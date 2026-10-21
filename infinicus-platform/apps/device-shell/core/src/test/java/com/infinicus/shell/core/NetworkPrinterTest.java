package com.infinicus.shell.core;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

class NetworkPrinterTest {
    /** Test policy: private networks plus loopback, so a real local socket can stand in for the printer. */
    private static final AddressPolicy WITH_LOOPBACK = a -> a.isLoopbackAddress() || AddressPolicy.PRIVATE_NETWORK.permits(a);

    /** A stand-in printer: accepts one connection and records every byte until the sender signals it is done. */
    private static final class FakePrinter implements AutoCloseable {
        final ServerSocket server;
        final CompletableFuture<byte[]> received = new CompletableFuture<>();
        FakePrinter() throws IOException {
            server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
            Thread t = new Thread(() -> {
                try (Socket s = server.accept(); InputStream in = s.getInputStream()) {
                    ByteArrayOutputStream all = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) >= 0) all.write(buf, 0, n);
                    received.complete(all.toByteArray());
                } catch (IOException e) {
                    received.completeExceptionally(e);
                }
            });
            t.setDaemon(true);
            t.start();
        }
        PrinterEndpoint endpoint() { return PrinterEndpoint.parse("127.0.0.1", String.valueOf(server.getLocalPort())).orElseThrow(); }
        @Override public void close() throws IOException { server.close(); }
    }

    @Test
    void delivers_every_byte_exactly_and_closes_the_connection() throws Exception {
        byte[] data = new byte[300_000];
        new Random(42).nextBytes(data);
        try (FakePrinter printer = new FakePrinter()) {
            assertEquals(PrintResult.OK, new NetworkPrinter(WITH_LOOPBACK).send(printer.endpoint(), data));
            assertArrayEquals(data, printer.received.get(5, java.util.concurrent.TimeUnit.SECONDS));   // EOF reached, so the sender closed its side
        }
    }

    @Test
    void a_small_escpos_receipt_arrives_unchanged() throws Exception {
        byte[] receipt = {0x1b, 0x40, 0x1b, 0x61, 0x01, 'S', 'h', 'o', 'p', 0x0a, 0x1d, 0x56, 0x42, 0x03, 0x1b, 0x70, 0x00, 0x19, (byte) 0xfa};
        try (FakePrinter printer = new FakePrinter()) {
            assertEquals(PrintResult.OK, new NetworkPrinter(WITH_LOOPBACK).send(printer.endpoint(), receipt));
            assertArrayEquals(receipt, printer.received.get(5, java.util.concurrent.TimeUnit.SECONDS));
        }
    }

    @Test
    void a_refused_connection_is_reported_as_connection_failed() throws Exception {
        int closedPort;
        try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) { closedPort = s.getLocalPort(); }
        PrinterEndpoint gone = PrinterEndpoint.parse("127.0.0.1", String.valueOf(closedPort)).orElseThrow();
        assertEquals(PrintResult.CONNECTION_FAILED, new NetworkPrinter(WITH_LOOPBACK).send(gone, new byte[] {1}));
    }

    @Test
    void production_policy_refuses_loopback_and_public_addresses_without_connecting() {
        AtomicInteger connects = new AtomicInteger();
        NetworkPrinter strict = new NetworkPrinter(AddressPolicy.PRIVATE_NETWORK, (a, p, t) -> { connects.incrementAndGet(); throw new IOException("must not connect"); }, 1000, 2000);
        for (String host : new String[] {"127.0.0.1", "localhost", "8.8.8.8", "93.184.216.34"}) {
            assertEquals(PrintResult.NOT_PERMITTED, strict.send(PrinterEndpoint.parse(host, "9100").orElseThrow(), new byte[] {1}), host);
        }
        assertEquals(0, connects.get());
    }

    @Test
    void a_connection_that_never_completes_times_out_within_the_limit_and_is_closed() {
        Socket[] opened = new Socket[1];
        NetworkPrinter slow = new NetworkPrinter(WITH_LOOPBACK, (a, p, t) -> {
            Socket s = new Socket();
            opened[0] = s;
            try { Thread.sleep(10_000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("interrupted"); }
            return s;
        }, 1000, 300);
        long start = System.nanoTime();
        PrintResult r = slow.send(PrinterEndpoint.parse("127.0.0.1", "9100").orElseThrow(), new byte[] {1});
        long ms = (System.nanoTime() - start) / 1_000_000;
        assertEquals(PrintResult.TIMEOUT, r);
        assertTrue(ms < 3000, "returned after " + ms + " ms");
    }

    @Test
    void a_write_that_fails_is_reported_as_write_failed_and_never_retried() {
        AtomicInteger connects = new AtomicInteger();
        NetworkPrinter broken = new NetworkPrinter(WITH_LOOPBACK, (a, p, t) -> {
            connects.incrementAndGet();
            return new Socket() {
                @Override public OutputStream getOutputStream() { return new OutputStream() { @Override public void write(int b) throws IOException { throw new IOException("printer went away"); } }; }
                @Override public void close() { /* nothing to close */ }
            };
        }, 1000, 2000);
        assertEquals(PrintResult.WRITE_FAILED, broken.send(PrinterEndpoint.parse("127.0.0.1", "9100").orElseThrow(), new byte[] {1, 2, 3}));
        assertEquals(1, connects.get());
    }

    @Test
    void empty_or_missing_input_is_an_invalid_request() {
        NetworkPrinter p = new NetworkPrinter(WITH_LOOPBACK);
        PrinterEndpoint e = PrinterEndpoint.parse("127.0.0.1", "9100").orElseThrow();
        assertEquals(PrintResult.INVALID_REQUEST, p.send(null, new byte[] {1}));
        assertEquals(PrintResult.INVALID_REQUEST, p.send(e, null));
        assertEquals(PrintResult.INVALID_REQUEST, p.send(e, new byte[0]));
    }
}
