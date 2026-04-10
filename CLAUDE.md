# CLAUDE.md — GasGas Analytics
Checkpoint: Abril 2026 — v1.0-stable

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

### GET /api/historico
Retorna serie de tiempo diaria para gráficas.

| Parámetro | Valores |
|---|---|
| `market` | `nacional` \| `estado` |
| `value` | `all` \| `{nombre estado}` |
| `days` | `7` \| `30` |

### GET /api/estados
Lista de los 32 estados disponibles.

### GET /api/ranking-estados ⚠️ PENDIENTE DE IMPLEMENTAR
Ranking de 32 estados por precio de hoy.
| Parámetro | Valores |
|---|---|
| `product` | `regular` \| `premium` \| `diesel` |

### GET /api/vecinos ⚠️ PENDIENTE DE IMPLEMENTAR
Estados vecinos de un estado dado con sus precios de hoy.
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

**Importante:** `updateAgregados.js` ya fue modificado para calcular `days=1` usando `p.date >= CURRENT_DATE`. Este cambio está en la rama `dev` pero NO en `main` (versión estable actual).

---

## Frontend — Dashboard (public/index.html)

### Dimensiones
- Mercado: Nacional / Estado
- Periodo: 7 días / 30 días
- Producto: Regular / Premium / Diesel

### Chips GasGas Pro (bloqueados)
- Ciudad 🔒 — al hacer click abre modal "Nivel Ciudad"
- C.P. 🔒 — al hacer click abre modal "Nivel Código Postal"
- Modal incluye badge "GasGas Pro" y botón mailto a hola@gasgas.com.mx

### Colores por producto
- Regular: `#1a6b2f` (verde oscuro)
- Premium: `#8b1a1a` (rojo oscuro)
- Diesel: `#111111` (negro)

### Componentes
- Cards de precio con label de periodo
- Gráfica de línea (Chart.js) coloreada por producto
- Brand bar: "GasGas Analytics · gasgas.com.mx"
- Footer: Actualizado | estaciones | cobertura% | Min | Max | Std
- Sección de contacto con botón mailto pre-cargado a hola@gasgas.com.mx

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

## Ramas de Git

- `main` → producción (versión estable v1.0-stable)
- `dev` → desarrollo y pruebas

### Flujo de trabajo
1. `git checkout dev`
2. Hacer cambios
3. `git add + commit + push origin dev`
4. Probar en gasgas-api-dev.onrender.com
5. Si todo bien: `git checkout main && git merge dev && git push origin main`

### Tag de seguridad
```bash
# Regresar a versión estable en caso de emergencia
git reset --hard v1.0-stable
git push origin main --force
```

### Checklist antes de pasar a producción
- GET /api/test → `{ status: 'ok' }`
- GET /api/estados → 32 estados
- GET /api/precios?market=nacional&days=30&product=regular → precios con min/max/std
- GET /api/historico?market=nacional&days=30 → serie de tiempo
- Abrir dashboard y verificar que carguen precios
- Verificar consola del navegador — no debe haber errores de CORS ni JS

---

## Desarrollo Pendiente: Periodo "Hoy"

Se intentó implementar un nuevo periodo "Hoy" en el dashboard. El trabajo está en la rama `dev` pero se revirtió `main` por inestabilidad. A continuación el estado y los problemas encontrados para no repetirlos.

### Qué se construyó
- `updateAgregados.js` — agregado `days=1` con `p.date >= CURRENT_DATE`
- `server.js` — endpoints `/api/ranking-estados` y `/api/vecinos`
- `index.html` — chip "Hoy", vista Nacional+Hoy (ranking 32 estados), vista Estado+Hoy (6 cards: posición nacional, variación vs ayer, distancia al promedio, rango interno, sparkline 7 días, vecinos)

### Problemas encontrados (no repetir)

#### 1. CORS
La API de producción (`api.gasgas.com.mx`) necesita tener configurado CORS para aceptar requests desde `gasgas.com.mx`, `www.gasgas.com.mx` y `gasgas-api-dev.onrender.com`. Sin esto, el navegador bloquea todas las llamadas a la API.
**Solución:** Agregar al `server.js` antes de cualquier route:
```javascript
const cors = require('cors');
app.use(cors({
  origin: [
    'https://gasgas.com.mx',
    'https://www.gasgas.com.mx',
    'https://api.gasgas.com.mx',
    'https://gasgas-api-dev.onrender.com',
    'http://localhost:3000'
  ]
}));
```
Y correr `npm install cors` antes del deploy.

#### 2. Tag cfasync de Cloudflare rompe el JS
Cloudflare inyecta `<script data-cfasync="false" src="/cdn-cgi/...">` antes del `<script>` principal, lo que hace que todo el JavaScript del dashboard falle silenciosamente. `loadData` aparece como `undefined`.
**Solución:** El `index.html` que se sube a GoDaddy no debe tener ese tag. Verificar siempre con `grep "cfasync" index.html` antes de hacer deploy.

#### 3. CDN de Chart.js
`cdn.jsdelivr.net` da 404 en el entorno de Render dev.
**Solución:** Usar siempre `cdnjs.cloudflare.com`:
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
```

#### 4. Script cortado al copiar/pegar
El `index.html` se cortaba al pegarlo en el chat o al copiarlo. Siempre verificar con:
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
- ✅ updateAgregados.js calcula days=1 (en rama dev)
- ✅ Tag v1.0-stable creado en commit 3e6ce6d
