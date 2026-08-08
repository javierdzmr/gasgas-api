# CLAUDE.md — GasGas Analytics
Checkpoint: **8 Agosto 2026**

Este archivo provee contexto a Claude cuando trabaja en este repositorio.

---

## Descripción del Proyecto

GasGas Analytics recopila, almacena y analiza precios de gasolina en México.
Modelo de negocio: **venta de datos y API a empresas** (fintechs, plataformas de gasto, flotillas).
Sitio público: https://gasgas.com.mx · API: https://api.gasgas.com.mx

**Clientes en producción:** Clara (precios por CP) y cobee (promedios diarios por estado).

---

## Stack Tecnológico

| Componente | Tecnología | URL |
|---|---|---|
| Sitio + API producción | Node.js / Express en **Render** | gasgas.com.mx · api.gasgas.com.mx |
| Entorno de desarrollo | Render (plan Free, se duerme) | gasgas-api-dev.onrender.com |
| Base de datos | **Supabase PostgreSQL 17** (ref `qorvxlbuhqopfbvuyfjh`, org "J's World", plan Pro) | — |
| DNS / SSL / caché | Cloudflare (plan Free) | — |
| Repositorio | GitHub | github.com/javierdzmr/gasgas-api |
| Ingesta CNE + seeders | **Northflank** (proyecto `gasgas-analytics`) | — |

**Importante:** el frontend ya NO vive en GoDaddy. Todo se sirve desde Render; el push a GitHub dispara el deploy.

---

## Repositorios relacionados (fuera de este repo)

| Repo | Qué hace | Dónde corre |
|---|---|---|
| `GasGasApp/gasgas-analytics-seed` | **"Feed prices"** — ingesta de precios de la CNE a `prices`. Corre 11× al día (`0 2,10,13,16,17,18,19,20,21,22,23 * * *` UTC), pero **el lote real entra 1 vez al día** (~13,500 filas, marcado a medianoche UTC = 18:00 MX del día anterior). | Northflank |
| `GasGasApp/gasgas-analytics-api-as-a-service-seed` | Seeder de **Clara**: calcula promedios por CP y los indexa en Redis. Corre 2× al día (`0 13,1 * * *` UTC). | Northflank |
| APIs de clientes | `clara.gasgas.app/api/precios-por-cp/{cp}` (GET, `x-api-key`) y `cobee.gasgas.app/api/daily-average-price` (POST `{date}`) | Northflank |
| `GasGasApp/GasGas` | App móvil React Native | — |

---

## Estructura del Repositorio

```
gasgas-api/
  server.js                          ← API + sitio + status privado
  package.json
  public/
    index.html                       ← LANDING B2B (página principal de gasgas.com.mx)
    dashboard.html                   ← dashboard de precios al consumidor (/dashboard)
    datos.html                       ← copia de la landing (/datos, para links viejos)
    datos-v2.html                    ← copia de trabajo de la landing
    datos-anterior.html              ← respaldo de la landing previa
    mapa.html                        ← Monitor Nacional (D3 + choropleth) (/mapa)
    docs.html                        ← documentación pública de la API (/docs)
    status.html                      ← tablero interno con PIN (/status)
    support.js                       ← runtime de Claude Design (necesario para index/datos)
    openapi.json                     ← especificación OpenAPI 3.1
    gasgas-api.postman_collection.json
  scripts/
    updateAgregados.js               ← cron: promedios + min/max/std (cálculo incremental)
    updateHistoricos.js              ← cron legacy: stats históricos
    updateHistoricosDaily.js         ← cron: serie diaria + auto-rebuild
  docs/
```

⚠️ `index.html`, `datos.html` y `datos-v2.html` comparten el mismo contenido (landing). **Al cambiar la landing hay que actualizar los tres.**

---

## Variables de Entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `DATABASE_URL` | Sí | Supabase PostgreSQL (SSL). El servicio web usa usuario de **solo lectura** |
| `PORT` | No | Puerto (default 10000) |
| `STATUS_PIN` | Para /status | PIN de acceso al tablero interno |
| `CLARA_API_KEY` | Para /status | Llave para verificar la API de Clara |
| `COBEE_API_KEY` | Opcional | Solo si cobee exige llave |
| `FORZAR_RECALCULO` | No | `=1` fuerza recálculo completo en updateAgregados |

