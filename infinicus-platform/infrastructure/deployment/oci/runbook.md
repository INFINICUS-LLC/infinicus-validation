> **Directory name is legacy; this IS the production deployment directory.** Production runs the compose project in this directory on the **Hetzner**
> VM `infinicus-prod-01` (verified 2026-10-12: PostgreSQL 16.15, ledger head 0170). The "oci" name is a leftover from an abandoned Oracle Cloud plan; do not
> rename or move it without a separate, planned change. The Oracle-specific provisioning steps below are historical; for Hetzner provisioning see `../hetzner/runbook.md`.
> Every redeploy must also run `grant-app-role.sh` after the migration gate (see the Hetzner runbook).

# Phase 3 runbook — deploying `apps/api` to an Oracle Cloud Always Free Compute VM

This is a step-by-step guide for **you** to run — nothing in this session
can execute any of it (no OCI credentials or tool access in this
sandbox). Everything in `infrastructure/deployment/oci/` is prepared and
ready; this file just walks through using it.

Target shape: one Always Free **Ampere A1** Compute instance running
Docker, with three containers (Postgres, the API, Caddy for TLS) — this
is the "Compute VM + Docker" option, not OCI's separate Autonomous
Database product.

## 1. Create the instance

In the OCI console: **Compute → Instances → Create Instance**.

- Image: **Ubuntu 22.04 or 24.04** (minimal/aarch64 build for Ampere).
- Shape: **VM.Standard.A1.Flex** — Always Free allows up to 4 OCPUs / 24 GB
  total across A1 instances; 2 OCPUs / 12 GB for this single instance is
  comfortably enough headroom.
- Under **Show Advanced Options → Management**, paste the entire contents
  of `cloud-init.yaml` (this repo) into the **Cloud-init script** box.
- Add your own SSH public key under **Add SSH keys** (do *not* put a
  private key anywhere in cloud-init or this repo).
- Create the instance and note its **public IP**.

## 2. Open the network — two separate firewalls, both required

1. **OCI Security List / Network Security Group** (console-level, in
   front of the VM): add ingress rules for **TCP 80** and **TCP 443**
   from `0.0.0.0/0` (or a tighter range if you want to restrict who can
   reach the API before DNS is set up). This is the OCI-managed
   firewall — `cloud-init.yaml`'s `ufw` rules do **not** substitute for
   this step; both layers block traffic if either is closed.
2. The VM's own `ufw` (opened automatically by `cloud-init.yaml` for
   22/80/443) — no action needed here if step 1 above the cloud-init
   ran successfully; verify with `sudo ufw status` after SSHing in.

## 3. DNS

Point `api.infini-cus.com` (or whatever subdomain you choose — update
`Caddyfile` if different) at the instance's public IP with an **A
record**. Caddy (step 6) needs this to already be resolving before it
can obtain a Let's Encrypt certificate — DNS propagation can take a few
minutes.

## 4. Copy the deployment files and set secrets

SSH in as the `deploy` user cloud-init created:

```bash
ssh deploy@<instance-public-ip>
```

Get this repository onto the VM (either `git clone` the repo, or `scp`
just the `infinicus-platform/` directory — either way, the `api` and
`tools` services in `docker-compose.yml` build from the monorepo root,
so the *whole* `infinicus-platform/` tree needs to be present, not just
the `infrastructure/deployment/oci/` directory):

```bash
sudo -u deploy git clone <your-repo-url> /opt/infinicus/repo
cd /opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci
cp .env.example .env
```

Edit `.env` and fill in real values — at minimum generate real random
passwords for `POSTGRES_ADMIN_PASSWORD` and `POSTGRES_APP_PASSWORD`
(e.g. `openssl rand -base64 24` for each). `RESEND_API_KEY` can stay
blank (verification emails are logged instead of sent — never blocks
signup, see `docs/production-readiness/connect-public-demo-phase1.md`).

## 5. Build images and run migrations

From `infrastructure/deployment/oci/` on the VM:

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
the real smoke-test script from the VM:

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
end-to-end smoke test against the live OCI-hosted backend.

## Ongoing operations

- **Redeploying a new version**: `git pull` (or `git checkout <reviewed SHA>`), **`GIT_SHA=$(git rev-parse HEAD) docker compose build`**,
  `docker compose run --rm tools` (migration gate — safe to run even
  when there's nothing new to migrate), `docker compose run --rm --entrypoint bash tools infrastructure/database/scripts/grant-app-role.sh`
  (required after every migration run, see the Hetzner runbook), then `docker compose up -d`.
  Build **with** `GIT_SHA`: it is what lets `GET /v1/health` report the running commit. (Until S-3 this file's compose definition did not pass the
  build argument at all, so the running API always reported `"unknown"`; it now does, like `../hetzner/docker-compose.yml`.)
- **Verify which commit is running** (do this after every `up -d`): `curl -s https://api.infini-cus.com/v1/health` must show
  `"version":"<the full output of git rev-parse HEAD>"`. `unknown` means the image was built without `GIT_SHA` or a stale container is still running.
  The same check, scripted and failing on a mismatch: `BASE_URL=https://api.infini-cus.com EXPECTED_BUILD_SHA=$(git rev-parse HEAD) infrastructure/deployment/scripts/smoke-test.sh`.
  `deploy.sh` does it automatically for staging and production (and refuses to start from a dirty tracked tree).
- **Logs**: `docker compose logs -f api`.
- **Backups**: `infrastructure/deployment/scripts/` and
  `infrastructure/database/scripts/` already have backup/restore/PITR
  scripts from BUILD-22 — they expect a reachable `DATABASE_URL`/
  `ADMIN_DATABASE_URL`, which on this VM means running them via
  `docker compose run --rm tools` with the appropriate script as the
  entrypoint, same pattern as step 5 above. Set up a cron job on the
  host calling into that pattern if you want scheduled backups — not
  included here since backup *storage* target (where the dump goes) is
  an environment-specific decision this runbook can't make for you.
