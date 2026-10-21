# PREPARATION — POS-8d-2 native device shell (documentation only; NO CODE)

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Status | **PREPARATION ONLY.** Evidence gathered, options and a block plan written. No shell project, plugin, dependency, configuration or production change was made. |
| Authorised by | Owner message "8d-2 prep" (2026-10-21), following `DECISION-RECORD-POS-9-OFFLINE-SELLING.md` (D1, D6: offline selling only inside the native shell) |
| Builds on | POS-8d-1 (`window.InfinicusDevice` contract v1, merged), POS-8b/8c/8f (printer registry, print log, screens, merged) |
| What this unblocks | The decision on **how the counter is delivered into the shell** (section 3), which decides the next block. |

## 1. What the shell is for
1. **Printing without a dialog** on a tablet or till: receive ESC/POS bytes from the counter and send them to a thermal printer over **network (raw TCP), Bluetooth or USB**; open the cash drawer (the pulse is already in the bytes, 8d-1).
2. **Be the only place offline selling can live** (decision record D1, D6): an encrypted on-device store for queued sales (OFF-2 onwards).
3. Keep the **physical printer address on the device**, never in the web page or the registry (8b design, contract v1).

Everything else (screens, totals, rules) stays in the web counter and the API.

## 2. Evidence gathered (2026-10-21, read from this repository)
| # | Question | Finding | How verified |
|---|---|---|---|
| E1 | Can `apps/web` be packaged as static files inside an app? | **No, not as it is.** `next build` with `output: "export"` fails: *Page "/businesses/[businessId]/printers" is missing "generateStaticParams()" so it cannot be used with "output: export"*. The only dynamic route is `app/(client)/businesses/[businessId]`, and a business id exists only at run time. | Temporary edit of `next.config.mjs`, build, reverted (working tree clean afterwards). |
| E2 | Does the web app need a server? | **No.** No route handlers, middleware, server actions, `next/image`, `next/headers` or data fetching in `apps/web`; it is a pure client of the `/v1` API. The only obstacle to static packaging is E1. | Search of `app/` and `lib/`. |
| E3 | Is there a production web host the shell could load from instead? | **No** (owner statement and Cloudflare project list, 2026-10-21; the repository has no web Dockerfile or deploy workflow). | Earlier hosting check. |
| E4 | How does sign-in work (WebView-compatible?) | **Yes.** Email and password through `supabase-js` `signInWithPassword`; no redirect or OAuth flow; `detectSessionInUrl: false`. Supabase persists its own session (`persistSession: true`) in the WebView's storage, as in any browser. | `lib/client/supabaseProvider.ts`. |
| E5 | What origins may call the API? | CORS allows only the origins in `CORS_ALLOWED_ORIGINS` (non-secret env var, comma separated; default `https://infini-cus.com,https://www.infini-cus.com`). Methods now include `PUT` (the old gap, finding S-2, is closed). A bundled app's page origin (for Android WebView typically `https://localhost` unless configured) is **not** in the list. | `apps/api/src/app.ts`, `packages/configuration`. |
| E6 | Does the web client already tolerate the shell's contract? | Yes: `findDeviceBridge` accepts only `{version: 1, printEscPos}`, treats the answer as untrusted, has a 15 s timeout, and never retries a failed device print through the browser. | `lib/client/deviceBridge.ts` and its tests (merged). |
| E7 | Is an Android build possible in this sandbox? | **No.** Java and Gradle exist; the Android SDK does not. Nothing about the shell can be built or run here. | Environment check. |

