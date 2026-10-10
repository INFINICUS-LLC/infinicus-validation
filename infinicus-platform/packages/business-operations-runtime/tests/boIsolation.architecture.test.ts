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

  it('does not flag unrelated operational code or the future validated authority name', () => {
    expect(findViolations('x.ts', 'const order = await orders.create(ctx, input);')).toHaveLength(0);
    expect(findViolations('x.ts', 'function accept(pkg: AuthorizedActionPackage) { return pkg; }')).toHaveLength(0);
  });
});
