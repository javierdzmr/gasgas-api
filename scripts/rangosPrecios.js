/**
 * rangosPrecios.js — LA fuente única de los rangos de precios válidos.
 *
 * Antes esto vivía copiado en siete lugares: updateAgregados.js,
 * updateHistoricosDaily.js y tres veces dentro de server.js. El riesgo era el
 * que advierte CLAUDE.md desde agosto: cambiar unos y olvidar otros, y que la
 * página publique un número mientras los promedios se calculan con otro.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Actualización 1 de septiembre de 2026 — la frontera norte
 *
 * Clara reportó que el CP 88776 (Reynosa) devolvía 0 en Regular y Diésel.
 * La causa no era un error de captura: en Reynosa la Magna se vendía a
 * $19.89, por debajo del piso de 21 que teníamos. El filtro la descartaba y
 * publicábamos 0 en su lugar.
 *
 * No era un caso aislado. El día que se midió se estaban tirando 605 precios
 * legítimos de Regular, concentrados en cinco estados fronterizos:
 *   Tamaulipas 250 de 584 (43%) · Chihuahua 195 (33%) · Sonora 101 (19%)
 *   Coahuila 33 · Baja California 16
 *
 * La razón es fiscal, no técnica: Hacienda mantiene un estímulo al IEPS para
 * municipios a menos de 45 km de la frontera norte, para emparejar precios con
 * Estados Unidos. En abril de 2026 iban $3.83/litro de Magna y $2.65 de Premium
 * en Reynosa, Río Bravo, Matamoros, Camargo, Díaz Ordaz y Miguel Alemán.
 * $23.99 − $3.83 = $20.16. Esos precios son reales.
 *
 * Consecuencia de haberlos tirado: publicábamos Chihuahua $1.60/litro más caro
 * de lo que estaba, y Tamaulipas $1.12. Ese número es el que recibía cobee a
 * diario.
 *
 * Cómo se eligieron los cortes nuevos (medidos sobre el corte del 1 sep):
 *   - Regular a 18: rescata 605 precios legítimos y sigue atrapando los 4 que
 *     sí son basura (se vieron valores de $13.59 y $15.94).
 *   - Regular a 28: solo admite 2 precios nuevos. Deja 2 fuera por arriba.
 *   - Premium a 20: el piso de 23 cortaba 45 precios, 23 de ellos en
 *     Tamaulipas. Mismo fenómeno de frontera, menor escala.
 *   - Premium se queda en 32 arriba: hoy no hay un solo precio por encima.
 *   - Diésel NO se tocó. Sus descartes están repartidos por todo el país sin
 *     patrón fronterizo: parece variación normal, no un mercado que estemos
 *     borrando. Si algún día se revisa, medir primero por estado.
 *
 * ⚠️ Al cambiar estos números hay que RECALCULAR LA HISTORIA, no solo seguir
 * hacia adelante. Si no, la serie diaria muestra un escalón que parece una
 * bajada real de precios (Tamaulipas −$1.12 de un día para otro) y nuestro
 * propio Monitor Nacional lo reporta como movimiento de 7 días.
 *
 * ⚠️ Fuera de este repositorio quedan copias que hay que alinear a mano:
 *      · gasgas-analytics-api-as-a-service-seed  (seeder de Clara, Northflank)
 *      · gasgas-cobee-firebase                   (API de cobee)
 *    No comparten paquete con este repo. Si se ajustan los rangos aquí, hay
 *    que revisarlos allá el mismo día.
 * ─────────────────────────────────────────────────────────────────────────
 */

const RANGE = {
  regular: { min: 18, max: 28 },
  premium: { min: 20, max: 32 },
  diesel:  { min: 25, max: 33 },
};

module.exports = { RANGE };
