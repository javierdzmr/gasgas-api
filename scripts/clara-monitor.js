// Monitor de salud de la API de Clara — corre en GitHub Actions.
// La API key NUNCA va en el repo: viene del secret CLARA_API_KEY.
// Sale con código 1 (falla) si algo está mal, para que GitHub te avise por correo.

const API_KEY = process.env.CLARA_API_KEY;
const BASE = "https://clara.gasgas.app/api/precios-por-cp";
const CPS = ["64000", "45640", "27000", "56600", "21100"];

if (!API_KEY) {
  console.error("Falta CLARA_API_KEY. Configúralo en Settings → Secrets → Actions del repo.");
  process.exit(1);
}

// Fecha de hoy y ayer en horario de México (tolerancia por zona horaria / hora de corrida).
function fechaMX(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}
const fechasOk = new Set([fechaMX(0), fechaMX(1)]);

async function get(cp, withKey = true) {
  const headers = withKey ? { "x-api-key": API_KEY } : {};
  const r = await fetch(`${BASE}/${cp}`, { headers });
  let body = null;
  try { body = await r.json(); } catch { /* respuesta no-JSON */ }
  return { status: r.status, body };
}
function inRange(n, a, b) { return typeof n === "number" && n >= a && n <= b; }

(async () => {
  const problemas = [];

  for (const cp of CPS) {
    try {
      const { status, body } = await get(cp);
      if (status !== 200) { problemas.push(`CP ${cp}: status ${status}`); continue; }
      if (!body || !body.precios) { problemas.push(`CP ${cp}: respuesta sin precios`); continue; }
      if (!fechasOk.has(body.fecha)) {
        problemas.push(`CP ${cp}: fecha vieja (${body.fecha}) — ¿Redis congelado / seed job caído?`);
      }
      const p = body.precios;
      if (!inRange(p.regular, 15, 30)) problemas.push(`CP ${cp}: regular fuera de rango (${p.regular})`);
      if (!inRange(p.premium, 18, 35)) problemas.push(`CP ${cp}: premium fuera de rango (${p.premium})`);
    } catch (e) {
      problemas.push(`CP ${cp}: error de red (${e.message})`);
    }
  }

  // Chequeo de seguridad: sin API key debe rechazar.
  try {
    const { status } = await get("64000", false);
    if (status !== 401 && status !== 403) {
      problemas.push(`Seguridad: sin API key devolvió ${status} (debería 401/403)`);
    }
  } catch (e) {
    problemas.push(`Seguridad: error (${e.message})`);
  }

  if (problemas.length) {
    console.error("❌ Clara con problemas:\n" + problemas.map((p) => "  - " + p).join("\n"));
    process.exit(1);
  }
  console.log(`✅ Clara OK — ${CPS.length} CPs frescos y correctos, seguridad activa. (fechas válidas: ${[...fechasOk].join(", ")})`);
})();
