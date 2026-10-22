# SPEC OFF-2 — Native encrypted offline storage (Capacitor / Android)

| Field | Value |
|---|---|
| Date | 2026-10-22 |
| Status | **SPECIFICATION ONLY. OFF-2 is not started.** No code, dependency, manifest, plugin, CI or production change. Each block below needs its own owner authorization. |
| Builds on | Decision record D1, D5, D6, D7; OFF-1 (server side, merged, disabled); POS-8d-1 (`window.InfinicusDevice` v1); POS-8d-2a/2b (static export, Capacitor 8 Android shell) |
| Not in OFF-2 | The selling interface and provisional receipts (OFF-3); the exceptions screens (OFF-4); hardening and monitoring (OFF-5); iOS; card tenders offline (D5); any server migration |
| Verified from the repository | Shell: `apps/device-shell` (Capacitor 8.5.x, `minSdk 24`, `compileSdk 36`, WebView origin `https://localhost`, `allowBackup=false`, cleartext off, WebView debugging off, bridge via `WebViewCompat.addWebMessageListener`, plain-Java `core` module with JUnit). Printer address already lives in app-private SharedPreferences. |
| Not verified | Any Android library version or availability (Google Maven is blocked in the working sandbox), SQLCipher licensing/size, behaviour on the pilot tablet, Keystore/StrongBox support on the pilot hardware. |

## 1. Goals and non-goals
Goals: durably store a catalogue snapshot and a queue of cash sale intents on the device, encrypted at rest, isolated per tenant/workspace/business and per device; keep the queue safe across crashes, power loss, logout, revocation and device loss; expose it to the counter through a narrow bridge contract; leave the server as the only authority.
Non-goals: computing authoritative totals, holding the session token or any identity in the shell (existing shell rule), storing card data, passwords, tokens or customer personal data, any web-side persistent storage (NA-04 and D6 stay).

## 2. Storage architecture
- **Engine (recommended):** SQLite encrypted with SQLCipher for Android, opened by a native Java class in the shell. Alternative considered: a Room database over a file encrypted with AES-GCM per record. SQLCipher is preferred for authenticated page-level encryption and transactional durability; availability and licensing must be verified at build time. *Not* acceptable: Capacitor Preferences, WebView localStorage/IndexedDB, plain SharedPreferences (all contradict D6/NA-04 or lack encryption).
- **Key hierarchy:** (1) a non-exportable **AES-256-GCM key in Android Keystore** (StrongBox-backed where the device offers it, TEE otherwise) wraps (2) a random 256-bit **database key** generated on first run with `SecureRandom`. The wrapped key is stored in app-private storage; the plaintext database key exists only in memory while the shell is unlocked. The Keystore key is *not* bound to biometric enrolment, so adding a fingerprint cannot destroy the queue (`KeyPermanentlyInvalidatedException` avoided); the lock is a separate PIN gate (section 5).
- **Isolation:** one encrypted database file **per scope** (tenant, workspace, business), named by a hash of the scope, each with its **own** database key wrapped by the Keystore key. Every store call carries the scope triple; a call whose scope differs from the unlocked scope is refused. A queue is never readable under another scope. The server re-verifies scope on every sync (OFF-1), as the final control.
- **Location and exposure:** `Context.getNoBackupFilesDir()`-style app-private storage; `allowBackup=false` (already set); no `FileProvider` path to the database; WebView file access stays off; the database is never reachable through an intent or exported component.
- **Release builds:** debuggable false, WebView debugging off (already), `FLAG_SECURE` on the PIN screen, no logging of ids, amounts or contents.

