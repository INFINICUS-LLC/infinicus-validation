# Runbook — deploying `apps/api` to a Hetzner Cloud server

This is a step-by-step guide for **you** to run — nothing in this session
can execute any of it (no Hetzner account or API token in this sandbox).
Everything in `infrastructure/deployment/hetzner/` is prepared and ready;
this file just walks through using it.

Target shape: one Hetzner Cloud server running Docker, with four
containers (Postgres, the API, a one-off migration/tools container, and
Caddy for TLS) — identical stack to `infrastructure/deployment/oci/`, just
provisioned on Hetzner instead. Use this runbook instead of the OCI one if
you're hosting on Hetzner Cloud (e.g. because OCI registration is blocked).

## 1. Create the server

In the [Hetzner Cloud Console](https://console.hetzner.cloud/): pick or
create a **Project**, then **Add Server**.

- **Location**: whichever region is closest to your users (e.g. Falkenstein
  or Nuremberg for Europe, Ashburn/Hillsboro for the US).
- **Image**: **Ubuntu 24.04** (or 22.04).
- **Type**: a shared-vCPU **CX** or **CPX** plan is plenty for this
  four-container stack — **CX22** (2 vCPU / 4 GB) is a reasonable
  starting point; scale up later if needed, Hetzner resizes are
  non-destructive.
- **Volume**: none needed — Postgres data lives on the server's local
  disk via the compose `postgres-data` volume (see "Backups" below for
  why that's still safe).
- **Networking**: leave public IPv4 enabled (needed for DNS + Let's
  Encrypt). IPv6 is fine to leave on too.
- **SSH keys**: add your public key here — do *not* put a private key
  anywhere in cloud-init or this repo.
- **Cloud config**: paste the entire contents of `cloud-init.yaml` (this
  repo) into the **Cloud config** box under the server creation form's
  advanced options.
- **Firewalls**: you can attach a firewall at creation time or after —
  see step 2 either way.

Create the server and note its **public IPv4 address**.

## 2. Open the network — two separate firewalls, both required

1. **Hetzner Cloud Firewall** (console-level, in front of the server):
   Console → **Firewalls** → Create Firewall. Add inbound rules for
   **TCP 22** (SSH, restrict to your own IP if you want), **TCP 80**, and
   **TCP 443** from `0.0.0.0/0` (and `::/0` for IPv6). Attach the
   firewall to the server (either during creation or via **Firewalls →
   your firewall → Resources → Add server**). This is the
   Hetzner-managed firewall — `cloud-init.yaml`'s `ufw` rules do **not**
   substitute for this step; both layers block traffic if either is
   closed.
2. The server's own `ufw` (opened automatically by `cloud-init.yaml` for
   22/80/443) — no action needed here if step 1 and the cloud-init both
   ran successfully; verify with `sudo ufw status` after SSHing in.

## 3. DNS

Point `api.infini-cus.com` (or whatever subdomain you choose — update
`Caddyfile` if different) at the server's public IPv4 with an **A
record** (and an AAAA record with the IPv6 address if you want IPv6
reachability too). Caddy (step 6) needs this to already be resolving
before it can obtain a Let's Encrypt certificate — DNS propagation can
take a few minutes.

## 4. Copy the deployment files and set secrets

SSH in as the `deploy` user cloud-init created:

```bash
ssh deploy@<server-public-ip>
```

Get this repository onto the server (either `git clone` the repo, or
`scp` just the `infinicus-platform/` directory — either way, the `api`
and `tools` services in `docker-compose.yml` build from the monorepo
root, so the *whole* `infinicus-platform/` tree needs to be present, not
just the `infrastructure/deployment/hetzner/` directory):

```bash
sudo -u deploy git clone <your-repo-url> /opt/infinicus/repo
cd /opt/infinicus/repo/infinicus-platform/infrastructure/deployment/hetzner
cp .env.example .env
```

Edit `.env` and fill in real values — at minimum generate real random
passwords for `POSTGRES_ADMIN_PASSWORD` and `POSTGRES_APP_PASSWORD`
(e.g. `openssl rand -base64 24` for each). `RESEND_API_KEY` can stay
blank (verification emails are logged instead of sent — never blocks
signup, see `docs/production-readiness/connect-public-demo-phase1.md`).

## 5. Build images and run migrations

From `infrastructure/deployment/hetzner/` on the server:

```bash
docker compose build
docker compose up -d postgres
docker compose run --rm tools   # runs migration-gate.sh — must exit 0
docker compose run --rm --entrypoint bash tools \
  infrastructure/database/scripts/grant-app-role.sh
```

The `tools` container's `DATABASE_URL`/`ADMIN_DATABASE_URL` already
point at the `postgres` service by container name — no extra flags
needed for a first-time setup. Both commands must complete successfully
before starting the API (the API will fail its readiness check against
an unmigrated database).

## 6. Start everything

```bash
docker compose up -d
docker compose ps    # postgres and api should show healthy; caddy running
```

Caddy will automatically request a Let's Encrypt certificate for
`api.infini-cus.com` on first request — watch its logs the first time:

```bash
docker compose logs -f caddy
```

## 7. Verify

```bash
curl -s https://api.infini-cus.com/v1/ready | jq .
```

should return a healthy readiness payload (reuses the same `/v1/ready`
endpoint the Dockerfile's own `HEALTHCHECK` and
`infrastructure/deployment/scripts/smoke-test.sh` use). You can also run
the real smoke-test script from the server:

```bash
cd /opt/infinicus/repo/infinicus-platform
BASE_URL=https://api.infini-cus.com bash infrastructure/deployment/scripts/smoke-test.sh
```

## 8. Hand back to Phase 4

Once step 7 passes, the real reachable HTTPS API URL is
`https://api.infini-cus.com`. That's the only input Phase 4 needs — it
updates `index.html`'s `API_BASE_URL` default (or you can set it
immediately via the browser console with
`localStorage.setItem('inf_api_base_url','https://api.infini-cus.com')`
on the live site to test before that edit lands) and does one real,
end-to-end smoke test against the live Hetzner-hosted backend.

