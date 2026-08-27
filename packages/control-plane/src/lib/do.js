// src/lib/do.js — placeholder de Durable Object (fase 4).
// Se mantiene aquí solo para que wrangler.jsonc lo pueda declarar cuando
// llegue el momento.

export class ControlPlaneDO {
  constructor(_state, _env) {}
  async fetch() { return new Response('not used', { status: 404 }) }
}