---

## Comandos

```bash
npm start                                   # node server.js

node scripts/updateAgregados.js             # requiere DATABASE_URL
FORZAR_RECALCULO=1 node scripts/updateAgregados.js   # ignora el cálculo incremental
node scripts/updateHistoricosDaily.js
```

---

## Base de Datos (Supabase)

### gas_stations
Padrón de **14,194** estaciones. Columnas clave: `id`, `estado`, `municipio`, `cp`, `lat`, `lng`, `cre_id`, `estado_slug`.
**5,013 CPs** distintos con estación · **3,528 estaciones sin CP válido** (pendiente: 2ª tanda de backfill).

### prices
Motor principal: **+10.7M registros**. Columnas: `id`, `date`, `regular`, `premium`, `diesel`.
**`date` es la FECHA DEL DATO** (medianoche UTC), no el momento de inserción — por eso en México se ve como "18:00 del día anterior". Usar `p.date::date` para comparar fechas.
Backdata: mayo 2024 → presente.

### prices_gas_station_links
JOIN entre `prices` y `gas_stations`. Columnas: `id`, `price_id`, `gas_station_id`.

### precios_agregados
Pre-cálculo por mercado y periodo (**8,854 filas**). Evita recorrer millones de registros.
Columnas: `market_type`, `market_value`, `days`, `regular/premium/diesel`, `min/max/std_*`, `stations_count`, `updated_at`.
Índice único: `(market_type, market_value, days)`.
`market_type`: `'nacional'` (`market_value='all'`) · `'estado'` (nombre, ej. `'Chiapas'`) · `'municipio'` (llave `'Estado|Municipio'`, la barra se codifica `%7C`).
Periodos: `days = 1, 7, 30`. Mercados: 1 nacional + 32 estados + **2,919 municipios**.

### precios_historicos_agregados
Serie diaria para gráficas (**146,083 filas**). Columnas: `market_type`, `market_value`, `date`, `regular`, `premium`, `diesel`, `estado_slug`, `updated_at`.

### Strapi y la DB
Strapi comparte esta base (tablas `admin_*`, `up_*`, `strapi_*`, `sessions`, `brands`) y en el pasado borró tablas al hacer deploy. La protección `CREATE TABLE IF NOT EXISTS` + `initTables()` lo resuelve.

⚠️ **Pendiente de seguridad:** las 40 tablas tienen **RLS desactivado** y la Data API de Supabase expone el esquema `public`. Nada del sistema la usa (todo entra por conexión directa). Recomendación: quitar `public` de *Exposed schemas* (Supabase → Data API → Settings) y apagar "Automatically expose new tables".

---

## Rangos de Precios Válidos

Objeto `RANGE` presente en `updateAgregados.js` y `updateHistoricosDaily.js`:

| Producto | Mínimo | Máximo |
|---|---|---|
| Regular | 21 | 27 |
| Premium | 23 | 32 |
| Diesel | 25 | 33 |

```sql
-- Diagnóstico para reajustar rangos
SELECT PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY regular) AS p01,
       PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY regular) AS p99
FROM prices WHERE regular > 0 AND date >= NOW() - INTERVAL '30 days';
```

---

## API Endpoints

### Públicos

| Endpoint | Parámetros | Notas |
|---|---|---|
| `GET /api/precios` | `market` (nacional/estado/municipio), `value`, `days` (1/7/30), `product` | Incluye `semaforo` (barato/medio/caro, umbral ±3%). **`min` y `max` ya vienen mapeados al producto pedido** — en el frontend usar `precios.min`, nunca `min_regular` |
| `GET /api/historico` | `market`, `value`, `days` (7/30) | Serie diaria |
| `GET /api/estados` | — | 32 estados |
| `GET /api/municipios` | `estado` | `[{municipio, estaciones}]` |
| `GET /api/ranking-estados` | `product` | **Ampliado 7 Ago 2026:** ahora incluye `stations_count` y `delta7_regular/premium/diesel` |
| `GET /api/vecinos` | `estado`, `product` | Comparativo regional |
| `GET /api/marcas` | — | Promedios por marca comercial |
| `GET /api/stats-hoy` | — | `{precios_hoy, registros_hoy, fecha}` — conteo real del último lote |
| `GET /api/demo/cp` | `cp`, `product` | **Demo de nivel CP.** Whitelist de 8 CPs + rate limit 30/h por IP |
| `POST /api/lead` | — | Captura de prospectos |
| `GET /api/test` | — | Health check |

