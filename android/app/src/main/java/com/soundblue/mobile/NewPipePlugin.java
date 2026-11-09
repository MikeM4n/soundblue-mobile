package com.soundblue.mobile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.ListExtractor;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.playlist.PlaylistExtractor;
import org.schabi.newpipe.extractor.playlist.PlaylistInfo;
import org.schabi.newpipe.extractor.playlist.PlaylistInfoItem;
import org.schabi.newpipe.extractor.search.SearchExtractor;
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;
import org.schabi.newpipe.extractor.stream.StreamType;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.soundblue.mobile.StreamResolver.firstImage;
import static com.soundblue.mobile.StreamResolver.safe;

@CapacitorPlugin(name = "NewPipe")
public final class NewPipePlugin extends Plugin {
    private static final ExecutorService WORKER = Executors.newFixedThreadPool(2);
    private static final Pattern VIDEO_IN_URL = Pattern.compile("(?:v=|youtu\\.be/)([A-Za-z0-9_-]{11})");
    private static final Pattern PLAYLIST_ID = Pattern.compile("^[A-Za-z0-9_-]{2,64}$");
    private static final Pattern PLAYLIST_IN_URL = Pattern.compile("[?&]list=([A-Za-z0-9_-]+)");
    private static final int SEARCH_RESULTS = 30;
    private static final int SEARCH_PLAYLISTS = 15;
    private static final int PLAYLIST_MAX = 5000; // canciones como mucho al importar una playlist

    /** Búsqueda normal de YouTube (cualquier video, sin importar sus vistas), con las vistas de cada uno. */
    @PluginMethod
    public void searchVideos(final PluginCall call) {
        final String query = call.getString("query", "").trim();
        if (query.isEmpty()) {
            call.reject("Escribe algo para buscar.");
            return;
        }

        WORKER.execute(() -> {
            try {
                final SearchExtractor extractor = ServiceList.YouTube.getSearchExtractor(query);
                extractor.fetchPage(); // sin esto getInitialPage no tiene datos (fallaba siempre hasta la 2.0.1)
                final List<InfoItem> items = extractor.getInitialPage().getItems();
                final JSArray results = new JSArray();
                for (final InfoItem item : items) {
                    if (!(item instanceof StreamInfoItem)) continue;
                    final StreamInfoItem video = (StreamInfoItem) item;
                    final StreamType type = video.getStreamType();
                    if (type == StreamType.LIVE_STREAM || type == StreamType.AUDIO_LIVE_STREAM) continue; // directos
                    final JSObject result = videoJson(video);
                    if (result == null) continue;
                    results.put(result);
                    if (results.length() >= SEARCH_RESULTS) break;
                }

                final JSObject response = new JSObject();
                response.put("results", results);
                call.resolve(response);
            } catch (final Exception error) {
                call.reject("NewPipe no pudo buscar en YouTube: " + safe(error.getMessage(), "error de extracción"), error);
            }
        });
    }

    /**
     * Playlists públicas de YouTube que coinciden con la búsqueda (las de cualquier usuario, también las tuyas si son
     * públicas), con su dueño, carátula y cuántas canciones tienen. Sin las mezclas automáticas («Mix»).
     */
    @PluginMethod
    public void searchPlaylists(final PluginCall call) {
        final String query = call.getString("query", "").trim();
        if (query.isEmpty()) {
            call.reject("Escribe algo para buscar.");
            return;
        }

        WORKER.execute(() -> {
            try {
                final SearchExtractor extractor = ServiceList.YouTube.getSearchExtractor(
                        query, Collections.singletonList(YoutubeSearchQueryHandlerFactory.PLAYLISTS), "");
                extractor.fetchPage();
                final JSArray results = new JSArray();
                final Set<String> seen = new HashSet<>();
                for (final InfoItem item : extractor.getInitialPage().getItems()) {
                    if (!(item instanceof PlaylistInfoItem)) continue;
                    final PlaylistInfoItem playlist = (PlaylistInfoItem) item;
                    if (playlist.getPlaylistType() != PlaylistInfo.PlaylistType.NORMAL) continue;
                    final Matcher matcher = PLAYLIST_IN_URL.matcher(safe(playlist.getUrl(), ""));
                    if (!matcher.find() || !seen.add(matcher.group(1))) continue;
                    final JSObject result = new JSObject();
                    result.put("id", matcher.group(1));
                    result.put("title", safe(playlist.getName(), "Playlist"));
                    result.put("uploader", safe(playlist.getUploaderName(), ""));
                    result.put("image", firstImage(playlist.getThumbnails()));
                    result.put("count", playlist.getStreamCount());
                    results.put(result);
                    if (results.length() >= SEARCH_PLAYLISTS) break;
                }
                final JSObject response = new JSObject();
                response.put("results", results);
                call.resolve(response);
            } catch (final Exception error) {
                call.reject("NewPipe no pudo buscar playlists: " + safe(error.getMessage(), "error de extracción"), error);
            }
        });
    }

