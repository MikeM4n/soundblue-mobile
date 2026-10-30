package com.soundblue.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.util.Util;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import androidx.media3.session.SessionResult;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.soundblue.mobile.widget.SoundBlueWidgetState;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Reproductor de SoundBlue: ExoPlayer con la cola de canciones dentro del servicio de Android. Al terminar una canción
 * pasa sola a la siguiente aunque la interfaz web esté dormida, pre-carga la URL de la que sigue, salta las que NewPipe
 * no puede extraer y responde a la notificación, los audífonos y el reloj sin pasar por JavaScript.
 * La interfaz (PlaybackPlugin) le manda la canción actual, las anteriores (para «anterior») y las próximas.
 */
@OptIn(markerClass = UnstableApi.class)
public final class PlaybackService extends MediaSessionService {
    private static final String TAG = "PlaybackService";
    private static final String SCHEME = "soundblue"; // soundblue://youtube/<id>: NewPipe la resuelve al cargarla
    private static final int MAX_BEHIND = 10; // las que ya sonaron que se guardan para «anterior»
    private static final int MAX_FAILURES = 10; // canciones seguidas que fallan antes de detenerse
    private static final long SAME_POSITION_MS = 2000;
    private static final int WIDGET_ARTWORK_PX = 256;
    private static final int LOW_QUEUE = 3; // quedan 3 o menos por sonar: se le pide más a la app
    private static final int AUTO_BATCH = 5; // las parecidas que agrega el servicio cuando sigue solo…
    private static final int AUTO_PER_ARTIST = 2; // …como mucho 2 del mismo artista (como la radio de la app)
    private static final long APP_GRACE_MS = 15_000; // con la app abierta, lo que se le espera antes de seguir solo
    private static final long ENDED_GRACE_MS = 5_000;
    private static final int RECENT_LIMIT = 200; // las que ya sonaron: al seguir solo no se repiten
    /** Comando de sesión del corazón del widget: «Me gusta» / quitar de Tus me gusta la que suena. */
    public static final String ACTION_TOGGLE_LIKE = "com.soundblue.mobile.TOGGLE_LIKE";
    private static final SessionCommand TOGGLE_LIKE = new SessionCommand(ACTION_TOGGLE_LIKE, Bundle.EMPTY);
    /** El hueco invisible antes del ♥ en los controles de medios de Android 13+ (likeButtons): no hace nada. */
    private static final String ACTION_SPACER = "com.soundblue.mobile.SPACER";
    private static final SessionCommand SPACER = new SessionCommand(ACTION_SPACER, Bundle.EMPTY);
    /** ▶ del widget con la app cerrada: Android arranca el servicio en primer plano y suena la última cola guardada. */
    public static final String ACTION_RESUME_FROM_WIDGET = "com.soundblue.mobile.RESUME_FROM_WIDGET";
    private static final String QUEUE_PREFS = "soundblue_queue"; // la cola, dónde iba y las que te gustan
    private static final String WIDGET_PREFS = "soundblue_widget"; // la última canción (widget/SoundBlueWidgetState.kt)
    private static final String IDLE_CHANNEL = "soundblue_idle";
    private static final int IDLE_NOTIFICATION_ID = 0x50B1;

    /** Lo que la interfaz quiere saber del reproductor. Siempre en el hilo principal. */
    interface Events {
        /**
         * reason: "auto" (terminó la anterior), "seek" (un botón o la app) o "failed" (la anterior no se pudo reproducir).
         * after: si es una de las que el servicio agregó solo, la última que le había mandado la app (si no, null).
         */
        void onTrackChanged(String videoId, String reason, @Nullable String after);

        void onStateChanged();

        void onTrackFailed(String videoId, String message, boolean network, boolean skipped);

        /**
         * Se tocó el corazón (widget, notificación o pantalla bloqueada): la app pone o quita la canción de Tus me gusta.
         * `track`: id, título, artista, carátula y `liked` (cómo debe quedar).
         */
        void onLikeToggle(JSONObject track);

        /** Quedan 3 o menos por sonar: la app debe mandar más. */
        void onQueueLow();
    }

