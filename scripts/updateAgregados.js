const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function updateAgregados() {
  const client = await pool.connect();

  try {
    console.log("⛽ Actualizando precios agregados...");

    // 🔥 LIMPIEZA
    await client.query(`
      DELETE FROM precios_agregados
      WHERE market_type = 'nacional'
      AND market_value = 'México';
    `);

    const daysList = [7, 30];

    for (const days of daysList) {

      // =========================
      // 🌎 NACIONAL (ALL)
      // =========================
      const nacional = await client.query(`
        SELECT 
          AVG(p.regular) AS regular,
          AVG(p.premium) AS premium,
          AVG(p.diesel) AS diesel,
          MIN(p.regular) AS min_regular,
          MAX(p.regular) AS max_regular,
          STDDEV(p.regular) AS std_regular,
          COUNT(DISTINCT l.gas_station_id) AS stations_count
        FROM prices p
        JOIN prices_gas_station_links l ON l.price_id = p.id
        WHERE p.date >= NOW() - INTERVAL '${days} days'
      `);

      const n = nacional.rows[0];

      await client.query(`
        INSERT INTO precios_agregados (
          market_type,
          market_value,
          days,
          regular,
          premium,
          diesel,
          updated_at,
          min_regular,
          max_regular,
          std_regular,
          stations_count
        )
        VALUES ('nacional', 'all', $1, $2, $3, $4, NOW(), $5, $6, $7, $8)
        ON CONFLICT (market_type, market_value, days)
        DO UPDATE SET
          regular = EXCLUDED.regular,
          premium = EXCLUDED.premium,
          diesel = EXCLUDED.diesel,
          updated_at = NOW(),
          min_regular = EXCLUDED.min_regular,
          max_regular = EXCLUDED.max_regular,
          std_regular = EXCLUDED.std_regular,
          stations_count = EXCLUDED.stations_count;
      `, [
        days,
        n.regular,
        n.premium,
        n.diesel,
        n.min_regular,
        n.max_regular,
        n.std_regular,
        n.stations_count
      ]);

      // =========================
      // 🗺️ ESTADOS
      // =========================
      const estados = await client.query(`
        SELECT 
          gs.estado,
          AVG(p.regular) AS regular,
          AVG(p.premium) AS premium,
          AVG(p.diesel) AS diesel,
          COUNT(DISTINCT l.gas_station_id) AS stations_count
        FROM prices p
        JOIN prices_gas_station_links l ON l.price_id = p.id
        JOIN gas_stations gs ON gs.id = l.gas_station_id
        WHERE p.date >= NOW() - INTERVAL '${days} days'
        GROUP BY gs.estado
      `);

      for (const row of estados.rows) {
        await client.query(`
          INSERT INTO precios_agregados (
            market_type,
            market_value,
            days,
            regular,
            premium,
            diesel,
            updated_at,
            stations_count
          )
          VALUES ('estado', $1, $2, $3, $4, $5, NOW(), $6)
          ON CONFLICT (market_type, market_value, days)
          DO UPDATE SET
            regular = EXCLUDED.regular,
            premium = EXCLUDED.premium,
            diesel = EXCLUDED.diesel,
            updated_at = NOW(),
            stations_count = EXCLUDED.stations_count;
        `, [
          row.estado,
          days,
          row.regular,
          row.premium,
          row.diesel,
          row.stations_count
        ]);
      }

    }

    console.log("✅ Precios agregados actualizados correctamente");

  } catch (err) {
    console.error("❌ Error en updateAgregados:", err);
  } finally {
    client.release();
    process.exit();
  }
}

updateAgregados();
