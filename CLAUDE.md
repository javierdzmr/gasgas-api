# CLAUDE.md — GasGas Analytics
Checkpoint: Abril 2026 — v19abril26

Este archivo provee contexto a Claude cuando trabaja en este repositorio.

---

## Descripción del Proyecto

GasGas Analytics recopila, almacena y analiza precios de gasolina en México.
Modelo de negocio: venta de API de precios a clientes del sector gasolinero.
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
    updateAgregados.js          ← Cron: calcula promedios + min/max/std
    updateHistoricos.js         ← Cron: stats históricos legacy
    updateHistoricosDaily.js    ← Cron: inserta promedios diarios para gráficas
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

### prices_gas_station_links
JOIN entre `prices` y `gas_stations`. Columnas: `id`, `price_id`, `gas_station_id`.

### precios_agregados
Pre-cálculo de promedios por mercado y periodo. Evita queries sobre millones de registros.
Columnas: `market_type`, `market_value`, `days`, `regular`, `premium`, `diesel`,
`min/max/std_regular`, `min/max/std_premium`, `min/max/std_diesel`,
`stations_count`, `updated_at`.
Índice único: `(market_type, market_value, days)`.
Valores de `market_type`: `'nacional'` o `'estado'`.
Valores de `market_value`: `'all'` para nacional, nombre del estado con capitalización normal (ej. `'Chiapas'`).
**Periodos disponibles:** `days = 1` (hoy), `days = 7`, `days = 30`.

### precios_historicos_agregados
Serie de tiempo diaria para las gráficas del dashboard.
Columnas: `market_type`, `market_value`, `date`, `regular`, `premium`, `diesel`, `updated_at`, `estado_slug`.
Índice único: `(market_type, market_value, date)`.

---

## Rangos de Precios Válidos (updateAgregados.js)

Actualizados el 13 Abril 2026 basados en análisis de percentiles p05–p99 sobre 30 días de datos reales:

| Producto | Mínimo | Máximo |
|---|---|---|
| Regular | 21 | 27 |
| Premium | 23 | 32 |
| Diesel | 25 | 33 |

Estos rangos están centralizados en el objeto `RANGE` al inicio de `updateAgregados.js`. Si los precios en México cambian significativamente, correr la query de diagnóstico de percentiles antes de ajustar:

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

| Nombre | Script | Schedule | Función |
|---|---|---|---|
| update-precios-agregados | updateAgregados.js | Cada 6h | Promedios + min/max/std para 1, 7 y 30 días |
| update-precios-historico | updateHistoricos.js | Cada 4h | Stats históricos legacy |
| update-historicos-daily | updateHistoricosDaily.js | 4x al día (8,14,20,2 UTC) | Inserta promedio diario en precios_historicos_agregados |

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

### ⚠️ BUG PENDIENTE — Rango interno del estado no muestra datos
**Estado al 14 Abril 2026:** La API sí devuelve `min` y `max` correctamente (verificado: `https://api.gasgas.com.mx/api/precios?market=estado&value=Chiapas&days=1&product=regular` retorna `min: 21.75`, `max: 25.74`). El problema está en el `index.html` de GoDaddy.

**Fix identificado:** En `renderEstadoHoy`, cambiar:
```javascript
// MAL — la API no devuelve min_regular, devuelve min
const minKey = `min_${currentProduct}`;
const maxKey = `max_${currentProduct}`;
const minVal = preciosHoy[minKey] ? formatMoney(preciosHoy[minKey]) : "—";
const maxVal = preciosHoy[maxKey] ? formatMoney(preciosHoy[maxKey]) : "—";

// BIEN — usar min/max directamente
const minVal = preciosHoy.min ? formatMoney(preciosHoy.min) : "—";
const maxVal = preciosHoy.max ? formatMoney(preciosHoy.max) : "—";
```

**Próximo paso al retomar:** Abrir consola del navegador en gasgas.com.mx con Estado+Hoy seleccionado y revisar errores JS. El último `index.html` subido a GoDaddy no cargó nada — posiblemente Cloudflare volvió a inyectar cfasync o el archivo se subió incompleto.

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

Ambos archivos deben mantenerse sincronizados manualmente. Al hacer cambios al frontend, hay que:
1. Hacer commit a `dev` y probar en `gasgas-api-dev.onrender.com`
2. Hacer merge a `main`
3. Subir manualmente el `index.html` al cPanel de GoDaddy

**Problema pendiente:** Unificar a un solo frontend servido desde Render, apuntando el DNS de `gasgas.com.mx` a Render y abandonando GoDaddy para el frontend.

---

## CORS — Configuración actual en server.js

Implementado con middleware nativo de Express (sin paquete `cors`):

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

### Sincronizar dev con main (antes de empezar nuevos cambios)
```bash
git checkout dev
git reset --hard main
git push origin dev --force
```

### Tags de seguridad
```bash
# Regresar a versión estable en caso de emergencia
git reset --hard 19abril26
git push origin main --force
```

