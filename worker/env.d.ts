// Minimal Cloudflare Workers runtime types used by the worker (avoids pulling in @cloudflare/workers-types,
// which clashes with the DOM lib the game itself compiles against).
declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}
interface WebSocket {
  accept(): void;
}
interface ResponseInit {
  webSocket?: WebSocket | null;
}
interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
