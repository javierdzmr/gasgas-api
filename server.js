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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 🗄️ conexión a la base de datos
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ==============================
// 🔹 PRECIOS
// ==============================
app.get("/api/precios", async (req, res) => {
  try {
    const { market, value, days, product } = req.query;

    const minCol = `min_${product}`;
    const maxCol = `max_${product}`;
    const stdCol = `std_${product}`;

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
    res.json(result.rows[0] || {});

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

    query += ` AND date >= NOW() - INTERVAL '${days} days' ORDER BY date`;

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
// 🔹 RANKING ESTADOS
// ==============================
app.get("/api/ranking-estados", async (req, res) => {
  try {
    const { product } = req.query;
    const col = ['regular','premium','diesel'].includes(product) ? product : 'regular';

    const result = await pool.query(`
      SELECT market_value AS estado, regular, premium, diesel
      FROM precios_agregados
      WHERE market_type = 'estado'
        AND days = 1
        AND ${col} IS NOT NULL
      ORDER BY ${col} DESC
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
// 🔹 HEALTH CHECK
// ==============================
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "GasGas API" });
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
