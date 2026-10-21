package com.infinicus.counter;

import android.content.Context;
import android.content.SharedPreferences;
import com.infinicus.shell.core.PrinterEndpoint;
import java.util.Optional;

/**
 * Device-local settings, in the app's private storage only. The printer's address lives here and nowhere else: not in the web page, not in the
 * registry, not in the repository. There is deliberately NO way to set it from the page or from an intent (another app could otherwise redirect
 * receipts); the in-shell settings screen arrives with POS-8d-2c. Until then it is written on the device by a developer (debug builds) for acceptance.
 */
final class ShellSettings {
    private static final String FILE = "infinicus_shell";
    private static final String KEY_HOST = "printer_host";
    private static final String KEY_PORT = "printer_port";

    private ShellSettings() {}

    /** The configured printer, or empty when none is set or the stored values are not valid. */
    static Optional<PrinterEndpoint> printer(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
        return PrinterEndpoint.parse(prefs.getString(KEY_HOST, null), prefs.getString(KEY_PORT, String.valueOf(PrinterEndpoint.DEFAULT_PORT)));
    }
}
