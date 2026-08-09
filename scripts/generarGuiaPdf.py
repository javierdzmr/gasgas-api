# -*- coding: utf-8 -*-
"""
Genera la guía de uso de la API de GasGas en PDF.

    pip install weasyprint --break-system-packages
    python3 scripts/generarGuiaPdf.py

Escribe public/GasGas-API-Guia-de-uso.pdf, que se adjunta al correo de la
llave de evaluación y también queda descargable desde el sitio.
"""
import datetime, pathlib
from weasyprint import HTML

SALIDA = pathlib.Path(__file__).resolve().parent.parent / "public" / "GasGas-API-Guia-de-uso.pdf"

AZUL, VERDE, VERDE_OSC = "#0E2A47", "#00A94F", "#007A39"
TINTA, GRIS, LINEA = "#0E2A47", "#4C6379", "#E7ECF0"

MESES = ["enero","febrero","marzo","abril","mayo","junio",
         "julio","agosto","septiembre","octubre","noviembre","diciembre"]
hoy = datetime.date.today()
FECHA = f"{hoy.day} de {MESES[hoy.month-1]} de {hoy.year}"

WA_NUMERO = "523342700911"          # formato para wa.me: 52 + 10 dígitos
WA_VISIBLE = "+52 33 4270 0911"

AREAS = [
    ("I",   "Pacífico",        "Baja California · Baja California Sur · Sonora · Sinaloa · Nayarit", "2,113"),
    ("II",  "Norte",           "Chihuahua · Coahuila · Durango · Nuevo León · Tamaulipas · San Luis Potosí · Zacatecas", "3,283"),
    ("III", "Bajío",           "Jalisco · Guanajuato · Querétaro · Michoacán · Aguascalientes · Colima", "3,056"),
    ("IV",  "Centro",          "Puebla · Hidalgo · Morelos · Tlaxcala · Guerrero · Estado de México", "2,005"),
    ("V",   "Valle de México", "Ciudad de México y municipios conurbados", "1,252"),
    ("VI",  "Sureste",         "Veracruz · Oaxaca · Chiapas · Tabasco · Campeche · Yucatán · Quintana Roo", "2,485"),
]

ENDPOINTS = [
    ("GET /precios",         "market, value, days, product", "Promedio, mínimo, máximo y desviación de un mercado."),
    ("GET /historico",       "market, value, days",          "Serie diaria para graficar tendencias."),
    ("GET /areas",           "—",                            "Catálogo de las 6 Áreas GasGas y qué entidades cubren."),
    ("GET /estados",         "—",                            "Los 32 estados, para armar selectores."),
    ("GET /municipios",      "estado",                       "Municipios de un estado con su número de estaciones."),
    ("GET /ranking-estados", "product",                      "Los 32 estados ordenados, con su cambio de 7 días."),
    ("GET /vecinos",         "estado, product",              "Comparativo contra los estados colindantes."),
    ("GET /marcas",          "—",                            "Promedios por marca comercial."),
    ("GET /stats-hoy",       "—",                            "Cuántos precios entraron en el último corte."),
    ("GET /test",            "—",                            "Verificación de disponibilidad."),
]

def filas_areas():
    return "".join(
        f"<tr><td class='k'>{c}</td><td class='n'>{n}</td>"
        f"<td class='e'>{e}</td><td class='num'>{s}</td></tr>"
        for c, n, e, s in AREAS)

def filas_endpoints():
    return "".join(
        f"<tr><td class='ep'>{e}</td><td class='pa'>{p}</td><td class='de'>{d}</td></tr>"
        for e, p, d in ENDPOINTS)

