const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// 🔐 importante para Cloudflare / Render
app.set('trust proxy', 1);

// 👉 si tienes archivos estáticos (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// 👉 RUTA PRINCIPAL (FIX CLAVE)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
  // Si no tienes carpeta public, usa esto en su lugar:
  // res.send('API GasGas funcionando');
});

// 👉 ejemplo de API (ajústalo a tu lógica real)
app.get('/api/test', (req, res) => {
  res.json({ status: 'ok' });
});

// 👉 fallback para rutas no encontradas
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// 👉 levantar servidor
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ==============================
// 🔹 PRECIOS
// ==============================
app.get("/api/precios", async (req, res) => {
  try {
    const { market, value, days, product } = req.query;

    console.log("PRECIOS →", { market, value, days, product });

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

        -- 🔥 TOTAL CORRECTO POR MERCADO
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
      query += ` AND LOWER(market_value) = LOWER($2)`;
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
