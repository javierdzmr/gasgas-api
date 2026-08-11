const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const dns = require('dns').promises;

const app = express();
const PORT = process.env.PORT || 10000;

// 🔐 importante para Cloudflare / Render
app.set('trust proxy', 1);

// 🌐 CORS
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 🧾 Parser de JSON (para POST /api/lead)
app.use(express.json({ limit: '16kb' }));

// 🧊 Cache-Control: los GET de /api son de LECTURA y pueden cachearse en el
//    borde (Cloudflare) y navegador ~5 min. Un millón de llamadas idénticas las
//    contesta la caché, no la base. POST (leads) nunca se cachea.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
  else res.set('Cache-Control', 'no-store');
  next();
});

// 🔒 status.gasgas.com.mx entrega directamente la página de status (con su PIN)
app.use((req, res, next) => {
  if ((req.hostname || "").startsWith("status.") && req.path === "/") {
    res.set("Cache-Control", "no-store");
    return res.sendFile(require("path").join(__dirname, "public", "status.html"));
  }
  next();
});

// 📊 Contador de uso de la API pública (ventana móvil de 24 h, en memoria)
//    Nota honesta: vive en el proceso — se reinicia con cada deploy o reinicio del servicio.
const usoApi = []; // timestamps
const usoPorRuta = new Map(); // ruta -> [timestamps]
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/status')) {
    const t = Date.now(), corte = t - 86400000;
    usoApi.push(t);
    while (usoApi.length && usoApi[0] < corte) usoApi.shift();
    const ruta = req.path.split('/').slice(0, 2).join('/') || req.path;
    let arr = usoPorRuta.get(ruta);
    if (!arr) { arr = []; usoPorRuta.set(ruta, arr); }
    arr.push(t);
    while (arr.length && arr[0] < corte) arr.shift();
    if (!arr.length) usoPorRuta.delete(ruta);
  }
  next();
});

// 📄 Servir el dashboard desde public/ (gasgas-api-dev.onrender.com)
app.use(express.static('public', { extensions: ['html'] }));

// 🗄️ conexión a la base de datos
// ============================================================
// 🔌 Pool de conexiones
//
// La base tiene un tope de 60 conexiones (3 reservadas para el superusuario).
// El 10 de agosto de 2026 se agotaron y la API entera respondió 500 durante
// horas: cada servicio abría hasta 10 conexiones (el default de `pg`) y nunca
// las soltaba, y durante un despliegue Render corre la instancia vieja y la
// nueva al mismo tiempo — o sea, el doble.
//
// Este servicio no necesita 10: las consultas son rápidas y las respuestas se
// cachean 5 minutos. Con 4 sobra, y en un despliegue el pico es 8, no 20.
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX) || 4,
  idleTimeoutMillis: 20000,        // suelta las inactivas pronto
  connectionTimeoutMillis: 8000,   // no se queda esperando para siempre
  allowExitOnIdle: false
});

// Un error del pool no debe tumbar el proceso
pool.on("error", (err) => console.error("Pool de PostgreSQL:", err.message));

// ==============================
// 🛡️ INIT: Crear tablas si no existen al arrancar
// Protege contra borrados de Strapi en deploys
// ==============================
async function initTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS precios_agregados (
        id             SERIAL PRIMARY KEY,
        market_type    VARCHAR(50)    NOT NULL,
        market_value   VARCHAR(100)   NOT NULL,
        days           INTEGER        NOT NULL,
        regular        NUMERIC(10,4),
        premium        NUMERIC(10,4),
        diesel         NUMERIC(10,4),
        min_regular    NUMERIC(10,4),
        max_regular    NUMERIC(10,4),
        std_regular    NUMERIC(10,4),
        min_premium    NUMERIC(10,4),
        max_premium    NUMERIC(10,4),
        std_premium    NUMERIC(10,4),
        min_diesel     NUMERIC(10,4),
        max_diesel     NUMERIC(10,4),
        std_diesel     NUMERIC(10,4),
        stations_count INTEGER,
        updated_at     TIMESTAMP DEFAULT NOW(),
        UNIQUE (market_type, market_value, days)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS precios_historicos_agregados (
        id           SERIAL PRIMARY KEY,
        market_type  VARCHAR(50),
        market_value VARCHAR(100),
        date         DATE,
        regular      NUMERIC(10,4),
        premium      NUMERIC(10,4),
        diesel       NUMERIC(10,4),
        estado_slug  VARCHAR(100),
        updated_at   TIMESTAMP DEFAULT NOW(),
        UNIQUE (market_type, market_value, date)
      )
    `);
    console.log("🛡️ Tablas verificadas al arrancar");
  } catch (err) {
    // 42501 = permission denied: el servicio web corre con usuario de SOLO LECTURA.
    // Es lo esperado y correcto — la creación/protección de tablas la hacen los
    // cron jobs (que sí escriben). No es un error, se omite en silencio.
    if (err.code === "42501") {
      console.log("ℹ️ Modo solo-lectura: se omite initTables (las tablas las protegen los crons).");
    } else {
      console.error("❌ Error en initTables:", err);
    }
  } finally {
    client.release();
  }
}
initTables();

// ==============================
// 🔑 LLAVES DE EVALUACIÓN — registro de uso
//
// Tiene que ir ANTES de las rutas: Express solo ejecuta el middleware que se
// declaró antes de la ruta que atiende la petición. Declarado después nunca
// corre y el contador se queda en cero.
//
// No bloquea nada: los endpoints públicos siguen abiertos. Su único trabajo es
// medir quién está integrando de verdad, que es la señal de intención de compra.
//
// La vigencia arranca en la PRIMERA consulta, no cuando se emite la llave: si
// el prospecto pide la llave un viernes y su equipo la toca hasta el miércoles,
// no queremos que se le hayan ido 5 de los 7 días esperando.
// ==============================
app.use("/api", (req, res, next) => {
  const k = req.headers["x-api-key"];
  if (k && String(k).startsWith("gg_test_")) {
    pool.query(
      `UPDATE api_keys_prueba
          SET llamadas    = llamadas + 1,
              ultima_uso  = NOW(),
              activada_en = COALESCE(activada_en, NOW()),
              expira_en   = CASE WHEN activada_en IS NULL
                                 THEN NOW() + INTERVAL '7 days'
                                 ELSE expira_en END
        WHERE api_key = $1 AND activa = TRUE AND expira_en > NOW()`,
      [String(k).slice(0, 80)]
    ).catch(() => {});
  }
  next();
});

// ==============================
// 🔹 PRECIOS
// ==============================
app.get("/api/precios", async (req, res) => {
  try {
    const { market, value, days, product } = req.query;

    // 🛡️ Whitelist: evita SQL injection vía nombre de columna
    const prod = ['regular', 'premium', 'diesel'].includes(product) ? product : 'regular';
    const minCol = `min_${prod}`;
    const maxCol = `max_${prod}`;
    const stdCol = `std_${prod}`;

    let query = `
      SELECT 
        pa.regular,
        pa.premium,
        pa.diesel,
        pa.updated_at,
        pa.${minCol} AS min,
        pa.${maxCol} AS max,
        pa.${stdCol} AS std,
        pa.stations_count,
        ${
          market === "nacional"
            ? `(SELECT COUNT(*) FROM gas_stations) AS total_estaciones`
            : market === "municipio"
              ? `(SELECT COUNT(*) FROM gas_stations WHERE LOWER(estado)=LOWER(split_part($2,'|',1)) AND LOWER(municipio)=LOWER(split_part($2,'|',2))) AS total_estaciones`
              : market === "area"
                ? `(SELECT COUNT(*) FROM gas_stations WHERE UPPER(gasgas_area)=UPPER($2)) AS total_estaciones`
                : `(SELECT COUNT(*) FROM gas_stations WHERE LOWER(estado)=LOWER($2)) AS total_estaciones`
        }
      FROM precios_agregados pa
      WHERE pa.market_type = $1
    `;

    let params = [market];

    if (market !== "nacional") {
      query += ` AND LOWER(pa.market_value) = LOWER($2) AND pa.days = $3`;
      params.push(value, days);
    } else {
      query += ` AND pa.market_value = 'all' AND pa.days = $2`;
      params.push(days);
    }

    const result = await pool.query(query, params);
    const row = result.rows[0] || {};

    // 🚦 Semáforo (valor agregado): clasifica el promedio de este mercado
    //    vs su referencia — estado vs nacional, municipio vs su estado.
    //    Umbral ±3% (GasGas Design System). Campo NUEVO y aditivo: no rompe
    //    a ningún consumidor existente.
    if (row[prod] != null && market !== "nacional") {
      try {
        let refType = null, refValue = null;
        if (market === "estado") { refType = "nacional"; refValue = "all"; }
        else if (market === "area") { refType = "nacional"; refValue = "all"; }
        else if (market === "municipio") { refType = "estado"; refValue = String(value || "").split("|")[0]; }

        if (refType && refValue) {
          const refQ = await pool.query(
            `SELECT ${prod} AS ref FROM precios_agregados
             WHERE market_type = $1 AND LOWER(market_value) = LOWER($2) AND days = $3 LIMIT 1`,
            [refType, refValue, days]
          );
          const ref = refQ.rows[0] ? parseFloat(refQ.rows[0].ref) : null;
          const val = parseFloat(row[prod]);
          if (ref && val) {
            const deltaPct = ((val - ref) / ref) * 100;
            const estado = deltaPct <= -3 ? "barato" : deltaPct >= 3 ? "caro" : "medio";
            row.semaforo = {
              producto: prod,
              referencia: refType,
              promedio_referencia: Number(ref.toFixed(2)),
              delta_pct: Number(deltaPct.toFixed(1)),
              estado,
              icono: estado === "barato" ? "↓" : estado === "caro" ? "↑" : "↔"
            };
          }
        }
      } catch (e) {
        console.error("semaforo:", e.message); // nunca tumba la respuesta principal
      }
    }

    res.json(row);

  } catch (err) {
    console.error("ERROR /precios:", err);
    res.status(500).json({ error: "Error obteniendo precios" });
  }
});

// ==============================
// 🔹 HISTÓRICO
// ==============================
app.get("/api/historico", async (req, res) => {
  try {
    const { market, value, days } = req.query;

    let query = `
      SELECT date, regular, premium, diesel
      FROM precios_historicos_agregados
      WHERE market_type = $1
    `;

    let params = [market];

    if (market !== "nacional") {
      query += ` AND LOWER(market_value) = LOWER($2)`;
      params.push(value);
    } else {
      query += ` AND market_value = 'all'`;
    }

    // 🛡️ Whitelist: solo periodos válidos, evita SQL injection
    const daysInt = [7, 30].includes(parseInt(days, 10)) ? parseInt(days, 10) : 30;
    query += ` AND date >= NOW() - INTERVAL '${daysInt} days' ORDER BY date`;

    const result = await pool.query(query, params);
    res.json(result.rows);

  } catch (err) {
    console.error("ERROR /historico:", err);
    res.status(500).json({ error: "Error obteniendo histórico" });
  }
});

// ==============================
// 🔹 ESTADOS
// ==============================
app.get("/api/estados", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT estado
      FROM gas_stations
      ORDER BY estado
    `);
    res.json(result.rows);

  } catch (err) {
    console.error("ERROR /estados:", err);
    res.status(500).json({ error: "Error obteniendo estados" });
  }
});

