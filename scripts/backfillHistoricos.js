/**
 * backfillHistoricos.js
 *
 * Rellena precios_historicos_agregados hacia atrás hasta donde alcance `prices`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * POR QUÉ
 *
 * updateHistoricosDaily.js solo escribe el día que corre. La tabla se creó en
 * abril de 2026, así que el histórico agregado empezaba ahí — aunque `prices`
 * tiene datos desde el 1 de mayo de 2024 (861 días con dato de 864 posibles,
 * 99.7% de cobertura).
 *
 * Eso bastaba para las gráficas de 7 y 30 días, pero no para la página de
 * reporte semanal, que compara cada corte contra el de hace un año y hace dos.
 * Sin este relleno esas dos columnas no existen.
 *
 * QUÉ CUESTA
 *
 * Las tres tablas que se recorren pesan ~1.4 GB juntas (prices 824 MB,
 * prices_gas_station_links 555 MB, gas_stations 5.7 MB). Se recorren UNA vez,
 * por tramos mensuales apoyados en prices_date_idx. Es del orden de una sola
 * corrida del agregado de 30 días, no de las 143 GB/día que costaba el cron
 * antes de volverse incremental. Ver el incidente del 10 de agosto en CLAUDE.md.
 *
 * QUÉ NO HACE
 *
 * No rellena municipios a propósito: son ~2,900 mercados por 861 días
 * (2.5 millones de filas) y la página pública no publica ese nivel. Si algún
 * día se necesita, correr con NIVELES=municipio y tramos más chicos.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Uso:
 *   DATABASE_URL='postgresql://...' DRY_RUN=1 node scripts/backfillHistoricos.js
 *   DATABASE_URL='postgresql://...' node scripts/backfillHistoricos.js
 *
 * Variables:
 *   DATABASE_URL  (obligatoria) la misma del cron update-precios-agregados.
 *                 Usar el puerto 5432 (modo sesión), no el 6543.
 *   DESDE         (default 2024-05-01) primer día a rellenar
 *   HASTA         (default hoy) último día
 *   NIVELES       (default nacional,area,estado) cuáles rellenar
 *   TRAMO_DIAS    (default 30) tamaño del tramo
 *   DRY_RUN       =1 cuenta lo que escribiría y no escribe
 *
 * Es idempotente: usa ON CONFLICT DO UPDATE, así que se puede volver a correr
 * sin duplicar. Un tramo que falle se puede reintentar solo con DESDE/HASTA.
 */

const { Pool } = require("pg");
const { RANGE } = require("./rangosPrecios");

// ── Validación temprana de la cadena de conexión ────────────────────────────
// Sin esto, pegar un marcador de posición ('...', 'PEGA_AQUI') truena 40 líneas
// después con un error que no dice qué pasó.
const URL = (process.env.DATABASE_URL || "").trim();
if (!URL) {
  console.error("Falta DATABASE_URL.");
  console.error("Cópiala de Render > cron update-precios-agregados > Environment.");
  process.exit(1);
}
if (!/^postgres(ql)?:\/\/\S+:\S+@\S+\/\S+/.test(URL)) {
  console.error("DATABASE_URL no tiene forma de cadena de conexión.");
  console.error("Debe verse así: postgresql://usuario:contrasena@host:5432/postgres");
  console.error(`Llegó algo de ${URL.length} caracteres que no cuadra.`);
  process.exit(1);
}
if (/:6543\//.test(URL)) {
  console.warn("⚠️  Estás usando el puerto 6543 (modo transacción).");
  console.warn("⚠️  Para un trabajo largo conviene el 5432 (modo sesión).");
}

const DESDE = process.env.DESDE || "2024-05-01";
const HASTA = process.env.HASTA || new Date().toISOString().slice(0, 10);
const TRAMO_DIAS = Number(process.env.TRAMO_DIAS) || 30;
const DRY_RUN = process.env.DRY_RUN === "1";
const NIVELES = (process.env.NIVELES || "nacional,area,estado")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const VALIDOS = ["nacional", "area", "estado", "municipio"];
const malos = NIVELES.filter((n) => !VALIDOS.includes(n));
if (malos.length) {
  console.error(`NIVELES desconocidos: ${malos.join(", ")}`);
  console.error(`Válidos: ${VALIDOS.join(", ")}`);
  process.exit(1);
}

const pool = new Pool({
  connectionString: URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000
});
pool.on("error", (err) => console.error("Pool de PostgreSQL:", err.message));