### Privados (tablero interno)

| Endpoint | Notas |
|---|---|
| `POST /api/status/login` | Valida `STATUS_PIN`, cookie firmada 30 días, máx 10 intentos/15 min por IP |
| `GET /api/status/checks` | Requiere cookie. Verifica Clara, cobee, último seed, cortes, API pública + uso 24 h |

**Caché:** los GET de `/api` responden `Cache-Control: public, max-age=300, s-maxage=300`.

---

## Cron Jobs (Render)

| Nombre | Script | Schedule (UTC) | Hora México | Función |
|---|---|---|---|---|
| update-precios-historico | updateHistoricos.js | `50 11 * * *` | 5:50 AM | Stats legacy — corre primero |
| update-precios-agregados | updateAgregados.js | `30 2,12,16,18,20,22,23 * * *` | **7 cortes**: 6:30, 10:30, 12:30, 14:30, 16:30, 17:30, 20:30 | Crea tablas + recalcula promedios. **Cálculo incremental (8 Ago 2026)** |
| update-historicos-daily | updateHistoricosDaily.js | 4× al día (8,14,20,2 UTC) | — | Serie diaria + auto-rebuild |

### ⚡ Cálculo incremental (8 Ago 2026)
`updateAgregados.js` compara `MAX(date)` de `prices` contra `MAX(updated_at)` de `precios_agregados`:
- `days=1` → siempre se recalcula (ligera, captura precios que entran durante el día)
- `days=7` y `days=30` → solo si hay lote nuevo (son las pesadas: ~3.4 GB y ~30 s cada una)

Ahorro medido: **~86%** (de ~143 GB/día a ~20 GB/día). Forzar con `FORZAR_RECALCULO=1`.

---

## Frontend

### Rutas

| Ruta | Archivo | Qué es |
|---|---|---|
| `/` | index.html | **Landing B2B** (diseño Claude Design): hero con promedios en vivo, ticker, teaser al mapa, proceso de limpieza, niveles, API, playground, planes |
| `/dashboard` | dashboard.html | Dashboard de precios al consumidor (chips nacional/estado, gráfica SVG, chips Pro bloqueados) |
| `/datos` | datos.html | Mismo contenido que `/` (compatibilidad con links viejos) |
| `/mapa` | mapa.html | Monitor Nacional: choropleth D3, KPIs, movimientos 7 días, ficha estatal, feed |
| `/docs` | docs.html | Documentación pública de la API |
| `/status` | status.html | **Tablero interno con PIN** (también responde en `status.gasgas.com.mx`) |

### Playground de `/datos` ("Pruébela usted mismo")
Armador de consultas sin código contra la API real: producto → lugar (estados/municipios reales en cascada) → nivel. Muestra la petición, la respuesta con colores, latencia real y traducción a lenguaje de negocio.
Niveles **Estado/Municipio/CP** activos; **Estación** bloqueado (gancho comercial).

### Reglas del diseño
- Colores: azul `#0E2A47` · verde `#00A94F`/`#007A39` · Magna verde, Premium `#DC2626`, Diésel `#334155`
- Tipografías: Figtree (UI) + JetBrains Mono (números)
- Fuente declarada en el sitio: *"Fuente: CNE · datos depurados por el algoritmo de calidad GasGas"*
- Cobertura publicada: 14,194 estaciones · 32 estados · 2,900+ municipios · **5,000+ CPs** · histórico desde mayo 2024 · **7 cortes al día**
- La landing es un export de **Claude Design** (`<x-dc>` + `support.js`): la lógica vive en la clase `Component extends DCLogic` al final del archivo, y el HTML usa `{{ }}` y `<sc-for>`. **No romper esa estructura.**
- Capa responsive añadida post-export en el `<style>`: no borrarla al reimportar diseños

