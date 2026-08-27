// scripts/nanoid-stub.mjs — stub para esbuild del per-box script.
//
// nanoid usa node:crypto internamente (no compatible con Workers isolate).
// Como el per-box script solo necesita las funciones de runtime-core
// (que no requieren nanoid — id.js solo se usa en el control-plane para
// generar boxIds/shareIds), podemos stubear el paquete.
// Si @htmlbox/shared empieza a usar nanoid en un módulo que runtime-core
// importa, este stub va a romperse. Hay que actualizar.
export const customAlphabet = () => () => 'STUB_NOT_FOR_PRODUCTION_USE'
export const nanoid = () => 'STUB_NOT_FOR_PRODUCTION_USE'
export default () => 'STUB_NOT_FOR_PRODUCTION_USE'
