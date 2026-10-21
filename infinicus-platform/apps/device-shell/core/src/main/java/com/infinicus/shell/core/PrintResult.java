package com.infinicus.shell.core;

/** How a print attempt ended, as a FIXED code the web page can show or log. Never a raw exception text, never an address. */
public enum PrintResult {
    OK("ok"),
    INVALID_REQUEST("invalid_request"),
    NOT_CONFIGURED("not_configured"),
    NOT_PERMITTED("not_permitted"),
    TIMEOUT("timeout"),
    CONNECTION_FAILED("connection_failed"),
    WRITE_FAILED("write_failed");

    private final String code;

    PrintResult(String code) { this.code = code; }

    public String code() { return code; }

    public boolean isOk() { return this == OK; }
}
