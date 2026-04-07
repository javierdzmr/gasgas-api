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
// 🔹 PRECIOS
// ==============================
app.get("/api/precios", async (req, res) => {
  try {
    const { market, value, days } = req.query;

    console.log("PRECIOS →", { market, value, days });

    let query = `
      SELECT 
        pa.regular,
        pa.premium,
        pa.diesel,
        pa.updated_at,
        pa.min_regular AS min,
        pa.max_regular AS max,
        pa.std_regular AS std,
        pa.stations_count,
        (SELECT COUNT(*) FROM gas_stations) AS total_estaciones
      FROM precios_agregados pa
      WHERE pa.market_type = $1
    `;

    let params = [market];

    if (market !== "nacional") {
      query += `
        AND LOWER(pa.market_value) = LOWER($2)
        AND pa.days = $3
      `;
      params.push(value, days);
    } else {
      query += `
        AND pa.market_value = 'all'
        AND pa.days = $2
      `;
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

    console.log("HISTORICO →", { market, value, days });

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
      query += `
        AND LOWER(market_value) = LOWER($2)
      `;
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
// 🚀 SERVER
// ==============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 API corriendo en puerto ${PORT}`);
});