---

## Cloudflare

- SSL Full strict · Always Use HTTPS
- Cache Rule: `/api/*` → Bypass
- ⚠️ **Tras cada deploy que cambie HTML hay que hacer Purge Everything**, si no se sigue sirviendo la versión vieja
- ⚠️ **Email Obfuscation rompe los correos en páginas React**: los `mailto:` de la landing se arman por JavaScript para esquivarlo
- ⚠️ Rocket Loader debe estar **OFF**

---

## CORS

```javascript
const ALLOWED_ORIGINS = [
  'https://gasgas.com.mx', 'https://www.gasgas.com.mx',
  'https://api.gasgas.com.mx', 'https://gasgas-api-dev.onrender.com',
  'http://localhost:3000'
];
```

---

## Ramas de Git y flujo

- `main` → producción (gasgas.com.mx) · `dev` → pruebas (gasgas-api-dev.onrender.com)

```bash
git checkout dev && git add -A && git commit -m "..." && git push origin dev
# probar en dev, con OK de J:
git checkout main && git merge dev && git push origin main && git checkout dev
```

**Push automático:** el repo tiene un token fine-grained en `.git/gasgas-credencial` (credential.helper store). Claude puede hacer push sin intervención.
**Autoría de commits:** usar `git -c user.name="javierdzmr" -c user.email="javier.diaz11@gmail.com" commit`.

### Checklist antes de producción
- `GET /api/test` → `{status:'ok'}` · `/api/estados` → 32 · `/api/stats-hoy` → fecha de hoy
- `/api/precios?market=estado&value=Chiapas&days=1&product=regular` → min/max reales
- `/api/ranking-estados?product=regular` → 32 estados con `delta7_*` y `stations_count`
- Abrir `/`, `/dashboard`, `/mapa`, `/docs` — sin errores en consola
- Verificar en móvil (la landing tiene capa responsive propia)
- **Purge de Cloudflare**

---

## Costos e infraestructura (8 Ago 2026)

**Supabase Pro** — $25/mes + cómputo (~$7 con créditos). Dos proyectos: `gasgas-analytics` y `tio-cali`.

⚠️ **Ciclo Jul 10 – Ago 10 2026:** egress de **895 GB** contra 250 GB incluidos (excedente 645 GB ≈ $58). El **spend cap se desactivó el 8 Ago** para evitar que los proyectos entren en modo restringido (error 402) y tumben a Clara/cobee.

### Consumo medido con `pg_stat_statements`

| Proceso | GB leídos | CPU | Estado |
|---|---|---|---|
| `updateAgregados` (min/max/std) | 5,005 GB | 12.5 h | ✅ Optimizado (–86%) |
| API de cobee (96 consultas por petición) | 1,550 GB | 2.5 h | ⏳ Pendiente (medido: 1 consulta agrupada = 87 ms vs ~1,850 ms) |
| Seeder de Clara (temp table) | 161 GB | 1.2 h | ✅ Optimizado (–66%) |

**Consulta útil para diagnosticar:**
```sql
SELECT calls, ROUND((total_exec_time/1000/60)::numeric,1) AS min_cpu,
       ROUND(((shared_blks_read+shared_blks_hit)*8192/1024.0^3)::numeric,1) AS gb_leidos,
       LEFT(regexp_replace(query,'\s+',' ','g'),80) AS consulta
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;
```

---

## GasGas Pro — Modelo comercial vigente

Precios publicados en `/datos` (MXN/mes + IVA, "desde", ajustables por cobertura y volumen):

| Nivel | Precio | Incluye |
|---|---|---|
| Estado | desde **$17,250** | 32 mercados + nacional, 3 combustibles, diario |
| Municipio | desde **$28,750** | + 2,900 plazas con dispersión |
| Código Postal | desde **$40,250** | + 5,000 zonas (el más contratado) |
| Estación | a la medida | 14,194 estaciones con marca y ubicación |

Setup inicial = una mensualidad. Histórico (desde mayo 2024) se cotiza aparte. CFDI desde el día uno.
Contacto comercial: **hola@gasgas.com.mx**

