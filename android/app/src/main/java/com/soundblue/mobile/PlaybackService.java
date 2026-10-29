package com.soundblue.mobile;

import android.app.PendingIntent;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;

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

    /** Lo que la interfaz quiere saber del reproductor. Siempre en el hilo principal. */
    interface Events {
        /** reason: "auto" (terminó la anterior), "seek" (un botón o la app) o "failed" (la anterior no se pudo reproducir). */
        void onTrackChanged(String videoId, String reason);

        void onStateChanged();

        void onTrackFailed(String videoId, String message, boolean network, boolean skipped);
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
    private int generation; // número del último `load` de la app: con él, la app descarta avisos de antes

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
        session = new MediaSession.Builder(this, player).setSessionActivity(openApp).build();

        final DefaultMediaNotificationProvider notification = new DefaultMediaNotificationProvider.Builder(this).build();
        notification.setSmallIcon(R.drawable.ic_stat_soundblue);
        setMediaNotificationProvider(notification);

        registerNetworkCallback();
        instance = this;
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
        if (networkCallback != null) {
            final ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
            if (connectivity != null) connectivity.unregisterNetworkCallback(networkCallback);
            networkCallback = null;
        }
        player.release();
        session.release();
        super.onDestroy();
    }

    // ---- Lo que pide la app (hilo principal) ----

    void setEvents(Events events) {
        this.events = events;
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
    void load(List<MediaItem> before, MediaItem current, List<MediaItem> after, long startMs, boolean autoplay,
              float volume, int generation) {
        this.generation = generation;
        retried = null;
        skippedFailed = null;
        waitingForNetwork = false;
        // Al cambiar la cola y luego `playWhenReady`, ExoPlayer pasaría un momento por «en pausa» y la app quitaría la
        // rueda de carga mientras NewPipe extrae el audio. Se avisa un solo estado al final: «cargando» (o «en pausa»).
        loading = true;
        try {
            loadItems(before, current, after, startMs, autoplay, volume);
        } finally {
            loading = false;
        }
        notifyState();
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
    void setNeighbors(String currentId, List<MediaItem> before, List<MediaItem> after) {
        final MediaItem current = player.getCurrentMediaItem();
        if (current == null || !current.mediaId.equals(currentId)) return;
        replaceBefore(before);
        replaceAfter(after);
        prefetchNext();
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
        if (!skip) return;
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
                    : reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO ? "auto" : "seek";
            skippedFailed = null;
            prefetchNext();
            main.post(PlaybackService.this::trimBehind);
            if (events != null && reason != Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) {
                events.onTrackChanged(item.mediaId, cause);
            }
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
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            notifyState();
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            onError(error);
        }
    }
}
