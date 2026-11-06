package com.soundblue.mobile;

import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Puente de la caché offline (OfflineCache) para la app: src/player/offlineCache.ts. */
@CapacitorPlugin(name = "OfflineCache")
public final class OfflineCachePlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());

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
