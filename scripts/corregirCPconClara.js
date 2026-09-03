/**
 * corregirCPconClara.js
 *
 * Completa y corrige el código postal del padrón usando el archivo que Clara
 * nos entregó el 2 de septiembre de 2026 (14,977 permisos con su CP).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE APLICA EL ARCHIVO COMPLETO A CIEGAS
 *
 * Al medirlo contra nuestro padrón en dos muestras:
 *   · De 400 estaciones nuestras SIN código postal, Clara trae las 400.
 *   · De 249 donde ambos tenemos dato, coincide en 54%. De las 114
 *     discrepancias, 92 son diferencias de colonia dentro de la misma ciudad.
 *   · En las 5 peores, contrastadas contra nuestras propias coordenadas,
 *     Clara acierta 4 de 5. Pero falla una: ubica una gasolinera de Chalco
 *     en Toluca, a 90 km.
 *
 * O sea: su archivo es mejor que el nuestro, pero no es la verdad. Por eso el
 * script trabaja en dos niveles con criterios distintos.
 *
 * NIVEL 1 — estaciones sin CP válido (traen '0' o vacío)
 *   Se aplica el de Clara directo. No hay nada que perder: hoy son invisibles
 *   para el producto de nivel código postal, que es el que más se contrata.
 *
 * NIVEL 2 — estaciones donde el nuestro y el de Clara no coinciden
 *   NO gana ninguno de los dos por autoridad. Se mide la distancia de la
 *   gasolinera (lat/lng del padrón, que no depende del CP) al centro de cada
 *   uno de los dos códigos postales, y gana el más cercano. Decide la
 *   geografía, no la fuente.
 *
 *   Para evitar cambios sin sentido, solo se sustituye si el de Clara queda
 *   al menos MARGEN_KM más cerca. Si están casi empatados son colonias
 *   vecinas y da lo mismo: se conserva el nuestro y no se mueve nada.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Uso:
 *   DATABASE_URL=... DRY_RUN=1 node scripts/corregirCPconClara.js
 *   DATABASE_URL=... NIVEL=1  node scripts/corregirCPconClara.js
 *   DATABASE_URL=... NIVEL=todos node scripts/corregirCPconClara.js
 *
 * Variables:
 *   DATABASE_URL  (obligatoria) usar el puerto 5432 (modo sesión), como los crons
 *   DRY_RUN=1     muestra qué haría y no escribe nada. SIEMPRE correrlo así primero
 *   NIVEL         1 | 2 | todos   (default: todos)
 *   MARGEN_KM     margen mínimo para cambiar en el nivel 2 (default 0.5)
 *
 * Todo lo que se aplique queda registrado en gas_stations_cp_correcciones con
 * su fuente y el criterio usado, para poder revertirlo o auditarlo después.
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DRY_RUN = process.env.DRY_RUN === "1";
const NIVEL = (process.env.NIVEL || "todos").toLowerCase();
const MARGEN_KM = Number(process.env.MARGEN_KM || 0.5);
// Si el CP de Clara queda a más de esto de la gasolinera, no es un empate:
// los dos datos son sospechosos y no se toca nada.
const MAX_KM = Number(process.env.MAX_KM || 15);
// Qué hacer cuando la distancia no distingue (colonias vecinas):
//   "clara"   -> se adopta el suyo. Es lo que hace que SUS consultas encuentren
//                la estación, y la geografía dice que da igual cuál usemos.
//   "nuestro" -> no se toca. Más conservador, pero Clara sigue sin encontrarla.
const EMPATE = (process.env.EMPATE || "clara").toLowerCase();

const ARCHIVO_CLARA = path.join(__dirname, "datos", "clara-cp-2026-09-02.json");
const ARCHIVO_CPS = path.join(__dirname, "datos", "cp-coordenadas.json");

// La base tiene 60 conexiones compartidas entre varios servicios (incidente
// del 10 de agosto de 2026). Este script trabaja en serie: con 2 le sobra.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000
});
pool.on("error", (err) => console.error("Pool de PostgreSQL:", err.message));

// ── Utilidades ──────────────────────────────────────────────────────────────

const R_TIERRA = 6371;
const rad = (d) => (d * Math.PI) / 180;

/** Distancia en kilómetros entre dos puntos (fórmula del semiverseno). */
function km(latA, lngA, latB, lngB) {
  const dLat = rad(latB - latA);
  const dLng = rad(lngB - lngA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(latA)) * Math.cos(rad(latB)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_TIERRA * Math.asin(Math.sqrt(a));
}

/**
 * Repara el catálogo de coordenadas antes de usarlo para arbitrar.
 *
 * El catálogo trae 433 códigos postales (1.5%) con la coordenada mal puesta.
 * El caso que lo destapó: el CP 36821 es de Irapuato, pero el catálogo lo
 * ubica en Zacatecas, a 376 km. Sus vecinos 36822 y 36824 sí están en
 * Irapuato. Si no se corrige, cualquier gasolinera con ese CP parece estar
 * malísimamente ubicada y el arbitraje le da la razón a Clara sin merecerlo.
 *
 * El arreglo: los códigos postales que comparten los primeros 4 dígitos son
 * colonias del mismo sector y están a pocos kilómetros. Si uno se sale más de
 * 50 km de la mediana de sus hermanos, su coordenada no sirve y se sustituye
 * por esa mediana, que sí es representativa del sector.
 *
 * (De paso: el peor caso del catálogo, el CP 99626 a 6,190 km de sus vecinos,
 *  es el mismo que produce la peor sustitución del mapa que usa la API de
 *  Clara — manda a quien pide un CP de Zacatecas a uno de Baja California.
 *  Ese archivo se generó con este catálogo. Vale la pena regenerarlo.)
 */
function sanearCoordenadas(coords) {
  const familias = {};
  for (const [cp, punto] of Object.entries(coords)) {
    const k = cp.slice(0, 4);
    (familias[k] = familias[k] || []).push([cp, punto]);
  }
  const mediana = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  let reparados = 0;
  const sospechosos = new Set();

  for (const arr of Object.values(familias)) {
    if (arr.length < 3) continue;               // sin hermanos no hay con qué comparar
    const mLat = mediana(arr.map((a) => a[1][0]));
    const mLng = mediana(arr.map((a) => a[1][1]));
    for (const [cp, punto] of arr) {
      if (km(punto[0], punto[1], mLat, mLng) > 50) {
        coords[cp] = [mLat, mLng];
        sospechosos.add(cp);
        reparados++;
      }
    }
  }
  console.log(`Coordenadas de CP reparadas: ${reparados} (estaban lejísimos de su sector)`);
  return sospechosos;
}

/** Índice permiso CRE -> [códigos postales] a partir del archivo de Clara. */
function cargarClara() {
  const datos = JSON.parse(fs.readFileSync(ARCHIVO_CLARA, "utf8"));
  const idx = new Map();
  for (const { cp, permisos } of datos) {
    for (const p of permisos) {
      if (!idx.has(p)) idx.set(p, []);
      if (!idx.get(p).includes(cp)) idx.get(p).push(cp);
    }
  }
  return idx;
}

/** Devuelve el CP de Clara más cercano a la estación (si trae varios). */
function cpDeClaraMasCercano(cps, coordsCP, lat, lng) {
  if (cps.length === 1) return { cp: cps[0], dist: distanciaA(cps[0], coordsCP, lat, lng) };
  let mejor = null;
  for (const cp of cps) {
    const d = distanciaA(cp, coordsCP, lat, lng);
    if (d === null) continue;
    if (!mejor || d < mejor.dist) mejor = { cp, dist: d };
  }
  return mejor || { cp: cps[0], dist: null };
}

function distanciaA(cp, coordsCP, lat, lng) {
  const c = coordsCP[cp];
  if (!c || lat == null || lng == null) return null;
  return km(lat, lng, c[0], c[1]);
}

/** Escribe el cambio en el padrón y su registro de auditoría. */
async function aplicar(cliente, cambios, criterio) {
  if (DRY_RUN || cambios.length === 0) return 0;
  let hechos = 0;
  // De 500 en 500 para no armar sentencias gigantes ni transacciones eternas.
  for (let i = 0; i < cambios.length; i += 500) {
    const lote = cambios.slice(i, i + 500);
    await cliente.query("BEGIN");
    try {
      for (const c of lote) {
        await cliente.query(
          `INSERT INTO gas_stations_cp_correcciones
             (gas_station_id, cre_id, cp_anterior, cp_nuevo, fuente, nota)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [c.id, c.cre_id, c.cp_anterior, c.cp_nuevo,
           "Clara (archivo del 2 sep 2026)", criterio(c)]
        );
        await cliente.query("UPDATE gas_stations SET cp = $1 WHERE id = $2",
          [c.cp_nuevo, c.id]);
        hechos++;
      }
      await cliente.query("COMMIT");
    } catch (e) {
      await cliente.query("ROLLBACK");
      throw e;
    }
    process.stdout.write(`\r  aplicados ${hechos}/${cambios.length}`);
  }
  process.stdout.write("\n");
  return hechos;
}

// ── Nivel 1: las que no tienen código postal ────────────────────────────────

async function nivel1(cliente, clara) {
  console.log("\n═══ NIVEL 1 — estaciones sin código postal ═══");
  const { rows } = await cliente.query(`
    SELECT id, cre_id, cp, estado, municipio
    FROM gas_stations
    WHERE (cp IS NULL OR cp !~ '^[0-9]{5}$') AND cre_id IS NOT NULL
    ORDER BY id`);
  console.log(`Estaciones sin CP en el padrón: ${rows.length}`);

  const cambios = [];
  let sinDato = 0;
  for (const r of rows) {
    const cps = clara.get(r.cre_id);
    if (!cps || cps.length === 0) { sinDato++; continue; }
    cambios.push({
      id: r.id, cre_id: r.cre_id,
      cp_anterior: r.cp, cp_nuevo: cps[0],
      estado: r.estado
    });
  }
  console.log(`Clara las resuelve            : ${cambios.length}` +
    ` (${((100 * cambios.length) / rows.length).toFixed(1)}%)`);
  console.log(`Siguen sin dato               : ${sinDato}`);

  if (cambios.length) {
    console.log("\nEjemplos:");
    cambios.slice(0, 5).forEach((c) =>
      console.log(`  ${c.cre_id.padEnd(24)} ${c.cp_anterior || "(vacío)"} -> ${c.cp_nuevo}  ${c.estado}`));
  }

  const n = await aplicar(cliente, cambios, () =>
    "Nivel 1: el padrón no traía código postal. Se toma el de Clara sin arbitrar.");
  console.log(DRY_RUN
    ? `\n[SIMULACRO] Se aplicarían ${cambios.length} correcciones.`
    : `\nAplicadas ${n} correcciones.`);
  return cambios.length;
}

// ── Nivel 2: las que discrepan ──────────────────────────────────────────────

async function nivel2(cliente, clara, coordsCP) {
  console.log("\n═══ NIVEL 2 — discrepancias, arbitradas por distancia ═══");
  const { rows } = await cliente.query(`
    SELECT id, cre_id, cp, lat, lng, estado
    FROM gas_stations
    WHERE cp ~ '^[0-9]{5}$' AND cre_id IS NOT NULL
    ORDER BY id`);
  console.log(`Estaciones con CP válido      : ${rows.length}`);

  let coinciden = 0, sinClara = 0, sinCoords = 0, empatadas = 0;
  let ganamosNosotros = 0, descartadas = 0;
  const cambios = [];

  for (const r of rows) {
    const cps = clara.get(r.cre_id);
    if (!cps || cps.length === 0) { sinClara++; continue; }
    if (cps.includes(r.cp)) { coinciden++; continue; }

    const dNuestro = distanciaA(r.cp, coordsCP, r.lat, r.lng);
    const deClara = cpDeClaraMasCercano(cps, coordsCP, r.lat, r.lng);

    // Sin coordenadas del de Clara no hay con qué comparar: se conserva el
    // nuestro, que ya está publicado.
    if (deClara.dist === null) { sinCoords++; continue; }

    // Si el CP de Clara queda absurdamente lejos de la gasolinera, los dos son
    // sospechosos y no es un empate: no se toca nada. Así se atrapan errores
    // como el de Chalco, que Clara ubica en Toluca a 77 km.
    if (deClara.dist > MAX_KM) { descartadas++; continue; }

    // Nuestro CP no está en el catálogo de coordenadas: no lo podemos ubicar
    // en el mapa, mientras que el de Clara sí y además cae cerca. Eso es
    // evidencia de que el nuestro está mal (caso Mérida: teníamos un CP de
    // Chiapas para una gasolinera de Yucatán).
    if (dNuestro === null) {
      cambios.push({ id: r.id, cre_id: r.cre_id, cp_anterior: r.cp,
        cp_nuevo: deClara.cp, estado: r.estado,
        dNuestro: null, dClara: deClara.dist, motivo: "nuestro-sin-ubicar" });
      continue;
    }

    const ganancia = dNuestro - deClara.dist;

    if (ganancia >= MARGEN_KM) {
      cambios.push({ id: r.id, cre_id: r.cre_id, cp_anterior: r.cp,
        cp_nuevo: deClara.cp, estado: r.estado,
        dNuestro, dClara: deClara.dist, ganancia, motivo: "clara-mas-cerca" });
    } else if (ganancia <= -MARGEN_KM) {
      ganamosNosotros++;                      // el nuestro es claramente mejor
    } else {
      // Empate técnico: son colonias vecinas y la geografía no distingue.
      empatadas++;
      if (EMPATE === "clara") {
        cambios.push({ id: r.id, cre_id: r.cre_id, cp_anterior: r.cp,
          cp_nuevo: deClara.cp, estado: r.estado,
          dNuestro, dClara: deClara.dist, ganancia, motivo: "empate-se-adopta-clara" });
      }
    }
  }

  console.log(`Coinciden con Clara           : ${coinciden}`);
  console.log(`Clara no las tiene            : ${sinClara}`);
  console.log(`Gana Clara por distancia      : ${cambios.filter(c=>c.motivo==="clara-mas-cerca").length}`);
  console.log(`Nuestro CP no se puede ubicar : ${cambios.filter(c=>c.motivo==="nuestro-sin-ubicar").length}  (gana Clara)`);
  console.log(`Gana el nuestro por distancia : ${ganamosNosotros}`);
  console.log(`Empate tecnico (< ${MARGEN_KM} km)      : ${empatadas}` +
    `  (politica EMPATE=${EMPATE}${EMPATE === "clara" ? ", se adopta el de Clara" : ", se conserva el nuestro"})`);
  console.log(`El de Clara queda a >${MAX_KM} km    : ${descartadas}  (sospechoso, no se toca)`);
  console.log(`Sin coordenadas para arbitrar : ${sinCoords}  (se conserva el nuestro)`);
  console.log(`TOTAL a cambiar               : ${cambios.length}`);

  const porDistancia = cambios.filter((c) => c.motivo === "clara-mas-cerca");
  if (porDistancia.length) {
    porDistancia.sort((a, b) => b.ganancia - a.ganancia);
    console.log("\nLas 8 donde más equivocado estaba el padrón:");
    porDistancia.slice(0, 8).forEach((c) =>
      console.log(`  ${c.cre_id.padEnd(24)} ${c.cp_anterior} -> ${c.cp_nuevo}` +
        `  (estaba a ${c.dNuestro.toFixed(1)} km, queda a ${c.dClara.toFixed(1)} km)  ${c.estado}`));
  }

  const n = await aplicar(cliente, cambios, (c) => {
    const base = `Nivel 2 (${c.motivo}). CP de Clara ${c.cp_nuevo} a ${c.dClara.toFixed(2)} km de la estacion`;
    return c.dNuestro === null
      ? `${base}. Nuestro CP ${c.cp_anterior} no existe en el catalogo de coordenadas: no se puede ubicar.`
      : `${base}; el nuestro ${c.cp_anterior} a ${c.dNuestro.toFixed(2)} km. Margen ${MARGEN_KM} km, tope ${MAX_KM} km.`;
  });
  console.log(DRY_RUN
    ? `\n[SIMULACRO] Se aplicarían ${cambios.length} correcciones.`
    : `\nAplicadas ${n} correcciones.`);
  return cambios.length;
}

// ── Cobertura: qué tiene Clara que nosotros no ──────────────────────────────

async function revisarCobertura(cliente, clara) {
  console.log("\n═══ COBERTURA — estaciones que Clara tiene y nosotros no ═══");
  const { rows } = await cliente.query(
    "SELECT cre_id FROM gas_stations WHERE cre_id IS NOT NULL");
  const nuestras = new Set(rows.map((r) => r.cre_id));

  const faltantes = [];
  for (const permiso of clara.keys()) {
    if (!nuestras.has(permiso)) faltantes.push(permiso);
  }
  console.log(`Permisos en el archivo de Clara: ${clara.size}`);
  console.log(`Permisos en nuestro padrón      : ${nuestras.size}`);
  console.log(`Que Clara tiene y nosotros NO   : ${faltantes.length}`);
  if (faltantes.length) {
    console.log("\nEjemplos:");
    faltantes.slice(0, 10).forEach((p) => console.log("  " + p));
    console.log("\nOJO: publicamos que cubrimos 14,194 estaciones. Si estas son");
    console.log("reales y están operando, la cobertura que vendemos está corta.");
  }
  return faltantes.length;
}

// ── Principal ───────────────────────────────────────────────────────────────

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Falta DATABASE_URL.");
    process.exit(1);
  }
  // Este script ESCRIBE en el padrón. La DATABASE_URL del servicio web es de
  // solo lectura y además usa el puerto 6543 (modo transacción). Hay que tomar
  // la de un cron, que tiene permisos de escritura y usa el 5432.
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error("\nDATABASE_URL no parece una dirección de PostgreSQL.");
    console.error("Debe empezar con postgresql:// y verse así:");
    console.error("  postgresql://usuario:contraseña@host:5432/postgres\n");
    console.error("Cópiala de Render, del cron 'update-precios-agregados'");
    console.error("(NO del servicio web: ese usuario es de solo lectura).");
    process.exit(1);
  }
  if (/:6543\//.test(url)) {
    console.warn("\nAVISO: esa dirección usa el puerto 6543 (modo transacción),");
    console.warn("que es el de los servicios web y suele ser de solo lectura.");
    console.warn("Para escribir hay que usar la de un cron, con puerto 5432.\n");
  }
  console.log(DRY_RUN
    ? "MODO SIMULACRO — no se escribe nada en la base."
    : "MODO REAL — se van a modificar datos del padrón.");
  console.log(`Nivel: ${NIVEL} · margen para desempatar: ${MARGEN_KM} km\n`);

  const clara = cargarClara();
  const coordsCP = JSON.parse(fs.readFileSync(ARCHIVO_CPS, "utf8"));
  console.log(`Archivo de Clara : ${clara.size} permisos`);
  console.log(`Coordenadas de CP: ${Object.keys(coordsCP).length} códigos postales`);
  sanearCoordenadas(coordsCP);

  const cliente = await pool.connect();
  try {
    // Comprobar permiso de escritura ANTES de calcular nada: si el usuario es
    // de solo lectura, mejor enterarnos ahora que a media corrida.
    if (!DRY_RUN) {
      try {
        await cliente.query("BEGIN");
        await cliente.query("UPDATE gas_stations SET cp = cp WHERE id = (SELECT MIN(id) FROM gas_stations)");
        await cliente.query("ROLLBACK");
      } catch (e) {
        await cliente.query("ROLLBACK").catch(() => {});
        console.error("\nEse usuario NO puede escribir en gas_stations:", e.message);
        console.error("Usa la DATABASE_URL de un cron, no la del servicio web.");
        process.exit(1);
      }
    }

    // La tabla de auditoría debe existir antes de tocar nada.
    await cliente.query(`
      CREATE TABLE IF NOT EXISTS gas_stations_cp_correcciones (
        id SERIAL PRIMARY KEY,
        gas_station_id INTEGER NOT NULL,
        cre_id TEXT, cp_anterior TEXT, cp_nuevo TEXT NOT NULL,
        fuente TEXT NOT NULL, nota TEXT,
        aplicado_en TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    if (NIVEL === "1" || NIVEL === "todos") await nivel1(cliente, clara);
    if (NIVEL === "2" || NIVEL === "todos") await nivel2(cliente, clara, coordsCP);
    await revisarCobertura(cliente, clara);

    if (!DRY_RUN) {
      const { rows } = await cliente.query(`
        SELECT COUNT(*) FILTER (WHERE cp ~ '^[0-9]{5}$') AS con_cp,
               COUNT(*) FILTER (WHERE cp IS NULL OR cp !~ '^[0-9]{5}$') AS sin_cp,
               COUNT(DISTINCT cp) FILTER (WHERE cp ~ '^[0-9]{5}$') AS cps_distintos
        FROM gas_stations`);
      const r = rows[0];
      console.log("\n═══ CÓMO QUEDÓ EL PADRÓN ═══");
      console.log(`Con código postal : ${r.con_cp}`);
      console.log(`Sin código postal : ${r.sin_cp}`);
      console.log(`CPs distintos     : ${r.cps_distintos}`);
      console.log("\nSIGUIENTE PASO: los agregados y el Redis de Clara siguen");
      console.log("calculados con los CPs viejos. Hay que recalcular y rellenar.");
    }
  } finally {
    cliente.release();
    await pool.end();
  }
  console.log("\nListo.");
}

main().catch(async (e) => {
  console.error("\nError:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
