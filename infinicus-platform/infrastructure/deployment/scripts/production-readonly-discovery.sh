#!/usr/bin/env bash
# Production runtime discovery - STRICTLY READ-ONLY operator script (Hetzner / Docker Compose).
#
# Collects the runtime facts needed before a controlled migration: server and Docker identity, deployed build, PostgreSQL version, migration
# ledger, schema fingerprint, roles and privileges, row counts, background jobs, backups, disk and health. It changes nothing.
#
# Read-only guarantees (enforced by packages/event-worker/tests/productionDiscoveryScript.architecture.test.ts):
#   * every SQL statement is a SELECT / SHOW, sent through a session forced read-only (default_transaction_read_only=on) with a statement timeout;
#   * no INSERT / UPDATE / DELETE / TRUNCATE / DDL / GRANT / migration / backup / restart / build / pull / worker start;
#   * no secret is ever printed: `docker compose config` and bare `docker inspect` (both can print passwords) are not used; container environment is
#     reduced to VARIABLE NAMES inside a pipe; connection strings are reduced to the USER name only (and only when the pattern matches).
#
# Usage (on the Hetzner VM, as the deploy user, from infrastructure/deployment/hetzner/ - the directory that holds docker-compose.yml and .env):
#   bash /path/to/production-readonly-discovery.sh 2>&1 | tee "discovery-$(date -u +%Y%m%dT%H%M%SZ).txt"
# Review the script before running it. Send back the complete output file. It contains no passwords, tokens or connection strings.
#
# Environment (all optional):
#   COMPOSE_DIR      directory with docker-compose.yml (default: current directory)
#   REPO_DIR         the repository checkout used for the build (default: /opt/infinicus/repo)
#   DB_SERVICE       compose service name of PostgreSQL (default: postgres)
#   DB_NAME / DB_ADMIN_USER   (defaults: infinicus / admin_role; the image's local socket is trust-authenticated, so no password is needed)
#   APP_ROLE         the least-privilege runtime role (default: app_role)
#   INFINICUS_DISCOVERY_PSQL  test hook: a complete psql command line (e.g. "psql -h localhost -U x -d y") used instead of docker compose exec.
#   INFINICUS_DISCOVERY_ONLY  test hook: "fingerprint" runs only the schema-fingerprint section (no docker, no host commands).

set -u
set -o pipefail

COMPOSE_DIR="${COMPOSE_DIR:-$PWD}"
REPO_DIR="${REPO_DIR:-/opt/infinicus/repo}"
DB_SERVICE="${DB_SERVICE:-postgres}"
DB_NAME="${DB_NAME:-infinicus}"
DB_ADMIN_USER="${DB_ADMIN_USER:-admin_role}"
APP_ROLE="${APP_ROLE:-app_role}"

# Reference fingerprints (SHA-256 prefix of the schema + function fingerprint output) of the repository built from CLEAN migrations on PostgreSQL 16 at the
# given migration head (docs/architecture/reconciliation/production-discovery/). 0170 is the verified live production head.
REF_0169_PG16="31a2177a6b48b2af"
REF_0170_PG16="38eabb12fde135b5"
REF_0198_PG16="7fd4c419d738de8a"
REF_0199_PG16="fcad5f9bfb827028"
REF_0200_PG16="44b7dd1cc29d81bd"
REF_0201_PG16="61ef99d74289c3b3"
REF_0202_PG16="670efa2071aece99"
REF_0203_PG16="4754f82304066378"
REF_0204_PG16="e63dc272f3feb3cc"
REF_0205_PG16="b1f501d79c6fd600"
REF_0206_PG16="c0b9988865306004"
REF_0207_PG16="bbd6bd1f31ad9ea9"
REF_0208_PG16="c2daa833c2f83c70"

