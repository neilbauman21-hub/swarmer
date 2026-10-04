// Cloudflare Worker entry: serves the built game from static assets and the two AI endpoints.
// Reuses the Pages Function handlers so both deploy targets behave the same.

import { onRequestPost as swarm } from '../functions/api/swarm';
import { onRequestPost as design } from '../functions/api/design';

interface Env {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  ASSETS: { fetch(req: Request): Promise<Response> };
  SWARM_MODELS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/swarm' || pathname === '/api/design') {
      if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
      return pathname === '/api/swarm' ? swarm({ request, env }) : design({ request, env });
    }
    return env.ASSETS.fetch(request);
  },
};