// ==============================
// 🔹 ÁREAS GASGAS
// Catálogo de las 6 macro-regiones comerciales, con las entidades que
// integra cada una y el número de estaciones que la respaldan.
// ==============================
app.get("/api/areas", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        a.clave,
        a.nombre,
        a.alias,
        a.descripcion,
        COUNT(g.id)::int AS estaciones,
        COALESCE(
          ARRAY_AGG(DISTINCT g.estado ORDER BY g.estado) FILTER (WHERE g.estado IS NOT NULL),
          '{}'
        ) AS entidades
      FROM gasgas_areas a
      LEFT JOIN gas_stations g ON g.gasgas_area = a.clave
      GROUP BY a.orden, a.clave, a.nombre, a.alias, a.descripcion
      ORDER BY a.orden
    `);
    res.json(result.rows);

  } catch (err) {
    console.error("ERROR /areas:", err);
    res.status(500).json({ error: "Error obteniendo áreas" });
  }
});

// ==============================
// 🔹 MUNICIPIOS DE UN ESTADO
// ==============================
app.get("/api/municipios", async (req, res) => {
  try {
    const { estado } = req.query;
    if (!estado) {
      return res.status(400).json({ error: "Falta el parámetro estado" });
    }

    // Parametrizado ($1) — sin riesgo de SQL injection
    const result = await pool.query(`
      SELECT municipio, COUNT(*)::int AS estaciones
      FROM gas_stations
      WHERE LOWER(estado) = LOWER($1)
        AND municipio IS NOT NULL AND municipio <> ''
      GROUP BY municipio
      ORDER BY municipio
    `, [estado]);

    res.json(result.rows);

  } catch (err) {
    console.error("ERROR /municipios:", err);
    res.status(500).json({ error: "Error obteniendo municipios" });
  }
});

// ==============================
// 🔹 PRECIO POR MARCA COMERCIAL (valor agregado: la bandera la resolvemos nosotros)
// ==============================
app.get("/api/marcas", async (req, res) => {
  try {
    const { estado } = req.query;
    // 🛡️ Whitelist de columna (evita SQL injection)
    const prod = ['regular', 'premium', 'diesel'].includes(req.query.product) ? req.query.product : 'regular';

    // 🛡️ Filtros de calidad — mismos rangos que el dashboard (updateAgregados.js)
    // Excluye precios basura (0.01, 1.00, 2.99, etc.) del promedio por marca.
    const RANGE = { regular: { min: 21, max: 27 }, premium: { min: 23, max: 32 }, diesel: { min: 25, max: 33 } };
    const r = RANGE[prod];

    let filtro = "";
    const params = [];
    if (estado) { filtro = "AND LOWER(gs.estado) = LOWER($1)"; params.push(estado); }

    const query = `
      WITH hoy AS (SELECT MAX(date) AS d FROM prices)
      SELECT
        CASE WHEN gs.titulo_1 IN ('Pemex','Pemex1') THEN 'Pemex' ELSE gs.titulo_1 END AS marca,
        COUNT(*)::int AS estaciones,
        ROUND(AVG(p.${prod})::numeric, 2) AS precio
      FROM prices p
      JOIN prices_gas_station_links l ON l.price_id = p.id
      JOIN gas_stations gs ON gs.id = l.gas_station_id
      WHERE p.date = (SELECT d FROM hoy)
        AND p.${prod} BETWEEN ${r.min} AND ${r.max}
        AND gs.titulo_1 IS NOT NULL AND gs.titulo_1 NOT IN ('', 'Otras Marcas')
        ${filtro}
      GROUP BY 1
      HAVING COUNT(*) >= 30
      ORDER BY precio ASC
    `;

    const result = await pool.query(query, params);
    res.json({ producto: prod, estado: estado || "nacional", marcas: result.rows });

  } catch (err) {
    console.error("ERROR /marcas:", err);
    res.status(500).json({ error: "Error obteniendo marcas" });
  }
});

// ==============================
// 🔹 CAPTURA DE LEADS (llave de prueba / contacto B2B)
//    Loguea SIEMPRE antes de escribir → el lead no se pierde ni aunque la DB falle.
//    Tabla 'leads' append-only; gasgas_ro solo tiene INSERT.
// ==============================
app.post("/api/lead", async (req, res) => {
  try {
    const b = req.body || {};
    const email = String(b.email || "").trim().slice(0, 200);
    const contexto = String(b.contexto || "").slice(0, 500);
    const fuente = String(b.fuente || "web").slice(0, 80);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: "Correo inválido" });
    }

    const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim().slice(0, 60);
    const ua = String(req.headers["user-agent"] || "").slice(0, 300);

    // 1) Captura garantizada en el log de Render (aunque la DB no escriba)
    console.log(`[LEAD] ${email} | fuente=${fuente} | ${contexto} | ip=${ip}`);

    // 2) Persistencia en tabla append-only
    try {
      await pool.query(
        `INSERT INTO leads (email, contexto, fuente, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`,
        [email, contexto, fuente, ip, ua]
      );
    } catch (e) {
      console.error("[LEAD] no se pudo guardar en DB (queda en el log):", e.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("ERROR /lead:", err);
    res.status(500).json({ ok: false, error: "Error registrando el lead" });
  }
});

// ==============================
// 🔹 RANKING ESTADOS
// ==============================
app.get("/api/ranking-estados", async (req, res) => {
  try {
    const { product } = req.query;
    const col = ['regular','premium','diesel'].includes(product) ? product : 'regular';

    // Nota: stations_count y delta7_* son campos ADITIVOS (compatibles con clientes existentes)
    const result = await pool.query(`
      WITH h AS (
        SELECT market_value, regular, premium, diesel,
               ROW_NUMBER() OVER (PARTITION BY market_value ORDER BY date DESC) AS rn
        FROM precios_historicos_agregados
        WHERE market_type = 'estado' AND date >= NOW() - INTERVAL '12 days'
      )
      SELECT a.market_value AS estado, a.regular, a.premium, a.diesel,
             a.stations_count,
             ROUND((h1.regular - h8.regular)::numeric, 4) AS delta7_regular,
             ROUND((h1.premium - h8.premium)::numeric, 4) AS delta7_premium,
             ROUND((h1.diesel  - h8.diesel)::numeric, 4) AS delta7_diesel
      FROM precios_agregados a
      LEFT JOIN h h1 ON h1.market_value = a.market_value AND h1.rn = 1
      LEFT JOIN h h8 ON h8.market_value = a.market_value AND h8.rn = 8
      WHERE a.market_type = 'estado' AND a.days = 1 AND a.${col} IS NOT NULL
      ORDER BY a.${col} DESC
    `);

    res.json(result.rows);

  } catch (err) {
    console.error("ERROR /ranking-estados:", err);
    res.status(500).json({ error: "Error obteniendo ranking" });
  }
});

// ==============================
// 🔹 VECINOS
// ==============================
const VECINOS = {
  'Aguascalientes':       ['Jalisco', 'Zacatecas', 'San Luis Potosí'],
  'Baja California':      ['Sonora', 'Baja California Sur'],
  'Baja California Sur':  ['Baja California', 'Sonora', 'Sinaloa'],
  'Campeche':             ['Tabasco', 'Chiapas', 'Yucatán'],
  'Chiapas':              ['Tabasco', 'Oaxaca', 'Veracruz', 'Campeche'],
  'Chihuahua':            ['Sonora', 'Sinaloa', 'Durango', 'Coahuila'],
  'Ciudad de México':     ['Estado de México', 'Morelos'],
  'Coahuila':             ['Chihuahua', 'Durango', 'Zacatecas', 'Nuevo León', 'Tamaulipas'],
  'Colima':               ['Jalisco', 'Michoacán'],
  'Durango':              ['Chihuahua', 'Sinaloa', 'Nayarit', 'Zacatecas', 'Coahuila'],
  'Estado de México':     ['Ciudad de México', 'Morelos', 'Guerrero', 'Michoacán', 'Querétaro', 'Hidalgo', 'Tlaxcala', 'Puebla'],
  'Guanajuato':           ['Jalisco', 'Michoacán', 'Querétaro', 'San Luis Potosí', 'Zacatecas'],
  'Guerrero':             ['Michoacán', 'Estado de México', 'Morelos', 'Puebla', 'Oaxaca'],
  'Hidalgo':              ['San Luis Potosí', 'Veracruz', 'Puebla', 'Tlaxcala', 'Estado de México', 'Querétaro'],
  'Jalisco':              ['Nayarit', 'Zacatecas', 'Aguascalientes', 'Guanajuato', 'Michoacán', 'Colima'],
  'Michoacán':            ['Jalisco', 'Guanajuato', 'Querétaro', 'Estado de México', 'Guerrero', 'Colima'],
  'Morelos':              ['Estado de México', 'Ciudad de México', 'Puebla', 'Guerrero'],
  'Nayarit':              ['Sinaloa', 'Durango', 'Zacatecas', 'Jalisco'],
  'Nuevo León':           ['Coahuila', 'Zacatecas', 'San Luis Potosí', 'Tamaulipas'],
  'Oaxaca':               ['Guerrero', 'Puebla', 'Veracruz', 'Chiapas'],
  'Puebla':               ['Hidalgo', 'Veracruz', 'Oaxaca', 'Guerrero', 'Morelos', 'Estado de México', 'Tlaxcala'],
  'Querétaro':            ['Guanajuato', 'San Luis Potosí', 'Hidalgo', 'Estado de México', 'Michoacán'],
  'Quintana Roo':         ['Yucatán', 'Campeche'],
  'San Luis Potosí':      ['Zacatecas', 'Jalisco', 'Guanajuato', 'Querétaro', 'Hidalgo', 'Veracruz', 'Tamaulipas', 'Nuevo León'],
  'Sinaloa':              ['Sonora', 'Chihuahua', 'Durango', 'Nayarit'],
  'Sonora':               ['Baja California', 'Chihuahua', 'Sinaloa'],
  'Tabasco':              ['Veracruz', 'Chiapas', 'Campeche'],
  'Tamaulipas':           ['Nuevo León', 'Coahuila', 'San Luis Potosí', 'Veracruz'],
  'Tlaxcala':             ['Hidalgo', 'Puebla', 'Estado de México'],
  'Veracruz':             ['Tamaulipas', 'San Luis Potosí', 'Hidalgo', 'Puebla', 'Oaxaca', 'Chiapas', 'Tabasco'],
  'Yucatán':              ['Campeche', 'Quintana Roo'],
  'Zacatecas':            ['Durango', 'Coahuila', 'Nuevo León', 'San Luis Potosí', 'Jalisco', 'Aguascalientes', 'Nayarit', 'Guanajuato'],
};

app.get("/api/vecinos", async (req, res) => {
  try {
    const { estado, product } = req.query;
    const col = ['regular','premium','diesel'].includes(product) ? product : 'regular';

    const vecinosList = VECINOS[estado] || [];
    if (vecinosList.length === 0) return res.json([]);

    const placeholders = vecinosList.map((_, i) => `$${i + 1}`).join(', ');

    const result = await pool.query(`
      SELECT market_value AS estado, regular, premium, diesel
      FROM precios_agregados
      WHERE market_type = 'estado'
        AND days = 1
        AND market_value IN (${placeholders})
        AND ${col} IS NOT NULL
      ORDER BY ${col} DESC
    `, vecinosList);

    res.json(result.rows);

  } catch (err) {
    console.error("ERROR /vecinos:", err);
    res.status(500).json({ error: "Error obteniendo vecinos" });
  }
});

// ==============================
// 🔹 PÁGINA /datos (escaparate B2B de la API)
// ==============================
app.get("/datos", (req, res) => {
  res.sendFile(__dirname + "/public/datos.html");
});

app.get("/docs", (req, res) => {
  res.sendFile(__dirname + "/public/docs.html");
});

// ==============================
// 🔹 HEALTH CHECK
// ==============================
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "GasGas API" });
});

// 🔹 DEMO nivel Código Postal (para el playground de /datos)
//    Protecciones anti-abuso:
//    1. WHITELIST: solo 8 CPs de demostración — imposible enumerar el catálogo completo (producto de pago)
//    2. RATE LIMIT en memoria: 30 peticiones/hora por IP en este endpoint
//    3. Query parametrizada ($1) — sin inyección SQL
//    4. Cache-Control de 5 min (middleware /api) absorbe ráfagas en el borde
const DEMO_CPS = {
  "11800": "Ciudad de México, CDMX",
  "64000": "Monterrey, Nuevo León",
  "45640": "Tlajomulco (ZM Guadalajara), Jalisco",
  "27000": "Torreón, Coahuila",
  "22000": "Tijuana, Baja California",
  "88500": "Reynosa, Tamaulipas",
  "77712": "Playa del Carmen, Quintana Roo",
  "81200": "Los Mochis, Sinaloa"
};
const demoCpHits = new Map(); // ip -> { n, reset }
function demoCpRateLimit(req, res) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const ahora = Date.now();
  let reg = demoCpHits.get(ip);
  if (!reg || ahora > reg.reset) { reg = { n: 0, reset: ahora + 3600_000 }; demoCpHits.set(ip, reg); }
  reg.n++;
  if (demoCpHits.size > 5000) { // limpieza para no crecer sin límite
    for (const [k, v] of demoCpHits) if (ahora > v.reset) demoCpHits.delete(k);
  }
  if (reg.n > 30) {
    res.status(429).json({ error: "Límite de uso de la demo excedido. Para acceso completo: hola@gasgas.com.mx" });
    return false;
  }
  return true;
}

app.get("/api/demo/cp", async (req, res) => {
  try {
    if (!demoCpRateLimit(req, res)) return;
    const cp = String(req.query.cp || "");
    if (!DEMO_CPS[cp]) {
      return res.status(403).json({
        error: "Ese CP no está en la demostración.",
        cps_demo: Object.keys(DEMO_CPS),
        nota: "El catálogo completo (5,000+ CPs) opera con API key por contrato.",
        contacto: "hola@gasgas.com.mx"
      });
    }
    const col = ["regular", "premium", "diesel"].includes(req.query.product) ? req.query.product : "regular";
    const RANGO = { regular: [21, 27], premium: [23, 32], diesel: [25, 33] };
    const [lo, hi] = RANGO[col];
    const result = await pool.query(`
      SELECT
        ROUND(AVG(CASE WHEN p.regular BETWEEN 21 AND 27 THEN p.regular END)::numeric, 4)::text AS regular,
        ROUND(AVG(CASE WHEN p.premium BETWEEN 23 AND 32 THEN p.premium END)::numeric, 4)::text AS premium,
        ROUND(AVG(CASE WHEN p.diesel  BETWEEN 25 AND 33 THEN p.diesel  END)::numeric, 4)::text AS diesel,
        ROUND(MIN(CASE WHEN p.${col} BETWEEN ${lo} AND ${hi} THEN p.${col} END)::numeric, 4)::text AS min,
        ROUND(MAX(CASE WHEN p.${col} BETWEEN ${lo} AND ${hi} THEN p.${col} END)::numeric, 4)::text AS max,
        ROUND(STDDEV(CASE WHEN p.${col} BETWEEN ${lo} AND ${hi} THEN p.${col} END)::numeric, 4)::text AS std,
        COUNT(DISTINCT l.gas_station_id)::int AS stations_count,
        MAX(p.date)::text AS updated_at
      FROM prices p
      JOIN prices_gas_station_links l ON l.price_id = p.id
      JOIN gas_stations g ON g.id = l.gas_station_id
      WHERE g.cp = $1
        AND p.date::date = (SELECT MAX(date::date) FROM prices)
    `, [cp]);
    const fila = result.rows[0] || {};
    res.json(Object.assign({ cp, lugar: DEMO_CPS[cp], demo: true }, fila,
      { nota: "CP de demostración. Catálogo completo de 5,000+ CPs por contrato." }));
  } catch (err) {
    console.error("ERROR /demo/cp:", err);
    res.status(500).json({ error: "Error obteniendo demo de CP" });
  }
});

// ==============================
// 🎯 EMBUDO COMERCIAL — asistente de /datos
//    Captura el prospecto, calcula su estimado, emite llave de evaluación
//    (7 días · 500 llamadas · niveles estado y municipio) y arma el mensaje
//    de WhatsApp con todo el contexto para que el ejecutivo solo cierre.
// ==============================

// Correos personales: la llave de evaluación es para empresas
const DOMINIOS_PERSONALES = new Set([
  "gmail.com","googlemail.com","hotmail.com","hotmail.es","hotmail.com.mx","outlook.com","outlook.es",
  "live.com","live.com.mx","msn.com","yahoo.com","yahoo.com.mx","yahoo.es","icloud.com","me.com","mac.com",
  "aol.com","protonmail.com","proton.me","gmx.com","gmx.es","mail.com","yandex.com","zoho.com","tutanota.com",
  "hey.com","fastmail.com","inbox.com","email.com","correo.com","prodigy.net.mx"
]);

const PRECIO_BASE = { estado: 17250, municipio: 28750, cp: 40250, estacion: 60000 };
const AREAS_VALIDAS = ["I", "II", "III", "IV", "V", "VI"];
const AREA_NOMBRE = { I: "Pacífico", II: "Norte", III: "Bajío", IV: "Centro", V: "Valle de México", VI: "Sureste" };

/**
 * Estimado mensual. Una Área GasGas cuesta el precio base del nivel; cada área
 * adicional suma 10%, así que las 6 (cobertura nacional) quedan en ×1.5 — el
 * mismo factor que teníamos antes. La página muestra este mismo cálculo.
 */
function estimar(nivel, nAreas, historico) {
  const base = PRECIO_BASE[nivel] || PRECIO_BASE.estado;
  const n = Math.min(6, Math.max(1, Number(nAreas) || 1));
  const factor = 1 + 0.1 * (n - 1);
  let min = Math.round((base * factor) / 250) * 250;
  let max = Math.round((min * 1.2) / 250) * 250;
  if (historico) { min = Math.round((min * 1.15) / 250) * 250; max = Math.round((max * 1.15) / 250) * 250; }
  return { min, max };
}

// ==============================
// 🛡️ ANTI-ABUSO DEL FORMULARIO
//
// El formulario envía correo a una dirección que escribe un desconocido. Sin
// candados nos pueden usar de trampolín para molestar a terceros, y los rebotes
// de dominios inventados queman la reputación de envío del dominio — que es lo
// caro de recuperar. Ninguna de estas medidas le agrega pasos al prospecto real.
// ==============================

/**
 * ¿El dominio tiene servidores de correo? Descarta dominios inventados y erratas.
 *
 * Falla ABIERTO a propósito: solo rechaza cuando el DNS responde con certeza que
 * el dominio no existe o no tiene correo. Ante un timeout o un SERVFAIL deja pasar,
 * porque perder un prospecto real por un hipo de red es más caro que dejar entrar
 * un correo falso — de esos ya se encargan los otros topes.
 */
const DNS_DEFINITIVO = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

async function dominioRecibeCorreo(dominio) {
  let mxDefinitivo = false;
  try {
    const mx = await dns.resolveMx(dominio);
    if (mx && mx.length) return true;
    mxDefinitivo = true;                       // respondió, pero sin registros MX
  } catch (e) {
    if (!DNS_DEFINITIVO.has(e.code)) return true;   // problema de red: no castigamos
    mxDefinitivo = true;
  }
  // Sin MX, un dominio todavía puede recibir correo por su registro A
  try {
    const a = await dns.resolve4(dominio);
    return !!(a && a.length);
  } catch (e) {
    if (!DNS_DEFINITIVO.has(e.code)) return true;
    return !mxDefinitivo ? true : false;
  }
}

// ──────────────────────────────────────────────────────────────
// Topes de emisión. Esto es una evaluación enterprise, no un servicio
// de autoservicio: una empresa seria necesita UNA llave, no varias.
// Todo lo que rebase estos números va a conversación con un humano,
// que además es donde se cierran las ventas B2B.
// ──────────────────────────────────────────────────────────────
const TOPE_DOMINIO_DIAS = 30;   // una llave por empresa al mes
const TOPE_IP_DIA       = 2;    // llaves emitidas desde una misma conexión al día
const TOPE_GLOBAL_DIA   = 30;   // 30 empresas distintas en un día ya es un día enorme

/** Devuelve null si se puede emitir, o el motivo del rechazo. */
async function topesDeEmision(email, dominio, ip) {
  const q = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM prospectos WHERE email = $1)                                             AS del_correo,
      (SELECT COUNT(*) FROM prospectos WHERE dominio = $2
         AND created_at > NOW() - ($3 || ' days')::INTERVAL)                                         AS del_dominio,
      (SELECT COUNT(*) FROM prospectos WHERE ip = $4 AND created_at > NOW() - INTERVAL '1 day')      AS de_la_ip,
      (SELECT COUNT(*) FROM prospectos WHERE created_at > NOW() - INTERVAL '1 day')                  AS del_dia
  `, [email, dominio, String(TOPE_DOMINIO_DIAS), ip]);
  const r = q.rows[0] || {};

  // Una llave por persona. No hay reemisión automática: si necesita otra o más
  // tiempo, queremos enterarnos nosotros — es señal de que está evaluando en serio.
  if (Number(r.del_correo) > 0) {
    return { codigo: 409, error: "llave_vigente",
             mensaje: "Ya emitimos una llave para este correo. Búsquela en su bandeja, y si necesita otra o más tiempo de prueba escríbanos a hola@gasgas.com.mx — se la reponemos el mismo día." };
  }
  if (Number(r.del_dominio) > 0) {
    return { codigo: 409, error: "tope_dominio",
             mensaje: "Su empresa ya tiene una llave de evaluación activa. Escríbanos a hola@gasgas.com.mx y le damos acceso a usted también, o extendemos la prueba del equipo." };
  }
  if (Number(r.de_la_ip) >= TOPE_IP_DIA) {
    return { codigo: 429, error: "tope_ip",
             mensaje: "Alcanzó el límite de solicitudes desde esta conexión. Escríbanos a hola@gasgas.com.mx y lo resolvemos de inmediato." };
  }
  if (Number(r.del_dia) >= TOPE_GLOBAL_DIA) {
    return { codigo: 429, error: "tope_diario",
             mensaje: "Alcanzamos el cupo de llaves de hoy. Escríbanos a hola@gasgas.com.mx y se la emitimos a mano." };
  }
  return null;
}

