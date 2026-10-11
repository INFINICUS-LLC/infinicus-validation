import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ARCHITECTURE GUARD (V-01, reconciliation P0 sequence):
 *
 *   No Business Operations code path may treat an ApprovedAction alone as
 *   execution authority.
 *
 * Today no ABA -> BO execution contract exists. An `ApprovedAction` is created
 * in Approved Business Action and nothing delivers it to Business Operations.
 * That isolation is the only thing standing between a decision and an
 * operational effect, so it is protected here until the complete, validated
 * `AuthorizedActionPackage` contract (P0-1 .. P0-5) is implemented and
 * validated. This test deliberately does NOT define that contract and does not
 * redefine the locked ABA or BO specifications; it only keeps the current
 * boundary from eroding by accident.
 *
 * What it forbids inside Business Operations code: any reference to the ABA
 * approved-action tables, repositories, entities, execution plans or control
 * gates, and any import from the ABA layer. The future authority name
 * (`AuthorizedActionPackage`) is intentionally NOT in the forbidden list.
 *
 * When P0-5 introduces the validated contract, this guard is extended (not
 * removed) to require that BO reaches ABA output only through it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = resolve(HERE, '..', '..', '..');

/** Roots that constitute Business Operations code, relative to infinicus-platform/. */
export const BO_CODE_ROOTS: readonly string[] = [
  'packages/business-operations-runtime/src',
  'packages/database/src/repositories/bo',
  'layers/business-operations/src',
  'layers/business-operations/blocks',
];

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sql']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