    private static PlaybackService instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private ExoPlayer player;
    private MediaSession session;
    private Events events;
    private ConnectivityManager.NetworkCallback networkCallback;
    private int failures; // seguidas, sin que ninguna llegue a sonar
    private String retried; // canción a la que ya se le pidió otra URL tras un error
    private String skippedFailed; // la que se quitó por fallar: el cambio de canción que sigue se debe a eso
    private boolean waitingForNetwork;
    private boolean loading; // dentro de `load`: los estados intermedios no se avisan (se avisa uno al final)
    private Uri widgetArtworkUri; // carátula que tiene (o está cargando) el widget
    private Bitmap widgetArtwork;
    private final Set<String> likedIds = new HashSet<>(); // las que la app dice que están en Tus me gusta
    private Boolean likeButton; // cómo está el corazón de la notificación (lleno: true), para no repintarlo de más
    private int generation; // número del último `load` de la app: con él, la app descarta avisos de antes
    // Seguir solo: con la Fila Dinámica (la app lo dice), al acabarse la cola el servicio agrega canciones parecidas.
    private boolean endless;
    private String appLastId; // la última canción que mandó la app: las que siguen las agregó el servicio
    private final Set<String> autoIds = new HashSet<>(); // las que agregó el servicio solo
    private final Set<String> recent = new LinkedHashSet<>(); // las que ya sonaron, de la más vieja a la más nueva
    private boolean advancing; // el servicio pasó solo a la siguiente: cuenta como «terminó la anterior»
    private int extendRequest; // el último pedido de parecidas (los de antes se descartan)
    private final Runnable autoExtend = this::autoExtend;

    static PlaybackService get() {
        return instance;
    }

