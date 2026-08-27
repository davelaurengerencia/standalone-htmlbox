// src/lib/debugPanel.js — gate server-side del panel de debug para boxes.
//
// Ver htmlbox-spec-debug-panel.md para la decisión de diseño completa. Resumen:
// el panel NUNCA se muestra a un visitante público ni a un viewer — solo cuando
// (1) la URL trae ?hbx_debug=1 y (2) la sesión tiene rol owner/editor sobre
// ESE box (o es platform owner). Las dos son necesarias: el gate real es
// server-side, nunca "oculto el botón con CSS".

import { checkMembership } from './auth.js'

const EDITOR_ROLES = new Set(['owner', 'editor'])

// Devuelve true solo si la URL pide el panel Y la sesión tiene rol owner/editor
// sobre ESE box. Nunca confiar en el query param solo — siempre revalidar rol.
export async function shouldShowDebugPanel(env, request, url, boxId) {
  if (url.searchParams.get('hbx_debug') !== '1') return false
  const membership = await checkMembership(env, request, boxId)
  return membership.ok && EDITOR_ROLES.has(membership.role)
}