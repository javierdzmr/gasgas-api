const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function updateHistoricos() {
  try {
    console.log("🚀 Actualizando históricos...");

    // 🧹 limpiar últimos 30 días (estado + nacional)
    await pool.query(`
      DELETE FROM precios_historicos_agregados
      WHERE date >= CURRENT_DATE - INTERVAL '30 days'
      AND market_type IN ('estado','nacional');
    `);

    console.log("🧹 Históricos limpiados");

    // 🔥 insertar históricos
    await pool.query(`
      INSERT INTO precios_historicos_agregados
      (market_type, market_value, date, regular, premium, diesel, updated_at)

      -- =========================
      -- 🔥 ESTADO
      -- =========================
      SELECT
        'estado',
        gs.estado,
        p.date,
        AVG(NULLIF(p.regular, 0)),
        AVG(NULLIF(p.premium, 0)),
        AVG(NULLIF(p.diesel, 0)),
        NOW()
      FROM prices p
      JOIN prices_gas_station_links l ON l.price_id = p.id
      JOIN gas_stations gs ON gs.id = l.gas_station_id
      WHERE p.date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY gs.estado, p.date

      UNION ALL

      -- =========================
      -- 🔥 NACIONAL
      -- =========================
      SELECT
        'nacional',
        'México',
        p.date,
        AVG(NULLIF(p.regular, 0)),
        AVG(NULLIF(p.premium, 0)),
        AVG(NULLIF(p.diesel, 0)),
        NOW()
      FROM prices p
      JOIN prices_gas_station_links l ON l.price_id = p.id
      WHERE p.date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY p.date;
    `);

    console.log("✅ Históricos actualizados");

    process.exit(0);

  } catch (error) {
    console.error("❌ Error en históricos:", error);
    process.exit(1);
  }
}

updateHistoricos();
