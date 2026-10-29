package com.soundblue.mobile;

import android.content.ComponentName;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.ContextCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * Puente entre la interfaz (src/player/nativePlayer.ts) y PlaybackService. La app le dice qué suena y qué sigue; los
 * cambios de canción, el estado y los fallos vuelven como eventos («trackChanged», «state», «trackFailed»).
 */
@CapacitorPlugin(name = "NativePlayer")
public final class PlaybackPlugin extends Plugin implements PlaybackService.Events {
    private static final String TAG = "PlaybackPlugin";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Runnable> pending = new ArrayList<>();
    private ListenableFuture<MediaController> connecting;
    private MediaController controller; // mantiene el servicio vivo mientras la app está abierta

    @Override
    protected void handleOnDestroy() {
        final PlaybackService service = PlaybackService.get();
        if (service != null) {
            service.clearEvents(this);
            // Cerrar la app (no solo mandarla a segundo plano) detiene la música, como antes: al abrirla de nuevo la
            // sesión se restaura en pausa y no debe quedar sonando otra cosa por detrás.
            if (getActivity() != null && getActivity().isFinishing()) service.pause();
        }
        if (controller != null) controller.release();
        else if (connecting != null) MediaController.releaseFuture(connecting);
        controller = null;
        connecting = null;
    }

    @PluginMethod
    public void load(final PluginCall call) {
        final JSObject current = call.getObject("current");
        if (current == null || !StreamResolver.VIDEO_ID.matcher(current.optString("id")).matches()) {
            call.reject("El identificador del video de YouTube no es válido.");
            return;
        }
        final List<MediaItem> before = items(call.getArray("history"));
        final List<MediaItem> after = items(call.getArray("upcoming"));
        final MediaItem item = item(current);
        final long startMs = Math.max(0, Math.round(call.getDouble("start", 0.0) * 1000));
        final boolean autoplay = call.getBoolean("autoplay", true);
        final float volume = call.getFloat("volume", 1f);
        final int generation = call.getInt("seq", 0);
        withService(call, (service) -> {
            service.load(before, item, after, startMs, autoplay, volume, generation);
            call.resolve();
        });
    }

    @PluginMethod
    public void setNeighbors(final PluginCall call) {
        final String currentId = call.getString("currentId", "");
        final List<MediaItem> before = items(call.getArray("history"));
        final List<MediaItem> after = items(call.getArray("upcoming"));
        withService(call, (service) -> {
            service.setNeighbors(currentId, before, after);
            call.resolve();
        });
    }

