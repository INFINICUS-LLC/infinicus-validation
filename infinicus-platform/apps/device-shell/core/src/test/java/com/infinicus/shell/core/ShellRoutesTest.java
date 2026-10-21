package com.infinicus.shell.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import java.util.function.Predicate;
import org.junit.jupiter.api.Test;

class ShellRoutesTest {
    private static final String ID = "00000000-0000-4000-8000-000000000003";
    private static final Set<String> BUNDLE = Set.of(
        "/index.html", "/sign-in/index.html", "/workspaces/index.html", "/businesses/index.html",
        "/businesses/_/counter/index.html", "/businesses/_/sales/index.html", "/businesses/_/printers/index.html",
        "/businesses/_/workflow/index.html", "/businesses/_/history/index.html");
    private static final Predicate<String> EXISTS = BUNDLE::contains;

    @Test
    void placeholderPath_matches_the_web_rule() {
        assertEquals("/businesses/_/counter/", ShellRoutes.placeholderPath("/businesses/" + ID + "/counter/"));
        assertEquals("/businesses/_/counter/", ShellRoutes.placeholderPath("/businesses/" + ID + "/counter"));
        assertEquals("/businesses/_/sales/extra/file.txt", ShellRoutes.placeholderPath("/businesses/" + ID + "/sales/extra/file.txt"));
        assertEquals("/businesses/_/printers/", ShellRoutes.placeholderPath("/businesses/another-id-entirely/printers/"));
        for (String untouched : new String[] {"/businesses/_/counter/", "/sign-in/", "/workspaces/", "/businesses/", "/businesses/" + ID, "/_next/static/chunks/a.js", "/"}) {
            assertEquals(untouched, ShellRoutes.placeholderPath(untouched), untouched);
        }
    }

    @Test
    void every_business_screen_address_resolves_to_its_placeholder_file() {
        for (String screen : new String[] {"counter", "sales", "printers", "workflow", "history"}) {
            String file = "/businesses/_/" + screen + "/index.html";
            assertEquals(file, ShellRoutes.resolve("/businesses/" + ID + "/" + screen + "/", EXISTS), screen + " with slash");
            assertEquals(file, ShellRoutes.resolve("/businesses/" + ID + "/" + screen, EXISTS), screen + " without slash");
            assertEquals(file, ShellRoutes.resolve("/businesses/_/" + screen + "/", EXISTS), screen + " placeholder itself");
        }
    }

    @Test
    void other_screens_resolve_to_their_own_index_file() {
        assertEquals("/sign-in/index.html", ShellRoutes.resolve("/sign-in/", EXISTS));
        assertEquals("/sign-in/index.html", ShellRoutes.resolve("/sign-in", EXISTS));
        assertEquals("/workspaces/index.html", ShellRoutes.resolve("/workspaces/", EXISTS));
        assertEquals("/businesses/index.html", ShellRoutes.resolve("/businesses/", EXISTS));
        assertEquals("/index.html", ShellRoutes.resolve("/", EXISTS));
    }

    @Test
    void file_requests_only_get_the_placeholder_mapping() {
        assertEquals("/_next/static/chunks/a.js", ShellRoutes.resolve("/_next/static/chunks/a.js", EXISTS));
        assertEquals("/businesses/_/counter/index.txt", ShellRoutes.resolve("/businesses/" + ID + "/counter/index.txt", EXISTS));
        assertEquals("/businesses/_/counter/index.html", ShellRoutes.resolve("/businesses/" + ID + "/counter/index.html", EXISTS));
        assertEquals("/favicon.ico", ShellRoutes.resolve("/favicon.ico", EXISTS));
    }

    @Test
    void an_address_with_no_bundled_file_is_left_to_the_default_behaviour() {
        assertEquals("/businesses/_/nonexistent/", ShellRoutes.resolve("/businesses/" + ID + "/nonexistent/", EXISTS));
        assertEquals("/businesses/" + ID, ShellRoutes.resolve("/businesses/" + ID, EXISTS));
        assertEquals("/nowhere", ShellRoutes.resolve("/nowhere", EXISTS));
    }

    @Test
    void unsafe_paths_are_never_rewritten_and_never_asked_about() {
        Predicate<String> mustNotBeCalled = p -> { throw new AssertionError("asked about " + p); };
        for (String unsafe : new String[] {"/businesses/" + ID + "/../x", "//evil", "/a/./b", "relative/path", "/a\\b", "/a/../../b", "", "/businesses/" + ID + "/counter/.."}) {
            assertEquals(unsafe, ShellRoutes.resolve(unsafe, mustNotBeCalled), unsafe);
        }
        assertEquals(null, ShellRoutes.resolve(null, mustNotBeCalled));
        assertFalse(ShellRoutes.isSafe("/x/../y"));
        assertTrue(ShellRoutes.isSafe("/businesses/_/counter/"));
    }
}
