// src/slugify.js — convierte un nombre humano en slug URL-friendly.
//
// Reusado en:
//   - control-plane/src/routes/boxes.js (auto-suggest de box slug al crear)
//   - portal/src/ui-partials/app-script.html.txt (auto-suggest de tenant slug)
//
// Reglas:
//   - lowercase.
//   - strip diacríticos (NFD + remove combining marks).
//   - caracteres no permitidos → guion. Solo [a-z0-9_-] sobreviven.
//   - trim leading/trailing guiones.
//   - max 60 chars (consistente con TENANT_SLUG_REGEX max 32 y BOX_SLUG max 64).
//   - fallback 'box' si el resultado queda vacío (todo eran símbolos).
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'box'
}