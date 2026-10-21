# BLOCK POS-8d-2b — Native shell scaffold and network printing (Capacitor / Android)

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Status | **IMPLEMENTED — VALIDATION PENDING (Android compile/assemble is verified only by GitHub CI; hardware testing pending)** |
| Authorised by | Owner message "POS-8D-2A REVIEW AND NEXT-BLOCK AUTHORIZATION" (Q1 approved: Capacitor, Android only) |
| Builds on | POS-8d-1 (`window.InfinicusDevice` v1), POS-8d-2a (static export, PR #216) |
| Not in this block | Bluetooth/USB, in-shell printer settings screen (8d-2c); signing/distribution (8d-2d); offline selling (OFF-1..5); CORS/API origin (Q3); any production, database or Phase W2 action |

## 1. What was built
- `apps/device-shell/`: Capacitor 8 Android project bundling the static export (`webDir ../web/out`), `appId com.infinicus.counter` (**provisional**, Q7), WebView origin `https://localhost`, cleartext off, backups off, WebView debugging off.
- **Route fallback.** Capacitor's local server sends paths without a dot to the root `index.html`. `ShellRoutes` rewrites `/businesses/<id>/<screen>` to the exported `/businesses/_/<screen>/index.html` only when that asset exists. The real business id stays in the address; the page reads it with `useBusinessId` (8d-2a). The shell never reads or stores an identity.
- **Bridge.** `ShellDeviceBridge` uses `WebViewCompat.addWebMessageListener("InfinicusNative")` and `addDocumentStartJavaScript(infinicus-device-shim.js)`, restricted to origin `https://localhost`, main frame only. The shim defines the frozen `window.InfinicusDevice` v1 (`printEscPos(b64) -> Promise<{ok, error?}>`); it settles in 12 s (web waits 15 s) and never retries through the browser.
- **Network printing.** Plain-Java `core` module: `PrintRequest` (strict Base64, <= 1 MiB), `PrinterEndpoint` (literal IPv4, port range, no DNS), `AddressPolicy.PRIVATE_NETWORK` (RFC 1918 and link-local only; no loopback, public or IPv6), `NetworkPrinter` (raw TCP, connect/write timeouts, fixed result codes, no retry).
- **Printer address is device-local** (`ShellSettings`, SharedPreferences). No setter reachable from the page, intents or the bridge in 2b; the entry screen is 8d-2c. Until an address is configured the answer is `{ok:false}`.
- CI: `.github/workflows/device-shell.yml` (core JUnit, shim/guard tests, web export, `cap sync`, `assembleDebug`, `testDebugUnitTest`); `ci.yml` test filter includes `@infinicus/device-shell`.
- Dependency: pnpm override `uuid@<11.1.1 -> 11.1.1` (GHSA-w5hq-g745-h8pq via `@capacitor/cli > xcode`); the dependency scan passes (9 advisories, all allowlisted).

## 2. Architecture compliance
- No second source of truth: the shell holds no transaction, total, token or business id; it moves bytes to a printer and returns ok/fail.
- Server authority over final totals, payment consistency, idempotency and authorisation are untouched (no API, DB or web business-logic change).
- NA-04 (no web browser storage) and NA-05 (address validation) guards pass; `shell-guards.test.ts` pins the shell's own rules (origin lock, no cleartext, no backup, no debugging, no exported components beyond the launcher, no secrets, no address in the page).
- Printer registry (8b) still holds no addresses. No offline selling, queue or provisional totals.

## 3. Verification actually run (sandbox)
| Check | Result |
|---|---|
| Core module, Gradle + JUnit 5 with real local sockets | 21/21 PASS |
| Mutation: `AddressPolicy` allow-all | caught (2 tests fail); restored, 21/21 PASS |
| `@infinicus/device-shell` vitest (shim 12, guards 10) | 22/22 PASS |
| `pnpm lint && pnpm typecheck` | PASS (39 tasks) |
| Dependency vulnerability scan | PASS |
| `cap sync android` against the real export | PASS; `public/` contains `index.html`, `businesses/_/...` |

## 4. Not verified here
- **Android compile, `assembleDebug`, instrumented behaviour:** the sandbox has no Android SDK and Google Maven is blocked. The result is **UNKNOWN until the CI job runs**. Capacitor 8 / `androidx.webkit` usage follows Capacitor's own source and has not been compiled by me.
- Any behaviour on a tablet or printer: pending hardware (route fallback in a real WebView, Android local-network permission, real ESC/POS output, printer off, app killed mid-print).

## 5. Open design points and owner decisions
- How the page names a target printer (contract v1 has no printer argument): decided in 8d-2c.
- Q3 API origin / CORS for `https://localhost` (production configuration, not Phase W2); Q4 distribution; Q5 signing-key custody; Q6 pilot hardware; Q7 final app name/id; Q8 SDK in CI (GitHub hosted runner assumed).
- Android local-network permission behaviour on the pilot OS version: verify on the device.