| Tag | Fecha | Descripción |
|---|---|---|
| `v1.0-stable` | commit 3e6ce6d | Primera versión estable |
| `13abril26` | 13 Abril 2026 | Rangos de precios corregidos, producto presentable a clientes |
| `18abril26` | 18 Abril 2026 | Fix min/max corruptos en cron, chips Pro: E.S., Personalizado, Descargar Excel |
| `19abril26` | 19 Abril 2026 | Chip Pro: Filtrar por marca centrado debajo de periodos |

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

## Problemas Conocidos (no repetir)

#### 1. CORS — resuelto 14 Abril 2026
Implementado con middleware nativo en `server.js`. Ver sección CORS arriba.

#### 2. Tag cfasync de Cloudflare rompe el JS
Cloudflare inyecta `<script data-cfasync="false" src="/cdn-cgi/...">` antes del `<script>` principal, lo que hace que todo el JavaScript del dashboard falle silenciosamente.
**Solución:** El `index.html` que se sube a GoDaddy no debe tener ese tag. Verificar siempre con `grep "cfasync" index.html` antes de hacer deploy.

#### 3. CDN de Chart.js
`cdn.jsdelivr.net` da 404 en el entorno de Render dev.
**Solución:** Usar siempre `cdnjs.cloudflare.com`.

#### 4. Script cortado al copiar/pegar
El `index.html` se cortaba al pegarlo en el chat. Siempre verificar con:
```bash
tail -5 public/index.html
```
Debe terminar con `</script></body></html>`.

#### 5. Render plan Free se duerme
El servicio `gasgas-api-dev` es plan Free y se duerme con inactividad. Antes de probar el dashboard en dev, siempre despertar la API primero:
```
https://gasgas-api-dev.onrender.com/api/test
```

#### 6. Dos frontends desincronizados
`gasgas.com.mx` (GoDaddy) y `gasgas-api-dev.onrender.com` (Render) tienen archivos distintos. Probar en dev no garantiza que producción funcione igual si el HTML de GoDaddy no se actualizó.

#### 7. Min/Max con valores irreales — resuelto 13 Abril 2026
Los rangos originales (`BETWEEN 20 AND 35`) dejaban pasar outliers. Se ajustaron con análisis de percentiles. Ver sección "Rangos de Precios Válidos".

#### 8. days=1 devuelve 0 estaciones por desfase UTC — resuelto 14 Abril 2026
`CURRENT_DATE` en Render es UTC, ya es "mañana" respecto a México. Solución: usar `p.date::date = (SELECT MAX(date::date) FROM prices)` para siempre tomar el último día disponible en la BD.

#### 9. Frontend no muestra rango interno del estado — PENDIENTE
La API sí devuelve `min` y `max` correctamente. El bug está en el `index.html` de GoDaddy — el código buscaba `min_regular` pero la API devuelve `min`. Fix identificado, pendiente de aplicar y verificar con consola del navegador.

#### 10. Min/Max muestran outliers en periodos 7d y 30d — resuelto 18 Abril 2026
La tabla `precios_agregados` tenía datos corruptos de versiones anteriores sin filtros de rango. Solución en tres capas en `updateAgregados.js`: (1) `UPDATE` de limpieza al inicio de cada ejecución, (2) `CASE WHEN BETWEEN` en el cálculo SQL, (3) función `sanear()` que valida antes del INSERT.

---

## Issues Resueltos

- ✅ Pool de PostgreSQL incluido en server.js
- ✅ Duplicados de estados en minúsculas eliminados de precios_agregados
- ✅ stations_count correcto por estado (no nacional)
- ✅ SSL activo vía Cloudflare
- ✅ Bypass caché para /api/* en Cloudflare
- ✅ public/index.html creado con dashboard completo
- ✅ express.static('public') configurado en server.js
- ✅ Chips bloqueados GasGas Pro (Ciudad y C.P.) con modal
- ✅ Banner de Contáctanos en el footer
- ✅ Tag v1.0-stable creado en commit 3e6ce6d
- ✅ Rangos de precios corregidos con análisis de percentiles (13 Abril 2026)
- ✅ Tag 13abril26 creado — versión presentable a clientes
- ✅ dev sincronizado con main (13 Abril 2026)
- ✅ days=1 implementado en updateAgregados.js con MAX(date::date)
- ✅ CORS implementado en server.js (14 Abril 2026)
- ✅ /api/ranking-estados implementado (14 Abril 2026)
- ✅ /api/vecinos implementado con mapa de 32 estados (14 Abril 2026)
- ✅ 7 días y 30 días funcionando correctamente en gasgas.com.mx
- ✅ Fix min/max outliers en days=7 y days=30 — limpieza en cron updateAgregados.js (18 Abril 2026)
- ✅ Chips GasGas Pro ampliados: E.S. y Personalizado agregados (18 Abril 2026)
- ✅ Botón "Descargar Excel" Pro debajo de tarjetas de precios (18 Abril 2026)
- ✅ Botón "Filtrar por marca" Pro centrado debajo de chips de periodo (19 Abril 2026)
- ✅ Tag 19abril26 creado — versión estable
- ⏳ Vista "Hoy" — rango interno del estado pendiente de resolver
