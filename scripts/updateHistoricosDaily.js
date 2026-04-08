const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function updateHistoricosDaily() {
  const client = await pool.connect();

  try {
    console.log("📅 Insertando promedios diarios en históricos...");

    const today = new Date().toISOString().split("T")[0];
    console.log(`📆 Fecha a procesar: ${today}`);

    // =========================
    // 🌎 NACIONAL
    // =========================
    const nacional = await client.query(`
      SELECT
        AVG(CASE WHEN p.regular BETWEEN 20 AND 30 THEN p.regular END) AS regular,
        AVG(CASE WHEN p.premium BETWEEN 20 AND 35 THEN p.premium END) AS premium,
        AVG(CASE WHEN p.diesel  BETWEEN 20 AND 35 THEN p.diesel  END) AS diesel
      FROM prices p
      WHERE p.date::date = $1
    `, [today]);

    const n = nacional.rows[0];

    if (n.regular || n.premium || n.diesel) {
      await client.query(`
        INSERT INTO precios_historicos_agregados (
          market_type, market_value, date,
          regular, premium, diesel,
          updated_at, estado_slug
        )
        VALUES ('nacional', 'all', $1, $2, $3, $4, NOW(), 'all')
        ON CONFLICT (market_type, market_value, date)
        DO UPDATE SET
          regular    = EXCLUDED.regular,
          premium    = EXCLUDED.premium,
          diesel     = EXCLUDED.diesel,
          updated_at = NOW();
      `, [today, n.regular, n.premium, n.diesel]);

      console.log(`✅ Nacional insertado para ${today}`);
    } else {
      console.log(`⚠️ Sin datos nacionales para ${today}`);
    }

    // =========================
    // 🗺️ ESTADOS
    // =========================
    const estados = await client.query(`
      SELECT
        gs.estado,
        gs.estado_slug,
        AVG(CASE WHEN p.regular BETWEEN 20 AND 30 THEN p.regular END) AS regular,
        AVG(CASE WHEN p.premium BETWEEN 20 AND 35 THEN p.premium END) AS premium,
        AVG(CASE WHEN p.diesel  BETWEEN 20 AND 35 THEN p.diesel  END) AS diesel
      FROM prices p
      JOIN prices_gas_station_links l ON l.price_id = p.id
      JOIN gas_stations gs ON gs.id = l.gas_station_id
      WHERE p.date::date = $1
      GROUP BY gs.estado, gs.estado_slug
    `, [today]);

    let insertados = 0;

    for (const row of estados.rows) {
      if (!row.regular && !row.premium && !row.diesel) continue;

      await client.query(`
        INSERT INTO precios_historicos_agregados (
          market_type, market_value, date,
          regular, premium, diesel,
          updated_at, estado_slug
        )
        VALUES ('estado', $1, $2, $3, $4, $5, NOW(), $6)
        ON CONFLICT (market_type, market_value, date)
        DO UPDATE SET
          regular    = EXCLUDED.regular,
          premium    = EXCLUDED.premium,
          diesel     = EXCLUDED.diesel,
          updated_at = NOW();
      `, [
        row.estado, today,
        row.regular, row.premium, row.diesel,
        row.estado_slug
      ]);

      insertados++;
    }

    console.log(`✅ ${insertados} estados insertados para ${today}`);
    console.log("🚀 Históricos diarios completados");

  } catch (err) {
    console.error("❌ Error en updateHistoricosDaily:", err);
  } finally {
    client.release();
    process.exit();
  }
}

updateHistoricosDaily();
