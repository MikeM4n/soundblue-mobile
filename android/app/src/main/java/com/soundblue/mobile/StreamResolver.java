package com.soundblue.mobile;

import android.net.Uri;

import org.schabi.newpipe.extractor.Image;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.exceptions.ExtractionException;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.StreamInfo;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Extrae con NewPipe la URL directa de audio de un video de YouTube y la guarda hasta que YouTube la vence. La usan el
 * servicio de reproducción (al cargar una canción y para pre-cargar la siguiente) y el plugin NewPipe.
 */
final class StreamResolver {
    static final Pattern VIDEO_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");
    private static final long DEFAULT_TTL_MS = 5 * 60 * 60 * 1000L; // si la URL no dice cuándo vence
    private static final long EXPIRY_MARGIN_MS = 10 * 60 * 1000L;
    private static final ExecutorService WORKER = Executors.newFixedThreadPool(2);
    private static final ConcurrentHashMap<String, CompletableFuture<Stream>> STREAMS = new ConcurrentHashMap<>();

    /** Audio listo para reproducir, con los datos del video. */
    static final class Stream {
        final String audioUrl;
        final String title;
        final String artist;
        final String artwork;
        final String mimeType;
        final long duration;
        final long expiresAt;

        Stream(String audioUrl, String title, String artist, String artwork, String mimeType, long duration) {
            this.audioUrl = audioUrl;
            this.title = title;
            this.artist = artist;
            this.artwork = artwork;
            this.mimeType = mimeType;
            this.duration = duration;
            this.expiresAt = expiry(audioUrl);
        }
    }

    /** YouTube no deja reproducir este video (no es un fallo de conexión): no vale la pena reintentarlo. */
    static final class UnavailableException extends IOException {
        UnavailableException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private StreamResolver() {}

    static synchronized void init() {
        if (NewPipe.getDownloader() == null) NewPipe.init(new NewPipeDownloader());
    }

    /** Espera la URL de audio. Bloquea: nunca llamarla desde el hilo principal. */
    static Stream resolve(String videoId) throws IOException {
        if (!VIDEO_ID.matcher(videoId).matches()) {
            throw new UnavailableException("El identificador del video de YouTube no es válido.", null);
        }
        try {
            return request(videoId).get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new InterruptedIOException("Se canceló la extracción del audio.");
        } catch (ExecutionException error) {
            final Throwable cause = error.getCause();
            if (cause instanceof IOException) throw (IOException) cause;
            throw new IOException(cause);
        }
    }

    /** Empieza a extraer en segundo plano, para que la canción esté lista cuando le toque. */
    static void prefetch(String videoId) {
        if (videoId != null && VIDEO_ID.matcher(videoId).matches()) request(videoId);
    }

    /** La URL guardada dejó de servir (p. ej. venció): la próxima vez se extrae otra. */
    static void forget(String videoId) {
        STREAMS.remove(videoId);
    }

    private static CompletableFuture<Stream> request(String videoId) {
        final CompletableFuture<Stream> future = STREAMS.compute(videoId, (id, saved) ->
                saved != null && !stale(saved) ? saved : CompletableFuture.supplyAsync(() -> extract(id), WORKER));
        // Un fallo no se guarda: la próxima vez se intenta de nuevo.
        future.whenComplete((stream, error) -> {
            if (error != null) STREAMS.remove(videoId, future);
        });
        return future;
    }

    private static boolean stale(CompletableFuture<Stream> future) {
        if (!future.isDone()) return false;
        if (future.isCompletedExceptionally()) return true;
        final Stream stream = future.getNow(null);
        return stream == null || System.currentTimeMillis() >= stream.expiresAt;
    }

    private static Stream extract(String videoId) {
        try {
            final StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + videoId);
            final AudioStream stream = info.getAudioStreams().stream()
                    .filter(AudioStream::isUrl)
                    .max(Comparator.comparingInt(AudioStream::getAverageBitrate))
                    .orElseThrow(() -> new UnavailableException("YouTube no ofreció un stream directo de audio.", null));
            return new Stream(
                    stream.getContent(),
                    safe(info.getName(), videoId),
                    safe(info.getUploaderName(), "SoundBlue"),
                    firstImage(info.getThumbnails()),
                    stream.getFormat() == null ? "" : stream.getFormat().getName(),
                    Math.max(0, info.getDuration()));
        } catch (ExtractionException error) {
            throw new CompletionException(new UnavailableException(
                    "NewPipe no pudo extraer el audio: " + safe(error.getMessage(), "error de extracción"), error));
        } catch (IOException error) {
            throw new CompletionException(error);
        }
    }

    /** Las URL de YouTube traen `expire` (segundos): se renueva un poco antes. */
    private static long expiry(String audioUrl) {
        final long now = System.currentTimeMillis();
        try {
            final String expire = Uri.parse(audioUrl).getQueryParameter("expire");
            if (expire != null) return Math.max(now, Long.parseLong(expire) * 1000L - EXPIRY_MARGIN_MS);
        } catch (RuntimeException ignored) {
            // URL sin ese dato: se usa el tiempo por defecto
        }
        return now + DEFAULT_TTL_MS;
    }

    static String firstImage(final List<Image> images) {
        if (images == null || images.isEmpty() || images.get(0) == null) return "";
        return safe(images.get(0).getUrl(), "");
    }

    static String safe(final String value, final String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }
}