// El slug de estado se calcula IGUAL que en updateHistoricosDaily.js. Si las
// dos fórmulas divergen, la serie queda partida en dos a media gráfica.
const SLUG_ESTADO =
  "LOWER(REGEXP_REPLACE(TRANSLATE(gs.estado, 'áéíóúÁÉÍÓÚüÜñÑ', " +
  "'aeiouAEIOUuUnN'), '[^a-zA-Z0-9]+', '-', 'g'))";

const PROMEDIOS = `
  AVG(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max} THEN p.regular END),
  AVG(CASE WHEN p.premium BETWEEN ${RANGE.premium.min} AND ${RANGE.premium.max} THEN p.premium END),
  AVG(CASE WHEN p.diesel  BETWEEN ${RANGE.diesel.min}  AND ${RANGE.diesel.max}  THEN p.diesel  END)`;

const AL_CHOCAR = `
  ON CONFLICT (market_type, market_value, date) DO UPDATE SET
    regular     = EXCLUDED.regular,
    premium     = EXCLUDED.premium,
    diesel      = EXCLUDED.diesel,
    estado_slug = EXCLUDED.estado_slug,
    updated_at  = NOW()`;

const COLUMNAS = `(market_type, market_value, date, regular, premium, diesel, estado_slug, updated_at)`;

/** Cada nivel es el mismo INSERT cambiando cómo se agrupa. */
const CONSULTAS = {
  nacional: `
    INSERT INTO precios_historicos_agregados ${COLUMNAS}
    SELECT 'nacional', 'all', p.date::date, ${PROMEDIOS}, 'all', NOW()
    FROM prices p
    WHERE p.date >= $1::date AND p.date < $2::date
    GROUP BY p.date::date
    ${AL_CHOCAR}`,

  estado: `
    INSERT INTO precios_historicos_agregados ${COLUMNAS}
    SELECT 'estado', gs.estado, p.date::date, ${PROMEDIOS}, ${SLUG_ESTADO}, NOW()
    FROM prices p
    JOIN prices_gas_station_links l ON l.price_id = p.id
    JOIN gas_stations gs ON gs.id = l.gas_station_id
    WHERE p.date >= $1::date AND p.date < $2::date
      AND gs.estado IS NOT NULL AND gs.estado <> ''
    GROUP BY gs.estado, p.date::date
    ${AL_CHOCAR}`,

  area: `
    INSERT INTO precios_historicos_agregados ${COLUMNAS}
    SELECT 'area', gs.gasgas_area, p.date::date, ${PROMEDIOS},
           'area-' || LOWER(gs.gasgas_area), NOW()
    FROM prices p
    JOIN prices_gas_station_links l ON l.price_id = p.id
    JOIN gas_stations gs ON gs.id = l.gas_station_id
    WHERE p.date >= $1::date AND p.date < $2::date
      AND gs.gasgas_area IS NOT NULL
    GROUP BY gs.gasgas_area, p.date::date
    ${AL_CHOCAR}`,

  municipio: `
    INSERT INTO precios_historicos_agregados ${COLUMNAS}
    SELECT 'municipio', gs.estado || '|' || gs.municipio, p.date::date, ${PROMEDIOS},
           ${SLUG_ESTADO}, NOW()
    FROM prices p
    JOIN prices_gas_station_links l ON l.price_id = p.id
    JOIN gas_stations gs ON gs.id = l.gas_station_id
    WHERE p.date >= $1::date AND p.date < $2::date
      AND gs.municipio IS NOT NULL AND gs.municipio <> ''
    GROUP BY gs.estado, gs.municipio, p.date::date
    ${AL_CHOCAR}`
};