## 3. Data model (inside each scope database)
| Table | Contents |
|---|---|
| `meta` | schema version, device id (random UUID, generated once), monotonic `device_seq`, last server contact (server time and `elapsedRealtime`), lock state, failed-PIN counter |
| `catalogue_snapshot` | business id, currency code and exponent, **`snapshot_at` issued by the server**, register session id the device was opened against |
| `catalogue_item` | product id, name, unit price in **minor units** (integer), active flag |
| `sale_intent` | `client_sale_id` (UUIDv4, primary key and idempotency identity), device id, scope, `cashier_user_id`, register session id, `device_created_at`, `elapsed_since_snapshot_ms`, currency, lines (`product_id`, `quantity`, `unit_price_shown_minor`), `provisional_total_minor`, tenders (cash only, minor units), catalogue `snapshot_at`, `status`, `attempt_count`, `last_attempt_at`, `server_response` (outcome, order id/number, difference, review reason), `queued_seq` |
| `status` values | `queued`, `sending`, `synced` (accepted or accepted_with_difference), `needs_review` (server kept it for review), `rejected_at_door` (HTTP 400: kept for manual handling), `held` (401/403/404/503: waiting for a condition), `conflict` (HTTP 409) |
Field names and bounds mirror the merged OFF-1 request (`clientSaleId`, `deviceId`, `registerSessionId`, `deviceCreatedAt`, `catalogueSnapshotAt`, `currencyCode`, `lines`, `provisionalTotalMinor`, `tenders`; at most 100 lines, 10 tenders; quantity bound; ISO date-times with offset). The intent stores integer minor units only.

## 4. Catalogue snapshot
- Taken from the authenticated catalogue read plus the business currency declaration and the open register session, **while online**. Replaced atomically (one transaction); a failed refresh keeps the previous snapshot.
- **Finding F-B:** the server compares `products.updated_at` with the intent's `catalogue_snapshot_at` to decide whether a price drift is honourable. That time must be **issued by the server** (a response field or the HTTP `Date` header of the catalogue read), never the device clock; otherwise a device clock error silently changes drift decisions. If no server-issued time is available from the existing read, a minimal API addition is a **prerequisite of OFF-3**, not of OFF-2's storage code.
- Stored size is bounded (item count and bytes); a larger catalogue is refused with a clear error, not truncated silently.

## 5. PIN / device-lock requirements
- Offline mode may only be enabled if the device has a secure lock screen (`KeyguardManager.isDeviceSecure()`); otherwise the shell refuses to create the store.
- A **shell PIN** unlocks the store. The database keys are decrypted into memory only after a correct PIN; the PIN is never stored. A salted, slow key-derivation function (PBKDF2, scrypt or Argon2, whichever the build supports) turns the PIN into a key that unwraps each database key, so the database key is unavailable without the PIN even though the Keystore key is non-biometric. The PIN check is constant-time.
- **Owner decisions needed (no values invented):** PIN length; inactivity lock timeout; failed-attempt thresholds; whether biometric unlock is allowed. *Proposal for discussion only:* 6 digits; re-lock after 5 minutes idle and whenever the app leaves the foreground; exponential back-off after 5 failures.
- **No automatic wipe on failed attempts.** Queued sales are financial records for cash already taken; a wrong-PIN storm must lock, not destroy. After a threshold the shell requires an online re-authentication by an owner/admin before another attempt.
- **Foreground-only sync (recommended):** synchronization runs only while the shell is unlocked and the cashier has a live session. A background `WorkManager` sync would need the database key available without the PIN, which weakens the lock. If the owner wants background sync it is a separate decision with a separate key.

