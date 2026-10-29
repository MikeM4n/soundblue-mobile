package com.soundblue.mobile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.search.SearchExtractor;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

import static com.soundblue.mobile.StreamResolver.firstImage;
import static com.soundblue.mobile.StreamResolver.safe;

@CapacitorPlugin(name = "NewPipe")
public final class NewPipePlugin extends Plugin {
    private static final ExecutorService WORKER = Executors.newFixedThreadPool(2);

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
                final List<InfoItem> items = extractor.getInitialPage().getItems();
                final JSArray results = new JSArray();
                for (final InfoItem item : items) {
                    if (!(item instanceof StreamInfoItem)) continue;
                    final StreamInfoItem video = (StreamInfoItem) item;
                    final String videoId = videoIdFromUrl(video.getUrl());
                    if (videoId == null) continue;

                    final String uploader = safe(video.getUploaderName(), "YouTube");
                    final JSObject result = new JSObject();
                    result.put("id", videoId);
                    result.put("title", video.getName());
                    result.put("artist", uploader.replaceFirst(" - Topic$", ""));
                    result.put("ytMusic", uploader.endsWith(" - Topic"));
                    result.put("duration", video.getDuration() > 0 ? video.getDuration() : 0);
                    result.put("artwork", firstImage(video.getThumbnails()));
                    results.put(result);
                    if (results.length() >= 30) break;
                }

                final JSObject response = new JSObject();
                response.put("results", results);
                call.resolve(response);
            } catch (final Exception error) {
                call.reject("NewPipe no pudo buscar en YouTube: " + safe(error.getMessage(), "error de extracción"), error);
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

    private static String videoIdFromUrl(final String url) {
        if (url == null) return null;
        final java.util.regex.Matcher matcher = Pattern.compile("(?:v=|youtu\\.be/)([A-Za-z0-9_-]{11})")
                .matcher(url);
        return matcher.find() ? matcher.group(1) : null;
    }
}