/** En simulacro no se escribe: se cuenta cuántas filas saldrían. */
const CONTEOS = {
  nacional: `SELECT COUNT(*) AS n FROM (SELECT p.date::date FROM prices p
    WHERE p.date >= $1::date AND p.date < $2::date GROUP BY p.date::date) t`,
  estado: `SELECT COUNT(*) AS n FROM (SELECT gs.estado, p.date::date FROM prices p
    JOIN prices_gas_station_links l ON l.price_id = p.id
    JOIN gas_stations gs ON gs.id = l.gas_station_id
    WHERE p.date >= $1::date AND p.date < $2::date AND gs.estado IS NOT NULL AND gs.estado <> ''
    GROUP BY gs.estado, p.date::date) t`,
  area: `SELECT COUNT(*) AS n FROM (SELECT gs.gasgas_area, p.date::date FROM prices p
    JOIN prices_gas_station_links l ON l.price_id = p.id
    JOIN gas_stations gs ON gs.id = l.gas_station_id
    WHERE p.date >= $1::date AND p.date < $2::date AND gs.gasgas_area IS NOT NULL
    GROUP BY gs.gasgas_area, p.date::date) t`,
  municipio: `SELECT COUNT(*) AS n FROM (SELECT gs.estado, gs.municipio, p.date::date FROM prices p
    JOIN prices_gas_station_links l ON l.price_id = p.id
    JOIN gas_stations gs ON gs.id = l.gas_station_id
    WHERE p.date >= $1::date AND p.date < $2::date AND gs.municipio IS NOT NULL AND gs.municipio <> ''
    GROUP BY gs.estado, gs.municipio, p.date::date) t`
};

/**
 * AUDITORÍA — no quitar.
 *
 * Compara CADA fila guardada contra un recálculo fresco. Existe por un error
 * real del 11 de septiembre de 2026:
 *
 * Se rellenó el histórico hacia atrás pero se cortó el nivel `nacional` en la
 * fecha donde la tabla "ya tenía datos", dando por hecho que esas filas estaban
 * bien. No lo estaban: las había escrito el cron con el rango viejo (piso de
 * regular en 21). Ese piso tira los precios de la frontera norte, así que el
 * promedio nacional salía ~0.17 más alto.
 *
 * Resultado: un escalón falso de +0.17 el 4 de mayo en la gráfica pública, y
 * un titular de "bajó 17 centavos esta semana" que era puro artefacto.
 *
 * Lo detectó J a simple vista, con el mejor argumento posible: el nacional
 * brincaba y NINGUNA de las seis áreas brincaba. Un promedio del país no puede
 * moverse sin que se mueva alguna de sus partes. Esa invariante vale como
 * prueba y por eso también se revisa aquí.
 *
 * Moraleja: al rellenar, NUNCA asumir que lo que ya estaba es correcto.
 * Recalcular el rango completo y comprobar.
 */
async function auditar(client) {
  console.log("\nAuditoría — cada fila guardada contra un recálculo fresco:");
  let problemas = 0;

  for (const nivel of NIVELES) {
    if (nivel === "municipio") continue; // demasiadas filas para auditar en línea
    const agrupa = {
      nacional: { sel: "'nacional', 'all'", from: "FROM prices p", grp: "p.date::date" },
      estado: {
        sel: "'estado', gs.estado",
        from: `FROM prices p JOIN prices_gas_station_links l ON l.price_id = p.id
               JOIN gas_stations gs ON gs.id = l.gas_station_id`,
        grp: "gs.estado, p.date::date"
      },
      area: {
        sel: "'area', gs.gasgas_area",
        from: `FROM prices p JOIN prices_gas_station_links l ON l.price_id = p.id
               JOIN gas_stations gs ON gs.id = l.gas_station_id`,
        grp: "gs.gasgas_area, p.date::date"
      }
    }[nivel];

    const { rows } = await client.query(`
      WITH r AS (
        SELECT ${agrupa.sel} AS mv_sel, p.date::date AS d,
               AVG(CASE WHEN p.regular BETWEEN ${RANGE.regular.min} AND ${RANGE.regular.max}
                        THEN p.regular END) AS reg
        ${agrupa.from}
        WHERE p.date >= $1::date AND p.date <= $2::date
        GROUP BY ${agrupa.grp}
      )
      SELECT COUNT(*) AS revisadas,
             COUNT(*) FILTER (WHERE ABS(COALESCE(h.regular,0) - COALESCE(r.reg,0)) > 0.005) AS malas,
             COALESCE(ROUND(MAX(ABS(COALESCE(h.regular,0) - COALESCE(r.reg,0)))::numeric, 4), 0) AS peor,
             MAX(h.date) FILTER (WHERE ABS(COALESCE(h.regular,0) - COALESCE(r.reg,0)) > 0.005)::text AS peor_dia
      FROM precios_historicos_agregados h
      JOIN r ON r.mv_sel = h.market_value AND r.d = h.date
      WHERE h.market_type = $3`, [DESDE, HASTA, nivel]);

    const a = rows[0];
    const malas = Number(a.malas);
    // El día en curso casi siempre difiere: siguen entrando precios mientras
    // corre el script. No cuenta como problema.
    const soloHoy = malas > 0 && a.peor_dia === new Date().toISOString().slice(0, 10);
    const marca = malas === 0 ? "ok  " : (soloHoy ? "ok* " : "MAL ");
    if (malas > 0 && !soloHoy) problemas++;
    console.log(`  ${marca} ${nivel.padEnd(10)} ${Number(a.revisadas).toLocaleString("es-MX")} filas · ` +
      `${malas} desajustadas` + (malas ? ` · peor ${a.peor} el ${a.peor_dia}` : "") +
      (soloHoy ? "  (solo el día en curso, normal)" : ""));
  }

  if (problemas) {
    console.error(`\n⚠️  ${problemas} nivel(es) con filas que NO coinciden con el recálculo.`);
    console.error("   Casi siempre significa que quedaron filas viejas calculadas con otro");
    console.error("   rango de precios. Vuelve a correr cubriendo TODO el periodo, sin cortar");
    console.error("   en la fecha donde la tabla 'ya tenía datos'.");
    process.exitCode = 1;
  } else {
    console.log("  Todo cuadra.");
  }
}

