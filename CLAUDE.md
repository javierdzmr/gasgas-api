# CLAUDE.md — GasGas Analytics
Checkpoint: Mayo 2026 — v27mayo26

Este archivo provee contexto a Claude cuando trabaja en este repositorio.

---

## Descripción del Proyecto

GasGas Analytics recopila, almacena y analiza precios de gasolina en México.
Modelo de negocio: venta de acceso al dashboard (GasGas Pro) y en Fase 2 venta de API de precios.
Sitio público: https://gasgas.com.mx

---

## Stack Tecnológico

| Componente | Tecnología | URL |
|---|---|---|
| Frontend | HTML/CSS/JS + Chart.js | gasgas.com.mx (GoDaddy cPanel) |
| API producción | Node.js / Express | api.gasgas.com.mx |
| API desarrollo | Node.js / Express | gasgas-api-dev.onrender.com |
| Servidor | Render (plan Starter) | 0.5 CPU, 512 MB |
| Base de datos | PostgreSQL 15 | Render Managed DB |
| DNS / SSL | Cloudflare (plan Free) | Modo Flexible, Always HTTPS |
| Repositorio | GitHub | github.com/javierdzmr/gasgas-api |

---

## Estructura del Repositorio

```
gasgas-api/
  server.js                     ← API principal (pool de DB incluido)
  package.json
  public/
    index.html                  ← Frontend del dashboard
  scripts/
    updateAgregados.js          ← Cron: CREATE TABLE IF NOT EXISTS + promedios + min/max/std
    updateHistoricos.js         ← Cron: stats históricos legacy
    updateHistoricosDaily.js    ← Cron: CREATE TABLE IF NOT EXISTS + auto-rebuild + inserta día
  docs/
    GasGas_Documentacion_Tecnica.docx
```

---

## Variables de Entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `DATABASE_URL` | Sí | PostgreSQL connection string (SSL enforced) |
| `PORT` | No | Puerto del servidor (default: 10000) |

---

## Comandos

```bash
# Iniciar servidor
npm start   # node server.js

# Correr scripts manualmente (requieren DATABASE_URL)
node scripts/updateAgregados.js
node scripts/updateHistoricosDaily.js
```

---

## Base de Datos

### gas_stations
Catálogo de ~14,000 gasolineras. Columnas clave: `id`, `estado`, `municipio`, `cp`, `lat`, `lng`, `cre_id`, `estado_slug`.

### prices
Motor principal. +9M registros, se actualiza varias veces al día.
Columnas: `id`, `date`, `regular`, `premium`, `diesel`.
**Importante:** El campo `date` es un timestamp. El servidor Render corre en UTC, que va 6-7 horas adelante de México. Usar siempre `p.date::date` para comparaciones de fecha.
**Backdata disponible:** Mayo 2024 → presente (~2 años).

### prices_gas_station_links
JOIN entre `prices` y `gas_stations`. Columnas: `id`, `price_id`, `gas_station_id`.

### precios_agregados
Pre-cálculo de promedios por mercado y periodo. Evita queries sobre millones de registros.
Columnas: `market_type`, `market_value`, `days`, `regular`, `premium`, `diesel`,
`min/max/std_regular`, `min/max/std_premium`, `min/max/std_diesel`,
`stations_count`, `updated_at`.
Índice único: `(market_type, market_value, days)`.
Valores de `market_type`: `'nacional'`, `'estado'` o `'municipio'` (19 Jul 2026).
Valores de `market_value`: `'all'` para nacional; nombre del estado con capitalización normal (ej. `'Chiapas'`); para municipio la llave compuesta `'Estado|Municipio'` (ej. `'Jalisco|Zapopan'`) — los nombres de municipio se repiten entre estados.
**Periodos disponibles:** `days = 1` (hoy), `days = 7`, `days = 30`.
**🛡️ Protección:** `updateAgregados.js` hace `CREATE TABLE IF NOT EXISTS` al inicio — si Strapi borra la tabla, el próximo cron la recrea automáticamente.

