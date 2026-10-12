/**
 * The git commit this API image was built from, so an operator can tell which code is deployed (`GET /v1/health`).
 * Injected at image build time (`ARG GIT_SHA` -> `ENV INFINICUS_BUILD_SHA`, see apps/api/Dockerfile). Not a secret. Anything that is not
 * a 7-40 character hex commit id is reported as `unknown`, so the endpoint can never echo arbitrary environment content.
 */
const COMMIT = /^[0-9a-f]{7,40}$/;

export function resolveBuildVersion(env: Record<string, string | undefined> = process.env): string {
  const raw = env.INFINICUS_BUILD_SHA?.trim().toLowerCase();
  return raw !== undefined && COMMIT.test(raw) ? raw : 'unknown';
}
