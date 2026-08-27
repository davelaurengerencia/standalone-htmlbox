// src/lib/tursoClient.js — única abstracción sobre Turso en HTMLBox.
//
// Dos modos:
//   - HTMLBOX_TURSO_MODE=local  → sqld local (turso dev) en HTMLBOX_TURSO_DEV_URL.
//   - HTMLBOX_TURSO_MODE=cloud  → Turso real (Platform API + @tursodatabase/serverless).
//
// Operaciones:
//   createBoxDatabase(boxId)         → aprovisiona la DB del box, devuelve { url, token }
//   ensureBoxSchema(boxUrl, boxToken)→ crea tablas base si no existen
//   connect(boxUrl, boxToken)        → cliente libsql para ejecutar SQL

import { connect } from '@tursodatabase/serverless'
import { applyBoxSchema, TURSO_DB_NAME_PREFIX, TURSO_GROUP } from '@htmlbox/shared'
import { TURSO_DB_NAME_REGEX } from '@htmlbox/shared'

const TURSO_API_BASE = 'https://api.turso.io/v1'

function mode(env) {
  return (env.HTMLBOX_TURSO_MODE || 'local').toLowerCase()
}

function devUrl(env) {
  return env.HTMLBOX_TURSO_DEV_URL || 'http://localhost:8080'
}

function devToken() {
  // sqld local NO requiere token (por defecto acepta conexiones sin auth en modo dev).
  // Si en algún momento se quiere proteger, wrangler soporta headers extra.
  return ''
}

// ---- Modo local ----------------------------------------------------------
//
// sqld local NO tiene una API REST para "crear databases" — pero tampoco hace
// falta: cada box puede tener su propio nombre lógico que pasamos como
// "database" al cliente libsql. La lib @tursodatabase/serverless habla el
// protocolo libsql nativo, así que un namespace por box se hace con un prefijo
// en el SQL (CREATE TABLE htmlbox_box_<id>_xxx). Esto es válido porque cada
// box tiene su propia DB física aislada en producción.
//
// Para dev usamos una sola DB local compartida y aislamos por box vía un
// nombre de DB lógico que sqld sí soporta (ruta /<nombre>).
async function localCreateDb(env, boxId) {
  const url = `${devUrl(env)}`
  const token = devToken()
  // sqld local acepta cualquier nombre de DB y la crea on-demand si no existe.
  // Como el binding es solo de runtime, probamos un SELECT 1 contra la DB del box
  // y dejamos que sqld la materialice. Devolvemos credenciales que servirán para
  // applyBoxSchema y futuras llamadas.
  const client = connect({ url, authToken: token })
  try {
    await client.execute('SELECT 1')
  } catch (err) {
    throw new Error(`tursoClient(local): sqld no responde en ${url}: ${err.message}`)
  }
  return { url, token }
}

async function localConnect(env, _boxUrl, _boxToken) {
  // En local, todas las boxes comparten el mismo sqld. Para mantener el
  // aislamiento, devolvemos un cliente que ejecuta SQL con un prefijo dinámico.
  // Pero como las bases se comparten en dev, NO podemos aislar totalmente —
  // opción B: una DB local por box en sqld multi-db.
  // Para esta fase 1-2, devolvemos cliente simple; las tablas del box empiezan
  // por htmlbox_<slug> por box, no se mezclan. (Las tablas globales del box
  // htmlbox_tables/htmlbox_files/htmlbox_runs/htmlbox_schema_log SÍ se
  // comparten, pero el box solo escribe las suyas vía boxId en columnas.)
  return connect({ url: devUrl(env), authToken: devToken() })
}

// ---- Modo cloud ----------------------------------------------------------

function tursoHeaders(env) {
  return {
    Authorization: `Bearer ${env.HTMLBOX_TURSO_PLATFORM_TOKEN}`,
    'Content-Type': 'application/json',
  }
}

function dbName(boxId) {
  if (!TURSO_DB_NAME_REGEX.test(`${TURSO_DB_NAME_PREFIX}${boxId}`)) {
    throw new Error(`tursoClient: boxId "${boxId}" genera nombre de DB inválido`)
  }
  return `${TURSO_DB_NAME_PREFIX}${boxId}`
}