### precios_historicos_agregados
Serie de tiempo diaria para las gráficas del dashboard.
Columnas: `market_type`, `market_value`, `date`, `regular`, `premium`, `diesel`, `updated_at`, `estado_slug`.
Índice único: `(market_type, market_value, date)`.
**🛡️ Protección:** `updateHistoricosDaily.js` hace `CREATE TABLE IF NOT EXISTS` + si detecta menos de 10 registros, repobla automáticamente nacional + 32 estados con los últimos 30 días sin intervención manual.

### Strapi y la DB
Todas las tablas tienen owner `_304ba600355ba807` (único usuario de Render). Strapi comparte esta DB y en el pasado (3 Mayo 2026) borró `precios_agregados` y `precios_historicos_agregados` al hacer deploy/migraciones automáticas. La protección `CREATE TABLE IF NOT EXISTS` en los scripts resuelve esto sin intervención manual.

---

## Rangos de Precios Válidos

Actualizados 13 Abril 2026. Objeto `RANGE` presente en **ambos** scripts (`updateAgregados.js` y `updateHistoricosDaily.js`):

| Producto | Mínimo | Máximo |
|---|---|---|
| Regular | 21 | 27 |
| Premium | 23 | 32 |
| Diesel | 25 | 33 |

Query de diagnóstico para ajustar rangos si los precios en México cambian:

```sql
SELECT
  'regular' AS producto,
  PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY regular) AS p01,
  PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY regular) AS p05,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY regular) AS p95,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY regular) AS p99
FROM prices
WHERE regular IS NOT NULL AND regular > 0
  AND date >= NOW() - INTERVAL '30 days'
-- repetir para premium y diesel
```

---

## API Endpoints

### GET /api/precios
Retorna precios promedio y estadísticas.

| Parámetro | Valores | Descripción |
|---|---|---|
| `market` | `nacional` \| `estado` | Nivel geográfico |
| `value` | `all` \| `{nombre estado}` | Mercado específico |
| `days` | `1` \| `7` \| `30` | Periodo de análisis |
| `product` | `regular` \| `premium` \| `diesel` | Producto para min/max/std |

Respuesta: `regular`, `premium`, `diesel`, `updated_at`, `min`, `max`, `std`, `stations_count`, `total_estaciones`

**CRÍTICO:** `min` y `max` ya vienen mapeados al producto solicitado. En el frontend NO usar `min_regular`, `min_premium` etc. — usar directamente `precios.min` y `precios.max`.

### GET /api/historico
Retorna serie de tiempo diaria para gráficas.

| Parámetro | Valores |
|---|---|
| `market` | `nacional` \| `estado` |
| `value` | `all` \| `{nombre estado}` |
| `days` | `7` \| `30` |

### GET /api/estados
Lista de los 32 estados disponibles.

### GET /api/municipios ✅ IMPLEMENTADO (19 Jul 2026)
Municipios de un estado con su número de estaciones (para el selector en cascada).
| Parámetro | Valores |
|---|---|
| `estado` | nombre del estado |

Respuesta: `[{ municipio, estaciones }]`. Nota: `/api/precios` y `/api/historico` ya aceptan `market=municipio&value=Estado|Municipio` sin cambios (el market va parametrizado). Recordar URL-encodear la barra vertical (`%7C`).

### GET /api/ranking-estados ✅ IMPLEMENTADO
Ranking de 32 estados por precio de hoy (days=1).
| Parámetro | Valores |
|---|---|
| `product` | `regular` \| `premium` \| `diesel` |

### GET /api/vecinos ✅ IMPLEMENTADO
Estados vecinos de un estado dado con sus precios de hoy (days=1).
| Parámetro | Valores |
|---|---|
| `estado` | nombre del estado |
| `product` | `regular` \| `premium` \| `diesel` |

### GET /api/test
Health check. Responde `{ status: 'ok' }`.

---

## Cron Jobs (Render)

