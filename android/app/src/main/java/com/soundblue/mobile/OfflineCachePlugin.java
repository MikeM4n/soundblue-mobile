package com.soundblue.mobile;

import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * Puente de las descargas (OfflineCache) para la app: src/player/offlineCache.ts. Avisa cada cambio de una canción
 * («track»: en cola, descargando, lista, falló, quitada) y cuántas se borraron para hacer espacio («evicted») o no cupieron
 * («full»). Mientras la app está abierta escucha los cambios de red: lo que esperaba Wi-Fi (o internet) sigue solo.
 */
@CapacitorPlugin(name = "OfflineCache")
public final class OfflineCachePlugin extends Plugin implements OfflineCache.Listener {
    private static final long SETTLE_MS = 1_500; // Android tarda un momento en dar la red nueva como la activa

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable resume = () -> OfflineCache.resume(getContext());
    private ConnectivityManager.NetworkCallback networkCallback;

    @Override
    public void load() {
        super.load();
        OfflineCache.init(getContext());
        OfflineCache.setListener(this);
        final ConnectivityManager connectivity = getContext().getSystemService(ConnectivityManager.class);
        if (connectivity == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                scheduleResume();
            }

            @Override
            public void onCapabilitiesChanged(@NonNull Network network, @NonNull NetworkCapabilities capabilities) {
                scheduleResume(); // p. ej. la red pasó a no tener límite de datos (Wi-Fi)
            }
        };
        connectivity.registerDefaultNetworkCallback(networkCallback);
    }

    @Override
    protected void handleOnDestroy() {
        OfflineCache.clearListener(this);
        main.removeCallbacks(resume);
        final ConnectivityManager connectivity = getContext().getSystemService(ConnectivityManager.class);
        if (connectivity != null && networkCallback != null) connectivity.unregisterNetworkCallback(networkCallback);
        networkCallback = null;
        super.handleOnDestroy();
    }

    private void scheduleResume() {
        main.removeCallbacks(resume);
        main.postDelayed(resume, SETTLE_MS);
    }

    // ---- Avisos (OfflineCache.Listener) ----

    @Override
    public void onTrack(String videoId, String state) {
        final JSObject data = new JSObject();
        data.put("id", videoId);
        data.put("state", state);
        notifyListeners("track", data);
    }

    @Override
    public void onEvicted(int count) {
        final JSObject data = new JSObject();
        data.put("count", count);
        notifyListeners("evicted", data);
    }

    @Override
    public void onFull(int skipped) {
        final JSObject data = new JSObject();
        data.put("skipped", skipped);
        notifyListeners("full", data);
    }

    // ---- Pedidos de la app ----

    /** «Selecciones rápidas» (id, título, artista, álbum, carátula): el respaldo automático guarda las que falten. */
    @PluginMethod
    public void offer(final PluginCall call) {
        OfflineCache.offer(getContext(), tracks(call));
        call.resolve();
    }

    /** «Descargar» una lista o una canción. `plays`: el historial (decide qué se borra primero si no cabe). */
    @PluginMethod
    public void download(final PluginCall call) {
        OfflineCache.setPlays(plays(call));
        OfflineCache.download(getContext(), tracks(call));
        call.resolve();
    }

    @PluginMethod
    public void cancel(final PluginCall call) {
        OfflineCache.cancel(ids(call));
        call.resolve();
    }

    /** «Quitar descarga»: de una canción o de toda una lista. */
    @PluginMethod
    public void remove(final PluginCall call) {
        OfflineCache.remove(getContext(), ids(call));
        call.resolve(OfflineCache.status(getContext()));
    }

    @PluginMethod
    public void status(final PluginCall call) {
        call.resolve(OfflineCache.status(getContext()));
    }

    @PluginMethod
    public void list(final PluginCall call) {
        call.resolve(OfflineCache.list(getContext()));
    }

    /** El límite global (50 a 1000 canciones). Bajarlo borra al momento las que sobran (con el historial de `plays`). */
    @PluginMethod
    public void setLimit(final PluginCall call) {
        OfflineCache.setPlays(plays(call));
        OfflineCache.setLimit(getContext(), call.getInt("limit", OfflineCache.DEFAULT_LIMIT));
        call.resolve(OfflineCache.status(getContext()));
    }

    /** «Descargar solo con Wi-Fi» (Ajustes). Apagado, también se descarga con datos móviles. */
    @PluginMethod
    public void setWifiOnly(final PluginCall call) {
        OfflineCache.setWifiOnly(getContext(), call.getBoolean("enabled", true));
        call.resolve(OfflineCache.status(getContext()));
    }

    /** «Borrar todas las descargas» (Ajustes). Si estaba sonando la caché, la cola de antes vuelve a su sitio. */
    @PluginMethod
    public void clear(final PluginCall call) {
        OfflineCache.clear(getContext());
        main.post(() -> {
            final PlaybackService service = PlaybackService.get();
            if (service != null) service.onOfflineCacheCleared();
            call.resolve(OfflineCache.status(getContext()));
        });
    }

    // ---- Internos ----

    private static List<JSONObject> tracks(PluginCall call) {
        final JSArray tracks = call.getArray("tracks");
        final List<JSONObject> list = new ArrayList<>();
        if (tracks == null) return list;
        for (int i = 0; i < tracks.length(); i++) {
            final JSONObject track = tracks.optJSONObject(i);
            if (track != null) list.add(track);
        }
        return list;
    }

    private static List<String> ids(PluginCall call) {
        final JSArray ids = call.getArray("ids");
        final List<String> list = new ArrayList<>();
        if (ids == null) return list;
        for (int i = 0; i < ids.length(); i++) {
            final String id = ids.optString(i, "");
            if (!id.isEmpty()) list.add(id);
        }
        return list;
    }

    /** {id: [veces escuchada, última vez (ms)]} → mapa. */
    private static Map<String, long[]> plays(PluginCall call) {
        final Map<String, long[]> plays = new HashMap<>();
        final JSObject json = call.getObject("plays");
        if (json == null) return plays;
        for (final Iterator<String> keys = json.keys(); keys.hasNext(); ) {
            final String id = keys.next();
            final JSONArray value = json.optJSONArray(id);
            if (value != null) plays.put(id, new long[] {value.optLong(0), value.optLong(1)});
        }
        return plays;
    }
}
