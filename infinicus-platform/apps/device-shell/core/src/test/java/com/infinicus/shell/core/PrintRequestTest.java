package com.infinicus.shell.core;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.Base64;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class PrintRequestTest {
    private static String b64(byte[] bytes) { return Base64.getEncoder().encodeToString(bytes); }

    @Test
    void parses_a_well_formed_request_and_returns_a_copy_of_the_bytes() {
        byte[] escpos = {0x1b, 0x40, 'H', 'i', 0x0a, 0x1d, 0x56, 0x42, 0x03};
        PrintRequest r = PrintRequest.parse("p1abc-7\n" + b64(escpos)).orElseThrow();
        assertEquals("p1abc-7", r.id());
        assertArrayEquals(escpos, r.payload());
        r.payload()[0] = 0;                                   // changing the copy must not change the request
        assertArrayEquals(escpos, r.payload());
    }

    @Test
    void refuses_malformed_messages_before_anything_else_happens() {
        String ok = b64(new byte[] {1, 2, 3});
        String[] bad = {
            null, "", "\n" + ok, "noNewline" + ok, "id\n", "id\n" + ok + "\nextra", "id\r\n" + ok, "id\n" + ok.substring(0, ok.length() - 1),
            "id\n!!!!", "id\nAAAA AAAA", "bad id\n" + ok, "bad/id\n" + ok, "x".repeat(65) + "\n" + ok, "id\n" + ok + "\r",
            "id\n" + b64(new byte[0]),
        };
        for (String message : bad) assertFalse(PrintRequest.parse(message).isPresent(), String.valueOf(message));
    }

    @Test
    void enforces_the_size_limit_exactly() {
        byte[] atLimit = new byte[PrintRequest.MAX_PAYLOAD_BYTES];
        Arrays.fill(atLimit, (byte) 'a');
        assertTrue(PrintRequest.parse("big\n" + b64(atLimit)).isPresent());
        assertFalse(PrintRequest.parse("big\n" + b64(new byte[PrintRequest.MAX_PAYLOAD_BYTES + 1])).isPresent());
        assertFalse(PrintRequest.parse("big\n" + "A".repeat(PrintRequest.MAX_MESSAGE_CHARS)).isPresent());
    }

    @Test
    void idOf_lets_the_page_be_told_about_a_bad_request_it_can_identify() {
        assertEquals(Optional.of("abc-1"), PrintRequest.idOf("abc-1\n!!!not base64"));
        assertEquals(Optional.empty(), PrintRequest.idOf("no newline"));
        assertEquals(Optional.empty(), PrintRequest.idOf("bad id\nx"));
        assertEquals(Optional.empty(), PrintRequest.idOf(null));
    }

    @Test
    void replies_carry_the_id_and_only_a_fixed_code() {
        assertEquals("abc-1\nok", PrintRequest.reply("abc-1", PrintResult.OK));
        for (PrintResult r : PrintResult.values()) {
            assertTrue(r.code().matches("[a-z_]+"), r.code());
            assertEquals("id\n" + r.code(), PrintRequest.reply("id", r));
        }
        assertTrue(PrintResult.OK.isOk());
        assertFalse(PrintResult.TIMEOUT.isOk());
    }
}
