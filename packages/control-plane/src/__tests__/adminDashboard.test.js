// __tests__/adminDashboard.test.js — tests de la lógica del dashboard del
// control-plane admin (platform owner dashboard).
//
// Cubre:
//   - Validación de slug (regex mirror del backend).
//   - Helper _tenantSlugifyFromName (autosuggest).
//   - State machine del modal nuevo tenant.
//   - State machine del modal detalle (openTenantDetail cierra estado).
//   - formatRelativeTime (utilidad para fechas en la tabla).
//
// NO testeamos el HTML rendered — eso requeriría jsdom + Alpine runtime.
// Probamos la lógica que se ejecuta cuando el user interactúa con la UI.

import { test } from 'node:test'
import assert from 'node:assert/strict'

// Mirror de la lógica en app-script.html.txt. Si cambia allá, hay que
// cambiar acá también — exactamente la misma situación que el portal
// (test/test.ts tenantCreateModal). Tradeoff: duplicación explícita
// para evitar acoplar el test al bundle del Worker.

const TENANT_SLUG_REGEX = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/

function slugifyFromName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || ''
}

// ============ TENANT_SLUG_REGEX (mirror del backend) ============

test('TENANT_SLUG_REGEX acepta minúsculas con guion', () => {
  assert.equal(TENANT_SLUG_REGEX.test('confetex'), true)
  assert.equal(TENANT_SLUG_REGEX.test('acme-corp'), true)
  assert.equal(TENANT_SLUG_REGEX.test('abc123'), true)
})

test('TENANT_SLUG_REGEX rechaza mayúsculas / chars especiales / empieza con número', () => {
  assert.equal(TENANT_SLUG_REGEX.test('Confetex'), false)
  assert.equal(TENANT_SLUG_REGEX.test('1empresa'), false)
  assert.equal(TENANT_SLUG_REGEX.test('empresa corp'), false)
  assert.equal(TENANT_SLUG_REGEX.test('empresa!'), false)
})

test('TENANT_SLUG_REGEX bounds 3-32 chars', () => {
  assert.equal(TENANT_SLUG_REGEX.test('ab'), false)
  assert.equal(TENANT_SLUG_REGEX.test('abc'), true)
  assert.equal(TENANT_SLUG_REGEX.test('a' + 'b'.repeat(30) + 'c'), true)
  assert.equal(TENANT_SLUG_REGEX.test('a' + 'b'.repeat(31) + 'c'), false)
})

// ============ slugifyFromName ============

test('slugifyFromName lowercase + strip diacritics', () => {
  assert.equal(slugifyFromName('Confetex'), 'confetex')
  assert.equal(slugifyFromName('MI EMPRESA'), 'mi-empresa')
  assert.equal(slugifyFromName('Año 2026'), 'ano-2026')
})

test('slugifyFromName colapsa secuencias de símbolos', () => {
  assert.equal(slugifyFromName('foo  bar'), 'foo-bar')
  assert.equal(slugifyFromName('foo!!!bar'), 'foo-bar')
  assert.equal(slugifyFromName('foo___bar'), 'foo___bar', '_ es válido')
})

test('slugifyFromName fallback vacío', () => {
  assert.equal(slugifyFromName('!!!'), '')
  assert.equal(slugifyFromName(''), '')
})

// ============ formatRelativeTime ============

function formatRelativeTime(iso) {
  if (!iso) return '—'
  const t = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'))
  if (isNaN(t.getTime())) return iso
  const diffMs = Date.now() - t.getTime()
  const sec = Math.round(diffMs / 1000)
  if (sec < 60) return 'hace ' + sec + 's'
  const min = Math.round(sec / 60)
  if (min < 60) return 'hace ' + min + ' min'
  const hr = Math.round(min / 60)
  if (hr < 24) return 'hace ' + hr + 'h'
  const day = Math.round(hr / 24)
  if (day < 30) return 'hace ' + day + 'd'
  return t.toISOString().slice(0, 10)
}

test('formatRelativeTime devuelve "—" para null/empty', () => {
  assert.equal(formatRelativeTime(null), '—')
  assert.equal(formatRelativeTime(''), '—')
})

test('formatRelativeTime devuelve el ISO si no parsea', () => {
  assert.equal(formatRelativeTime('not-a-date'), 'not-a-date')
})

test('formatRelativeTime calcula correctamente las unidades', () => {
  const now = Date.now()
  assert.match(formatRelativeTime(new Date(now - 5 * 1000).toISOString()), /^hace \d+s$/)
  assert.match(formatRelativeTime(new Date(now - 5 * 60 * 1000).toISOString()), /^hace \d+ min$/)
  assert.match(formatRelativeTime(new Date(now - 3 * 60 * 60 * 1000).toISOString()), /^hace \d+h$/)
  assert.match(formatRelativeTime(new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()), /^hace \d+d$/)
})

test('formatRelativeTime: >30 días → fecha YYYY-MM-DD', () => {
  const far = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const out = formatRelativeTime(far)
  assert.match(out, /^\d{4}-\d{2}-\d{2}$/, 'debe ser ISO date corta')
})

// ============ Modal nuevo tenant state machine ============