section() { printf '\n===== %s =====\n' "$1"; }
run() { # run <label> <command...> : print the command's output, never abort
  printf -- '--- %s\n' "$1"; shift
  "$@" 2>&1 || printf '(command failed or not permitted: exit %s)\n' "$?"
}

# --- SQL transport: always a read-only session. -------------------------------------------------------------------------------------------------
READONLY_OPTS='-c default_transaction_read_only=on -c statement_timeout=20000 -c idle_in_transaction_session_timeout=30000'
sql() { # sql  (reads SQL text on stdin; prints unaligned rows; pipe-separated)
  if [[ -n "${INFINICUS_DISCOVERY_PSQL:-}" ]]; then
    PGOPTIONS="$READONLY_OPTS" ${INFINICUS_DISCOVERY_PSQL} -X -At -F'|' -v ON_ERROR_STOP=0
  else
    (cd "$COMPOSE_DIR" && docker compose exec -T -e PGOPTIONS="$READONLY_OPTS" "$DB_SERVICE" psql -U "$DB_ADMIN_USER" -d "$DB_NAME" -X -At -F'|' -v ON_ERROR_STOP=0)
  fi
}
q() { # q <label> <sql>
  printf -- '--- %s\n' "$1"; printf '%s\n' "$2" | sql 2>&1 || printf '(sql failed)\n'
}

printf 'INFINICUS production runtime discovery (read-only) - %s UTC\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ "${INFINICUS_DISCOVERY_ONLY:-}" != fingerprint ]]; then
section '1 SERVER'
run hostname hostname
run os 'cat' /etc/os-release
run kernel uname -srm
run uptime uptime
run cpus nproc
run memory free -m
run disk-usage df -h
run inodes df -i /
run time-sync timedatectl show -p NTPSynchronized -p Timezone
# Hetzner link-local metadata service (read-only, no token): identity of the server. User-data and keys are deliberately NOT read.
for p in hostname instance-id region availability-zone public-ipv4; do
  printf -- '--- hetzner-metadata/%s: ' "$p"; curl -fsS --max-time 3 "http://169.254.169.254/hetzner/v1/metadata/$p" 2>&1 || printf '(unavailable)'; printf '\n'
done
run firewall-ufw sudo -n ufw status

section '2 DOCKER / COMPOSE'
run docker-version docker --version
run compose-version docker compose version
run compose-projects docker compose ls
run containers docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.RunningFor}}\t{{.Ports}}'
run compose-services-all bash -c "cd '$COMPOSE_DIR' && docker compose config --services"
run compose-services-running bash -c "cd '$COMPOSE_DIR' && docker compose ps --format 'table {{.Name}}\t{{.Service}}\t{{.State}}\t{{.Health}}'"
run compose-images bash -c "cd '$COMPOSE_DIR' && docker compose images"
# Specific fields only (never the Env block): restarts, OOM, image id, start time.
run container-health docker inspect -f '{{.Name}} image={{.Image}} status={{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}}' $(docker ps -aq)
run image-labels bash -c "docker images --digests --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Digest}} {{.CreatedSince}}'"
run docker-volumes docker volume ls
run docker-disk docker system df
run docker-stats docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.PIDs}}'
run event-worker-present bash -c "docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' | grep -i -E 'event-worker|worker' || echo 'no worker container found'"
run kernel-oom bash -c "journalctl -k --since '30 days ago' --no-pager 2>/dev/null | grep -i -E 'out of memory|oom-kill' | tail -5 || true"

section '3 DEPLOYED BUILD'
run repo-head git --no-optional-locks -C "$REPO_DIR" rev-parse HEAD
run repo-branch git --no-optional-locks -C "$REPO_DIR" rev-parse --abbrev-ref HEAD
run repo-last-commit git --no-optional-locks -C "$REPO_DIR" log -1 --format='%H %cI %s'
run repo-dirty git --no-optional-locks -C "$REPO_DIR" status --porcelain
# User name only, and only when the pattern matches (sed -n ... p): the password and host are never printed.
for svc in api event-worker; do
  run "db-user-in-$svc-DATABASE_URL" bash -c "cd '$COMPOSE_DIR' && docker compose exec -T $svc sh -c 'echo \"\$DATABASE_URL\"' 2>/dev/null | sed -nE 's#^[a-z]+://([^:/@]+).*#\\1#p'"
