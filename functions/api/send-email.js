// functions/api/send-email.js — INFINICUS ENGINE v3
// Cloudflare Pages Function · Simulation report email
//
// DISABLED BY DEFAULT (PR-C). Nothing is sent unless EMAIL_MODE is "live" and a verified sending identity is configured
// (functions/_shared/email.js). While disabled the route validates the request and answers 503 "Service unavailable"
// (the same status the previous "Email service not configured" answer used), so the frontend's existing error path runs.
//
// Hardened in PR-C: exact-origin allowlist instead of wildcard CORS; bounded body; strict field validation; every
// user-supplied value HTML-escaped and length-capped before it enters the template; fixed subject lines; sender and reply-to
// come only from server configuration; per-IP, per-recipient and global limits (best-effort, not authentication).
// Remaining blocker for live mode: a requester can still ask for a report to be mailed to an address they typed without
// proving they own it (no double opt-in yet).
// Env: ALLOWED_ORIGINS, INFINICUS_WAITLIST (counters), EMAIL_MODE, RESEND_API_KEY, EMAIL_FROM, EMAIL_VERIFIED_DOMAINS (+ optional
// EMAIL_REPLY_TO, EMAIL_ALLOWED_RECIPIENT_DOMAINS)

import { gate, checkLimit, intEnv } from '../_shared/route.js';
import { deliver, emailMode } from '../_shared/email.js';
import { escapeHtml, toFiniteNumber } from '../_shared/escape.js';

const SCHEMA = {
  name: { type: 'string', max: 80 },
  email: { type: 'email', required: true },
  idea: { type: 'string', max: 500, multiline: true },
  verdict: { type: 'string', max: 12 },
  headline: { type: 'string', max: 200 },
  summary: { type: 'string', max: 1200, multiline: true },
  capital: { type: 'number', min: 0, max: 1e12 },
  revenue: { type: 'number', min: -1e12, max: 1e12 },
  profit: { type: 'number', min: -1e12, max: 1e12 },
  endCash: { type: 'number', min: -1e12, max: 1e12 },
  profDays: { type: 'number', min: 0, max: 90 },
  mcSurvival: { type: 'number', min: 0, max: 1 },
  score_viability: { type: 'number', min: 0, max: 100 },
  score_market: { type: 'number', min: 0, max: 100 },
  score_execution: { type: 'number', min: 0, max: 100 },
  score_financial: { type: 'number', min: 0, max: 100 },
};

const SUBJECTS = {
  go: '✅ Your Business Got a GO — INFINICUS Report',
  modify: '⚠️ Your Simulation Results — Adjustments Needed',
  stop: '🛑 Your Simulation Results — INFINICUS Analysis',
};

/** Escaped strings and clamped numbers only: the template below never sees a raw user value. */
function safeReportData(v) {
  const text = (s, max) => escapeHtml(s ?? '', { maxLength: max }).replace(/\n/g, '<br>');
  const num = (n) => (n === undefined ? undefined : toFiniteNumber(n));
  const verdict = ['go', 'modify', 'stop'].includes((v.verdict ?? '').toLowerCase()) ? v.verdict.toLowerCase() : 'stop';
  return {
    name: text(v.name, 80), email: escapeHtml(v.email), idea: text(v.idea, 500), verdict, headline: text(v.headline, 200), summary: text(v.summary, 1200),
    capital: num(v.capital), revenue: num(v.revenue), profit: num(v.profit), endCash: num(v.endCash), profDays: num(v.profDays), mcSurvival: num(v.mcSurvival),
    score_viability: num(v.score_viability), score_market: num(v.score_market), score_execution: num(v.score_execution), score_financial: num(v.score_financial),
  };
}