## 6. Logout, revocation, device loss
| Event | Behaviour |
|---|---|
| Cashier logs out with `queued`/`sending`/`held` intents | The shell warns ("N unsent sales"), offers sync now. If the cashier proceeds, the queue **stays encrypted and scope-bound**; it is not readable by another user or scope and is resumed after the original scope signs in again. It is **not wiped** (cash was taken). |
| All intents `synced` or reviewed by the server | Synced rows are purged after the server acknowledgement is stored, keeping only the offline-number to real-number mapping needed for reprints, for a retention period the owner sets. |
| Session expired (default server session lifetime is 24 hours, same as the offline limit) | Queue waits; UI shows "sign in to send N sales" (design 5.5). A sale older than 24 hours at the time of sync is refused at the door (HTTP 400) and kept as `rejected_at_door` for manual handling. |
| User/session revoked server-side | Sync receives 401/403 and the intents become `held`; nothing is deleted. |
| Device lost or stolen | Data at rest is encrypted and PIN-gated. The owner revokes the user's sessions (server side) so a thief cannot sync. **Unsent sales are lost with the device** (record the cash on paper, per the memo). Remote wipe is impossible while offline. The queue holds no card data, passwords or tokens. |
| Uninstall / data cleared | Keys and queue are destroyed together; documented as loss of unsent sales. |
| Key unusable (Keystore reset, corrupted wrapped key) | Detect on open, move the files to a quarantine location, record an event, show a recovery message. Never silently create a new empty store over a damaged one. |
**Gap (F-D):** there is no server-side device identity or registration; `deviceId` is a client-chosen string, so "revoke the device" currently means revoking the **user's sessions**. A device registry with explicit revocation is a possible OFF-5 item and would need a server migration.

## 7. Queue durability and synchronization contracts
**Durability rules**
1. A sale intent is written in **one transaction** (`PRAGMA synchronous=FULL`, WAL, journal checkpoints) **before** the counter shows "sale complete" or prints the provisional receipt. A crash can lose an unconfirmed screen, never a completed sale.
2. `device_seq` is incremented in the same transaction; the temporary number `OFF-<device>-<seq>` is derived from it and never reused.
3. A row is deleted only after the server answer is stored and the retention rule allows it. `sending` rows found at start-up return to `queued` (safe: the Idempotency-Key equals `client_sale_id`).
4. Limits enforced in the shell: at most **100** queued intents (D3); refuse a new sale above it with a clear message; warn when the oldest intent is near the 24 h limit; stop offering offline selling when the oldest queued intent would exceed it. Refuse new sales when free storage is below a threshold.

**Bridge contract v2 (proposal).** `window.InfinicusDevice.version === 2`, frozen, installed at document start for origin `https://localhost` only (as v1). v1 `printEscPos` is unchanged. A `store` namespace with narrow, scope-checked methods, all returning `{ok, error?, ...}` and settling within a bound: `unlockStatus()`, `unlock(pin)`, `lock()`, `putCatalogue(scope, snapshot)`, `getCatalogue(scope)`, `enqueueSale(scope, intent)`, `nextToSend(scope)`, `markSending(scope, id)`, `recordResult(scope, id, httpStatus, body)`, `counts(scope)`, `purgeSynced(scope)`. No raw SQL, no bulk export, no listing across scopes, strict JSON schema and size limits on every call, rate limiting.
**Sync loop (page-driven, shell holds no token).** The page takes `nextToSend`, calls `markSending`, POSTs `/v1/businesses/:id/offline-sales` with `Idempotency-Key = clientSaleId`, then calls `recordResult`. Result mapping:
| Server answer | Intent status |
|---|---|
| 201/200 `accepted` or `accepted_with_difference` | `synced` (store order id and number) |
| 201/200 `needs_review` | `needs_review` (kept; no order exists) |
| 400 validation (too old, bad total, clock ahead, non-cash) | `rejected_at_door` (**kept**, F-2: the server stored nothing) |
| 401 | `held` until sign-in |
| 403 / 404 | `held` (scope or permission problem; alert) |
| 409 (same id, different body) | `conflict` (quarantine, alert; should never happen) |
| 503 (offline selling not enabled) | `held` |
| network error / 5xx | stays `queued`, retry with back-off and the **same** key |
Replaying is always safe (OFF-1 returns the first answer).
**Finding F-3 / owner decision:** the server attributes a synced sale to the **syncing** session's user; the request has no cashier field. Either (a) the shell only lets the original cashier sync their own intents, or (b) the owner accepts attribution to the syncing user, or (c) a later OFF-1 addendum adds a validated cashier field. Recommended: (a) in OFF-2 and (c) considered in OFF-5.