done
run api-ready bash -c "cd '$COMPOSE_DIR' && docker compose exec -T api wget -qO- http://localhost:3000/v1/ready"
run api-health bash -c "cd '$COMPOSE_DIR' && docker compose exec -T api wget -qO- http://localhost:3000/v1/health"

section '4 POSTGRESQL'
q server "select version(), current_database(), current_user, inet_server_port(), now(), pg_postmaster_start_time()"
q size "select pg_size_pretty(pg_database_size(current_database())), pg_database_size(current_database())"
q connections "select (select setting from pg_settings where name='max_connections') max_connections, (select count(*) from pg_stat_activity) in_use"
q sessions-by-role "select usename, application_name, state, count(*), max(backend_start) from pg_stat_activity where datname = current_database() group by 1,2,3 order by 4 desc"
q settings "select name, setting from pg_settings where name in ('archive_mode','archive_command','wal_level','shared_buffers','max_wal_size','data_directory','ssl','password_encryption','log_statement','log_min_duration_statement','listen_addresses') order by 1"
q data-dir-volume "select pg_size_pretty(sum(pg_total_relation_size(c.oid))) all_relations from pg_class c where c.relkind in ('r','i','t','m')"
q largest-relations "select n.nspname||'.'||c.relname rel, c.relkind, pg_size_pretty(pg_total_relation_size(c.oid)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','m') and n.nspname not in ('pg_catalog','information_schema') order by pg_total_relation_size(c.oid) desc limit 15"
q wal-archiver "select archived_count, last_archived_time, failed_count, last_failed_time from pg_stat_archiver"

section '5 MIGRATION LEDGER'
q ledger-summary "select count(*) rows, count(distinct filename) distinct_names, min(filename) first, max(filename) head from public._migrations"
q ledger-names "select string_agg(filename, ',' order by filename) from public._migrations"
q ledger-acl "select c.relowner::regrole owner, c.relrowsecurity rls, c.relforcerowsecurity force_rls, c.relacl::text from pg_class c where c.oid = 'public._migrations'::regclass"

fi # INFINICUS_DISCOVERY_ONLY=fingerprint (test hook) skips sections 1-5

