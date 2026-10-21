package com.infinicus.counter;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * The shell's single screen: Capacitor's bridge activity carrying the bundled counter. The shell plugin is registered BEFORE the bridge starts, so its
 * load() runs before the first page is requested (see ShellPlugin).
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShellPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