const sumarDias = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function main() {
  console.log(`Relleno de histórico agregado`);
  console.log(`  Periodo : ${DESDE} → ${HASTA}`);
  console.log(`  Niveles : ${NIVELES.join(", ")}`);
  console.log(`  Tramos  : ${TRAMO_DIAS} días${DRY_RUN ? "  · SIMULACRO (no escribe)" : ""}\n`);

  const client = await pool.connect();
  const t0 = Date.now();
  const total = {};
  NIVELES.forEach((n) => (total[n] = 0));

  try {
    // La tabla ya existe en producción, pero el cron la recrea si Strapi la
    // borra (problema conocido #12). Aquí se hace lo mismo por si se corre
    // contra una base limpia.
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
      )`);

    const finExclusivo = sumarDias(HASTA, 1);
    let tramo = 0;

    for (let ini = DESDE; ini < finExclusivo; ini = sumarDias(ini, TRAMO_DIAS)) {
      const fin = sumarDias(ini, TRAMO_DIAS) > finExclusivo
        ? finExclusivo
        : sumarDias(ini, TRAMO_DIAS);
      tramo++;

      const partes = [];
      for (const nivel of NIVELES) {
        const sql = DRY_RUN ? CONTEOS[nivel] : CONSULTAS[nivel];
        const r = await client.query(sql, [ini, fin]);
        const n = DRY_RUN ? Number(r.rows[0].n) : r.rowCount;
        total[nivel] += n;
        partes.push(`${nivel} ${String(n).padStart(5)}`);
      }

      const seg = Math.round((Date.now() - t0) / 1000);
      console.log(`[${String(tramo).padStart(2)}] ${ini} → ${sumarDias(fin, -1)}  ` +
        `${partes.join(" · ")}  (${seg}s)`);
    }

    const seg = Math.round((Date.now() - t0) / 1000);
    console.log(`\n${DRY_RUN ? "Se escribirían" : "Escritas"}:`);
    for (const nivel of NIVELES) {
      console.log(`  ${nivel.padEnd(10)} ${total[nivel].toLocaleString("es-MX")} filas`);
    }
    console.log(`Tiempo: ${seg}s`);

    if (DRY_RUN) {
      console.log("\n[SIMULACRO] No se escribió nada. Quita DRY_RUN para aplicar.");
    } else {
      const v = await client.query(`
        SELECT market_type, MIN(date)::text AS desde, MAX(date)::text AS hasta,
               COUNT(*) AS filas, COUNT(DISTINCT date) AS dias
        FROM precios_historicos_agregados
        WHERE market_type = ANY($1::text[])
        GROUP BY market_type ORDER BY market_type`, [NIVELES]);
      console.log("\nCómo quedó la tabla:");
      v.rows.forEach((r) => console.log(
        `  ${r.market_type.padEnd(10)} ${r.desde} → ${r.hasta}  ` +
        `${Number(r.filas).toLocaleString("es-MX")} filas · ${r.dias} días`));

      await auditar(client);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("\nError:", e.message);
  console.error("El relleno es idempotente: se puede reintentar el tramo que falló");
  console.error("acotando DESDE y HASTA, sin duplicar nada.");
  process.exit(1);
});
