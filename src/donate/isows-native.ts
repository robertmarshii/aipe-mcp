// Bundle stand-in for the isows package (pulled in by viem's barrel, never used for donations):
// Node 22's own WebSocket, so the ws package and its server code stay out of the bundle.
export const WebSocket = globalThis.WebSocket;
