// Cloudflare Pages Function: POST /api/design  { prompt, unlocked } -> { design, model }
// Turns a description ("a fast hedgehog with spikes all round") into a construct blueprint.
// The browser validates the result again against what the player has actually researched.

import { designSystemPrompt, extractJson } from '../../src/ai/design-prompt';
import { PARTS } from '../../src/sim/parts';
import { replyText } from './swarm';

interface Env {
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  SWARM_MODELS?: string;
}

const DEFAULT_MODELS = ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-4-scout-17b-16e-instruct'];
const hits = new Map<string, number[]>(); // best-effort per-isolate rate limit
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.AI) return json({ error: 'The AI binding is not configured on this deployment.' }, 503);
  const ip = request.headers.get('cf-connecting-ip') ?? 'anon';
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 8) return json({ error: 'Too many designs in a minute. Give it a moment.' }, 429);
  recent.push(now);
  hits.set(ip, recent);
  let body: { prompt?: unknown; unlocked?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Send JSON: { "prompt": "..." }' }, 400);
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 500) : '';
  if (!prompt) return json({ error: 'Describe the construct you want first.' }, 400);
  const known = new Set(PARTS.map((p) => p.id));
  const unlocked = Array.isArray(body.unlocked) ? body.unlocked.filter((p): p is string => typeof p === 'string' && known.has(p)) : ['drone'];
  if (!unlocked.includes('drone')) unlocked.push('drone');

  const messages = [
    { role: 'system', content: designSystemPrompt(unlocked) },
    { role: 'user', content: prompt },
  ];
  const models = env.SWARM_MODELS ? env.SWARM_MODELS.split(',').map((m) => m.trim()).filter(Boolean) : DEFAULT_MODELS;
  const errors: string[] = [];
  for (const model of models) {
    try {
      const design = extractJson(replyText(await env.AI.run(model, { messages, max_tokens: 2000, temperature: 0.4 })));
      if (design && typeof design === 'object' && Array.isArray((design as { cells?: unknown }).cells)) return json({ design, model });
      errors.push(`${model}: no design JSON in reply`);
    } catch (err) {
      errors.push(`${model}: ${(err as Error).message}`);
    }
  }
  return json({ error: 'The model could not design that. Try describing it differently.', detail: errors }, 502);
}
