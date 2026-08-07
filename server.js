const express = require('express');
const { Pool } = require('pg');

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

// 📄 Servir el dashboard desde public/ (gasgas-api-dev.onrender.com)
app.use(express.static('public', { extensions: ['html'] }));

// 🗄️ conexión a la base de datos
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
          market !== "nacional"
            ? `(SELECT COUNT(*) FROM gas_stations WHERE LOWER(estado)=LOWER($2)) AS total_estaciones`
            : `(SELECT COUNT(*) FROM gas_stations) AS total_estaciones`
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
// 🔹 PRECIO POR MARCA COMERCIAL (value-add: la CNE no da la bandera)
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
        nota: "El catálogo completo (4,900+ CPs) opera con API key por contrato.",
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
      { nota: "CP de demostración. Catálogo completo de 4,900+ CPs por contrato." }));
  } catch (err) {
    console.error("ERROR /demo/cp:", err);
    res.status(500).json({ error: "Error obteniendo demo de CP" });
  }
});

// 🔹 Stats del día (para la landing /datos): precios y estaciones procesados hoy
app.get("/api/stats-hoy", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (COUNT(regular) + COUNT(premium) + COUNT(diesel))::int AS precios_hoy,
        COUNT(*)::int AS registros_hoy,
        MAX(date::date)::text AS fecha
      FROM prices
      WHERE date::date = (SELECT MAX(date::date) FROM prices)
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("ERROR /stats-hoy:", err);
    res.status(500).json({ error: "Error obteniendo stats" });
  }
});

app.get("/api/test", (req, res) => {
  res.json({ status: "ok" });
});

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
