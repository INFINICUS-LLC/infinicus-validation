/**
 * Architecture guards for the device shell (POS-8d-2b): structural checks over its source text that pin the properties the design depends on, so none
 * can drift silently: the single trusted origin, bundled-only content, a minimal manifest, nothing the web page or another app can use to redirect
 * printing, and one copy of the routing rule shared with the web export server.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
/** Source text without comment lines, so a comment cannot satisfy or trip a check. */
const code = (p: string): string => read(p).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const APP = 'android/app/src/main';
const javaFiles = (dir: string): string[] => walk(join(ROOT, dir)).filter((f) => f.endsWith('.java')).map((f) => relative(ROOT, f));
const appJava = javaFiles(`${APP}/java`);
const coreJava = javaFiles('core/src/main/java');
const config = JSON.parse(read('capacitor.config.json')) as { appId: string; webDir: string; server?: Record<string, unknown>; android?: Record<string, unknown> };

describe('one trusted origin, bundled content only', () => {
  it('the origin in the Java code equals what capacitor.config.json serves from, and the printing bridge is installed for that origin only', () => {
    const origin = /ALLOWED_ORIGIN = "([^"]+)"/.exec(read('core/src/main/java/com/infinicus/shell/core/ShellOrigin.java'))?.[1];
    expect(origin).toBe(`${config.server?.androidScheme}://${config.server?.hostname}`);
    const bridge = code(`${APP}/java/com/infinicus/counter/ShellDeviceBridge.java`);
    expect(bridge).toContain('Collections.singleton(ShellOrigin.ALLOWED_ORIGIN)');
    expect(bridge).not.toMatch(/"\*"|"https?:\/\//);
    expect(bridge.match(/WebViewCompat\.addWebMessageListener\(/g)).toHaveLength(1);
    expect(bridge.match(/WebViewCompat\.addDocumentStartJavaScript\(/g)).toHaveLength(1);
    expect(bridge).toContain('if (!isMainFrame) return;');
  });

  it('the counter is bundled, never loaded from a remote address, and the shell is configured securely', () => {
    expect(config.webDir).toBe('../web/out');
    expect(config.server?.url).toBeUndefined();
    expect(config.server?.cleartext).toBeUndefined();
    expect(config.server?.androidScheme).toBe('https');
    expect(config.android?.allowMixedContent).toBe(false);
    expect(config.android?.webContentsDebuggingEnabled).toBe(false);
    expect(JSON.stringify(config)).not.toMatch(/https?:\/\//);
  });
});

describe('minimal Android manifest', () => {
  const manifest = read(`${APP}/AndroidManifest.xml`);
  it('no backup of app data, no cleartext traffic, and the only permission is network access', () => {
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    const permissions = [...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((m) => m[1]);
    expect(permissions).toEqual(['android.permission.INTERNET']);
  });
  it('one launcher activity, and no way for another app or a link to start it with data (no VIEW, SEND or custom intent filters)', () => {
    expect(manifest.match(/<activity\b/g)).toHaveLength(1);
    expect(manifest.match(/<intent-filter>/g)).toHaveLength(1);
    expect(manifest).toContain('android.intent.action.MAIN');
    expect(manifest).not.toMatch(/android\.intent\.action\.(VIEW|SEND|SEND_MULTIPLE)|android\.intent\.category\.BROWSABLE|android:scheme=/);
  });
});

describe('nothing can redirect or widen printing', () => {
  it('the printer address is read only from the app\'s private storage: no intent extras, no page-callable methods, no legacy JavaScript interface', () => {
    for (const f of appJava) {
      const text = code(f);
      expect(text, f).not.toMatch(/getIntent\(\)|getStringExtra|getExtras|getIntExtra/);
      expect(text, f).not.toMatch(/@PluginMethod|addJavascriptInterface|@JavascriptInterface/);
    }
    expect(code(`${APP}/java/com/infinicus/counter/ShellSettings.java`)).toContain('MODE_PRIVATE');
    expect(code(`${APP}/java/com/infinicus/counter/ShellSettings.java`)).not.toMatch(/\.edit\(\)|\.put(String|Int)\(/);   // no setter in this block
  });

  it('printing goes through the strict parser, the private-network policy and fixed result codes only', () => {
    const bridge = code(`${APP}/java/com/infinicus/counter/ShellDeviceBridge.java`);
    expect(bridge).toContain('new NetworkPrinter(AddressPolicy.PRIVATE_NETWORK)');
    expect(bridge).toContain('PrintRequest.parse(data)');
    expect(bridge).not.toMatch(/Logger\.(debug|info|warn|error)\([^)]*(data|payload|endpoint|host)/);   // never log the bytes or the address
    expect(bridge).not.toMatch(/getMessage\(\)|printStackTrace|toString\(\)/);                         // no exception text reaches the page
  });

  it('the shim and the configuration contain no address, URL or printer setting', () => {
    for (const text of [read(`${APP}/assets/infinicus-device-shim.js`), read('capacitor.config.json')]) {
      expect(text).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      expect(text).not.toMatch(/https?:\/\/(?!localhost)/);
    }
    expect(read(`${APP}/assets/infinicus-device-shim.js`)).not.toMatch(/host|9100|socket/i);
  });
});

describe('one routing rule, one copy of the logic', () => {
  it('the Java pattern equals the web export server\'s pattern', () => {
    const java = /BUSINESS_SCREEN = Pattern\.compile\("([^"]+)"\)/.exec(read('core/src/main/java/com/infinicus/shell/core/ShellRoutes.java'))?.[1];
    const web = /exec\(cleanPath\)|\.exec\(cleanPath\)/.test('') ? '' : /const m = \/(.+)\/\.exec\(cleanPath\)/.exec(readFileSync(join(ROOT, '../web/scripts/serve-export.mjs'), 'utf8'))?.[1];
    expect(java).toBeDefined();
    expect(web).toBeDefined();
    expect(java).toBe((web as string).replace(/\\\//g, '/'));
  });

  it('the shared core is plain Java (no Android classes) and the app compiles it from there, not from a copy', () => {
    for (const f of coreJava) expect(read(f), f).not.toMatch(/^import (android|androidx|com\.getcapacitor)\./m);
    expect(read('android/app/build.gradle')).toContain("java.srcDirs += '../../core/src/main/java'");
    expect(appJava.filter((f) => /ShellRoutes|PrintRequest|NetworkPrinter|PrinterEndpoint|AddressPolicy|PrintResult/.test(f))).toEqual([]);
  });
});

describe('no secrets or build outputs in the shell', () => {
  it('signing material and generated outputs are ignored by version control, and none is present', () => {
    const ignore = read('android/.gitignore');
    for (const pattern of ['*.jks', '*.keystore', 'keystore.properties', '*.apk', '*.aab', 'build/']) expect(ignore, pattern).toContain(pattern);
    const tracked = walk(ROOT).map((f) => relative(ROOT, f)).filter((f) => !f.includes('node_modules') && !f.startsWith('android/app/build') && !f.startsWith('core/build') && !f.includes('.gradle/') && !f.startsWith('android/app/src/main/assets/public'));
    expect(tracked.filter((f) => /\.(jks|keystore|p12|pem|apk|aab)$|keystore\.properties|google-services\.json/.test(f))).toEqual([]);
    expect(existsSync(join(ROOT, 'android/local.properties'))).toBe(false);
  });
});