/** Verifica el token de Cloudflare Turnstile. Sin llave configurada, no bloquea. */
async function turnstileValido(token, ip) {
  const secreto = process.env.TURNSTILE_SECRET_KEY;
  if (!secreto) return true;               // aún no configurado: no rompe el flujo
  if (!token) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: secreto, response: String(token).slice(0, 3000), remoteip: ip || "" })
    });
    const j = await r.json();
    return !!j.success;
  } catch (e) {
    console.error("turnstile:", e.message);
    return true;                            // si Cloudflare no responde, no castigamos al prospecto
  }
}

/**
 * Deja rastro de cada intento rechazado. Sin esto, un ataque de mil correos se
 * ve exactamente igual que un día sin visitas: nadie se entera.
 * Nunca lanza — registrar no puede tumbar la respuesta al usuario.
 */
function anotarBloqueo(motivo, req, datos = {}) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || null;
  pool.query(
    `INSERT INTO solicitudes_bloqueadas (motivo, email, dominio, empresa, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [motivo,
     (datos.email || "").slice(0, 160) || null,
     (datos.dominio || "").slice(0, 120) || null,
     (datos.empresa || "").slice(0, 140) || null,
     ip,
     String(req.headers["user-agent"] || "").slice(0, 300)]
  ).catch(() => {});
}

const solicitudesPorIp = new Map();
function limiteSolicitudes(req, res) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const ahora = Date.now();
  let reg = solicitudesPorIp.get(ip);
  if (!reg || ahora > reg.reset) { reg = { n: 0, reset: ahora + 3600_000 }; solicitudesPorIp.set(ip, reg); }
  reg.n++;
  if (reg.n > 5) {
    // Solo se anota el primer rechazo de cada tanda, para que un bot insistente
    // no nos llene la tabla con miles de filas idénticas.
    if (!reg.anotado) { reg.anotado = true; anotarBloqueo("rate_limit_ip", req); }
    res.status(429).json({ error: "Demasiadas solicitudes. Escríbenos a hola@gasgas.com.mx" });
    return false;
  }
  return true;
}


// La guía en PDF es la misma para todos: se lee una vez y se reutiliza en cada envío.
const GUIA_PDF = "public/GasGas-API-Guia-de-uso.pdf";
let guiaB64 = null;
function guiaEnBase64() {
  if (guiaB64 === null) {
    try { guiaB64 = require("fs").readFileSync(GUIA_PDF).toString("base64"); }
    catch (e) { console.error("No se pudo leer la guía PDF:", e.message); guiaB64 = ""; }
  }
  return guiaB64;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Envía la llave de evaluación por correo. Devuelve true si salió. */
async function enviarLlavePorCorreo({ nombre, empresa, email, llave, nivel, areasTxt, historico, est }) {
  const KEY = process.env.SENDGRID_API_KEY;
  const DE = process.env.CORREO_REMITENTE || "hola@gasgas.com.mx";
  if (!KEY) return { ok: false, motivo: "sin_servicio_correo" };

  const NIV = { estado: "nivel estado", municipio: "nivel municipio", cp: "nivel código postal", estacion: "nivel estación" };
  const pila = nombre.split(" ")[0];
  const curl = `curl -H "x-api-key: ${llave}" "https://api.gasgas.com.mx/api/precios?market=estado&value=Jalisco&days=1&product=regular"`;

  // WhatsApp de soporte: sale de la misma variable que usa el asistente
  const waNum = String(process.env.WHATSAPP_NUMERO || "").replace(/[^0-9]/g, "");
  const waVisible = waNum.length === 12
    ? `+${waNum.slice(0, 2)} ${waNum.slice(2, 4)} ${waNum.slice(4, 8)} ${waNum.slice(8)}`
    : waNum ? "+" + waNum : "";
  const waHref = waNum ? "https://wa.me/" + waNum : "mailto:hola@gasgas.com.mx";

  // Correo HTML: tablas y estilos en línea, que es lo único que respetan
  // Outlook y Gmail. Sin imágenes externas para no caer en spam.
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F8;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:14px;overflow:hidden;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">

  <tr><td style="background:#0E2A47;padding:26px 30px;">
    <span style="display:inline-block;background:#FFFFFF;color:#0E2A47;font-weight:800;font-size:13px;padding:4px 11px;border-radius:99px;">GG</span>
    <span style="color:rgba(255,255,255,.5);font-size:14px;margin-left:8px;">GasGas / datos</span>
    <div style="color:#FFFFFF;font-size:23px;font-weight:800;margin-top:16px;line-height:1.25;">Su llave está lista, ${esc(pila)}</div>
    <div style="color:rgba(255,255,255,.65);font-size:15px;margin-top:6px;">500 consultas · sin costo · 7 días a partir de su primera llamada</div>
  </td></tr>

  <tr><td style="padding:26px 30px 6px;">
    <div style="font-family:'SFMono-Regular',Consolas,monospace;font-size:10px;letter-spacing:1px;color:#007A39;">SU LLAVE</div>
    <div style="background:#E8F5EE;border:1px solid #B9E4CC;border-radius:9px;padding:13px 15px;margin-top:7px;
                font-family:'SFMono-Regular',Consolas,monospace;font-size:14px;color:#0E2A47;word-break:break-all;">${esc(llave)}</div>
  </td></tr>

  <tr><td style="padding:18px 30px 0;">
    <div style="font-family:'SFMono-Regular',Consolas,monospace;font-size:10px;letter-spacing:1px;color:#007A39;">SU PRIMERA LLAMADA</div>
    <div style="background:#0E2A47;border-radius:9px;padding:13px 15px;margin-top:7px;
                font-family:'SFMono-Regular',Consolas,monospace;font-size:11.5px;line-height:1.6;color:#E8F5EE;word-break:break-all;">${esc(curl)}</div>
    <div style="font-size:13px;color:#4C6379;margin-top:8px;">Cópiela tal cual. Responde en menos de un segundo — y ahí arrancan sus 7 días, no antes.</div>
  </td></tr>

  <tr><td style="padding:22px 30px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#F7F9FA;border:1px solid #E7ECF0;border-radius:9px;">
      <tr><td style="padding:14px 16px;">
        <div style="font-size:15px;font-weight:700;color:#0E2A47;">📎 Guía de uso de la API</div>
        <div style="font-size:13px;color:#4C6379;margin-top:3px;">Va adjunta a este correo: endpoints, parámetros, Áreas GasGas y manejo de errores. Tres páginas, sin relleno.</div>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:22px 30px 0;">
    <a href="https://gasgas.com.mx/docs" style="display:block;background:#00A94F;color:#FFFFFF;text-decoration:none;
       border-radius:9px;padding:14px;text-align:center;font-size:16px;font-weight:700;">Ver la documentación completa</a>
    <div style="font-size:12.5px;color:#8B99A6;margin-top:9px;text-align:center;">Incluye la especificación OpenAPI 3.1 y la colección de Postman</div>
  </td></tr>

  <tr><td style="padding:22px 30px 0;">
    <div style="border-top:1px solid #E7ECF0;padding-top:16px;">
      <div style="font-family:'SFMono-Regular',Consolas,monospace;font-size:10px;letter-spacing:1px;color:#8B99A6;">LO QUE NOS PIDIÓ</div>
      <div style="font-size:14px;color:#0E2A47;margin-top:5px;">${esc(NIV[nivel] || nivel)} · ${esc(areasTxt)}${historico ? " · con histórico" : ""}</div>
      <div style="font-size:14px;color:#4C6379;margin-top:3px;">Estimado: <b style="color:#0E2A47;">$${est.min.toLocaleString("en-US")} – $${est.max.toLocaleString("en-US")} MXN</b>/mes + IVA</div>
    </div>
  </td></tr>

  <tr><td style="padding:20px 30px 4px;">
    <div style="font-size:14px;color:#4C6379;line-height:1.6;">¿Necesita nivel código postal, estación, o el histórico desde mayo 2024?
    Responda este correo y lo vemos — le contesta alguien que conoce el dato.</div>
  </td></tr>

  <tr><td style="padding:16px 30px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#F7F9FA;border:1px solid #E7ECF0;border-radius:9px;">
      <tr><td style="padding:14px 16px;">
        <div style="font-family:'SFMono-Regular',Consolas,monospace;font-size:10px;letter-spacing:1px;color:#8B99A6;">¿DUDAS DURANTE SU PRUEBA?</div>
        <div style="font-size:15px;color:#0E2A47;margin-top:6px;">
          WhatsApp <a href="${waHref}" style="color:#007A39;text-decoration:none;font-weight:700;">${esc(waVisible)}</a>
          &nbsp;·&nbsp; <a href="mailto:hola@gasgas.com.mx" style="color:#007A39;text-decoration:none;font-weight:700;">hola@gasgas.com.mx</a>
        </div>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="background:#081B30;padding:16px 30px;">
    <span style="color:rgba(255,255,255,.5);font-size:12px;">GasGas · datos depurados por el algoritmo de calidad GasGas</span>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  const texto =
`Hola ${nombre.split(" ")[0]},

Aquí está la llave de evaluación de la API de GasGas para ${empresa}.

LLAVE
${llave}

Vigencia: 500 consultas y 7 días contados desde su primera llamada — el reloj
no corre mientras no la use. Niveles estado, municipio y área.

PRIMERA LLAMADA (copiar y pegar)
curl -H "x-api-key: ${llave}" "https://api.gasgas.com.mx/api/precios?market=estado&value=Jalisco&days=1&product=regular"

DOCUMENTACIÓN
https://gasgas.com.mx/docs — incluye la especificación OpenAPI y la colección de Postman.

LO QUE NOS PIDIÓ
${NIV[nivel] || nivel}, ${areasTxt}${historico ? ", con histórico" : ""}.
Estimado: $${est.min.toLocaleString("en-US")} – $${est.max.toLocaleString("en-US")} MXN/mes + IVA.

¿Necesita nivel código postal o estación, o el histórico completo? Responda este correo y lo vemos.

¿DUDAS DURANTE SU PRUEBA?
WhatsApp ${waVisible || "—"} · hola@gasgas.com.mx

Equipo GasGas`;

  try {
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }], bcc: [{ email: DE }] }],
        from: { email: DE, name: "GasGas Datos" },
        reply_to: { email: DE },
        subject: `Su llave de evaluación · API GasGas (${empresa})`,
        // El texto plano va primero: es el orden que exige SendGrid y el que
        // ven los clientes de correo que no muestran HTML.
        content: [
          { type: "text/plain", value: texto },
          { type: "text/html",  value: html }
        ],
        attachments: guiaEnBase64() ? [{
          content: guiaEnBase64(),
          filename: "GasGas-API-Guia-de-uso.pdf",
          type: "application/pdf",
          disposition: "attachment"
        }] : [],
        // Sin esto SendGrid reescribe cada URL con un enlace de rastreo y
        // rompe el curl que el cliente tiene que copiar y pegar.
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking:  { enable: false },
          subscription_tracking: { enable: false }
        }
      })
    });
    if (r.status >= 200 && r.status < 300) return { ok: true };
    return { ok: false, motivo: "HTTP " + r.status };
  } catch (e) {
    return { ok: false, motivo: String(e && e.message || e).slice(0, 120) };
  }
}

app.post("/api/solicitar-acceso", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!limiteSolicitudes(req, res)) return;
    const b = req.body || {};
    const nombre = String(b.nombre || "").trim().slice(0, 120);
    const empresa = String(b.empresa || "").trim().slice(0, 140);
    const email = String(b.email || "").trim().toLowerCase().slice(0, 160);
    const whatsapp = String(b.whatsapp || "").trim().slice(0, 40);
    const nivel = ["estado", "municipio", "cp", "estacion"].includes(b.nivel) ? b.nivel : "estado";
    const historico = !!b.historico;

    // Áreas GasGas seleccionadas. Sin selección válida se asume cobertura nacional.
    let areas = Array.isArray(b.areas)
      ? [...new Set(b.areas.map(a => String(a).toUpperCase()).filter(a => AREAS_VALIDAS.includes(a)))]
      : [];
    if (b.nacional === true || areas.length === 0 || areas.length === 6) areas = [...AREAS_VALIDAS];
    const esNacional = areas.length === 6;
    const cobertura = esNacional ? "nacional" : areas.length === 1 ? "una_region" : "varias";
    const casoUso = String(b.caso_uso || "").slice(0, 80);

    if (!nombre || !empresa || !email) return res.status(400).json({ error: "Faltan datos para continuar." });
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return res.status(400).json({ error: "Ese correo no parece válido." });

    const dominio = email.split("@")[1];
    const rastro = { email, dominio, empresa };

    if (DOMINIOS_PERSONALES.has(dominio)) {
      anotarBloqueo("correo_personal", req, rastro);
      return res.status(422).json({
        error: "correo_personal",
        mensaje: "La llave de evaluación se emite a correos de empresa. Usa el tuyo corporativo y la generamos al instante."
      });
    }

    const ipCliente = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || null;

    // 🛡️ Turnstile: filtra bots antes de gastar cuota de correo
    if (!await turnstileValido(b.turnstile_token, ipCliente)) {
      anotarBloqueo("verificacion_fallida", req, rastro);
      return res.status(403).json({
        error: "verificacion_fallida",
        mensaje: "No pudimos verificar que la solicitud venga de una persona. Recargue la página e intente de nuevo."
      });
    }

    // 🛡️ El dominio tiene que poder recibir correo: evita rebotes que queman
    //    la reputación de envío, y atrapa erratas como "@gmial.com"
    if (!await dominioRecibeCorreo(dominio)) {
      anotarBloqueo("dominio_sin_correo", req, rastro);
      return res.status(422).json({
        error: "dominio_sin_correo",
        mensaje: `No encontramos servidores de correo en ${dominio}. Revise que esté bien escrito.`
      });
    }

    // 🛡️ Topes por correo, por empresa, por conexión y global del día
    const tope = await topesDeEmision(email, dominio, ipCliente);
    if (tope) {
      anotarBloqueo(tope.error, req, rastro);
      return res.status(tope.codigo).json({ error: tope.error, mensaje: tope.mensaje });
    }

    const est = estimar(nivel, areas.length, historico);

    // Prospecto
    const ip = ipCliente;
    const ins = await pool.query(
      `INSERT INTO prospectos (nombre, empresa, email, dominio, whatsapp, nivel, cobertura, areas, historico, caso_uso, estimado_min, estimado_max, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [nombre, empresa, email, dominio, whatsapp, nivel, cobertura, areas, historico, casoUso, est.min, est.max, ip, String(req.headers["user-agent"] || "").slice(0, 300)]
    );
    const prospectoId = ins.rows[0].id;

    // Llave de evaluación: 7 días · 500 llamadas
    const llave = "gg_test_" + crypto.randomBytes(18).toString("base64url");
    await pool.query(
      // 30 días para activarla; en la primera consulta el reloj se reinicia a 7 días
      `INSERT INTO api_keys_prueba (api_key, prospecto_id, empresa, email, limite, expira_en)
       VALUES ($1,$2,$3,$4,500, NOW() + INTERVAL '30 days')`,
      [llave, prospectoId, empresa, email]
    );

    const NIVEL_TXT = { estado: "nivel estado", municipio: "nivel municipio", cp: "nivel código postal", estacion: "nivel estación" };
    const areasTxt = esNacional
      ? "cobertura nacional (las 6 Áreas GasGas)"
      : areas.length === 1
        ? `Área GasGas ${areas[0]} — ${AREA_NOMBRE[areas[0]]}`
        : `${areas.length} Áreas GasGas: ${areas.map(a => `${a} (${AREA_NOMBRE[a]})`).join(", ")}`;

    // Enviar la llave por correo (si hay servicio configurado)
    const envio = await enviarLlavePorCorreo({ nombre, empresa, email, llave, nivel, areasTxt, historico, est });
    pool.query(`UPDATE prospectos SET correo_enviado = $1, correo_error = $2 WHERE id = $3`,
      [!!envio.ok, envio.ok ? null : (envio.motivo || null), prospectoId]).catch(() => {});

    const mensaje =
      `Hola, soy ${nombre} de ${empresa}. Ya generé mi llave de evaluación en gasgas.com.mx.\n\n` +
      `Lo que necesitamos: ${NIVEL_TXT[nivel]}, ${areasTxt}${historico ? ", con histórico" : ""}` +
      `${casoUso ? ` (uso: ${casoUso})` : ""}.\n` +
      `Estimado que me mostró la página: $${est.min.toLocaleString("en-US")} – $${est.max.toLocaleString("en-US")} MXN/mes + IVA.\n\n` +
      `Me gustaría revisar la propuesta formal y el alta como proveedor.`;

    // El número vive en la variable WHATSAPP_NUMERO (Render → Environment), no en el código
    const numero = String(process.env.WHATSAPP_NUMERO || "").replace(/[^0-9]/g, "");
    const whatsappUrl = numero
      ? "https://wa.me/" + numero + "?text=" + encodeURIComponent(mensaje)
      : "mailto:hola@gasgas.com.mx?subject=" + encodeURIComponent("Acceso a la API de GasGas") + "&body=" + encodeURIComponent(mensaje);

    res.json({
      ok: true,
      correo_enviado: !!envio.ok,     // la llave viaja por correo, nunca en la respuesta
      correo_destino: email,
      expira_dias: 7,
      limite_llamadas: 500,
      niveles_incluidos: ["estado", "municipio"],
      areas,
      cobertura,
      estimado: est,
      whatsapp_texto: mensaje,
      whatsapp_url: whatsappUrl,
      canal: numero ? "whatsapp" : "correo"
    });
  } catch (err) {
    console.error("ERROR /solicitar-acceso:", err);
    res.status(500).json({ error: "No pudimos procesar la solicitud. Escríbenos a hola@gasgas.com.mx" });
  }
});