| Nombre | Script | Schedule (UTC) | Hora México | Función |
|---|---|---|---|---|
| update-precios-historico | updateHistoricos.js | `50 11 * * *` | 5:50 AM | Stats históricos legacy — corre primero |
| update-precios-agregados | updateAgregados.js | `30 2,12,16,18,20,22,23 * * *` | 7 cortes: 6:30, 10:30, 12:30, 14:30, 16:30, 17:30 y 20:30 (hora MX) | Crea tablas si no existen + recalcula promedios. **Cálculo incremental (8 Ago 2026):** `days=1` siempre; `days=7` y `days=30` solo si hay lote nuevo desde el último cálculo (los datos entran 1 vez al día). Forzar con `FORZAR_RECALCULO=1`. |
| update-historicos-daily | updateHistoricosDaily.js | 4x al día (8,14,20,2 UTC) | — | Crea tabla + auto-rebuild si vacía + inserta día |

**Lógica de orden:** `update-precios-historico` corre 10 minutos antes que `update-precios-agregados` para que aunque el legacy corrompa algo, el agregados lo limpia inmediatamente después.

---

## Frontend — Dashboard (public/index.html)

### Dimensiones
- Mercado: Nacional / Estado / 🔒 Ciudad / 🔒 C.P. / 🔒 E.S.
- Periodo: Hoy / 7 días / 30 días / 🔒 Personalizado
- Marca: 🔒 Filtrar por marca (centrado debajo de chips de periodo)
- Producto: Regular / Premium / Diesel

### Vista "Hoy" — Nacional
Muestra ranking de 32 estados ordenados de más caro a más barato usando `/api/ranking-estados`.

### Vista "Hoy" — Estado
Muestra 6 métricas:
1. Posición nacional (de `/api/ranking-estados`)
2. Variación vs ayer (del último punto de `/api/historico?days=7`)
3. Distancia al promedio nacional (de `/api/precios?market=nacional&days=1`)
4. Rango interno del estado (de `precios.min` y `precios.max` de `/api/precios?market=estado&days=1`)
5. Sparkline tendencia 7 días
6. Estados vecinos hoy (de `/api/vecinos`)

### CRÍTICO — uso correcto de min/max en el frontend

```javascript
// MAL — la API NO devuelve estas claves
const minVal = preciosHoy[minKey] ? formatMoney(preciosHoy[minKey]) : "—";
const maxVal = preciosHoy[maxKey] ? formatMoney(preciosHoy[maxKey]) : "—";

// BIEN — usar min/max directamente
const minVal = preciosHoy.min ? formatMoney(preciosHoy.min) : "—";
const maxVal = preciosHoy.max ? formatMoney(preciosHoy.max) : "—";
```

### Chips GasGas Pro (bloqueados)
- Ciudad 🔒 — al hacer click abre modal "Nivel Ciudad"
- C.P. 🔒 — al hacer click abre modal "Nivel Código Postal"
- E.S. 🔒 — al hacer click abre modal "Estación de Servicio"
- Personalizado 🔒 (en fila de periodos, a la derecha de "30 días") — abre modal "Periodo Personalizado"
- Botón "Descargar Excel" 🔒 (debajo de tarjetas de precios, alineado a la derecha) — abre modal "Descargar Excel"
- Botón "Filtrar por marca" 🔒 (centrado debajo de chips de periodo, mismo estilo chip locked) — abre modal "Filtrar por Marca"
- Modal incluye badge "GasGas Pro" y botón mailto a hola@gasgas.com.mx
- Todos los modales usan `showProModal(type)` con entradas en el objeto `PRO_CONTENT` en el JS
- Tipos disponibles en PRO_CONTENT: `ciudad`, `cp`, `es`, `personalizado`, `excel`, `marca`

### Colores por producto
- Regular: `#1a6b2f` (verde oscuro)
- Premium: `#8b1a1a` (rojo oscuro)
- Diesel: `#111111` (negro)

### CDN Chart.js
Usar siempre: `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js`
**NO usar** `cdn.jsdelivr.net` — da 404 en el entorno de Render.

### Responsive
- Portrait mobile (<600px): aspectRatio 1.4, solo primera y última fecha en eje X
- Landscape / desktop: aspectRatio 2.5, todas las fechas
- Se redibuja automáticamente en orientationchange

---

## Cloudflare

