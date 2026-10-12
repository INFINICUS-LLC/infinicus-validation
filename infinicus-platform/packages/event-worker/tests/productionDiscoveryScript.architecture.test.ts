import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Guard for the operator's production discovery script (no database, no docker). The script runs on the production VM, so "read-only" and
 * "never prints a secret" are properties the repository must keep proving: every SQL statement is a SELECT, no shell command mutates anything,
 * nothing that can print a secret is used, and the fingerprint embedded in the script stays identical to the committed reference SQL/outputs.
 */
const PLATFORM = resolve(__dirname, '../../..');
const REPO = resolve(PLATFORM, '..');
const SCRIPT = join(PLATFORM, 'infrastructure/deployment/scripts/production-readonly-discovery.sh');
const REF_DIR = join(REPO, 'docs/architecture/reconciliation/production-discovery');
const text = readFileSync(SCRIPT, 'utf8');

/** Script lines without comments. */
const code = text.split('\n').filter((l) => !/^\s*#/.test(l));
const body = code.join('\n');
/** Shell-only text: SQL (heredocs and q calls) removed, because SQL legitimately contains > and < comparison operators. */
const shellOnly = body.replace(/<<'SQL'\n[\s\S]*?\nSQL\n/g, '').split('\n').filter((l) => !/^q\s+\S+\s+"/.test(l)).join('\n');

/** SQL texts the script sends: q "<label>" "<sql>" calls and the two heredocs. */
function sqlStatements(): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/^q\s+\S+\s+"((?:[^"\\]|\\.)*)"/gm)) out.push(m[1]);
  for (const m of body.matchAll(/<<'SQL'\n([\s\S]*?)\nSQL\n/g)) out.push(m[1]);
  return out;
}
const stripLiterals = (sql: string): string => sql.replace(/'(?:[^']|'')*'/g, "''");