// ==============================
// 🔒 STATUS PRIVADO (status.gasgas.com.mx / /status) — solo con PIN
//    - PIN en variable de entorno STATUS_PIN (nunca en el código)
//    - Cookie firmada (hash del PIN) para no teclearlo a cada rato
//    - Máx 10 intentos de PIN por IP cada 15 min
//    - Checks corren en el SERVIDOR: las llaves de Clara/cobee jamás llegan al navegador
// ==============================
const statusIntentos = new Map();
const procesoDesde = new Date().toISOString();

function statusToken() {
  return crypto.createHash("sha256").update("gasgas-status-v1|" + (process.env.STATUS_PIN || "")).digest("hex");
}
function statusAutorizado(req) {
  if (!process.env.STATUS_PIN) return false;
  const m = (req.headers.cookie || "").match(/gg_status=([a-f0-9]{64})/);
  return !!m && m[1] === statusToken();
}

app.post("/api/status/login", (req, res) => {
  res.set("Cache-Control", "no-store");
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const ahora = Date.now();
  let reg = statusIntentos.get(ip);
  if (!reg || ahora > reg.reset) { reg = { n: 0, reset: ahora + 15 * 60000 }; statusIntentos.set(ip, reg); }
  reg.n++;
  if (reg.n > 10) return res.status(429).json({ error: "Demasiados intentos. Espera 15 minutos." });
  if (!process.env.STATUS_PIN) return res.status(503).json({ error: "Falta configurar STATUS_PIN en Render → Environment" });
  if (String((req.body && req.body.pin) || "") !== process.env.STATUS_PIN) {
    return res.status(401).json({ error: "PIN incorrecto" });
  }
  statusIntentos.delete(ip);
  res.set("Set-Cookie", "gg_status=" + statusToken() + "; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax");
  res.json({ ok: true });
});