    static Uri uriFor(String videoId) {
        return new Uri.Builder().scheme(SCHEME).authority("youtube").appendPath(videoId).build();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        StreamResolver.init();

        final DataSource.Factory dataSource =
                new ResolvingDataSource.Factory(new DefaultDataSource.Factory(this), PlaybackService::resolve);
        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSource).setLoadErrorHandlingPolicy(new LoadErrorPolicy()))
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                        .build(), true)
                // Audífonos o Bluetooth del carro desconectados: pausa (no sigue por el altavoz del celular).
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                // «Anterior» (app, notificación, audífonos, reloj): pasados 3 s reinicia la canción; antes, va a la anterior.
                .setMaxSeekToPreviousPositionMs(3000)
                .build();
        player.addListener(new PlayerListener());

        final Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        final PendingIntent openApp = PendingIntent.getActivity(this, 0, launch,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        session = new MediaSession.Builder(this, player)
                .setSessionActivity(openApp)
                .setCallback(new SessionCallback())
                .build();

        final DefaultMediaNotificationProvider notification = new DefaultMediaNotificationProvider.Builder(this).build();
        notification.setSmallIcon(R.drawable.ic_stat_soundblue);
        setMediaNotificationProvider(notification);
        // La sesión queda registrada desde ya (no solo cuando se conecta la app): si la música empieza desde el widget,
        // la notificación sale igual y el servicio pasa a primer plano.
        addSession(session);

        registerNetworkCallback();
        final SharedPreferences queuePrefs = getSharedPreferences(QUEUE_PREFS, MODE_PRIVATE);
        likedIds.addAll(queuePrefs.getStringSet("liked", new HashSet<>()));
        endless = queuePrefs.getBoolean("endless", true); // también con la app cerrada (el widget)
        // Si la app está abierta (p. ej. el widget arrancó la música), se entera desde ya de lo que pasa aquí.
        events = PlaybackPlugin.listener();
        instance = this;
        deliverPendingLikes();
        updateWidget();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (intent != null && ACTION_RESUME_FROM_WIDGET.equals(intent.getAction())) {
            resumeFromWidget();
            return START_NOT_STICKY;
        }
        return super.onStartCommand(intent, flags, startId); // botones de la notificación y de los audífonos
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        // Cerrar la app desde «recientes» detiene la música, como antes.
        pauseAllPlayersAndStopSelf();
    }

    @Override
    public void onDestroy() {
        instance = null;
        events = null;
        main.removeCallbacks(autoExtend);
        SoundBlueWidgetState.idle(this); // sin servicio no hay nada que controlar: queda la última canción, en pausa
        if (networkCallback != null) {
            final ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
            if (connectivity != null) connectivity.unregisterNetworkCallback(networkCallback);
            networkCallback = null;
        }
        saveQueue(); // con la posición exacta: el widget puede seguir desde aquí
        player.release();
        session.release();
        super.onDestroy();
    }

    // ---- Lo que pide la app (hilo principal) ----

    void setEvents(Events events) {
        this.events = events;
        deliverPendingLikes(); // los «Me gusta» que se tocaron con la app cerrada
    }

    void clearEvents(Events events) {
        if (this.events == events) this.events = null;
    }

    Player getPlayer() {
        return player;
    }

    int getGeneration() {
        return generation;
    }

    /**
     * Pone a sonar `current` con las anteriores (`before`) y las próximas (`after`). Si es la siguiente o la anterior de
     * la que suena, solo salta a ella (su URL ya está pre-cargada); si no, arma la cola de nuevo.
     */
    void load(List<MediaItem> before, MediaItem current, List<MediaItem> after, boolean endless, long startMs,
              boolean autoplay, float volume, int generation) {
        this.generation = generation;
        retried = null;
        skippedFailed = null;
        waitingForNetwork = false;
        fromApp(current, after, endless);
        // Al cambiar la cola y luego `playWhenReady`, ExoPlayer pasaría un momento por «en pausa» y la app quitaría la
        // rueda de carga mientras NewPipe extrae el audio. Se avisa un solo estado al final: «cargando» (o «en pausa»).
        loading = true;
        try {
            loadItems(before, current, after, startMs, autoplay, volume);
        } finally {
            loading = false;
        }
        notifyState();
        checkQueue(false);
    }

    private void loadItems(List<MediaItem> before, MediaItem current, List<MediaItem> after, long startMs,
                           boolean autoplay, float volume) {
        player.setVolume(volume);
        final int target = indexNearCurrent(current.mediaId);
        if (target == C.INDEX_UNSET) {
            final List<MediaItem> items = new ArrayList<>(before);
            items.add(current);
            items.addAll(after);
            player.setMediaItems(items, before.size(), startMs);
        } else {
            if (target != player.getCurrentMediaItemIndex()
                    || Math.abs(player.getCurrentPosition() - startMs) > SAME_POSITION_MS) {
                player.seekTo(target, startMs);
            }
            replaceBefore(before);
            replaceAfter(after);
        }
        if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
        player.setPlayWhenReady(autoplay);
        prefetchNext();
    }

    /** La app cambió su cola (agregaste, quitaste o moviste canciones). Si ya suena otra, espera a que la app se entere. */
    void setNeighbors(String currentId, List<MediaItem> before, List<MediaItem> after, boolean endless) {
        final MediaItem current = player.getCurrentMediaItem();
        if (current == null || !current.mediaId.equals(currentId)) return;
        fromApp(current, after, endless);
        replaceBefore(before);
        replaceAfter(after);
        prefetchNext();
        checkQueue(false);
    }

    /** La cola que mandó la app manda desde aquí: lo que el servicio iba a agregar solo ya no hace falta. */
    private void fromApp(MediaItem current, List<MediaItem> after, boolean endless) {
        appLastId = after.isEmpty() ? current.mediaId : after.get(after.size() - 1).mediaId;
        autoIds.clear();
        extendRequest++;
        main.removeCallbacks(autoExtend);
        if (this.endless == endless) return;
        this.endless = endless;
        getSharedPreferences(QUEUE_PREFS, MODE_PRIVATE).edit().putBoolean("endless", endless).apply();
    }

    void play() {
        if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
        else if (player.getPlaybackState() == Player.STATE_ENDED) player.seekToDefaultPosition();
        player.play();
    }

    void pause() {
        player.pause();
    }

    void seekTo(long positionMs) {
        player.seekTo(positionMs);
    }

    void previous() {
        if (player.getMediaItemCount() == 0) return;
        player.seekToPrevious();
        if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
    }

    void setVolume(float volume) {
        player.setVolume(volume);
    }

    void setRepeatOne(boolean enabled) {
        player.setRepeatMode(enabled ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
    }

    /** La app avisa si la canción está en Tus me gusta (el corazón del widget). */
    void setLiked(String videoId, boolean liked) {
        if (!(liked ? likedIds.add(videoId) : likedIds.remove(videoId))) return;
        saveLiked();
        updateWidget();
    }

    /**
     * Corazón del widget, de la notificación o de la pantalla bloqueada: cambia al instante y la app guarda la canción en
     * Tus me gusta (y lo confirma con setLiked). Si la app está cerrada (la música la arrancó el widget), queda anotado y
     * se guarda en cuanto se abre.
     */
    private void toggleLike() {
        final MediaItem item = player.getCurrentMediaItem();
        if (item == null) return;
        final boolean liked = !likedIds.remove(item.mediaId);
        if (liked) likedIds.add(item.mediaId);
        saveLiked();
        updateWidget();
        final JSONObject like = trackJson(item);
        try {
            like.put("liked", liked);
        } catch (JSONException ignored) {
            // no pasa con un booleano
        }
        if (events != null) {
            events.onLikeToggle(like);
            return;
        }
        final SharedPreferences prefs = getSharedPreferences(QUEUE_PREFS, MODE_PRIVATE);
        try {
            final JSONObject pending = new JSONObject(prefs.getString("pendingLikes", "{}"));
            pending.put(item.mediaId, like); // si la tocas dos veces, cuenta la última
            prefs.edit().putString("pendingLikes", pending.toString()).apply();
        } catch (JSONException error) {
            Log.w(TAG, "No se pudo anotar el «Me gusta»", error);
        }
    }

    /** Los «Me gusta» que se tocaron con la app cerrada: se le pasan ahora que está abierta. */
    private void deliverPendingLikes() {
        if (events == null) return;
        final SharedPreferences prefs = getSharedPreferences(QUEUE_PREFS, MODE_PRIVATE);
        final String saved = prefs.getString("pendingLikes", "{}");
        if ("{}".equals(saved)) return;
        prefs.edit().remove("pendingLikes").apply();
        try {
            final JSONObject pending = new JSONObject(saved);
            for (final Iterator<String> ids = pending.keys(); ids.hasNext(); ) {
                final JSONObject like = pending.optJSONObject(ids.next());
                if (like != null) events.onLikeToggle(like);
            }
        } catch (JSONException error) {
            Log.w(TAG, "Los «Me gusta» anotados están dañados", error);
        }
    }

    /** El corazón de la notificación (y de la pantalla bloqueada): lleno si la que suena está en Tus me gusta. */
    private void updateLikeButton(@Nullable MediaItem item) {
        final boolean liked = item != null && likedIds.contains(item.mediaId);
        if (likeButton != null && likeButton == liked) return;
        likeButton = liked;
        session.setMediaButtonPreferences(likeButtons(liked));
    }

    /**
     * ⏮ ⏯ ⏭ ♥. En la notificación (Android 12 o antes) el ♥ va después de ⏭. Desde Android 13 los controles de medios y la
     * pantalla bloqueada no siguen ese orden: ⏮ ⏯ ⏭ van fijos y las acciones propias llenan los huecos, y capas como la de
     * OPPO/realme tienen uno a cada lado y ponen la primera a la izquierda. Un hueco invisible delante deja el ♥ a la derecha.
     */
    private static List<CommandButton> likeButtons(boolean liked) {
        final CommandButton heart = new CommandButton.Builder(liked ? CommandButton.ICON_HEART_FILLED : CommandButton.ICON_HEART_UNFILLED)
                .setDisplayName(liked ? "Quitar de Tus me gusta" : "Me gusta")
                .setSessionCommand(TOGGLE_LIKE)
                .setSlots(CommandButton.SLOT_OVERFLOW) // después de ⏮ ⏯ ⏭, que siguen en su sitio
                .build();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return ImmutableList.of(heart);
        final CommandButton spacer = new CommandButton.Builder(CommandButton.ICON_UNDEFINED)
                .setCustomIconResId(R.drawable.media_spacer)
                .setDisplayName(" ") // Android no acepta una acción sin nombre
                .setSessionCommand(SPACER)
                .setSlots(CommandButton.SLOT_OVERFLOW)
                .build();
        return ImmutableList.of(spacer, heart);
    }

    // ---- Seguir desde el widget con la app cerrada ----

    /**
     * ▶ del widget con la app cerrada: vuelve a armar la última cola guardada y suena donde iba, sin abrir la app. Las URL
     * no se guardan (YouTube las vence): NewPipe extrae una nueva al cargar cada canción (resolve), y si una vence a mitad,
     * onError pide otra. Android arrancó el servicio en primer plano: al empezar a cargar, Media3 muestra la notificación.
     */
    private void resumeFromWidget() {
        if (player.getMediaItemCount() == 0 && !restoreQueue()) {
            leaveForeground(); // nada guardado: se cumple con el primer plano que pidió Android y se detiene
            return;
        }
        play();
    }

    /** La cola guardada (o, si no hay, la última canción que mostró el widget). False si no hay nada. */
    private boolean restoreQueue() {
        final SharedPreferences prefs = getSharedPreferences(QUEUE_PREFS, MODE_PRIVATE);
        final List<MediaItem> items = new ArrayList<>();
        try {
            final JSONArray saved = new JSONArray(prefs.getString("items", "[]"));
            for (int i = 0; i < saved.length(); i++) {
                final JSONObject track = saved.optJSONObject(i);
                if (track != null && StreamResolver.VIDEO_ID.matcher(track.optString("id")).matches()) items.add(mediaItem(track));
            }
        } catch (JSONException error) {
            Log.w(TAG, "La cola guardada está dañada", error);
        }
        if (items.isEmpty()) {
            final SharedPreferences widget = getSharedPreferences(WIDGET_PREFS, MODE_PRIVATE);
            final String id = widget.getString("id", "");
            if (!StreamResolver.VIDEO_ID.matcher(id).matches()) return false;
            final JSONObject track = new JSONObject();
            try {
                track.put("id", id).put("title", widget.getString("title", "")).put("artist", widget.getString("artist", ""));
            } catch (JSONException ignored) {
                // no pasa con textos
            }
            player.setMediaItem(mediaItem(track));
            return true;
        }
        final int index = Math.min(Math.max(0, prefs.getInt("index", 0)), items.size() - 1);
        player.setMediaItems(items, index, Math.max(0, prefs.getLong("position", 0)));
        return true;
    }

    /** La cola, la canción y dónde iba, para seguir desde el widget aunque Android cierre la app. */
    private void saveQueue() {
        final int count = player.getMediaItemCount();
        if (count == 0) return; // vacía (recién creada): se conserva la última guardada
        final JSONArray items = new JSONArray();
        for (int i = 0; i < count; i++) items.put(trackJson(player.getMediaItemAt(i)));
        getSharedPreferences(QUEUE_PREFS, MODE_PRIVATE).edit()
                .putString("items", items.toString())
                .putInt("index", player.getCurrentMediaItemIndex())
                .putLong("position", Math.max(0, player.getCurrentPosition()))
                .apply();
    }

    private void saveLiked() {
        getSharedPreferences(QUEUE_PREFS, MODE_PRIVATE).edit().putStringSet("liked", new HashSet<>(likedIds)).apply();
    }

    /** Android exige pasar a primer plano tras arrancar así; sin nada que sonar, se muestra un aviso y se quita. */
    private void leaveForeground() {
        final NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            manager.createNotificationChannel(new NotificationChannel(IDLE_CHANNEL, "SoundBlue", NotificationManager.IMPORTANCE_LOW));
        }
        final Notification notification = new NotificationCompat.Builder(this, IDLE_CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_soundblue)
                .setContentTitle("SoundBlue")
                .setContentText("Abre la app para elegir música")
                .build();
        ServiceCompat.startForeground(this, IDLE_NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    /** Una canción de la app (id, título, artista, álbum, carátula) para ExoPlayer: la URL la resuelve NewPipe al cargarla. */
    static MediaItem mediaItem(final JSONObject track) {
        final String videoId = track.optString("id");
        final MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .setTitle(StreamResolver.safe(track.optString("title"), videoId))
                .setArtist(StreamResolver.safe(track.optString("artist"), "SoundBlue"))
                .setAlbumTitle(StreamResolver.safe(track.optString("album"), "SoundBlue"));
        final String artwork = track.optString("artwork");
        if (artwork.startsWith("https:")) metadata.setArtworkUri(Uri.parse(artwork));
        return new MediaItem.Builder()
                .setMediaId(videoId)
                .setUri(uriFor(videoId))
                .setMediaMetadata(metadata.build())
                .build();
    }

    private static JSONObject trackJson(MediaItem item) {
        final MediaMetadata metadata = item.mediaMetadata;
        final JSONObject track = new JSONObject();
        try {
            track.put("id", item.mediaId)
                    .put("title", metadata.title == null ? "" : metadata.title.toString())
                    .put("artist", metadata.artist == null ? "" : metadata.artist.toString())
                    .put("album", metadata.albumTitle == null ? "" : metadata.albumTitle.toString())
                    .put("artwork", metadata.artworkUri == null ? "" : metadata.artworkUri.toString());
        } catch (JSONException ignored) {
            // no pasa con textos
        }
        return track;
    }

    // ---- Cola ----

    private int indexNearCurrent(String videoId) {
        final int index = player.getCurrentMediaItemIndex();
        final int count = player.getMediaItemCount();
        if (count == 0) return C.INDEX_UNSET;
        for (final int candidate : new int[] {index, index + 1, index - 1}) {
            if (candidate >= 0 && candidate < count && player.getMediaItemAt(candidate).mediaId.equals(videoId)) {
                return candidate;
            }
        }
        return C.INDEX_UNSET;
    }

    /** Las próximas: se conservan las que ya coinciden (y lo que ExoPlayer ya cargó de ellas). */
    private void replaceAfter(List<MediaItem> after) {
        final int from = player.getCurrentMediaItemIndex() + 1;
        int kept = 0;
        while (kept < after.size() && from + kept < player.getMediaItemCount()
                && player.getMediaItemAt(from + kept).mediaId.equals(after.get(kept).mediaId)) {
            kept++;
        }
        if (from + kept < player.getMediaItemCount()) player.removeMediaItems(from + kept, player.getMediaItemCount());
        if (kept < after.size()) player.addMediaItems(after.subList(kept, after.size()));
    }

    /** Las anteriores (lo que alcanza «anterior»). Cambiarlas no interrumpe la que suena. */
    private void replaceBefore(List<MediaItem> before) {
        final int current = player.getCurrentMediaItemIndex();
        boolean same = current == before.size();
        for (int i = 0; same && i < current; i++) same = player.getMediaItemAt(i).mediaId.equals(before.get(i).mediaId);
        if (same) return;
        if (current > 0) player.removeMediaItems(0, current);
        if (!before.isEmpty()) player.addMediaItems(0, before);
    }

    private void notifyState() {
        if (events != null && !loading) events.onStateChanged();
    }

    private void trimBehind() {
        final int extra = player.getCurrentMediaItemIndex() - MAX_BEHIND;
        if (extra > 0) player.removeMediaItems(0, extra);
    }

    /**
     * Quedan pocas por sonar: al cambiar de canción se le avisa a la app para que mande más. Si ya no queda ninguna y la
     * app no manda más (dormida en segundo plano o cerrada), el servicio sigue solo (autoExtend).
     */
    private void checkQueue(boolean notify) {
        final int left = player.getMediaItemCount() - 1 - player.getCurrentMediaItemIndex();
        if (notify && left <= LOW_QUEUE && events != null) events.onQueueLow();
        if (left <= 0) scheduleExtend(APP_GRACE_MS);
    }

    /** Con la app conectada se le da un margen para mandar las suyas; sin ella, se sigue enseguida. */
    private void scheduleExtend(long graceMs) {
        main.removeCallbacks(autoExtend);
        if (endless) main.postDelayed(autoExtend, events != null ? graceMs : 0);
    }

    /**
     * La cola se acabó y la app no mandó más: el servicio sigue solo con canciones parecidas a la que suena, las
     * «relacionadas» que NewPipe ya trajo al extraerla (sin consultas de más; si esa no se pudo extraer, las de la
     * anterior). Cuando la app despierta, su Fila Dinámica vuelve a mandar.
     */
    private void autoExtend() {
        final MediaItem item = player.getCurrentMediaItem();
        if (!endless || item == null || player.hasNextMediaItem() || player.getRepeatMode() != Player.REPEAT_MODE_OFF) return;
        final String seed = item.mediaId;
        final int index = player.getCurrentMediaItemIndex();
        final String fallback = index > 0 ? player.getMediaItemAt(index - 1).mediaId : null;
        final int request = ++extendRequest;
        StreamResolver.related(seed)
                .handle((related, error) -> related)
                .thenCompose((related) -> related != null && !related.isEmpty() || fallback == null
                        ? CompletableFuture.completedFuture(related)
                        : StreamResolver.related(fallback).handle((other, error) -> other))
                .thenAccept((related) -> main.post(() -> {
                    if (instance == null || request != extendRequest) return;
                    final MediaItem now = player.getCurrentMediaItem();
                    if (now == null || !now.mediaId.equals(seed) || player.hasNextMediaItem()) return;
                    final List<MediaItem> picks = pickRelated(related);
                    if (picks.isEmpty()) {
                        Log.w(TAG, "No hay canciones parecidas para seguir después de " + seed);
                        return;
                    }
                    player.addMediaItems(picks);
                    if (player.getPlayerError() != null) {
                        // La última no se pudo reproducir: se quita (como en onError) y suena la primera parecida.
                        skippedFailed = seed;
                        player.removeMediaItem(player.getCurrentMediaItemIndex());
                        player.prepare();
                    } else if (player.getPlaybackState() == Player.STATE_ENDED) {
                        advancing = true;
                        player.seekTo(player.getCurrentMediaItemIndex() + 1, 0);
                    }
                    prefetchNext();
                }));
    }

    /** Las parecidas que no sonaron hace poco ni están en la cola, como mucho 2 del mismo artista. */
    private List<MediaItem> pickRelated(@Nullable List<StreamResolver.Related> related) {
        final List<MediaItem> picks = new ArrayList<>();
        if (related == null) return picks;
        final Set<String> used = new HashSet<>(recent);
        for (int i = 0; i < player.getMediaItemCount(); i++) used.add(player.getMediaItemAt(i).mediaId);
        final Map<String, Integer> perArtist = new HashMap<>();
        for (final StreamResolver.Related song : related) {
            if (picks.size() >= AUTO_BATCH) break;
            final String artist = song.artist.toLowerCase(Locale.ROOT);
            final int count = perArtist.containsKey(artist) ? perArtist.get(artist) : 0;
            if (count >= AUTO_PER_ARTIST || !used.add(song.id)) continue;
            perArtist.put(artist, count + 1);
            final JSONObject track = new JSONObject();
            try {
                track.put("id", song.id).put("title", song.title).put("artist", song.artist).put("artwork", song.artwork);
            } catch (JSONException ignored) {
                // no pasa con textos
            }
            autoIds.add(song.id);
            picks.add(mediaItem(track));
        }
        return picks;
    }

    /** Las que ya sonaron (las más viejas salen): al seguir solo no se repiten. */
    private void remember(String videoId) {
        recent.remove(videoId);
        recent.add(videoId);
        if (recent.size() <= RECENT_LIMIT) return;
        final Iterator<String> oldest = recent.iterator();
        oldest.next();
        oldest.remove();
    }

    /** Pre-carga: la URL de la siguiente se extrae mientras suena la actual, así «siguiente» no espera a NewPipe. */
    private void prefetchNext() {
        final int next = player.getNextMediaItemIndex();
        if (next != C.INDEX_UNSET) StreamResolver.prefetch(player.getMediaItemAt(next).mediaId);
    }

    /** soundblue://youtube/<id> → la URL de audio que da NewPipe. Corre en el hilo de carga de ExoPlayer. */
    private static DataSpec resolve(DataSpec spec) throws IOException {
        if (!SCHEME.equals(spec.uri.getScheme())) return spec;
        final String videoId = spec.uri.getLastPathSegment();
        return spec.withUri(Uri.parse(StreamResolver.resolve(videoId == null ? "" : videoId).audioUrl));
    }

    // ---- Errores ----

    private void onError(PlaybackException error) {
        final MediaItem item = player.getCurrentMediaItem();
        if (item == null) return;
        final String videoId = item.mediaId;
        if (isNetworkError(error) && !isOnline()) {
            // Sin internet no se salta nada: sigue sola cuando vuelva la conexión (registerNetworkCallback).
            waitingForNetwork = true;
            if (events != null) events.onTrackFailed(videoId, "Sin conexión", true, false);
            return;
        }
        if (!hasCause(error, StreamResolver.UnavailableException.class) && !videoId.equals(retried)) {
            // Un fallo de la descarga (p. ej. la URL de YouTube venció tras horas en pausa): otra URL y sigue donde iba.
            retried = videoId;
            StreamResolver.forget(videoId);
            player.prepare();
            return;
        }
        failures++;
        final boolean skip = failures <= MAX_FAILURES && player.hasNextMediaItem();
        Log.w(TAG, "No se pudo reproducir " + videoId + (skip ? ", pasando a la siguiente" : ""), error);
        if (events != null) events.onTrackFailed(videoId, message(error), false, skip);
        if (!skip) {
            // Falló la última: con la Fila Dinámica, si la app no manda más, el servicio sigue solo con parecidas.
            if (failures <= MAX_FAILURES) scheduleExtend(ENDED_GRACE_MS);
            return;
        }
        // Se quita de la cola (así «anterior» no vuelve a ella) y suena la siguiente.
        skippedFailed = videoId;
        player.removeMediaItem(player.getCurrentMediaItemIndex());
        player.prepare();
    }

    private static String message(PlaybackException error) {
        Throwable cause = error;
        while (cause.getCause() != null) cause = cause.getCause();
        return StreamResolver.safe(cause.getMessage(), "No se pudo reproducir esta canción.");
    }

    private static boolean isNetworkError(PlaybackException error) {
        return error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
                || hasCause(error, UnknownHostException.class)
                || hasCause(error, ConnectException.class)
                || hasCause(error, NoRouteToHostException.class)
                || hasCause(error, SocketTimeoutException.class);
    }

    private static boolean hasCause(Throwable error, Class<? extends Throwable> type) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (type.isInstance(cause)) return true;
        }
        return false;
    }

    private boolean isOnline() {
        final ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
        final Network network = connectivity == null ? null : connectivity.getActiveNetwork();
        final NetworkCapabilities capabilities = network == null ? null : connectivity.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void registerNetworkCallback() {
        final ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
        if (connectivity == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                main.post(() -> {
                    if (!waitingForNetwork || instance == null) return;
                    waitingForNetwork = false;
                    if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
                });
            }
        };
        connectivity.registerDefaultNetworkCallback(networkCallback);
    }

    /** Una canción que YouTube no deja reproducir no se reintenta (ni una URL vencida): se resuelve enseguida. */
    private static final class LoadErrorPolicy extends DefaultLoadErrorHandlingPolicy {
        @Override
        public long getRetryDelayMsFor(LoadErrorInfo info) {
            if (hasCause(info.exception, StreamResolver.UnavailableException.class)) return C.TIME_UNSET;
            for (Throwable cause = info.exception; cause != null; cause = cause.getCause()) {
                if (cause instanceof HttpDataSource.InvalidResponseCodeException
                        && ((HttpDataSource.InvalidResponseCodeException) cause).responseCode == 403) {
                    return C.TIME_UNSET;
                }
            }
            return super.getRetryDelayMsFor(info);
        }
    }

    private final class PlayerListener implements Player.Listener {
        @Override
        public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
            if (item == null) return;
            retried = null;
            final String cause = skippedFailed != null ? "failed"
                    : reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO || advancing ? "auto" : "seek";
            skippedFailed = null;
            advancing = false;
            remember(item.mediaId);
            prefetchNext();
            main.post(PlaybackService.this::trimBehind);
            if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) return;
            if (events != null) events.onTrackChanged(item.mediaId, cause, autoIds.contains(item.mediaId) ? appLastId : null);
            checkQueue(true);
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            if (isPlaying) {
                failures = 0;
                prefetchNext();
            }
            notifyState();
        }

        @Override
        public void onPlaybackStateChanged(int playbackState) {
            notifyState();
            // Se acabó la cola: si la app no manda más enseguida, el servicio sigue solo (con la Fila Dinámica).
            if (playbackState == Player.STATE_ENDED) scheduleExtend(ENDED_GRACE_MS);
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            notifyState();
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            onError(error);
        }

        // Una vez por tanda de cambios (no por cada aviso suelto): el widget muestra lo que suena y si está en pausa.
        @Override
        public void onEvents(Player eventPlayer, Player.Events events) {
            if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_MEDIA_METADATA_CHANGED,
                    Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_PLAY_WHEN_READY_CHANGED,
                    Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_TIMELINE_CHANGED)) {
                updateWidget();
            }
            // Cambió la cola, la canción, se pausó o se adelantó: se guarda para seguir desde el widget.
            if (events.containsAny(Player.EVENT_TIMELINE_CHANGED, Player.EVENT_MEDIA_ITEM_TRANSITION,
                    Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_POSITION_DISCONTINUITY)) {
                saveQueue();
            }
        }
    }

    /**
     * Lo que la sesión acepta además de lo normal: el corazón (y su hueco), solo desde la propia app (el widget y la notificación, que
     * es la que usa Android para la pantalla bloqueada y los controles de medios).
     */
    private final class SessionCallback implements MediaSession.Callback {
        @Override
        public MediaSession.ConnectionResult onConnect(MediaSession session, MediaSession.ControllerInfo controller) {
            if (!getPackageName().equals(controller.getPackageName())) {
                return MediaSession.Callback.super.onConnect(session, controller);
            }
            final SessionCommands commands =
                    MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon().add(TOGGLE_LIKE).add(SPACER).build();
            final MediaItem item = player.getCurrentMediaItem();
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailableSessionCommands(commands)
                    .setMediaButtonPreferences(likeButtons(item != null && likedIds.contains(item.mediaId)))
                    .build();
        }

        @Override
        public ListenableFuture<SessionResult> onCustomCommand(MediaSession session, MediaSession.ControllerInfo controller,
                                                               SessionCommand command, Bundle args) {
            if (ACTION_TOGGLE_LIKE.equals(command.customAction)) {
                toggleLike();
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (ACTION_SPACER.equals(command.customAction)) {
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            return MediaSession.Callback.super.onCustomCommand(session, controller, command, args);
        }
    }

    // ---- Widget (widget/SoundBlueWidget.kt) ----

    private void updateWidget() {
        final MediaItem item = player.getCurrentMediaItem();
        updateLikeButton(item); // y el corazón de la notificación, con lo mismo
        if (item == null) {
            widgetArtworkUri = null;
            widgetArtwork = null;
            SoundBlueWidgetState.idle(this); // queda la última canción que sonó
            return;
        }
        final MediaMetadata metadata = item.mediaMetadata;
        if (!Objects.equals(metadata.artworkUri, widgetArtworkUri)) {
            widgetArtworkUri = metadata.artworkUri;
            widgetArtwork = null;
            loadWidgetArtwork(metadata);
        }
        SoundBlueWidgetState.publish(this, item.mediaId,
                metadata.title == null ? item.mediaId : metadata.title.toString(),
                metadata.artist == null ? "" : metadata.artist.toString(),
                !Util.shouldShowPlayButton(player), // ⏸ también mientras carga, como en la app
                likedIds.contains(item.mediaId),
                true, // ♥ siempre: con la app cerrada queda anotado y se guarda al abrirla (toggleLike)
                widgetArtwork);
    }

    /** La carátula, con el mismo cargador (y caché) que la notificación. */
    private void loadWidgetArtwork(MediaMetadata metadata) {
        final ListenableFuture<Bitmap> future = session.getBitmapLoader().loadBitmapFromMetadata(metadata);
        if (future == null) return;
        final Uri uri = metadata.artworkUri;
        future.addListener(() -> {
            if (instance == null || !Objects.equals(uri, widgetArtworkUri)) return; // ya suena otra
            try {
                widgetArtwork = forWidget(future.get());
                updateWidget();
            } catch (Exception error) {
                Log.w(TAG, "No se pudo cargar la carátula para el widget", error);
            }
        }, ContextCompat.getMainExecutor(this));
    }

    /** El widget recibe la imagen por Binder (máximo ~1 MB por envío): basta una pequeña para 48 dp. */
    private static Bitmap forWidget(Bitmap bitmap) {
        final int largest = Math.max(bitmap.getWidth(), bitmap.getHeight());
        if (largest <= WIDGET_ARTWORK_PX) return bitmap;
        final float scale = (float) WIDGET_ARTWORK_PX / largest;
        return Bitmap.createScaledBitmap(bitmap, Math.round(bitmap.getWidth() * scale),
                Math.round(bitmap.getHeight() * scale), true);
    }
}