    /**
     * Una playlist pública (o no listada) de YouTube COMPLETA, de cualquier usuario: sigue sus páginas hasta `max`
     * canciones (como mucho 5000). Respaldo de la lectura por YouTube Music al importar (src/data/playlistImport.ts).
     */
    @PluginMethod
    public void getPlaylist(final PluginCall call) {
        final String id = call.getString("id", "").trim();
        final int max = Math.max(1, Math.min(call.getInt("max", PLAYLIST_MAX), PLAYLIST_MAX));
        if (!PLAYLIST_ID.matcher(id).matches()) {
            call.reject("El identificador de la playlist no es válido.");
            return;
        }

        WORKER.execute(() -> {
            try {
                final PlaylistExtractor extractor =
                        ServiceList.YouTube.getPlaylistExtractor("https://www.youtube.com/playlist?list=" + id);
                extractor.fetchPage();
                final JSArray tracks = new JSArray();
                final Set<String> seen = new HashSet<>();
                ListExtractor.InfoItemsPage<StreamInfoItem> page = extractor.getInitialPage();
                while (true) {
                    for (final StreamInfoItem video : page.getItems()) {
                        final JSObject track = videoJson(video);
                        if (track == null || !seen.add(track.getString("id"))) continue;
                        tracks.put(track);
                        if (tracks.length() >= max) break;
                    }
                    if (tracks.length() >= max || !page.hasNextPage()) break;
                    page = extractor.getPage(page.getNextPage());
                }

                final JSObject response = new JSObject();
                response.put("title", safe(extractor.getName(), "Playlist"));
                response.put("image", firstImage(extractor.getThumbnails()));
                long count = -1;
                try {
                    count = extractor.getStreamCount();
                } catch (final Exception ignored) {
                    // algunas no lo dicen
                }
                response.put("count", count);
                response.put("tracks", tracks);
                call.resolve(response);
            } catch (final Exception error) {
                call.reject("NewPipe no pudo leer la playlist: " + safe(error.getMessage(), "error de extracción"), error);
            }
        });
    }

    @PluginMethod
    public void getAudioStream(final PluginCall call) {
        final String videoId = call.getString("videoId", "").trim();
        if (!StreamResolver.VIDEO_ID.matcher(videoId).matches()) {
            call.reject("El identificador del video de YouTube no es válido.");
            return;
        }

        WORKER.execute(() -> {
            try {
                final StreamResolver.Stream stream = StreamResolver.resolve(videoId);
                final JSObject response = new JSObject();
                response.put("audioUrl", stream.audioUrl);
                response.put("title", stream.title);
                response.put("artist", stream.artist);
                response.put("duration", stream.duration);
                response.put("artwork", stream.artwork);
                response.put("mimeType", stream.mimeType);
                call.resolve(response);
            } catch (final Exception error) {
                call.reject(safe(error.getMessage(), "NewPipe no pudo extraer el audio."), error);
            }
        });
    }

    /** Un video para la app: id, título, artista (el canal, sin « - Topic»), duración, carátula y vistas (-1: no se sabe). */
    private static JSObject videoJson(final StreamInfoItem video) {
        final String videoId = videoIdFromUrl(video.getUrl());
        final String title = safe(video.getName(), "");
        if (videoId == null || title.isEmpty()) return null;
        final String uploader = safe(video.getUploaderName(), "YouTube");
        final JSObject result = new JSObject();
        result.put("id", videoId);
        result.put("title", title);
        result.put("artist", uploader.replaceFirst(" - Topic$", ""));
        result.put("ytMusic", uploader.endsWith(" - Topic"));
        result.put("duration", video.getDuration() > 0 ? video.getDuration() : 0);
        result.put("artwork", firstImage(video.getThumbnails()));
        result.put("viewCount", video.getViewCount());
        return result;
    }

    private static String videoIdFromUrl(final String url) {
        if (url == null) return null;
        final Matcher matcher = VIDEO_IN_URL.matcher(url);
        return matcher.find() ? matcher.group(1) : null;
    }
}
