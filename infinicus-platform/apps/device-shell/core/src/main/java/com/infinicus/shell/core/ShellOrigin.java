package com.infinicus.shell.core;

/**
 * The only web origin the shell trusts: the one Capacitor serves the bundled counter from. It must equal capacitor.config.json
 * (server.androidScheme + "://" + server.hostname); a test keeps the two in step. The printing bridge and its script are installed for this origin only,
 * so no other page or frame can reach the printer.
 */
public final class ShellOrigin {
    public static final String ALLOWED_ORIGIN = "https://localhost";

    private ShellOrigin() {}
}