// 📈 Uso de Clara y cobee: se miden con las estadísticas de Postgres (pg_stat_statements),
//    que cuentan cada consulta aunque el tráfico no pase por este servidor.
//    Como son contadores acumulados, tomamos fotos cada 10 min y restamos para la ventana de 24 h.
const SQL_USO_CLIENTES = `
  SELECT
    COALESCE(SUM(calls) FILTER (WHERE query ILIKE '%gs.cp AS cp%'),0)::bigint AS clara,
    COALESCE(SUM(calls) FILTER (WHERE query ILIKE '%AS state%' AND query ILIKE '%average_price%'),0)::bigint AS cobee
  FROM pg_stat_statements`;
const fotosUso = []; // [{ t, clara, cobee }]
let usoDisponible = null; // null = sin probar, false = sin permisos

async function tomarFotoUso() {
  try {
    const q = await pool.query(SQL_USO_CLIENTES);
    const r = q.rows[0] || {};
    fotosUso.push({ t: Date.now(), clara: Number(r.clara || 0), cobee: Number(r.cobee || 0) });
    const corte = Date.now() - 25 * 3600000;
    while (fotosUso.length && fotosUso[0].t < corte) fotosUso.shift();
    usoDisponible = true;
  } catch (e) {
    usoDisponible = false; // p. ej. sin permiso para leer pg_stat_statements
  }
}
tomarFotoUso();
setInterval(tomarFotoUso, 10 * 60000);

