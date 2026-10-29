package com.soundblue.mobile;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.WebViewListener;
import android.webkit.WebView;
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
        registerPlugin(UpdatePlugin.class);
        StreamResolver.init();
        super.onCreate(savedInstanceState);
        final Bridge bridge = getBridge();
        WebView webView = bridge == null ? null : bridge.getWebView();

        if (webView != null) {
            // 1. Configuración para permitir audio sin interacción
            webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }

            // 2. Bloqueador de peticiones (Adblock para tu proyecto personal). Extiende el cliente de Capacitor: es el que
            // sirve la interfaz empaquetada en https://localhost. Con un WebViewClient genérico esas peticiones salían a la
            // red y el WebView mostraba «localhost rechazó la conexión» en vez de la app.
            bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
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
            bridge.addWebViewListener(new WebViewListener() {
                @Override
                public void onPageLoaded(WebView loadedWebView) {
                    loadedWebView.evaluateJavascript(VISIBILITY_SCRIPT, null);
                }
            });
        }
    }
}
