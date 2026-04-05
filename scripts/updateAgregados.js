const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function updateAgregados() {
  try {
    console.log("🚀 Iniciando actualización de agregados...");

    // 🧹 Limpiar estados previos
    await pool.query(`
      DELETE FROM precios_agregados WHERE market_type = 'estado';
    `);

    console.log("🧹 Datos anteriores eliminados");

    // 🔥 Insertar nuevos agregados
    await pool.query(`
      INSERT INTO precios_agregados (market_type, market_value, days, regular, premium, diesel, updated_at)

      SELECT
          'estado' as market_type,
          gs.estado as market_value,
          30 as days,

          AVG(est.regular_avg) as regular,
          AVG(est.premium_avg) as premium,
          AVG(est.diesel_avg) as diesel,

          NOW() as updated_at

      FROM (

          SELECT
              psl.gas_station_id,
              AVG(p.regular) as regular_avg,
              AVG(p.premium) as premium_avg,
              AVG(p.diesel) as diesel_avg

          FROM prices p
          JOIN prices_gas_station_links psl
              ON p.id = psl.price_id

          WHERE p.date >= CURRENT_DATE - INTERVAL '30 days'

          GROUP BY psl.gas_station_id

      ) est

      JOIN gas_stations gs
          ON est.gas_station_id = gs.id

      GROUP BY gs.estado;
    `);

    console.log("✅ Agregados actualizados correctamente");

    process.exit(0);

  } catch (error) {
    console.error("❌ Error actualizando agregados:", error);
    process.exit(1);
  }
}

updateAgregados();