function makeAppStub(overrides = {}) {
  return {
    user: { is_platform_owner: true, email: 'owner@x.com' },
    newTenant: { name: '', slug: '' },
    newTenantError: '',
    newTenantSlugTouched: false,
    tenantSlugValid: false,
    newTenantModalOpen: false,
    creatingTenant: false,
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
        this.showToast('Solo el platform owner puede crear tenants.')
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

test('openNewTenantModal: bloquea !platform_owner', () => {
  const app = makeAppStub({ user: { is_platform_owner: false, email: 'm@x' } })
  app.openNewTenantModal()
  assert.equal(app.newTenantModalOpen, false)
})

test('openNewTenantModal: platform owner → modal abre con state limpio', () => {
  const app = makeAppStub({ newTenant: { name: 'old', slug: 'old' }, newTenantError: 'old' })
  app.openNewTenantModal()
  assert.equal(app.newTenantModalOpen, true)
  assert.deepEqual(app.newTenant, { name: '', slug: '' })
  assert.equal(app.newTenantError, '')
  assert.equal(app.newTenantSlugTouched, false)
})

test('closeNewTenantModal limpia error + creatingTenant', () => {
  const app = makeAppStub({ newTenantModalOpen: true, newTenantError: 'x', creatingTenant: true })
  app.closeNewTenantModal()
  assert.equal(app.newTenantModalOpen, false)
  assert.equal(app.newTenantError, '')
  assert.equal(app.creatingTenant, false)
})

test('onTenantNameInput: autosuggest si NO fue tocado', () => {
  const app = makeAppStub()
  app.onTenantNameInput({ target: { value: 'Confetex Argentina' } })
  assert.equal(app.newTenant.name, 'Confetex Argentina')
  assert.equal(app.newTenant.slug, 'confetex-argentina')
  assert.equal(app.tenantSlugValid, true)
})

test('onTenantNameInput: respeta slug manual si touched', () => {
  const app = makeAppStub()
  app.onTenantSlugInput({ target: { value: 'company-prod' } })
  app.onTenantNameInput({ target: { value: 'Confetex' } })
  assert.equal(app.newTenant.name, 'Confetex')
  assert.equal(app.newTenant.slug, 'company-prod')
})

test('onTenantSlugInput: marca touched + recomputa validity', () => {
  const app = makeAppStub()
  app.onTenantSlugInput({ target: { value: 'mi-empresa' } })
  assert.equal(app.newTenantSlugTouched, true)
  assert.equal(app.tenantSlugValid, true)
  app.onTenantSlugInput({ target: { value: 'INVALID' } })
  assert.equal(app.tenantSlugValid, false)
})

test('createTenant: bloquea !platform_owner (defense-in-depth)', async () => {
  const app = makeAppStub({ user: { is_platform_owner: false } })
  app.newTenant = { name: 'X', slug: 'x-corp' }
  app.tenantSlugValid = true
  const out = await app.createTenant(async () => ({}))
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /platform owner/i)
})

test('createTenant: bloquea con name vacío', async () => {
  const app = makeAppStub()
  app.newTenant = { name: '   ', slug: 'ok-slug' }
  app.tenantSlugValid = true
  const out = await app.createTenant(async () => ({}))
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /Poné un nombre/)
})

test('createTenant: bloquea con slug inválido', async () => {
  const app = makeAppStub()
  app.newTenant = { name: 'Foo', slug: 'INVALID' }
  app.tenantSlugValid = false
  const out = await app.createTenant(async () => ({}))
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /Slug inválido/)
})

test('createTenant: happy path → POST + devuelve tenant', async () => {
  const app = makeAppStub()
  app.newTenant = { name: 'Confetex', slug: 'confetex' }
  app.tenantSlugValid = true
  let captured = null
  const apiFetch = async (path, opts) => {
    captured = { path, opts }
    return { tenant: { id: 'tenant_abc', slug: 'confetex', name: 'Confetex' } }
  }
  const out = await app.createTenant(apiFetch)
  assert.equal(out.ok, true)
  assert.equal(captured.path, '/api/tenants')
  assert.equal(captured.opts.method, 'POST')
  assert.deepEqual(captured.opts.body, { name: 'Confetex', slug: 'confetex' })
  assert.equal(app.creatingTenant, false)
})

test('createTenant: slug_taken del backend → mensaje claro', async () => {
  const app = makeAppStub()
  app.newTenant = { name: 'Confetex', slug: 'confetex' }
  app.tenantSlugValid = true
  const out = await app.createTenant(async () => ({ error: 'slug_taken' }))
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /Ya hay un tenant con ese slug/)
})

test('createTenant: error code desconocido → genérico', async () => {
  const app = makeAppStub()
  app.newTenant = { name: 'Foo', slug: 'foo' }
  app.tenantSlugValid = true
  const out = await app.createTenant(async () => ({ error: 'weird_thing' }))
  assert.equal(out.ok, false)
  assert.match(app.newTenantError, /weird_thing/)
})

// ============ Modal detalle tenant ============

test('openTenantDetail: setea currentTenant y abre el modal', async () => {
  const app = makeAppStub({
    tenantDetail: null,
    tenantDetailModalOpen: false,
    currentTenant: null,
    loadingTenantDetail: false,
    openTenantDetail: async function (t) {
      this.currentTenant = t
      this.tenantDetailModalOpen = true
      this.tenantDetail = null
      this.loadingTenantDetail = true
      try {
        const wsData = await fetch(`/api/tenants/${t.id}/workspaces`)
      } catch {}
      // No seteamos tenantDetail para simular que la respuesta falló.
      this.loadingTenantDetail = false
    },
    closeTenantDetail() {
      this.tenantDetailModalOpen = false
    },
  })
  await app.openTenantDetail({ id: 'tenant_xyz', name: 'Confetex', slug: 'confetex' })
  assert.equal(app.currentTenant.id, 'tenant_xyz')
  assert.equal(app.tenantDetailModalOpen, true)
})

test('closeTenantDetail: cierra el modal', () => {
  const app = makeAppStub({
    tenantDetailModalOpen: true,
    closeTenantDetail() { this.tenantDetailModalOpen = false },
  })
  app.closeTenantDetail()
  assert.equal(app.tenantDetailModalOpen, false)
})