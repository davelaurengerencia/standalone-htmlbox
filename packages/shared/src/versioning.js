// src/versioning.js — lógica de las "últimas 5 versiones" (§11.2).
//
// Regla fija: cada push crea una nueva versión. Si hay > MAX_BOX_VERSIONS, la
// más antigua se borra (R2 + D1). Rollback crea una nueva versión copiada —
// NUNCA destruye historial.

import { MAX_BOX_VERSIONS } from './constants.js'
import { boxVersionKey, isInsideBoxNamespace } from './namespacedKey.js'

// Incremento atómico de la versión activa.
// Implementación: SELECT htmlbox_version + UPDATE. El control-plane debería
// serializar por boxId si quiere atomicidad estricta (en práctica, las
// escrituras de un box vienen del mismo usuario).
export async function bumpVersion(db, boxId) {
  const row = await db.prepare(
    `SELECT htmlbox_version, tenant_id FROM htmlbox_boxes WHERE id = ?1`
  ).bind(boxId).first()

  if (!row) throw new Error(`versioning: box ${boxId} no existe`)

  const next = (row.htmlbox_version ?? 0) + 1
  await db.prepare(
    `UPDATE htmlbox_boxes SET htmlbox_version = ?1, updated_at = datetime('now') WHERE id = ?2`
  ).bind(next, boxId).run()

  return next
}

// Lista de versiones registradas en D1, ordenadas desc.
export async function listVersions(db, boxId) {
  const res = await db.prepare(
    `SELECT version, source, agent_name, summary, created_by, created_at
       FROM htmlbox_versions WHERE box_id = ?1 ORDER BY version DESC`
  ).bind(boxId).all()
  return res.results ?? []
}

// Lee el contenido de una versión específica (R2).
export async function readVersion(bucket, tenantSlug, boxId, version) {
  const key = boxVersionKey(tenantSlug, boxId, version)
  if (!isInsideBoxNamespace(key, tenantSlug, boxId)) {
    throw new Error('versioning: key fuera del namespace del box')
  }
  const obj = await bucket.get(key)
  if (!obj) return null
  return await obj.text()
}

// Purga la versión más antigua si el box supera el límite.
// Devuelve { purged: [versiones eliminadas] }.
export async function purgeIfOverLimit({ db, bucket, tenantSlug, boxId }) {
  const versions = await listVersions(db, boxId)
  if (versions.length <= MAX_BOX_VERSIONS) return { purged: [] }

  // versions ya viene DESC; las sobrantes son las del final.
  const toDelete = versions.slice(MAX_BOX_VERSIONS)
  const purged = []
  for (const v of toDelete) {
    const key = boxVersionKey(tenantSlug, boxId, v.version)
    await bucket.delete(key)
    await db.prepare(`DELETE FROM htmlbox_versions WHERE box_id = ?1 AND version = ?2`)
      .bind(boxId, v.version).run()
    purged.push(v.version)
  }
  return { purged }
}

// Registra una versión en D1 tras haber subido a R2.
export async function recordVersion({
  db, boxId, version, source, agentName, summary, userId,
}) {
  await db.prepare(`
    INSERT INTO htmlbox_versions (box_id, version, source, agent_name, summary, created_by)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).bind(boxId, version, source, agentName ?? null, summary, userId ?? null).run()
}

// Crea una versión nueva copiando el contenido de otra (rollback).
export async function rollbackTo({ db, bucket, tenantSlug, boxId, targetVersion, userId, agentName }) {
  const html = await readVersion(bucket, tenantSlug, boxId, targetVersion)
  if (html === null) throw new Error(`rollback: versión ${targetVersion} no encontrada`)

  const next = await bumpVersion(db, boxId)
  const newKey = boxVersionKey(tenantSlug, boxId, next)
  await bucket.put(newKey, html, { httpMetadata: { contentType: 'text/html' } })

  await recordVersion({
    db, boxId, version: next,
    source: 'rollback',
    agentName, summary: `Rollback a v${targetVersion}`,
    userId,
  })
  await purgeIfOverLimit({ db, bucket, tenantSlug, boxId })

  return { version: next, html }
}