const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function updateStats(days) {

  console.log(`🔥 Calculando stats para ${days} días...`);

  // ==============================
  // 🔹 ESTADOS
  // ==============================
  const estados = await pool.query(`
    SELECT DISTINCT estado FROM gas_stations
  `);

  for (const row of estados.rows) {

    const estado = row.estado;

    const stats = await pool.query(`
      SELECT 
        MIN(p.regular) AS min_regular,
        MAX(p.regular) AS max_regular,
        STDDEV(p.regular) AS std_regular,

        MIN(p.premium) AS min_premium,
        MAX(p.premium) AS max_premium,
        STDDEV(p.premium) AS std_premium,

        MIN(p.diesel) AS min_diesel,
        MAX(p.diesel) AS max_diesel,
        STDDEV(p.diesel) AS std_diesel

      FROM prices p
      JOIN prices_gas_station_links l ON l.price_id = p.id
      JOIN gas_stations g ON g.id = l.gas_station_id

      WHERE LOWER(g.estado) = LOWER($1)
      AND p.date >= NOW() - INTERVAL '${days} days'
    `, [estado]);

    const s = stats.rows[0];

    await pool.query(`
      UPDATE precios_agregados
      SET 
        min_regular = $1,
        max_regular = $2,
        std_regular = $3,

        min_premium = $4,
        max_premium = $5,
        std_premium = $6,

        min_diesel = $7,
        max_diesel = $8,
        std_diesel = $9

      WHERE market_type = 'estado'
      AND LOWER(market_value) = LOWER($10)
      AND days = $11
    `, [
      s.min_regular, s.max_regular, s.std_regular,
      s.min_premium, s.max_premium, s.std_premium,
      s.min_diesel, s.max_diesel, s.std_diesel,
      estado, days
    ]);

    console.log(`✅ Stats actualizados: ${estado}`);
  }

  // ==============================
  // 🔹 NACIONAL
  // ==============================
  const nacional = await pool.query(`
    SELECT 
      MIN(regular) AS min_regular,
      MAX(regular) AS max_regular,
      STDDEV(regular) AS std_regular,

      MIN(premium) AS min_premium,
      MAX(premium) AS max_premium,
      STDDEV(premium) AS std_premium,

      MIN(diesel) AS min_diesel,
      MAX(diesel) AS max_diesel,
      STDDEV(diesel) AS std_diesel

    FROM prices
    WHERE date >= NOW() - INTERVAL '${days} days'
  `);

  const n = nacional.rows[0];

  await pool.query(`
    UPDATE precios_agregados
    SET 
      min_regular = $1,
      max_regular = $2,
      std_regular = $3,

      min_premium = $4,
      max_premium = $5,
      std_premium = $6,

      min_diesel = $7,
      max_diesel = $8,
      std_diesel = $9

    WHERE market_type = 'nacional'
    AND market_value = 'all'
    AND days = $10
  `, [
    n.min_regular, n.max_regular, n.std_regular,
    n.min_premium, n.max_premium, n.std_premium,
    n.min_diesel, n.max_diesel, n.std_diesel,
    days
  ]);

  console.log(`🇲🇽 Stats nacional actualizados`);
}


// ==============================
// 🚀 EJECUCIÓN
// ==============================
(async () => {
  try {
    await updateStats(7);
    await updateStats(30);

    console.log("🚀 Stats completados");
    process.exit(0);

  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
