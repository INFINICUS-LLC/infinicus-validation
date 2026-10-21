package com.infinicus.shell.core;

import java.util.Base64;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * A print request from the counter page: the message "&lt;id&gt;\n&lt;base64 ESC/POS bytes&gt;" (contract v1 carries only the bytes; the target printer
 * is the one configured on this device). Parsing is strict: anything malformed is refused before anything touches the network. The id only correlates
 * the answer with the call.
 */
public final class PrintRequest {
    /** A receipt or ticket is a few kilobytes; this leaves room for raster images later and still bounds what the page can push. */
    public static final int MAX_PAYLOAD_BYTES = 1024 * 1024;
    static final int MAX_MESSAGE_CHARS = (MAX_PAYLOAD_BYTES / 3 + 1) * 4 + 128;
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9-]{1,64}$");

    private final String id;
    private final byte[] payload;

    private PrintRequest(String id, byte[] payload) {
        this.id = id;
        this.payload = payload;
    }

    public String id() { return id; }

    /** A copy: callers cannot alter the request. */
    public byte[] payload() { return payload.clone(); }

    /** The id of a message that has a well-formed first line, even when the rest is bad, so the page can still be told it failed. */
    public static Optional<String> idOf(String message) {
        if (message == null) return Optional.empty();
        int nl = message.indexOf('\n');
        if (nl < 1) return Optional.empty();
        String id = message.substring(0, nl);
        return ID.matcher(id).matches() ? Optional.of(id) : Optional.empty();
    }

    /** Returns empty for anything not exactly "id\nbase64", with a non-empty payload within the size limit. */
    public static Optional<PrintRequest> parse(String message) {
        if (message == null || message.length() > MAX_MESSAGE_CHARS) return Optional.empty();
        Optional<String> id = idOf(message);
        if (!id.isPresent()) return Optional.empty();
        String data = message.substring(id.get().length() + 1);
        if (data.isEmpty() || data.indexOf('\n') >= 0 || data.indexOf('\r') >= 0) return Optional.empty();
        if (data.length() % 4 != 0) return Optional.empty();   // the page always sends padded Base64 (btoa); Java's decoder alone would accept a truncated payload
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(data);          // the strict (RFC 4648) decoder: no line breaks, no stray characters
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        if (bytes.length == 0 || bytes.length > MAX_PAYLOAD_BYTES) return Optional.empty();
        return Optional.of(new PrintRequest(id.get(), bytes));
    }

    /** The reply message "&lt;id&gt;\n&lt;code&gt;" the page's script matches back to its call. */
    public static String reply(String id, PrintResult result) {
        return id + "\n" + result.code();
    }
}