## 8. Clock handling (device side)
- Record, at every online contact, the server time (HTTP `Date`) and `SystemClock.elapsedRealtime()`; store an estimated offset in `meta` and in each intent (`elapsed_since_snapshot_ms`). Elapsed time is monotonic and unaffected by manual clock changes.
- The shell stops offering offline selling when `elapsedRealtime` since the last server contact approaches the 24 h limit, regardless of the wall clock.
- The wall-clock `device_created_at` is still sent (the server records it with `received_at` and flags skew); the server's tolerance bound is an owner decision (see the completion report).

## 9. Security tests and fault injection (acceptance for OFF-2)
Unit (plain-Java `core` module, no Android needed): queue state machine and transitions; scope isolation; limits; JSON schema/size bounds; result mapping; migration of the local schema; PIN throttling logic with a fake clock.
Instrumented on an emulator/tablet (hardware pending): Keystore key creation and non-exportability; database file unreadable without the key (open with wrong key fails; strings search of the file finds no plaintext product names or amounts); StrongBox and TEE fallback; key invalidation handling; encryption of WAL/journal files.
Fault injection: kill the process before commit, after commit before UI, mid-`sending`, mid-snapshot swap; battery pull (SIGKILL loop); full disk; corrupt page; truncated WAL; clock set backwards/forwards; duplicate delivery; two rapid `enqueueSale` calls; session expiry mid-queue; logout with unsent sales; scope switch; replay of an old `recordResult`; oversize/invalid bridge payloads; calls from a non-allowed origin or sub-frame; attempts to read another scope; adb backup and `run-as` on a release build; screenshots of the PIN screen; log inspection for leaked ids and amounts.
Static guards (extend `shell-guards.test.ts`): no exported components beyond the launcher, no `allowBackup`, no cleartext, no debugging, no network permission use by the store, no SharedPreferences use for queue data, no secrets in the repository.
Property test (cross-stack): provisional totals from the shared exact-math library equal the server's recomputation for random carts in KWD/USD/JPY (belongs with OFF-3, run against OFF-1).

## 10. Dependencies on the existing shell and open prerequisites
- Extends `ShellDeviceBridge`, `infinicus-device-shim.js` (v1 stays), `MainActivity`; adds a store class beside `ShellSettings`; adds SQLCipher and a Keystore wrapper (library versions **not verified**; Gradle resolution needs Google/Maven Central access in CI).
- CI: `device-shell.yml` already builds `assembleDebug` and runs core JUnit; instrumented tests need an emulator or a device farm; hardware acceptance needs the pilot tablet (decision Q6).
- Still open from POS-8d-2: Q3 API origin/CORS for `https://localhost` (production configuration), Q4 distribution, Q5 signing-key custody, Q7 final app id (`com.infinicus.counter` is provisional).
- Supabase session persistence in the WebView (PREP-POS-8D2 finding E4) is outside the encrypted queue; hardening it with the Keystore is an OFF-2/OFF-5 decision.

## 11. Proposed block plan (each separately authorized; none started)
| Block | Content |
|---|---|
| OFF-2a | `core` module: queue state machine, scope isolation, schema, limits, result mapping, with JUnit and mutation checks (no Android dependency) |
| OFF-2b | Encrypted store: SQLCipher + Keystore key wrapping, quarantine, instrumented tests |
| OFF-2c | Bridge contract v2 + shim + guards + web-side typed client (no UI) |
| OFF-2d | PIN/lock, logout, revocation and loss behaviour |
| OFF-2e | Fault-injection suite and hardware acceptance on the pilot tablet |

## 12. Owner decisions needed before OFF-2a
1. Confirm Capacitor/Android as the shell (never formally confirmed; Q1).
2. PIN length, idle timeout, lockout thresholds, biometric allowed or not; foreground-only sync (recommended).
3. Cashier attribution on sync (7, F-3).
4. Retention of the offline-to-real number mapping after sync.
5. Whether a minimal server addition for a server-issued catalogue time (F-B) is authorized as part of OFF-3 prerequisites.
6. Pilot hardware and a signing-key custody plan (Q5, Q6).