describe('production discovery script: strictly read-only', () => {
  it('is a real script and finds its SQL (not vacuous)', () => {
    expect(text.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(sqlStatements().length).toBeGreaterThan(30);
    expect(body).toContain('default_transaction_read_only=on');
  });

  it('every SQL statement is a SELECT/WITH and contains no write, DDL, privilege or session-changing keyword (string literals removed)', () => {
    const forbidden = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|vacuum|reindex|cluster|call|do|set|reset|lock|refresh|execute|prepare|listen|notify|analyze|comment|merge|import|security\s+label|discard|begin|commit|rollback)\b/i;
    for (const raw of sqlStatements()) {
      const sql = stripLiterals(raw.replace(/\$APP_ROLE/g, 'app_role')).trim();
      expect(sql, raw).toMatch(/^(select|with)\b/i);
      expect(sql, raw).not.toMatch(forbidden);
      expect(sql, raw).not.toContain(';');
    }
  });

  it('all SQL goes through the read-only session wrapper; psql is never invoked anywhere else', () => {
    const psqlLines = code.filter((l) => /\bpsql\b/.test(l));
    expect(psqlLines.length).toBe(1); // the docker path inside sql(); the test hook runs the caller-supplied command through the same wrapper
    expect(code.filter((l) => /INFINICUS_DISCOVERY_PSQL\}/.test(l)).length).toBe(1);
    expect(body).toMatch(/PGOPTIONS="\$READONLY_OPTS"/);
    expect(body).toMatch(/-e PGOPTIONS="\$READONLY_OPTS"/);
  });

  it('no mutating shell command: no service control, build/pull/run, file mutation, package manager, git mutation, backup, migration, grant or worker start', () => {
    const bad: [RegExp, string][] = [
      [/docker\s+compose\s+(up|down|restart|stop|start|build|pull|run|rm|kill|create|cp|push|pause|unpause)\b/, 'compose mutation'],
      [/docker\s+(run|rm|rmi|stop|start|restart|kill|pull|push|build|commit|cp|exec|create|network\s+(create|rm)|volume\s+(create|rm|prune)|system\s+prune|image\s+prune)\b/, 'docker mutation'],
      [/systemctl\s+(start|stop|restart|reload|enable|disable|mask|daemon-reload)\b/, 'systemctl mutation'],
      [/\b(rm|mv|cp|dd|mkfs|chmod|chown|ln|touch|mkdir|rmdir|truncate|shred|tee|install|useradd|usermod|passwd)\s/, 'file/system mutation'],
      [/\b(apt|apt-get|dpkg|yum|npm|pnpm|pip|pip3)\b/, 'package manager'],
      [/git\s+(?!--no-optional-locks\s+-C\s+"\$REPO_DIR"\s+(rev-parse|log|status))/, 'git other than the read-only queries'],
      [/\b(migration-gate|grant-app-role|backup\.sh|restore\.sh|pg_dump|pg_restore|pitr|enable-wal|deploy\.sh)/, 'migration/backup/restore/deploy script'],
      [/-(exec|delete|ok)\b/, 'find -exec/-delete'],
      [/\bcrontab\s+-(e|r|i)\b|\bcrontab\s+\S+\.\S+/, 'crontab edit'],
      [/\bcurl\b[^\n]*(-X|--request|-d\b|--data|-T\b|--upload|-F\b|--form|-o\b|--output|-O\b)/, 'curl that writes or posts'],
      [/\bwget\b(?![^\n]*-qO-\s+http:\/\/localhost)/, 'wget other than a local GET to stdout'],
      [/\bsudo\b(?![^\n]*-n\s+(ufw\s+status|crontab\s+-l\s+-u\s+root))/, 'sudo beyond ufw status / crontab -l'],
      [/(?<![0-9&-])>[ \t]*(?!\/dev\/null|&)[\w./~$"'-]/, 'file redirection'],
    ];
    for (const [re, label] of bad) expect(re.test(shellOnly), `${label}: ${re}`).toBe(false);
  });

  it('docker exec is only used for psql (via sql()), local wget GETs, the DATABASE_URL user-name extraction and env NAME listing', () => {
    const execLines = code.filter((l) => /docker compose exec/.test(l));
    expect(execLines.length).toBeGreaterThan(3);
    for (const l of execLines) {
      expect(/psql -U|wget -qO- http:\/\/localhost:3000\/v1\/(ready|health)|sh -c 'echo \\"\\\$DATABASE_URL\\"'|sh -c 'env'/.test(l), l).toBe(true);
    }
  });

  it('can never print a secret: no compose config dump, no bare inspect/env/printenv/cat of .env, user-name extraction prints only on match, env is reduced to names', () => {
    expect(body).not.toMatch(/docker\s+compose\s+config(?!\s+--services)/);
    expect(body).not.toMatch(/docker\s+inspect(?![^\n]*-f\s+'\{\{\.Name\}\} image=)/);
    expect(body).not.toMatch(/\.Config\.Env|\{\{\s*json\s|\{\{\s*\.\s*\}\}/);
    expect(body).not.toMatch(/\bprintenv\b|\bcat\s+[^\n|]*\.env\b|\bsource\s+[^\n]*\.env\b|\bdeclare\s+-x\b|\bset\s+-x\b|\bxtrace\b/);
    expect(body).not.toMatch(/user-data|public-keys/);
    expect(/for p in hostname instance-id region availability-zone public-ipv4; do/.test(body)).toBe(true); // the only metadata paths read
    // DATABASE_URL: only the user name, only when the whole pattern matched (-n ... p), never the whole line.
    expect(body).toMatch(/sed -nE 's#\^\[a-z\]\+:\/\/\(\[\^:\/@\]\+\)\.\*#\\\\1#p'/);
    // environment listings: names only (awk prints $1 for NAME=... lines; .env via grep -o of the name prefix)
    expect(body).toMatch(/env' 2>\/dev\/null \| awk -F= '\/\^\[A-Za-z_\]\[A-Za-z0-9_\]\*=\/\{print \\\$1\}'/);
    expect(body).toMatch(/grep -o -E '\^\[A-Za-z_\]\[A-Za-z0-9_\]\*=' \.env/);
    for (const l of code) expect(/\bcat\b/.test(l) && !/'cat' \/etc\/os-release|<<'SQL'/.test(l) && !/cat <<'SQL'|\$\(cat/.test(l), l).toBe(false);
  });

  it('never calls out: the only network access is the link-local Hetzner metadata service (specific read-only paths) and a local container GET', () => {
    const urls = [...body.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(2);
    for (const u of urls) expect(/^http:\/\/(169\.254\.169\.254\/hetzner\/v1\/metadata\/\$p|localhost:3000\/v1\/(ready|health))/.test(u), u).toBe(true);
  });
});

describe('production discovery script: fingerprint stays tied to the committed references', () => {
  const FP_RE = /FP_SQL=\$\(cat <<'SQL'\n([\s\S]*?)\nSQL\n\)/;
  const FN_RE = /FN_SQL=\$\(cat <<'SQL'\n([\s\S]*?)\nSQL\n\)/;
  const heredoc = (name: 'FP_SQL' | 'FN_SQL'): string => {
    const m = (name === 'FP_SQL' ? FP_RE : FN_RE).exec(text);
    expect(m, name).not.toBeNull();
    return (m as RegExpExecArray)[1];
  };
  const file = (n: string): string => readFileSync(join(REF_DIR, n), 'utf8');

  it('the embedded fingerprint SQL equals the committed schema-fingerprint.sql and function-fingerprint.sql', () => {
    expect(heredoc('FP_SQL').trim()).toBe(file('schema-fingerprint.sql').trim());
    expect(heredoc('FN_SQL').trim()).toBe(file('function-fingerprint.sql').trim());
  });

  it('the reference hashes in the script are the SHA-256 prefixes of the committed reference outputs (0169 and 0198, PostgreSQL 16)', () => {
    for (const head of ['0169', '0198']) {
      const h = createHash('sha256').update(file(`reference-${head}.pg16.fingerprint.txt`) + file(`reference-${head}.pg16.functions.txt`)).digest('hex').slice(0, 16);
      expect(text, head).toContain(`REF_${head}_PG16="${h}"`);
    }
  });
});
