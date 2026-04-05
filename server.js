const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

app.use(cors());
app.use(express.json());

// 🔥 CONEXIÓN A POSTGRES
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 🧠 MAPEO DE MERCADOS
const marketMap = {
  CDMX: "Ciudad de México",
  cdmx: "Ciudad de México"
};

// ===============================
// 📊 API DE PRECIOS
// ===============================
app.get('/api/precios', async (req, res) => {
  const { market = "nacional", value = "CDMX", days = 30 } = req.query;

  const mappedValue = marketMap[value] || value;

  try {
    let query = "";
    let params = [];

    if (market === "nacional") {
      query = `
SELECT regular, premium, diesel
FROM precios_agregados
WHERE market_type = 'nacional'
AND days = $1
ORDER BY updated_at DESC
LIMIT 1
`;
      params = [days];
    } else {
      query = `
SELECT regular, premium, diesel
FROM precios_agregados
WHERE market_type = $1
AND LOWER(market_value) = LOWER($2)
AND days = $3
ORDER BY updated_at DESC
LIMIT 1
`;
      params = [market, mappedValue, days];
    }

    const result = await db.query(query, params);

    res.json({
      mercado: market,
      regular: result.rows[0]?.regular
        ? parseFloat(result.rows[0].regular).toFixed(2)
        : 0,
      premium: result.rows[0]?.premium
        ? parseFloat(result.rows[0].premium).toFixed(2)
        : 0,
      diesel: result.rows[0]?.diesel
        ? parseFloat(result.rows[0].diesel).toFixed(2)
        : 0
    });

  } catch (error) {
    console.error(error);
    res.status(500).send(error.message);
  }
});

// ===============================
// 📈 API HISTÓRICO
// ===============================
app.get('/api/historico', async (req, res) => {
  const { market = "nacional", value = "CDMX", days = 30 } = req.query;

  const mappedValue = marketMap[value] || value;

  try {
    let query = "";
    let params = [];

    if (market === "nacional") {
      query = `
SELECT updated_at as date, regular, premium, diesel
FROM precios_agregados
WHERE market_type = 'nacional'
AND days = $1
ORDER BY updated_at ASC
`;
      params = [days];
    } else {
      query = `
SELECT updated_at as date, regular, premium, diesel
FROM precios_agregados
WHERE market_type = $1
AND LOWER(market_value) = LOWER($2)
AND days = $3
ORDER BY updated_at ASC
`;
      params = [market, mappedValue, days];
    }

    const result = await db.query(query, params);

    res.json(
      result.rows.map(row => ({
        date: row.date,
        regular: row.regular
          ? parseFloat(row.regular).toFixed(2)
          : 0,
        premium: row.premium
          ? parseFloat(row.premium).toFixed(2)
          : 0,
        diesel: row.diesel
          ? parseFloat(row.diesel).toFixed(2)
          : 0
      }))
    );

  } catch (error) {
    console.error(error);
    res.status(500).send(error.message);
  }
});

// ===============================
// 🚀 PUERTO
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
