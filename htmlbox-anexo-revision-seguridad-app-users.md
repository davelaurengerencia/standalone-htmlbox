# HTMLBox — Anexo: revisión de seguridad de "usuarios de las apps" (fases 1-3)

Anexo a `htmlbox-spec-app-users-IMPLEMENTED.md`, `htmlbox-spec-app-customers-IMPLEMENTED.md` y `htmlbox-spec-app-users-centralized-IMPLEMENTED.md`. Auditoría de seguridad sobre la implementación real, commits `e709872` (fase 1+2) y `ebc9391` (fase 3). No reemplaza esas specs — son 4 hallazgos puntuales a corregir antes de dar el trabajo por cerrado.

## 1. CRÍTICO — el admin de usuarios centralizados no chequea rol

**Archivo:** `packages/control-plane/src/routes/tenantAppUsers.js`

`requireUser()` solo exige sesión de plataforma válida — no valida rol. Ningún handler (`createTenantAppUser`, `grantAccess`, `revokeAccess`, `deleteTenantAppUser`) llama `assertTenantScope`/`requireRole`, pese a que el archivo los importa (`session.js`) y nunca los usa. Mismo patrón en `packages/control-plane/src/routes/internal.js`: importa `requireRole, assertTenantScope` y tampoco los invoca.

**Impacto:** cualquier usuario de plataforma con rol `viewer` sobre un tenant puede:
1. `POST /api/tenant-app-users` — crear un `tenant_app_user` (ej. con su propio email).
2. `POST /api/tenant-app-users/{id}/access { scope_type: 'tenant' }` — otorgarse acceso a todo el tenant.
3. Vía el fallback `isTenantWide` de `appDataApi.js`, leer los datos privados (`owner_user_id`) de **todos los customers de todas las apps del tenant** — algo que un `viewer` nunca debería poder hacer.

**Fix:** en cada handler de `tenantAppUsers.js`, después de resolver el tenant, llamar `requireRole(membership, 'owner', 'editor')` (ya existe en `session.js`) antes de cualquier mutación. Confirmar también que los internos de `internal.js` que dependen de rol lo apliquen donde corresponda.

## 2. CRÍTICO — la cookie del customer no queda scoped en 2 de los 3 modos de ruteo

**Archivo:** `packages/runtime/src/lib/appAuth.js` (`cookiePathForBox`)

La spec fase 1 §6 pidió explícitamente resolver el `Path` de la cookie `hbx_app_sid` para los 3 modos de ruteo (`/s/{shareId}`, `/t/{tenant}/{boxSlug}`, `/{boxSlug}` en subdominio). La implementación intenta derivarlo del header `Referer`, pero en el flujo real el `fetch()` a `/consume` se dispara desde la propia página de `verifyConfirmHtml` (servida en `/api/app-auth/{boxId}/verify`) — el `Referer` de ese request nunca es la URL pública del box, así que esa rama nunca dispara y siempre cae al fallback `/${boxInfo.boxSlug}`.

**Impacto:**
- En boxes servidos por `/s/{shareId}` o `/t/{tenant}/{boxSlug}`, la cookie queda con un `Path` que no es prefijo del path real → el browser no la reenvía → el login por magic link no persiste sesión en esos 2 modos (se rompe en silencio, sin error visible).
- Dos boxes de tenants distintos con el mismo `boxSlug` bajo el mismo host pueden terminar con el mismo `Path`, pisándose la cookie entre sí — justo el caso que la spec pidió evitar.

No es un leak de datos (la sesión igual se valida server-side contra la Turso DB del box exacto), pero rompe la funcionalidad en 2 de 3 modos y la defensa de aislamiento por cookie que se pidió.

**Fix:** no depender de `Referer`. Usar `boxInfo.visibility` + el modo de resolución que ya devuelve `resolveBoxDb`/`resolver.js`, o pasar el path público explícito desde el llamador (ej. en `magicLinkBase`/`?return=`) en vez de reconstruirlo desde un header que en este flujo nunca es el correcto.

## 3. IMPORTANTE — `checkTenantAppAccess` no cruza tenant por sí misma

