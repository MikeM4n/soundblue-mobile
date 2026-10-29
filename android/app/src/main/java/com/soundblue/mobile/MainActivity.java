package com.soundblue.mobile;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.WebViewListener;
import com.soundblue.mobile.widget.SoundBlueWidgetKt;
import android.content.Intent;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.os.Bundle;
import android.os.Build;
import java.io.ByteArrayInputStream;

public class MainActivity extends BridgeActivity {
    private static final String VISIBILITY_SCRIPT = "(function(){"
        + "try{Object.defineProperty(document,'hidden',{configurable:true,get:function(){return false;}});}catch(e){}"
        + "try{Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'visible';}});}catch(e){}"
        + "document.addEventListener('visibilitychange',function(e){e.stopImmediatePropagation();},true);"
        + "})();";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NewPipePlugin.class);
        registerPlugin(PlaybackPlugin.class);
        StreamResolver.init();
        super.onCreate(savedInstanceState);
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        
        if (webView != null) {
            // 1. Configuración para permitir audio sin interacción
            webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }

            // 2. Bloqueador de peticiones (Adblock para tu proyecto personal)
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    String url = request.getUrl().toString();
                    // Bloquea dominios de anuncios
                    if (url.contains("doubleclick.net") || 
                        url.contains("googleadservices.com") || 
                        url.contains("youtube.com/api/stats/ads") || 
                        url.contains("youtube.com/pagead")) {
                        // Retorna una respuesta vacía para que no se descargue el anuncio
                        return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream("".getBytes()));
                    }
                    return super.shouldInterceptRequest(view, request);
                }
            });

            // Mantiene la sesión de audio del WebView visible durante reproducción en segundo plano.
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageLoaded(WebView loadedWebView) {
                    loadedWebView.evaluateJavascript(VISIBILITY_SCRIPT, null);
                }
            });
        }
        if (savedInstanceState == null) handleWidgetIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleWidgetIntent(intent);
    }

    /** ▶ del widget sobre la última canción guardada: la app sigue con ella (evento «widgetPlay» de NativePlayer). */
    private void handleWidgetIntent(Intent intent) {
        if (intent == null || !SoundBlueWidgetKt.ACTION_WIDGET_PLAY.equals(intent.getAction()) || getBridge() == null) return;
        final PluginHandle handle = getBridge().getPlugin("NativePlayer");
        if (handle != null && handle.getInstance() instanceof PlaybackPlugin) {
            ((PlaybackPlugin) handle.getInstance()).widgetPlay();
        }
    }
}
