package com.soundblue.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Descargas para escuchar sin conexión: el AUDIO guardado en el teléfono (files/offline) y su lista (SharedPreferences).
 * Hay dos clases:
 *  - Las que descargas tú («Descargar» en una lista o en el menú ⋮ de una canción): quedan hasta que las quites.
 *  - El respaldo automático: hasta 50 de «Selecciones rápidas», si caben; las de más de 24 h se renuevan.
 * Una descargada suena desde el teléfono (PlaybackService.resolve), con o sin internet. Sin internet, PlaybackService salta
 * las que no están descargadas y, si ya no queda ninguna por delante, pone todas en bucle (modo offline).
 * Límite global (Ajustes, guardado también en la app): de 50 a 1000 canciones, 200 por defecto. Si lo que pides no cabe,
 * se borran primero las del respaldo (las más viejas) y después las tuyas que menos escuchas (y las más viejas), según el
 * historial de la app; nunca las de la misma descarga. Si aun así no cabe, lo que falta no se descarga (onFull).
 * «Descargar solo con Wi-Fi» (encendido por defecto): solo se descarga en una red sin límite de datos; si toca esperar,
 * lo pendiente sigue solo al llegar la red (resume, desde OfflineCachePlugin).
 */
@OptIn(markerClass = UnstableApi.class)
final class OfflineCache {
    private static final String TAG = "OfflineCache";
    private static final String PREFS = "soundblue_offline";
    private static final String KEY = "entries";
    private static final String LIMIT_KEY = "limit";
    private static final String WIFI_ONLY_KEY = "wifiOnly";
    private static final String DIR = "offline";
    static final int MIN_LIMIT = 50;
    static final int MAX_LIMIT = 1000;
    static final int DEFAULT_LIMIT = 200;
    static final int AUTO_TARGET = 50; // respaldo automático de «Selecciones rápidas», si cabe
    static final long KEEP_MS = 24 * 60 * 60 * 1000L;
    private static final long MAX_BYTES = 25L * 1024 * 1024; // por canción: nada de mezclas de una hora
    private static final long MAX_SONG_S = 10 * 60;
    private static final int CHUNK = 1024 * 1024; // de a 1 MB, como pide ExoPlayer (así YouTube no frena la descarga)
    private static final int MAX_RETRIES = 3; // cortes de red seguidos en la misma canción antes de darla por fallida
    private static final long RETRY_MS = 30_000; // tras un corte con la red aparentemente bien, se reintenta a los 30 s
    private static final Object LOCK = new Object();
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();

    /** Lo que la app quiere saber (OfflineCachePlugin). Se llama desde el hilo de descargas o el de la app. */
    interface Listener {
        /** state: "queued", "downloading", "done", "failed" o "removed" (quitada, cancelada o borrada para hacer espacio). */
        void onTrack(String videoId, String state);

        /** Se borraron `count` para hacer espacio (al descargar algo nuevo o al bajar el límite). */
        void onEvicted(int count);

        /** No cupieron `skipped` de las que pediste (el límite está lleno de las que estás descargando). */
        void onFull(int skipped);
    }

    /** Una canción guardada. `manual`: la descargaste tú (si no, es del respaldo automático). */
    static final class Entry {
        final String id;
        final String title;
        final String artist;
        final String album;
        final String artwork;
        final String file;
        final long size;
        final long savedAt;
        boolean manual;

        Entry(String id, String title, String artist, String album, String artwork, String file, long size, long savedAt, boolean manual) {
            this.id = id;
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.artwork = artwork;
            this.file = file;
            this.size = size;
            this.savedAt = savedAt;
            this.manual = manual;
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject().put("id", id).put("title", title).put("artist", artist).put("album", album)
                    .put("artwork", artwork).put("file", file).put("size", size).put("savedAt", savedAt).put("manual", manual);
        }

