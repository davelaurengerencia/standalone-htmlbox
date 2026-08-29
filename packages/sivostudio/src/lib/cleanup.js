// src/lib/cleanup.js — limpieza de boxes abandonados.
//
// Llamado desde el cron trigger en src/worker.js#scheduled.
// Lista boxes con `last_seen < datetime('now', '-N days') AND deleted = 0`,
// los borra del namespace WFP y marca deleted=1 en D1.
//
// Best-effort: si deleteStudioBoxWorker falla (404 idempotente es OK),
// igual marca deleted=1. Si D1 UPDATE falla, logueamos y seguimos con
// el próximo box. El cleanup corre en un cron trigger — queremos que
// termine incluso si un box específico tenga problemas.
//
// Threshold override: env.HTMLBOX_STUDIO_CLEANUP_DAYS (default 30).

// Result shape — para logs/tests.
export function emptyResult() {
  return { scanned: 0, deleted: 0, failed: 0, errors: [] }
}

// Lista boxes candidatos para limpieza (default: 30 días sin actividad).
export async function listCleanupCandidates(env, thresholdDays) {
  const days = thresholdDays ?? parseInt(env.HTMLBOX_STUDIO_CLEANUP_DAYS || '30', 10)
  if (!env.STUDIO_D1) {
    throw new Error('cleanup: STUDIO_D1 binding no configurado')
  }
  const result = await env.STUDIO_D1.prepare(
    `SELECT box_id, name, script_name, last_seen, created_at
       FROM htmlbox_studio_boxes
      WHERE deleted = 0
        AND last_seen < datetime('now', '-' || ? || ' days')
      ORDER BY last_seen ASC
      LIMIT 100`
  ).bind(days).all()
  return { candidates: result.results || [], thresholdDays: days }
}

// Procesa UN candidato: borra del namespace y marca deleted=1 en D1.
// deps.deleteStudioBoxWorker permite inyectar mock en tests.
export async function cleanupBox(env, candidate, deps = {}) {
  let deleteFromWfp
  if (deps.deleteStudioBoxWorker) {
    deleteFromWfp = deps.deleteStudioBoxWorker
  } else {
    // Dynamic import para evitar ciclo si wfpDeployer importa algo de acá.
    const mod = await import('./wfpDeployer.js')
    deleteFromWfp = mod.deleteStudioBoxWorker
  }
  const boxId = candidate.box_id

  // 1) Borrar del namespace WFP. 404 es idempotente (script ya no existe).
  let wfpIdempotent = false
  try {
    const r = await deleteFromWfp(env, boxId)
    if (r && r.idempotent) wfpIdempotent = true
  } catch (e) {
    // No rompemos — devolvemos error, el caller decide si seguir.
    return { ok: false, boxId, step: 'wfp', reason: String(e) }
  }

  // 2) Marcar deleted=1 en D1 (best-effort).
  try {
    await env.STUDIO_D1.prepare(
      `UPDATE htmlbox_studio_boxes SET deleted = 1 WHERE box_id = ?`
    ).bind(boxId).run()
  } catch (e) {
    return { ok: false, boxId, step: 'd1', reason: String(e) }
  }

  return { ok: true, boxId, wfpIdempotent }
}

// Procesa todos los candidatos. Devuelve un summary con counts + errors.
export async function runCleanup(env, deps = {}) {
  const result = emptyResult()
  try {
    const { candidates, thresholdDays } = await listCleanupCandidates(env)
    result.scanned = candidates.length
    result.thresholdDays = thresholdDays
    for (const candidate of candidates) {
      const r = await cleanupBox(env, candidate, deps)
      if (r.ok) {
        result.deleted += 1
      } else {
        result.failed += 1
        result.errors.push({ box_id: r.boxId, step: r.step, reason: r.reason })
      }
    }
  } catch (e) {
    result.errors.push({ step: 'list', reason: String(e) })
  }
  return result
}