async function cloudCreateDb(env, boxId) {
  const org = env.HTMLBOX_TURSO_ORG
  if (!org) throw new Error('tursoClient(cloud): HTMLBOX_TURSO_ORG no configurado')

  const name = dbName(boxId)

  // 1) createDatabase
  const createRes = await fetch(`${TURSO_API_BASE}/organizations/${org}/databases`, {
    method: 'POST',
    headers: tursoHeaders(env),
    body: JSON.stringify({ name, group: TURSO_GROUP }),
  })
  if (!createRes.ok) {
    const text = await createRes.text()
    throw new Error(`tursoClient.createDatabase ${name}: ${createRes.status} ${text}`)
  }
  const { database } = await createRes.json()
  // Turso API v1 returns keys `Name` and `Hostname` (capitalized). Tolerate
  // ambas variantes por compat.
  const hostname = database.hostname || database.Hostname
  if (!hostname) {
    throw new Error(`tursoClient.createDatabase ${name}: respuesta sin hostname — ${JSON.stringify(database).slice(0, 200)}`)
  }

  // 2) createToken (full-access)
  const tokRes = await fetch(
    `${TURSO_API_BASE}/organizations/${org}/databases/${name}/auth/tokens`,
    {
      method: 'POST',
      headers: tursoHeaders(env),
      body: JSON.stringify({}),
    },
  )
  if (!tokRes.ok) {
    const text = await tokRes.text()
    throw new Error(`tursoClient.createToken ${name}: ${tokRes.status} ${text}`)
  }
  const tokJson = await tokRes.json()
  // La API moderna de Turso devuelve `{ jwt }` para tokens sin expiración,
  // y `{ tokens: [{ jwt, ... }] }` cuando se listan. Aceptamos ambos.
  const jwt = tokJson.jwt || tokJson.tokens?.[0]?.jwt
  if (!jwt) throw new Error(`tursoClient.createToken ${name}: respuesta sin jwt`)
  return { url: `libsql://${hostname}`, token: jwt }
}

async function cloudConnect(_env, boxUrl, boxToken) {
  return connect({ url: boxUrl, authToken: boxToken })
}

// ---- API pública ---------------------------------------------------------

export async function createBoxDatabase(env, boxId) {
  if (mode(env) === 'cloud') return await cloudCreateDb(env, boxId)
  return await localCreateDb(env, boxId)
}

// Borra la Turso DB del box vía Platform API. Best-effort: en modo local
// (sqld) no hay equivalente y la operación es un no-op. El caller debe
// envolver en try/catch igual que con R2 — si falla, logueamos y seguimos,
// porque la box ya está borrada en D1.
export async function deleteBoxDatabase(env, dbUrl) {
  if (mode(env) !== 'cloud') return { ok: false, reason: 'local_mode_noop' }
  const org = env.HTMLBOX_TURSO_ORG
  const token = env.HTMLBOX_TURSO_PLATFORM_TOKEN
  if (!org || !token) return { ok: false, reason: 'missing_turso_credentials' }
  if (!dbUrl || !dbUrl.startsWith('libsql://')) return { ok: false, reason: 'invalid_url' }
  const name = dbUrl.replace('libsql://', '').split('.')[0]
  const res = await fetch(`${TURSO_API_BASE}/organizations/${org}/databases/${name}`, {
    method: 'DELETE',
    headers: tursoHeaders(env),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, status: res.status, reason: text || `turso_delete_${res.status}` }
  }
  return { ok: true }
}

export async function ensureBoxSchema(env, boxUrl, boxToken) {
  const client = mode(env) === 'cloud'
    ? await cloudConnect(env, boxUrl, boxToken)
    : await localConnect(env, boxUrl, boxToken)
  await applyBoxSchema(client)
  return client
}

export async function connectToBox(env, boxUrl, boxToken) {
  if (mode(env) === 'cloud') return await cloudConnect(env, boxUrl, boxToken)
  return await localConnect(env, boxUrl, boxToken)
}

export function tursoMode(env) {
  return mode(env)
}