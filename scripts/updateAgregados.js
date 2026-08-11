const { Pool } = require("pg");

// El tope de la base son 60 conexiones. Un cron no necesita mas de 2:
// trabaja en serie y con 2 tiene margen si una se traba. Ver el incidente
// del 10 de agosto de 2026 en CLAUDE.md.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 15000
});
pool.on("error", (err) => console.error("Pool de PostgreSQL:", err.message));

// ============================================================
// Rangos de precios válidos (actualizados Abril 2026)
// Basados en análisis de percentiles p05–p99 sobre 30 días:
//   regular: p05=21.29  p99=24.99  → BETWEEN 21 AND 27
//   premium: p05=24.99  p99=29.99  → BETWEEN 23 AND 32
//   diesel:  p05=26.99  p99=30.35  → BETWEEN 25 AND 33
// ============================================================
const RANGE = {
  regular: { min: 21, max: 27 },
  premium: { min: 23, max: 32 },
  diesel:  { min: 25, max: 33 },
};

async function updateAgregados() {
  const client = await pool.connect();

  try {
    console.log("⛽ Actualizando precios agregados...");

    // ============================================================
    // 🛡️ PROTECCIÓN: Crear tablas si no existen
    // Evita que deploys de Strapi o reinicios rompan el sistema
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS precios_agregados (
        id             SERIAL PRIMARY KEY,
        market_type    VARCHAR(50)    NOT NULL,
        market_value   VARCHAR(100)   NOT NULL,
        days           INTEGER        NOT NULL,
        regular        NUMERIC(10,4),
        premium        NUMERIC(10,4),
        diesel         NUMERIC(10,4),
        min_regular    NUMERIC(10,4),
        max_regular    NUMERIC(10,4),
        std_regular    NUMERIC(10,4),
        min_premium    NUMERIC(10,4),
        max_premium    NUMERIC(10,4),
        std_premium    NUMERIC(10,4),
        min_diesel     NUMERIC(10,4),
        max_diesel     NUMERIC(10,4),
        std_diesel     NUMERIC(10,4),
        stations_count INTEGER,
        updated_at     TIMESTAMP DEFAULT NOW(),
        UNIQUE (market_type, market_value, days)
      )
    `);

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

    console.log("🛡️ Tablas verificadas/creadas");

    // Limpiar min/max corruptos antes de recalcular (outliers de versiones anteriores sin filtros)
    await client.query(`
      UPDATE precios_agregados SET
        min_regular = CASE WHEN min_regular < ${RANGE.regular.min} OR min_regular > ${RANGE.regular.max} THEN NULL ELSE min_regular END,
        max_regular = CASE WHEN max_regular < ${RANGE.regular.min} OR max_regular > ${RANGE.regular.max} THEN NULL ELSE max_regular END,
        min_premium = CASE WHEN min_premium < ${RANGE.premium.min} OR min_premium > ${RANGE.premium.max} THEN NULL ELSE min_premium END,
        max_premium = CASE WHEN max_premium < ${RANGE.premium.min} OR max_premium > ${RANGE.premium.max} THEN NULL ELSE max_premium END,
        min_diesel  = CASE WHEN min_diesel  < ${RANGE.diesel.min}  OR min_diesel  > ${RANGE.diesel.max}  THEN NULL ELSE min_diesel  END,
        max_diesel  = CASE WHEN max_diesel  < ${RANGE.diesel.min}  OR max_diesel  > ${RANGE.diesel.max}  THEN NULL ELSE max_diesel  END
      WHERE
        (min_regular IS NOT NULL AND (min_regular < ${RANGE.regular.min} OR min_regular > ${RANGE.regular.max}))
        OR (max_regular IS NOT NULL AND (max_regular < ${RANGE.regular.min} OR max_regular > ${RANGE.regular.max}))
        OR (min_premium IS NOT NULL AND (min_premium < ${RANGE.premium.min} OR min_premium > ${RANGE.premium.max}))
        OR (max_premium IS NOT NULL AND (max_premium < ${RANGE.premium.min} OR max_premium > ${RANGE.premium.max}))
        OR (min_diesel  IS NOT NULL AND (min_diesel  < ${RANGE.diesel.min}  OR min_diesel  > ${RANGE.diesel.max}))
        OR (max_diesel  IS NOT NULL AND (max_diesel  < ${RANGE.diesel.min}  OR max_diesel  > ${RANGE.diesel.max}))
    `);
    console.log("🧹 Min/max corruptos limpiados");

    // ============================================================
    // ⚡ CÁLCULO INCREMENTAL (8 Ago 2026)
    // Los precios entran a la base en un lote diario. Con 7 cortes al día,
    // recalcular las ventanas de 7 y 30 días en cada corte repite el mismo
    // resultado 7 veces: son las consultas pesadas (~3.4 GB y 30 s cada una,
    // porque recorren `prices` cruda).
    //
    // Regla: una ventana solo se recalcula si hay datos más nuevos que su
    // último cálculo. `days=1` se recalcula siempre (es ligera y captura los
    // precios que entran durante el día).
    //
    // Forzar recálculo completo:  FORZAR_RECALCULO=1 node scripts/updateAgregados.js
    // ============================================================
    const FORZAR = process.env.FORZAR_RECALCULO === "1";

    const ultimoLote = await client.query(`SELECT MAX(date) AS t FROM prices`);
    const tLote = ultimoLote.rows[0]?.t ? new Date(ultimoLote.rows[0].t).getTime() : 0;

    const calculados = await client.query(`
      SELECT days, MAX(updated_at) AS t
      FROM precios_agregados
      WHERE market_type = 'nacional'
      GROUP BY days
    `);
    const tCalculo = {};
    for (const r of calculados.rows) tCalculo[Number(r.days)] = r.t ? new Date(r.t).getTime() : 0;

    const daysList = [1, 7, 30].filter(days => {
      if (days === 1 || FORZAR) return true;
      const yaCalculado = tCalculo[days] || 0;
      // Si el último cálculo es posterior al último lote de datos, no hay nada nuevo que calcular.
      if (yaCalculado > tLote) {
        console.log(`⏭️  ${days} días: sin datos nuevos desde el último cálculo — se omite (ahorro de una consulta pesada)`);
        return false;
      }
      return true;
    });

    for (const days of daysList) {

      // days=1 usa el último día disponible en prices (evita problemas de zona horaria UTC vs México)
      const dateFilter = days === 1
        ? `p.date::date = (SELECT MAX(date::date) FROM prices)`
        : `p.date >= NOW() - INTERVAL '${days} days'`;

      // =========================
      // 🌎 NACIONAL
      // =========================
      const nacional = await client.query(`
        SELECT 
          AVG(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END)    AS regular,
          AVG(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END)    AS premium,
          AVG(CASE WHEN p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max}  THEN p.diesel  END)    AS diesel,

          MIN(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END)    AS min_regular,
          MAX(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END)    AS max_regular,
          STDDEV(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END) AS std_regular,

          MIN(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END)    AS min_premium,
          MAX(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END)    AS max_premium,
          STDDEV(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END) AS std_premium,

          MIN(CASE WHEN p.diesel BETWEEN ${RANGE.diesel.min} AND ${RANGE.diesel.max} THEN p.diesel END)        AS min_diesel,
          MAX(CASE WHEN p.diesel BETWEEN ${RANGE.diesel.min} AND ${RANGE.diesel.max} THEN p.diesel END)        AS max_diesel,
          STDDEV(CASE WHEN p.diesel BETWEEN ${RANGE.diesel.min} AND ${RANGE.diesel.max} THEN p.diesel END)     AS std_diesel,

          COUNT(DISTINCT CASE 
            WHEN (p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max})
              OR (p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max})
              OR (p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max})
            THEN l.gas_station_id
          END) AS stations_count

        FROM prices p
        JOIN prices_gas_station_links l ON l.price_id = p.id
        WHERE ${dateFilter}
      `);

      const n = nacional.rows[0];

      // Guardar saneado: si el min/max calculado cae fuera del rango válido, guardarlo como NULL
      const sanear = (val, min, max) => {
        const v = parseFloat(val);
        return (!isNaN(v) && v >= min && v <= max) ? v : null;
      };

      n.min_regular = sanear(n.min_regular, RANGE.regular.min, RANGE.regular.max);
      n.max_regular = sanear(n.max_regular, RANGE.regular.min, RANGE.regular.max);
      n.min_premium = sanear(n.min_premium, RANGE.premium.min, RANGE.premium.max);
      n.max_premium = sanear(n.max_premium, RANGE.premium.min, RANGE.premium.max);
      n.min_diesel  = sanear(n.min_diesel,  RANGE.diesel.min,  RANGE.diesel.max);
      n.max_diesel  = sanear(n.max_diesel,  RANGE.diesel.min,  RANGE.diesel.max);

      await client.query(`
        INSERT INTO precios_agregados (
          market_type, market_value, days,
          regular, premium, diesel, updated_at,
          min_regular, max_regular, std_regular,
          min_premium, max_premium, std_premium,
          min_diesel,  max_diesel,  std_diesel,
          stations_count
        )
        VALUES ('nacional', 'all', $1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (market_type, market_value, days)
        DO UPDATE SET
          regular        = EXCLUDED.regular,
          premium        = EXCLUDED.premium,
          diesel         = EXCLUDED.diesel,
          updated_at     = NOW(),
          min_regular    = EXCLUDED.min_regular,
          max_regular    = EXCLUDED.max_regular,
          std_regular    = EXCLUDED.std_regular,
          min_premium    = EXCLUDED.min_premium,
          max_premium    = EXCLUDED.max_premium,
          std_premium    = EXCLUDED.std_premium,
          min_diesel     = EXCLUDED.min_diesel,
          max_diesel     = EXCLUDED.max_diesel,
          std_diesel     = EXCLUDED.std_diesel,
          stations_count = EXCLUDED.stations_count;
      `, [
        days,
        n.regular, n.premium, n.diesel,
        n.min_regular, n.max_regular, n.std_regular,
        n.min_premium, n.max_premium, n.std_premium,
        n.min_diesel,  n.max_diesel,  n.std_diesel,
        n.stations_count
      ]);

      console.log(`✅ Nacional ${days} días actualizado — ${n.stations_count} estaciones`);

      // =========================
      // 🗺️ ESTADOS
      // =========================
      const estados = await client.query(`
        SELECT 
          gs.estado,

          AVG(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END)    AS regular,
          AVG(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END)    AS premium,
          AVG(CASE WHEN p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max}  THEN p.diesel  END)    AS diesel,

          MIN(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END)    AS min_regular,
          MAX(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END)    AS max_regular,
          STDDEV(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END) AS std_regular,

          MIN(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END)    AS min_premium,
          MAX(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END)    AS max_premium,
          STDDEV(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END) AS std_premium,

          MIN(CASE WHEN p.diesel BETWEEN ${RANGE.diesel.min} AND ${RANGE.diesel.max} THEN p.diesel END)        AS min_diesel,
          MAX(CASE WHEN p.diesel BETWEEN ${RANGE.diesel.min} AND ${RANGE.diesel.max} THEN p.diesel END)        AS max_diesel,
          STDDEV(CASE WHEN p.diesel BETWEEN ${RANGE.diesel.min} AND ${RANGE.diesel.max} THEN p.diesel END)     AS std_diesel,

          COUNT(DISTINCT CASE 
            WHEN (p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max})
              OR (p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max})
              OR (p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max})
            THEN l.gas_station_id
          END) AS stations_count

        FROM prices p
        JOIN prices_gas_station_links l ON l.price_id = p.id
        JOIN gas_stations gs ON gs.id = l.gas_station_id
        WHERE ${dateFilter}
        GROUP BY gs.estado
      `);

      for (const row of estados.rows) {
        row.min_regular = sanear(row.min_regular, RANGE.regular.min, RANGE.regular.max);
        row.max_regular = sanear(row.max_regular, RANGE.regular.min, RANGE.regular.max);
        row.min_premium = sanear(row.min_premium, RANGE.premium.min, RANGE.premium.max);
        row.max_premium = sanear(row.max_premium, RANGE.premium.min, RANGE.premium.max);
        row.min_diesel  = sanear(row.min_diesel,  RANGE.diesel.min,  RANGE.diesel.max);
        row.max_diesel  = sanear(row.max_diesel,  RANGE.diesel.min,  RANGE.diesel.max);

        await client.query(`
          INSERT INTO precios_agregados (
            market_type, market_value, days,
            regular, premium, diesel, updated_at,
            min_regular, max_regular, std_regular,
            min_premium, max_premium, std_premium,
            min_diesel,  max_diesel,  std_diesel,
            stations_count
          )
          VALUES ('estado', $1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          ON CONFLICT (market_type, market_value, days)
          DO UPDATE SET
            regular        = EXCLUDED.regular,
            premium        = EXCLUDED.premium,
            diesel         = EXCLUDED.diesel,
            updated_at     = NOW(),
            min_regular    = EXCLUDED.min_regular,
            max_regular    = EXCLUDED.max_regular,
            std_regular    = EXCLUDED.std_regular,
            min_premium    = EXCLUDED.min_premium,
            max_premium    = EXCLUDED.max_premium,
            std_premium    = EXCLUDED.std_premium,
            min_diesel     = EXCLUDED.min_diesel,
            max_diesel     = EXCLUDED.max_diesel,
            std_diesel     = EXCLUDED.std_diesel,
            stations_count = EXCLUDED.stations_count;
        `, [
          row.estado, days,
          row.regular, row.premium, row.diesel,
          row.min_regular, row.max_regular, row.std_regular,
          row.min_premium, row.max_premium, row.std_premium,
          row.min_diesel,  row.max_diesel,  row.std_diesel,
          row.stations_count
        ]);
      }

      console.log(`✅ ${estados.rows.length} estados actualizados para ${days} días`);

      // =========================
      // 🏙️🧭 MUNICIPIOS + ÁREAS GASGAS (una sola pasada)
      //
      // Son dos cortes distintos del mismo universo, así que se calculan con
      // GROUPING SETS en una sola lectura de `prices` en vez de dos. Con la
      // ventana de 30 días cada escaneo cuesta ~3.4 GB de egress: separarlos
      // duplicaría ese costo sin ganar nada.
      //
      //   market_value municipio = 'Estado|Municipio' (los nombres se repiten
      //   entre estados, ej. Juárez; la llave compuesta los distingue)
      //   market_value área      = clave 'I'..'VI' (ver tabla gasgas_areas)
      //
      // Los CASE de rango ya filtran outliers, no se requiere sanear().
      // =========================
      const mercados = await client.query(`
        INSERT INTO precios_agregados (
          market_type, market_value, days,
          regular, premium, diesel, updated_at,
          min_regular, max_regular, std_regular,
          min_premium, max_premium, std_premium,
          min_diesel,  max_diesel,  std_diesel,
          stations_count
        )
        SELECT
          CASE WHEN GROUPING(gs.municipio) = 1 THEN 'area' ELSE 'municipio' END,
          CASE WHEN GROUPING(gs.municipio) = 1 THEN gs.gasgas_area
               ELSE gs.estado || '|' || gs.municipio END,
          ${days},
          AVG(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END),
          AVG(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END),
          AVG(CASE WHEN p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max}  THEN p.diesel  END),
          NOW(),
          MIN(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END),
          MAX(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END),
          STDDEV(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END),
          MIN(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END),
          MAX(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END),
          STDDEV(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END),
          MIN(CASE WHEN p.diesel BETWEEN ${RANGE.diesel.min} AND ${RANGE.diesel.max} THEN p.diesel END),
          MAX(CASE WHEN p.diesel BETWEEN ${RANGE.diesel.min} AND ${RANGE.diesel.max} THEN p.diesel END),
          STDDEV(CASE WHEN p.diesel BETWEEN ${RANGE.diesel.min} AND ${RANGE.diesel.max} THEN p.diesel END),
          COUNT(DISTINCT CASE
            WHEN (p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max})
              OR (p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max})
              OR (p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max})
            THEN l.gas_station_id
          END)
        FROM prices p
        JOIN prices_gas_station_links l ON l.price_id = p.id
        JOIN gas_stations gs ON gs.id = l.gas_station_id
        WHERE ${dateFilter}
        GROUP BY GROUPING SETS ( (gs.estado, gs.municipio), (gs.gasgas_area) )
        HAVING
          -- municipios: descartar los que no traen plaza en el padrón
          ( GROUPING(gs.municipio) = 0
            AND gs.municipio IS NOT NULL AND gs.municipio <> '' )
          -- áreas: descartar estaciones aún sin área asignada
          OR ( GROUPING(gs.municipio) = 1 AND gs.gasgas_area IS NOT NULL )
        ON CONFLICT (market_type, market_value, days)
        DO UPDATE SET
          regular        = EXCLUDED.regular,
          premium        = EXCLUDED.premium,
          diesel         = EXCLUDED.diesel,
          updated_at     = NOW(),
          min_regular    = EXCLUDED.min_regular,
          max_regular    = EXCLUDED.max_regular,
          std_regular    = EXCLUDED.std_regular,
          min_premium    = EXCLUDED.min_premium,
          max_premium    = EXCLUDED.max_premium,
          std_premium    = EXCLUDED.std_premium,
          min_diesel     = EXCLUDED.min_diesel,
          max_diesel     = EXCLUDED.max_diesel,
          std_diesel     = EXCLUDED.std_diesel,
          stations_count = EXCLUDED.stations_count;
      `);

      console.log(`✅ ${mercados.rowCount} mercados actualizados para ${days} días (municipios + 6 Áreas GasGas)`);
    }

    console.log("🚀 Precios agregados completados sin NULLs");

  } catch (err) {
    console.error("❌ Error en updateAgregados:", err);
  } finally {
    client.release();
    process.exit();
  }
}

updateAgregados();
