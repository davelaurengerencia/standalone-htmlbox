// src/namespacedKey.js — port del patrón de sivocloud (`control-plane/UPLOAD-DESIGN.md`).
//
// Toda key de R2 SIEMPRE empieza por `tenants/{tenantSlug}/...`. El cliente jamás compone
// el path: lo firma el control-plane, lo verifica el runtime, y `../` queda contenido
// dentro del propio namespace del box.

import { isValidTenantSlug, isValidBoxSlug } from './id.js'

const SAFE_SEGMENT = /^[a-zA-Z0-9_.\-]{1,200}$/

// Lanza si el segmento tiene caracteres no permitidos. NO acepta vacíos ni `..`.
function assertSegment(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`namespacedKey: segmento "${name}" vacío`)
  }
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new Error(`namespacedKey: segmento "${name}" contiene separadores o es traversal`)
  }
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`namespacedKey: segmento "${name}"="${value}" no es seguro`)
  }
}

// --- Helpers de cada nivel del namespace ------------------------------

export function tenantRoot(tenantSlug) {
  if (!isValidTenantSlug(tenantSlug)) {
    throw new Error(`namespacedKey: tenantSlug inválido "${tenantSlug}"`)
  }
  return `tenants/${tenantSlug}`
}

export function boxRoot(tenantSlug, boxId) {
  assertSegment('boxId', boxId)
  return `${tenantRoot(tenantSlug)}/boxes/${boxId}`
}

// Key de una versión de HTML del box:
//   tenants/{slug}/boxes/{boxId}/versions/v{N}.html
export function boxVersionKey(tenantSlug, boxId, version) {
  const n = Number(version)
  if (!Number.isInteger(n) || n < 1) throw new Error(`boxVersionKey: version inválida ${version}`)
  return `${boxRoot(tenantSlug, boxId)}/versions/v${n}.html`
}

// Key de un archivo de datos subido (CSV/XLSX/JSON):
//   tenants/{slug}/boxes/{boxId}/uploads/{fileId}/{filename}
export function boxUploadKey(tenantSlug, boxId, fileId, filename) {
  assertSegment('fileId', fileId)
  assertSegment('filename', filename)
  return `${boxRoot(tenantSlug, boxId)}/uploads/${fileId}/${filename}`
}

// Asset arbitrario del box:
//   tenants/{slug}/boxes/{boxId}/assets/{path}
export function boxAssetKey(tenantSlug, boxId, ...segments) {
  for (const s of segments) assertSegment('asset', s)
  return `${boxRoot(tenantSlug, boxId)}/assets/${segments.join('/')}`
}

// Exports generados por flows:
//   tenants/{slug}/_exports/{runId}/{filename}
export function tenantExportKey(tenantSlug, runId, filename) {
  assertSegment('runId', runId)
  assertSegment('filename', filename)
  return `${tenantRoot(tenantSlug)}/_exports/${runId}/${filename}`
}

// Verifica que una key arbitraria está dentro del namespace del box
// (defensa en profundidad por si alguien intenta apuntar a otro tenant).
export function isInsideBoxNamespace(key, tenantSlug, boxId) {
  const prefix = boxRoot(tenantSlug, boxId)
  return key === prefix || key.startsWith(prefix + '/')
}

export function isInsideTenantNamespace(key, tenantSlug) {
  const prefix = tenantRoot(tenantSlug)
  return key === prefix || key.startsWith(prefix + '/')
}