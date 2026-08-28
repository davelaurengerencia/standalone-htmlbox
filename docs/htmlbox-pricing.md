# SIVO CLOUD — Sistema de Precios y Costos

## 1. Filosofía

- El tenant es un dueño de negocio **no técnico**: nunca se le exponen unidades técnicas (requests, CPU-ms, rows read/written).
- Todo se traduce a lenguaje de negocio: **apps, usuarios, workspaces, GB de almacenamiento, operaciones**.
- Las “operaciones” no son una línea de ingreso — son un **freno antiabuso**. El costo real de infraestructura por operación es despreciable; el límite existe para detectar bugs o uso descontrolado antes de que te cueste a ti.
- El único costo que de verdad escala con el tiempo y con el que sí hay que tener cuidado es el **storage** (Turso + R2).

## 2. Jerarquía del producto

```
Tenant
 └── Workspace   (agrupador de apps)
      └── App    (mini app individual — Worker + Turso DB)
```

## 3. Plan Base — $50/mes

|Recurso                                                           |Incluido                                |
|------------------------------------------------------------------|----------------------------------------|
|Workspaces                                                        |3                                       |
|Apps (total, repartidas entre workspaces)                         |5                                       |
|Usuarios                                                          |5                                       |
|Storage (Turso + R2 combinado)                                    |*(pendiente de definir — ver sección 6)*|
|Operaciones/mes (suma total del tenant, todos los workspaces/apps)|10,000,000                              |

El plan base es un **mínimo cerrado**: se cobra completo aunque el tenant use menos recursos de los incluidos (no hay prorrateo hacia abajo).

## 4. Precios de recursos adicionales

|Ítem                                       |Precio adicional                                                        |
|-------------------------------------------|------------------------------------------------------------------------|
|Workspace extra                            |+$10/mes                                                                |
|App extra                                  |+$5/mes                                                                 |
|Usuario extra                              |+$5/mes                                                                 |
|GB de storage extra                        |+$0.75/GB/mes                                                           |
|Operaciones extra (pasado el límite de 10M)|aviso primero → luego cobro o throttle (no es línea de ingreso planeada)|

### Ejemplo de cálculo

Tenant con 8 apps, 12 usuarios, 4 workspaces:

```
$50 base
+ (8-5) apps  × $5  = $15
+ (12-5) users × $5 = $35
+ (4-3) workspace × $10 = $10
─────────────────────────
Total: $110/mes
```

## 5. Qué es una “operación”

Una operación = cualquier interacción de negocio que pasa por el Worker y toca la base de datos (Turso), ya sea lectura o escritura. No se distingue tipo (read/write) para el tenant — se cuenta todo junto y suma **a nivel de tenant completo**, sin importar en qué app o workspace ocurrió.

Se espera que la mayoría del volumen sea **lectura** (dashboards, listados, reportes) más que escritura, lo cual es normal y hace que el límite de 10M sea aún más holgado en términos de costo real.

## 6. Costos reales de infraestructura (verificado 2026)

### Cloudflare Workers for Platforms (WfP)

- Base: **$25/mes** → incluye 20M requests + 60M CPU-ms + 1000 scripts
- Extra: $0.30 por millón de requests / $0.02 por millón de CPU-ms / $0.02 por script extra
- WfP cobra 1 sola request por toda la cadena dispatch → user Worker → outbound; el CPU time sí se acumula a través de esa cadena
- 1 script = 1 tenant o 1 app aislada (según cómo se implemente el aislamiento)

### Turso (referencia plan Scaler)

- Storage: $0.50/GB extra
- Rows read: $0.80 por **billón** extra (~$0.0000000016 c/u — casi gratis)
- Rows written: $0.80 por **millón** extra (~$0.0000008 c/u)

### Cloudflare KV (si se usa como caché)

- KV read: $0.50/millón
- KV write: **$5/millón** (10x más caro que un write directo a Turso)

⚠️ Nota: dado que un read a Turso ya es casi gratis por sí solo, KV **no siempre conviene**. Solo cachear en KV cuando el mismo dato se lee muchas veces entre cada escritura (ej. configuración de tenant, catálogos, permisos). No cachear datos que se leen 1-2 veces — ahí Turso directo sale más barato que pagar el write a KV.

### Costo real estimado por operación (Worker + Turso)

|Tipo                          |Costo aproximado       |
|------------------------------|-----------------------|
|Operación de lectura (read)   |~$0.0000004 – 0.0000005|
|Operación de escritura (write)|~$0.0000012 – 0.0000015|

### Costo real del límite completo (peor caso)

```
10,000,000 operaciones × costo promedio ≈ $2 – $12 USD
```

Muy por debajo del plan de $50 — el límite de 10M es un freno de seguridad, no un riesgo de margen.

## 6.1 Por qué usar Workers for Platforms (justificación de arquitectura)

Se evaluó cambiar de un Worker central único (routing por Host header) a Workers for Platforms, con aislamiento real por script (por tenant o por app).

**Qué gana la plataforma con WfP:**

1. **Aislamiento de seguridad real**: cada tenant corre en su propio sandbox lógico. Un bug o exploit en el código de un tenant no puede escaparse a afectar a otros, a diferencia de un Worker central donde todo depende de que el propio código de aplicación nunca falle en el scoping por tenant.
1. **Límites de CPU/consumo nativos por tenant**: se puede configurar un CPU limit por invocación distinto por script, lo que permite hacer cumplir el freno de 10M operaciones/mes de forma confiable a nivel de infraestructura, no solo con contabilidad hecha a mano en el código.
1. **Medición de consumo nativa**: Cloudflare factura y da métricas por script, lo que facilita saber cuánto consume cada tenant sin instrumentar un sistema de conteo propio.
1. **Deploys independientes**: permite dar lógica custom a un tenant específico sin tocar el resto de la plataforma.

**Trade-offs:**

- Más complejidad operativa (gestionar N scripts en vez de 1 Worker central).
- Costo base más alto ($25/mes vs. Worker normal), aunque marginal frente al ingreso.

**Estimado de costo a escala (~50 tenants activos, ~150-250 scripts, uso normal dentro de los límites de operaciones):**

```
$25 (suscripción base)
+ ~$0 (requests, dentro del incluido de 20M/mes)
+ ~$0.20 (CPU time, leve exceso del incluido)
+ ~$0 (scripts, muy por debajo de 1000 incluidos)
──────────────────────────────────────────────
Total estimado: ~$25-40/mes para TODA la plataforma
```

Frente a un ingreso mínimo de $50/mes **por tenant** (o sea $2,500/mes con 50 tenants), el costo de WfP es marginal. **Decisión: adoptar WfP** — el aislamiento de seguridad y el control nativo de consumo por tenant justifican el costo, que es prácticamente ruido comparado con el ingreso.

## 7. Pendiente por definir

- [ ] GB de storage incluidos en el plan base de $50 (Turso + R2 combinado)
- [ ] Mecanismo exacto al pasar el límite de 10M operaciones: ¿cobro automático (ej. $1/millón extra) o solo aviso + throttle manual?
- [ ] Validar volumen real esperado de KV writes si se implementa caché, para confirmar que no afecta el margen del plan base

## 8. Cómo comunicar esto al tenant (nunca en términos técnicos)

> “Tu plan incluye uso generoso para la operación normal de tu negocio. Si tu actividad crece mucho más de lo esperado, te avisamos antes de cualquier cargo adicional.”

Nunca mencionar: requests, CPU-ms, rows read/written, KV, Turso, Workers. Solo: apps, usuarios, workspaces, GB, y “operaciones” cuando aplique el freno antiabuso.