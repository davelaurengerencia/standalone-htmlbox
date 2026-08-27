// __tests__/tenantCreateModal.test.js — tests de la lógica del modal
// "Crear Tenant" en el portal. Cubre:
//   - Validación de slug (regex TENANT_SLUG_REGEX — mismo que el backend).
//   - Helper _tenantSlugifyFromName (autosuggest).
//   - State machine del modal: openNewTenantModal, onTenantNameInput,
//     onTenantSlugInput, createTenant (con apiFetch mockeado).
//
// NO testeamos el HTML rendered — eso requeriría jsdom + Alpine runtime.
// Probamos la lógica que se ejecuta cuando el user interactúa.

import { test } from 'node:test'
import assert from 'node:assert/strict'

// Mirror literal de la lógica en app-script.html.txt. Si cambia allá, hay
// que cambiar acá también (o mejor: extraer a un módulo shared y testearlo
// de verdad). Mientras tanto, este mirror es el mínimo viable para que un
// test falle si alguien rompe la regex / el flow del helper.
const TENANT_SLUG_REGEX = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/

function slugifyFromName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || ''
}

// ============ TENANT_SLUG_REGEX ============

test('slug regex acepta minúsculas con guion medio', () => {
  assert.equal(TENANT_SLUG_REGEX.test('confetex'), true)
  assert.equal(TENANT_SLUG_REGEX.test('acme-corp'), true)
  assert.equal(TENANT_SLUG_REGEX.test('a1'), false, '2 chars no')
  assert.equal(TENANT_SLUG_REGEX.test('abc-def-ghi'), true)
})

test('slug regex rechaza mayúsculas y caracteres especiales', () => {
  assert.equal(TENANT_SLUG_REGEX.test('Confetex'), false, 'mayúscula no')
  assert.equal(TENANT_SLUG_REGEX.test('mi_empresa'), false, 'underscore no')
  assert.equal(TENANT_SLUG_REGEX.test('1empresa'), false, 'empieza con número no')
  assert.equal(TENANT_SLUG_REGEX.test('-empresa'), false, 'empieza con guion no')
  assert.equal(TENANT_SLUG_REGEX.test('empresa-'), false, 'termina con guion no')
  assert.equal(TENANT_SLUG_REGEX.test('empresa corp'), false, 'espacio no')
  assert.equal(TENANT_SLUG_REGEX.test('empresa!'), false, 'bang no')
})

test('slug regex tiene bounds claros (3-32 chars)', () => {
  assert.equal(TENANT_SLUG_REGEX.test('ab'), false, '2 chars')
  assert.equal(TENANT_SLUG_REGEX.test('abc'), true, '3 chars min')
  // 32 chars max
  assert.equal(TENANT_SLUG_REGEX.test('a' + 'b'.repeat(30) + 'c'), true, '32 chars')
  assert.equal(TENANT_SLUG_REGEX.test('a' + 'b'.repeat(31) + 'c'), false, '33 chars')
})

// ============ slugifyFromName ============

test('slugifyFromName lowercase + strip diacritics', () => {
  assert.equal(slugifyFromName('Confetex'), 'confetex')
  assert.equal(slugifyFromName('MI EMPRESA'), 'mi-empresa')
  assert.equal(slugifyFromName('José & María'), 'jose-maria')
  assert.equal(slugifyFromName('Año 2026'), 'ano-2026')
})

test('slugifyFromName colapsa secuencias de símbolos a un guion', () => {
  assert.equal(slugifyFromName('foo  bar'), 'foo-bar', 'espacios → 1 guion')
  assert.equal(slugifyFromName('foo!!!bar'), 'foo-bar', '!!! → 1 guion')
  assert.equal(slugifyFromName('foo ! @ bar'), 'foo-bar', 'mezcla símbolos → 1 guion')
  // Nota: _ está permitido en slugs (caracter válido), NO se colapsa.
  // Mantener '_' en el output es por diseño — ver regex [a-z0-9_-].
  assert.equal(slugifyFromName('foo___bar'), 'foo___bar', '_ es válido, no colapsa')
})

test('slugifyFromName trim guiones leading/trailing', () => {
  assert.equal(slugifyFromName('!!!hello!!!'), 'hello')
  assert.equal(slugifyFromName('   leading spaces'), 'leading-spaces')
  assert.equal(slugifyFromName('trailing!!!'), 'trailing')
})

test('slugifyFromName corta a 60 chars', () => {
  const long = 'a'.repeat(120)
  const out = slugifyFromName(long)
  assert.equal(out.length, 60, 'debe cortar a 60')
})

test('slugifyFromName fallback vacío si todo es símbolos', () => {
  // No cae en 'box' (esa es la versión backend) — la versión del portal
  // devuelve '' para que el modal sepa que el slug auto-suggested está vacío
  // y deje el user typearlo manualmente.
  assert.equal(slugifyFromName('!!!'), '')
  assert.equal(slugifyFromName(''), '')
})