## 3. The decision that matters: how the counter reaches the shell (from E1–E3)
| | Option | What it means | Verdict |
|---|---|---|---|
| **H-A** | **Shell loads a hosted web app** (Capacitor `server.url` style) | Needs a production web host that does not exist (design H1 in `NA-04_RELEASE_READINESS_AND_ISOLATED_TEST_HOSTING.md`, never built). **The shell cannot start with no connection**, because its UI comes from the network, so it **cannot support offline selling (D1)**. | Fine only for a printing-only pilot; **incompatible with the approved offline direction**. |
| **H-B** | **Shell bundles the counter as static files (recommended)** | The counter ships inside the app, works with no network, needs no web host. **Requires making `apps/web` statically exportable** (section 3.1), a web-only change. | Serves 8d-2 **and** OFF-1..5. |
| H-C | Run a small server inside the app | Not a mainstream path on Android; adds attack surface. | Rejected. |

**Recommendation: H-B.** One web-only preparation block ("static-export readiness") comes first; it needs no Android SDK and no hardware.

### 3.1 What "static-export readiness" would involve (a proposal, not started)
- Replace the dynamic `[businessId]` segment with a route the exporter can pre-render once (for example a single optional catch-all page), and read the business id **from the address** with the helper that already exists (`businessIdFromPath`, used by the tab bar), not with `useParams`.
- The shell serves that one page for every business address (a single-page-app fallback). **Whether the Capacitor local server does this fallback by default, and the exact setting, are not verified here**; they must be confirmed in the first Android build.
- **This touches a guard:** `noServerAccess.architecture.test.ts` lists the pages that use `useParams` and requires the `z.string().uuid()` validation. Changing the routing means updating that guard (keeping its intent: the id is validated before use, and no identity comes from the URL). That is an explicit guard change and needs the owner's approval when the block is authorised.
- Export must still pass the browser-secret scan; only the three public variables (`NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) are baked in at build time, so each shell build is tied to one environment.

## 4. Technology
- **Assumed since the planning of 8d: Capacitor on Android.** The owner has **never confirmed it**; it is Decision Q1 below.
- Alternatives, for the record: a plain native Android app with a WebView (full control, more native code to own); a different cross-platform shell. I have **not verified** the current state or fit of any third-party plugin or alternative framework and name none as a recommendation; a short spike on a real device is the right way to choose.
- iOS is **not planned** (no requirement stated; its network and Bluetooth rules differ and would need a separate evaluation).

## 5. The shell's contract and responsibilities
**Contract v1 (exists, unchanged):** `window.InfinicusDevice = { version: 1, printEscPos(dataBase64): Promise<{ ok: boolean; error?: string }> }`, injected before the page loads. The shell decodes the bytes, sends them to the configured printer, and answers `ok: true` **only when the printer accepted them**. No answer in 15 s counts as a failure on the web side.
**Needed for 8d-2:**
- Printer settings **inside the shell** (native screen): connection type (network, Bluetooth, USB), the physical address/port or paired device, paper width; stored in app-private storage on the device. A shell may hold more than one printer (receipt and kitchen); how the web page names the target printer in the call is **an open design point** (v1 has no printer argument; a v1-compatible addition or a v2 contract is decided in the block that builds the plugin).
- **Network printers:** raw TCP, port 9100 is the common default (to be confirmed per printer model); **Bluetooth:** pairing and the permission model of the Android version in use; **USB:** host permission prompts.
- The cash drawer opens through the printer, using the pulse already in the bytes.
**Needed later for offline (OFF-2, not 8d-2):** a persistent encrypted store API (a contract v2), sync scheduling, wipe-on-logout, device revocation.

## 6. Security requirements for the shell
- WebView restricted to the app's own content; navigation to other origins blocked; remote debugging off in release builds; no file access from content; cleartext web traffic off (printers are reached by native sockets, not by the WebView).
- No secrets in the app bundle (only the three public variables); the existing browser-secret scan applies to what is bundled.
- **Session token storage:** the Supabase session persists in the WebView's storage (E4). That is the same as a browser today and is **not** the encrypted queue of D6; hardening it with the platform keystore is a decision for OFF-2.
- **API origin (E5):** the bundled app must be allowed to call the API. Options: add a dedicated shell origin to `CORS_ALLOWED_ORIGINS` (a **production configuration change**, not secret, needs its own authorised window and an API restart; prefer a dedicated host name over the generic `localhost` if the shell framework allows it, to be verified); or route API calls through the shell's native HTTP layer, which is not a browser cross-origin call but changes how requests are sent. **Not decided, not part of Phase W2.**
- **Signing key:** owner-held; never in the repository, CI logs or this chat.
- Printer addresses are device-local; losing a device exposes a LAN address, not credentials. Offline data protection is OFF-2.

## 7. Build, CI and distribution (to decide)
- A CI job with the Android SDK (GitHub's hosted runners are expected to include it; **not verified here**) running the debug build and the plugin's unit tests against a fake socket; **release signing outside CI**.
- New npm dependencies are subject to the existing dependency scan (and its allowlist rules); none is added by this document.
- Distribution of installable builds (internal testing track, device management, or direct install) is the owner's choice (Q4).

## 8. Test plan and acceptance for 8d-2
1. **Without hardware (can be automated):** a local TCP listener captures the bytes the plugin sends and a test checks them against the encoder's output (header, cut, drawer pulse present only for the automatic cash print); timeout and refusal paths return `{ ok: false }`; the web side already proves "no retry through the browser".
2. **With hardware (owner's device):** a real receipt on 80 mm and 58 mm, a kitchen ticket, the drawer kick, Bluetooth and USB if used, a printer powered off (failure message appears, sale unaffected), app killed mid-print (no duplicate on restart).
3. **Static export:** every counter screen loads from the bundled files with the device in airplane mode up to the sign-in screen; deep links to each business tab resolve.
4. **Security checks:** the list in section 6, and the secret scan on the bundle.

## 9. Proposed blocks (each separately authorised; none started)
| Block | Content | Needs |
|---|---|---|
| 8d-2a | **Web static-export readiness** (section 3.1): routing change, guard update, export in CI, tests | owner approval of the guard change; **no** SDK, **no** hardware, **no** migration |
| 8d-2b | Shell project scaffold + network (TCP) printing plugin + CI job | Q1, SDK runner, a printer reachable on a network |
| 8d-2c | Bluetooth / USB printing and the in-shell printer settings screen | hardware |
| 8d-2d | Signing, distribution, device acceptance pass | owner-held key, devices |
| (separate) | API origin / CORS decision for the shell (section 6) | authorised production-configuration window; **not Phase W2** |

## 10. Owner decisions needed (with a recommendation)
| # | Decision | Recommendation |
|---|---|---|
| Q1 | Confirm Capacitor on Android as the shell technology (never confirmed so far) | **Confirm**, subject to a short device spike in 8d-2b; iOS out of scope. |
| Q2 | How the counter reaches the shell: hosted (H-A) or bundled (H-B)? | **H-B (bundled).** It is the only option compatible with offline selling and needs no web host. Authorises 8d-2a. |
| Q3 | API origin for the shell: dedicated CORS origin, or native HTTP layer? | **Dedicated origin** (dedicated host name if possible), set in its own authorised window. |
| Q4 | How builds reach devices (internal track, device management, direct install) | Direct install for the pilot; revisit with more than a few devices. |
| Q5 | Custody of the signing key | Owner-held, offline backup, never shared. |
| Q6 | Pilot hardware: tablet model and printer model(s), and how each printer connects | Name them; the connection type decides whether 8d-2c is needed at all. |
| Q7 | App name and identifier | Owner's choice; none is invented here. |
| Q8 | Android SDK in CI | Use hosted runners if the SDK is present (to be verified in 8d-2b). |

## 11. What was not done and not verified
No shell project, plugin, build file, dependency, CI job, configuration, migration or production change. Not verified: the Capacitor local-server fallback and host-name settings, the availability and quality of any printing plugin, the SDK on hosted runners, any Bluetooth or USB behaviour, and any printer model. The static-export finding (E1) is a real build result; everything marked "to be verified" is to be settled in the first Android build.
