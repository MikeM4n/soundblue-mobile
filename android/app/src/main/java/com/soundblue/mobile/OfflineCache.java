package com.soundblue.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.util.Log;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Caché offline: el audio de canciones de «Selecciones rápidas» guardado en el teléfono (archivos en files/offline y sus
 * datos en SharedPreferences). Sin internet, PlaybackService las pone a sonar una tras otra (modo offline) hasta que
 * vuelve la conexión. Se guarda el AUDIO: la URL que da NewPipe no sirve sin internet (y YouTube la vence en unas horas).
 * Reglas: hasta 15 canciones (unos 50 MB). Ninguna se borra sola antes de 24 h; solo «Limpiar caché offline» en Ajustes.
 * Si está llena, con Wi-Fi las de más de 24 h se cambian por nuevas de «Selecciones rápidas»; con datos móviles solo se
 * completa lo que falte (así no gasta datos cada día).
 */
@OptIn(markerClass = UnstableApi.class)
final class OfflineCache {
    private static final String TAG = "OfflineCache";
    private static final String PREFS = "soundblue_offline";
    private static final String KEY = "entries";
    private static final String DIR = "offline";
    static final int TARGET = 15;
    static final long KEEP_MS = 24 * 60 * 60 * 1000L;
    private static final long MAX_BYTES = 25L * 1024 * 1024; // por canción: nada de mezclas de una hora
    private static final long MAX_SONG_S = 10 * 60;
    private static final int CHUNK = 1024 * 1024; // de a 1 MB, como pide ExoPlayer (así YouTube no frena la descarga)
    private static final Object LOCK = new Object();
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();
    private static volatile boolean downloading;
    private static volatile int generation; // sube al limpiar: la descarga en curso se descarta

    /** Una canción guardada. */
    static final class Entry {
        final String id;
        final String title;
        final String artist;
        final String album;
        final String artwork;
        final String file;
        final long size;
        final long savedAt;

        Entry(String id, String title, String artist, String album, String artwork, String file, long size, long savedAt) {
            this.id = id;
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.artwork = artwork;
            this.file = file;
            this.size = size;
            this.savedAt = savedAt;
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject().put("id", id).put("title", title).put("artist", artist).put("album", album)
                    .put("artwork", artwork).put("file", file).put("size", size).put("savedAt", savedAt);
        }

        static Entry fromJson(JSONObject json) {
            return new Entry(json.optString("id"), json.optString("title"), json.optString("artist"), json.optString("album"),
                    json.optString("artwork"), json.optString("file"), json.optLong("size"), json.optLong("savedAt"));
        }
    }

    private OfflineCache() {}

    private static File dir(Context context) {
        final File dir = new File(context.getFilesDir(), DIR);
        if (!dir.exists() && !dir.mkdirs()) Log.w(TAG, "No se pudo crear " + dir);
        return dir;
    }

    /** Las guardadas (solo las que tienen su archivo), de la más vieja a la más nueva. */
    static List<Entry> entries(Context context) {
        synchronized (LOCK) {
            final List<Entry> entries = new ArrayList<>();
            final File dir = dir(context);
            try {
                final JSONArray saved = new JSONArray(prefs(context).getString(KEY, "[]"));
                for (int i = 0; i < saved.length(); i++) {
                    final JSONObject json = saved.optJSONObject(i);
                    if (json == null) continue;
                    final Entry entry = Entry.fromJson(json);
                    if (StreamResolver.VIDEO_ID.matcher(entry.id).matches() && new File(dir, entry.file).isFile()) entries.add(entry);
                }
            } catch (JSONException error) {
                Log.w(TAG, "La lista de la caché offline está dañada", error);
            }
            return entries;
        }
    }

    /** Para PlaybackService: las guardadas, listas para ExoPlayer (archivos del teléfono, sin NewPipe). */
    static List<MediaItem> mediaItems(Context context) {
        final List<MediaItem> items = new ArrayList<>();
        final File dir = dir(context);
        for (final Entry entry : entries(context)) {
            final MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                    .setTitle(StreamResolver.safe(entry.title, entry.id))
                    .setArtist(StreamResolver.safe(entry.artist, "SoundBlue"))
                    .setAlbumTitle("Modo offline");
            if (entry.artwork.startsWith("https:")) metadata.setArtworkUri(Uri.parse(entry.artwork));
            items.add(new MediaItem.Builder()
                    .setMediaId(entry.id)
                    .setUri(Uri.fromFile(new File(dir, entry.file)))
                    .setMediaMetadata(metadata.build())
                    .build());
        }
        return items;
    }

    /** Cuántas hay, cuánto ocupan y si está descargando (para Ajustes). */
    static JSObject status(Context context) {
        final List<Entry> entries = entries(context);
        long bytes = 0;
        long oldest = 0;
        long newest = 0;
        for (final Entry entry : entries) {
            bytes += entry.size;
            if (oldest == 0 || entry.savedAt < oldest) oldest = entry.savedAt;
            newest = Math.max(newest, entry.savedAt);
        }
        final JSObject status = new JSObject();
        status.put("count", entries.size());
        status.put("bytes", bytes);
        status.put("target", TARGET);
        status.put("downloading", downloading);
        status.put("oldest", oldest);
        status.put("newest", newest);
        return status;
    }

    /** «Selecciones rápidas» que llegaron a la app: en segundo plano se guardan las que hagan falta (ver las reglas arriba). */
    static void offer(Context context, List<JSONObject> tracks) {
        final Context app = context.getApplicationContext();
        WORKER.execute(() -> fill(app, tracks));
    }

