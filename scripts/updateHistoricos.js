const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function updateHistoricos() {
  const client = await pool.connect();

  try {
    console.log("📈 Actualizando históricos...");

    // 🔥 LIMPIEZA
    await client.query(`
      DELETE FROM precios_historicos_agregados
      WHERE market_type = 'nacional'
      AND market_value = 'México';
    `);

    // =========================
    // 🌎 NACIONAL (ALL)
    // =========================
    const historico = await client.query(`
      SELECT 
        DATE(p.date) as date,

        AVG(CASE WHEN p.regular BETWEEN 20 AND 30 THEN p.regular END) AS regular,
        AVG(CASE WHEN p.premium BETWEEN 20 AND 35 THEN p.premium END) AS premium,
        AVG(CASE WHEN p.diesel BETWEEN 20 AND 35 THEN p.diesel END) AS diesel

      FROM prices p
      WHERE p.date >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(p.date)
      ORDER BY date
    `);

    for (const row of historico.rows) {
      await client.query(`
        INSERT INTO precios_historicos_agregados (
          market_type,
          market_value,
          date,
          regular,
          premium,
          diesel,
          updated_at
        )
        VALUES ('nacional', 'all', $1, $2, $3, $4, NOW())
        ON CONFLICT (market_type, market_value, date)
        DO UPDATE SET
          regular = EXCLUDED.regular,
          premium = EXCLUDED.premium,
          diesel = EXCLUDED.diesel,
          updated_at = NOW();
      `, [
        row.date,
        row.regular,
        row.premium,
        row.diesel
      ]);
    }

    // =========================
    // 🗺️ ESTADOS
    // =========================
    const estados = await client.query(`
      SELECT 
        gs.estado,
        DATE(p.date) as date,

        AVG(CASE WHEN p.regular BETWEEN 20 AND 30 THEN p.regular END) AS regular,
        AVG(CASE WHEN p.premium BETWEEN 20 AND 35 THEN p.premium END) AS premium,
        AVG(CASE WHEN p.diesel BETWEEN 20 AND 35 THEN p.diesel END) AS diesel

      FROM prices p
      JOIN prices_gas_station_links l ON l.price_id = p.id
      JOIN gas_stations gs ON gs.id = l.gas_station_id
      WHERE p.date >= NOW() - INTERVAL '30 days'
      GROUP BY gs.estado, DATE(p.date)
      ORDER BY date
    `);

    for (const row of estados.rows) {
      await client.query(`
        INSERT INTO precios_historicos_agregados (
          market_type,
          market_value,
          date,
          regular,
          premium,
          diesel,
          updated_at
        )
        VALUES ('estado', $1, $2, $3, $4, $5, NOW())
        ON CONFLICT (market_type, market_value, date)
        DO UPDATE SET
          regular = EXCLUDED.regular,
          premium = EXCLUDED.premium,
          diesel = EXCLUDED.diesel,
          updated_at = NOW();
      `, [
        row.estado,
        row.date,
        row.regular,
        row.premium,
        row.diesel
      ]);
    }

    console.log("✅ Históricos actualizados correctamente");

  } catch (err) {
    console.error("❌ Error en updateHistoricos:", err);
  } finally {
    client.release();
    process.exit();
  }
}

updateHistoricos();
