# DNS records para sivocloud.dev

> **TL;DR**: si compraste el dominio en Cloudflare Registrar, NO necesitás
> agregar registros manualmente para que los Workers funcionen — la zona
> existe automáticamente y los routes se atachan via API con `wrangler deploy`.
>
> Los registros de abajo son opcionales y solo necesarios para casos específicos.

## 1. Records automáticos (ya están, no tocar)

Cloudflare Registrar configura estos al comprar el dominio. No los borres:

| Tipo | Nombre | Valor |
|---|---|---|
| NS | `sivocloud.dev` | `ada.ns.cloudflare.com`, `bob.ns.cloudflare.com` (los que CF asigne) |
| SOA | `sivocloud.dev` | (auto) |

Verificá en el dashboard que la zona está en estado **Active** (no Pending).

## 2. Records para Workers (NO necesitás agregar nada)

Los Workers se atachan a la zona via **routes** declarados en `wrangler.jsonc`,
NO via registros DNS. El wildcard `*.sivocloud.dev` ya está cubierto por la
zona (Cloudflare matchea cualquier subdominio que no tenga un record específico).

| Tipo | Patrón en wrangler | Worker |
|---|---|---|
| Route | `sivocloud.dev` (apex) | `htmlbox-landing` |
| Route | `*.sivocloud.dev` (wildcard) | `htmlbox-runtime` |
| Route | `studio.sivocloud.dev` (override del wildcard) | `htmlbox-portal` |
| Route | `controlplane.sivocloud.dev` (override del wildcard) | `htmlbox-control-plane` |

Desplegar: `wrangler deploy` desde cada `packages/*/`.

## 3. Records para email (RECOMENDADO para producción)

Como migramos el `FROM_ADDRESS` a `no-reply@sivocloud.dev`, sin SPF/DKIM los
emails caen en spam. Cloudflare Email Service (Workers con binding MAIL)
funciona sin estos records PERO con baja deliverability.

### SPF (autoriza a Cloudflare a enviar desde tu dominio)

```
Tipo:  TXT
Nombre: sivocloud.dev (o @)
Valor: v=spf1 include:_spf.mx.cloudflare.net ~all
TTL:   Auto
```

### DKIM (Cloudflare firma automáticamente si usás Email Service)

```
Tipo:  TXT
Nombre: cf2024-1._domainkey.sivocloud.dev
Valor: (Cloudflare te lo da al activar Email Routing / Email Service)
```

Para obtenerlo: dashboard de Cloudflare → Email → Email Routing → Domains →
"sivocloud.dev" → "Enable". Cloudflare genera los records DKIM/SPF que tenés
que pegar en la zona DNS.

### DMARC (recomendado pero opcional)

```
Tipo:  TXT
Nombre: _dmarc.sivocloud.dev
Valor: v=DMARC1; p=none; rua=mailto:hello@sivocloud.dev
TTL:   Auto
```

`p=none` es la política más permisiva (solo reporta). Cambiá a `p=quarantine`
o `p=reject` cuando tengas confianza en el setup.

## 4. Records NO necesarios

- **A / AAAA para el apex**: Workers no los necesitan (responden via routes).
- **CNAME para subdominios**: Workers cubren via wildcard.
- **MX**: solo si querés RECIBIR emails en `sivocloud.dev` (con Email Routing
  podés forwardear a Gmail/etc sin MX).

## 5. Si la zona NO aparece en el dashboard

Posibles causas:
1. **La compra todavía no se propagó** — esperá unos minutos y refresca.
2. **El dominio se compró en otra cuenta de Cloudflare** — no aparece acá.
   Solución: mover el dominio entre accounts desde el dashboard del account
   original (o contactar soporte de CF).
3. **El dominio está bajo otra organización** — verificar el selector de
   organización arriba a la derecha en el dashboard.

Si ninguna de esas aplica, contactá soporte de Cloudflare con el número
de orden de compra.
