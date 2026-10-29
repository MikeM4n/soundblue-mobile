package com.soundblue.mobile;

import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** HTTP implementation used by NewPipe Extractor. Calls run on the plugin's worker executor. */
public final class NewPipeDownloader extends Downloader {
    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) "
                    + "Gecko/20100101 Firefox/128.0";

    @Override
    public Response execute(final Request request) throws IOException, ReCaptchaException {
        final HttpURLConnection connection =
                (HttpURLConnection) new URL(request.url()).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestMethod(request.httpMethod());
        connection.setRequestProperty("User-Agent", USER_AGENT);

        for (final Map.Entry<String, List<String>> header : request.headers().entrySet()) {
            if (header.getKey() == null || header.getValue() == null) continue;
            boolean first = true;
            for (final String value : header.getValue()) {
                if (first) {
                    connection.setRequestProperty(header.getKey(), value);
                    first = false;
                } else {
                    connection.addRequestProperty(header.getKey(), value);
                }
            }
        }

        final byte[] body = request.dataToSend();
        if (body != null && body.length > 0) {
            connection.setDoOutput(true);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }
        }

        try {
            final int status = connection.getResponseCode();
            final InputStream stream = status >= HttpURLConnection.HTTP_BAD_REQUEST
                    ? connection.getErrorStream() : connection.getInputStream();
            final String responseBody = stream == null ? "" : readBody(stream);
            final Map<String, List<String>> headers = connection.getHeaderFields();
            return new Response(status, connection.getResponseMessage(),
                    headers == null ? Collections.emptyMap() : headers,
                    responseBody, connection.getURL().toString());
        } finally {
            connection.disconnect();
        }
    }

    private static String readBody(final InputStream input) throws IOException {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            final byte[] buffer = new byte[8192];
            int read;
            while ((read = stream.read(buffer)) != -1) output.write(buffer, 0, read);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }
}