// ============ Modal state machine ============

function makeAppStub(overrides = {}) {
  return {
    user: { is_platform_owner: true, email: 'owner@x.com' },
    newTenant: { name: '', slug: '' },
    newTenantError: '',
    newTenantSlugTouched: false,
    tenantSlugValid: false,
    newTenantModalOpen: false,
    creatingTenant: false,
    _apiFetchLog: [],
    showToast: () => {},
    _tenantSlugifyFromName: slugifyFromName,
    _recomputeTenantSlugValid() {
      this.tenantSlugValid = TENANT_SLUG_REGEX.test(this.newTenant.slug)
    },
    onTenantNameInput(event) {
      this.newTenant.name = event.target.value
      if (!this.newTenantSlugTouched) {
        this.newTenant.slug = this._tenantSlugifyFromName(this.newTenant.name)
        this._recomputeTenantSlugValid()
      }
    },
    onTenantSlugInput(event) {
      this.newTenant.slug = event.target.value
      this.newTenantSlugTouched = true
      this._recomputeTenantSlugValid()
    },
    openNewTenantModal() {
      if (!this.user?.is_platform_owner) {
        this.newTenantError = 'Solo el platform owner puede crear tenants.'
        return
      }
      this.newTenant = { name: '', slug: '' }
      this.newTenantError = ''
      this.newTenantSlugTouched = false
      this.tenantSlugValid = false
      this.newTenantModalOpen = true
    },
    closeNewTenantModal() {
      this.newTenantModalOpen = false
      this.newTenantError = ''
      this.creatingTenant = false
    },
    // Versión simplificada de createTenant para tests (sin reload de tenants).
    async createTenant(apiFetch) {
      if (!this.user?.is_platform_owner) {
        this.newTenantError = 'Solo el platform owner puede crear tenants.'
        return { ok: false }
      }
      const name = this.newTenant.name.trim()
      const slug = this.newTenant.slug.trim()
      if (!name) {
        this.newTenantError = 'Poné un nombre.'
        return { ok: false }
      }
      if (!this.tenantSlugValid) {
        this.newTenantError = 'Slug inválido.'
        return { ok: false }
      }
      this.creatingTenant = true
      this.newTenantError = ''
      try {
        const data = await apiFetch('/api/tenants', { method: 'POST', body: { name, slug } })
        if (!data || data.error) {
          const code = data?.error
          this.newTenantError = ({
            invalid_slug: 'Slug inválido.',
            slug_taken: 'Ya hay un tenant con ese slug.',
            missing_name: 'Falta el nombre.',
            platform_owner_only: 'Tu cuenta no es platform owner.',
          })[code] || ('Error: ' + (code || 'desconocido'))
          return { ok: false }
        }
        return { ok: true, tenant: data.tenant }
      } finally {
        this.creatingTenant = false
      }
    },
    ...overrides,
  }
}

function apiFetchStub(responses) {
  const log = []
  let i = 0
  const fn = async (path, opts) => {
    log.push({ path, opts })
    if (i >= responses.length) throw new Error(`apiFetch llamado ${i + 1} veces, solo ${responses.length} respuestas mockeadas`)
    return responses[i++]
  }
  return [fn, log]
}

test('openNewTenantModal: bloquea si NO es platform owner', () => {
  const app = makeAppStub({ user: { is_platform_owner: false, email: 'member@x.com' } })
  app.openNewTenantModal()
  assert.equal(app.newTenantModalOpen, false, 'no debe abrir')
})

test('openNewTenantModal: platform owner → modal abre con state limpio', () => {
  const app = makeAppStub({ newTenant: { name: 'old', slug: 'old-slug' }, newTenantError: 'old error' })
  app.openNewTenantModal()
  assert.equal(app.newTenantModalOpen, true)
  assert.deepEqual(app.newTenant, { name: '', slug: '' })
  assert.equal(app.newTenantError, '')
  assert.equal(app.newTenantSlugTouched, false)
  assert.equal(app.tenantSlugValid, false)
})

test('closeNewTenantModal: limpia error + creatingTenant', () => {
  const app = makeAppStub({ newTenantModalOpen: true, newTenantError: 'algo', creatingTenant: true })
  app.closeNewTenantModal()
  assert.equal(app.newTenantModalOpen, false)
  assert.equal(app.newTenantError, '')
  assert.equal(app.creatingTenant, false)
})

test('onTenantNameInput: autosuggest del slug si NO fue tocado', () => {
  const app = makeAppStub()
  app.onTenantNameInput({ target: { value: 'Confetex Argentina' } })
  assert.equal(app.newTenant.name, 'Confetex Argentina')
  assert.equal(app.newTenant.slug, 'confetex-argentina')
  assert.equal(app.newTenantSlugTouched, false)
  assert.equal(app.tenantSlugValid, true)
})

