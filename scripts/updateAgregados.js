yconst { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function updateAgregados() {
  try {
    console.log("🚀 Iniciando actualización de agregados...");

    // 🧹 Limpiar datos previos (solo estado y nacional)
    await pool.query(`
      DELETE FROM precios_agregados 
      WHERE market_type IN ('estado','nacional') 
      AND days IN (7,30);
    `);

    console.log("🧹 Datos anteriores eliminados");

    // 🔥 Insertar nuevos agregados
    await pool.query(`
      INSERT INTO precios_agregados 
      (market_type, market_value, days, regular, premium, diesel, updated_at)

      WITH base AS (
        -- 🔹 Promedio por estación por día
        SELECT
          psl.gas_station_id,
          p.date,
          AVG(NULLIF(p.regular, 0)) AS regular,
          AVG(NULLIF(p.premium, 0)) AS premium,
          AVG(NULLIF(p.diesel, 0)) AS diesel
        FROM prices p
        JOIN prices_gas_station_links psl
          ON p.id = psl.price_id
        WHERE p.date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY psl.gas_station_id, p.date
      )

      -- =========================
      -- 🔥 ESTADO - 7 DÍAS
      -- =========================
      SELECT
        'estado',
        gs.estado,
        7,
        AVG(b.regular),
        AVG(b.premium),
        AVG(b.diesel),
        NOW()
      FROM base b
      JOIN gas_stations gs ON gs.id = b.gas_station_id
      WHERE b.date >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY gs.estado

      UNION ALL

      -- =========================
      -- 🔥 ESTADO - 30 DÍAS
      -- =========================
      SELECT
        'estado',
        gs.estado,
        30,
        AVG(b.regular),
        AVG(b.premium),
        AVG(b.diesel),
        NOW()
      FROM base b
      JOIN gas_stations gs ON gs.id = b.gas_station_id
      GROUP BY gs.estado

      UNION ALL

      -- =========================
      -- 🔥 NACIONAL - 7 DÍAS
      -- =========================
      SELECT
        'nacional',
        'México',
        7,
        AVG(b.regular),
        AVG(b.premium),
        AVG(b.diesel),
        NOW()
      FROM base b
      WHERE b.date >= CURRENT_DATE - INTERVAL '7 days'

      UNION ALL

      -- =========================
      -- 🔥 NACIONAL - 30 DÍAS
      -- =========================
      SELECT
        'nacional',
        'México',
        30,
        AVG(b.regular),
        AVG(b.premium),
        AVG(b.diesel),
        NOW()
      FROM base b;
    `);

    console.log("✅ Agregados (estado + nacional | 7 y 30 días) actualizados");

    process.exit(0);

  } catch (error) {
    console.error("❌ Error actualizando agregados:", error);
    process.exit(1);
  }
}

updateAgregados();