- SSL: modo Flexible, Always Use HTTPS activado
- Cache Rule: "No cache API" — URI Path starts with `/api/` → Bypass cache
- **ADVERTENCIA:** Cloudflare modifica el HTML servido desde GoDaddy — inyecta tags `<script data-cfasync="false">` y ofusca emails. Esto rompe el JS del dashboard. Al actualizar el `index.html` en GoDaddy, verificar que no haya tags `cfasync` ni emails ofuscados `/cdn-cgi/l/email-protection`.

---

## Arquitectura de Dos Frontends

El proyecto tiene DOS lugares donde vive el `index.html`:

1. **GoDaddy cPanel** → sirve `gasgas.com.mx` (lo que ven los usuarios)
2. **Render `public/`** → sirve `gasgas-api-dev.onrender.com` (entorno de dev)

Al hacer cambios al frontend:
1. Commit a `dev` y probar en `gasgas-api-dev.onrender.com`
2. Merge a `main`
3. Subir manualmente el `index.html` al cPanel de GoDaddy

**Problema pendiente:** Unificar a un solo frontend servido desde Render.

---

## CORS — Configuración actual en server.js

```javascript
const ALLOWED_ORIGINS = [
  'https://gasgas.com.mx',
  'https://www.gasgas.com.mx',
  'https://api.gasgas.com.mx',
  'https://gasgas-api-dev.onrender.com',
  'http://localhost:3000'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
```

---

## Ramas de Git

- `main` → producción
- `dev` → desarrollo y pruebas (siempre partir de main antes de nuevos features)

### Flujo de trabajo
1. `git checkout dev`
2. Hacer cambios
3. `git add + commit + push origin dev`
4. Probar en gasgas-api-dev.onrender.com
5. Si todo bien: `git checkout main && git merge dev && git push origin main`

### Sincronizar dev con main
```bash
git checkout dev
git reset --hard main
git push origin dev --force
```

### Tags de seguridad

| Tag | Fecha | Descripción |
|---|---|---|
| `v1.0-stable` | commit 3e6ce6d | Primera versión estable |
| `13abril26` | 13 Abril 2026 | Rangos de precios corregidos |
| `18abril26` | 18 Abril 2026 | Fix min/max corruptos en cron |
| `19abril26` | 19 Abril 2026 | Chip Pro: Filtrar por marca |
| `03mayo26` | 3 Mayo 2026 | Protección CREATE TABLE IF NOT EXISTS + auto-rebuild históricos |
| `27mayo26` | 27 Mayo 2026 | initTables() en server.js al arrancar + fix NaN en frontend |

### Checklist antes de pasar a producción
- GET /api/test → `{ status: 'ok' }`
- GET /api/estados → 32 estados
- GET /api/precios?market=nacional&days=30&product=regular → precios con min/max/std
- GET /api/historico?market=nacional&days=30 → serie de tiempo
- GET /api/precios?market=estado&value=Chiapas&days=1&product=regular → min y max con valores reales
- GET /api/ranking-estados?product=regular → 32 estados con precios
- GET /api/vecinos?estado=Chiapas&product=regular → estados vecinos con precios
- Abrir dashboard y verificar que carguen precios en 7 días, 30 días y Hoy
- Verificar consola del navegador — no debe haber errores de CORS ni JS

---

## GasGas Pro — Cotizador (EN DESARROLLO)

### Estado actual: Preview funcional completado — 21 Abril 2026
Se construyó un cotizador interactivo en HTML/CSS/JS (`gasgas-cotizador.html`) con precio en tiempo real.

### Modelo comercial definido

**Plan base: $500 MXN/mes**
Incluye: Nacional + nivel Estado + 3 productos + datos desde contratación + sin apertura por marca

**Add-on: Granularidad**
| Nivel | Precio adicional |
|---|---|
| Estado | Incluido en base |
| Ciudad | +$1,500 |
| C.P. | +$5,000 |
| ES (Estación de Servicio) | +$19,500 |

**Multiplicador geográfico** (aplica solo si granularidad > Estado)
| Cobertura | Multiplicador |
|---|---|
| 1 Área | 1x |
| 2–3 Áreas | 1.3x |
| 4–5 Áreas o Nacional | 1.5x |

