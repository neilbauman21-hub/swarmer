// Cloudflare Worker entry: serves the built game from static assets, the two AI endpoints,
// and the endless multiplayer arena (a Durable Object, see arena.ts).

import { onRequestPost as swarm } from '../functions/api/swarm';
import { onRequestPost as design } from '../functions/api/design';
import { Arena } from './arena';

export { Arena };

interface Env {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  ASSETS: { fetch(req: Request): Promise<Response> };
  ARENA: DurableObjectNamespace;
  SWARM_MODELS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/swarm' || pathname === '/api/design') {
      if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
      return pathname === '/api/swarm' ? swarm({ request, env }) : design({ request, env });
    }
    if (pathname === '/api/arena') return env.ARENA.get(env.ARENA.idFromName('main')).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