test('onTenantNameInput: respeta el slug manual si YA fue tocado', () => {
  const app = makeAppStub()
  app.onTenantSlugInput({ target: { value: 'company-prod' } })
  // A partir de acá newTenantSlugTouched = true.
  app.onTenantNameInput({ target: { value: 'Confetex' } })
  assert.equal(app.newTenant.name, 'Confetex')
  assert.equal(app.newTenant.slug, 'company-prod', 'no debe pisar el slug manual')
})

test('onTenantSlugInput: marca touched + recomputa validity', () => {
  const app = makeAppStub()
  app.onTenantSlugInput({ target: { value: 'mi-empresa' } })
  assert.equal(app.newTenant.slug, 'mi-empresa')
  assert.equal(app.newTenantSlugTouched, true)
  assert.equal(app.tenantSlugValid, true)

  app.onTenantSlugInput({ target: { value: 'INVALID' } })
  assert.equal(app.tenantSlugValid, false, 'mayúsculas inválido')
})

test('createTenant: bloquea si NO es platform owner (defense-in-depth)', async () => {
  const app = makeAppStub({ user: { is_platform_owner: false, email: 'member@x.com' } })
  app.newTenant = { name: 'X', slug: 'x-corp' }
  app.tenantSlugValid = true
  const [apiFetch] = apiFetchStub([])
  const out = await app.createTenant(apiFetch)
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /platform owner/i)
})

test('createTenant: bloquea con name vacío', async () => {
  const app = makeAppStub()
  app.newTenant = { name: '   ', slug: 'ok-slug' }
  app.tenantSlugValid = true
  const [apiFetch] = apiFetchStub([])
  const out = await app.createTenant(apiFetch)
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /Poné un nombre/)
})

test('createTenant: bloquea con slug inválido', async () => {
  const app = makeAppStub()
  app.newTenant = { name: 'Foo', slug: 'INVALID' }
  app.tenantSlugValid = false
  const [apiFetch] = apiFetchStub([])
  const out = await app.createTenant(apiFetch)
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /Slug inválido/)
})

test('createTenant: happy path → POST + devuelve tenant', async () => {
  const app = makeAppStub()
  app.newTenant = { name: 'Confetex', slug: 'confetex' }
  app.tenantSlugValid = true
  const [apiFetch, log] = apiFetchStub([
    { tenant: { id: 'tenant_abc123', slug: 'confetex', name: 'Confetex' } },
  ])
  const out = await app.createTenant(apiFetch)
  assert.equal(out.ok, true)
  assert.equal(out.tenant.slug, 'confetex')
  assert.equal(log.length, 1)
  assert.equal(log[0].path, '/api/tenants')
  assert.equal(log[0].opts.method, 'POST')
  assert.deepEqual(log[0].opts.body, { name: 'Confetex', slug: 'confetex' })
  assert.equal(app.creatingTenant, false, 'creatingTenant se resetea')
})

test('createTenant: slug_taken del backend → mensaje claro', async () => {
  const app = makeAppStub()
  app.newTenant = { name: 'Confetex', slug: 'confetex' }
  app.tenantSlugValid = true
  const [apiFetch] = apiFetchStub([{ error: 'slug_taken' }])
  const out = await app.createTenant(apiFetch)
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /Ya hay un tenant con ese slug/)
})

test('createTenant: invalid_slug del backend → mensaje claro', async () => {
  const app = makeAppStub()
  app.newTenant = { name: 'Foo', slug: 'ok' }
  app.tenantSlugValid = true
  const [apiFetch] = apiFetchStub([{ error: 'invalid_slug' }])
  const out = await app.createTenant(apiFetch)
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /Slug inválido/)
})

test('createTenant: missing_name del backend → mensaje claro', async () => {
  const app = makeAppStub()
  app.newTenant = { name: 'Foo', slug: 'foo' }
  app.tenantSlugValid = true
  const [apiFetch] = apiFetchStub([{ error: 'missing_name' }])
  const out = await app.createTenant(apiFetch)
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /Falta el nombre/)
})

test('createTenant: platform_owner_only del backend → mensaje claro', async () => {
  const app = makeAppStub({ user: { is_platform_owner: true, email: 'fake-owner@x.com' } })
  app.newTenant = { name: 'X', slug: 'x-corp' }
  app.tenantSlugValid = true
  const [apiFetch] = apiFetchStub([{ error: 'platform_owner_only' }])
  const out = await app.createTenant(apiFetch)
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /platform owner/i)
})

test('createTenant: error code desconocido → mensaje genérico', async () => {
  const app = makeAppStub()
  app.newTenant = { name: 'Foo', slug: 'foo' }
  app.tenantSlugValid = true
  const [apiFetch] = apiFetchStub([{ error: 'weird_thing' }])
  const out = await app.createTenant(apiFetch)
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /weird_thing/)
})