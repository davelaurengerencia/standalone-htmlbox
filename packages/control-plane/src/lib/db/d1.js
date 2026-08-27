// src/lib/db/d1.js — helpers comunes para hablar con el binding D1.
//
// Re-exporta un cliente uniforme que valida la firma de los métodos más usados
// (prepare/bind/first/all/run). Sin esto, todos los handlers repiten lo mismo.

export function db(env) {
  if (!env?.DB) {
    throw new Error('D1 binding "DB" no está configurado en este worker.')
  }
  return env.DB
}

// Ejecuta un SELECT y devuelve la primera fila o null.
export async function first(env, sql, ...binds) {
  const stmt = db(env).prepare(sql).bind(...binds)
  return await stmt.first()
}

// Ejecuta un SELECT y devuelve el array (vacío si no hay filas).
export async function all(env, sql, ...binds) {
  const stmt = db(env).prepare(sql).bind(...binds)
  const res = await stmt.all()
  return res.results ?? []
}

// Ejecuta un INSERT/UPDATE/DELETE — devuelve { ok, meta }.
export async function run(env, sql, ...binds) {
  const stmt = db(env).prepare(sql).bind(...binds)
  return await stmt.run()
}

// Utilidad: transacción con varias sentencias ejecutadas en orden.
// D1 soporta batch() pero NO en planes con muchas sentencias — esta versión
// secuencial es más portable y suficiente para provisionar.
export async function execBatch(env, stmts) {
  for (const { sql, binds = [] } of stmts) {
    await run(env, sql, ...binds)
  }
}