        static Entry fromJson(JSONObject json) {
            return new Entry(json.optString("id"), json.optString("title"), json.optString("artist"), json.optString("album"),
                    json.optString("artwork"), json.optString("file"), json.optLong("size"), json.optLong("savedAt"),
                    json.optBoolean("manual", false)); // las de la 1.9.x eran todas del respaldo
        }
    }

    /** Lo siguiente que toca descargar: una tuya o una del respaldo (que, si `replace`, ocupa el lugar de esa vieja). */
    private static final class Job {
        final JSONObject track;
        final boolean manual;
        @Nullable final String replace;

        Job(JSONObject track, boolean manual, @Nullable String replace) {
            this.track = track;
            this.manual = manual;
            this.replace = replace;
        }

        String id() {
            return track.optString("id");
        }
    }

    // Todo lo de abajo se toca con LOCK.
    private static Context app;
    private static LinkedHashMap<String, Entry> index; // las guardadas, de la más vieja a la más nueva
    private static final LinkedHashMap<String, JSONObject> manualQueue = new LinkedHashMap<>(); // las que pediste, en orden
    private static List<JSONObject> autoOffer = new ArrayList<>(); // las últimas «Selecciones rápidas» ofrecidas
    private static final Map<String, long[]> plays = new HashMap<>(); // id → {veces escuchada, última vez}: de la app
    private static final Set<String> batch = new HashSet<>(); // las de tus descargas en curso: no se borran para hacer espacio
    private static boolean scheduled; // hay una tanda de descargas en marcha (o encargada)
    private static boolean waiting; // hay pendientes esperando red (Wi-Fi o internet)
    private static volatile String current; // la tuya que se está descargando
    private static volatile boolean cancelCurrent;
    private static volatile boolean autoBusy; // descargando una del respaldo
    private static boolean networkFailure; // la última fetch falló por la red (solo el hilo de descargas)
    private static String retryId; // la que falló por un corte de red…
    private static int retryCount; // …y cuántas veces seguidas
    private static volatile int generation; // sube al limpiar: la descarga en curso se descarta
    private static volatile Listener listener;

    private OfflineCache() {}

    static void init(Context context) {
        synchronized (LOCK) {
            if (app == null) app = context.getApplicationContext();
        }
    }

    static void setListener(Listener value) {
        listener = value;
    }

    /** Solo si sigue siendo `value`: al reabrir la app, la vieja se destruye después de que la nueva se registró. */
    static void clearListener(Listener value) {
        if (listener == value) listener = null;
    }

    // ---- Lectura ----

    private static File dir() {
        final File dir = new File(app.getFilesDir(), DIR);
        if (!dir.exists() && !dir.mkdirs()) Log.w(TAG, "No se pudo crear " + dir);
        return dir;
    }

    /** La lista en memoria (la primera vez, de SharedPreferences; solo las que tienen su archivo). Con LOCK. */
    private static LinkedHashMap<String, Entry> index() {
        if (index != null) return index;
        index = new LinkedHashMap<>();
        final File dir = dir();
        try {
            final JSONArray saved = new JSONArray(prefs().getString(KEY, "[]"));
            for (int i = 0; i < saved.length(); i++) {
                final JSONObject json = saved.optJSONObject(i);
                if (json == null) continue;
                final Entry entry = Entry.fromJson(json);
                if (StreamResolver.VIDEO_ID.matcher(entry.id).matches() && new File(dir, entry.file).isFile()) index.put(entry.id, entry);
            }
        } catch (JSONException error) {
            Log.w(TAG, "La lista de descargas está dañada", error);
        }
        // Archivos sin anotar (la app se cerró a mitad de una descarga, o antes de guardar la lista): ocupan espacio y nadie
        // los usa. Solo al cargar, cuando todavía no hay ninguna descarga en curso.
        final Set<String> known = new HashSet<>();
        for (final Entry entry : index.values()) known.add(entry.file);
        final File[] files = dir.listFiles();
        if (files != null) {
            for (final File file : files) {
                if (!known.contains(file.getName()) && !file.delete()) Log.w(TAG, "No se pudo borrar " + file);
            }
        }
        return index;
    }

