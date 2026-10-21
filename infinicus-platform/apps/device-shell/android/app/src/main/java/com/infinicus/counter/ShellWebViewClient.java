package com.infinicus.counter;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.infinicus.shell.core.ShellOrigin;
import com.infinicus.shell.core.ShellRoutes;
import java.io.IOException;
import java.io.InputStream;

/**
 * Capacitor's web client plus the counter's routing rule (ShellRoutes). Capacitor sends any address without a file extension to the ROOT page, which is
 * wrong for /businesses/&lt;id&gt;/&lt;screen&gt;; this client first rewrites such a request to the bundled placeholder screen's file, and then lets Capacitor
 * serve it. The browser address is not changed, so the page still reads the real business id from it. Only GET requests for the app's own origin are
 * considered; everything else goes to Capacitor untouched.
 */
final class ShellWebViewClient extends BridgeWebViewClient {
    /** Where Capacitor puts the bundled web files inside the app's assets. */
    private static final String WEB_ROOT = "public";

    private final AssetManager assets;

    ShellWebViewClient(Bridge bridge, AssetManager assets) {
        super(bridge);
        this.assets = assets;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (!"GET".equalsIgnoreCase(request.getMethod()) || !ShellOrigin.ALLOWED_ORIGIN.equals(url.getScheme() + "://" + url.getAuthority())) {
            return super.shouldInterceptRequest(view, request);
        }
        String path = url.getPath();
        String resolved = ShellRoutes.resolve(path, this::isBundled);
        if (resolved == null || resolved.equals(path)) {
            return super.shouldInterceptRequest(view, request);
        }
        return super.shouldInterceptRequest(view, new RewrittenRequest(request, url.buildUpon().path(resolved).build()));
    }

    private boolean isBundled(String path) {
        try (InputStream ignored = assets.open(WEB_ROOT + path)) {
            return true;
        } catch (IOException e) {
            return false;
        }
    }
}