function usoClientes24h() {
  if (usoDisponible === false) return { disponible: false, motivo: "Sin acceso a las estadísticas de Postgres" };
  if (fotosUso.length < 2) return { disponible: false, motivo: "Midiendo… (la primera lectura toma unos minutos)" };
  const ahora = fotosUso[fotosUso.length - 1];
  const corte = Date.now() - 24 * 3600000;
  const base = fotosUso.find(f => f.t >= corte) || fotosUso[0];
  const horas = Math.max(0.1, (ahora.t - base.t) / 3600000);
  const dif = (k) => Math.max(0, ahora[k] - base[k]);
  return {
    disponible: true,
    ventana_horas: Math.round(horas * 10) / 10,
    clara: dif("clara"),
    cobee: dif("cobee")
  };
}

const stMide = async (fn) => { const t0 = Date.now(); try { const r = await fn(); return Object.assign({ ms: Date.now() - t0 }, r); } catch (e) { return { ok: false, ms: Date.now() - t0, detalle: String(e && e.message || e).slice(0, 140) }; } };
const stTimeout = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
const stFechaMX = (offsetDias) => new Date(Date.now() - (offsetDias || 0) * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

app.get("/api/status/checks", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!statusAutorizado(req)) return res.status(401).json({ error: "PIN requerido" });
  try {
    const [clara, cobee, seed, cortes, publica] = await Promise.all([
      // 1) API de Clara: consulta real por CP con la llave del entorno
      stMide(async () => {
        const r = await fetch("https://clara.gasgas.app/api/precios-por-cp/99600?v=2", {
          headers: process.env.CLARA_API_KEY ? { "x-api-key": process.env.CLARA_API_KEY } : {},
          signal: stTimeout(8000)
        });
        if (!r.ok) return { ok: false, detalle: "HTTP " + r.status };
        const j = await r.json();
        const fresca = !!(j && j.fecha && j.fecha >= stFechaMX(1));
        const conPrecios = !!(j && j.precios && j.precios.regular);
        return { ok: conPrecios && fresca, fecha: j && j.fecha, detalle: conPrecios ? (fresca ? "responde con dato de " + j.fecha : "responde, pero con dato viejo (" + (j && j.fecha) + ")") : "responde sin precios" };
      }),
      // 2) API de cobee: promedio diario de ayer (siempre debe existir)
      stMide(async () => {
        const r = await fetch("https://cobee.gasgas.app/api/daily-average-price", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, process.env.COBEE_API_KEY ? { "x-api-key": process.env.COBEE_API_KEY } : {}),
          body: JSON.stringify({ date: stFechaMX(1) }),
          signal: stTimeout(8000)
        });
        if (!r.ok) return { ok: false, detalle: "HTTP " + r.status };
        const j = await r.json();
        const n = j && Array.isArray(j.data) ? j.data.length : 0;
        return { ok: n > 0, registros: n, detalle: n > 0 ? n + " registros para " + stFechaMX(1) : "sin registros para " + stFechaMX(1) };
      }),
      // 3) Último seed de precios a la base
      //    Los lotes se marcan con la FECHA DEL DATO (medianoche UTC), no con la hora de carga:
      //    por eso la frescura se mide comparando esa fecha contra el día de hoy en México.
      stMide(async () => {
        const q = await pool.query(`
          WITH ult AS (SELECT MAX(date::date) AS d FROM prices)
          SELECT (SELECT d FROM ult)::text AS fecha_lote,
                 (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City')::date::text AS hoy_mx,
                 ((SELECT CURRENT_DATE) - (SELECT d FROM ult))::int AS dias_atras,
                 (SELECT (COUNT(regular)+COUNT(premium)+COUNT(diesel))::int FROM prices WHERE date::date = (SELECT d FROM ult)) AS precios,
                 (SELECT COUNT(*)::int FROM prices WHERE date::date = (SELECT d FROM ult)) AS estaciones`);
        const row = q.rows[0] || {};
        const hoyMX = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
        const ayerMX = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
        const f = row.fecha_lote;
        const esHoy = f === hoyMX, esAyer = f === ayerMX;
        return {
          ok: esHoy || esAyer,
          fecha_lote: f,
          cuando: esHoy ? "hoy" : (esAyer ? "ayer" : "hace " + (row.dias_atras || "?") + " días"),
          precios: row.precios, estaciones: row.estaciones
        };
      }),
      // 4) Cortes de promedios (updateAgregados, 7 al día)
      stMide(async () => {
        const q = await pool.query(`SELECT MAX(updated_at) AS ultimo FROM precios_agregados`);
        const row = q.rows[0] || {};
        const horas = row.ultimo ? (Date.now() - new Date(row.ultimo).getTime()) / 3600000 : 999;
        return { ok: horas < 11, ultimo: row.ultimo, horas: Math.round(horas * 10) / 10 }; // 11h cubre la pausa nocturna 20:30→6:30
      }),
      // 5) API pública propia
      stMide(async () => {
        const r = await fetch("https://api.gasgas.com.mx/api/test", { signal: stTimeout(8000) });
        const j = r.ok ? await r.json() : null;
        return { ok: !!(j && j.status === "ok"), detalle: r.ok ? "responde ok" : "HTTP " + r.status };
      })
    ]);
    // Uso de NUESTRA API pública en las últimas 24 h (contador en memoria)
    const corte24 = Date.now() - 86400000;
    const top = [...usoPorRuta.entries()]
      .map(([ruta, arr]) => ({ ruta, n: arr.filter(t => t >= corte24).length }))
      .filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 5);
    const uso = { total24h: usoApi.filter(t => t >= corte24).length, top, desde: procesoDesde };
    const usoClientes = usoClientes24h();

    // Prospectos recientes y uso real de sus llaves (señal de intención de compra)
    let prospectos = { total7d: 0, lista: [] };
    try {
      const q = await pool.query(`
        SELECT p.nombre, p.empresa, p.email, p.nivel, p.cobertura, p.areas, p.historico,
               p.estimado_min, p.estimado_max, p.created_at, p.correo_enviado,
               COALESCE(k.llamadas, 0) AS llamadas, k.expira_en, k.api_key, k.activada_en
        FROM prospectos p
        LEFT JOIN api_keys_prueba k ON k.prospecto_id = p.id
        ORDER BY p.created_at DESC LIMIT 8`);
      const t7 = await pool.query(`SELECT COUNT(*)::int AS n FROM prospectos WHERE created_at > NOW() - INTERVAL '7 days'`);
      prospectos = { total7d: t7.rows[0]?.n || 0, lista: q.rows };
    } catch (e) { prospectos = { error: true }; }

    // Conexiones de la base. El 10 Ago 2026 se agotaron y toda la API respondió
    // 500 durante horas sin que nadie se enterara hasta que rebotó un proceso
    // externo. Esto lo hace visible antes de que truene.
    let conexiones = { error: true };
    try {
      const c = await pool.query(`
        SELECT
          (SELECT setting::int FROM pg_settings WHERE name='max_connections') AS tope,
          COUNT(*)::int AS en_uso,
          COUNT(*) FILTER (WHERE state='idle')::int AS inactivas,
          COUNT(*) FILTER (WHERE state='idle in transaction')::int AS atoradas
        FROM pg_stat_activity WHERE backend_type='client backend'`);
      const r = c.rows[0] || {};
      const pct = r.tope ? Math.round(100 * r.en_uso / r.tope) : 0;
      conexiones = { tope: r.tope, en_uso: r.en_uso, inactivas: r.inactivas,
                     atoradas: r.atoradas, pct,
                     alerta: pct >= 70 || r.atoradas > 0 };
    } catch (e) { conexiones = { error: true }; }

    // Intentos bloqueados: sin esto un ataque se ve igual que un día tranquilo
    let bloqueos = { total24h: 0, porMotivo: [], ipsTop: [] };
    try {
      const b24 = await pool.query(`
        SELECT motivo, COUNT(*)::int AS n
        FROM solicitudes_bloqueadas
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY motivo ORDER BY n DESC`);
      const ips = await pool.query(`
        SELECT ip, COUNT(*)::int AS n
        FROM solicitudes_bloqueadas
        WHERE created_at > NOW() - INTERVAL '24 hours' AND ip IS NOT NULL
        GROUP BY ip HAVING COUNT(*) >= 5 ORDER BY n DESC LIMIT 3`);
      const total = b24.rows.reduce((a, r) => a + r.n, 0);
      bloqueos = {
        total24h: total,
        porMotivo: b24.rows,
        ipsTop: ips.rows,
        // Un puñado de rechazos al día es normal (erratas, correos personales).
        // Arriba de 40, o una sola IP insistiendo, ya huele a automatizado.
        alerta: total >= 40 || ips.rows.length > 0
      };
    } catch (e) { bloqueos = { error: true }; }

    res.json({ generado: new Date().toISOString(), clara, cobee, seed, cortes, publica, uso, usoClientes, prospectos, bloqueos, conexiones });
  } catch (err) {
    console.error("ERROR /status/checks:", err);
    res.status(500).json({ error: "Error corriendo los checks" });
  }
});

