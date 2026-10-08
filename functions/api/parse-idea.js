// functions/api/parse-idea.js
// Cloudflare Pages Function — parse business idea from uploaded image
// Uses Cloudflare Workers AI vision model (llama-3.2-11b-vision-instruct)
// Bound via Pages dashboard: AI binding name = "AI"
//
// Hardened in PR-C: exact-origin allowlist instead of wildcard CORS; per-IP and global abuse limits (the model call is the
// cost); upload size capped before reading; image type decided from magic bytes, never from the client-declared MIME type;
// internal error messages are no longer returned to the caller.
// Env: ALLOWED_ORIGINS (required), INFINICUS_WAITLIST (counters, required), AI binding (optional: fallback answer if absent)

import { gate, intEnv, sniffImageType } from '../_shared/route.js';
import { plainTextBlock } from '../_shared/escape.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

export async function onRequest(context) {
  const { request, env } = context;
  const g = await gate(context, {
    route: '/api/parse-idea',
    methods: ['POST'],
    limits: [
      { name: 'parse-ip', scope: 'ip', limit: intEnv(env, 'PARSE_IDEA_IP_PER_HOUR', 10), windowMs: 3_600_000 },
      { name: 'parse-all', scope: 'global', limit: intEnv(env, 'PARSE_IDEA_PER_DAY', 1000), windowMs: 86_400_000 },
    ],
  });
  if (!g.ok) return g.response;

  try {
    const type = (request.headers.get('Content-Type') ?? '').toLowerCase();
    if (!type.startsWith('multipart/form-data')) return g.respond(415, { error: 'Unsupported media type' });
    const declared = request.headers.get('Content-Length');
    if (declared === null || !/^\d{1,12}$/.test(declared)) return g.respond(400, { error: 'Invalid request' });
    if (Number(declared) > MAX_REQUEST_BYTES) return g.respond(413, { error: 'Image too large' });

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('image');

    if (!file || typeof file === 'string') {
      return g.respond(400, { error: 'No image provided' });
    }
    if (file.size > MAX_IMAGE_BYTES) return g.respond(413, { error: 'Image too large' });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = sniffImageType(bytes);
    if (!mimeType) {
      return g.respond(400, { error: 'Unsupported image type' });
    }

    // Convert to base64
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    // Check AI binding
    if (!env.AI) {
      // Fallback: return placeholder if AI not bound
      return g.respond(200, {
        idea: 'Image uploaded. AI parsing unavailable — please describe your business idea in the text box below.',
        fallback: true,
      });
    }

    // Call Workers AI vision model
    const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: base64,
            },
            {
              type: 'text',
              text: 'This image contains a business idea, business plan, pitch, or concept. Extract and summarize the core business idea in 2-4 concise sentences. Focus on: what the business does, who the customers are, and how it makes money. Reply with only the business idea summary, no preamble.',
            },
          ],
        },
      ],
      max_tokens: 300,
    });

    const idea = plainTextBlock(typeof response?.response === 'string' ? response.response.trim() : '', 1000);

    if (!idea) {
      return g.respond(422, { error: 'Could not extract idea from image — try a clearer image or type your idea directly.' });
    }

    return g.respond(200, { idea });

  } catch (err) {
    return g.respond(500, { error: 'Image analysis unavailable' });
  }
}
