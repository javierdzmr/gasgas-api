const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

// 🔌 Conexión a PostgreSQL (usa tu DATABASE_URL de Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// 🧠 Mapeo de valores (ej: CDMX → Ciudad de México)
const marketMap = {
  CDMX: "Ciudad de México",
  cdmx: "Ciudad de México",
};

// 🚀 ENDPOINT PRINCIPAL
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

    // Si NO es nacional, agregamos filtro por value
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

    // Si no hay datos → devolver ceros
    if (!result.rows.length) {
      return res.json({
        regular: 0,
        premium: 0,
        diesel: 0,
      });
    }

    // Convertir a número por si vienen como string
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

// ❤️ Health check
app.get("/", (req, res) => {
  res.send("GasGas API running 🚀");
});

// 🚀 Levantar servidor
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
