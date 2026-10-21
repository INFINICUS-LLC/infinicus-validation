package com.infinicus.shell.core;

import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * THE routing rule of the bundled counter (POS-8d-2a/2b). The static export holds each business screen ONCE under the placeholder id "_"; the shell
 * answers every /businesses/&lt;id&gt;/&lt;screen&gt;[/...] address with that file while the browser keeps the real address (the page reads the business
 * id from it). Capacitor's own local server would send such an address to the ROOT index.html, which is wrong for a deep address, so the shell rewrites
 * the request first.
 *
 * The pattern is the same one apps/web/scripts/serve-export.mjs uses (a test compares them). Pure: it only maps strings; whether a file exists is
 * asked through the predicate.
 */
public final class ShellRoutes {
    /** Same expression as placeholderPath in apps/web/scripts/serve-export.mjs. */
    static final Pattern BUSINESS_SCREEN = Pattern.compile("^/businesses/([^/]+)/([^/]+)(/.*)?$");
    static final String PLACEHOLDER = "_";

    private ShellRoutes() {}

    /** /businesses/&lt;id&gt;/&lt;screen&gt;[/...] becomes /businesses/_/&lt;screen&gt;[/...]; every other path (and the placeholder itself) is unchanged. */
    public static String placeholderPath(String path) {
        Matcher m = BUSINESS_SCREEN.matcher(path);
        if (m.matches() && !PLACEHOLDER.equals(m.group(1))) {
            String rest = m.group(3) == null ? "/" : m.group(3);
            return "/businesses/" + PLACEHOLDER + "/" + m.group(2) + rest;
        }
        return path;
    }

    /** False for a path that could climb out of the bundle or is not an absolute path; such requests are never rewritten. */
    static boolean isSafe(String path) {
        if (path == null || !path.startsWith("/")) return false;
        if (path.contains("\\") || path.contains("//") || path.indexOf('\0') >= 0) return false;
        for (String segment : path.split("/", -1)) {
            if (segment.equals("..") || segment.equals(".")) return false;
        }
        return true;
    }

    /**
     * The path the shell should serve for a request path, or the SAME path when nothing needs to change. A directory-like address (last segment has no
     * dot) becomes its explicit index file, because Capacitor sends such addresses to the root page; the file is used only if it exists in the bundle.
     *
     * @param assetExists asks whether a bundled file exists (for example "/businesses/_/counter/index.html")
     */
    public static String resolve(String path, Predicate<String> assetExists) {
        if (!isSafe(path)) return path;
        String mapped = placeholderPath(path);
        String base = mapped.endsWith("/") ? mapped.substring(0, mapped.length() - 1) : mapped;
        String last = base.substring(base.lastIndexOf('/') + 1);
        if (last.indexOf('.') >= 0) return mapped;                 // a file request (script, style, data): only the placeholder mapping applies
        String candidate = base + "/index.html";
        return assetExists.test(candidate) ? candidate : mapped;   // unknown address: leave it to the default behaviour
    }
}