**Add-on: Historial / Backdata**
| Periodo | Precio adicional |
|---|---|
| Desde contratación | Incluido |
| 6 meses | +$500 |
| 1 año | +$1,500 |
| 2 años (todo disponible desde mayo 2024) | +$3,500 |

**Add-on: Apertura por marca**
| Opción | Precio adicional |
|---|---|
| Sin apertura | Incluido |
| Con apertura por marca | +$2,000 |
| Nivel ES | Forzado, incluido sin costo adicional |

**Fórmula:**
```
Precio = (Base $500 + Granularidad) × Multiplicador geográfico + Historial + Marca
```

**Todos los precios son + IVA (16%). Se factura en MXN.**

### Áreas geográficas definidas
| Área | Estados |
|---|---|
| Norte | BC, BCS, Sonora, Chihuahua, Coahuila, NL, Tamaulipas, Sinaloa |
| Pacífico | Nayarit, Jalisco, Colima, Michoacán, Guerrero, Oaxaca, Chiapas |
| Occidente | Durango, Zacatecas, Aguascalientes, SLP, Guanajuato, Querétaro |
| Centro | CDMX, Edomex, Hidalgo, Tlaxcala, Morelos, Puebla, Veracruz |
| Sureste | Tabasco, Campeche, Yucatán, Quintana Roo |

Si el cliente selecciona las 5 áreas = equivale a Nacional.

### Reglas de negocio importantes
- El cliente puede combinar múltiples áreas
- Elegir un nivel de granularidad incluye los niveles superiores
- Apertura por marca es **obligatoria y forzada** cuando se selecciona nivel ES
- Los 3 productos siempre están incluidos — no es variable de precio
- Fase 1: Solo dashboard. API es Fase 2.
- Pagos: tarjeta, Apple Pay, PayPal — procesador pendiente
- Facturación en MXN + IVA. RFC y razón social disponibles.
- Autenticación: JWT directo en server.js (NO usar Strapi para esto)

### Próximos pasos del cotizador
1. Integración de procesador de pagos (Stripe u otro)
2. Pantalla de login/cuenta del cliente
3. Definir qué ve cada cliente según su plan
4. Implementar autenticación JWT en server.js
5. Generación automática de facturas

---

## Problemas Conocidos (no repetir)

#### 1. CORS — resuelto 14 Abril 2026
Middleware nativo en `server.js`. Ver sección CORS.

#### 2. Tag cfasync de Cloudflare rompe el JS
Cloudflare inyecta `<script data-cfasync="false">` y rompe el JS. Verificar con `grep "cfasync" index.html` antes de deploy a GoDaddy.

#### 3. CDN de Chart.js
Usar siempre `cdnjs.cloudflare.com`, nunca `cdn.jsdelivr.net`.

#### 4. Script cortado al copiar/pegar
Verificar con `tail -5 public/index.html` — debe terminar con `</script></body></html>`.

#### 5. Render plan Free se duerme
Despertar con `https://gasgas-api-dev.onrender.com/api/test` antes de probar.

#### 6. Dos frontends desincronizados
GoDaddy y Render tienen archivos distintos. Probar en dev no garantiza que producción funcione.

#### 7. Min/Max con valores irreales — resuelto 13 Abril 2026
Rangos ajustados con percentiles. Ver sección Rangos de Precios Válidos.

#### 8. days=1 devuelve 0 estaciones por desfase UTC — resuelto 14 Abril 2026
Usar `p.date::date = (SELECT MAX(date::date) FROM prices)`.

#### 9. Frontend no muestra rango interno del estado — resuelto 22 Abril 2026
Usar `preciosHoy.min` / `preciosHoy.max`, no `preciosHoy[minKey]`.

#### 10. Min/Max outliers en 7d y 30d — resuelto 18 Abril 2026
Triple protección en `updateAgregados.js`: UPDATE limpieza + CASE WHEN BETWEEN + función `sanear()`.

#### 11. Min/Max se corrompían periódicamente — resuelto 21 Abril 2026
`updateHistoricos.js` reducido a 1 vez/día (5:50 AM). `updateAgregados.js` limpia 10 min después.

