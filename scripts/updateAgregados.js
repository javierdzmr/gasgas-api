const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function updateAgregados() {
  try {
    console.log("🚀 Iniciando actualización de agregados...");

    // 🧹 Limpiar solo estados (7 y 30)
    await pool.query(`
      DELETE FROM precios_agregados 
      WHERE market_type = 'estado' AND days IN (7,30);
    `);

    console.log("🧹 Datos anteriores eliminados");

    // 🔥 Insertar 7 y 30 días en un solo query
    await pool.query(`
      INSERT INTO precios_agregados 
      (market_type, market_value, days, regular, premium, diesel, updated_at)

      -- =========================
      -- 🔥 BASE: promedio por estación
      -- =========================
      WITH base AS (
        SELECT
          psl.gas_station_id,
          p.date,
          AVG(NULLIF(p.regular, 0)) as regular,
          AVG(NULLIF(p.premium, 0)) as premium,
          AVG(NULLIF(p.diesel, 0)) as diesel
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
      GROUP BY gs.estado;
    `);

    console.log("✅ Agregados (7 y 30 días) actualizados correctamente");

    process.exit(0);

  } catch (error) {
    console.error("❌ Error actualizando agregados:", error);
    process.exit(1);
  }
}

updateAgregados();
