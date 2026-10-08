// Cloudflare Pages Function — POST /api/feedback
// Stores anonymous product feedback and (only when email is enabled) notifies the owner.
//
// Hardened in PR-C: exact-origin allowlist instead of wildcard CORS; bounded JSON body; strict fields; per-IP and global
// abuse limits (best-effort, not authentication); comment/verdict HTML-escaped; email only via functions/_shared/email.js.
// Storage is unchanged: KV INFINICUS_USERS, key "feedback:<ms epoch>", 365-day TTL (this namespace also holds legacy user
// records; feedback is only ever written under its own prefix).
// Env: ALLOWED_ORIGINS (required), INFINICUS_WAITLIST (counters, required), INFINICUS_USERS (feedback storage, required).

import { gate, intEnv } from '../_shared/route.js';
import { deliver } from '../_shared/email.js';
import { escapeHtml, plainTextLine } from '../_shared/escape.js';

const SCHEMA = {
  rating: { type: 'number', min: 0, max: 5 },
  recommend: { type: 'boolean' },
  comment: { type: 'string', max: 1000, multiline: true },
  verdict: { type: 'string', max: 20 },
};

export async function onRequest(context) {
  const { env } = context;
  const g = await gate(context, {
    route: '/api/feedback',
    methods: ['POST'],
    limits: [
      { name: 'feedback-ip', scope: 'ip', limit: intEnv(env, 'FEEDBACK_IP_PER_HOUR', 20), windowMs: 3_600_000 },
      { name: 'feedback-all', scope: 'global', limit: intEnv(env, 'FEEDBACK_PER_DAY', 2000), windowMs: 86_400_000 },
    ],
    body: { maxBytes: 4096, schema: SCHEMA },
  });
  if (!g.ok) return g.response;
  if (!env.INFINICUS_USERS || typeof env.INFINICUS_USERS.put !== 'function') return g.respond(503, { ok: false, error: 'Service unavailable' });

  const rating = g.value.rating ?? 0;
  const recommend = g.value.recommend ?? null;
  const comment = g.value.comment ?? '';
  const verdict = plainTextLine(g.value.verdict ?? 'unknown', 20) || 'unknown';
  const ts = Date.now();
  const entry = { rating, recommend, comment, verdict, submittedAt: new Date(ts).toISOString() };

  try {
    await env.INFINICUS_USERS.put(`feedback:${ts}`, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 365 });
  } catch (e) { /* storage failure must not break the form */ }

  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  const stars = '★'.repeat(filled) + '☆'.repeat(5 - filled);
  const recText = recommend === true ? '👍 Yes' : recommend === false ? '👎 No' : '—';
  const eVerdict = escapeHtml(verdict.toUpperCase());
  const eComment = escapeHtml(comment, { maxLength: 1000 }).replace(/\n/g, '<br>');
  await deliver(env, {
    route: '/api/feedback', kind: 'owner',
    subject: `[Feedback] ${stars} — ${verdict.toUpperCase()} verdict`,
    html: `
            <div style="font-family:monospace;max-width:480px;margin:0 auto;padding:24px;background:#0a0f0d;color:#e2e8f0;border-radius:12px;">
              <h2 style="color:#00e060;font-size:16px;margin:0 0 20px;letter-spacing:.05em;">INFINICUS USER FEEDBACK</h2>
              <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <tr><td style="padding:8px 0;color:#64748b;width:140px;">Verdict</td><td style="color:#e2e8f0;font-weight:bold;">${eVerdict}</td></tr>
                <tr><td style="padding:8px 0;color:#64748b;">Satisfaction</td><td style="color:#f59e0b;font-size:18px;">${stars} <span style="color:#e2e8f0;font-size:13px;">(${filled}/5)</span></td></tr>
                <tr><td style="padding:8px 0;color:#64748b;">Recommend</td><td style="color:#e2e8f0;">${recText}</td></tr>
                <tr><td style="padding:8px 0;color:#64748b;vertical-align:top;">Comment</td><td style="color:#e2e8f0;">${eComment || '—'}</td></tr>
                <tr><td style="padding:8px 0;color:#64748b;">Submitted</td><td style="color:#94a3b8;font-size:11px;">${new Date(ts).toUTCString()}</td></tr>
              </table>
            </div>
          `,
  });

  return g.respond(200, { ok: true });
}
