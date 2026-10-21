package com.infinicus.counter;

import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Wires the shell into Capacitor's bridge while it is being created, which is before the first page load: (1) the request-routing web client that
 * serves business addresses from the bundled placeholder screens, and (2) the origin-restricted printing bridge that defines window.InfinicusDevice.
 * It exposes NO methods to the web page: the page can only reach the printer through the contract-v1 bridge.
 */
@CapacitorPlugin(name = "InfinicusShell")
public class ShellPlugin extends Plugin {
    private static final String TAG = "InfinicusShell";

    @Override
    public void load() {
        Bridge bridge = getBridge();
        WebView webView = bridge.getWebView();
        bridge.setWebViewClient(new ShellWebViewClient(bridge, getContext().getAssets()));
        ShellDeviceBridge.install(getContext(), webView);
        Logger.info(TAG, "shell routing installed");
    }
}
