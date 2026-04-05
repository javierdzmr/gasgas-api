const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

// 🔌 Conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// 🧠 Mapeo de valores
const marketMap = {
  CDMX: "Ciudad de México",
  cdmx: "Ciudad de México",
};

// ===============================
// 🚀 ENDPOINT PRECIOS (SNAPSHOT)
// ===============================
app.get("/api/precios", async (req, res) => {
  try {
    const { market = "nacional", value = "nacional", days = 30 } = req.query;

    console.log("PARAMS:", { market, value, days });

    const mappedValue = marketMap[value] || value;

    console.log("MAPPED VALUE:", mappedValue);

    let query = `
      SELECT regular, premium, diesel
      FROM precios_agregados
      WHERE market_type = $1
    `;

    let params = [market];

    if (market !== "nacional") {
      query += `
        AND LOWER(TRIM(market_value)) = LOWER(TRIM($2))
        AND days = $3
      `;
      params.push(mappedValue, days);
    } else {
      query += `
        AND days = $2
      `;
      params.push(days);
    }

    console.log("QUERY:", query);
    console.log("PARAMS ARRAY:", params);

    const result = await pool.query(query, params);

    console.log("RESULT ROWS:", result.rows);

    if (!result.rows.length) {
      return res.json({
        regular: 0,
        premium: 0,
        diesel: 0,
      });
    }

    const row = result.rows[0];

    res.json({
      regular: Number(row.regular),
      premium: Number(row.premium),
      diesel: Number(row.diesel),
    });

  } catch (error) {
    console.error("ERROR API:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ==================================
// 📊 ENDPOINT HISTÓRICO (GRÁFICA REAL)
// ==================================
app.get("/api/historico", async (req, res) => {
  try {
    const {
      market = "nacional",
      value = "nacional",
      days = 30,
      product = "regular"
    } = req.query;

    console.log("HIST PARAMS:", { market, value, days, product });

    const mappedValue = marketMap[value] || value;

    let query = `
      SELECT date, ${product}
      FROM precios_historicos_agregados
      WHERE market_type = $1
    `;

    let params = [market];

    if (market !== "nacional") {
      query += `
        AND LOWER(TRIM(market_value)) = LOWER(TRIM($2))
        AND date >= CURRENT_DATE - INTERVAL '${days} days'
      `;
      params.push(mappedValue);
    } else {
      query += `
        AND date >= CURRENT_DATE - INTERVAL '${days} days'
      `;
    }

    query += ` ORDER BY date ASC`;

    console.log("HIST QUERY:", query);
    console.log("HIST PARAMS ARRAY:", params);

    const result = await pool.query(query, params);

    console.log("HIST RESULT ROWS:", result.rows.length);

    res.json(result.rows);

  } catch (error) {
    console.error("ERROR HISTORICO:", error);
    res.status(500).json({ error: "Error histórico" });
  }
});

// ===============================
// ❤️ HEALTH CHECK
// ===============================
app.get("/", (req, res) => {
  res.send("GasGas API running 🚀");
});

// ===============================
// 🚀 START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
