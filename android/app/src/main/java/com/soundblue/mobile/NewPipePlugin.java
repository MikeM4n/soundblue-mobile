package com.soundblue.mobile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import androidx.core.content.ContextCompat;

import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.Image;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.search.SearchExtractor;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;

import java.util.Comparator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "NewPipe")
public final class NewPipePlugin extends Plugin {
    private BroadcastReceiver mediaNextReceiver;
    private BroadcastReceiver mediaPreviousReceiver;
    private static final Pattern VIDEO_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");
    private static final ExecutorService WORKER = Executors.newFixedThreadPool(2);

    @Override
    public void load() {
        mediaNextReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                notifyListeners("mediaNext", new JSObject());
            }
        };
        ContextCompat.registerReceiver(getContext(), mediaNextReceiver,
                new IntentFilter("com.soundblue.mobile.MEDIA_NEXT"), ContextCompat.RECEIVER_NOT_EXPORTED);
        mediaPreviousReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                notifyListeners("mediaPrevious", new JSObject());
            }
        };
        ContextCompat.registerReceiver(getContext(), mediaPreviousReceiver,
                new IntentFilter("com.soundblue.mobile.MEDIA_PREVIOUS"), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        if (mediaNextReceiver != null) {
            getContext().unregisterReceiver(mediaNextReceiver);
            mediaNextReceiver = null;
        }
        if (mediaPreviousReceiver != null) {
            getContext().unregisterReceiver(mediaPreviousReceiver);
            mediaPreviousReceiver = null;
        }
    }

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
        if (!VIDEO_ID.matcher(videoId).matches()) {
            call.reject("El identificador del video de YouTube no es válido.");
            return;
        }

        WORKER.execute(() -> {
            try {
                final String watchUrl = "https://www.youtube.com/watch?v=" + videoId;
                final StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, watchUrl);
                final AudioStream stream = info.getAudioStreams().stream()
                        .filter(AudioStream::isUrl)
                        .max(Comparator.comparingInt(AudioStream::getAverageBitrate))
                        .orElseThrow(() -> new IllegalStateException("YouTube no ofreció un stream directo de audio."));

                final JSObject response = new JSObject();
                response.put("audioUrl", stream.getContent());
                response.put("title", safe(info.getName(), videoId));
                response.put("artist", safe(info.getUploaderName(), "SoundBlue"));
                response.put("duration", Math.max(0, info.getDuration()));
                response.put("artwork", firstImage(info.getThumbnails()));
                response.put("mimeType", stream.getFormat() == null ? "" : stream.getFormat().getName());
                call.resolve(response);
            } catch (final Exception error) {
                call.reject("NewPipe no pudo extraer el audio: " + safe(error.getMessage(), "error de extracción"), error);
            }
        });
    }

    private static String videoIdFromUrl(final String url) {
        if (url == null) return null;
        final java.util.regex.Matcher matcher = Pattern.compile("(?:v=|youtu\\.be/)([A-Za-z0-9_-]{11})")
                .matcher(url);
        return matcher.find() ? matcher.group(1) : null;
    }

    private static String firstImage(final List<Image> images) {
        if (images == null || images.isEmpty() || images.get(0) == null) return "";
        return safe(images.get(0).getUrl(), "");
    }

    private static String safe(final String value, final String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }
}