    /** El archivo de una canción descargada, o null. Para reproducirla desde el teléfono (PlaybackService.resolve). */
    @Nullable
    static File fileFor(String videoId) {
        synchronized (LOCK) {
            if (app == null || videoId == null) return null;
            final Entry entry = index().get(videoId);
            if (entry == null) return null;
            final File file = new File(dir(), entry.file);
            return file.isFile() ? file : null;
        }
    }

    static boolean isCached(String videoId) {
        return fileFor(videoId) != null;
    }

    /** Para el modo offline: todas las guardadas, listas para ExoPlayer (archivos del teléfono, sin NewPipe). */
    static List<MediaItem> mediaItems(Context context) {
        init(context);
        final List<MediaItem> items = new ArrayList<>();
        synchronized (LOCK) {
            final File dir = dir();
            for (final Entry entry : index().values()) {
                final File file = new File(dir, entry.file);
                if (!file.isFile()) continue;
                final MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                        .setTitle(StreamResolver.safe(entry.title, entry.id))
                        .setArtist(StreamResolver.safe(entry.artist, "SoundBlue"))
                        .setAlbumTitle("Modo offline");
                if (entry.artwork.startsWith("https:")) metadata.setArtworkUri(Uri.parse(entry.artwork));
                items.add(new MediaItem.Builder()
                        .setMediaId(entry.id)
                        .setUri(Uri.fromFile(file))
                        .setMediaMetadata(metadata.build())
                        .build());
            }
        }
        return items;
    }

    /** Cuántas hay (tuyas y del respaldo), cuánto ocupan, el límite, la red y si está descargando (para Ajustes). */
    static JSObject status(Context context) {
        init(context);
        final JSObject status = new JSObject();
        synchronized (LOCK) {
            final long staleBefore = System.currentTimeMillis() - KEEP_MS;
            long bytes = 0;
            long oldest = 0;
            long newest = 0;
            int manual = 0;
            int stale = 0;
            for (final Entry entry : index().values()) {
                bytes += entry.size;
                if (oldest == 0 || entry.savedAt < oldest) oldest = entry.savedAt;
                newest = Math.max(newest, entry.savedAt);
                if (entry.manual) manual++;
                else if (entry.savedAt < staleBefore) stale++;
            }
            status.put("count", index().size());
            status.put("manual", manual);
            status.put("auto", index().size() - manual);
            status.put("bytes", bytes);
            status.put("stale", stale);
            status.put("oldest", oldest);
            status.put("newest", newest);
            status.put("queued", manualQueue.size());
            status.put("waiting", waiting);
        }
        final boolean online = isOnline();
        status.put("target", limit());
        status.put("autoTarget", AUTO_TARGET);
        status.put("online", online);
        status.put("wifi", online && !isMetered());
        status.put("wifiOnly", wifiOnly());
        status.put("downloading", current != null || autoBusy);
        return status;
    }

    /** Qué hay: las descargadas (todas y las tuyas) y las pendientes (en cola o descargándose). */
    static JSObject list(Context context) {
        init(context);
        final JSArray downloaded = new JSArray();
        final JSArray manual = new JSArray();
        final JSArray pending = new JSArray();
        synchronized (LOCK) {
            for (final Entry entry : index().values()) {
                downloaded.put(entry.id);
                if (entry.manual) manual.put(entry.id);
            }
            for (final String id : manualQueue.keySet()) pending.put(id);
        }
        final String now = current;
        if (now != null && !contains(pending, now)) pending.put(now);
        final JSObject result = new JSObject();
        result.put("downloaded", downloaded);
        result.put("manual", manual);
        result.put("pending", pending);
        return result;
    }

    private static boolean contains(JSArray array, String value) {
        for (int i = 0; i < array.length(); i++) if (value.equals(array.optString(i))) return true;
        return false;
    }

    // ---- Ajustes ----

