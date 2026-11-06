package com.soundblue.mobile;

import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Puente de la caché offline (OfflineCache) para la app: src/player/offlineCache.ts. Mientras la app está abierta escucha
 * los cambios de red: si había canciones esperando Wi-Fi (o internet), siguen descargándose solas al llegar.
 */
@CapacitorPlugin(name = "OfflineCache")
public final class OfflineCachePlugin extends Plugin {
    private static final long SETTLE_MS = 1_500; // Android tarda un momento en dar la red nueva como la activa

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable resume = () -> OfflineCache.resume(getContext());
    private ConnectivityManager.NetworkCallback networkCallback;

    @Override
    public void load() {
        super.load();
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

    /** Canciones de «Selecciones rápidas» (id, título, artista, álbum, carátula): se guardan las que falten. */
    @PluginMethod
    public void offer(final PluginCall call) {
        final JSArray tracks = call.getArray("tracks");
        final List<JSONObject> list = new ArrayList<>();
        if (tracks != null) {
            for (int i = 0; i < tracks.length(); i++) {
                final JSONObject track = tracks.optJSONObject(i);
                if (track != null) list.add(track);
            }
        }
        OfflineCache.offer(getContext(), list);
        call.resolve();
    }

    @PluginMethod
    public void status(final PluginCall call) {
        call.resolve(OfflineCache.status(getContext()));
    }

    /** Cuántas canciones guardar (Ajustes): 15, 30, 50 o 100. Bajarlo borra las más viejas al momento. */
    @PluginMethod
    public void setLimit(final PluginCall call) {
        OfflineCache.setLimit(getContext(), call.getInt("limit", OfflineCache.DEFAULT_LIMIT));
        call.resolve(OfflineCache.status(getContext()));
    }

    /** «Descargar solo con Wi-Fi» (Ajustes). Apagado, también se descarga con datos móviles. */
    @PluginMethod
    public void setWifiOnly(final PluginCall call) {
        OfflineCache.setWifiOnly(getContext(), call.getBoolean("enabled", true));
        call.resolve(OfflineCache.status(getContext()));
    }

    /** «Limpiar caché offline» en Ajustes. Si estaba sonando la caché, la cola de antes vuelve a su sitio. */
    @PluginMethod
    public void clear(final PluginCall call) {
        OfflineCache.clear(getContext());
        main.post(() -> {
            final PlaybackService service = PlaybackService.get();
            if (service != null) service.onOfflineCacheCleared();
            call.resolve(OfflineCache.status(getContext()));
        });
    }
}