**Archivo:** `packages/control-plane/src/lib/session.js` (`checkTenantAppAccess`)

La función filtra por `tenant_app_user_id` + `scope_type`/`scope_id`, pero nunca compara `box.tenant_id` contra el tenant del `tenant_app_user`. Hoy es seguro porque el único caller (`postTenantAppAccessCheck` en `internal.js`) sí hace esa comparación antes de invocarla — pero es una dependencia frágil, sin defensa en profundidad. Si en el futuro se agrega un segundo caller sin replicar el chequeo, un `tenant_app_user` con `scope_type='tenant'` pasaría a tener acceso a boxes de **cualquier tenant**, no solo el suyo.

**Fix:** mover el cruce de `tenant_id` adentro de `checkTenantAppAccess` (recibiendo o resolviendo el tenant del `tenant_app_user` en la misma función/query), no dejarlo únicamente en el caller.

## 4. MENOR — GET de admin de fase 1 sin chequeo de rol

**Archivo:** `packages/runtime/src/lib/appAuthRoutes.js` (`getAdminUsers`, `getAdminSettings`)

A diferencia de los endpoints de escritura del mismo archivo (que sí rechazan `role === 'viewer'`), estos dos GET no tienen ese chequeo — cualquier `viewer` del workspace puede listar los emails de los `app_users` de un box y ver el `signup_mode` configurado. Solo lectura, sin acceso a datos de customers — severidad baja, pero inconsistente con el resto del archivo y con lo que pide la spec.

**Fix:** agregar el mismo chequeo `role !== 'viewer'` que ya tienen `postAdminAddUser`/disable/enable/delete/settings.

## Qué está bien (confirmado leyendo el código, no solo el mensaje del commit)

- `appDataApi.js#postUpsert`: `owner_user_id` sale siempre de la sesión validada, nunca del body — el body se destructura descartando explícitamente cualquier campo de ownership antes de insertar.
- `getRows`: el filtro por `owner_user_id` está hardcodeado al `scope='private'` + sesión, sin ningún query param que lo bypasee.
- El fallback `isTenantWide` (fase 3) valida de verdad contra control-plane vía la cookie httpOnly `hbx_tapp_sid` — no hay ningún header falsificable por el browser que lo otorgue.
- `postUpsert` devuelve 403 para `isTenantWide`, tal como pide la spec (usuarios centralizados son solo-lectura en v1).
- `requiresInternalSecret` cubre todos los endpoints internos que corresponden y falla cerrado si el secreto no está configurado.
- Los slugs se validan contra la regex antes de interpolarse en SQL en todos los puntos revisados — sin inyección de nombre de tabla.
- El escape de XSS en `verifyConfirmHtml`/`verifyErrorHtml` es real (allowlist regex + `JSON.stringify` + tabla fija de mensajes), no cosmético.
- Anti-enumeración en `signup_mode='open'`: la respuesta es siempre genérica, sin importar si el email existía o no.
- Los endpoints de mutación de fase 1/2 (agregar/deshabilitar/borrar usuario, cambiar settings) sí exigen `role !== 'viewer'` de forma consistente.

## Checklist de corrección

1. Agregar `requireRole`/`assertTenantScope` a todos los handlers de `tenantAppUsers.js` (hallazgo 1).
2. Reescribir `cookiePathForBox` en `appAuth.js` para no depender de `Referer` — resolver el path real desde `boxInfo`/el modo de ruteo (hallazgo 2).
3. Mover el cruce de `tenant_id` dentro de `checkTenantAppAccess` (hallazgo 3).
4. Agregar el chequeo de rol a `getAdminUsers`/`getAdminSettings` (hallazgo 4).
5. Re-probar el caso de la spec fase 1 §6 punto 9 (dos boxes bajo el mismo subdominio, confirmar cookies con `Path` distinto) — ahora también para los modos `/s/` y `/t/`, no solo el de subdominio.
6. Probar el escenario de escalación descrito en el hallazgo 1 después del fix: un `viewer` de plataforma no debe poder crear ni otorgarse accesos de `tenant_app_user`.
