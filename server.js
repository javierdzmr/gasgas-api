const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});


// ==============================
// 🔹 PRECIOS (CARDS + FOOTER)
// ==============================
app.get("/api/precios", async (req, res) => {
  try {
    const { market, value, days } = req.query;

    let query = `
      SELECT 
        pa.regular,
        pa.premium,
        pa.diesel,
        pa.updated_at,
        pa.min_regular,
        pa.max_regular,
        pa.std_regular,
        pa.stations_count,
        (SELECT COUNT(*) FROM gas_stations) AS total_estaciones
      FROM precios_agregados pa
      WHERE pa.market_type = $1
    `;

    let params = [market];

    if (market !== "nacional") {
      query += ` AND pa.market_value = $2 AND pa.days = $3`;
      params.push(value, days);
    } else {
      query += ` AND pa.market_value = 'all' AND pa.days = $2`;
      params.push(days);
    }

    const result = await pool.query(query, params);

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo precios" });
  }
});


// ==============================
// 🔹 HISTÓRICO (GRÁFICA)
// ==============================
app.get("/api/historico", async (req, res) => {
  try {
    const { market, value, days, product } = req.query;

    let query = `
      SELECT 
        date,
        regular,
        premium,
        diesel
      FROM precios_historicos_agregados
      WHERE market_type = $1
    `;

    let params = [market];

    if (market !== "nacional") {
      query += ` AND market_value = $2`;
      params.push(value);
    } else {
      query += ` AND market_value = 'all'`;
    }

    query += `
      AND date >= NOW() - INTERVAL '${days} days'
      ORDER BY date
    `;

    const result = await pool.query(query, params);

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error obteniendo histórico" });
  }
});


// ==============================
// 🔹 ESTADOS (DROPDOWN)
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
    console.error(err);
    res.status(500).json({ error: "Error obteniendo estados" });
  }
});


// ==============================
// 🚀 SERVER
// ==============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 API corriendo en puerto ${PORT}`);
});
