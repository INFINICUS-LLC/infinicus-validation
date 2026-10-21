// Builds the counter as static files in apps/web/out for the device shell (POS-8d-2a). Dependency-free and cross-platform (no `VAR=x cmd` syntax).
// Run through the package manager (`pnpm run build:export`), so `next` is resolved exactly as in the normal build. Only the three public variables
// (NEXT_PUBLIC_API_BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY) are baked in at build time, so one export is tied to one
// environment. Nothing secret may be set here (the browser-secret scan guards the sources).
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'out'), { recursive: true, force: true });
const run = spawnSync('next', ['build'], { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, NEXT_OUTPUT: 'export', NEXT_TELEMETRY_DISABLED: '1' } });
process.exit(run.status ?? 1);