## Ongoing operations

- **Redeploying a new version**: `git pull` (or `git checkout <reviewed SHA>`),
  `GIT_SHA=$(git rev-parse HEAD) docker compose build`,
  `docker compose run --rm tools` (migration gate — safe to run even
  when there's nothing new to migrate),
  `docker compose run --rm --entrypoint bash tools infrastructure/database/scripts/grant-app-role.sh`
  (**required after every migration run**: it grants the application role access to new objects and, since migration 0196, withholds direct
  writes of execution-activation rows and the protected reorder columns; it is idempotent and safe to run when nothing changed),
  then `docker compose up -d`. Order matters: migrate, grant, then start the new application.
- **Which version is deployed**: `curl -s https://api.infini-cus.com/v1/health` returns `{"status":"ok","version":"<git commit>"}`
  (`unknown` if the image was built without `GIT_SHA`). Also `git -C /opt/infinicus/repo rev-parse HEAD` and `docker compose images`.
- **Logs**: `docker compose logs -f api`.
- **Backups**: `infrastructure/deployment/scripts/` and
  `infrastructure/database/scripts/` already have backup/restore/PITR
  scripts from BUILD-22 — they expect a reachable `DATABASE_URL`/
  `ADMIN_DATABASE_URL`, which on this server means running them via
  `docker compose run --rm tools` with the appropriate script as the
  entrypoint, same pattern as step 5 above. Set up a cron job on the
  host calling into that pattern if you want scheduled backups. Two
  options for where the dump goes: a Hetzner Storage Box (cheap, same
  provider) or any S3-compatible target — neither is wired up here since
  it's an environment-specific decision this runbook can't make for you.
- **Resizing**: Hetzner Cloud servers can be resized (more vCPU/RAM)
  non-destructively from the console with a brief reboot — no need to
  recreate the server or re-run this runbook if the CX22 starting point
  turns out to be too small.

## Differences from the OCI runbook

If you previously attempted the `infrastructure/deployment/oci/` runbook:
the containers, `Caddyfile`, `.env.example`, and `postgres-init/` script
here are identical — only the surrounding provider steps (server
creation console, firewall mechanism) differ. There is no data to migrate
between the two unless you had already gotten an OCI instance running
and populated with real data, in which case use
`infrastructure/database/scripts/backup.sh` against the OCI instance and
`restore.sh` against this new Hetzner one.
