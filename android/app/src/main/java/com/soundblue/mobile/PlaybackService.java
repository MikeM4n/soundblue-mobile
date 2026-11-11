package com.soundblue.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
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
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
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
    private static final int RECENT_LIMIT = 300; // las que ya sonaron: al seguir solo no se repiten…
    private static final long RECENT_MS = 24 * 60 * 60 * 1000L; // …las de las últimas 24 h (se guardan al cerrar)
    private static final int RECENT_FALLBACK = 20; // si no queda otra, solo se evitan las últimas 20
    private static final long PROBE_MS = 20_000; // en modo offline, cada cuánto se prueba si volvió internet
    private static final long PROBE_SOON_MS = 1_500; // al aparecer una red: se prueba enseguida
    /** Comando de sesión del corazón del widget: «Me gusta» / quitar de Tus me gusta la que suena. */
    public static final String ACTION_TOGGLE_LIKE = "com.soundblue.mobile.TOGGLE_LIKE";
    private static final SessionCommand TOGGLE_LIKE = new SessionCommand(ACTION_TOGGLE_LIKE, Bundle.EMPTY);
    /** El hueco invisible antes del ♥ en los controles de medios de Android 13+ (likeButtons): no hace nada. */
    private static final String ACTION_SPACER = "com.soundblue.mobile.SPACER";
    private static final SessionCommand SPACER = new SessionCommand(ACTION_SPACER, Bundle.EMPTY);
    /** ▶ del widget con la app cerrada: Android arranca el servicio en primer plano y suena la última cola guardada. */
    public static final String ACTION_RESUME_FROM_WIDGET = "com.soundblue.mobile.RESUME_FROM_WIDGET";
    private static final String QUEUE_PREFS = "soundblue_queue"; // la cola, dónde iba y las que te gustan
    // Transición suave (crossfade): los últimos 10 s de una canción se mezclan con el inicio de la siguiente.
    private static final String CROSSFADE_KEY = "crossfade_enabled"; // Ajustes → «Transición suave»
    private static final long CROSSFADE_MS = 10_000;
    private static final long FADE_TICK_MS = 100; // el volumen de las dos se ajusta 10 veces por segundo
    private static final long FADE_WATCH_MS = 500; // cada cuánto se mira si ya faltan 10 s
    private static final AudioAttributes AUDIO_ATTRIBUTES = new AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build();
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

        /**
         * Empezó (true) o terminó (false) el modo offline: sin internet suena la caché offline y la cola de la app queda
         * guardada; al volver la conexión, la cola sigue donde iba.
         */
        void onOfflineChanged(boolean active);
    }

    private static PlaybackService instance;
    // De cada canción, si empezó a sonar desde su descarga (true) o por internet (resolve): así sigue igual al adelantar.
    private static final java.util.concurrent.ConcurrentHashMap<String, Boolean> FROM_FILE = new java.util.concurrent.ConcurrentHashMap<>();

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
    // Las que ya sonaron (id → cuándo), de la más vieja a la más nueva. Se guardan: valen también al día siguiente.
    private final LinkedHashMap<String, Long> recent = new LinkedHashMap<>();
    private boolean advancing; // el servicio pasó solo a la siguiente: cuenta como «terminó la anterior»
    private int extendRequest; // el último pedido de parecidas (los de antes se descartan)
    private final Runnable autoExtend = this::autoExtend;
    // Modo offline: sin internet suena la caché (OfflineCache) en bucle y la cola de la app espera aquí, con su posición.
    private boolean offline;
    private boolean offlineFromExtractor; // entró porque NewPipe falló 10 seguidas (no por falta de internet)
    private List<MediaItem> savedItems = new ArrayList<>();
    private int savedIndex;
    private long savedPosition;
    private int savedRepeat = Player.REPEAT_MODE_OFF;
    private final Runnable offlineProbe = this::probeOnline;
    private boolean backupBlocked; // la caché no suena (falló entera): no se vuelve a ella hasta que haya red o elijas otra
    // Transición suave: un solo ExoPlayer no puede sonar dos canciones a la vez, así que hay dos. `player` es el de la
    // sesión (notificación, controles, la cola). Cuando a la canción le quedan 10 s, `spare` arranca la siguiente en
    // volumen 0 y cada 100 ms uno baja y el otro sube. Al terminar, `spare` pasa a ser `player` (sin cortes: ya venía
    // sonando) y el que era `player` queda de repuesto para la próxima. Todo aquí, en el servicio: sigue con la pantalla
    // bloqueada y la app dormida.
    private boolean crossfade; // el ajuste (SharedPreferences: crossfade_enabled)
    private DataSource.Factory dataSource;
    private ExoPlayer spare; // el otro reproductor (se crea la primera vez que hace falta)
    private boolean fading; // mezclando: `player` baja y `spare` sube
    // La canción que se va (por su id, no por su lugar: si en plena mezcla se recorta lo que ya sonó, el lugar cambia).
    private String fadeFromId;
    private float userVolume = 1f; // el volumen que pidió la app: la mezcla lo reparte entre las dos
    private String noFadeFor; // canción cuya siguiente no cargó al mezclar: termina normal, sin reintentar la mezcla
    private final PlayerListener playerListener = new PlayerListener();
    private final Player.Listener spareListener = new Player.Listener() {
        @Override
        public void onPlayerError(PlaybackException error) {
            // La siguiente no se pudo cargar: sin mezcla; al terminar la que suena, el cambio normal se encarga del error.
            Log.w(TAG, "Transición suave: la siguiente no cargó", error);
            final MediaItem leaving = player.getCurrentMediaItem();
            noFadeFor = leaving == null ? null : leaving.mediaId; // con esta canción no se vuelve a intentar
            cancelFade();
        }
    };
    private final Runnable fadeWatch = this::watchForFade;
    private final Runnable fadeTick = this::fadeStep;

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
        OfflineCache.init(this);

        dataSource = new ResolvingDataSource.Factory(new DefaultDataSource.Factory(this), PlaybackService::resolve);
        player = buildPlayer(true);
        player.addListener(playerListener);

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
        crossfade = queuePrefs.getBoolean(CROSSFADE_KEY, false);
        loadRecent(queuePrefs);
        // Si la app está abierta (p. ej. el widget arrancó la música), se entera desde ya de lo que pasa aquí.
        events = PlaybackPlugin.listener();
        instance = this;
        deliverPendingLikes();
        updateWidget();
    }

    /**
     * Un reproductor. `audioFocus`: el de la sesión pide el foco de audio (pausa con una llamada); el de repuesto no, o al
     * arrancar le quitaría el foco al que suena y lo pausaría en plena mezcla.
     */
    private ExoPlayer buildPlayer(boolean audioFocus) {
        return new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSource).setLoadErrorHandlingPolicy(new LoadErrorPolicy()))
                .setAudioAttributes(AUDIO_ATTRIBUTES, audioFocus)
                // Audífonos o Bluetooth del carro desconectados: pausa (no sigue por el altavoz del celular).
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                // «Anterior» (app, notificación, audífonos, reloj): pasados 3 s reinicia la canción; antes, va a la anterior.
                .setMaxSeekToPreviousPositionMs(3000)
                .build();
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
        cancelFade(); // también la que estaba entrando (no es de la sesión: nadie más la pausaría)
        pauseAllPlayersAndStopSelf();
    }

    @Override
    public void onDestroy() {
        instance = null;
        events = null;
        main.removeCallbacks(autoExtend);
        main.removeCallbacks(offlineProbe);
        main.removeCallbacks(fadeWatch);
        cancelFade();
        SoundBlueWidgetState.idle(this); // sin servicio no hay nada que controlar: queda la última canción, en pausa
        if (networkCallback != null) {
            final ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
            if (connectivity != null) connectivity.unregisterNetworkCallback(networkCallback);
            networkCallback = null;
        }
        saveQueue(); // con la posición exacta: el widget puede seguir desde aquí
        player.release();
        if (spare != null) spare.release();
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
        cancelFade(); // elegiste otra: la mezcla en curso se deja
        retried = null;
        skippedFailed = null;
        waitingForNetwork = false;
        dropOffline(); // elegiste otra canción (o la app volvió a cargar la suya): manda la cola de la app
        backupBlocked = false;
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
        userVolume = volume;
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
        if (offline) {
            updateSaved(currentId, before, after, endless); // suena la caché: los cambios van a la cola que espera
            return;
        }
        final MediaItem current = player.getCurrentMediaItem();
        if (current == null || !current.mediaId.equals(currentId)) return;
        // Cambió la que seguía (la quitaste, pusiste otra «a continuación»): la que ya estaba entrando no es la que toca.
        if (fading) {
            final MediaItem entering = spare.getCurrentMediaItem();
            if (after.isEmpty() || entering == null || !after.get(0).mediaId.equals(entering.mediaId)) cancelFade();
        }
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
        cancelFade(); // en pausa no se mezcla: al seguir, si aún faltan menos de 10 s, la transición empieza de nuevo
        player.pause();
    }

    void seekTo(long positionMs) {
        cancelFade();
        player.seekTo(positionMs);
    }

    void previous() {
        if (player.getMediaItemCount() == 0) return;
        cancelFade();
        player.seekToPrevious();
        if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
    }

    /** ⏭ en modo offline: la siguiente de la caché (fuera de él, «siguiente» lo decide la app con su cola). */
    void next() {
        if (!player.hasNextMediaItem()) return;
        cancelFade();
        player.seekToNextMediaItem();
        if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
    }

    void setVolume(float volume) {
        userVolume = volume;
        if (!fading) player.setVolume(volume); // mezclando, lo aplica el siguiente ajuste (fadeStep), repartido entre las dos
    }

    /** Ajustes → «Transición suave» (también lo deja guardado para cuando el servicio arranque solo, p. ej. desde el widget). */
    static void saveCrossfade(Context context, boolean enabled) {
        context.getSharedPreferences(QUEUE_PREFS, MODE_PRIVATE).edit().putBoolean(CROSSFADE_KEY, enabled).apply();
        final PlaybackService service = instance;
        if (service == null) return;
        service.crossfade = enabled;
        if (!enabled) service.cancelFade();
        else if (service.player.isPlaying()) service.scheduleFadeWatch();
    }

    void setRepeatOne(boolean enabled) {
        if (enabled) cancelFade(); // «repetir una»: la misma canción vuelve a empezar, sin mezcla
        final int mode = enabled ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF;
        if (offline) savedRepeat = mode; // la caché sigue en bucle; se aplica al volver a la cola
        else player.setRepeatMode(mode);
    }

    boolean isOffline() {
        return offline;
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
        // En modo offline se guarda la cola que espera (no la caché): el widget sigue desde ella.
        final int count = offline ? savedItems.size() : player.getMediaItemCount();
        if (count == 0) return; // vacía (recién creada): se conserva la última guardada
        final JSONArray items = new JSONArray();
        for (int i = 0; i < count; i++) items.put(trackJson(offline ? savedItems.get(i) : player.getMediaItemAt(i)));
        getSharedPreferences(QUEUE_PREFS, MODE_PRIVATE).edit()
                .putString("items", items.toString())
                .putInt("index", offline ? savedIndex : player.getCurrentMediaItemIndex())
                .putLong("position", Math.max(0, offline ? savedPosition : player.getCurrentPosition()))
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
        if (offline) return; // la caché suena en bucle: no se recorta
        final int extra = player.getCurrentMediaItemIndex() - MAX_BEHIND;
        if (extra > 0) player.removeMediaItems(0, extra);
    }

    /**
     * Quedan pocas por sonar: al cambiar de canción se le avisa a la app para que mande más. Si ya no queda ninguna y la
     * app no manda más (dormida en segundo plano o cerrada), el servicio sigue solo (autoExtend).
     */
    private void checkQueue(boolean notify) {
        if (offline) return;
        final int left = player.getMediaItemCount() - 1 - player.getCurrentMediaItemIndex();
        if (notify && left <= LOW_QUEUE && events != null) events.onQueueLow();
        if (left <= 0) scheduleExtend(APP_GRACE_MS);
    }

    /** Con la app conectada se le da un margen para mandar las suyas; sin ella, se sigue enseguida. */
    private void scheduleExtend(long graceMs) {
        main.removeCallbacks(autoExtend);
        if (endless && !offline) main.postDelayed(autoExtend, events != null ? graceMs : 0);
    }

    /**
     * La cola se acabó y la app no mandó más: el servicio sigue solo con canciones parecidas a la que suena, las
     * «relacionadas» que NewPipe ya trajo al extraerla (sin consultas de más; si esa no se pudo extraer, las de la
     * anterior). Cuando la app despierta, su Fila Dinámica vuelve a mandar.
     */
    private void autoExtend() {
        final MediaItem item = player.getCurrentMediaItem();
        if (!endless || offline || item == null || player.hasNextMediaItem() || player.getRepeatMode() != Player.REPEAT_MODE_OFF) return;
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
                    if (instance == null || request != extendRequest || offline) return;
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

    /**
     * Las parecidas que no sonaron en las últimas 24 h ni están en la cola, como mucho 2 del mismo artista. Si con eso no
     * queda ninguna, solo se evitan las últimas 20 que sonaron: la música no se detiene.
     */
    private List<MediaItem> pickRelated(@Nullable List<StreamResolver.Related> related) {
        final List<MediaItem> picks = pickRelated(related, true);
        return picks.isEmpty() ? pickRelated(related, false) : picks;
    }

    private List<MediaItem> pickRelated(@Nullable List<StreamResolver.Related> related, boolean skipDay) {
        final List<MediaItem> picks = new ArrayList<>();
        if (related == null) return picks;
        final Set<String> used = new HashSet<>();
        final long since = System.currentTimeMillis() - RECENT_MS;
        final List<String> played = new ArrayList<>(recent.keySet());
        for (int i = played.size() - 1, n = 0; i >= 0; i--, n++) {
            if (skipDay ? recent.get(played.get(i)) >= since : n < RECENT_FALLBACK) used.add(played.get(i));
        }
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

    /** Las que ya sonaron (salen las de más de 24 h y, si son muchas, las más viejas): al seguir solo no se repiten. */
    private void remember(String videoId) {
        final long now = System.currentTimeMillis();
        recent.remove(videoId);
        recent.put(videoId, now);
        final Iterator<Map.Entry<String, Long>> oldest = recent.entrySet().iterator();
        while (oldest.hasNext()) {
            final Map.Entry<String, Long> entry = oldest.next();
            if (recent.size() <= RECENT_LIMIT && entry.getValue() >= now - RECENT_MS) break;
            oldest.remove();
        }
        final JSONObject saved = new JSONObject();
        try {
            for (final Map.Entry<String, Long> entry : recent.entrySet()) saved.put(entry.getKey(), entry.getValue());
        } catch (JSONException ignored) {
            // no pasa con números
        }
        getSharedPreferences(QUEUE_PREFS, MODE_PRIVATE).edit().putString("recent", saved.toString()).apply();
    }

    private void loadRecent(SharedPreferences prefs) {
        final long since = System.currentTimeMillis() - RECENT_MS;
        try {
            final JSONObject saved = new JSONObject(prefs.getString("recent", "{}"));
            final List<Map.Entry<String, Long>> entries = new ArrayList<>();
            for (final Iterator<String> ids = saved.keys(); ids.hasNext(); ) {
                final String id = ids.next();
                final long at = saved.optLong(id);
                if (at >= since) entries.add(new java.util.AbstractMap.SimpleEntry<>(id, at));
            }
            entries.sort((a, b) -> Long.compare(a.getValue(), b.getValue()));
            for (final Map.Entry<String, Long> entry : entries) recent.put(entry.getKey(), entry.getValue());
        } catch (JSONException error) {
            Log.w(TAG, "El historial de 24 h está dañado", error);
        }
    }

    /** Pre-carga: la URL de la siguiente se extrae mientras suena la actual, así «siguiente» no espera a NewPipe. */
    private void prefetchNext() {
        if (offline) return; // la caché ya está en el teléfono (y sin internet no hay qué extraer)
        final int next = player.getNextMediaItemIndex();
        if (next == C.INDEX_UNSET) return;
        final String videoId = player.getMediaItemAt(next).mediaId;
        if (!OfflineCache.isCached(videoId)) StreamResolver.prefetch(videoId); // la descargada no necesita NewPipe
    }

    /**
     * soundblue://youtube/<id> → si está descargada, su archivo del teléfono (sin internet ni NewPipe); si no, la URL de
     * audio que da NewPipe. La fuente se decide al empezar la canción y se mantiene al adelantar (si se descargó mientras
     * sonaba, sigue por internet hasta que vuelva a empezar). Corre en el hilo de carga de ExoPlayer.
     */
    private static DataSpec resolve(DataSpec spec) throws IOException {
        if (!SCHEME.equals(spec.uri.getScheme())) return spec;
        final String segment = spec.uri.getLastPathSegment();
        final String videoId = segment == null ? "" : segment;
        final java.io.File file = OfflineCache.fileFor(videoId);
        final Boolean pinned = spec.position == 0 ? null : FROM_FILE.get(videoId);
        final boolean useFile = file != null && (pinned == null || pinned);
        FROM_FILE.put(videoId, useFile);
        if (useFile) return spec.withUri(Uri.fromFile(file));
        return spec.withUri(Uri.parse(StreamResolver.resolve(videoId).audioUrl));
    }

    /** Sin internet: salta a la siguiente descargada de la cola (las que no lo están no pueden sonar). False si no hay. */
    private boolean skipToDownloaded() {
        for (int i = player.getCurrentMediaItemIndex() + 1; i < player.getMediaItemCount(); i++) {
            if (!OfflineCache.isCached(player.getMediaItemAt(i).mediaId)) continue;
            retried = null;
            player.seekTo(i, 0);
            player.prepare();
            return true;
        }
        return false;
    }

    // ---- Errores ----

    private void onError(PlaybackException error) {
        final MediaItem item = player.getCurrentMediaItem();
        if (item == null) return;
        final String videoId = item.mediaId;
        cancelFade(); // la que suena falló: sin mezcla; lo de abajo decide qué sigue
        if (offline) {
            onOfflineError(item, error);
            return;
        }
        final boolean network = isNetworkError(error);
        if (network && !isOnline()) {
            // Sin internet: sigue la siguiente descargada de la cola; si no queda ninguna, la caché offline en bucle hasta
            // que vuelva la conexión; si tampoco hay, la canción espera.
            if (skipToDownloaded() || enterOffline(false)) return;
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
        // Otra vez sin respuesta de la red (señal muy débil o una red sin salida a internet): la caché, en vez de saltar.
        if (network && (skipToDownloaded() || enterOffline(false))) return;
        failures++;
        final boolean skip = failures <= MAX_FAILURES && player.hasNextMediaItem();
        // NewPipe no pudo con 10 seguidas: antes de quedarse en silencio, suena la caché (hasta que NewPipe vuelva a poder).
        if (!skip && failures > MAX_FAILURES && enterOffline(true)) return;
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

    // ---- Transición suave (crossfade) ----

    private void scheduleFadeWatch() {
        main.removeCallbacks(fadeWatch);
        if (crossfade && !fading) main.postDelayed(fadeWatch, FADE_WATCH_MS);
    }

    /**
     * Mientras suena (cada medio segundo): ¿le quedan 10 s o menos a la canción? Entonces empieza la mezcla. No hay
     * mezcla sin siguiente en la cola, con «repetir una», en el modo offline (la caché en bucle) ni en canciones de menos
     * de 20 s (no habría qué mezclar).
     */
    private void watchForFade() {
        if (!crossfade || fading || !player.isPlaying()) return;
        final MediaItem leaving = player.getCurrentMediaItem();
        final boolean blocked = leaving != null && leaving.mediaId.equals(noFadeFor);
        final long duration = player.getDuration();
        final long remaining = duration - player.getCurrentPosition();
        if (!blocked && duration != C.TIME_UNSET && duration >= CROSSFADE_MS * 2 && remaining <= CROSSFADE_MS && remaining > FADE_TICK_MS * 5
                && !offline && player.getRepeatMode() == Player.REPEAT_MODE_OFF && player.hasNextMediaItem()) {
            startFade();
            return;
        }
        main.postDelayed(fadeWatch, FADE_WATCH_MS);
    }

    /**
     * Empieza la mezcla: el reproductor de repuesto recibe la misma cola, arranca la SIGUIENTE en volumen 0 (su URL ya la
     * pre-cargó NewPipe, o es un archivo descargado) y cada 100 ms fadeStep reparte el volumen.
     */
    private void startFade() {
        final int next = player.getNextMediaItemIndex();
        if (next == C.INDEX_UNSET) return;
        if (spare == null) spare = buildPlayer(false);
        final List<MediaItem> items = new ArrayList<>();
        for (int i = 0; i < player.getMediaItemCount(); i++) items.add(player.getMediaItemAt(i));
        fading = true;
        final MediaItem leaving = player.getCurrentMediaItem();
        fadeFromId = leaving == null ? null : leaving.mediaId;
        spare.addListener(spareListener);
        spare.setVolume(0f);
        spare.setRepeatMode(player.getRepeatMode());
        spare.setMediaItems(items, next, 0);
        spare.prepare();
        spare.setPlayWhenReady(true);
        main.removeCallbacks(fadeTick);
        main.post(fadeTick);
    }

    /**
     * Un ajuste de la mezcla (cada 100 ms): la que se va suena a (lo que le queda / 10 s) y la que entra a (1 − eso), las
     * dos sobre el volumen que pidió la app. Cuando a la que se va ya no le queda nada, termina (finishFade).
     */
    private void fadeStep() {
        if (!fading) return;
        if (player.getDuration() == C.TIME_UNSET) {
            cancelFade();
            return;
        }
        final long remaining = Math.max(0, player.getDuration() - player.getCurrentPosition());
        final MediaItem now = player.getCurrentMediaItem();
        if (now == null || !now.mediaId.equals(fadeFromId) || player.getPlaybackState() == Player.STATE_ENDED
                || remaining <= FADE_TICK_MS) {
            finishFade();
            return;
        }
        final float leaving = Math.min(1f, remaining / (float) CROSSFADE_MS);
        player.setVolume(userVolume * leaving);
        spare.setVolume(userVolume * (1f - leaving));
        main.postDelayed(fadeTick, FADE_TICK_MS);
    }

    /**
     * Fin de la mezcla: la que entraba queda al 100 % y su reproductor pasa a ser el de la sesión (notificación, controles,
     * la cola), sin cortes porque ya venía sonando. El otro se detiene y queda de repuesto. La app se entera como de
     * cualquier cambio de canción («terminó la anterior»).
     */
    private void finishFade() {
        if (!fading) return;
        fading = false;
        main.removeCallbacks(fadeTick);
        final ExoPlayer old = player;
        final ExoPlayer entering = spare;
        entering.removeListener(spareListener);
        old.removeListener(playerListener);
        entering.setVolume(userVolume);
        player = entering;
        spare = old;
        player.addListener(playerListener);
        // Primero la sesión pasa a seguir a la que entra (así la notificación nunca ve un reproductor detenido); después el
        // foco de audio cambia de manos y la que se fue se detiene.
        session.setPlayer(player);
        old.setAudioAttributes(AUDIO_ATTRIBUTES, false);
        player.setAudioAttributes(AUDIO_ATTRIBUTES, true);
        old.stop();
        old.clearMediaItems();
        noFadeFor = null;
        final MediaItem item = player.getCurrentMediaItem();
        if (item != null) {
            retried = null;
            skippedFailed = null;
            advancing = false;
            failures = 0;
            remember(item.mediaId);
            prefetchNext();
            main.post(this::trimBehind);
            if (events != null) events.onTrackChanged(item.mediaId, "auto", autoIds.contains(item.mediaId) ? appLastId : null);
            checkQueue(true);
        }
        notifyState();
        updateWidget();
        saveQueue();
        if (player.isPlaying()) scheduleFadeWatch();
    }

    /** Deja la mezcla a medias: la que entraba se calla y la que suena vuelve a su volumen (como si no hubiera empezado). */
    private void cancelFade() {
        if (!fading) return;
        fading = false;
        main.removeCallbacks(fadeTick);
        if (spare != null) {
            spare.removeListener(spareListener);
            spare.stop();
            spare.clearMediaItems();
        }
        player.setVolume(userVolume);
        if (player.isPlaying()) scheduleFadeWatch();
    }

    // ---- Modo offline ----

    /**
     * Sin internet (o NewPipe sin poder extraer nada): la cola de la app queda guardada aquí, con la canción y el segundo
     * donde iba, y suenan las canciones de la caché offline una tras otra, en bucle, hasta que vuelva la conexión
     * (probeOnline). False si la caché está vacía.
     */
    private boolean enterOffline(boolean fromExtractor) {
        if (offline) return true;
        if (backupBlocked || player.getCurrentMediaItem() == null) return false;
        cancelFade();
        final List<MediaItem> backup = OfflineCache.mediaItems(this);
        if (backup.isEmpty()) return false;
        Collections.shuffle(backup);
        final List<MediaItem> items = new ArrayList<>();
        for (int i = 0; i < player.getMediaItemCount(); i++) items.add(player.getMediaItemAt(i));
        savedItems = items;
        savedIndex = player.getCurrentMediaItemIndex();
        savedPosition = Math.max(0, player.getCurrentPosition());
        savedRepeat = player.getRepeatMode();
        saveQueue(); // la cola de la app con su posición, para el widget (antes de cambiarla por la caché)
        offline = true;
        offlineFromExtractor = fromExtractor;
        waitingForNetwork = false;
        retried = null;
        main.removeCallbacks(autoExtend);
        extendRequest++;
        final boolean play = player.getPlayWhenReady();
        loading = true;
        try {
            player.setMediaItems(backup, 0, 0);
            player.setRepeatMode(Player.REPEAT_MODE_ALL);
            player.prepare();
            player.setPlayWhenReady(play);
        } finally {
            loading = false;
        }
        Log.i(TAG, "Modo offline: " + backup.size() + " canciones de la caché" + (fromExtractor ? " (NewPipe falla)" : ""));
        if (events != null) events.onOfflineChanged(true);
        notifyState();
        scheduleProbe(PROBE_MS);
        return true;
    }

    /**
     * Volvió internet: se deja de sonar la caché y la cola de la app sigue en la canción y el segundo donde iba (sonando,
     * salvo que hayas pausado la caché).
     */
    private void exitOffline() {
        if (!offline) return;
        final List<MediaItem> items = savedItems;
        final int index = Math.max(0, Math.min(savedIndex, items.size() - 1));
        final long position = savedPosition;
        final boolean play = player.getPlayWhenReady();
        dropOffline();
        if (items.isEmpty()) return;
        failures = 0;
        loading = true;
        try {
            player.setMediaItems(items, index, position);
            player.prepare();
            player.setPlayWhenReady(play);
        } finally {
            loading = false;
        }
        Log.i(TAG, "Fin del modo offline: sigue la cola donde iba");
        notifyState();
        prefetchNext();
        checkQueue(false);
    }

    /** Termina el modo offline sin volver a poner la cola guardada (la app manda la suya: load). */
    private void dropOffline() {
        if (!offline) return;
        offline = false;
        offlineFromExtractor = false;
        retried = null;
        waitingForNetwork = false;
        main.removeCallbacks(offlineProbe);
        player.setRepeatMode(savedRepeat);
        savedItems = new ArrayList<>();
        if (events != null) events.onOfflineChanged(false);
    }

    /** La app cambió su cola mientras suena la caché: se actualiza la que espera (si sigue siendo la misma canción). */
    private void updateSaved(String currentId, List<MediaItem> before, List<MediaItem> after, boolean endless) {
        if (savedItems.isEmpty() || savedIndex >= savedItems.size() || !savedItems.get(savedIndex).mediaId.equals(currentId)) return;
        final MediaItem current = savedItems.get(savedIndex);
        final List<MediaItem> items = new ArrayList<>(before);
        items.add(current);
        items.addAll(after);
        savedItems = items;
        savedIndex = before.size();
        fromApp(current, after, endless);
    }

    /** Una de la caché no se pudo reproducir (archivo dañado): sale de la caché y suena la siguiente. */
    private void onOfflineError(MediaItem item, PlaybackException error) {
        Log.w(TAG, "No se pudo reproducir " + item.mediaId + " de la caché offline", error);
        // Solo si el ARCHIVO está mal se borra la descarga; con otro error (audio, Bluetooth…) solo sale de lo que suena.
        final boolean badFile = error.errorCode == PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND
                || error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED
                || error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED;
        if (badFile) OfflineCache.remove(this, item.mediaId);
        if (player.getMediaItemCount() <= 1) {
            // No queda ninguna que suene: vuelve la cola y espera a internet como antes (sin volver a la caché hasta que
            // vuelva la conexión o elijas otra canción, para no dar vueltas con la misma que falla).
            backupBlocked = true;
            exitOffline();
            return;
        }
        player.removeMediaItem(player.getCurrentMediaItemIndex());
        player.prepare();
    }

    /** «Limpiar caché offline» con la caché sonando: la cola vuelve (y, sin internet, espera la conexión). */
    void onOfflineCacheCleared() {
        if (offline) exitOffline();
    }

    private void scheduleProbe(long delayMs) {
        main.removeCallbacks(offlineProbe);
        if (offline) main.postDelayed(offlineProbe, delayMs);
    }

    /**
     * ¿Volvió internet? Se prueba a extraer la canción que espera: si NewPipe la da (o YouTube responde, aunque sea que
     * no está disponible), la cola sigue. Si se entró por fallos de NewPipe, solo cuando la extracción vuelva a funcionar.
     */
    private void probeOnline() {
        if (!offline || savedItems.isEmpty()) return;
        if (!isOnline()) {
            scheduleProbe(PROBE_MS);
            return;
        }
        final String videoId = savedItems.get(Math.max(0, Math.min(savedIndex, savedItems.size() - 1))).mediaId;
        StreamResolver.probe(videoId).whenComplete((stream, error) -> main.post(() -> {
            if (!offline || instance == null) return;
            final boolean back = error == null || (!offlineFromExtractor && !isNetworkCause(error));
            if (back) exitOffline();
            else scheduleProbe(PROBE_MS);
        }));
    }

    private static boolean isNetworkCause(Throwable error) {
        return hasCause(error, UnknownHostException.class)
                || hasCause(error, ConnectException.class)
                || hasCause(error, NoRouteToHostException.class)
                || hasCause(error, SocketTimeoutException.class)
                || hasCause(error, java.io.InterruptedIOException.class);
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
                    if (instance == null) return;
                    backupBlocked = false; // hay red otra vez
                    if (offline) {
                        scheduleProbe(PROBE_SOON_MS); // ¿ya hay internet de verdad? Si sí, sigue la cola
                        return;
                    }
                    if (!waitingForNetwork) return;
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
            if (fading) {
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                    // La que se iba terminó antes del último ajuste: la mezcla acaba aquí (el otro ya suena la siguiente).
                    main.post(PlaybackService.this::finishFade);
                    return;
                }
                cancelFade(); // saltaste a otra a mano (notificación, audífonos): sin mezcla
            }
            noFadeFor = null;
            retried = null;
            if (offline) {
                // La caché offline: la app no la sigue como su cola (le llega por «state», con offline: true).
                remember(item.mediaId);
                notifyState();
                return;
            }
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
            if (isPlaying && !offline) {
                failures = 0;
                prefetchNext();
            }
            // Transición suave: sonando, se vigila cuándo faltan 10 s. En pausa (o si una llamada quitó el foco de audio)
            // la mezcla se deja: la que estaba entrando no debe seguir sola. Cargando (buffer) no se toca.
            if (isPlaying) scheduleFadeWatch();
            else {
                main.removeCallbacks(fadeWatch);
                if (fading && player.getPlaybackState() == Player.STATE_READY) cancelFade();
            }
            notifyState();
        }

        @Override
        public void onPositionDiscontinuity(Player.PositionInfo oldPosition, Player.PositionInfo newPosition, int reason) {
            // Adelantaste o atrasaste la canción (también desde la notificación): la mezcla en curso ya no corresponde.
            if (fading && reason == Player.DISCONTINUITY_REASON_SEEK) cancelFade();
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
