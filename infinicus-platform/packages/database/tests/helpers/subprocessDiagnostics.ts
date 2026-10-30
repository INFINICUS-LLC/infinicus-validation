/**
 * CI-STAB-02 R3: useful, safe failure context for tests that run a real script as a subprocess.
 *
 * `execFile` rejects with "Command failed: ..." and, in CI, the log of a failed run showed the test name but not why the script exited non-zero.
 * This wrapper does not change what runs or hide a failure: a non-zero exit still rejects. It only adds, to that rejection, the exit status, signal,
 * elapsed time and the bounded, redacted tails of stderr and stdout. Nothing is printed when the script succeeds.
 */
import { execFile } from 'node:child_process';

const TAIL_CHARS = 1500;

/** Removes what must never reach a CI log: connection strings, passwords, identifiers, e-mail addresses and long digit runs. */
export function redactDiagnostic(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<url-redacted>')
    .replace(/\b(PG)?PASSWORD\s*[=:]\s*\S+/gi, '$1PASSWORD=<redacted>')
    .replace(/\bpassword\s*=\s*\S+/gi, 'password=<redacted>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b\d{9,}\b/g, '<number>');
}

const tail = (text: string | undefined, max = TAIL_CHARS): string => {
  const clean = redactDiagnostic((text ?? '').trim());
  return clean.length > max ? `...${clean.slice(clean.length - max)}` : clean || '(empty)';
};

export interface SubprocessFailure { code?: unknown; signal?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown }

/** One bounded, redacted paragraph describing a failed subprocess. */
export function describeSubprocessFailure(label: string, error: SubprocessFailure, elapsedMs: number): string {
  return [
    `${label} failed: exit=${String(error.code ?? 'unknown')} signal=${String(error.signal ?? 'none')} killed=${String(Boolean(error.killed))} elapsedMs=${elapsedMs}`,
    `stderr(tail): ${tail(typeof error.stderr === 'string' ? error.stderr : undefined)}`,
    `stdout(tail): ${tail(typeof error.stdout === 'string' ? error.stdout : undefined, 600)}`,
  ].join('\n');
}

/**
 * Runs `bash <script>` exactly like the original `execFileAsync('bash', [script], { env })`. On a non-zero exit it rejects with the diagnostic above
 * (plus `extraContext`, evaluated only then, e.g. a catalog snapshot); on success it returns the output untouched.
 */
export async function runScript(
  script: string,
  env: NodeJS.ProcessEnv,
  label: string,
  extraContext?: () => Promise<string>,
): Promise<{ stdout: string; stderr: string }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile('bash', [script], { env }, async (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr });
      let context = '';
      if (extraContext) {
        try { context = `\ncontext: ${redactDiagnostic(await extraContext())}`; } catch (contextError) { context = `\ncontext: unavailable (${redactDiagnostic(String((contextError as Error).message))})`; }
      }
      const failure = new Error(describeSubprocessFailure(label, { ...(error as object), stdout, stderr } as SubprocessFailure, Date.now() - started) + context);
      (failure as Error & { cause?: unknown }).cause = error;
      reject(failure);
    });
  });
}
