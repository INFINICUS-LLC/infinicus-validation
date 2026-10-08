// Cloudflare Pages Function — POST /api/nurture
// Sends ONE Day 3 or Day 7 nurture email.
//
//   POST /api/nurture   Authorization: Bearer <NURTURE_BATCH_SECRET>
//   { "email": "user@example.com", "name": "Jane", "day": 3 }
//
// SERVER-TO-SERVER ONLY (PR-C): previously an unauthenticated route that could email any address. It is now behind the same
// mandatory bearer secret as /api/nurture-batch, has no CORS, and sends only through functions/_shared/email.js
// (EMAIL_MODE defaults to disabled). No frontend page calls it.

import { gate } from '../_shared/route.js';
import { deliver } from '../_shared/email.js';
import { escapeHtml, plainTextLine } from '../_shared/escape.js';

const SCHEMA = {
  email: { type: 'email', required: true },
  name: { type: 'string', max: 80 },
  day: { type: 'number', integer: true, required: true, min: 3, max: 7 },
};

export async function onRequest(context) {
  const { env } = context;
  const g = await gate(context, { route: '/api/nurture', methods: ['POST'], bearer: 'NURTURE_BATCH_SECRET', body: { maxBytes: 2048, schema: SCHEMA } });
  if (!g.ok) return g.response;

  const { email, day } = g.value;
  if (day !== 3 && day !== 7) return g.respond(400, { ok: false, error: 'Invalid request' });

  const firstName = plainTextLine((g.value.name || '').split(' ')[0], 40) || 'there';
  const html = day === 3 ? buildDay3(escapeHtml(firstName)) : buildDay7(escapeHtml(firstName));
  const subject = day === 3
    ? `Did you run your first simulation yet, ${firstName}?`
    : `${firstName}, your business idea deserves real numbers — here's what 500 simulations reveal`;

  const result = await deliver(env, { route: '/api/nurture', kind: 'user', to: email, subject, html });
  if (result.status === 'disabled' || result.status === 'logged') return g.respond(200, { ok: true, day, delivered: false });
  if (result.status === 'sent') return g.respond(200, { ok: true, day, delivered: true });
  return g.respond(result.status === 'refused' ? 400 : 503, { ok: false, error: result.status === 'refused' ? 'Invalid request' : 'Service unavailable' });
}

// ── DAY 3 ─────────────────────────────────────────────────────────────────────
function buildDay3(name) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8fafc;font-family:Inter,sans-serif;">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08);">
  <div style="background:#07080a;padding:28px 32px;">
    <div style="font-family:monospace;font-size:10px;color:#00e676;letter-spacing:.15em;margin-bottom:8px;">INFINICUS ENGINE v3 · DAY 3</div>
    <h1 style="margin:0;font-size:20px;font-weight:900;color:#fff;line-height:1.2;">How to read your simulation verdict, ${name}.</h1>
  </div>
  <div style="padding:28px 32px;">
    <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.65;">If you've already run a simulation — great. If not, this is a good moment to start. Here's how to make sense of what the engine tells you.</p>

    <div style="margin:0 0 20px;">
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;padding:14px;background:#f0fdf4;border-radius:8px;border-left:3px solid #10b981;">
        <span style="font-size:20px;line-height:1;">✅</span>
        <div><strong style="color:#065f46;font-size:13px;">GO</strong><br><span style="font-size:13px;color:#374151;line-height:1.6;">Survival rate above 55%, positive end cash, 30%+ profitable days. The math works — execution is what matters now.</span></div>
      </div>
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;padding:14px;background:#fffbeb;border-radius:8px;border-left:3px solid #f59e0b;">
        <span style="font-size:20px;line-height:1;">⚠️</span>
        <div><strong style="color:#92400e;font-size:13px;">MODIFY</strong><br><span style="font-size:13px;color:#374151;line-height:1.6;">The model shows potential but gaps. Try adjusting your price, cutting costs, or increasing your marketing budget — then re-run.</span></div>
      </div>
      <div style="display:flex;align-items:flex-start;gap:12px;padding:14px;background:#fef2f2;border-radius:8px;border-left:3px solid #ef4444;">
        <span style="font-size:20px;line-height:1;">🛑</span>
        <div><strong style="color:#991b1b;font-size:13px;">STOP</strong><br><span style="font-size:13px;color:#374151;line-height:1.6;">Under these parameters, most scenarios end in failure. The engine suggests alternative businesses that might work with your capital.</span></div>
      </div>
    </div>

    <p style="margin:0 0 20px;font-size:14px;color:#4b5563;line-height:1.65;"><strong>Pro tip:</strong> Run the same idea in all 4 engine modes — Balanced, Lean Survival, Aggressive Scale, and Investor View. The spread tells you how sensitive your model is to strategy.</p>

    <div style="text-align:center;margin-bottom:24px;">
      <a href="https://infini-cus.com/index.html" style="display:inline-block;background:#07080a;color:#00e676;text-decoration:none;font-family:monospace;font-weight:700;font-size:12px;padding:14px 28px;border-radius:8px;letter-spacing:.08em;">▶ RUN YOUR SIMULATION NOW →</a>
    </div>
    <p style="margin:0;font-size:12px;color:#9ca3af;">Reply to this email if you have any questions. We read every one.</p>
  </div>
  <div style="padding:14px 32px;border-top:1px solid #f3f4f6;background:#fafafa;"><p style="margin:0;font-size:11px;color:#9ca3af;">INFINICUS ENGINE · infini-cus.com · <a href="https://infini-cus.com/legal.html" style="color:#9ca3af;">Unsubscribe</a></p></div>
