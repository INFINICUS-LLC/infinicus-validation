package com.infinicus.counter;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Logger;
import com.infinicus.shell.core.AddressPolicy;
import com.infinicus.shell.core.NetworkPrinter;
import com.infinicus.shell.core.PrintRequest;
import com.infinicus.shell.core.PrintResult;
import com.infinicus.shell.core.PrinterEndpoint;
import com.infinicus.shell.core.ShellOrigin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The printing bridge, contract version 1 (window.InfinicusDevice, defined by assets/infinicus-device-shim.js). It is installed through two
 * origin-restricted mechanisms, a message port named InfinicusNative and a document-start script, so ONLY the bundled counter's own origin can reach
 * the printer; a page from any other origin sees neither. Messages are "&lt;id&gt;\n&lt;base64 ESC/POS&gt;", parsed strictly (PrintRequest), sent to the
 * configured private-network printer by NetworkPrinter off the UI thread, and answered "&lt;id&gt;\n&lt;fixed code&gt;". No payload, address or exception
 * text is ever logged or returned. On a WebView without these features nothing is installed and the counter falls back to browser printing.
 */
final class ShellDeviceBridge {
    private static final String TAG = "InfinicusShell";
    private static final String PORT_NAME = "InfinicusNative";
    private static final String SHIM_ASSET = "infinicus-device-shim.js";

    private final Context context;
    private final NetworkPrinter printer = new NetworkPrinter(AddressPolicy.PRIVATE_NETWORK);
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "infinicus-print");
        t.setDaemon(true);
        return t;
    });

    private ShellDeviceBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    static void install(Context context, WebView webView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Logger.warn(TAG, "this WebView cannot run the printing bridge; the counter will print through the browser");
            return;
        }
        String shim = readAsset(context);
        if (shim == null) {
            Logger.error(TAG, "printing bridge script missing from the app", null);
            return;
        }
        Set<String> origins = Collections.singleton(ShellOrigin.ALLOWED_ORIGIN);
        ShellDeviceBridge bridge = new ShellDeviceBridge(context);
        try {
            WebViewCompat.addWebMessageListener(webView, PORT_NAME, origins, bridge::onMessage);
            WebViewCompat.addDocumentStartJavaScript(webView, shim, origins);
        } catch (RuntimeException e) {
            Logger.error(TAG, "printing bridge could not be installed", e);
        }
    }

    private static String readAsset(Context context) {
        try (InputStream in = context.getAssets().open(SHIM_ASSET)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int n;
            while ((n = in.read(buffer)) >= 0) out.write(buffer, 0, n);   // readAllBytes() needs Android 13; the app supports Android 7
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }

    private void onMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy reply) {
        if (!isMainFrame) return;                              // the counter is the main frame; the print frame and any other frame get nothing
        final String data = message.getData();
        Optional<String> id = PrintRequest.idOf(data);
        if (!id.isPresent()) return;                           // cannot be answered: no usable id
        Optional<PrintRequest> request = PrintRequest.parse(data);
        if (!request.isPresent()) {
            reply.postMessage(PrintRequest.reply(id.get(), PrintResult.INVALID_REQUEST));
            return;
        }
        worker.execute(() -> reply.postMessage(PrintRequest.reply(request.get().id(), print(request.get()))));
    }

    private PrintResult print(PrintRequest request) {
        Optional<PrinterEndpoint> endpoint = ShellSettings.printer(context);
        if (!endpoint.isPresent()) return PrintResult.NOT_CONFIGURED;
        return printer.send(endpoint.get(), request.payload());
    }
}
