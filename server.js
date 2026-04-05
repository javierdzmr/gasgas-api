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

// 🚀 API DE PRECIOS (PROMEDIO PRO)
app.get('/api/precios', async (req, res) => {
  const { market = "nacional", value = "CDMX", days = 30 } = req.query;

  try {
    let query;
    let params;

    if (market === "nacional") {
      query = `
        WITH estaciones AS (
          SELECT 
            g.id as station_id,
            AVG(p.regular) as regular,
            AVG(p.premium) as premium,
            AVG(p.diesel) as diesel
          FROM prices p
          JOIN prices_gas_station_links l ON p.id = l.price_id
          JOIN gas_stations g ON l.gas_station_id = g.id
          WHERE p.date >= NOW() - INTERVAL '${days} days'
          GROUP BY g.id
        )
        SELECT 
          AVG(regular) as regular,
          AVG(premium) as premium,
          AVG(diesel) as diesel
        FROM estaciones
      `;
      params = [];
    } else {
      query = `
        WITH estaciones AS (
          SELECT 
            g.id as station_id,
            AVG(p.regular) as regular,
            AVG(p.premium) as premium,
            AVG(p.diesel) as diesel
          FROM prices p
          JOIN prices_gas_station_links l ON p.id = l.price_id
          JOIN gas_stations g ON l.gas_station_id = g.id
          WHERE p.date >= NOW() - INTERVAL '${days} days'
          AND g.estado = $1
          GROUP BY g.id
        )
        SELECT 
          AVG(regular) as regular,
          AVG(premium) as premium,
          AVG(diesel) as diesel
        FROM estaciones
      `;
      params = [value];
    }

    const result = await db.query(query, params);

    res.json({
      mercado: market,
      regular: result.rows[0].regular ? parseFloat(result.rows[0].regular).toFixed(2) : 0,
      premium: result.rows[0].premium ? parseFloat(result.rows[0].premium).toFixed(2) : 0,
      diesel: result.rows[0].diesel ? parseFloat(result.rows[0].diesel).toFixed(2) : 0
    });

  } catch (error) {
    console.error(error);
    res.status(500).send(error.message);
  }
});

// 📈 API HISTÓRICO (PARA GRÁFICAS)
app.get('/api/historico', async (req, res) => {
  const { market = "nacional", value = "CDMX", days = 30 } = req.query;

  try {
    let query;
    let params;

    if (market === "nacional") {
      query = `
        WITH estaciones AS (
          SELECT 
            g.id as station_id,
            p.date,
            AVG(p.regular) as regular,
            AVG(p.premium) as premium,
            AVG(p.diesel) as diesel
          FROM prices p
          JOIN prices_gas_station_links l ON p.id = l.price_id
          JOIN gas_stations g ON l.gas_station_id = g.id
          WHERE p.date >= NOW() - INTERVAL '${days} days'
          GROUP BY g.id, p.date
        )
        SELECT 
          date,
          AVG(regular) as regular,
          AVG(premium) as premium,
          AVG(diesel) as diesel
        FROM estaciones
        GROUP BY date
        ORDER BY date ASC
      `;
      params = [];
    } else {
      query = `
        WITH estaciones AS (
          SELECT 
            g.id as station_id,
            p.date,
            AVG(p.regular) as regular,
            AVG(p.premium) as premium,
            AVG(p.diesel) as diesel
          FROM prices p
          JOIN prices_gas_station_links l ON p.id = l.price_id
          JOIN gas_stations g ON l.gas_station_id = g.id
          WHERE p.date >= NOW() - INTERVAL '${days} days'
          AND g.estado = $1
          GROUP BY g.id, p.date
        )
        SELECT 
          date,
          AVG(regular) as regular,
          AVG(premium) as premium,
          AVG(diesel) as diesel
        FROM estaciones
        GROUP BY date
        ORDER BY date ASC
      `;
      params = [value];
    }

    const result = await db.query(query, params);

    res.json(
      result.rows.map(row => ({
        date: row.date,
        regular: row.regular ? parseFloat(row.regular).toFixed(2) : 0,
        premium: row.premium ? parseFloat(row.premium).toFixed(2) : 0,
        diesel: row.diesel ? parseFloat(row.diesel).toFixed(2) : 0
      }))
    );

  } catch (error) {
    console.error(error);
    res.status(500).send(error.message);
  }
});

// ✅ PUERTO
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