</div></body></html>`;
}

// ── DAY 7 ─────────────────────────────────────────────────────────────────────
function buildDay7(name) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8fafc;font-family:Inter,sans-serif;">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08);">
  <div style="background:#07080a;padding:28px 32px;">
    <div style="font-family:monospace;font-size:10px;color:#00e676;letter-spacing:.15em;margin-bottom:8px;">INFINICUS ENGINE v3 · DAY 7</div>
    <h1 style="margin:0;font-size:20px;font-weight:900;color:#fff;line-height:1.2;">What 500 Monte Carlo runs tell you that spreadsheets never could.</h1>
  </div>
  <div style="padding:28px 32px;">
    <p style="margin:0 0 18px;font-size:15px;color:#374151;line-height:1.65;">Hey ${name} — it's been a week. Here's something most founders don't know before they spend their first dollar:</p>

    <div style="background:#f9fafb;border-radius:8px;padding:20px;margin-bottom:20px;border:1px solid #e5e7eb;">
      <div style="font-family:monospace;font-size:10px;color:#6b7280;letter-spacing:.08em;margin-bottom:12px;">// WHAT THE DATA SHOWS</div>
      <div style="font-size:13px;color:#374151;line-height:1.8;">
        📊 <strong>The average survival rate</strong> for first-time founders in high-competition markets is <strong>31%</strong> — versus 68% for serial entrepreneurs.<br><br>
        💡 <strong>The single biggest lever:</strong> price. Increasing your price by 20% is almost always more powerful than doubling your marketing spend.<br><br>
        📍 <strong>Location matters more than people think.</strong> The same business in Lagos versus London can have 3× different fixed cost structures — that's now built into every simulation.<br><br>
        🔄 <strong>MODIFY isn't failure.</strong> 60% of GO verdicts start as MODIFY. Founders who iterate their inputs 3+ times have dramatically better outcomes.
      </div>
    </div>

    <p style="margin:0 0 16px;font-size:14px;color:#4b5563;line-height:1.65;">The engine now includes a <strong>10-section Business Plan PDF export</strong>, a <strong>Break-Even Reverse Calculator</strong>, and a <strong>6-month / 12-month extended forecast</strong>. Run a simulation and explore them.</p>

    <div style="text-align:center;margin-bottom:24px;">
      <a href="https://infini-cus.com/index.html" style="display:inline-block;background:#07080a;color:#00e676;text-decoration:none;font-family:monospace;font-weight:700;font-size:12px;padding:14px 28px;border-radius:8px;letter-spacing:.08em;">▶ SIMULATE YOUR IDEA →</a>
    </div>
    <p style="margin:0 0 12px;font-size:14px;color:#374151;line-height:1.65;"><strong>One ask:</strong> What business idea are you working on? Hit reply and tell us — we read every response and sometimes share useful data back.</p>
    <p style="margin:0;font-size:12px;color:#9ca3af;">After today, you'll only hear from us when there's a significant update or your plan opens. No spam.</p>
  </div>
  <div style="padding:14px 32px;border-top:1px solid #f3f4f6;background:#fafafa;"><p style="margin:0;font-size:11px;color:#9ca3af;">INFINICUS ENGINE · infini-cus.com · <a href="https://infini-cus.com/legal.html" style="color:#9ca3af;">Unsubscribe</a></p></div>
</div></body></html>`;
}