    /** «Limpiar caché offline»: borra todo (también lo que se estaba descargando). */
    static void clear(Context context) {
        synchronized (LOCK) {
            generation++;
            final File[] files = dir(context).listFiles();
            if (files != null) for (final File file : files) if (!file.delete()) Log.w(TAG, "No se pudo borrar " + file);
            prefs(context).edit().remove(KEY).apply();
        }
    }

    /** Una que no se pudo reproducir (archivo dañado): sale de la caché. */
    static void remove(Context context, String videoId) {
        synchronized (LOCK) {
            final List<Entry> kept = new ArrayList<>();
            for (final Entry entry : entries(context)) {
                if (entry.id.equals(videoId)) {
                    if (!new File(dir(context), entry.file).delete()) Log.w(TAG, "No se pudo borrar " + entry.file);
                } else {
                    kept.add(entry);
                }
            }
            write(context, kept);
        }
    }

    private static void fill(Context context, List<JSONObject> offered) {
        downloading = true;
        try {
            for (final JSONObject track : offered) {
                final String id = track.optString("id");
                if (!StreamResolver.VIDEO_ID.matcher(id).matches() || has(context, id)) continue;
                final List<Entry> entries = entries(context);
                final boolean room = entries.size() < TARGET;
                final Entry stale = oldestStale(entries);
                // Llena: solo con Wi-Fi se cambia una de más de 24 h. Con datos móviles se queda como está.
                if (!room && (stale == null || isMetered(context))) return;
                if (!isOnline(context)) return;
                if (!download(context, track)) continue;
                if (!room) remove(context, stale.id);
            }
        } finally {
            downloading = false;
        }
    }

    private static boolean has(Context context, String videoId) {
        for (final Entry entry : entries(context)) if (entry.id.equals(videoId)) return true;
        return false;
    }

    private static Entry oldestStale(List<Entry> entries) {
        final long limit = System.currentTimeMillis() - KEEP_MS;
        Entry oldest = null;
        for (final Entry entry : entries) {
            if (entry.savedAt < limit && (oldest == null || entry.savedAt < oldest.savedAt)) oldest = entry;
        }
        return oldest;
    }

    /** Extrae la URL con NewPipe y baja el audio por partes a files/offline/<id>.audio. */
    private static boolean download(Context context, JSONObject track) {
        final String id = track.optString("id");
        final int started = generation;
        final StreamResolver.Stream stream;
        try {
            stream = StreamResolver.resolve(id);
        } catch (IOException error) {
            Log.w(TAG, "No se pudo extraer " + id + " para la caché offline", error);
            return false;
        }
        if (stream.duration > MAX_SONG_S) return false;
        final long declared = contentLength(stream.audioUrl);
        if (declared > MAX_BYTES) return false;
        final File dir = dir(context);
        final File part = new File(dir, id + ".part");
        final File done = new File(dir, id + ".audio");
        final DefaultHttpDataSource source = new DefaultHttpDataSource.Factory()
                .setConnectTimeoutMs(20_000)
                .setReadTimeoutMs(30_000)
                .setAllowCrossProtocolRedirects(true)
                .createDataSource();
        final byte[] buffer = new byte[64 * 1024];
        long position = 0;
        try (FileOutputStream out = new FileOutputStream(part)) {
            while (declared <= 0 || position < declared) {
                if (started != generation) throw new IOException("Se limpió la caché");
                final long length = declared > 0 ? Math.min(CHUNK, declared - position) : CHUNK;
                long got = 0;
                try {
                    source.open(new DataSpec.Builder().setUri(Uri.parse(stream.audioUrl)).setPosition(position).setLength(length).build());
                    int read;
                    while ((read = source.read(buffer, 0, buffer.length)) != C.RESULT_END_OF_INPUT) {
                        out.write(buffer, 0, read);
                        got += read;
                        if (position + got > MAX_BYTES) throw new IOException("Demasiado grande para la caché");
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
            Log.w(TAG, "No se pudo guardar " + id + " en la caché offline", error);
            return false;
        }
        synchronized (LOCK) {
            if (started != generation || position <= 0 || (declared > 0 && position < declared) || !part.renameTo(done)) {
                if (part.exists() && !part.delete()) Log.w(TAG, "No se pudo borrar " + part);
                return false;
            }
            final List<Entry> entries = entries(context);
            entries.add(new Entry(id,
                    StreamResolver.safe(track.optString("title"), stream.title),
                    StreamResolver.safe(track.optString("artist"), stream.artist),
                    track.optString("album"),
                    StreamResolver.safe(track.optString("artwork"), stream.artwork),
                    done.getName(), position, System.currentTimeMillis()));
            write(context, entries);
        }
        Log.i(TAG, "Guardada para el modo offline: " + id + " (" + position / 1024 + " KB)");
        return true;
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

    private static void write(Context context, List<Entry> entries) {
        final JSONArray json = new JSONArray();
        try {
            for (final Entry entry : entries) json.put(entry.toJson());
        } catch (JSONException error) {
            Log.w(TAG, "No se pudo guardar la lista de la caché offline", error);
            return;
        }
        prefs(context).edit().putString(KEY, json.toString()).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean isOnline(Context context) {
        final ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        final Network network = connectivity == null ? null : connectivity.getActiveNetwork();
        final NetworkCapabilities capabilities = network == null ? null : connectivity.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private static boolean isMetered(Context context) {
        final ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        return connectivity == null || connectivity.isActiveNetworkMetered();
    }
}