section '6 SCHEMA FINGERPRINT'
FP_SQL=$(cat <<'SQL'
with s as (select nspname from pg_namespace where nspname in ('ai_decision_intelligence','api','approved_business_action','audit','billing','business_digital_twin','business_intelligence','business_operations','continuous_learning','data_acquisition','events','files','identity','observability','onboarding','outcome_monitoring','platform','simulation','tenancy','public'))
select sch, kind, count(*) n, md5(string_agg(txt, '|' order by txt)) h from (
 select n.nspname sch, 'columns' kind, c.relname||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||':'||a.attgenerated::text txt
   from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where n.nspname in (select nspname from s) and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
 union all select n.nspname, 'constraints', c.relname||'.'||co.conname||':'||pg_get_constraintdef(co.oid) from pg_constraint co join pg_class c on c.oid=co.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in (select nspname from s)
 union all select schemaname, 'indexes', tablename||'.'||indexname||':'||indexdef from pg_indexes where schemaname in (select nspname from s)
 union all select n.nspname, 'triggers', c.relname||'.'||t.tgname||':'||pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in (select nspname from s)
 union all select n.nspname, 'functions', p.proname||'('||pg_get_function_identity_arguments(p.oid)||'):'||p.prosecdef||':'||md5(p.prosrc)||':'||coalesce(p.proconfig::text,'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in (select nspname from s) and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
 union all select n.nspname, 'rls', c.relname||':'||c.relrowsecurity||':'||c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in (select nspname from s)
 union all select schemaname, 'policies', tablename||'.'||policyname||':'||cmd||':'||coalesce(qual,'')||':'||coalesce(with_check,'')||':'||roles::text from pg_policies where schemaname in (select nspname from s)
) x group by 1,2 order by 1,2
SQL
)
FN_SQL=$(cat <<'SQL'
select n.nspname sch, count(*) n, md5(string_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||'):'||p.prosecdef, '|' order by p.proname||'('||pg_get_function_identity_arguments(p.oid)||')')) sig_h, md5(string_agg(md5(regexp_replace(p.prosrc,'\s+','','g')), '|' order by p.proname||'('||pg_get_function_identity_arguments(p.oid)||')')) src_h, md5(string_agg(coalesce(p.proconfig::text,''), '|' order by p.proname||'('||pg_get_function_identity_arguments(p.oid)||')')) cfg_h
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('ai_decision_intelligence','approved_business_action','billing','business_digital_twin','business_intelligence','business_operations','continuous_learning','data_acquisition','onboarding','outcome_monitoring','platform','simulation')
 and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e') group by 1 order by 1
SQL
)
FP_OUT="$(printf '%s\n' "$FP_SQL" | sql 2>&1)"
FN_OUT="$(printf '%s\n' "$FN_SQL" | sql 2>&1)"
FP_HASH="$(printf '%s\n%s\n' "$FP_OUT" "$FN_OUT" | sha256sum | cut -c1-16)"
printf 'fingerprint-groups=%s function-groups=%s combined-sha256-16=%s\n' "$(printf '%s\n' "$FP_OUT" | grep -c .)" "$(printf '%s\n' "$FN_OUT" | grep -c .)" "$FP_HASH"
if [[ "$FP_HASH" == "$REF_0208_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0208_PG16'
elif [[ "$FP_HASH" == "$REF_0207_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0207_PG16'
elif [[ "$FP_HASH" == "$REF_0206_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0206_PG16'
elif [[ "$FP_HASH" == "$REF_0205_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0205_PG16'
elif [[ "$FP_HASH" == "$REF_0204_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0204_PG16'
elif [[ "$FP_HASH" == "$REF_0203_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0203_PG16'
elif [[ "$FP_HASH" == "$REF_0202_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0202_PG16'
elif [[ "$FP_HASH" == "$REF_0201_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0201_PG16'
elif [[ "$FP_HASH" == "$REF_0200_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0200_PG16'
elif [[ "$FP_HASH" == "$REF_0199_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0199_PG16'
elif [[ "$FP_HASH" == "$REF_0198_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0198_PG16'
elif [[ "$FP_HASH" == "$REF_0170_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0170_PG16'
elif [[ "$FP_HASH" == "$REF_0169_PG16" ]]; then echo 'fingerprint-verdict=MATCHES_REPOSITORY_0169_PG16'
else echo 'fingerprint-verdict=NO_REFERENCE_MATCH (send the full fingerprint below for a group-level diff)'; fi
printf -- '--- fingerprint rows (schema|kind|count|md5)\n%s\n--- function fingerprint rows\n%s\n' "$FP_OUT" "$FN_OUT"

[[ "${INFINICUS_DISCOVERY_ONLY:-}" == fingerprint ]] && exit 0

section '7 ROLES AND PRIVILEGES'
q roles "select rolname, rolcanlogin login, rolsuper superuser, rolbypassrls bypassrls, rolcreatedb createdb, rolcreaterole createrole, rolreplication replication, rolinherit, rolconnlimit from pg_roles where rolname !~ '^pg_' order by 1"
q memberships "select r.rolname member, m.rolname member_of from pg_auth_members a join pg_roles r on r.oid=a.member join pg_roles m on m.oid=a.roleid where r.rolname !~ '^pg_' order by 1,2"
q app-role-exists "select '$APP_ROLE' role, exists(select 1 from pg_roles where rolname='$APP_ROLE') exists"
q object-owners "select n.nspname schema, pg_get_userbyid(n.nspowner) schema_owner, (select string_agg(distinct pg_get_userbyid(c.relowner), ',') from pg_class c where c.relnamespace=n.oid and c.relkind in ('r','p')) table_owners, (select string_agg(distinct pg_get_userbyid(p.proowner), ',') from pg_proc p where p.pronamespace=n.oid) function_owners from pg_namespace n where n.nspname !~ '^(pg_|information_schema)' order by 1"
q security-definer-owners "select pg_get_userbyid(p.proowner) owner, p.prosecdef, count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^(pg_|information_schema)' and p.prosecdef group by 1,2"
q app-role-attributes "select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname = '$APP_ROLE'"
q app-role-p1 "select case when not exists(select 1 from pg_roles where rolname='$APP_ROLE') then 'APP_ROLE_MISSING' when exists(select 1 from pg_proc p where p.prosecdef and pg_get_userbyid(p.proowner)='$APP_ROLE') then 'FAIL_APP_ROLE_OWNS_SECURITY_DEFINER_FUNCTIONS' else 'PASS_APP_ROLE_OWNS_NO_SECURITY_DEFINER_FUNCTIONS' end p1"
q app-role-schema-usage "select n.nspname, has_schema_privilege('$APP_ROLE', n.oid, 'USAGE') usage from pg_namespace n where n.nspname !~ '^(pg_|information_schema)' and exists(select 1 from pg_roles where rolname='$APP_ROLE') order by 1"
q ledger-privileges-app-role "select p privilege, has_table_privilege('$APP_ROLE', 'public._migrations', p) app_role_has, has_table_privilege('public', 'public._migrations', p) public_has from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p where exists(select 1 from pg_roles where rolname='$APP_ROLE')"
q table-grants-non-owner "select n.nspname, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee, count(distinct c.relname) tables, string_agg(distinct a.privilege_type, ',') privileges from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(c.relacl) a where c.relkind in ('r','p') and n.nspname !~ '^(pg_|information_schema)' and a.grantee <> c.relowner group by 1,2 order by 1,2"
q governed-functions "select n.nspname||'.'||p.proname fn, pg_get_userbyid(p.proowner) owner, p.prosecdef, p.proconfig::text, case when exists(select 1 from pg_roles where rolname='$APP_ROLE') then has_function_privilege('$APP_ROLE', p.oid, 'EXECUTE') end app_role_exec, has_function_privilege('public', p.oid, 'EXECUTE') public_exec from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('record_execution_capability_activation','apply_inventory_reorder_policy','emit_outbox_event')"
q protected-tables-app-role "select t, p, has_table_privilege('$APP_ROLE', t, p) from (values ('business_operations.execution_capability_activations'),('business_operations.inventory_balances')) v(t), unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p where exists(select 1 from pg_roles where rolname='$APP_ROLE') and to_regclass(t) is not null"
q protected-columns-app-role "select c, has_column_privilege('$APP_ROLE', 'business_operations.inventory_balances', c, 'UPDATE') app_role_can_update from unnest(array['reorder_point','reorder_quantity','reorder_policy_state','quantity_on_hand']) c where exists(select 1 from pg_roles where rolname='$APP_ROLE') and exists(select 1 from information_schema.columns where table_schema='business_operations' and table_name='inventory_balances' and column_name=c)"
q rls-flags "select n.nspname||'.'||c.relname tbl, c.relrowsecurity rls, c.relforcerowsecurity forced from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ('audit','events','business_operations') order by 1"

section '8 DATA PROFILE (counts only)'
q row-counts "select t, case when to_regclass(t) is null then 'table does not exist' else (xpath('/row/c/text()', query_to_xml(format('select count(*) c from %s', t), false, true, '')))[1]::text end from unnest(array['audit.audit_events','business_operations.inventory_movements','business_operations.purchase_receipts','business_operations.purchase_receipt_lines','business_operations.inventory_balances','business_operations.purchase_orders','business_operations.purchase_order_line_items','events.outbox_events','events.inbox_events','events.dead_letter_events','events.event_subscriptions','events.event_delivery_attempts','events.business_event_ledger','business_operations.authorized_action_receipts','business_operations.authorized_action_claims','business_operations.authorized_action_executions','business_operations.execution_capability_activations','outcome_monitoring.action_execution_verifications','approved_business_action.authorized_action_packages','tenancy.tenants','identity.users','platform.businesses']) t"
q outbox-types "select event_type, status, count(*) from events.outbox_events group by 1,2 order by 3 desc limit 20"
q subscriptions-for-worker "select count(*) from events.event_subscriptions where event_pattern like 'control_loop.%' or subscriber_name like 'bo.authorized_action_intake@%'"
q po-currency-default "select pg_get_expr(d.adbin,d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where d.adrelid='business_operations.purchase_orders'::regclass and a.attname='currency_code'"

section '9 BACKGROUND JOBS AND SCRIPTS (append-only compatibility)'
run crontab-current bash -c "crontab -l 2>&1"
run crontab-root bash -c "sudo -n crontab -l -u root 2>&1"
run cron-dirs bash -c "ls -la /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly 2>&1"
run systemd-timers systemctl list-timers --all --no-pager
run scheduled-references bash -c "grep -r -n -i -E 'audit_events|inventory_movements|purchase_receipt|truncate|delete from|update ' /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /var/spool/cron 2>/dev/null || echo 'no cron file references the hardened tables'"
run opt-infinicus-layout bash -c "ls -la /opt/infinicus 2>&1; find /opt/infinicus -maxdepth 2 -type f \\( -name '*.sh' -o -name '*.sql' \\) -not -path '*/repo/*' 2>/dev/null | head -50"
run container-commands bash -c "cd '$COMPOSE_DIR' && docker compose ps -a --format '{{.Service}} {{.Command}}'"
q db-jobs "select extname from pg_extension where extname in ('pg_cron','pg_net','dblink','http')"

section '10 BACKUPS AND RESTORE EVIDENCE'
run backup-dirs bash -c "ls -lat /var/backups /opt/infinicus/backups /home/*/backups /srv /mnt 2>/dev/null | head -60"
run backup-files bash -c "find /opt /var/backups /home /srv /mnt -xdev \\( -name '*.dump' -o -name '*.sql.gz' -o -name '*.backup' -o -name '*.tar.gz' -o -name 'base.tar*' \\) -mtime -90 -printf '%TY-%Tm-%Td %TH:%TM %s %p\\n' 2>/dev/null | sort -r | head -30"
run backup-tooling bash -c "ls -la $REPO_DIR/infinicus-platform/infrastructure/database/scripts/ 2>&1 | head -20; command -v rclone restic borg 2>&1 || echo 'no rclone/restic/borg on PATH'"
echo '--- Hetzner server backups / snapshots are visible only in the Hetzner Cloud Console (Server -> Backups / Snapshots): record the latest backup time and snapshot list manually.'

section '11 CONFIGURATION PRESENCE (variable NAMES only - values never printed)'
run compose-env-file-names bash -c "cd '$COMPOSE_DIR' && grep -o -E '^[A-Za-z_][A-Za-z0-9_]*=' .env 2>/dev/null | tr -d '=' | sort"
for svc in api event-worker; do
  run "container-env-names-$svc" bash -c "cd '$COMPOSE_DIR' && docker compose exec -T $svc sh -c 'env' 2>/dev/null | awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print \$1}' | sort"
done

printf '\n===== END (read-only discovery complete; nothing was changed) =====\n'
