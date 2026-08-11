# CLAUDE.md — GasGas Analytics
Checkpoint: **10 Agosto 2026**

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
    GasGas-API-Guia-de-uso.pdf       ← guía de 3 págs: se adjunta al correo del demo y se descarga del sitio
    datos-anterior.html              ← respaldo de la landing vieja. ⚠️ sigue hablando de la fuente pública
  scripts/
    updateAgregados.js               ← cron: promedios + min/max/std (cálculo incremental)
    updateHistoricos.js              ← cron legacy: stats históricos
    updateHistoricosDaily.js         ← cron: serie diaria + auto-rebuild
    generarGuiaPdf.py                ← genera la guía PDF (weasyprint). No corre en Render: se ejecuta a mano y el PDF se commitea
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
| `SENDGRID_API_KEY` | Para el demo | Envío de la llave de evaluación. **Sin ella el correo no sale**, el asistente degrada a "la recibirá en unos minutos" y /status avisa |
| `CORREO_REMITENTE` | No | Default `hola@gasgas.com.mx` |
| `WHATSAPP_NUMERO` | Para el demo | `52` + 10 dígitos, sin símbolos. Sin ella el botón final cae a `mailto:` |
| `TURNSTILE_SECRET_KEY` | Para el demo | Verificación anti-bot. **Sin ella no bloquea nada** (falla abierta a propósito) |

⚠️ Las cuatro nuevas están en **dev y producción** desde el 9 Ago. Al crear un servicio nuevo hay que copiarlas.

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

### Tablas del demo (9 Ago 2026)
| Tabla | Qué guarda |
|---|---|
| `prospectos` | Quién pidió el demo: nombre, empresa, correo, dominio, nivel, `areas TEXT[]`, estimado, IP, si el correo salió |
| `api_keys_prueba` | Llave `gg_test_…`, límite 500, `expira_en`, **`activada_en`** (NULL = sin estrenar), `llamadas` |
| `solicitudes_bloqueadas` | Cada intento rechazado con su motivo, dominio e IP |

Índices para los topes: `prospectos(email)`, `(dominio, created_at)`, `(ip, created_at)`, `(created_at)`.

### Strapi y la DB
Strapi comparte esta base (tablas `admin_*`, `up_*`, `strapi_*`, `sessions`, `brands`) y en el pasado borró tablas al hacer deploy. La protección `CREATE TABLE IF NOT EXISTS` + `initTables()` lo resuelve.

⚠️ **Pendiente de seguridad:** las 40 tablas tienen **RLS desactivado** y la Data API de Supabase expone el esquema `public`. Nada del sistema la usa (todo entra por conexión directa). Recomendación: quitar `public` de *Exposed schemas* (Supabase → Data API → Settings) y apagar "Automatically expose new tables".

---

## Áreas GasGas (9 Ago 2026)

Seis macro-regiones comerciales **definidas por GasGas**. Parten de la agrupación que usa la industria
de consumo, pero la definición es propia: movimos Veracruz y Querétaro y redefinimos el Área V.
**Nunca se nombra la marca de la que partieron**, ni aquí ni de cara al cliente.

| Clave | Nombre | Entidades | Estaciones |
|---|---|---|---|
| I | Pacífico | BC · BCS · Son · Sin · Nay | 2,113 |
| II | Norte | Chih · Coah · Dgo · NL · Tamps · SLP · Zac | 3,283 |
| III | Bajío | Jal · Gto · **Qro** · Mich · Ags · Col | 3,056 |
| IV | Centro | Pue · Hgo · Mor · Tlax · Gro · Edoméx (sin conurbación) | 2,005 |
| V | Valle de México | CDMX + 59 municipios conurbados + Tizayuca, Hgo | 1,252 |
| VI | Sureste | **Ver** · Oax · Chis · Tab · Camp · Yuc · QR | 2,485 |

### Objetos en la base
- `gasgas_areas` — catálogo (RLS activa, política de lectura para `gasgas_ro` y `service_role`)
- `gasgas_areas_reglas` — 38 reglas: una por estado (prioridad 0) + 6 excepciones por rango de CP (prioridad 10)
- `gasgas_area_de(estado, cp)` — resuelve la clave
- `gas_stations.gasgas_area` (indexada) y `gas_stations.gasgas_area_metodo`
- `v_gasgas_areas_cobertura` — vista de resumen

