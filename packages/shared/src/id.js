// src/id.js — generación de IDs únicos.
// boxId y otros IDs internos son URL-safe (sin ambigüedad en paths de R2/D1).

import { customAlphabet } from 'nanoid'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz' // sin mayúsculas, sin caracteres ambiguos
const SHORT_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789' // sin 0/o/1/l

export const boxId = customAlphabet(ALPHABET, 16)
export const userId = customAlphabet(ALPHABET, 12)
export const shareId = customAlphabet(ALPHABET, 10)
export const shortToken = customAlphabet(SHORT_ALPHABET, 12)

export const nowIso = () => new Date().toISOString()
export const nowUnix = () => Math.floor(Date.now() / 1000)

// Validador de slug de tenant (subdominio) — debe ser DNS-safe y lowercase.
export const TENANT_SLUG_REGEX = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/
export const isValidTenantSlug = (s) => typeof s === 'string' && TENANT_SLUG_REGEX.test(s)

// Slug de box dentro de un tenant — más permisivo, pero URI-safe.
export const BOX_SLUG_REGEX = /^[a-z][a-z0-9_-]{0,62}[a-z0-9]$/
export const isValidBoxSlug = (s) => typeof s === 'string' && BOX_SLUG_REGEX.test(s)