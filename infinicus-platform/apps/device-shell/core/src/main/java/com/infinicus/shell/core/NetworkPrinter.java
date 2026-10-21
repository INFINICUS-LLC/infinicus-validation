package com.infinicus.shell.core;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Sends ESC/POS bytes to a network printer over a plain TCP connection (POS-8d-2b). One attempt per call, bounded in time, never retried here: a failed
 * print is reported to the counter, which tells the cashier (a retry could print a second copy if the first partly arrived). The target address must be
 * permitted by the AddressPolicy AFTER name resolution. Answers are fixed PrintResult codes; no address or exception text leaves this class.
 */
public final class NetworkPrinter {
    /** Opens a connection; replaceable so the time limits can be tested without a network. */
    public interface Connector {
        Socket open(InetAddress address, int port, int connectTimeoutMs) throws IOException;
    }

    public static final int DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
    public static final int DEFAULT_TOTAL_TIMEOUT_MS = 10_000;

    private final AddressPolicy policy;
    private final Connector connector;
    private final int connectTimeoutMs;
    private final int totalTimeoutMs;

    public NetworkPrinter(AddressPolicy policy) {
        this(policy, NetworkPrinter::realConnect, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS);
    }

    public NetworkPrinter(AddressPolicy policy, Connector connector, int connectTimeoutMs, int totalTimeoutMs) {
        this.policy = policy;
        this.connector = connector;
        this.connectTimeoutMs = connectTimeoutMs;
        this.totalTimeoutMs = totalTimeoutMs;
    }

    private static Socket realConnect(InetAddress address, int port, int connectTimeoutMs) throws IOException {
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(address, port), connectTimeoutMs);
            return socket;
        } catch (IOException | RuntimeException e) {
            try { socket.close(); } catch (IOException ignored) { /* already failing */ }
            throw e;
        }
    }

    /** Blocking; call it off the UI thread. */
    public PrintResult send(PrinterEndpoint endpoint, byte[] data) {
        if (endpoint == null || data == null || data.length == 0) return PrintResult.INVALID_REQUEST;
        InetAddress[] resolved;
        try {
            resolved = InetAddress.getAllByName(endpoint.host());
        } catch (UnknownHostException e) {
            return PrintResult.CONNECTION_FAILED;
        }
        InetAddress target = null;
        for (InetAddress candidate : resolved) {
            if (policy.permits(candidate)) { target = candidate; break; }
        }
        if (target == null) return PrintResult.NOT_PERMITTED;
        final InetAddress address = target;
        final AtomicReference<Socket> open = new AtomicReference<>();
        FutureTask<PrintResult> task = new FutureTask<>(() -> {
            try (Socket socket = connector.open(address, endpoint.port(), connectTimeoutMs)) {
                open.set(socket);
                OutputStream out = socket.getOutputStream();
                out.write(data);
                out.flush();
                socket.shutdownOutput();            // tell the printer nothing more is coming; it keeps printing what it has
                return PrintResult.OK;
            } catch (SocketTimeoutException e) {
                return PrintResult.TIMEOUT;
            } catch (IOException e) {
                return open.get() == null ? PrintResult.CONNECTION_FAILED : PrintResult.WRITE_FAILED;
            }
        });
        Thread worker = new Thread(task, "infinicus-network-print");
        worker.setDaemon(true);
        worker.start();
        try {
            return task.get(totalTimeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            Socket stuck = open.get();
            if (stuck != null) {
                try { stuck.close(); } catch (IOException ignored) { /* closing unblocks the worker */ }
            }
            worker.interrupt();
            return PrintResult.TIMEOUT;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return PrintResult.TIMEOUT;
        } catch (ExecutionException e) {
            return PrintResult.CONNECTION_FAILED;
        }
    }
}
