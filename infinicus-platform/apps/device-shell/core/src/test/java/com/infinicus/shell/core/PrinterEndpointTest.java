package com.infinicus.shell.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.InetAddress;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class PrinterEndpointTest {
    @Test
    void accepts_ipv4_addresses_and_plain_host_names_with_a_valid_port() {
        Optional<PrinterEndpoint> e = PrinterEndpoint.parse(" 192.168.1.50 ", " 9100 ");
        assertTrue(e.isPresent());
        assertEquals("192.168.1.50", e.get().host());
        assertEquals(9100, e.get().port());
        assertEquals("receipt-printer.lan", PrinterEndpoint.parse("Receipt-Printer.LAN", "9100").get().host());
        assertTrue(PrinterEndpoint.parse("printer", "1").isPresent());
        assertTrue(PrinterEndpoint.parse("10.0.0.2", "65535").isPresent());
    }

    @Test
    void refuses_malformed_hosts_and_ports() {
        for (String host : new String[] {null, "", "  ", "999.1.1.1", "1.2.3", "1.2.3.4.5", "-bad.example", "bad_name", "has space", "a..b", "http://10.0.0.2", "10.0.0.2:9100", "10.0.0.2/24", "::1", "x".repeat(254), "a".repeat(64) + ".lan"}) {
            assertFalse(PrinterEndpoint.parse(host, "9100").isPresent(), String.valueOf(host));
        }
        for (String port : new String[] {null, "", "0", "-1", "65536", "99999", "abc", "9100.5", "1e3"}) {
            assertFalse(PrinterEndpoint.parse("10.0.0.2", port).isPresent(), String.valueOf(port));
        }
    }

    private static boolean permits(String ip) throws Exception {
        return AddressPolicy.PRIVATE_NETWORK.permits(InetAddress.getByName(ip));
    }

    @Test
    void the_production_policy_allows_only_private_and_link_local_ipv4() throws Exception {
        for (String ok : new String[] {"10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.254", "192.168.0.1", "192.168.255.254", "169.254.10.10"}) assertTrue(permits(ok), ok);
        for (String no : new String[] {"8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "192.167.1.1", "192.169.1.1", "100.64.0.1", "127.0.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "93.184.216.34", "::1", "fe80::1", "fd00::1", "2001:4860:4860::8888"}) assertFalse(permits(no), no);
    }
}