function buildEmailHTML(data) {
  const {
    name, email, idea, verdict, headline, summary,
    capital, revenue, profit, endCash, profDays, mcSurvival,
    score_viability, score_market, score_execution, score_financial
  } = data;

  const verdictColor = verdict === 'go' ? '#10b981' : verdict === 'modify' ? '#f59e0b' : '#f43f5e';
  const verdictLabel = verdict === 'go' ? '✅ GO' : verdict === 'modify' ? '⚠️ MODIFY' : '🛑 STOP';
  const greeting = name ? `Hi ${name},` : 'Hi there,';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Your INFINICUS Simulation Report</title>
</head>
<body style="margin:0;padding:0;background:#04060d;font-family:system-ui,-apple-system,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#04060d;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- HEADER -->
  <tr><td style="background:#0a0d1a;border:1px solid #1a2035;border-radius:16px 16px 0 0;padding:32px 36px;text-align:center;">
    <div style="font-size:11px;font-family:monospace;color:#00e060;letter-spacing:.2em;margin-bottom:8px;">INFINICUS ENGINE v3</div>
    <div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-.5px;">Your Business Simulation</div>
    <div style="font-size:13px;color:#6b7280;margin-top:6px;">90-Day Statistical Analysis Report</div>
  </td></tr>

  <!-- VERDICT BANNER -->
  <tr><td style="background:${verdictColor}18;border-left:1px solid ${verdictColor}40;border-right:1px solid ${verdictColor}40;padding:20px 36px;text-align:center;">
    <div style="font-size:11px;font-family:monospace;color:${verdictColor};letter-spacing:.15em;margin-bottom:6px;">ENGINE VERDICT</div>
    <div style="font-size:32px;font-weight:900;color:${verdictColor};">${verdictLabel}</div>
    ${headline ? `<div style="font-size:15px;color:#e5e7eb;margin-top:10px;line-height:1.5;font-style:italic;">"${headline}"</div>` : ''}
  </td></tr>

  <!-- BODY -->
  <tr><td style="background:#0a0d1a;border:1px solid #1a2035;border-top:none;padding:32px 36px;">

    <p style="color:#d1d5db;font-size:14px;line-height:1.7;margin:0 0 24px;">${greeting}</p>
    ${summary ? `<p style="color:#d1d5db;font-size:14px;line-height:1.7;margin:0 0 28px;">${summary}</p>` : ''}

    <!-- IDEA -->
    <div style="background:#111827;border:1px solid #1f2937;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
      <div style="font-size:10px;font-family:monospace;color:#6b7280;letter-spacing:.12em;margin-bottom:6px;">BUSINESS IDEA</div>
      <div style="font-size:13px;color:#f3f4f6;line-height:1.5;">${idea || '—'}</div>
    </div>

    <!-- KEY METRICS -->
    <div style="font-size:10px;font-family:monospace;color:#6b7280;letter-spacing:.12em;margin-bottom:12px;">90-DAY SIMULATION RESULTS</div>
    <table width="100%" cellpadding="0" cellspacing="8" style="margin-bottom:24px;">
      <tr>
        <td width="50%" style="padding:4px;">
          <div style="background:#111827;border:1px solid #1f2937;border-radius:8px;padding:14px 16px;">
            <div style="font-size:10px;font-family:monospace;color:#6b7280;margin-bottom:4px;">TOTAL REVENUE</div>
            <div style="font-size:18px;font-weight:700;color:#10b981;">${capital ? '$'+Number(revenue||0).toLocaleString() : '—'}</div>
          </div>
        </td>
        <td width="50%" style="padding:4px;">
          <div style="background:#111827;border:1px solid #1f2937;border-radius:8px;padding:14px 16px;">
            <div style="font-size:10px;font-family:monospace;color:#6b7280;margin-bottom:4px;">NET PROFIT / LOSS</div>
            <div style="font-size:18px;font-weight:700;color:${(profit||0)>=0?'#10b981':'#f43f5e'};">${profit!==undefined?((profit>=0?'+':'')+('$'+Math.abs(profit).toLocaleString())):'—'}</div>
          </div>
        </td>
      </tr>
      <tr>
        <td width="50%" style="padding:4px;">
          <div style="background:#111827;border:1px solid #1f2937;border-radius:8px;padding:14px 16px;">
            <div style="font-size:10px;font-family:monospace;color:#6b7280;margin-bottom:4px;">PROFITABLE DAYS</div>
            <div style="font-size:18px;font-weight:700;color:#00e0ff;">${profDays !== undefined ? profDays+'/90' : '—'}</div>
          </div>
        </td>
        <td width="50%" style="padding:4px;">
          <div style="background:#111827;border:1px solid #1f2937;border-radius:8px;padding:14px 16px;">
            <div style="font-size:10px;font-family:monospace;color:#6b7280;margin-bottom:4px;">MC SURVIVAL RATE</div>
            <div style="font-size:18px;font-weight:700;color:#a78bfa;">${mcSurvival !== undefined ? Math.round(mcSurvival*100)+'%' : '—'}</div>
          </div>
        </td>
      </tr>
    </table>

    <!-- SCORES -->
    ${(score_viability || score_market || score_execution || score_financial) ? `
    <div style="font-size:10px;font-family:monospace;color:#6b7280;letter-spacing:.12em;margin-bottom:12px;">VIABILITY SCORES</div>
    <div style="background:#111827;border:1px solid #1f2937;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
      ${[
        ['Viability', score_viability, '#10b981'],
        ['Market Fit', score_market, '#00e0ff'],
        ['Execution', score_execution, '#a78bfa'],
        ['Financial', score_financial, '#f59e0b']
      ].filter(([,v])=>v).map(([label, val, color])=>`
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:11px;color:#9ca3af;font-family:monospace;">${label}</span>
          <span style="font-size:11px;color:${color};font-family:monospace;font-weight:700;">${val}/100</span>
        </div>
        <div style="background:#1f2937;border-radius:4px;height:5px;">
          <div style="background:${color};width:${val}%;height:5px;border-radius:4px;"></div>
        </div>
      </div>`).join('')}
    </div>` : ''}

    <!-- CTA -->
    <div style="text-align:center;margin:28px 0;">
      <a href="https://infinicus-validation.pages.dev" style="display:inline-block;background:#00e060;color:#04060d;font-family:monospace;font-size:12px;font-weight:700;letter-spacing:.08em;padding:14px 32px;border-radius:8px;text-decoration:none;">VIEW FULL REPORT →</a>
    </div>

    <hr style="border:none;border-top:1px solid #1f2937;margin:24px 0;">
    <p style="color:#6b7280;font-size:11px;line-height:1.6;margin:0;">
      This report was generated by INFINICUS ENGINE v3, a statistical business simulation tool for educational and planning purposes only. Results are probabilistic projections — not guarantees. Always consult qualified professionals before making financial decisions.
    </p>

  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#060810;border:1px solid #1a2035;border-top:none;border-radius:0 0 16px 16px;padding:20px 36px;text-align:center;">
    <div style="font-size:10px;font-family:monospace;color:#374151;letter-spacing:.1em;">
      © 2026 INFINICUS ENGINE ·
      <a href="https://infinicus-validation.pages.dev/legal.html#privacy" style="color:#374151;">Privacy Policy</a> ·
      <a href="https://infinicus-validation.pages.dev/legal.html#terms" style="color:#374151;">Terms</a> ·
      Reply to this email to reach our team
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export async function onRequest(context) {
  const { env } = context;
  const g = await gate(context, {
    route: '/api/send-email',
    methods: ['POST'],
    limits: [
      { name: 'email-ip', scope: 'ip', limit: intEnv(env, 'SEND_EMAIL_IP_PER_HOUR', 5), windowMs: 3_600_000 },
      { name: 'email-all', scope: 'global', limit: intEnv(env, 'SEND_EMAIL_PER_DAY', 500), windowMs: 86_400_000 },
    ],
    body: { maxBytes: 8192, schema: SCHEMA },
  });
  if (!g.ok) return g.response;

  // Disabled by default: answer before spending any per-recipient quota or building content.
  if (emailMode(env) === 'disabled') return g.respond(503, { ok: false, error: 'Service unavailable' });

  const quota = await checkLimit(env, { name: 'email-to', key: g.value.email, limit: 3, windowMs: 86_400_000 });
  if (quota.degraded) return g.respond(503, { ok: false, error: 'Service unavailable' });
  if (!quota.allowed) return g.respond(429, { ok: false, error: 'Too many requests' }, { 'Retry-After': String(Math.max(1, quota.retryAfterSec)) });

  const data = safeReportData(g.value);
  const result = await deliver(env, {
    route: '/api/send-email', kind: 'user', to: g.value.email,
    subject: SUBJECTS[data.verdict],
    html: buildEmailHTML(data),
  });

  if (result.status === 'sent') return g.respond(200, { ok: true });
  if (result.status === 'logged') return g.respond(200, { ok: true, delivered: false });
  if (result.status === 'refused') return g.respond(400, { ok: false, error: 'Invalid request' });
  return g.respond(result.status === 'unconfigured' || result.status === 'disabled' ? 503 : 502, { ok: false, error: 'Email delivery failed' });
}