HTML_DOC = f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<style>
@page {{
  size: Letter; margin: 20mm 17mm 18mm;
  @bottom-left  {{ content: "GasGas · Guía de uso de la API · {FECHA}";
                   font-family: Lato; font-size: 8pt; color: #8B99A6; }}
  @bottom-right {{ content: counter(page) " / " counter(pages);  font-family: Lato; font-size: 8pt; color: #8B99A6; }}
}}
@page :first {{ margin-top: 0; }}
* {{ box-sizing: border-box; }}
body {{ font-family: Lato, sans-serif; color: {TINTA}; font-size: 10pt; line-height: 1.55; margin: 0; }}

.portada {{ background: {AZUL}; color: #fff; margin: 0 -17mm 16mm; padding: 22mm 17mm 16mm; }}
.marca {{ display: inline-block; background: #fff; color: {AZUL}; font-weight: 900;
          font-size: 11pt; padding: 3pt 9pt; border-radius: 20pt; letter-spacing: .5pt; }}
.marca-t {{ font-size: 10.5pt; color: rgba(255,255,255,.55); margin-left: 8pt; }}
h1 {{ font-size: 27pt; font-weight: 900; margin: 14pt 0 6pt; line-height: 1.12; letter-spacing: -.4pt; }}
.sub {{ font-size: 11.5pt; color: rgba(255,255,255,.7); margin: 0; max-width: 128mm; }}
.pills {{ margin-top: 14pt; font-family: "DejaVu Sans Mono", monospace; font-size: 8pt;
          color: rgba(255,255,255,.85); letter-spacing: .6pt; }}
.pills span {{ border: 1px solid rgba(255,255,255,.3); border-radius: 20pt; padding: 3pt 9pt; margin-right: 5pt; }}

h2 {{ font-size: 13pt; font-weight: 900; margin: 16pt 0 7pt; padding-left: 9pt;
      border-left: 3.5pt solid {VERDE}; letter-spacing: -.2pt; }}
h2:first-of-type {{ margin-top: 0; }}
h3 {{ font-size: 10.5pt; font-weight: 900; margin: 12pt 0 4pt; color: {AZUL}; }}
p {{ margin: 0 0 7pt; color: {GRIS}; }}
b, strong {{ color: {TINTA}; }}

pre {{ background: {AZUL}; color: #E8F5EE; font-family: "DejaVu Sans Mono", monospace;
       font-size: 7.6pt; line-height: 1.5; padding: 9pt 11pt; border-radius: 5pt;
       margin: 6pt 0 9pt; white-space: pre-wrap; word-break: break-all; }}
pre .c {{ color: #7FD6A4; }}
code {{ font-family: "DejaVu Sans Mono", monospace; font-size: 8.6pt;
        background: #F1F5F8; padding: 1pt 3.5pt; border-radius: 3pt; color: {AZUL}; }}

table {{ width: 100%; border-collapse: collapse; margin: 5pt 0 9pt; }}
th {{ font-family: "DejaVu Sans Mono", monospace; font-size: 7pt; letter-spacing: .8pt;
      color: {VERDE_OSC}; text-align: left; text-transform: uppercase;
      border-bottom: 1.2pt solid {VERDE}; padding: 0 5pt 3.5pt; }}
td {{ font-size: 8.6pt; padding: 5pt; border-bottom: .6pt solid {LINEA}; vertical-align: top; color: {GRIS}; }}
td.k {{ font-family: "DejaVu Sans Mono", monospace; font-weight: bold; color: {VERDE_OSC}; width: 8%; }}
td.n {{ font-weight: bold; color: {TINTA}; width: 21%; }}
td.e {{ width: 56%; font-size: 8pt; }}
td.num, th.num {{ text-align: right; font-family: "DejaVu Sans Mono", monospace; color: {TINTA}; }}
td.ep {{ font-family: "DejaVu Sans Mono", monospace; color: {AZUL}; font-weight: bold; width: 26%; font-size: 8pt; }}
td.pa {{ font-family: "DejaVu Sans Mono", monospace; width: 26%; font-size: 7.6pt; }}

.aviso {{ background: #E8F5EE; border: .8pt solid #B9E4CC; border-radius: 5pt;
          padding: 9pt 12pt; margin: 9pt 0; font-size: 9pt; color: #1D5C3B; }}
.aviso b {{ color: #1D5C3B; }}
.cierre {{ background: {AZUL}; color: #fff; border-radius: 6pt; padding: 13pt 16pt; margin-top: 16pt; }}
.cierre h3 {{ color: #fff; margin: 0 0 4pt; font-size: 12pt; }}
.cierre p {{ color: rgba(255,255,255,.72); margin: 0; font-size: 9.5pt; }}
.cierre a {{ color: #7FD6A4; text-decoration: none; font-weight: bold; }}
table.contacto {{ margin: 11pt 0 0; }}
table.contacto td {{ border: 0; padding: 0 14pt 0 0; vertical-align: top; }}
table.contacto .ct {{ font-family: "DejaVu Sans Mono", monospace; font-size: 6.5pt;
                      letter-spacing: .9pt; color: rgba(255,255,255,.45); }}
table.contacto .cv {{ font-size: 9.5pt; margin-top: 2pt; }}
.doscol {{ display: flex; gap: 10pt; }}
.doscol > div {{ flex: 1; border: .8pt solid {LINEA}; border-radius: 5pt; padding: 9pt 11pt; }}
.doscol .t {{ font-family: "DejaVu Sans Mono", monospace; font-size: 7pt; letter-spacing: .8pt;
              color: {VERDE_OSC}; text-transform: uppercase; }}
.doscol .v {{ font-size: 15pt; font-weight: 900; color: {TINTA}; margin-top: 2pt; }}
.doscol .d {{ font-size: 8pt; color: {GRIS}; }}
.nb {{ page-break-inside: avoid; }}
</style></head><body>

<div class="portada">
  <span class="marca">GG</span><span class="marca-t">gasgas / datos</span>
  <h1>Guía de uso de la API</h1>
  <p class="sub">Precios de combustible de México: validados, deduplicados y enriquecidos
  con marca comercial. Entregados por API, listos para su sistema.</p>
  <div class="pills"><span>14,194 ESTACIONES</span><span>7 CORTES AL DÍA</span><span>DESDE MAYO 2024</span></div>
</div>

<h2>Empiece aquí</h2>
<p>La API es REST sobre HTTPS y responde JSON. No hay SDK que instalar: si su lenguaje
puede hacer una petición HTTP, ya puede consumirla. Esta llamada funciona tal cual —
sustituya <code>SU_LLAVE</code> por la que recibió por correo.</p>
<pre><span class="c"># Promedio de Magna en Jalisco, último corte</span>
curl -H "x-api-key: SU_LLAVE" \\
  "https://api.gasgas.com.mx/api/precios?market=estado&amp;value=Jalisco&amp;days=1&amp;product=regular"</pre>

<h3>La respuesta</h3>
<pre>{{
  "regular": "23.9295",       <span class="c">// promedio del producto, MXN por litro</span>
  "premium": "29.0847",
  "diesel":  "27.0410",
  "min":     "22.9900",       <span class="c">// del producto pedido en `product`</span>
  "max":     "24.4900",
  "std":     "0.2968",        <span class="c">// dispersión: qué tan parejo está el mercado</span>
  "stations_count": 333,      <span class="c">// estaciones que respaldan la cifra</span>
  "updated_at": "2026-08-09T18:18:33Z",
  "semaforo": {{
    "estado": "medio",        <span class="c">// barato | medio | caro</span>
    "delta_pct": 0.5,         <span class="c">// contra su referencia</span>
    "referencia": "nacional"
  }}
}}</pre>
<div class="aviso"><b>Los precios viajan como texto, no como número.</b> Es a propósito:
evita que su lenguaje redondee y le cambie el cuarto decimal. Conviértalos a decimal en su
lado, nunca a punto flotante si va a hacer sumas de dinero.</div>

<h2>Los cuatro parámetros</h2>
<table>
<tr><th>Parámetro</th><th>Valores</th><th>Para qué sirve</th></tr>
<tr><td class="pa">market</td><td class="pa">nacional · estado · municipio · area</td><td class="de">Qué tan agregado quiere el dato.</td></tr>
<tr><td class="pa">value</td><td class="pa">all · Jalisco · Jalisco|Zapopan · V</td><td class="de">Cuál mercado. En municipio la barra se codifica <code>%7C</code>.</td></tr>
<tr><td class="pa">days</td><td class="pa">1 · 7 · 30</td><td class="de">Último corte, o promedio de la ventana.</td></tr>
<tr><td class="pa">product</td><td class="pa">regular · premium · diesel</td><td class="de">A qué combustible corresponden min, max y std.</td></tr>
</table>

<h2>Áreas GasGas</h2>
<p>Seis macro-regiones comerciales que agrupan al país como lo piensan las áreas de
consumo masivo: por zona de distribución, no por frontera estatal. Consúltelas con
<code>market=area</code> y la clave romana en <code>value</code>.</p>
<table class="nb">
<tr><th>Área</th><th>Nombre</th><th>Entidades que integra</th><th class="num">Estaciones</th></tr>
{filas_areas()}
</table>
<pre>curl -H "x-api-key: SU_LLAVE" \\
  "https://api.gasgas.com.mx/api/precios?market=area&amp;value=V&amp;days=7&amp;product=premium"</pre>

<h2>Todos los endpoints</h2>
<p>Base: <code>https://api.gasgas.com.mx/api</code></p>
<table>
<tr><th>Endpoint</th><th>Parámetros</th><th>Qué devuelve</th></tr>
{filas_endpoints()}
</table>

<h2>Errores y límites</h2>
<p>Los errores llegan como JSON con una llave <code>error</code> y el código HTTP correspondiente.</p>
<table class="nb">
<tr><th>Código</th><th>Qué pasó</th><th>Qué hacer</th></tr>
<tr><td class="pa">400</td><td class="de">Falta un parámetro o viene mal formado.</td><td class="de">Revise <code>market</code> y <code>value</code>.</td></tr>
<tr><td class="pa">404</td><td class="de">El mercado no existe.</td><td class="de">Valide contra <code>/estados</code>, <code>/municipios</code> o <code>/areas</code>.</td></tr>
<tr><td class="pa">429</td><td class="de">Excedió su límite de consultas.</td><td class="de">Reintente con espera progresiva.</td></tr>
</table>

<div class="doscol nb">
  <div><div class="t">Frecuencia</div><div class="v">7 cortes</div>
       <div class="d">Entre las 6:30 y las 20:30, hora de México. Cada respuesta trae su <code>updated_at</code>.</div></div>
  <div><div class="t">Caché</div><div class="v">5 minutos</div>
       <div class="d">Las respuestas se pueden cachear ese tiempo. Consultar más seguido no le da un dato más fresco.</div></div>
</div>

<h2>Su llave de evaluación</h2>
<p>La llave que recibió es de demostración: <b>7 días de vigencia, 500 consultas y acceso a
nivel estado, municipio y área</b>. No tiene costo ni compromiso, y no hace falta tarjeta.
Los niveles de código postal y estación, y el histórico completo desde mayo 2024, se
habilitan con contrato.</p>
<div class="aviso"><b>Un consejo para su prueba:</b> lo que más dice sobre la calidad del
dato no es el promedio, es <code>std</code> y <code>stations_count</code>. Compare una plaza
grande contra una chica y verá de inmediato qué tanta dispersión real hay — eso es lo que no
se puede reconstruir con un archivo descargado.</p></div>

<div class="cierre">
  <h3>¿Dudas durante su prueba?</h3>
  <p>Escríbanos y le contesta alguien que conoce el dato, no un formulario.</p>
  <table class="contacto"><tr>
    <td><div class="ct">WHATSAPP</div>
        <div class="cv"><a href="https://wa.me/{WA_NUMERO}">{WA_VISIBLE}</a></div></td>
    <td><div class="ct">CORREO</div>
        <div class="cv"><a href="mailto:hola@gasgas.com.mx">hola@gasgas.com.mx</a></div></td>
    <td><div class="ct">DOCUMENTACIÓN</div>
        <div class="cv"><a href="https://gasgas.com.mx/docs">gasgas.com.mx/docs</a></div></td>
  </tr></table>
</div>

</body></html>"""

if __name__ == "__main__":
    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    HTML(string=HTML_DOC).write_pdf(str(SALIDA))
    print(f"✅ {SALIDA}  ({SALIDA.stat().st_size // 1024} KB)")
