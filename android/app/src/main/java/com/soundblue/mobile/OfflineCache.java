package com.soundblue.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.SystemClock;
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
import java.io.InterruptedIOException;
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
import java.util.function.BooleanSupplier;

/**
 * Descargas para escuchar sin conexión: el AUDIO guardado en el teléfono (files/offline) y su lista (SharedPreferences).
 * Solo lo que descargas tú («Descargar» en una lista o en el menú ⋮ de una canción); quedan hasta que las quites. (El
 * respaldo automático de «Selecciones rápidas» de la 1.9 y la 2.0.0 ya no existe: lo que quede de él se borra al cargar.)
 * Cola real: de a UNA canción, en el orden en que las pediste (una lista entera antes que la siguiente). La que se baja
 * avisa «downloading»; las demás, «queued» (esperan su turno).
 * Una descargada suena desde el teléfono (PlaybackService.resolve), con o sin internet. Sin internet, PlaybackService salta
 * las que no están descargadas y, si ya no queda ninguna por delante, pone tus descargas en bucle (modo offline).
 * Límite global (Ajustes, guardado también en la app): de 50 a 10 000 canciones o «Sin límite» (0), 200 por defecto. El
 * otro límite es el espacio del teléfono: siempre quedan libres al menos 300 MB. Si lo que pides no cabe (por el límite o
 * por el espacio), se borran las que menos escuchas (y las más viejas), según el historial de la app; nunca las de la
 * misma descarga. Si aun así no cabe, lo que falta no se descarga (onFull, diciendo si fue por el espacio).
 * «Descargar solo con Wi-Fi» (encendido por defecto): solo se descarga en una red sin límite de datos; si toca esperar,
 * lo pendiente sigue solo al llegar la red (resume, desde OfflineCachePlugin).
 * La música va primero (2.1.4): las descargas corren en un hilo de prioridad baja (también su extracción con NewPipe, que
 * no ocupa los hilos del reproductor), esperan mientras el reproductor carga la canción o tiene poco búfer
 * (yieldToPlayback, avisado por PlaybackService con setPlayback), van como mucho a 512 KB/s mientras suena música por
 * internet y descansan medio segundo entre canción y canción.
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
    static final int MAX_LIMIT = 10_000;
    static final int UNLIMITED = 0; // «Sin límite»: solo cuenta el espacio del teléfono
    private static final long RESERVE_BYTES = 300L * 1024 * 1024; // lo que siempre queda libre en el teléfono
    private static final long SONG_ESTIMATE = 10L * 1024 * 1024; // lo que se le pide de espacio a una canción antes de bajarla
    static final int DEFAULT_LIMIT = 200;
    private static final long MAX_BYTES = 25L * 1024 * 1024; // por canción: nada de mezclas de una hora
    private static final long MAX_SONG_S = 10 * 60;
    private static final int CHUNK = 1024 * 1024; // de a 1 MB, como pide ExoPlayer (así YouTube no frena la descarga)
    private static final int MAX_RETRIES = 3; // cortes de red seguidos en la misma canción antes de darla por fallida
    private static final long RETRY_MS = 30_000; // tras un corte con la red aparentemente bien, se reintenta a los 30 s
    // Prioridad del reproductor (2.1.4):
    private static final long SONG_REST_MS = 500; // respiro entre canción y canción (CPU y disco libres para la música)
    private static final long STREAMING_LIMIT = 512 * 1024; // bytes/s mientras suena música por internet
    private static final long MAX_YIELD_MS = 15_000; // lo más que espera seguido a que el reproductor cargue
    private static final Object LOCK = new Object();
    private static final Object GATE = new Object(); // donde esperan las descargas mientras el reproductor carga
    private static final ThreadLocal<Boolean> IN_DOWNLOADS = new ThreadLocal<>(); // true en el hilo de descargas
    /** Un solo hilo, de prioridad baja: el reproductor y la interfaz se quedan con la CPU cuando la necesitan. */
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor((task) -> new Thread(() -> {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
        IN_DOWNLOADS.set(Boolean.TRUE);
        task.run();
    }, "SoundBlue-descargas"));
    // Lo que avisa PlaybackService (setPlayback):
    private static volatile boolean playbackStreaming; // suena música por internet: las descargas van más despacio
    private static volatile boolean playbackHungry; // el reproductor necesita la red YA: las descargas esperan

    /** Lo que la app quiere saber (OfflineCachePlugin). Se llama desde el hilo de descargas o el de la app. */
    interface Listener {
        /** state: "queued", "downloading", "done", "failed" o "removed" (quitada, cancelada o borrada para hacer espacio). */
        void onTrack(String videoId, String state);

        /** Se borraron `count` para hacer espacio (al descargar algo nuevo o al bajar el límite). */
        void onEvicted(int count);

        /**
         * No cupieron `skipped` de las que pediste: el límite (o, si `storage`, el espacio del teléfono) está lleno de las
         * que estás descargando.
         */
        void onFull(int skipped, boolean storage);
    }

    /** Una canción descargada. `manual`: siempre true desde la 2.0.1 (false era el respaldo automático, que se borra). */
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

    /** La siguiente de la cola. */
    private static final class Job {
        final JSONObject track;

        Job(JSONObject track) {
            this.track = track;
        }

        String id() {
            return track.optString("id");
        }
    }

    // Todo lo de abajo se toca con LOCK.
    private static Context app;
    private static LinkedHashMap<String, Entry> index; // las guardadas, de la más vieja a la más nueva
    private static final LinkedHashMap<String, JSONObject> manualQueue = new LinkedHashMap<>(); // las que pediste, en orden
    private static final Map<String, long[]> plays = new HashMap<>(); // id → {veces escuchada, última vez}: de la app
    private static final Set<String> batch = new HashSet<>(); // las de tus descargas en curso: no se borran para hacer espacio
    private static boolean scheduled; // hay una tanda de descargas en marcha (o encargada)
    private static boolean waiting; // hay pendientes esperando red (Wi-Fi o internet)
    private static volatile String current; // la que se está descargando (las demás de la cola esperan)
    private static volatile boolean cancelCurrent;
    private static boolean networkFailure; // la última fetch falló por la red (solo el hilo de descargas)
    private static boolean fetched; // la última de la cola se bajó de internet (solo el hilo de descargas)
    private static int preFreed; // las que se borraron por espacio antes de la descarga en curso (solo el hilo de descargas)
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

    // ---- La música va primero ----

    /**
     * Lo avisa PlaybackService (hilo principal, al cambiar algo y cada segundo mientras suena). `streaming`: suena música
     * por internet (las descargas van como mucho a STREAMING_LIMIT). `hungry`: el reproductor está cargando la canción (o
     * la siguiente) o le quedan pocos segundos guardados: las descargas sueltan la red y esperan.
     */
    static void setPlayback(boolean streaming, boolean hungry) {
        playbackStreaming = streaming;
        if (playbackHungry == hungry) return;
        playbackHungry = hungry;
        if (!hungry) wakeDownloads();
    }

    /**
     * En el hilo de descargas (fetch y las consultas de NewPipe de una descarga, NewPipeDownloader): mientras el reproductor
     * necesite la red, espera. Como mucho MAX_YIELD_MS seguidos (si el reproductor se queda cargando, la descarga avanza
     * un poco y vuelve a esperar) y deja de esperar si `stop` (la cancelaste). En cualquier otro hilo no hace nada.
     */
    static void yieldToPlayback(@Nullable BooleanSupplier stop) {
        if (!playbackHungry || IN_DOWNLOADS.get() == null) return;
        final long until = SystemClock.elapsedRealtime() + MAX_YIELD_MS;
        synchronized (GATE) {
            while (playbackHungry && (stop == null || !stop.getAsBoolean())) {
                final long left = until - SystemClock.elapsedRealtime();
                if (left <= 0) return;
                try {
                    GATE.wait(left);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    /** La descarga que espera al reproductor vuelve a mirar (ya no hace falta esperar, o la cancelaste). */
    private static void wakeDownloads() {
        synchronized (GATE) {
            GATE.notifyAll();
        }
    }

    /** Entre canción y canción: un respiro para la CPU y el disco (el reproductor y la interfaz van primero). */
    private static void rest() {
        try {
            Thread.sleep(SONG_REST_MS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    /** Mientras suena música por internet, la descarga va como mucho a STREAMING_LIMIT: el resto de la red es del reproductor. */
    private static final class Throttle {
        private long start; // desde cuándo se mide (0: ahora no hay límite)
        private long bytes; // lo bajado desde `start`

        void onRead(int read) throws InterruptedIOException {
            if (!playbackStreaming) {
                start = 0;
                return;
            }
            final long now = SystemClock.elapsedRealtime();
            if (start == 0) {
                start = now;
                bytes = 0;
            }
            bytes += read;
            final long due = start + bytes * 1000 / STREAMING_LIMIT;
            if (due <= now) return;
            try {
                Thread.sleep(due - now);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new InterruptedIOException("Se detuvo la descarga");
            }
        }
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
        int dropped = 0;
        try {
            final JSONArray saved = new JSONArray(prefs().getString(KEY, "[]"));
            for (int i = 0; i < saved.length(); i++) {
                final JSONObject json = saved.optJSONObject(i);
                if (json == null) continue;
                final Entry entry = Entry.fromJson(json);
                if (!entry.manual) {
                    dropped++; // del respaldo automático de antes: se borra
                    continue;
                }
                if (StreamResolver.VIDEO_ID.matcher(entry.id).matches() && new File(dir, entry.file).isFile()) index.put(entry.id, entry);
            }
        } catch (JSONException error) {
            Log.w(TAG, "La lista de descargas está dañada", error);
        }
        if (dropped > 0) {
            Log.i(TAG, "Se borraron " + dropped + " canciones del respaldo automático de antes");
            write();
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

    /** Cuántas hay, cuánto ocupan, el límite, la cola, la red y si está descargando (para Ajustes). */
    static JSObject status(Context context) {
        init(context);
        final JSObject status = new JSObject();
        synchronized (LOCK) {
            long bytes = 0;
            long oldest = 0;
            long newest = 0;
            for (final Entry entry : index().values()) {
                bytes += entry.size;
                if (oldest == 0 || entry.savedAt < oldest) oldest = entry.savedAt;
                newest = Math.max(newest, entry.savedAt);
            }
            status.put("count", index().size());
            status.put("bytes", bytes);
            status.put("oldest", oldest);
            status.put("newest", newest);
            // En cola: las que esperan su turno (sin contar la que se está descargando).
            status.put("queued", manualQueue.size() - (current != null && manualQueue.containsKey(current) ? 1 : 0));
            status.put("waiting", waiting);
            status.put("downloading", current != null);
        }
        final boolean online = isOnline();
        status.put("target", savedLimit()); // 0: sin límite
        synchronized (LOCK) {
            status.put("free", dir().getUsableSpace()); // espacio libre en el teléfono (bytes)
        }
        status.put("online", online);
        status.put("wifi", online && !isMetered());
        status.put("wifiOnly", wifiOnly());
        return status;
    }

    /** Qué hay: las descargadas, la que se está descargando (`current`) y las que esperan su turno (`queued`). */
    static JSObject list(Context context) {
        init(context);
        final JSArray downloaded = new JSArray();
        final JSArray queued = new JSArray();
        final String now;
        synchronized (LOCK) {
            now = current;
            for (final Entry entry : index().values()) downloaded.put(entry.id);
            for (final String id : manualQueue.keySet()) if (!id.equals(now)) queued.put(id);
        }
        final JSObject result = new JSObject();
        result.put("downloaded", downloaded);
        result.put("queued", queued);
        if (now != null) result.put("current", now);
        return result;
    }

    // ---- Ajustes ----

    /** El límite elegido: 50 a 10 000, o 0 («Sin límite»). Las de la 1.9.x (15, 30) suben a 50. */
    static int savedLimit() {
        final int saved = prefs().getInt(LIMIT_KEY, DEFAULT_LIMIT);
        return saved <= UNLIMITED ? UNLIMITED : Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, saved));
    }

    /** Cuántas caben como mucho (sin límite: todas las que permita el espacio del teléfono). */
    static int limit() {
        final int saved = savedLimit();
        return saved == UNLIMITED ? Integer.MAX_VALUE : saved;
    }

    /** ¿Queda espacio en el teléfono para una canción más (dejando siempre 300 MB libres)? Con LOCK. */
    private static boolean diskHasRoom() {
        return dir().getUsableSpace() >= RESERVE_BYTES + SONG_ESTIMATE;
    }

    /** Cambia el límite (0: sin límite). Si hay más de las que caben, se borran al momento (las que menos escuchas). */
    static void setLimit(Context context, int value) {
        init(context);
        final int saved = value <= UNLIMITED ? UNLIMITED : Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, value));
        prefs().edit().putInt(LIMIT_KEY, saved).apply();
        final int limit = limit();
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

    /**
     * «Descargar» (una lista o una canción): van al final de la cola, en orden (esperan a que termine lo que pediste antes).
     * Las que ya están descargadas no se repiten.
     */
    static void download(Context context, List<JSONObject> tracks) {
        download(context, tracks, false);
    }

    /**
     * Como download; con `priority` (el botón de «Sonando ahora») van al PRINCIPIO de la cola: se bajan en cuanto termine
     * la que se está descargando (también si ya estaban esperando más atrás).
     */
    static void download(Context context, List<JSONObject> tracks, boolean priority) {
        init(context);
        final List<String> queued = new ArrayList<>();
        final List<String> pinned = new ArrayList<>();
        synchronized (LOCK) {
            final LinkedHashMap<String, JSONObject> first = new LinkedHashMap<>();
            for (final JSONObject track : tracks) {
                final String id = track.optString("id");
                if (!StreamResolver.VIDEO_ID.matcher(id).matches()) continue;
                batch.add(id);
                if (index().containsKey(id)) {
                    pinned.add(id);
                } else if (id.equals(current) && !cancelCurrent) {
                    continue; // ya se está descargando
                } else if (priority) {
                    if (manualQueue.remove(id) == null) queued.add(id);
                    first.put(id, track);
                } else if (!manualQueue.containsKey(id)) {
                    // (La que se está cancelando ahora mismo vuelve a la cola: la pediste otra vez.)
                    manualQueue.put(id, track);
                    queued.add(id);
                }
            }
            if (!first.isEmpty()) {
                first.putAll(manualQueue);
                manualQueue.clear();
                manualQueue.putAll(first);
            }
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
        wakeDownloads(); // si esperaba al reproductor, se entera ya
        for (final String id : removed) notifyTrack(id, "removed");
    }

    /** «Quitar descarga»: borra las canciones y cancela las que estaban en la cola. */
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
            waiting = false;
            index().clear();
            final File[] files = dir().listFiles();
            if (files != null) for (final File file : files) if (!file.delete()) Log.w(TAG, "No se pudo borrar " + file);
            prefs().edit().remove(KEY).apply();
        }
        wakeDownloads();
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
        boolean storage = false; // lo que no cupo fue por el espacio del teléfono
        try {
            while (true) {
                final Job job;
                synchronized (LOCK) {
                    final boolean work = !manualQueue.isEmpty();
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
                fetched = false;
                final int[] result = downloadManual(job);
                if (result == null) { // se cayó la red: queda en la cola y sigue al volver (resume)
                    pause();
                    return;
                }
                evicted += result[0];
                skipped += result[1];
                storage |= result[2] == 1;
                // Bajó una de internet y quedan más: medio segundo de respiro antes de la siguiente.
                final boolean more;
                synchronized (LOCK) {
                    more = !manualQueue.isEmpty();
                }
                if (fetched && more) rest();
            }
        } finally {
            notifyEvicted(evicted);
            final Listener target = listener;
            if (skipped > 0 && target != null) target.onFull(skipped, storage);
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

    /** La siguiente de la cola (la más antigua que pediste). Con LOCK. */
    @Nullable
    private static Job nextJob() {
        final Iterator<JSONObject> queue = manualQueue.values().iterator();
        return queue.hasNext() ? new Job(queue.next()) : null;
    }

    /**
     * Una de las que pediste. Devuelve {borradas para hacer espacio, las que no cupieron, 1 si fue por el espacio del
     * teléfono}, o null si se cayó la red (queda en la cola para cuando vuelva).
     */
    @Nullable
    private static int[] downloadManual(Job job) {
        final String id = job.id();
        synchronized (LOCK) {
            if (!manualQueue.containsKey(id)) return new int[] {0, 0, 0}; // la cancelaste justo ahora
            // Ya está descargada (la pediste en dos listas): no se baja otra vez.
            if (index().containsKey(id)) {
                manualQueue.remove(id);
                notifyTrack(id, "done");
                return new int[] {0, 0, 0};
            }
            // Poco espacio en el teléfono: se borran antes las que menos escuchas (nunca las de esta descarga).
            int freed = 0;
            while (!diskHasRoom()) {
                final Entry victim = pickVictim();
                if (victim == null) break;
                removeEntry(victim);
                freed++;
            }
            if (freed > 0) write();
            // ¿Cabe? Si está lleno (límite o espacio) y no hay nada que se pueda borrar, lo que falta no se descarga.
            final boolean noDisk = !diskHasRoom();
            if (noDisk || (index().size() >= limit() && pickVictim() == null)) {
                final List<String> skipped = new ArrayList<>(manualQueue.keySet());
                manualQueue.clear();
                for (final String skip : skipped) notifyTrack(skip, "removed");
                return new int[] {freed, skipped.size(), noDisk ? 1 : 0};
            }
            current = id;
            cancelCurrent = false;
            preFreed = freed;
        }
        notifyTrack(id, "downloading");
        fetched = true;
        final File file = fetch(job.track);
        int evicted = preFreed;
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
        return new int[] {evicted, 0, 0};
    }

    /**
     * Cuál se borra para hacer espacio: la que menos escuchas (y, a igual, la que hace más que no suena o se descargó hace
     * más). Nunca las de tus descargas en curso. Con LOCK. Null si no hay ninguna que se pueda borrar.
     */
    @Nullable
    private static Entry pickVictim() {
        Entry victim = null;
        for (final Entry entry : index().values()) {
            if (batch.contains(entry.id)) continue;
            if (victim == null || lessValuable(entry, victim)) victim = entry;
        }
        return victim;
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
        Log.i(TAG, "Descargada: " + id + " (" + done.length() / 1024 + " KB)");
        return true;
    }

    /**
     * Extrae la URL con NewPipe y baja el audio por partes a files/offline/<id>.part. Null si no se pudo; entonces
     * `networkFailure` dice si fue por la red (la canción queda pendiente) o por la canción (falló de verdad).
     * La música va primero: antes de extraer y de cada parte espera si el reproductor está cargando (yieldToPlayback); si
     * empieza a cargar a mitad de una parte, la conexión se suelta y esa parte sigue después desde donde iba. Mientras suena
     * música por internet, baja como mucho a STREAMING_LIMIT (Throttle).
     */
    @Nullable
    private static File fetch(JSONObject track) {
        final String id = track.optString("id");
        final int started = generation;
        networkFailure = false;
        final BooleanSupplier stop = () -> started != generation || (cancelCurrent && id.equals(current));
        yieldToPlayback(stop);
        if (stop.getAsBoolean()) return null; // la cancelaste mientras esperaba
        final StreamResolver.Stream stream;
        try {
            stream = StreamResolver.resolveForDownload(id); // aquí mismo, en este hilo de prioridad baja
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
        final Throttle throttle = new Throttle();
        long position = 0;
        try (FileOutputStream out = new FileOutputStream(part)) {
            while (declared <= 0 || position < declared) {
                yieldToPlayback(stop); // el reproductor está cargando: espera antes de pedir la siguiente parte
                if (stop.getAsBoolean()) throw new IOException("Cancelada");
                final long length = declared > 0 ? Math.min(CHUNK, declared - position) : CHUNK;
                long got = 0;
                boolean yielded = false; // se soltó la conexión para darle la red al reproductor
                try {
                    source.open(new DataSpec.Builder().setUri(Uri.parse(stream.audioUrl)).setPosition(position).setLength(length).build());
                    int read;
                    while ((read = source.read(buffer, 0, buffer.length)) != C.RESULT_END_OF_INPUT) {
                        out.write(buffer, 0, read);
                        got += read;
                        if (position + got > MAX_BYTES) throw new IOException("Demasiado grande para descargarla");
                        if (playbackHungry) { // el reproductor empezó a cargar: la parte sigue después, desde aquí
                            yielded = true;
                            break;
                        }
                        throttle.onRead(read);
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
                if (!yielded && got < length) break; // la última parte
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
