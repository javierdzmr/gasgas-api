const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Mismos rangos que updateAgregados.js
const RANGE = {
  regular: { min: 21, max: 27 },
  premium: { min: 23, max: 32 },
  diesel:  { min: 25, max: 33 },
};

async function updateHistoricosDaily() {
  const client = await pool.connect();

  try {
    console.log("📅 Insertando promedios diarios en históricos...");

    // ============================================================
    // 🛡️ PROTECCIÓN: Crear tabla si no existe
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS precios_historicos_agregados (
        id           SERIAL PRIMARY KEY,
        market_type  VARCHAR(50),
        market_value VARCHAR(100),
        date         DATE,
        regular      NUMERIC(10,4),
        premium      NUMERIC(10,4),
        diesel       NUMERIC(10,4),
        estado_slug  VARCHAR(100),
        updated_at   TIMESTAMP DEFAULT NOW(),
        UNIQUE (market_type, market_value, date)
      )
    `);
    console.log("🛡️ Tabla verificada/creada");

    // ============================================================
    // 🔄 REPOBLACIÓN AUTOMÁTICA: Si la tabla está vacía o tiene
    // menos de 10 registros, repoblar los últimos 30 días
    // ============================================================
    const countResult = await client.query(`SELECT COUNT(*) FROM precios_historicos_agregados`);
    const totalRows = parseInt(countResult.rows[0].count);

    if (totalRows < 10) {
      console.log(`⚠️ Tabla con solo ${totalRows} registros — repoblando últimos 30 días...`);

      // Nacional — 30 días
      await client.query(`
        INSERT INTO precios_historicos_agregados (market_type, market_value, date, regular, premium, diesel, estado_slug, updated_at)
        SELECT
          'nacional',
          'all',
          p.date::date AS date,
          AVG(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END) AS regular,
          AVG(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END) AS premium,
          AVG(CASE WHEN p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max}  THEN p.diesel  END) AS diesel,
          'all',
          NOW()
        FROM prices p
        WHERE p.date >= NOW() - INTERVAL '30 days'
        GROUP BY p.date::date
        ON CONFLICT (market_type, market_value, date) DO UPDATE SET
          regular    = EXCLUDED.regular,
          premium    = EXCLUDED.premium,
          diesel     = EXCLUDED.diesel,
          updated_at = NOW()
      `);
      console.log("✅ Nacional repoblado — 30 días");

      // Estados — 30 días
      await client.query(`
        INSERT INTO precios_historicos_agregados (market_type, market_value, date, regular, premium, diesel, estado_slug, updated_at)
        SELECT
          'estado',
          gs.estado,
          p.date::date AS date,
          AVG(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END) AS regular,
          AVG(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END) AS premium,
          AVG(CASE WHEN p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max}  THEN p.diesel  END) AS diesel,
          LOWER(REGEXP_REPLACE(TRANSLATE(gs.estado, 'áéíóúÁÉÍÓÚüÜñÑ', 'aeiouAEIOUuUnN'), '[^a-zA-Z0-9]+', '-', 'g')),
          NOW()
        FROM prices p
        JOIN prices_gas_station_links l ON l.price_id = p.id
        JOIN gas_stations gs ON gs.id = l.gas_station_id
        WHERE p.date >= NOW() - INTERVAL '30 days'
        GROUP BY gs.estado, p.date::date
        ON CONFLICT (market_type, market_value, date) DO UPDATE SET
          regular     = EXCLUDED.regular,
          premium     = EXCLUDED.premium,
          diesel      = EXCLUDED.diesel,
          estado_slug = EXCLUDED.estado_slug,
          updated_at  = NOW()
      `);
      console.log("✅ 32 estados repoblados — 30 días");

      // Municipios — 30 días (market_value = 'Estado|Municipio')
      await client.query(`
        INSERT INTO precios_historicos_agregados (market_type, market_value, date, regular, premium, diesel, estado_slug, updated_at)
        SELECT
          'municipio',
          gs.estado || '|' || gs.municipio,
          p.date::date AS date,
          AVG(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END) AS regular,
          AVG(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END) AS premium,
          AVG(CASE WHEN p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max}  THEN p.diesel  END) AS diesel,
          LOWER(REGEXP_REPLACE(TRANSLATE(gs.estado, 'áéíóúÁÉÍÓÚüÜñÑ', 'aeiouAEIOUuUnN'), '[^a-zA-Z0-9]+', '-', 'g')),
          NOW()
        FROM prices p
        JOIN prices_gas_station_links l ON l.price_id = p.id
        JOIN gas_stations gs ON gs.id = l.gas_station_id
        WHERE p.date >= NOW() - INTERVAL '30 days'
          AND gs.municipio IS NOT NULL AND gs.municipio <> ''
        GROUP BY gs.estado, gs.municipio, p.date::date
        ON CONFLICT (market_type, market_value, date) DO UPDATE SET
          regular     = EXCLUDED.regular,
          premium     = EXCLUDED.premium,
          diesel      = EXCLUDED.diesel,
          estado_slug = EXCLUDED.estado_slug,
          updated_at  = NOW()
      `);
      console.log("✅ Municipios repoblados — 30 días");
    }

    // ============================================================
    // 📅 INSERCIÓN DIARIA NORMAL
    // ============================================================
    const today = new Date().toISOString().split("T")[0];
    console.log(`📆 Fecha a procesar: ${today}`);

    // =========================
    // 🌎 NACIONAL
    // =========================
    const nacional = await client.query(`
      SELECT
        AVG(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END) AS regular,
        AVG(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END) AS premium,
        AVG(CASE WHEN p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max}  THEN p.diesel  END) AS diesel
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
        LOWER(REGEXP_REPLACE(TRANSLATE(gs.estado, 'áéíóúÁÉÍÓÚüÜñÑ', 'aeiouAEIOUuUnN'), '[^a-zA-Z0-9]+', '-', 'g')) AS estado_slug,
        AVG(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END) AS regular,
        AVG(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END) AS premium,
        AVG(CASE WHEN p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max}  THEN p.diesel  END) AS diesel
      FROM prices p
      JOIN prices_gas_station_links l ON l.price_id = p.id
      JOIN gas_stations gs ON gs.id = l.gas_station_id
      WHERE p.date::date = $1
      GROUP BY gs.estado
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

    // =========================
    // 🏙️ MUNICIPIOS (set-based, ~3,000 mercados en un solo INSERT)
    // =========================
    const municipios = await client.query(`
      INSERT INTO precios_historicos_agregados (market_type, market_value, date, regular, premium, diesel, estado_slug, updated_at)
      SELECT
        'municipio',
        gs.estado || '|' || gs.municipio,
        p.date::date,
        AVG(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END),
        AVG(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END),
        AVG(CASE WHEN p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max}  THEN p.diesel  END),
        LOWER(REGEXP_REPLACE(TRANSLATE(gs.estado, 'áéíóúÁÉÍÓÚüÜñÑ', 'aeiouAEIOUuUnN'), '[^a-zA-Z0-9]+', '-', 'g')),
        NOW()
      FROM prices p
      JOIN prices_gas_station_links l ON l.price_id = p.id
      JOIN gas_stations gs ON gs.id = l.gas_station_id
      WHERE p.date::date = $1
        AND gs.municipio IS NOT NULL AND gs.municipio <> ''
      GROUP BY gs.estado, gs.municipio, p.date::date
      ON CONFLICT (market_type, market_value, date) DO UPDATE SET
        regular     = EXCLUDED.regular,
        premium     = EXCLUDED.premium,
        diesel      = EXCLUDED.diesel,
        estado_slug = EXCLUDED.estado_slug,
        updated_at  = NOW()
    `, [today]);

    console.log(`✅ ${municipios.rowCount} municipios insertados para ${today}`);
    console.log("🚀 Históricos diarios completados");

  } catch (err) {
    console.error("❌ Error en updateHistoricosDaily:", err);
  } finally {
    client.release();
    process.exit();
  }
}

updateHistoricosDaily();