    /** El límite global (50 a 1000). Las de la 1.9.x (15, 30) suben a 50. */
    static int limit() {
        final int saved = prefs().getInt(LIMIT_KEY, DEFAULT_LIMIT);
        return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, saved));
    }

    /** Cambia el límite. Si hay más de las que caben, se borran al momento (primero el respaldo; ver pickVictim). */
    static void setLimit(Context context, int value) {
        init(context);
        final int limit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, value));
        prefs().edit().putInt(LIMIT_KEY, limit).apply();
        int evicted = 0;
        synchronized (LOCK) {
            while (index().size() > limit) {
                final Entry victim = pickVictim();
                if (victim == null) break;
                removeEntry(victim);
                evicted++;
            }
            if (evicted > 0) write();
        }
        notifyEvicted(evicted);
        schedule(); // si subió, puede que quepan las que esperaban
    }

    static boolean wifiOnly() {
        return prefs().getBoolean(WIFI_ONLY_KEY, true);
    }

    /** «Descargar solo con Wi-Fi». Al apagarlo, lo que esperaba Wi-Fi empieza ya con datos móviles. */
    static void setWifiOnly(Context context, boolean enabled) {
        init(context);
        prefs().edit().putBoolean(WIFI_ONLY_KEY, enabled).apply();
        resume(context);
    }

    /** El historial de la app (id → veces escuchada y última vez): decide cuáles se borran primero para hacer espacio. */
    static void setPlays(Map<String, long[]> history) {
        synchronized (LOCK) {
            plays.clear();
            plays.putAll(history);
        }
    }

    // ---- Pedidos ----

    /** «Selecciones rápidas» de Inicio: el respaldo automático guarda las que falten (si caben). */
    static void offer(Context context, List<JSONObject> tracks) {
        init(context);
        synchronized (LOCK) {
            autoOffer = new ArrayList<>(tracks);
        }
        schedule();
    }

    /**
     * «Descargar» (una lista o una canción): van a la cola, en orden. Las que ya estaban en el respaldo pasan a ser tuyas
     * sin volver a descargarse.
     */
    static void download(Context context, List<JSONObject> tracks) {
        init(context);
        final List<String> queued = new ArrayList<>();
        final List<String> pinned = new ArrayList<>();
        synchronized (LOCK) {
            boolean changed = false;
            for (final JSONObject track : tracks) {
                final String id = track.optString("id");
                if (!StreamResolver.VIDEO_ID.matcher(id).matches()) continue;
                batch.add(id);
                final Entry entry = index().get(id);
                if (entry != null) {
                    if (!entry.manual) {
                        entry.manual = true;
                        changed = true;
                    }
                    pinned.add(id);
                } else if (!manualQueue.containsKey(id) && (!id.equals(current) || cancelCurrent)) {
                    // (La que se está cancelando ahora mismo vuelve a la cola: la pediste otra vez.)
                    manualQueue.put(id, track);
                    queued.add(id);
                }
            }
            if (changed) write();
        }
        for (final String id : pinned) notifyTrack(id, "done");
        for (final String id : queued) notifyTrack(id, "queued");
        schedule();
    }

    /** Cancela las que estaban en cola (y la que se descarga, si es una de ellas). */
    static void cancel(List<String> ids) {
        final List<String> removed = new ArrayList<>();
        synchronized (LOCK) {
            for (final String id : ids) {
                if (manualQueue.remove(id) != null) removed.add(id);
                batch.remove(id);
            }
            if (current != null && ids.contains(current)) cancelCurrent = true; // la descarga en curso se corta
        }
        for (final String id : removed) notifyTrack(id, "removed");
    }

    /** «Quitar descarga»: borra las canciones (tuyas o del respaldo) y cancela las que estaban pendientes. */
    static void remove(Context context, List<String> ids) {
        init(context);
        cancel(ids);
        final List<String> removed = new ArrayList<>();
        synchronized (LOCK) {
            for (final String id : ids) {
                final Entry entry = index().get(id);
                if (entry == null) continue;
                removeEntry(entry);
                removed.add(id);
            }
            if (!removed.isEmpty()) write();
        }
        for (final String id : removed) notifyTrack(id, "removed");
    }

    /** «Borrar todas las descargas» (Ajustes): todo, también lo que se estaba descargando. */
    static void clear(Context context) {
        init(context);
        final List<String> removed;
        synchronized (LOCK) {
            generation++;
            removed = new ArrayList<>(index().keySet());
            removed.addAll(manualQueue.keySet());
            manualQueue.clear();
            batch.clear();
            autoOffer = new ArrayList<>();
            waiting = false;
            index().clear();
            final File[] files = dir().listFiles();
            if (files != null) for (final File file : files) if (!file.delete()) Log.w(TAG, "No se pudo borrar " + file);
            prefs().edit().remove(KEY).apply();
        }
        for (final String id : removed) notifyTrack(id, "removed");
    }

    /** Una que no se pudo reproducir (archivo dañado): sale de las descargas. */
    static void remove(Context context, String videoId) {
        final List<String> ids = new ArrayList<>();
        ids.add(videoId);
        remove(context, ids);
    }

    /** ¿Se puede descargar ahora? Con internet y, si es «solo con Wi-Fi», en una red sin límite de datos. */
    static boolean canDownload() {
        return isOnline() && (!wifiOnly() || !isMetered());
    }

    /** Cambió la red (o un ajuste): si había pendientes esperando y ya se puede, siguen. */
    static void resume(Context context) {
        init(context);
        synchronized (LOCK) {
            if (!waiting) return;
        }
        if (canDownload()) schedule();
    }

    // ---- Descargas (un solo hilo, de a una) ----

    private static void schedule() {
        synchronized (LOCK) {
            if (app == null || scheduled) return;
            scheduled = true;
        }
        WORKER.execute(OfflineCache::run);
    }

    private static void run() {
        int evicted = 0;
        int skipped = 0;
        try {
            while (true) {
                final Job job;
                synchronized (LOCK) {
                    final boolean work = !manualQueue.isEmpty() || !autoOffer.isEmpty();
                    if (work && !canDownload()) { // se pausa aquí y sigue al llegar la red (resume)
                        scheduled = false;
                        waiting = true;
                        return;
                    }
                    waiting = false;
                    job = work ? nextJob() : null;
                    if (job == null) {
                        scheduled = false;
                        batch.clear();
                        return;
                    }
                }
                if (job.manual) {
                    final int[] result = downloadManual(job);
                    if (result == null) { // se cayó la red: queda en la cola y sigue al volver (resume)
                        pause();
                        return;
                    }
                    evicted += result[0];
                    skipped += result[1];
                } else if (!downloadAuto(job)) {
                    pause();
                    return;
                }
            }
        } finally {
            notifyEvicted(evicted);
            final Listener target = listener;
            if (skipped > 0 && target != null) target.onFull(skipped);
        }
    }

    /**
     * Sin red a mitad de la tanda: lo pendiente espera a que vuelva (resume la retoma al cambiar la red). Si la red parece
     * estar bien (fue un corte), se reintenta solo a los 30 s.
     */
    private static void pause() {
        synchronized (LOCK) {
            scheduled = false;
            waiting = true;
        }
        if (canDownload()) new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> resume(app), RETRY_MS);
    }

    /** La siguiente: primero las que pediste; después el respaldo, si le falta o hay que renovar una vieja. Con LOCK. */
    @Nullable
    private static Job nextJob() {
        final Iterator<JSONObject> manual = manualQueue.values().iterator();
        if (manual.hasNext()) return new Job(manual.next(), true, null);
        final int limit = limit();
        int auto = 0;
        Entry stale = null;
        final long staleBefore = System.currentTimeMillis() - KEEP_MS;
        for (final Entry entry : index().values()) {
            if (entry.manual) continue;
            auto++;
            if (entry.savedAt < staleBefore && (stale == null || entry.savedAt < stale.savedAt)) stale = entry;
        }
        final boolean room = auto < AUTO_TARGET && index().size() < limit;
        if (!room && stale == null) {
            autoOffer = new ArrayList<>();
            return null;
        }
        while (!autoOffer.isEmpty()) {
            final JSONObject track = autoOffer.remove(0);
            final String id = track.optString("id");
            if (!StreamResolver.VIDEO_ID.matcher(id).matches() || index().containsKey(id)) continue;
            return new Job(track, false, room ? null : stale.id);
        }
        return null;
    }

    /**
     * Una de las que pediste. Devuelve {borradas para hacer espacio, las que no cupieron}, o null si se cayó la red (queda
     * en la cola para cuando vuelva).
     */
    @Nullable
    private static int[] downloadManual(Job job) {
        final String id = job.id();
        synchronized (LOCK) {
            if (!manualQueue.containsKey(id)) return new int[] {0, 0}; // la cancelaste justo ahora
            // Ya está guardada (p. ej. el respaldo la estaba bajando cuando la pediste): pasa a ser tuya, sin bajarla otra vez.
            final Entry saved = index().get(id);
            if (saved != null) {
                manualQueue.remove(id);
                if (!saved.manual) {
                    saved.manual = true;
                    write();
                }
                notifyTrack(id, "done");
                return new int[] {0, 0};
            }
            // ¿Cabe? Si está lleno y no hay nada que se pueda borrar, lo que falta de tus descargas no se descarga.
            if (index().size() >= limit() && pickVictim() == null) {
                final List<String> skipped = new ArrayList<>(manualQueue.keySet());
                manualQueue.clear();
                for (final String skip : skipped) notifyTrack(skip, "removed");
                return new int[] {0, skipped.size()};
            }
            current = id;
            cancelCurrent = false;
        }
        notifyTrack(id, "downloading");
        final File file = fetch(job.track);
        int evicted = 0;
        boolean saved = false;
        final String state;
        synchronized (LOCK) {
            final boolean cancelled = cancelCurrent;
            current = null;
            cancelCurrent = false;
            boolean offline = file == null && !cancelled && networkFailure;
            if (offline && canDownload()) {
                // La red parece estar pero falló (un corte): se reintenta, aunque no para siempre la misma canción.
                retryCount = id.equals(retryId) ? retryCount + 1 : 1;
                retryId = id;
                if (retryCount > MAX_RETRIES) offline = false;
            }
            // Cancelada: cancel() ya la sacó de la cola; si está otra vez, es que la volviste a pedir (se deja).
            if (!cancelled && !offline) manualQueue.remove(id);
            if (file != null && !cancelled) {
                while (index().size() >= limit()) {
                    final Entry victim = pickVictim();
                    if (victim == null) break;
                    removeEntry(victim);
                    evicted++;
                }
                saved = index().size() < limit() && commit(job.track, file, true);
            }
            if (!saved && file != null && file.exists() && !file.delete()) Log.w(TAG, "No se pudo borrar " + file);
            if (evicted > 0 || saved) write();
            if (!offline) retryId = null; // ya se resolvió (bien o mal): sus cortes no cuentan para la próxima vez
            state = saved ? "done" : offline || manualQueue.containsKey(id) ? "queued" : cancelled ? "removed" : "failed";
            if (offline) {
                notifyTrack(id, state);
                return null;
            }
        }
        notifyTrack(id, state);
        return new int[] {evicted, 0};
    }

    /** Una del respaldo automático (si toca, en el lugar de una de más de 24 h). False si se cayó la red (se reintenta). */
    private static boolean downloadAuto(Job job) {
        autoBusy = true;
        final File file;
        try {
            file = fetch(job.track);
        } finally {
            autoBusy = false;
        }
        if (file == null) {
            if (!networkFailure || canDownload()) return true; // falló ella (o un corte suelto): sigue con la siguiente
            synchronized (LOCK) {
                autoOffer.add(0, job.track); // se intenta otra vez al volver la red
            }
            return false;
        }
        synchronized (LOCK) {
            if (job.replace != null) {
                final Entry old = index().get(job.replace);
                if (old != null && !old.manual) removeEntry(old);
            }
            // Si mientras tanto tus descargas llenaron el límite (o ya la descargaste tú), el respaldo cede su lugar.
            if (index().containsKey(job.id()) || index().size() >= limit() || !commit(job.track, file, false)) {
                if (file.exists() && !file.delete()) Log.w(TAG, "No se pudo borrar " + file);
                write();
                return true;
            }
            write();
        }
        notifyTrack(job.id(), "done");
        return true;
    }

    /**
     * Cuál se borra para hacer espacio: primero las del respaldo (la más vieja); si no hay, de las tuyas la que menos
     * escuchas (y, a igual, la que hace más que no suena o se guardó hace más). Nunca las de tus descargas en curso.
     * Con LOCK. Null si no hay ninguna que se pueda borrar.
     */
    @Nullable
    private static Entry pickVictim() {
        Entry auto = null;
        Entry manual = null;
        for (final Entry entry : index().values()) {
            if (batch.contains(entry.id)) continue;
            if (!entry.manual) {
                if (auto == null || entry.savedAt < auto.savedAt) auto = entry;
            } else if (manual == null || lessValuable(entry, manual)) {
                manual = entry;
            }
        }
        return auto != null ? auto : manual;
    }

    private static boolean lessValuable(Entry a, Entry b) {
        final long[] pa = plays.get(a.id);
        final long[] pb = plays.get(b.id);
        final long countA = pa == null ? 0 : pa[0];
        final long countB = pb == null ? 0 : pb[0];
        if (countA != countB) return countA < countB;
        final long lastA = Math.max(a.savedAt, pa == null ? 0 : pa[1]);
        final long lastB = Math.max(b.savedAt, pb == null ? 0 : pb[1]);
        return lastA < lastB;
    }

    /** Con LOCK. No escribe la lista (write). */
    private static void removeEntry(Entry entry) {
        index().remove(entry.id);
        if (!new File(dir(), entry.file).delete()) Log.w(TAG, "No se pudo borrar " + entry.file);
        notifyTrack(entry.id, "removed");
    }

    /** Pasa el archivo descargado a su nombre final y lo anota. Con LOCK. No escribe la lista (write). */
    private static boolean commit(JSONObject track, File part, boolean manual) {
        final String id = track.optString("id");
        final File done = new File(dir(), id + ".audio");
        if (!part.renameTo(done)) return false;
        index().remove(id);
        index().put(id, new Entry(id,
                StreamResolver.safe(track.optString("title"), id),
                StreamResolver.safe(track.optString("artist"), "SoundBlue"),
                track.optString("album"),
                track.optString("artwork"),
                done.getName(), done.length(), System.currentTimeMillis(), manual));
        Log.i(TAG, "Guardada" + (manual ? "" : " (respaldo)") + ": " + id + " (" + done.length() / 1024 + " KB)");
        return true;
    }

    /**
     * Extrae la URL con NewPipe y baja el audio por partes a files/offline/<id>.part. Null si no se pudo; entonces
     * `networkFailure` dice si fue por la red (la canción queda pendiente) o por la canción (falló de verdad).
     */
    @Nullable
    private static File fetch(JSONObject track) {
        final String id = track.optString("id");
        final int started = generation;
        networkFailure = false;
        final StreamResolver.Stream stream;
        try {
            stream = StreamResolver.resolve(id);
        } catch (IOException error) {
            networkFailure = isNetworkCause(error) || !canDownload();
            Log.w(TAG, "No se pudo extraer " + id + " para descargarla", error);
            return null;
        }
        if (stream.duration > MAX_SONG_S) return null;
        final long declared = contentLength(stream.audioUrl);
        if (declared > MAX_BYTES) return null;
        final File part;
        synchronized (LOCK) {
            part = new File(dir(), id + ".part");
        }
        final DefaultHttpDataSource source = new DefaultHttpDataSource.Factory()
                .setConnectTimeoutMs(20_000)
                .setReadTimeoutMs(30_000)
                .setAllowCrossProtocolRedirects(true)
                .createDataSource();
        final byte[] buffer = new byte[64 * 1024];
        long position = 0;
        try (FileOutputStream out = new FileOutputStream(part)) {
            while (declared <= 0 || position < declared) {
                if (started != generation || (cancelCurrent && id.equals(current))) throw new IOException("Cancelada");
                final long length = declared > 0 ? Math.min(CHUNK, declared - position) : CHUNK;
                long got = 0;
                try {
                    source.open(new DataSpec.Builder().setUri(Uri.parse(stream.audioUrl)).setPosition(position).setLength(length).build());
                    int read;
                    while ((read = source.read(buffer, 0, buffer.length)) != C.RESULT_END_OF_INPUT) {
                        out.write(buffer, 0, read);
                        got += read;
                        if (position + got > MAX_BYTES) throw new IOException("Demasiado grande para descargarla");
                    }
                } catch (HttpDataSource.InvalidResponseCodeException error) {
                    if (error.responseCode != 416 || position == 0) throw error; // 416: ya no quedaba nada por bajar
                } finally {
                    try {
                        source.close();
                    } catch (IOException ignored) {
                        // ya se leyó lo que había
                    }
                }
                position += got;
                if (got < length) break; // la última parte
            }
        } catch (IOException error) {
            if (!part.delete()) Log.w(TAG, "No se pudo borrar " + part);
            // Cancelada o limpiada no cuenta como falta de red.
            networkFailure = started == generation && !(cancelCurrent && id.equals(current)) && (isNetworkCause(error) || !canDownload());
            Log.w(TAG, "No se pudo descargar " + id, error);
            return null;
        }
        if (started != generation || position <= 0 || (declared > 0 && position < declared)) {
            if (part.exists() && !part.delete()) Log.w(TAG, "No se pudo borrar " + part);
            return null;
        }
        return part;
    }

    // ---- Internos ----

    /** ¿Falló por la red (sin conexión, se cortó, no respondió) y no por la canción? */
    private static boolean isNetworkCause(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof java.net.UnknownHostException || cause instanceof java.net.ConnectException
                    || cause instanceof java.net.NoRouteToHostException || cause instanceof java.net.SocketTimeoutException
                    || cause instanceof java.net.SocketException) {
                return true;
            }
        }
        return false;
    }

    /** Escribe la lista. Con LOCK. */
    private static void write() {
        final JSONArray json = new JSONArray();
        try {
            for (final Entry entry : index().values()) json.put(entry.toJson());
        } catch (JSONException error) {
            Log.w(TAG, "No se pudo guardar la lista de descargas", error);
            return;
        }
        prefs().edit().putString(KEY, json.toString()).apply();
    }

    private static void notifyTrack(String id, String state) {
        final Listener target = listener;
        if (target != null) target.onTrack(id, state);
    }

    private static void notifyEvicted(int count) {
        final Listener target = listener;
        if (count > 0 && target != null) target.onEvicted(count);
    }

    /** Las URL de audio de YouTube traen `clen` (bytes): así se sabe cuándo terminar y si es demasiado grande. */
    private static long contentLength(String url) {
        try {
            final String clen = Uri.parse(url).getQueryParameter("clen");
            return clen == null ? -1 : Long.parseLong(clen);
        } catch (RuntimeException ignored) {
            return -1;
        }
    }

    private static SharedPreferences prefs() {
        return app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Con internet de verdad: VALIDATED (un Wi-Fi sin salida, como un portal cautivo, no cuenta). */
    private static boolean isOnline() {
        final ConnectivityManager connectivity = app.getSystemService(ConnectivityManager.class);
        final Network network = connectivity == null ? null : connectivity.getActiveNetwork();
        final NetworkCapabilities capabilities = network == null ? null : connectivity.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private static boolean isMetered() {
        final ConnectivityManager connectivity = app.getSystemService(ConnectivityManager.class);
        return connectivity == null || connectivity.isActiveNetworkMetered();
    }
}