#### 12. Tablas borradas por Strapi — resuelto 3 Mayo 2026 + reforzado 27 Mayo 2026
Strapi borró `precios_agregados` y `precios_historicos_agregados` al hacer deploy. Solución: `CREATE TABLE IF NOT EXISTS` en ambos scripts + auto-rebuild en `updateHistoricosDaily.js` si tabla vacía. También se corrigieron rangos incorrectos (`BETWEEN 20 AND 30/35`) en `updateHistoricosDaily.js`.

#### 13. Frontend mostraba $NaN cuando API devuelve {} — resuelto 27 Mayo 2026
`formatMoney(undefined)` producía `$NaN`. Fix: guard en `formatMoney` con `isNaN()` y check de objeto vacío en `loadData()`. Muestra "—" o "Sin datos" en lugar de crashear.

#### 14. Crons sin correr 23 días + tablas inexistentes al arranque — resuelto 27 Mayo 2026
Los cron jobs de Render se suspendieron 23 días. Al volver a correr, `updateHistoricos.js` (legacy) corría primero e intentaba UPDATE sobre tabla inexistente. Fix: `initTables()` en `server.js` al arrancar — las tablas se recrean en cada deploy sin esperar al cron.

---

#### 15. Cron de agregados recalculaba lo mismo 7 veces al día — resuelto 8 Ago 2026
Los precios entran a `prices` en un lote diario, pero al subir a 7 cortes el cron recalculaba las ventanas de 7 y 30 días en cada corte (consultas de ~3.4 GB y ~30 s que recorren `prices` cruda). Medición con `pg_stat_statements`: 5 TB leídos acumulados, 12.5 h de CPU — el mayor consumidor de toda la base. Fix: `updateAgregados.js` compara `MAX(date)` de `prices` contra `MAX(updated_at)` de `precios_agregados` y omite las ventanas ya calculadas. Ahorro estimado: ~86% de la carga pesada (de ~143 GB/día a ~20 GB/día).

## Issues Resueltos

- ✅ Pool de PostgreSQL incluido en server.js
- ✅ Duplicados de estados en minúsculas eliminados de precios_agregados
- ✅ stations_count correcto por estado (no nacional)
- ✅ SSL activo vía Cloudflare
- ✅ Bypass caché para /api/* en Cloudflare
- ✅ public/index.html creado con dashboard completo
- ✅ express.static('public') configurado en server.js
- ✅ Chips bloqueados GasGas Pro con modales
- ✅ Banner de Contáctanos en el footer
- ✅ Rangos de precios corregidos con análisis de percentiles (13 Abril 2026)
- ✅ days=1 con MAX(date::date) (14 Abril 2026)
- ✅ CORS implementado (14 Abril 2026)
- ✅ /api/ranking-estados implementado (14 Abril 2026)
- ✅ /api/vecinos implementado (14 Abril 2026)
- ✅ Fix min/max outliers en days=7 y days=30 (18 Abril 2026)
- ✅ Chips Pro: E.S., Personalizado, Descargar Excel (18 Abril 2026)
- ✅ Chip Pro: Filtrar por marca (19 Abril 2026)
- ✅ Tag 19abril26 — versión estable
- ✅ Cron jobs reconfigurados (21 Abril 2026)
- ✅ Modelo comercial GasGas Pro + cotizador preview (21 Abril 2026)
- ✅ Rango interno del estado corregido en frontend (22 Abril 2026)
- ✅ CREATE TABLE IF NOT EXISTS en updateAgregados.js (3 Mayo 2026)
- ✅ Auto-rebuild históricos + rangos corregidos en updateHistoricosDaily.js (3 Mayo 2026)
- ✅ Tag 03mayo26 — versión con protección de tablas
- ✅ initTables() en server.js — protección al arrancar (27 Mayo 2026)
- ✅ Fix NaN en frontend cuando API devuelve {} (27 Mayo 2026)
- ✅ Tag 27mayo26 — protección máxima contra borrado de tablas por Strapi
- ⏳ GasGas Pro — flujo de pago, login de clientes y backend pendiente
