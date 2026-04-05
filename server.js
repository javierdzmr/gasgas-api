const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

app.use(cors());
app.use(express.json());

// 🔥 CONEXIÓN A POSTGRES (Render)
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 🚀 API DE PRECIOS (USANDO PRE-CÁLCULO)
app.get('/api/precios', async (req, res) => {
  const { market = "nacional", value = "nacional", days = 30 } = req.query;

  try {
    const result = await db.query(`
      SELECT regular, premium, diesel
      FROM precios_agregados
      WHERE market_type = $1
      AND market_value = $2
      AND days = $3
      LIMIT 1
    `, [market, value, days]);

    if (result.rows.length === 0) {
      return res.json({
        regular: 0,
        premium: 0,
        diesel: 0
      });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error(error);
    res.status(500).send("Error en API");
  }
});

// ✅ IMPORTANTE PARA RENDER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
