package com.infinicus.counter;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import java.util.Map;

/** The same request with a different address, so Capacitor's local server serves the bundled file the shell chose. Everything else is passed through. */
final class RewrittenRequest implements WebResourceRequest {
    private final WebResourceRequest base;
    private final Uri url;

    RewrittenRequest(WebResourceRequest base, Uri url) {
        this.base = base;
        this.url = url;
    }

    @Override public Uri getUrl() { return url; }
    @Override public boolean isForMainFrame() { return base.isForMainFrame(); }
    @Override public boolean isRedirect() { return base.isRedirect(); }
    @Override public boolean hasGesture() { return base.hasGesture(); }
    @Override public String getMethod() { return base.getMethod(); }
    @Override public Map<String, String> getRequestHeaders() { return base.getRequestHeaders(); }
}
