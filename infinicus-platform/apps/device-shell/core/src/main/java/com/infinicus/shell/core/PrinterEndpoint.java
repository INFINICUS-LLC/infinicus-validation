package com.infinicus.shell.core;

import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Where the receipt printer is: a host (an IPv4 address or a plain host name) and a TCP port (raw ESC/POS printing; 9100 is the usual default, to be
 * confirmed per printer model). It lives only on the device, never in the web page and never in the database. Syntax is checked here; whether the
 * ADDRESS is allowed is decided at connect time by the AddressPolicy, after the name is resolved.
 */
public final class PrinterEndpoint {
    private static final Pattern IPV4 = Pattern.compile("^(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}$");
    private static final Pattern HOST_NAME = Pattern.compile("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$");
    public static final int DEFAULT_PORT = 9100;

    private final String host;
    private final int port;

    private PrinterEndpoint(String host, int port) {
        this.host = host;
        this.port = port;
    }

    public String host() { return host; }

    public int port() { return port; }

    /** Empty unless the host is an IPv4 address or a lower-case host name (at most 253 characters) and the port is 1 to 65535. */
    public static Optional<PrinterEndpoint> parse(String host, String port) {
        if (host == null || port == null) return Optional.empty();
        String h = host.trim().toLowerCase(java.util.Locale.ROOT);
        if (h.isEmpty() || h.length() > 253) return Optional.empty();
        boolean ipv4 = IPV4.matcher(h).matches();
        if (!ipv4) {
            if (!HOST_NAME.matcher(h).matches()) return Optional.empty();
            // A name whose last label is all digits is not a host name (it is a malformed address such as 999.1.1.1 or 1.2.3).
            String last = h.substring(h.lastIndexOf('.') + 1);
            if (last.chars().allMatch(Character::isDigit)) return Optional.empty();
        }
        int p;
        try {
            p = Integer.parseInt(port.trim());
        } catch (NumberFormatException e) {
            return Optional.empty();
        }
        if (p < 1 || p > 65535) return Optional.empty();
        return Optional.of(new PrinterEndpoint(h, p));
    }
}