Pendientes: llaves de prueba, rate limiting por API key, login de clientes, pagos.

---

## Política del changelog público (`/docs`)

Solo se registra lo que el cliente puede notar: **campos y endpoints nuevos, frecuencia, cobertura y documentación**.
- Se redacta como **valor entregado**, nunca como falla corregida ("el conteo ahora refleja el padrón completo", no "corregimos un bug").
- **No se publican**: mejoras internas de infraestructura, detalles de implementación, incidencias sin impacto en el dato, ni roadmap.
- **Excepción ética:** si un error afectó datos que un cliente ya usó, se le avisa **por correo directo** — eso no se resuelve con silencio.

## Problemas Conocidos (no repetir)

1. **CORS** — resuelto 14 Abr 2026 (middleware nativo)
2. **Cloudflare inyecta `cfasync`** y rompe el JS — Rocket Loader OFF
3. **CDN de Chart.js:** usar `cdnjs.cloudflare.com`, nunca jsdelivr (404)
4. **Script cortado al pegar:** verificar con `tail -c 25 archivo.html` → `</script></body></html>`
5. **Render Free se duerme** — despertar dev con `/api/test`
6. ~~Dos frontends desincronizados~~ — resuelto: todo se sirve desde Render
7. **Min/Max irreales** — resuelto con rangos por percentiles (13 Abr 2026)
8. **days=1 con desfase UTC** — usar `p.date::date = (SELECT MAX(date::date) FROM prices)`
9. **Rango interno del estado** — usar `preciosHoy.min`, no `preciosHoy[minKey]`
10. **Min/Max outliers en 7d/30d** — triple protección en updateAgregados
11. **Min/Max se corrompían** — updateHistoricos 1×/día, agregados limpia después
12. **Tablas borradas por Strapi** — CREATE TABLE IF NOT EXISTS + auto-rebuild + initTables()
13. **$NaN en frontend** — guard con `isNaN()` y check de objeto vacío
14. **Crons suspendidos 23 días** — initTables() en server.js al arrancar
15. **Cron recalculaba 7× lo mismo** — resuelto 8 Ago 2026 con cálculo incremental (ver arriba)
16. **`total_estaciones` = 0 en municipios** — resuelto 7 Ago 2026: la llave `Estado|Municipio` no se separaba (`split_part`)
17. **"▲ +0.00" contradictorio** — resuelto: si el cambio de 7 días redondea a cero, mostrar "· s/c" neutro
18. **Frescura del seed mal medida** — no contar horas desde `MAX(date)` (es fecha del dato, no de carga); comparar la fecha del lote contra hoy en México
19. **Credenciales en el código del seeder de Clara** — resuelto 8 Ago 2026: SendGrid y Redis pasaron a variables de entorno. **La llave vieja de SendGrid sigue expuesta en el historial de git: hay que revocarla.**

---

## Historial reciente (5–8 Agosto 2026)

- ✅ Push directo desde Cowork con token fine-grained (5 Ago)
- ✅ Layout desktop 2 columnas + navegación entre páginas (5 Ago)
- ✅ OpenAPI 3.1 + colección Postman + secciones de caché/seguridad/errores en `/docs` (5 Ago) → evaluación externa **8.9/10**
- ✅ Landing B2B de Claude Design con datos reales, playground y Monitor Nacional (6–7 Ago)
- ✅ La landing pasó a ser la página principal; dashboard movido a `/dashboard` (7 Ago)
- ✅ Cortes de 2 → 7 al día (7 Ago)
- ✅ Tablero interno `/status` con PIN (7–8 Ago)
- ✅ Seeder de Clara: 1 consulta en vez de 3 + pipeline Redis + credenciales fuera del código (8 Ago)
- ✅ Cálculo incremental en updateAgregados: **–86%** (8 Ago)
- ⏳ Pendientes: optimizar cobee (1 consulta agrupada), backfill de 3,528 CPs, cerrar Data API de Supabase, revocar llave de SendGrid, `www.gasgas.com.mx` (CNAME), subdominio `status.gasgas.com.mx`, llaves de prueba para clientes
