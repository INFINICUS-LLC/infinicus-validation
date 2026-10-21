package com.infinicus.shell.core;

import java.net.Inet4Address;
import java.net.InetAddress;

/**
 * Which addresses the shell may print to. A receipt printer is on the shop's own network, so production allows ONLY private and link-local IPv4
 * addresses (RFC 1918 and 169.254/16). That keeps the printing bridge from being used as a way to send data to an arbitrary host. Tests pass a
 * policy that also allows loopback.
 */
public interface AddressPolicy {
    boolean permits(InetAddress address);

    /** Production policy: private (10/8, 172.16/12, 192.168/16) and link-local (169.254/16) IPv4 only; no loopback, no public, no IPv6. */
    AddressPolicy PRIVATE_NETWORK = address -> {
        if (!(address instanceof Inet4Address)) return false;
        return address.isSiteLocalAddress() || address.isLinkLocalAddress();
    };
}