// 🔹 Stats del día (para la landing /datos): precios y estaciones procesados hoy
app.get("/api/stats-hoy", async (req, res) => {
  try {
    // Los rangos deben coincidir con los de scripts/updateAgregados.js:
    // regular 21–27 · premium 23–32 · diesel 25–33
    const result = await pool.query(`
      SELECT
        (COUNT(regular) + COUNT(premium) + COUNT(diesel))::int AS precios_hoy,
        ( COUNT(regular) FILTER (WHERE regular BETWEEN 21 AND 27)
        + COUNT(premium) FILTER (WHERE premium BETWEEN 23 AND 32)
        + COUNT(diesel)  FILTER (WHERE diesel  BETWEEN 25 AND 33))::int AS precios_validados,
        COUNT(*)::int AS registros_hoy,
        MAX(date::date)::text AS fecha
      FROM prices
      WHERE date::date = (SELECT MAX(date::date) FROM prices)
    `);
    const r = result.rows[0] || {};
    // Cuántos descartó el filtro de calidad: es la evidencia de que trabaja
    r.precios_descartados = (r.precios_hoy || 0) - (r.precios_validados || 0);
    res.json(r);
  } catch (err) {
    console.error("ERROR /stats-hoy:", err);
    res.status(500).json({ error: "Error obteniendo stats" });
  }
});

app.get("/api/test", (req, res) => {
  res.json({ status: "ok" });
});

// ==============================
// 🩺 SALUD REAL
//
// `/api/test` responde ok sin tocar la base: durante el apagón del 10 Ago
// devolvía 200 mientras todo lo demás daba 500. Un monitor apuntado ahí
// habría dicho "todo bien" durante horas. Este sí consulta la base y
// responde 503 cuando no puede: es el que debe vigilar un monitor externo.
// ==============================
app.get("/api/salud", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const t0 = Date.now();
  try {
    const q = await pool.query(`
      SELECT (SELECT setting::int FROM pg_settings WHERE name='max_connections') AS tope,
             (SELECT COUNT(*) FROM pg_stat_activity WHERE backend_type='client backend') AS en_uso,
             (SELECT MAX(date::date)::text FROM prices) AS ultimo_lote`);
    const r = q.rows[0] || {};
    const pct = r.tope ? Math.round(100 * r.en_uso / r.tope) : null;
    const hoyMX = new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
    const lote_al_dia = r.ultimo_lote === hoyMX;
    const sano = pct !== null && pct < 85;
    res.status(sano ? 200 : 503).json({
      estado: sano ? "ok" : "presion_de_conexiones",
      conexiones: { en_uso: Number(r.en_uso), tope: Number(r.tope), pct },
      ultimo_lote: r.ultimo_lote, lote_al_dia,
      ms: Date.now() - t0
    });
  } catch (e) {
    res.status(503).json({ estado: "base_inalcanzable", detalle: String(e.message).slice(0, 120), ms: Date.now() - t0 });
  }
});

// ==============================
// 🔔 AVISOS POR CORREO
//
// El foco ámbar de /status solo sirve si alguien abre /status. El 10 Ago
// estuvimos caídos horas y nos enteramos porque un tercero nos escribió.
// Esto revisa solo y avisa; también manda un correo cuando ya se resolvió,
// para no dejar a nadie con el pendiente.
// ==============================
const ALERTAS_A = (process.env.ALERTAS_CORREOS || "javier@gasgas.com.mx,cesar@gasgas.com.mx")
  .split(",").map(s => s.trim()).filter(Boolean);
const REPETIR_AVISO_MS = 6 * 3600000;   // no insistir con lo mismo antes de 6 h
// Umbral configurable para poder probar el envío: bajarlo a 1 en Render hace que
// llegue el correo en el siguiente chequeo, y al regresarlo a 70 llega el de
// "ya se resolvió". Así se comprueba el circuito completo sin esperar una falla.
const UMBRAL_CONEXIONES = Number(process.env.ALERTA_CONEXIONES_PCT) || 70;
// Un umbral absurdamente bajo solo puede ser una prueba. El correo lo dice
// claramente en vez de disfrazarse de emergencia: una alarma de práctica que
// se ve igual que una real es la mejor forma de que dejen de hacerle caso.
const MODO_PRUEBA = UMBRAL_CONEXIONES < 20;
const avisosActivos = new Map();        // clave → { desde, ultimoEnvio }

