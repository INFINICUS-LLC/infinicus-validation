#!/usr/bin/env bash
# AUTH-LOCKOUT-1.RP-14B — owner-run exposure assessment pack. READ-ONLY: it changes nothing and prints NO secret value
# (variable names with SAME / DIFFERENT / only-in-... , file metadata, counts, yes/no). Run on infinicus-prod-01 as the deploy user:
#   bash rp14b-owner-pack.sh 2>&1 | tee "rp14b-$(date -u +%Y%m%dT%H%M%SZ).txt"
set -u
IMG="${IMG:-oci-api:rollback-20261014}"
CUR_ENV="${CUR_ENV:-/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env}"
BACKUPS="${BACKUPS:-/opt/infinicus/repo/infinicus-platform/infrastructure/deployment/oci/.env.backup-before-preview-cors /home/deploy/infinicus-oci-env-backup-20261014T185738Z}"
OTHER_IMAGES="${OTHER_IMAGES:-oci-api:latest infinicus-api:rollback-pre-0202 infinicus-api:candidate-20261014}"
HOME_DIR="${HOME_DIR:-$HOME}"
sec() { printf '\n===== %s =====\n' "$1"; }
sec "0 WHEN / WHO"; date -u +%Y-%m-%dT%H:%M:%SZ; id -un
sec "A IMAGE PROVENANCE (metadata only)"
docker image inspect "$IMG" --format 'id={{.Id}} created={{.Created}} tags={{json .RepoTags}} repoDigests={{json .RepoDigests}} lastTagTime={{.Metadata.LastTagTime}}' 2>&1
echo "--- env variable NAMES baked into the image configuration (values not printed)"
docker image inspect "$IMG" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>&1 | cut -d= -f1
echo "--- registries with a stored login (names only)"
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.docker/config.json")
d = json.load(open(p)) if os.path.exists(p) else {}
print(sorted((d.get("auths") or {}).keys()) or "none")
print("credsStore:", d.get("credsStore", "none"), "| credHelpers:", sorted((d.get("credHelpers") or {}).keys()) or "none")
PY
echo "--- shell history: counts only (lines are not printed)"
for pat in 'docker +push' 'docker +save' 'docker +export' 'docker +login' 'docker +image +save' 'scp .*oci-image' 'rclone .*(copy|sync)'; do
  if [ -r "$HOME_DIR/.bash_history" ]; then c=$(grep -c -E "$pat" "$HOME_DIR/.bash_history" 2>/dev/null); else c=n/a; fi
  printf '%-28s %s\n' "$pat" "${c:-0}"; done
echo "--- image or tar archives over 50 MB in home, /tmp, /var/tmp (metadata)"
find "$HOME_DIR" /tmp /var/tmp -maxdepth 3 \( -name '*.tar' -o -name '*.tar.gz' -o -name '*.tgz' \) -size +50M -printf '%TY-%Tm-%Td %s %p\n' 2>/dev/null
echo "--- containers using the image"
docker ps -a --filter "ancestor=$IMG" --format '{{.Names}} {{.Status}}'
sec "B SENSITIVE FILES IN IMAGES (paths only)"
for i in "$IMG" $OTHER_IMAGES; do
  echo "--- $i"
  docker run --rm --network none --no-healthcheck --entrypoint sh "$i" -c \
    'find /repo -maxdepth 6 \( -name ".env" -o -name ".env.*" -o -name "*.env" -o -name "*env-backup*" -o -name "*.pem" -o -name "*.key" \) -not -path "*/node_modules/*" 2>/dev/null | sort; echo "(search done)"' 2>&1 | head -20
done
sec "C CREDENTIAL EQUALITY: image .env vs current .env, and each env backup vs current (names and SAME/DIFFERENT only)"
python3 - "$IMG" "$CUR_ENV" $BACKUPS <<'PY'
import re, subprocess, sys
img, cur_path, *files = sys.argv[1:]
def parse(t):
    d = {}
    for l in t.splitlines():
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', l)
        if m: d[m.group(1)] = m.group(2)
    return d
def compare(label, old, cur):
    print(f"--- {label}: {len(old)} variables")
    for k in sorted(set(old) | set(cur)):
        st = "only-in-current" if k not in old else "only-in-this-file" if k not in cur else ("SAME" if old[k] == cur[k] else "DIFFERENT")
        print(f"   {k:36s} {st}")
cur = parse(open(cur_path).read())
r = subprocess.run(['docker','run','--rm','--network','none','--no-healthcheck','--entrypoint','cat',img,'/repo/infrastructure/deployment/oci/.env'], capture_output=True, text=True)
compare("image " + img, parse(r.stdout) if r.returncode == 0 else {}, cur)
if r.returncode != 0: print("   (no .env readable in the image)")
for f in files:
    try: compare(f, parse(open(f).read()), cur)
    except Exception as e: print(f"--- {f}: not readable ({type(e).__name__})")
PY
sec "D PERMISSIONS, OWNERS AND LOCAL ACCESS"
for f in $CUR_ENV $BACKUPS; do stat -c '%A %U:%G %s bytes mtime=%y %n' "$f" 2>&1; done
echo "--- groups of the deploy user / members of its primary group"
id deploy; getent group deploy
echo "--- interactive accounts on the host (names only)"
getent passwd | awk -F: '$3>=1000 && $7!~/(nologin|false)$/ {print $1" uid="$3" shell="$7}'
echo "--- other readable-by-all env-like files under /opt/infinicus and the home directory (metadata only)"
find /opt/infinicus "$HOME_DIR" -maxdepth 6 \( -name '.env*' -o -name '*env-backup*' \) -not -name '.env.example' -not -path '*/node_modules/*' -perm /o+r -printf '%M %u:%g %p\n' 2>/dev/null
echo "--- can file reads be established historically? (auditd) "; systemctl is-active auditd 2>&1 | head -1
echo "--- accepted SSH logins in the retained auth log: counts per user (no addresses printed)"
{ zcat -f /var/log/auth.log* 2>/dev/null | grep -E 'sshd.*Accepted' | sed -E 's/.*Accepted [a-z]+ for ([^ ]+) from.*/\1/' | sort | uniq -c; } 2>&1 | head -10
sec "END"; date -u +%Y-%m-%dT%H:%M:%SZ
