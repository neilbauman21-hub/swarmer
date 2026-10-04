// Cloudflare Worker entry: serves the built game from static assets, the two AI endpoints,
// and the multiplayer rooms (Durable Objects, see room.ts).

import { onRequestPost as swarm } from '../functions/api/swarm';
import { onRequestPost as design } from '../functions/api/design';
import { Matchmaker, Room, newCode } from './room';

export { Matchmaker, Room };

interface Env {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  ASSETS: { fetch(req: Request): Promise<Response> };
  ROOMS: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  SWARM_MODELS?: string;
}

const CODE = /^[A-Z2-9]{5}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === '/api/swarm' || pathname === '/api/design') {
      if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
      return pathname === '/api/swarm' ? swarm({ request, env }) : design({ request, env });
    }
    if (pathname === '/api/quick') {
      return env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global')).fetch(request);
    }
    if (pathname === '/api/new') return Response.json({ code: newCode() });
    const m = pathname.match(/^\/api\/room\/([A-Za-z0-9]{5})$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE.test(code)) return new Response('Bad room code', { status: 400 });
      url.searchParams.set('code', code);
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(url.toString(), request));
    }
    return env.ASSETS.fetch(request);
  },
};