### Cómo se asignó (importante si se rehace)
⚠️ **`gas_stations.municipio` NO trae municipios, trae localidades** — "Ciudad López Mateos" en vez de
Atizapán. Por eso el Edomex tiene 267 valores distintos cuando existen 125 municipios. El VDM **no se
puede armar con ese campo**; se armó por **rangos de CP**, que sí mapean limpio.

Resultado: 13,822 estaciones por CP (97.4%), 360 por vecino más cercano, 12 corregidas a mano
(el padrón traía el CP mal: cuatro gasolineras de Ecatepec vienen con CP de Toluca).
`gasgas_area_metodo` guarda cuál se usó: `cp` · `vecino` · `geo`.

---

## Rangos de Precios Válidos

Objeto `RANGE` presente en `updateAgregados.js` y `updateHistoricosDaily.js`:

| Producto | Mínimo | Máximo |
|---|---|---|
| Regular | 21 | 27 |
| Premium | 23 | 32 |
| Diesel | 25 | 33 |

⚠️ **Los rangos viven en tres lugares:** `updateAgregados.js`, `updateHistoricosDaily.js` y ahora
también `server.js` (endpoint `/api/stats-hoy`). Si se ajustan por percentiles hay que cambiar los tres,
si no la página publica un número y los promedios se calculan con otro. **Pendiente: centralizarlos.**

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
| `GET /api/precios` | `market` (nacional/estado/municipio/**area**), `value`, `days` (1/7/30), `product` | Incluye `semaforo` (barato/medio/caro, umbral ±3%). **`min` y `max` ya vienen mapeados al producto pedido** — en el frontend usar `precios.min`, nunca `min_regular` |
| `GET /api/historico` | `market`, `value`, `days` (7/30) | Serie diaria |
| `GET /api/estados` | — | 32 estados |
| `GET /api/municipios` | `estado` | `[{municipio, estaciones}]` |
| `GET /api/areas` | — | **Nuevo 9 Ago 2026.** Catálogo de las 6 Áreas GasGas con sus entidades y conteo de estaciones |
| `GET /api/ranking-estados` | `product` | **Ampliado 7 Ago 2026:** ahora incluye `stations_count` y `delta7_regular/premium/diesel` |
| `GET /api/vecinos` | `estado`, `product` | Comparativo regional |
| `GET /api/marcas` | — | Promedios por marca comercial |
| `GET /api/stats-hoy` | — | `{precios_hoy, precios_validados, precios_descartados, registros_hoy, fecha}`. **`precios_hoy` es la suma de valores individuales** (regular+premium+diesel), no de estaciones. `precios_validados` aplica los rangos; el descarte (~2%) es la evidencia del filtro |
| `GET /api/demo/cp` | `cp`, `product` | **Demo de nivel CP.** Whitelist de 8 CPs + rate limit 30/h por IP |
| `POST /api/lead` | — | Captura de prospectos (legado) |
| `POST /api/solicitar-acceso` | — | **Motor del demo.** Ver sección "Demo self-service" |
| `GET /api/test` | — | Health check |

### Privados (tablero interno)

| Endpoint | Notas |
|---|---|
| `POST /api/status/login` | Valida `STATUS_PIN`, cookie firmada 30 días, máx 10 intentos/15 min por IP |
| `GET /api/status/checks` | Requiere cookie. Verifica Clara, cobee, último seed, cortes, API pública + uso 24 h |

**Caché:** los GET de `/api` responden `Cache-Control: public, max-age=300, s-maxage=300`.

---

## Demo self-service (9 Ago 2026)

Sustituye al `mailto:` que **no hacía nada** para quien usa Gmail en el navegador: durante días
se perdió todo el que llegaba al final de la página.

### Recorrido
1. **Paso 1** nivel: Estado o Municipio
2. **Paso 2** Áreas GasGas: multiselección de las 6 + "Todo el país", con el estimado en vivo
3. **Paso 3** datos: nombre, empresa, correo **de empresa**, WhatsApp opcional
4. Correo con la llave + `GasGas-API-Guia-de-uso.pdf` adjunto → botón de WhatsApp con el mensaje redactado

El asistente vive **arriba, pegado al hero** (`<section id="contacto">` es la 2ª sección).
Al final de la página hay un cierre que regresa a él.

### Precio del estimado
1 área = precio base del nivel; **cada área adicional +10%**; las 6 = ×1.5 (el mismo factor que tenía
"nacional", así que nadie que pida país completo ve un cambio). Nivel municipio: 1 área $28,750 → 6 áreas $43,250.
El cálculo está duplicado en `server.js` (`estimar`) y en la landing (`wEstimado`): **deben coincidir**.

### Llaves de evaluación
- 500 consultas · **7 días desde la PRIMERA consulta**, no desde la emisión
- Al emitirse hay 30 días para estrenarla (`api_keys_prueba.expira_en`); la primera llamada fija
  `activada_en` y recalcula `expira_en` a 7 días
- El middleware que cuenta el uso **debe ir antes de las rutas** en `server.js` (ver Problemas Conocidos #20)

### Anti-abuso (4 capas)
| Capa | Regla |
|---|---|
| Turnstile (Cloudflare) | Verificación invisible. Site key pública en el HTML, secreta en Render |
| Dominio | Debe tener MX o A. **Falla abierta**: solo rechaza si el DNS confirma que no existe |
| Por correo | 1 llave, **sin reemisión automática** |
| Por empresa | 1 llave al mes por dominio |
| Por conexión | 2 llaves al día por IP · 5 intentos/hora |
| Global | 30 llaves al día |

Todo rechazo se registra en `solicitudes_bloqueadas` y se ve en `/status`, con foco ámbar
si pasa de 40 en 24 h o si una IP insiste 5+ veces. **Sin ese registro un ataque se ve igual
que un día tranquilo.**

Los mensajes de rechazo **nunca cierran la puerta**: todos empujan a `hola@gasgas.com.mx`.
Que una segunda persona de la misma empresa pida el demo es la mejor señal de compra que hay,
y queremos enterarnos.

### Correo (SendGrid)
- Dominio autenticado con DKIM (3 CNAME + DMARC en Cloudflare, todos **DNS only**)
- ⚠️ **Trial hasta el 9 de octubre de 2026.** Después, plan de pago desde $19.95 USD/mes —
  el plan gratuito permanente ya no existe. Alternativas si el volumen no lo justifica: Resend, Amazon SES
- ⚠️ **El rastreo de clics va apagado.** Con él encendido SendGrid reescribe las URLs y **rompe el
  `curl` de copiar y pegar** que le prometemos al cliente
- HTML en tablas con estilos en línea (lo único que respetan Gmail y Outlook), sin imágenes externas

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

### Municipios y Áreas en una sola pasada (9 Ago 2026)
Son dos cortes del mismo universo, así que se calculan con `GROUPING SETS` en **una sola lectura**
de `prices`. Separarlos habría costado ~3.4 GB extra por periodo, unos **200 GB/mes** de egress.
**Las Áreas GasGas costaron cero GB adicionales.**

---

## Frontend

### Rutas

| Ruta | Archivo | Qué es |
|---|---|---|
| `/` | index.html | **Landing B2B** (diseño Claude Design): hero, **asistente de demo (2ª sección)**, ticker, mapa, proceso, niveles, API, playground, planes, cierre |
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
- **No se menciona la fuente ni "el archivo que limpiar"** en nada que vea el cliente (ver Mensajes)
- Pie del sitio: *"datos procesados por el algoritmo de calidad GasGas"*
- Cobertura publicada: 14,194 estaciones · 32 estados · 2,900+ municipios · **5,000+ CPs** · histórico desde mayo 2024 · **7 cortes al día**
- La landing es un export de **Claude Design** (`<x-dc>` + `support.js`): la lógica vive en la clase `Component extends DCLogic` al final del archivo, y el HTML usa `{{ }}` y `<sc-for>`. **No romper esa estructura.**
- Capa responsive añadida post-export en el `<style>`: no borrarla al reimportar diseños
- ⚠️ La capa responsive usa selectores por **substring del atributo `style`** (`[style*="display: flex"]`).
  **Se rompen al editar el estilo en línea.** Para cosas críticas usar clases reales (ej. `.gg-tira`)
- **Cintilla de estados:** dos copias explícitas (`.gg-copia`) dentro de `.gg-tira`. El ancho total es
  el doble exacto de una copia, así el `-50%` de la animación cae siempre en el inicio de la segunda.
  La separación va como `padding` de cada elemento, **nunca como `gap` del contenedor**

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
- `/api/areas` → 6 áreas · `/api/precios?market=area&value=V&days=1` → responde
- `/api/stats-hoy` → `precios_hoy − precios_validados = precios_descartados`
- Abrir `/` y confirmar que el asistente es la 2ª sección y carga los 3 pasos
- Sonda del demo **sin crear nada**: POST a `/api/solicitar-acceso` con dominio inexistente y sin token.
  Con Turnstile activo debe dar **403 `verificacion_fallida`**; si da 422 es que falta la variable
- Verificar en móvil (la landing tiene capa responsive propia)
- **Purge de Cloudflare**
- Al verificar por URL, agregar `?v=<timestamp>`: los GET de `/api` traen caché de 5 min

---

## Conexiones a la base — incidente del 10 Ago 2026

**Qué pasó:** se agotaron las 60 conexiones de Postgres (3 reservadas al superusuario).
Toda la API respondió **500 durante horas** y nadie se enteró hasta que rebotó un proceso externo.

**Por qué:** cada servicio abría hasta **10** conexiones (el default de `pg`) y las dejaba
apartadas. Sumando web prod, web dev, 3 crons, Strapi y los trabajos de Northflank ya se
llenaba; los ~14 despliegues de ese día lo remataron, porque **Render corre la instancia
vieja y la nueva a la vez** durante cada despliegue.

**Efecto secundario:** al reiniciar Supabase para liberar, el servidor web **se murió**
(`Exited with status 1`). Sin un `pool.on("error")`, node-postgres convierte el corte de
conexiones en un error no manejado y Node mata el proceso.

### Cómo quedó
| Medida | Valor |
|---|---|
| `DATABASE_URL` de los servicios web | puerto **6543** (modo transacción, multiplexa) |
| `DATABASE_URL` de los crons | puerto **5432** (sesión) — corren y se van |
| Pool del servicio web | `max: 4` · idle 20 s · timeout 8 s |
| Pool de los crons y del seeder de Clara | `max: 2` |
| Manejador `pool.on("error")` | en todos |

**Medido después:** 30 peticiones simultáneas → 30/30 OK, y el servicio web usa **4 conexiones**.
Uso total **14 de 60 (23%)** contra 60/60 antes.

⚠️ **No subir el pool "por si acaso".** Con 4 aguanta 30 peticiones a la vez; el cuello nunca
fue el pool, era el cupo compartido.

`/status` tiene tarjeta de conexiones: foco ámbar arriba del **70%** o si hay conexiones
atoradas en transacción. **Si algún día sube de 40%, revisar Northflank** (Feed prices, API de
Clara y API de cobee siguen sin tope explícito; sus repos no están en `gasgas-repos`).

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

**Por Área GasGas (9 Ago 2026):** el precio del nivel es por **1 área**; cada área adicional suma 10%;
las 6 = ×1.5. Bajó el piso de entrada a la mitad: quien solo opera en el Valle de México entra con
$28,750 en vez de tener que contratar el país completo. Y sabemos **qué área pidió**, que es
inteligencia de dónde está la demanda.

Setup inicial = una mensualidad. Histórico (desde mayo 2024) se cotiza aparte. CFDI desde el día uno.
Contacto comercial: **hola@gasgas.com.mx**

Pendientes: rate limiting por API key, login de clientes, pagos.

---

## Mensajes: qué NO decimos

**No se menciona de dónde sale el dato ni se plantea "el archivo" como alternativa.** Muchos clientes
no saben que existe un archivo público; decírselo es sembrarles una objeción que no traían.
Retirado el 9 Ago de la landing, `/mapa`, `/dashboard`, `/docs`, el OpenAPI, la colección de Postman
y la guía PDF.

- El titular pasó de *"no un archivo que limpiar"* a **"listo para su sistema"**
- *"Limpieza continua"* → *"Validación en cada corte"*: decir que limpiamos implica que el origen viene sucio
- El argumento es lo que **recibe** (cobertura, marca comercial resuelta, 7 cortes, histórico), no lo que evita
- Si un comprador pregunta por la fuente, se contesta **en la conversación**, no en la página
- ⚠️ `datos-anterior.html` todavía habla de la fuente. No está enlazado pero es alcanzable por URL

Tampoco se nombra la marca ajena de la que partieron las áreas: son **Áreas GasGas** y la definición es propia.

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
20. **Middleware declarado después de las rutas** — el contador de uso de las llaves de prueba
    **nunca corrió**: Express solo ejecuta lo que se declara antes de la ruta que atiende la petición.
    `/status` decía "sin usar la llave" aunque el cliente hiciera mil consultas. Resuelto 9 Ago:
    el `app.use("/api", …)` va **antes** de `app.get("/api/precios", …)`
21. **SendGrid reescribía las URLs** — el rastreo de clics convertía el `curl` del correo en un enlace
    `ct.sendgrid.net` y **el comando no funcionaba**. Resuelto 9 Ago apagando `tracking_settings`
22. **La cintilla brincaba** — dos causas: (a) se recalculaba en cada render y el feed dispara uno
    cada 2.6 s; (b) con `gap` + `padding-left`, el `-50%` caía 48 px antes del inicio de la copia.
    Resuelto 9 Ago: lista congelada + dos copias explícitas
23. **`gas_stations.municipio` son localidades, no municipios** — no sirve para agrupar por municipio real.
    Usar CP o lat/lng (ver Áreas GasGas)
24. **Al medir animaciones con el navegador: verificar `document.visibilityState`** — Chrome congela
    animaciones y temporizadores en pestañas de fondo. El 9 Ago diagnostiqué un "hilo saturado" que
    en realidad era el ahorro de energía de Chrome. Perdí media hora
25. **RLS sin política = cero filas** — al activar RLS en `gasgas_areas` el endpoint devolvió `[]`
    aunque `gasgas_ro` tenía GRANT. Hace falta `CREATE POLICY … FOR SELECT TO gasgas_ro`
26. **Conexiones agotadas** — ver la sección del incidente del 10 Ago. Regla: **todo pool nuevo
    lleva `max` explícito y `pool.on("error")`**. El default de 10 por proceso no es gratis
27. **Caché de 5 min en los GET de `/api`** — al verificar un despliegue, agregar `?v=<timestamp>`
    o parecerá que el cambio no subió

---

## Historial reciente (5–9 Agosto 2026)

- ✅ Push directo desde Cowork con token fine-grained (5 Ago)
- ✅ Layout desktop 2 columnas + navegación entre páginas (5 Ago)
- ✅ OpenAPI 3.1 + colección Postman + secciones de caché/seguridad/errores en `/docs` (5 Ago) → evaluación externa **8.9/10**
- ✅ Landing B2B de Claude Design con datos reales, playground y Monitor Nacional (6–7 Ago)
- ✅ La landing pasó a ser la página principal; dashboard movido a `/dashboard` (7 Ago)
- ✅ Cortes de 2 → 7 al día (7 Ago)
- ✅ Tablero interno `/status` con PIN (7–8 Ago)
- ✅ Seeder de Clara: 1 consulta en vez de 3 + pipeline Redis + credenciales fuera del código (8 Ago)
- ✅ Cálculo incremental en updateAgregados: **–86%** (8 Ago)

### 9 Agosto 2026 — todo esto salió a producción el mismo día
- ✅ **Áreas GasGas**: definición propia, 14,194 estaciones clasificadas, `market_type='area'` en la API
- ✅ **Demo self-service**: asistente de 3 pasos, llave por correo, guía PDF adjunta, entrega a WhatsApp
- ✅ El asistente subió al inicio de la página; el `mailto:` muerto quedó fuera
- ✅ **Anti-abuso**: Turnstile + validación de dominio + topes + registro de bloqueados en `/status`
- ✅ SendGrid con dominio autenticado (DKIM) y rastreo de clics apagado
- ✅ Se retiró toda mención a la fuente pública del sitio, docs, OpenAPI, Postman y la guía
- ✅ `stats-hoy` separa recibidos / validados / descartados
- ✅ Marca homologada a **GasGas** (reporte de César)
- ✅ Corregidos: contador de uso que nunca corrió, cintilla que brincaba, vigencia desde el primer uso

### Pendientes al 9 Ago (en orden de urgencia)
1. **Rotar la llave de SendGrid y el PIN de `/status`** — ambos quedaron a la vista en capturas
2. **Revocar la llave vieja de SendGrid** del historial de git del seeder de Clara
3. **Probar el demo completo en producción** con un correo de empresa, y **pegar el `curl`** para
   confirmar que el contador de uso ya funciona
4. Optimizar cobee (1 consulta agrupada: 87 ms vs ~1,850 ms medidos) — el mayor consumo pendiente
5. Documentar las Áreas GasGas en `/docs`, el OpenAPI y la colección de Postman
6. Agregar "Área" como nivel en el playground de la landing
7. Centralizar los rangos de precios (hoy en 3 archivos)
8. Cerrar la Data API de Supabase (quitar `public` de *Exposed schemas*)
9. Decidir antes del **9 de octubre** si se sigue en SendGrid de pago o se migra
10. Borrar o limpiar `datos-anterior.html`
11. Backfill de 3,528 estaciones sin CP · `www.gasgas.com.mx` (CNAME) · `status.gasgas.com.mx`