/** Correo de aviso. Dos formatos: alerta (rojo, con qué hacer) y todo-en-orden (verde). */
async function enviarAviso({ alerta, titulo, quePaso, queSignifica, pedirAClaude, nota }) {
  titulo = String(titulo || "");
  const KEY = process.env.SENDGRID_API_KEY;
  const DE = process.env.CORREO_REMITENTE || "hola@gasgas.com.mx";
  if (!KEY || !ALERTAS_A.length) return false;

  const prueba = alerta && MODO_PRUEBA;
  // En prueba, el titular no puede anunciar una falla que no existe
  if (prueba) titulo = "Prueba del sistema de avisos";
  const franja = prueba ? "#B45309" : alerta ? "#B91C1C" : "#007A39";
  const etiqueta = prueba ? "PRUEBA DEL SISTEMA — NO ES UNA FALLA"
                 : alerta ? "REQUIERE ATENCIÓN" : "TODO EN ORDEN";

  const bloqueClaude = pedirAClaude ? `
  <tr><td style="padding:4px 30px 0;">
    <div style="font-family:'SFMono-Regular',Consolas,monospace;font-size:10px;letter-spacing:1px;color:#8B99A6;">CÓPIALE ESTO A CLAUDE</div>
    <div style="background:#0E2A47;border-radius:9px;padding:14px 16px;margin-top:7px;
                font-family:'SFMono-Regular',Consolas,monospace;font-size:13px;line-height:1.5;color:#E8F5EE;">${esc(pedirAClaude)}</div>
    <div style="font-size:13px;color:#4C6379;margin-top:8px;">Pégalo tal cual y él lo revisa. Entre más pronto, mejor.</div>
  </td></tr>` : "";

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F8;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#FFFFFF;border-radius:14px;overflow:hidden;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">

  <tr><td style="background:${franja};padding:22px 30px;">
    <div style="color:rgba(255,255,255,.75);font-size:11px;letter-spacing:1.5px;font-weight:bold;">${etiqueta}</div>
    <div style="color:#FFFFFF;font-size:22px;font-weight:800;margin-top:8px;line-height:1.3;">${esc(titulo)}</div>
  </td></tr>

  <tr><td style="padding:24px 30px 0;">
    <div style="font-family:'SFMono-Regular',Consolas,monospace;font-size:10px;letter-spacing:1px;color:#8B99A6;">QUÉ PASÓ</div>
    <div style="font-size:16px;color:#0E2A47;margin-top:6px;line-height:1.55;">${esc(quePaso)}</div>
  </td></tr>

  ${queSignifica ? `<tr><td style="padding:18px 30px 0;">
    <div style="font-family:'SFMono-Regular',Consolas,monospace;font-size:10px;letter-spacing:1px;color:#8B99A6;">QUÉ SIGNIFICA</div>
    <div style="font-size:15.5px;color:#4C6379;margin-top:6px;line-height:1.55;">${esc(queSignifica)}</div>
  </td></tr>` : ""}

  ${bloqueClaude ? `<tr><td style="padding:18px 30px 0;"><div style="border-top:1px solid #E7ECF0;"></div></td></tr>` + bloqueClaude : ""}

  ${nota ? `<tr><td style="padding:18px 30px 0;">
    <div style="font-size:15px;color:#4C6379;line-height:1.55;">${esc(nota)}</div>
  </td></tr>` : ""}

  <tr><td style="padding:22px 30px 26px;">
    <a href="https://gasgas.com.mx/status" style="display:block;background:${alerta ? "#0E2A47" : "#00A94F"};color:#FFFFFF;text-decoration:none;
       border-radius:9px;padding:13px;text-align:center;font-size:15.5px;font-weight:700;">Abrir el tablero</a>
  </td></tr>

  <tr><td style="background:#081B30;padding:14px 30px;">
    <span style="color:rgba(255,255,255,.5);font-size:11.5px;">GasGas · aviso automático · se revisa cada 10 minutos</span>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  const texto = `${etiqueta}\n${titulo}\n\nQUÉ PASÓ\n${quePaso}\n` +
    (queSignifica ? `\nQUÉ SIGNIFICA\n${queSignifica}\n` : "") +
    (pedirAClaude ? `\nCÓPIALE ESTO A CLAUDE\n${pedirAClaude}\n` : "") +
    (nota ? `\n${nota}\n` : "") +
    `\nTablero: https://gasgas.com.mx/status`;

  try {
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: ALERTAS_A.map(email => ({ email })) }],
        from: { email: DE, name: "GasGas · Avisos" },
        subject: (prueba ? "🔧 Prueba de avisos · " : alerta ? "⚠️ " : "✅ ") + titulo,
        content: [{ type: "text/plain", value: texto }, { type: "text/html", value: html }],
        tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } }
      })
    });
    return r.status >= 200 && r.status < 300;
  } catch (e) { console.error("aviso:", e.message); return false; }
}

/** Levanta o baja un aviso, sin repetirlo cada 10 minutos. */
async function marcarAviso(clave, activo, info) {
  const ahora = Date.now();
  const previo = avisosActivos.get(clave);

  if (activo) {
    if (!previo) {
      avisosActivos.set(clave, { desde: ahora, ultimoEnvio: ahora, titulo: info.titulo });
      await enviarAviso({ alerta: true, ...info });
    } else if (ahora - previo.ultimoEnvio > REPETIR_AVISO_MS) {
      previo.ultimoEnvio = ahora;
      const horas = Math.round((ahora - previo.desde) / 3600000);
      await enviarAviso({ alerta: true, ...info,
        titulo: "Sigue sin resolverse: " + info.titulo,
        nota: `Lleva ${horas} horas así. Si no se ha revisado, este es buen momento.` });
    }
  } else if (previo) {
    avisosActivos.delete(clave);
    const min = Math.round((ahora - previo.desde) / 60000);
    const duracion = min < 60 ? `${min} minutos` : `${Math.round(min / 60)} horas`;
    await enviarAviso({
      alerta: false,
      titulo: "Todo volvió a la normalidad",
      quePaso: `Lo que te avisamos hace rato — "${previo.titulo}" — ya se resolvió. Duró ${duracion}.`,
      queSignifica: "El sistema está funcionando bien otra vez. No tienes que hacer nada.",
      nota: "Seguimos revisando cada 10 minutos. Si algo vuelve a salirse de lo normal, te avisamos igual que esta vez."
    });
  }
}

async function revisarSalud() {
  try {
    const q = await pool.query(`
      SELECT (SELECT setting::int FROM pg_settings WHERE name='max_connections') AS tope,
             (SELECT COUNT(*) FROM pg_stat_activity WHERE backend_type='client backend') AS en_uso,
             (SELECT MAX(date::date)::text FROM prices) AS ultimo_lote`);
    const r = q.rows[0] || {};
    const pct = Math.round(100 * r.en_uso / r.tope);

    await marcarAviso("conexiones", pct >= UMBRAL_CONEXIONES, {
      titulo: "La base de datos se está saturando",
      quePaso: MODO_PRUEBA
        ? `Todo bien: hay ${r.en_uso} conexiones abiertas de las ${r.tope} que aguanta la base, apenas ${pct}%.`
        : `Hay ${r.en_uso} conexiones abiertas de las ${r.tope} que aguanta la base. Va en ${pct}%.`,
      queSignifica: MODO_PRUEBA
        ? `Esto es un simulacro: el umbral está puesto en ${UMBRAL_CONEXIONES}% a propósito para probar el envío. El sistema está sano — un valor normal es menos de 40%. Regresa ALERTA_CONEXIONES_PCT a 70 en Render.`
        : "Si llega al 85%, la página deja de mostrar precios y las APIs de Clara y cobee empiezan a fallar. Todavía no pasa nada, pero va en esa dirección.",
      pedirAClaude: MODO_PRUEBA ? "" :
        `Las conexiones de la base están al ${pct}%. Revisa qué las está ocupando y bájalas antes de que lleguen al 85%.`,
      nota: MODO_PRUEBA ? "" : "Mientras tanto: no publiques cambios, cada despliegue ocupa conexiones de más."
    });

    // El lote del día debe entrar antes del mediodía en México
    const hoyMX = new Date(Date.now() - 6 * 3600000);
    const fechaMX = hoyMX.toISOString().slice(0, 10);
    const pasoMediodia = hoyMX.getUTCHours() >= 12;
    await marcarAviso("seed", pasoMediodia && r.ultimo_lote !== fechaMX, {
      titulo: "No han entrado los precios de hoy",
      quePaso: `Los precios más recientes que tenemos son del ${r.ultimo_lote}, y hoy es ${fechaMX}.`,
      queSignifica: "La página y las APIs están entregando los precios de ayer. No se rompe nada, pero el dato está viejo y los clientes lo pueden notar.",
      pedirAClaude: `No entraron los precios de hoy: el último lote es del ${r.ultimo_lote}. Revisa el proceso "Feed prices" en Northflank y dime qué pasó.`
    });

    await marcarAviso("base", false, {});
  } catch (e) {
    // Si la base no responde, eso es lo que hay que avisar
    await marcarAviso("base", true, {
      titulo: "La base de datos no responde",
      quePaso: "El servidor no puede consultar ningún dato. Esto lleva pasando al menos unos minutos.",
      queSignifica: "La página carga pero sin precios, y los clientes que usan la API están recibiendo errores. Es lo más grave que puede avisar este correo.",
      pedirAClaude: "La base de datos no responde y /api/salud está dando 503. Diagnostica qué pasa y dime qué hacer.",
      nota: `Detalle técnico: ${String(e.message).slice(0, 140)}`
    });
  }
}

// Primera revisión a los 2 minutos (deja que arranque), luego cada 10
setTimeout(revisarSalud, 2 * 60000);
setInterval(revisarSalud, 10 * 60000);

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// ==============================
// 🚀 SERVER
// ==============================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 GasGas API corriendo en puerto ${PORT}`);
});
