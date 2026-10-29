package com.soundblue.mobile;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Actualizaciones fuera de Play Store (src/lib/apkUpdate.ts): descarga el APK nuevo con DownloadManager (con su
 * notificación de progreso), avisa el porcentaje («progress») y al terminar abre el instalador de Android. La primera vez
 * Android pide permitir «Instalar apps desconocidas» para SoundBlue, y solo instala el APK si está firmado con la misma
 * clave que el que está instalado.
 */
@CapacitorPlugin(name = "AppUpdater")
public final class UpdatePlugin extends Plugin {
    private static final String APK_NAME = "SoundBlue.apk";
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static final long POLL_MS = 500;

    private final Handler main = new Handler(Looper.getMainLooper());
    private PluginCall pending; // la descarga en curso (una a la vez); se responde al abrir el instalador

    @PluginMethod
    public void downloadAndInstall(final PluginCall call) {
        final String url = call.getString("url", "");
        if (!url.startsWith("https://")) {
            call.reject("La dirección del APK no es válida.");
            return;
        }
        main.post(() -> {
            if (pending != null) {
                call.reject("La actualización ya se está descargando.");
                return;
            }
            final Context context = getContext();
            final File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) {
                call.reject("No hay dónde guardar la actualización.");
                return;
            }
            final File apk = new File(dir, APK_NAME);
            //noinspection ResultOfMethodCallIgnored
            apk.delete(); // la de una vez anterior: si no, DownloadManager guardaría «SoundBlue-1.apk»
            final DownloadManager manager = context.getSystemService(DownloadManager.class);
            final long id;
            try {
                id = manager.enqueue(new DownloadManager.Request(Uri.parse(url))
                        .setTitle("SoundBlue")
                        .setDescription("Descargando la actualización")
                        .setMimeType(APK_MIME)
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                        .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, APK_NAME));
            } catch (RuntimeException error) {
                call.reject("No se pudo empezar la descarga.", error);
                return;
            }
            pending = call;
            poll(manager, id, apk);
        });
    }

    @Override
    protected void handleOnDestroy() {
        // La descarga sigue en DownloadManager (y en su notificación), pero el instalador ya no se abre solo.
        main.removeCallbacksAndMessages(null);
        pending = null;
    }

    /** Cada medio segundo: el porcentaje mientras baja; al terminar, el instalador (o el error). */
    private void poll(final DownloadManager manager, final long id, final File apk) {
        final PluginCall call = pending;
        if (call == null) return;
        int status = -1; // sin fila: la cancelaron desde la notificación
        int reason = 0;
        long done = 0;
        long total = -1;
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor != null && cursor.moveToFirst()) {
                status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                done = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            }
        }
        if (status == DownloadManager.STATUS_SUCCESSFUL) {
            pending = null;
            install(call, apk);
            return;
        }
        if (status == -1 || status == DownloadManager.STATUS_FAILED) {
            pending = null;
            manager.remove(id);
            // En los errores de HTTP, `reason` es el código (404: no existe ese release o ese archivo).
            call.reject(status == -1 ? "Se canceló la descarga." : "No se pudo descargar la actualización (código " + reason + ").");
            return;
        }
        if (total > 0) {
            final JSObject data = new JSObject();
            data.put("percent", (int) (done * 100 / total));
            notifyListeners("progress", data);
        }
        main.postDelayed(() -> poll(manager, id, apk), POLL_MS);
    }

    private void install(final PluginCall call, final File apk) {
        final Context context = getContext();
        try {
            // Con FileProvider (AndroidManifest.xml, xml/file_paths.xml): el instalador no puede leer un file:// ajeno.
            final Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
            context.startActivity(new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, APK_MIME)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (IllegalArgumentException | ActivityNotFoundException error) {
            call.reject("No se pudo abrir el instalador de Android.", error);
        }
    }
}