/** Each rule: a name for the report and the pattern that signals a violation. */
export const FORBIDDEN_IN_BO: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'ApprovedAction entity/repository/table', pattern: /approved[_ ]?actions?/i },
  { name: 'ABA schema (approved_business_action)', pattern: /approved_business_action/i },
  { name: 'ABA execution plan', pattern: /ActionExecutionPlan|action_execution_plans?/i },
  { name: 'ABA control gate', pattern: /ActionControlGate|action_control_gates?/i },
  // P0-5 Block 3b: the package STORE is ABA-owned. BO reaches a package only through the validated AuthorizedActionPackage
  // contract (never through ABA's repository or tables), so the contract name stays allowed while its persistence does not.
  { name: 'AuthorizedActionPackage repository/table (ABA-owned storage)', pattern: /AuthorizedActionPackageRepository|authorized_action_package(?:s|_versions|_lifecycle_events)\b/i },
  // P0-5 Block 3c-1: the capture (original / delta / final parameters) and owner assignment are ABA-owned too; BO sees only the package.
  { name: 'ABA authorized-action capture/owner-assignment (ABA-owned storage)', pattern: /AuthorizedActionCaptureRepository|authorized_action_(?:captures|owner_assignments)\b/i },
  // P0-5 Block 3c-2: the action-type registry and automation-level policy are ABA-governed too. "BO can execute this" is BO's own
  // capability registry; BO never reads ABA's vocabulary or policy store.
  { name: 'ABA action-type registry / automation-level policy (ABA-owned storage)', pattern: /ActionTypeRegistryRepository|AutomationLevelPolicyRepository|action_type_(?:definitions|status_events)\b|automation_level_polic(?:y|ies)\w*/i },
  // P0-5 Block 3c-3: the execution boundaries (window, preconditions, budget, rollback, monitoring) are authored and owned by ABA;
  // BO sees them only inside the validated AuthorizedActionPackage and re-checks them itself before executing.
  { name: 'ABA authorized-action boundaries (ABA-owned storage)', pattern: /AuthorizedActionBoundaryRepository|authorized_action_boundaries\b/i },
  // P0-5 Block 3d: the ABA issuer is the only component that seals and persists a package. BO never issues, seals, audits issuance or
  // reaches the issuer's source reader; it consumes a package only through the validated contract.
  { name: 'ABA package issuer / issuance audit (ABA-owned)', pattern: /AuthorizedActionPackageIssuer|AuthorizedActionIssuanceRepository|PackageIssuanceRefusedError|sealAuthorizedActionPackage|package-issuance-audit|package\.issued|package\.issuance_refused/i },
  { name: 'import from the ABA layer', pattern: /(?:from|require\()\s*['"][^'"]*approved-business-action[^'"]*['"]/i },
];

export interface BoIsolationViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

/** Pure matcher so the guard itself can be tested without touching the filesystem. */
export function findViolations(file: string, source: string): BoIsolationViolation[] {
  const violations: BoIsolationViolation[] = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of FORBIDDEN_IN_BO) {
      if (rule.pattern.test(lines[index])) {
        violations.push({ file, line: index + 1, rule: rule.name, text: lines[index].trim().slice(0, 160) });
      }
    }
  }
  return violations;
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (SCANNED_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('Business Operations isolation guard (no ApprovedAction-as-authority)', () => {
  it('scans a non-trivial set of Business Operations source files (the guard cannot pass vacuously)', () => {
    const scanned = BO_CODE_ROOTS.flatMap((root) => listSourceFiles(join(PLATFORM_ROOT, root)));
    expect(scanned.length).toBeGreaterThan(50);
    // The runtime package is the core of BO; it must be among the scanned roots.
    expect(scanned.some((file) => file.includes('OperationalCommandExecutor'))).toBe(true);
  });

  it('finds no reference to ApprovedAction, ABA tables, execution plans, control gates or the ABA layer in any Business Operations code', () => {
    const violations: BoIsolationViolation[] = [];
    for (const root of BO_CODE_ROOTS) {
      for (const file of listSourceFiles(join(PLATFORM_ROOT, root))) {
        violations.push(...findViolations(relative(PLATFORM_ROOT, file), readFileSync(file, 'utf8')));
      }
    }
    const report = violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n');
    expect(report).toBe('');
  });
});

describe('Business Operations isolation guard — the matcher itself', () => {
  it('detects an ApprovedAction repository used from BO code', () => {
    const source = "import { ApprovedActionRepository } from '@infinicus/database';\nnew ApprovedActionRepository();";
    expect(findViolations('x.ts', source).map((v) => v.rule)).toContain('ApprovedAction entity/repository/table');
  });

  it('detects a raw read of the ABA approved-actions table', () => {
    const source = 'SELECT id FROM approved_business_action.approved_actions WHERE status = $1';
    const rules = findViolations('x.ts', source).map((v) => v.rule);
    expect(rules).toContain('ABA schema (approved_business_action)');
    expect(rules).toContain('ApprovedAction entity/repository/table');
  });

  it('detects an execution plan, a control gate and an import from the ABA layer', () => {
    expect(findViolations('x.ts', 'const p: ActionExecutionPlan = load();')).toHaveLength(1);
    expect(findViolations('x.ts', 'gate = ActionControlGate.open();')).toHaveLength(1);
    expect(findViolations('x.ts', "import { x } from '../../approved-business-action/src';")).toHaveLength(1);
  });

  it('detects the package repository and the package tables used from BO code', () => {
    expect(findViolations('x.ts', "import { AuthorizedActionPackageRepository } from '@infinicus/database';").map((v) => v.rule))
      .toContain('AuthorizedActionPackage repository/table (ABA-owned storage)');
    for (const table of ['authorized_action_packages', 'authorized_action_package_versions', 'authorized_action_package_lifecycle_events']) {
      expect(findViolations('x.ts', `SELECT 1 FROM ${table}`).map((v) => v.rule)).toContain('AuthorizedActionPackage repository/table (ABA-owned storage)');
    }
  });

  it('detects the capture repository and the capture / owner-assignment tables used from BO code', () => {
    const rule = 'ABA authorized-action capture/owner-assignment (ABA-owned storage)';
    expect(findViolations('x.ts', 'new AuthorizedActionCaptureRepository();').map((v) => v.rule)).toContain(rule);
    for (const table of ['authorized_action_captures', 'authorized_action_owner_assignments']) {
      expect(findViolations('x.ts', `SELECT 1 FROM ${table}`).map((v) => v.rule)).toContain(rule);
    }
  });

  it('detects the action-type registry and automation-level policy used from BO code', () => {
    const rule = 'ABA action-type registry / automation-level policy (ABA-owned storage)';
    for (const text of ['new ActionTypeRegistryRepository();', 'new AutomationLevelPolicyRepository();', 'SELECT 1 FROM action_type_definitions',
      'SELECT 1 FROM action_type_status_events', 'SELECT 1 FROM automation_level_policies', 'FROM automation_level_policy_versions',
      'FROM automation_level_policy_enablement_events']) {
      expect(findViolations('x.ts', text).map((v) => v.rule)).toContain(rule);
    }
  });

  it('detects the boundary repository and the boundaries table used from BO code', () => {
    const rule = 'ABA authorized-action boundaries (ABA-owned storage)';
    expect(findViolations('x.ts', 'new AuthorizedActionBoundaryRepository();').map((v) => v.rule)).toContain(rule);
    expect(findViolations('x.ts', 'SELECT 1 FROM authorized_action_boundaries').map((v) => v.rule)).toContain(rule);
  });

  it('detects the package issuer, the issuance source reader and the seal function used from BO code', () => {
    const rule = 'ABA package issuer / issuance audit (ABA-owned)';
    expect(findViolations('x.ts', 'new AuthorizedActionPackageIssuer().issue(ctx, req);').map((v) => v.rule)).toContain(rule);
    expect(findViolations('x.ts', 'new AuthorizedActionIssuanceRepository();').map((v) => v.rule)).toContain(rule);
    expect(findViolations('x.ts', 'sealAuthorizedActionPackage(body, opts);').map((v) => v.rule)).toContain(rule);
    expect(findViolations('x.ts', "event_type = 'package.issued'").map((v) => v.rule)).toContain(rule);
  });

  it('does not flag unrelated operational code or the future validated authority name', () => {
    expect(findViolations('x.ts', 'const order = await orders.create(ctx, input);')).toHaveLength(0);
    expect(findViolations('x.ts', 'function accept(pkg: AuthorizedActionPackage) { return pkg; }')).toHaveLength(0);
  });
});
