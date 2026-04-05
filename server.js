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

// 🚀 API DE PRECIOS
app.get('/api/precios', async (req, res) => {
  const { market = "nacional", value = "nacional", days = 30 } = req.query;

  try {
    let query;
    let params;

    // 🌎 CASO NACIONAL (sin filtro)
    if (market === "nacional") {
      query = `
        SELECT 
          AVG(regular) as regular,
          AVG(premium) as premium,
          AVG(diesel) as diesel
        FROM precios_agregados
        WHERE days = $1
      `;
      params = [days];
    } else {
      // 📍 CASO ESTADO / CIUDAD
      query = `
        SELECT 
          AVG(regular) as regular,
          AVG(premium) as premium,
          AVG(diesel) as diesel
        FROM precios_agregados
        WHERE market_type = $1
        AND market_value = $2
        AND days = $3
      `;
      params = [market, value, days];
    }

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return res.json({
        mercado: market,
        regular: 0,
        premium: 0,
        diesel: 0
      });
    }

    res.json({
      mercado: market,
      regular: parseFloat(result.rows[0].regular).toFixed(2),
      premium: parseFloat(result.rows[0].premium).toFixed(2),
      diesel: parseFloat(result.rows[0].diesel).toFixed(2)
    });

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