    @PluginMethod
    public void play(final PluginCall call) {
        withService(call, (service) -> {
            service.play();
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(final PluginCall call) {
        withService(call, (service) -> {
            service.pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void seek(final PluginCall call) {
        final long positionMs = Math.max(0, Math.round(call.getDouble("seconds", 0.0) * 1000));
        withService(call, (service) -> {
            service.seekTo(positionMs);
            call.resolve();
        });
    }

    @PluginMethod
    public void previous(final PluginCall call) {
        withService(call, (service) -> {
            service.previous();
            call.resolve();
        });
    }

    @PluginMethod
    public void setVolume(final PluginCall call) {
        final float volume = call.getFloat("volume", 1f);
        withService(call, (service) -> {
            service.setVolume(volume);
            call.resolve();
        });
    }

    @PluginMethod
    public void setRepeatOne(final PluginCall call) {
        final boolean enabled = call.getBoolean("enabled", false);
        withService(call, (service) -> {
            service.setRepeatOne(enabled);
            call.resolve();
        });
    }

    @PluginMethod
    public void getState(final PluginCall call) {
        main.post(() -> call.resolve(state()));
    }

    /** Si la canción está en Tus me gusta (el corazón del widget). Sin el servicio en marcha no hay widget que pintar. */
    @PluginMethod
    public void setLiked(final PluginCall call) {
        final String videoId = call.getString("id", "");
        final boolean liked = call.getBoolean("liked", false);
        main.post(() -> {
            final PlaybackService service = PlaybackService.get();
            if (service != null) service.setLiked(videoId, liked);
            call.resolve();
        });
    }

    // ---- Eventos del servicio (hilo principal) ----

    @Override
    public void onTrackChanged(String videoId, String reason) {
        final JSObject data = state();
        data.put("id", videoId);
        data.put("reason", reason);
        notifyListeners("trackChanged", data);
    }

    @Override
    public void onStateChanged() {
        notifyListeners("state", state());
    }

    @Override
    public void onTrackFailed(String videoId, String message, boolean network, boolean skipped) {
        final PlaybackService service = PlaybackService.get();
        final JSObject data = new JSObject();
        data.put("id", videoId);
        data.put("message", message);
        data.put("network", network);
        data.put("skipped", skipped);
        data.put("seq", service == null ? 0 : service.getGeneration());
        notifyListeners("trackFailed", data);
    }

    @Override
    public void onLikeToggle(String videoId) {
        final JSObject data = new JSObject();
        data.put("id", videoId);
        notifyListeners("likeToggle", data);
    }

    // ---- Internos ----

    /** Corre `action` en el hilo principal con el servicio ya creado (la primera vez lo conecta). */
    private void withService(final PluginCall call, final Consumer<PlaybackService> action) {
        main.post(() -> {
            if (controller != null && PlaybackService.get() != null) {
                run(call, action);
                return;
            }
            pending.add(() -> run(call, action));
            connect();
        });
    }

    private void run(final PluginCall call, final Consumer<PlaybackService> action) {
        final PlaybackService service = PlaybackService.get();
        if (service == null) {
            call.reject("El reproductor de Android no está disponible.");
            return;
        }
        try {
            service.setEvents(this);
            action.accept(service);
        } catch (RuntimeException error) {
            Log.e(TAG, "Falló una orden al reproductor", error);
            call.reject("El reproductor no pudo hacerlo: " + StreamResolver.safe(error.getMessage(), "error"), error);
        }
    }

    private void connect() {
        if (connecting != null) return;
        final SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), PlaybackService.class));
        final ListenableFuture<MediaController> future = new MediaController.Builder(getContext(), token).buildAsync();
        connecting = future;
        future.addListener(() -> {
            try {
                controller = future.get();
            } catch (Exception error) {
                Log.e(TAG, "No se pudo conectar con el reproductor", error);
                connecting = null;
            }
            final List<Runnable> waiting = new ArrayList<>(pending);
            pending.clear();
            for (final Runnable task : waiting) task.run();
        }, ContextCompat.getMainExecutor(getContext()));
    }

    private JSObject state() {
        final JSObject data = new JSObject();
        final PlaybackService service = PlaybackService.get();
        if (service == null) {
            data.put("status", "paused");
            return data;
        }
        final Player player = service.getPlayer();
        final MediaItem item = player.getCurrentMediaItem();
        final long duration = player.getDuration();
        data.put("id", item == null ? "" : item.mediaId);
        data.put("status", status(player));
        data.put("position", player.getCurrentPosition() / 1000.0);
        data.put("duration", duration == C.TIME_UNSET ? 0 : duration / 1000.0);
        data.put("seq", service.getGeneration());
        return data;
    }

    private static String status(Player player) {
        switch (player.getPlaybackState()) {
            case Player.STATE_IDLE:
                return player.getPlayerError() != null ? "error" : "paused";
            case Player.STATE_ENDED:
                return "ended";
            case Player.STATE_BUFFERING:
                return player.getPlayWhenReady() ? "buffering" : "paused";
            default:
                return player.isPlaying() ? "playing" : "paused";
        }
    }

    private static List<MediaItem> items(final JSArray tracks) {
        final List<MediaItem> items = new ArrayList<>();
        if (tracks == null) return items;
        for (int i = 0; i < tracks.length(); i++) {
            final JSONObject track = tracks.optJSONObject(i);
            if (track != null && StreamResolver.VIDEO_ID.matcher(track.optString("id")).matches()) items.add(item(track));
        }
        return items;
    }

    /** La canción para ExoPlayer: su URL es soundblue://youtube/<id> y PlaybackService la resuelve con NewPipe al cargarla. */
    private static MediaItem item(final JSONObject track) {
        final String videoId = track.optString("id");
        final MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .setTitle(StreamResolver.safe(track.optString("title"), videoId))
                .setArtist(StreamResolver.safe(track.optString("artist"), "SoundBlue"))
                .setAlbumTitle(StreamResolver.safe(track.optString("album"), "SoundBlue"));
        final String artwork = track.optString("artwork");
        if (artwork.startsWith("https:")) metadata.setArtworkUri(Uri.parse(artwork));
        return new MediaItem.Builder()
                .setMediaId(videoId)
                .setUri(PlaybackService.uriFor(videoId))
                .setMediaMetadata(metadata.build())
                .build();
    }
}
