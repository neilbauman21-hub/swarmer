// Cloudflare Pages Function: POST /api/swarm  { prompt, context } -> { code, model }
// Turns a player's instruction into a swarm program with Workers AI.
// The model runs through the AI binding, so no API key ever reaches the browser.

import { SYSTEM_PROMPT, extractCode } from '../../src/ai/prompt';

interface Env {
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  SWARM_MODELS?: string; // optional comma-separated override
}

interface Ctx {
  request: Request;
  env: Env;
}

// Measured on the production prompt: llama-4-scout answers in ~7 s; gpt-oss-120b is slower but sturdier.
// Reasoning-first models (glm-4.7-flash, gpt-oss-20b, qwen3) spent the whole budget thinking and returned nothing.
const DEFAULT_MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/openai/gpt-oss-120b'];
const MAX_PROMPT = 500;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;
const hits = new Map<string, number[]>(); // best-effort per-isolate rate limit

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Different Workers AI models answer in different shapes. */
export function replyText(res: unknown): string {
  if (typeof res === 'string') return res;
  const r = res as Record<string, any>;
  if (typeof r?.response === 'string') return r.response;
  const choice = r?.choices?.[0];
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  if (typeof choice?.text === 'string') return choice.text;
  if (typeof r?.output_text === 'string') return r.output_text;
  if (Array.isArray(r?.output)) {
    for (const item of r.output) {
      for (const part of item?.content ?? []) if (typeof part?.text === 'string' && item.type !== 'reasoning') return part.text;
    }
  }
  return '';
}

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  if (!env.AI) return json({ error: 'The AI binding is not configured on this deployment.' }, 503);

  const ip = request.headers.get('cf-connecting-ip') ?? 'anon';
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) return json({ error: 'Too many orders in a minute. Give your swarm a moment.' }, 429);
  recent.push(now);
  hits.set(ip, recent);

  let body: { prompt?: unknown; context?: unknown; fix?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Send JSON: { "prompt": "..." }' }, 400);
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, MAX_PROMPT) : '';
  if (!prompt) return json({ error: 'Type an order for your swarm first.' }, 400);
  const context = typeof body.context === 'string' ? body.context.slice(0, 2500) : '';
  // Self-repair: the browser sends back a program that crashed or did nothing, with the reason.
  const fix = body.fix && typeof body.fix === 'object' ? (body.fix as { code?: unknown; error?: unknown }) : null;
  const fixNote = fix && typeof fix.code === 'string'
    ? `\n\nYour previous program for this order failed: ${String(fix.error ?? 'it issued no orders').slice(0, 300)}\nPrevious program:\n\`\`\`js\n${fix.code.slice(0, 4000)}\n\`\`\`\nWrite a corrected program.`
    : '';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Current game: ${context}\n\nPlayer order: ${prompt}${fixNote}` },
  ];
  const models = env.SWARM_MODELS ? env.SWARM_MODELS.split(',').map((m) => m.trim()).filter(Boolean) : DEFAULT_MODELS;
  const errors: string[] = [];
  for (const model of models) {
    try {
      const res = await env.AI.run(model, { messages, max_tokens: 1800, temperature: 0.2 });
      const code = extractCode(replyText(res));
      if (code.includes('function tick')) return json({ code, model });
      errors.push(`${model}: no tick function in reply`);
    } catch (err) {
      errors.push(`${model}: ${(err as Error).message}`);
    }
  }
  return json({ error: 'The model could not write a program for that order. Try rephrasing it.', detail: errors }, 502);
}
