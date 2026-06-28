import { Hono } from 'hono';
import type { Env } from '../types';

// Informe de Evaluación de Daños — Costa de La Guaira (terremoto doble Mw7.2+Mw7.5,
// Falla de San Sebastián, 24-jun-2026). Analiza los 820 reportes de /danos a través
// de tres lentes (estructural, geológica, gestión de desastres) con revisión
// adversarial (red-team). Gráficos servidos como estáticos desde /informe-danos/assets/.
export const informeDanos = new Hono<{ Bindings: Env }>();

const REPORT_CSS = `@page { size: A4; margin: 18mm 16mm 20mm 16mm;
  @bottom-center { content: "SISMO911 · Informe de Daños — Costa de La Guaira · " counter(page) "/" counter(pages); font-size: 8pt; color: #66788a; }
}
body { font-family: "Helvetica Neue", Arial, sans-serif; color: #0b1b2b; font-size: 10.5pt; line-height: 1.45; }
h1 { color: #0b2545; font-size: 21pt; border-bottom: 3px solid #b3261e; padding-bottom: 6px; }
h2 { color: #0b2545; font-size: 15pt; margin-top: 22px; border-bottom: 1px solid #c9d3dd; padding-bottom: 3px; page-break-after: avoid; }
h3 { color: #1e3a5f; font-size: 12pt; margin-top: 14px; page-break-after: avoid; }
h4 { color: #33415c; font-size: 10.5pt; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 9pt; page-break-inside: avoid; }
th { background: #0b2545; color: #fff; text-align: left; padding: 5px 7px; }
td { border: 1px solid #c9d3dd; padding: 4px 7px; vertical-align: top; }
tr:nth-child(even) td { background: #f3f6f9; }
blockquote { background: #fff6e9; border-left: 4px solid #e8821a; margin: 12px 0; padding: 8px 14px; font-size: 9.7pt; }
img { max-width: 100%; height: auto; display: block; margin: 12px auto; border: 1px solid #dfe6ec; border-radius: 4px; page-break-inside: avoid; }
code { background: #eef2f6; padding: 1px 4px; border-radius: 3px; font-size: 9pt; }
hr { border: none; border-top: 1px solid #dfe6ec; margin: 18px 0; }
a { color: #0b2545; }
strong { color: #0b1b2b; }
`;
const REPORT_BODY = `<h1 id="informe-de-evaluación-de-daños--costa-de-la-guaira">Informe de
Evaluación de Daños — Costa de La Guaira</h1>
<h3
id="terremoto-doble-de-venezuela--24-de-junio-de-2026-mw-72--mw-75--falla-de-san-sebastián">Terremoto
doble de Venezuela · 24 de junio de 2026 (Mw 7,2 + Mw 7,5 — Falla de San
Sebastián)</h3>
<p><strong>Plataforma:</strong> SISMO911 · módulo <code>/danos</code>
(Evaluación de Daños — Satélite + IA) <strong>Corte de datos:</strong>
28 de junio de 2026 · <strong>Reportes analizados:</strong> 820
nacionales / 199 en la costa de La Guaira <strong>Método:</strong>
lentes de <em>ingeniería estructural</em>, <em>geología/geotecnia</em> y
<em>gestión de desastres</em>, <strong>endurecido por una revisión
adversarial (red-team) multidisciplinaria</strong> cuyos hallazgos se
incorporan en el texto y se documentan en §9.</p>
<blockquote>
<h3
id="warning-advertencia-de-lectura-obligatoria--naturaleza-y-límites-de-los-datos">⚠️
Advertencia de lectura obligatoria — naturaleza y límites de los
datos</h3>
<p>Las cifras de daños provienen de reportes <strong>ciudadanos</strong>
agregados por SISMO911 desde <code>sosvenezuela2026.com</code>. De 820
reportes: <strong>784 “confirmados por la comunidad”, 31 sin verificar,
solo 5 verificados oficialmente</strong>; apenas <strong>20 traen foto
(2,4%)</strong> y <strong>158 (19%) están sin clasificar</strong>.
<strong>NO es un censo oficial ni una inspección de ingeniería.</strong>
Es una <strong>señal de priorización</strong> —densa y temprana— que
<strong>debe validarse en campo</strong>.</p>
<p><strong>Sesgo de cobertura (corrección clave del red-team):</strong>
los datos reflejan <em>dónde se usa la app</em>, no necesariamente
<em>dónde está el peor daño</em>. <strong>El epicentro estuvo en
Yaracuy/Carabobo (San Felipe, Yumare, Morón, Puerto Cabello), no en La
Guaira.</strong> Es muy probable que la región epicentral sea un
<strong>“desierto de datos”</strong> con daño grave subreportado. Toda
comparación entre zonas que no esté <strong>normalizada por población /
parque edificado</strong> es indicativa, no concluyente.</p>
</blockquote>
<hr />
<h2 id="0-resumen-ejecutivo">0. Resumen ejecutivo</h2>
<ol type="1">
<li><p><strong>El evento.</strong> El 24/06/2026 a las 18:04 (local)
ocurrió un <strong>doblete sísmico</strong> sobre la <strong>Falla de
San Sebastián</strong>: premonitor <strong>Mw 7,2</strong> (prof. 20,3
km) y, 39 s después, el principal <strong>Mw 7,5</strong> (prof. 10 km),
zona Yumare–Morón. Es <strong>el sismo más fuerte de Venezuela desde
1900</strong>, intensidad <strong>Mercalli IX</strong>. <strong>300+
réplicas</strong>; el 26/06 una réplica <strong>M4,7 derribó el puente
de Caraballeda</strong>, aislando la parroquia.</p></li>
<li><p><strong>El daño humano no coincide con el epicentro
sísmico.</strong> La destrucción se concentró en la <strong>costa de La
Guaira</strong> y en <strong>Caracas</strong>, a &gt;100 km del
epicentro. La causa es geológica (<strong>efecto de sitio</strong>) — y
el patrón de reportes está, además, sesgado por la cobertura de la app
(ver advertencia).</p></li>
<li><p><strong>Hallazgo central, formulado con honestidad.</strong> La
costa de La Guaira concentra el <strong>71% de los colapsos
<em>reportados en SISMO911</em></strong> (102 de 143). Es un
<strong>indicador fuerte de priorización</strong>, <strong>consistente
con</strong> un efecto de sitio severo, <strong>pero no prueba</strong>
por sí solo la severidad relativa: falta el denominador (parque
edificado) y la región epicentral está subreportada. Caraballeda es,
cualitativamente, el foco más severo.</p></li>
<li><p><strong>Por qué (geología).</strong> La franja está construida
sobre <strong>sedimentos costeros blandos y rellenos</strong> entre el
mar y la Cordillera. El mecanismo dominante y defendible es la
<strong>amplificación dinámica</strong> de la sacudida (resonancia
suelo–edificio). La <strong>licuefacción es posible pero NO está
probada</strong> (los abanicos de quebrada son gruesos, poco licuables)
— debe verificarse en campo. El <strong>análogo sísmico correcto es el
terremoto de Caracas de 1967</strong> (colapsos en Caraballeda/Macuto
por resonancia), <strong>no</strong> el deslave hidrometeorológico de
1999.</p></li>
<li><p><strong>Víctimas (cifras en evolución, rangos).</strong> Al
27/06: <strong>≈1.430 fallecidos, 3.238–3.360 heridos, 50.000–68.900
“desaparecidos”, 3.142 familias damnificadas</strong>. Los
“desaparecidos” son en gran parte <strong>no-contactados por caída de
telecomunicaciones</strong>, no necesariamente sepultados. El modelo
<strong>USGS PAGER</strong> asigna probabilidad no trivial al rango de
<strong>decenas de miles a &gt;100.000</strong> (alerta roja) — es una
distribución de probabilidad, no una cifra esperada.</p></li>
<li><p><strong>Acción (orden).</strong> (a) <strong>Cerrar el punto
ciego epicentral</strong> con verificación satelital antes de fijar
prioridades geográficas; (b) <strong>corregir el bug
<code>people_trapped=0</code></strong> (dato más sensible a la vida);
(c) inspección <strong>ATC-20</strong> de los puntos costeros,
cordón/apuntalamiento ante réplicas; (d) <strong>refugios Sphere en
suelo seguro</strong>; (e) reconstrucción <strong>Build Back
Better</strong> guiada por microzonificación FUNVISIS; (f) tamizar
<strong>riesgo NaTech</strong> (Refinería El Palito / Puerto Cabello),
<strong>integridad hospitalaria</strong> y <strong>coordinación
internacional</strong> (RDC/OSOCC/UNDAC/LEMA).</p></li>
</ol>
<hr />
<h2 id="1-el-evento-sísmico">1. El evento sísmico</h2>
<table>
<thead>
<tr>
<th>Parámetro</th>
<th>Premonitor</th>
<th>Principal</th>
</tr>
</thead>
<tbody>
<tr>
<td>Fecha/hora</td>
<td>24/06/2026 18:04 local</td>
<td>+39 s</td>
</tr>
<tr>
<td>Magnitud</td>
<td><strong>Mw 7,2</strong></td>
<td><strong>Mw 7,5</strong></td>
</tr>
<tr>
<td>Profundidad</td>
<td>20,3 km</td>
<td>10 km (somero)</td>
</tr>
<tr>
<td>Zona epicentral</td>
<td>San Felipe / Yumare (Yaracuy)</td>
<td>Yumare–Morón</td>
</tr>
<tr>
<td>Falla</td>
<td>Sistema <strong>San Sebastián</strong> (rumbo-deslizante, mayormente
costa afuera)</td>
<td>íd.; ruptura ~150×20 km</td>
</tr>
<tr>
<td>Intensidad</td>
<td>—</td>
<td><strong>Mercalli IX</strong></td>
</tr>
</tbody>
</table>
<ul>
<li><strong>Falla de San Sebastián:</strong> transcurrente de la
frontera Caribe–Sudamérica, paralela a la costa centro-norte. Segmento
somero en tierra cerca del <strong>Aeropuerto de Maiquetía</strong> =
<strong>Falla de Las Bruscas</strong>.</li>
<li><strong>Réplicas:</strong> 300+; <strong>M4,7 (26/06)</strong>
colapsó el <strong>puente de Caraballeda</strong> — agravante logístico
de primer orden (la parroquia quedó aislada cuando su reloj de búsqueda
apenas comenzaba).</li>
<li><strong>Histórico:</strong> el más fuerte desde el <strong>terremoto
de San Narciso (1900)</strong>.</li>
</ul>
<p><img src="/informe-danos/assets/01_severidad_nacional.png"
alt="Severidad nacional" /></p>
<hr />
<h2 id="2-metodología-y-fuente-de-datos">2. Metodología y fuente de
datos</h2>
<ul>
<li><strong>Fuente:</strong> feed público
<code>sosvenezuela2026.com/api/reports</code> → tabla
<code>sos_damage</code> → <code>/api/danos-estructurales</code> y el
mapa <code>/danos</code>.</li>
<li><strong>Volumen:</strong> 820 reportes · 818 geolocalizados (99,8%)
· 20 con foto (2,4%) · 158 (19%) sin clasificar.</li>
<li><strong>Verificación:</strong> 784 <em>community_confirmed</em> · 31
<em>unverified</em> · 5 <em>official_verified</em>.</li>
<li><strong>Limpieza de la plataforma:</strong> descarte de coordenadas
fuera de Venezuela y corrección de geocodificaciones erróneas (ej.:
colapso de Tanaguarena publicado por error en Europa).</li>
<li><strong>Severidad (leyenda):</strong> 🔴 grave/severo · 🟠 moderado
· 🟡 leve · 🟢 sin daño · ⚪ indeterminado.</li>
<li><strong>Recorte “costa de La Guaira”:</strong> municipios
Caraballeda, Maiquetía, Catia La Mar, Macuto, La Guaira, Naiguatá,
Carayaca, Caruao + <em>bounding box</em> costero (lat 10,55–10,65 / lon
−67,10…−66,30) = <strong>199 reportes</strong>.</li>
<li><strong>Limitación reconocida:</strong> los conteos por topónimo
están contaminados por duplicados/variantes (ej.: Caraballeda aparece
con 95 a nivel localidad pero 77 a nivel municipal — geográficamente
imposible). Por eso las cifras por lugar se usan como
<strong>±indicativas</strong>, no como porcentajes exactos.</li>
</ul>
<hr />
<h2 id="3-panorama-nacional">3. Panorama nacional</h2>
<ul>
<li><strong>820 reportes</strong> sesgados a <strong>Caracas
(344)</strong> y la <strong>costa de La Guaira</strong>.</li>
<li><strong>Severidad:</strong> 150 🔴 · 214 🟠 · 296 🟡 · 2 🟢 · 158
sin clasificar.</li>
<li><strong>Tipo:</strong> <strong>507 dañados · 143 colapsados</strong>
· 145 puntos de ayuda · 11 “refugios” · 9 “personas atrapadas” · 2 agua
· 2 fuga de gas · 1 médica.</li>
</ul>
<p><img src="/informe-danos/assets/02_categorias_nacional.png"
alt="Categorías nacional" /></p>
<p><img src="/informe-danos/assets/05_top_municipios.png"
alt="Municipios más afectados" /></p>
<p><img src="/informe-danos/assets/08_mapa_nacional.png" alt="Mapa nacional" /></p>
<blockquote>
<p><strong>Lectura honesta:</strong> Caracas domina en <em>volumen</em>
(capital, millones de habitantes, alta conectividad → más reportes); la
costa de La Guaira domina en <em>severidad reportada</em>.
<strong>Ninguna comparación entre zonas es válida sin normalizar por
población/parque edificado.</strong> Y el <strong>vacío
epicentral</strong> (Yaracuy/Carabobo) implica que el mapa subrepresenta
el campo cercano.</p>
</blockquote>
<hr />
<h2 id="4-foco-costa-de-la-guaira">4. Foco: costa de La Guaira</h2>
<p><strong>199 reportes · 102 colapsos · 108 rojos</strong> — la zona
más severa <em>de lo reportado</em>.</p>
<p><img src="/informe-danos/assets/03_concentracion_colapsos.png"
alt="Concentración de colapsos" /></p>
<p><img src="/informe-danos/assets/04_la_guaira_por_localidad.png"
alt="Daños por localidad — La Guaira" /></p>
<p><img src="/informe-danos/assets/06_perfil_severidad.png"
alt="Perfil de severidad LG vs Nacional" /></p>
<p><img src="/informe-danos/assets/07_mapa_la_guaira.png"
alt="Mapa de daños La Guaira" /></p>
<table>
<thead>
<tr>
<th>Localidad</th>
<th style="text-align: right;">Reportes (±indic.)</th>
<th>Lectura</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>Caraballeda</strong></td>
<td style="text-align: right;">~95</td>
<td>Foco principal: Los Corales, Tanaguarena, Caribe, El Palmar, Punta
Brisas. <strong>Aislada</strong> tras el colapso del puente.</td>
</tr>
<tr>
<td><strong>Maiquetía</strong></td>
<td style="text-align: right;">~35</td>
<td>Pariata, Playa Grande; crítica por el aeropuerto.</td>
</tr>
<tr>
<td><strong>Catia La Mar</strong></td>
<td style="text-align: right;">~15</td>
<td>Urimare, Playa Verde.</td>
</tr>
<tr>
<td><strong>Macuto</strong></td>
<td style="text-align: right;">~10</td>
<td>Casco costero (zona de colapsos en 1967).</td>
</tr>
<tr>
<td><strong>La Guaira (centro)</strong></td>
<td style="text-align: right;">~9</td>
<td>Puerto y casco histórico.</td>
</tr>
<tr>
<td><strong>Naiguatá</strong></td>
<td style="text-align: right;">~4</td>
<td>Extremo este.</td>
</tr>
<tr>
<td><strong>Otros LG</strong></td>
<td style="text-align: right;">~31</td>
<td>Camurí, Carayaca, Caruao.</td>
</tr>
</tbody>
</table>
<p><strong>Dato, en su justa dimensión:</strong> la costa de La Guaira
aporta ~24% de los reportes pero el <strong>71% de los colapsos
reportados</strong>. Es una <strong>bandera de priorización
potente</strong>, pero su interpretación como “severidad física probada”
requiere (i) normalizar por parque edificado y (ii) descartar que sea
artefacto de cobertura/rescate intenso (el puente caído y la operación
USAR generan más reportes de colapso). <strong>Conclusión cualitativa
robusta: Caraballeda es el foco.</strong> <strong>Conclusión
cuantitativa (“71%”): indicador, no censo.</strong></p>
<hr />
<h2 id="5-análisis-estructural-lente-ingeniería-sísmica--atc-20">5.
Análisis estructural <em>(lente: ingeniería sísmica — ATC-20)</em></h2>
<h3 id="51-traducción-a-etiquetado-de-seguridad-conservadora">5.1
Traducción a etiquetado de seguridad (conservadora)</h3>
<table>
<thead>
<tr>
<th>Severidad reportada</th>
<th>Etiqueta ATC-20 sugerida</th>
<th>Acción</th>
</tr>
</thead>
<tbody>
<tr>
<td>Colapsado</td>
<td>⬛ Cordón / disposición</td>
<td>Asegurar → USAR → remoción/demolición</td>
</tr>
<tr>
<td>Rojo (grave)</td>
<td>🔴 Insegura</td>
<td>Prohibir entrada; apuntalar/evacuar vecinos</td>
</tr>
<tr>
<td>Naranja (moderado)</td>
<td>🟡 Uso restringido <strong>pendiente de inspección</strong></td>
<td>Entrada limitada; inspección prioritaria</td>
</tr>
<tr>
<td>Amarillo (leve)</td>
<td>🟢/🟡 según sistema estructural</td>
<td>Inspección antes de reocupar</td>
</tr>
</tbody>
</table>
<blockquote>
<p><strong>Corrección del red-team aplicada:</strong> <em>NO</em> se
asignan grados <strong>EMS-98</strong> numéricos a los datos. La
severidad colaborativa de color <strong>no es convertible a
EMS-98</strong> sin inspección presencial (requiere ver tipología y
patrón de daño). El 19% sin clasificar invalida cualquier “distribución
de grados”.</p>
</blockquote>
<h3
id="52-mecanismos-de-falla-esperados-mercalli-ix-sobre-suelo-blando">5.2
Mecanismos de falla esperados (Mercalli IX sobre suelo blando)</h3>
<p>Hipótesis a confirmar en inspección, no conteos:</p>
<ul>
<li><strong>Planta baja blanda</strong> (locales/estacionamiento en PB)
— principal causa de colapso en pórticos de concreto.</li>
<li><strong>Mampostería no confinada / autoconstrucción</strong>
(barrios) — volcamiento fuera de plano, alta mortalidad.</li>
<li><strong>Golpeteo</strong> entre edificios contiguos; <strong>columna
corta/cautiva</strong>; <strong>colapso en panqueque</strong> (baja
supervivencia → urgencia USAR).</li>
<li><strong>Falla de fundación</strong> por asentamiento diferencial
(posible licuefacción local — verificar).</li>
<li><strong>Calidad constructiva + intensidad IX + sitio blando</strong>
son <strong>co-causas de peso comparable</strong>; el doblete es un
<strong>agravante plausible</strong> (daño acumulado en 39 s), no
necesariamente “el” driver principal.</li>
</ul>
<h3 id="53-demolición-vs-reparación">5.3 Demolición vs. reparación</h3>
<p>Marca como <strong>“CANDIDATO A DEMOLICIÓN, sujeto a evaluación
detallada (FEMA 306/307/308)”</strong>, no como orden de demoler.
Disposición firme <strong>solo</strong> ante colapso consumado o peligro
inminente a terceros, <strong>tras descarte USAR</strong>. Secuencia:
visto bueno estructural → corte de servicios → tamizaje asbesto/hazmat →
liberación USAR → demolición controlada. <strong>Nunca</strong> demoler
categorías enteras desde datos sin inspección.</p>
<hr />
<h2
id="6-análisis-geológico-geotécnico-lente-geología--geotecnia--sismología--sin-predicción">6.
Análisis geológico-geotécnico <em>(lente: geología / geotecnia /
sismología — sin “predicción”)</em></h2>
<h3 id="61-por-qué-la-guaira-lejos-del-epicentro-sufrió-tanto">6.1 Por
qué La Guaira, lejos del epicentro, sufrió tanto</h3>
<ul>
<li><strong>Amplificación dinámica (mecanismo dominante y
defendible):</strong> los sedimentos costeros blandos amplifican la
sacudida frente a la roca y entran en <strong>resonancia</strong> con
edificios de período similar. Este es el efecto de sitio del
<strong>terremoto de Caracas de 1967</strong>, cuando colapsaron
edificios en <strong>Caraballeda y Macuto</strong> — el análogo
correcto.</li>
<li><strong>Licuefacción (posible, NO probada — verificar):</strong>
requiere <strong>arenas/limos sueltos saturados</strong> con freático
alto. Los abanicos de las quebradas San Julián/Cerro Grande son
depósitos de <strong>flujo de escombros (gravas/bloques)</strong>,
típicamente <strong>menos</strong> licuables. Puede haber licuefacción
en lentes arenosos o rellenos sueltos, pero <strong>no hay evidencia de
campo</strong> (sand boils, lateral spreading) citada. → mantener como
hipótesis a confirmar con granulometría y nivel freático.</li>
<li><strong>Topografía:</strong> crestas y bordes de talud amplifican
localmente.</li>
</ul>
<h3 id="62-microzonificación-funvisis--base-de-la-reconstrucción">6.2
Microzonificación (FUNVISIS) — base de la reconstrucción</h3>
<ul>
<li><strong>Roca / ladera firme</strong> → reconstrucción con código
sísmico COVENIN.</li>
<li><strong>Sedimento blando (amplificación)</strong> → fundaciones
profundas / mejora de suelo.</li>
<li><strong>Lentes licuables / rellenos</strong> → caracterizar y
mejorar o reubicar.</li>
<li><strong>Canal de quebrada / abanico activo</strong> (San Julián,
Cerro Grande) → <strong>zona de no reconstrucción</strong> (riesgo de
flujo de escombros).</li>
</ul>
<h3 id="63-dos-peligros-distintos-no-confundir">6.3 Dos peligros
distintos, no confundir</h3>
<ul>
<li><strong>1967 (sísmico):</strong> análogo del efecto de sitio actual
— resonancia de sedimentos → colapsos costeros. <strong>Es la física
correcta</strong> para 2026.</li>
<li><strong>1999 (hidrometeorológico):</strong> la Tragedia de Vargas
fue por <strong>lluvia → flujos de escombros</strong>, no por sismo.
<strong>No</strong> informa sobre amplificación sísmica.
<strong>Sí</strong> importa ahora como <strong>peligro en
cascada</strong>: junio es temporada de lluvias y las réplicas sobre
laderas saturadas pueden <strong>re-disparar deslaves tipo 1999</strong>
sobre Caraballeda. → <strong>no ubicar refugios en conos de
deyección.</strong></li>
</ul>
<h3
id="64-réplicas-y-peligros-en-cascada-probabilístico--no-predicción">6.4
Réplicas y peligros en cascada <em>(probabilístico — NO
predicción)</em></h3>
<ul>
<li><strong>Réplicas:</strong> la tasa decae con el tiempo (<strong>ley
de Omori</strong>); la mayor suele estar ~1 magnitud bajo el principal
(<strong>ley de Båth</strong>) → posibles eventos **M~6**. Se recomienda
un <strong>pronóstico formal (Omori / Reasenberg-Jones): P[M≥6 en 7
días]</strong> para acotar la ventana de riesgo de cuadrillas
USAR/apuntalamiento, en vez del conteo bruto “300+”.</li>
<li><strong>Edificios 🟡 dañados</strong> son mucho más vulnerables a
réplicas → cordón/evacuación.</li>
<li><strong>Cascadas:</strong> sacudida + (posible) licuefacción +
(potencial) deslave por lluvia + tamizaje de
<strong>tsunami/seiche</strong>. San Sebastián es predominantemente
rumbo-deslizante (bajo potencial tsunamigénico), <strong>pero el
precedente de Palu 2018</strong> (falla transcurrente costera → tsunami
por deslizamiento submarino) obliga a <strong>tamizar tsunami</strong>
antes de concentrar heridos/equipos en la orilla y ubicar albergues
costeros.</li>
</ul>
<blockquote>
<p><strong>Escenarios, no profecías:</strong> la ciencia <strong>no
predice</strong> fecha/lugar/magnitud de un terremoto. Lo anterior es
<strong>peligro</strong> (probabilidad condicionada), no predicción.</p>
</blockquote>
<hr />
<h2
id="7-damnificados-y-áreas-afectadas-lente-gestión-de-desastres--rangos-con-fuentefecha">7.
Damnificados y áreas afectadas <em>(lente: gestión de desastres — RANGOS
con fuente/fecha)</em></h2>
<table>
<thead>
<tr>
<th>Indicador</th>
<th>Cifra</th>
<th>Fuente / fecha</th>
</tr>
</thead>
<tbody>
<tr>
<td>Fallecidos</td>
<td>235 → 920 → <strong>≈1.430</strong></td>
<td>El Tiempo 24/06; Univisión 26/06; Jorge Rodríguez/AN 27/06</td>
</tr>
<tr>
<td>Heridos</td>
<td><strong>3.238–3.360</strong></td>
<td>CNN/El Tiempo 25–27/06</td>
</tr>
<tr>
<td>“Desaparecidos” (≈ no contactados)</td>
<td><strong>50.000–68.900</strong></td>
<td>Univisión 26/06; Wikipedia/EN 27/06</td>
</tr>
<tr>
<td>Familias damnificadas</td>
<td><strong>3.142</strong></td>
<td>Jorge Rodríguez/AN 27/06</td>
</tr>
<tr>
<td>Edificios colapsados (La Guaira)</td>
<td><strong>100+</strong> (SISMO911: 102 reportados en costa)</td>
<td>Prensa / datos SISMO911</td>
</tr>
<tr>
<td>Distribución de fatalidades</td>
<td>prob. no trivial en rango <strong>decenas de
miles–&gt;100.000</strong></td>
<td>USGS PAGER (modelo, no cifra esperada)</td>
</tr>
</tbody>
</table>
<blockquote>
<p><strong>Cautelas:</strong> (1) cifras de la 1ª semana
<strong>volátiles y al alza</strong>; (2) distinguir
<strong>confirmado</strong> (oficial) vs <strong>modelado</strong>
(PAGER) vs <strong>reportado</strong> (ciudadano); (3) los
“desaparecidos” son mayormente <strong>caída de
telecomunicaciones</strong>, no sepultados — no usarlos como proxy de
víctimas atrapadas; (4) la cifra oficial proviene de <strong>fuente
política única</strong> (AN) — tratar con cautela.</p>
</blockquote>
<p><strong>Áreas afectadas (jerarquía, con el blind spot
explícito):</strong> 1) costa de La Guaira (Caraballeda, Maiquetía,
Catia La Mar, Macuto); 2) Caracas (mayor volumen; daño en Ciudad
Universitaria/UNESCO); 3) <strong>zona epicentral Yaracuy/Carabobo (San
Felipe, Yumare, Morón, Puerto Cabello) — probablemente subreportada,
prioridad de verificación</strong>; 4) focos dispersos (Maracay,
Valencia, Barquisimeto, Guarenas-Guatire).</p>
<p><strong>Refugios:</strong> se habilitó el <strong>Estadio José Luis
García Carneiro</strong> (mayor recinto de La Guaira).
<strong>Corrección del red-team:</strong> en LATAM el <strong>60–80% de
los desplazados se autoalberga</strong> con familias anfitrionas; la
demanda <strong>neta</strong> de albergue oficial es menor que el total
de damnificados — <strong>apoyar a familias anfitrionas</strong>
(transferencias, WASH, alimentos) además de centros colectivos. Los “11
refugios” del dataset son <strong>reportes</strong>, no un inventario
real de capacidad. Todo albergue debe estar <strong>estructuralmente
liberado, en suelo seguro y fuera de conos de deyección</strong>,
cumpliendo Sphere (≥3,5 m²/persona; ≥15 L agua/persona/día; 1
letrina/20).</p>
<hr />
<h2 id="8-recomendaciones-por-fase">8. Recomendaciones (por fase)</h2>
<p><strong>Respuesta inmediata (0–4 sem)</strong></p>
<ol type="1">
<li><strong>Verificación independiente del blind spot
epicentral</strong> (Copernicus EMS, ARIA/InSAR, ShakeMap USGS,
sobrevuelo) <strong>antes</strong> de fijar prioridades
geográficas.</li>
<li><strong>USAR/INSARAG</strong> sobre colapsos con señales de vida +
tipología con vacíos; <strong>Caraballeda apenas inicia su
búsqueda</strong> (estuvo aislada) → no aplicar mecánicamente la “regla
de 72 h”.</li>
<li><strong>Restablecer acceso a Caraballeda</strong> (puente caído):
puente provisional + corredor marítimo (evaluar Puerto de La Guaira,
muelles/playas de desembarco) + aéreo.</li>
<li><strong>Etiquetado ATC-20</strong>; cordonar 🔴, apuntalar/evacuar
🟡 ante réplicas.</li>
<li><strong>Tamizar riesgo NaTech/HAZMAT</strong> en zona epicentral
(<strong>Refinería El Palito, terminales de Puerto
Cabello/Maiquetía</strong>) y cortar gas/electricidad en zonas
colapsadas (hay 2 fugas de gas).</li>
<li><strong>Integridad hospitalaria + síndrome de aplastamiento</strong>
(diálisis), banco de sangre, cadena de frío, vigilancia epidemiológica
(contexto VE: difteria/sarampión/malaria) y WASH.</li>
<li><strong>Refugios Sphere</strong> en suelo seguro + apoyo a familias
anfitrionas; <strong>protección</strong> (VBG, trata de menores) y
<strong>apoyo psicosocial (MHPSS)</strong>.</li>
</ol>
<p><strong>Datos / coordinación (inmediato)</strong> 8. <strong>Corregir
el bug <code>people_trapped=0</code></strong> y reconciliar
incoherencias (95&gt;77, 19% sin clasificar, geocodificación). La
priorización USAR se rige por <strong>señales de vida + tipología +
acceso</strong>, no por nº de reportes. 9. <strong>Arquitectura de
coordinación:</strong> activar <strong>LEMA</strong>,
<strong>RDC</strong> en Maiquetía/aeródromo alterno,
<strong>OSOCC</strong> y solicitar <strong>UNDAC</strong>; resolver el
cuello político-jurídico (autoridad receptora reconocida,
<strong>sanciones OFAC/licencias</strong>, aduana/visados, mando
cívico-militar). Evaluar <strong>capacidad operativa de
Maiquetía</strong> (punto único de falla) y designar <strong>alterno
firme</strong>. 10. <strong>Atender poblaciones vulnerables:</strong>
menores, personas con discapacidad, adultos mayores,
embarazadas/neonatos, pacientes crónicos, <strong>personas privadas de
libertad</strong>, migrantes/retornados, indígenas.</p>
<p><strong>Recuperación temprana (1–6 m)</strong> 11. <strong>EDAN/PDNA
oficial</strong> que valide en campo los reportes ciudadanos. 12.
<strong>Demolición controlada</strong> de candidatos tras liberación
USAR + tamizaje hazmat; <strong>gestión de escombros/asbesto</strong>.
13. <strong>Gestión de fatalidades masivas (DVI, estándar
INTERPOL):</strong> morgues temporales, refrigeración, datos
ante-mortem, <strong>reunificación familiar (RFL del CICR)</strong>. 14.
<strong>Microzonificación FUNVISIS</strong> actualizada como base legal
del reordenamiento.</p>
<p><strong>Reconstrucción (6 m+) — Build Back Better</strong> 15.
Reconstruir <strong>a código COVENIN con enforcement</strong>, mejora de
suelo/fundaciones profundas en sedimento blando, <strong>reubicación
fuera de canales de flujo</strong>. 16. <strong>Costeo
paramétrico</strong> (nº edificios × costo/m² resiliente + mejora de
suelo + reubicación) para dimensionar la necesidad; el <strong>Fondo CAF
(US$1M semilla)</strong> es <strong>simbólico</strong> frente a la
magnitud — buscar financiamiento multilateral. 17. <strong>No repetir
1999/2026:</strong> prohibir reedificar en abanicos activos;
instrumentación sísmica, alerta y mitigación de quebradas; restablecer
<strong>telecomunicaciones</strong> (raíz del artefacto “desaparecidos”)
y revisar <strong>lifelines</strong> (energía/Guri, agua, presas aguas
arriba, viaducto Caracas–La Guaira).</p>
<hr />
<h2 id="9-revisión-adversarial-red-team-y-respuestas">9. Revisión
adversarial (Red-Team) y respuestas</h2>
<p>Tres revisores escépticos senior (estructural, geológico, gestión de
desastres) + un crítico de completitud atacaron el borrador.
<strong>Veredicto:</strong> <em>útil como borrador operativo, no apto
para decisión/comunicación sin endurecer.</em> Correcciones
incorporadas:</p>
<table>
<thead>
<tr>
<th>#</th>
<th>Crítica (severidad)</th>
<th>Respuesta / corrección aplicada</th>
</tr>
</thead>
<tbody>
<tr>
<td>1</td>
<td><strong>“71% de colapsos <em>nacionales</em>”</strong> trata datos
crowdsourced como censo (ALTO)</td>
<td>Reformulado a <strong>“71% de los colapsos
<em>reportados</em>”</strong>; degradado a indicador de priorización;
exigida normalización por parque edificado (§0, §3, §4).</td>
</tr>
<tr>
<td>2</td>
<td><strong>Grados EMS-98</strong> asignados a etiquetas de color sin
foto (ALTO)</td>
<td><strong>Eliminada</strong> toda asignación EMS-98; se explicita que
el color no es convertible a EMS-98 (§5.1).</td>
</tr>
<tr>
<td>3</td>
<td><strong>Licuefacción</strong> sobre-afirmada; abanicos de
debris-flow son gruesos/poco licuables (ALTO)</td>
<td>Separada <strong>amplificación (dominante)</strong> de
<strong>licuefacción (posible, a verificar)</strong>; sin evidencia de
campo (§6.1).</td>
</tr>
<tr>
<td>4</td>
<td><strong>1999 ≠ análogo sísmico</strong> (fue hidrometeorológico)
(ALTO)</td>
<td>Sustituido por <strong>1967 Caracas</strong> como análogo sísmico;
1999 reubicado como <strong>cascada por lluvia</strong> (§6.3).</td>
</tr>
<tr>
<td>5</td>
<td><strong>Punto ciego epicentral</strong> (Yaracuy/Carabobo
subreportado) (TIER 1)</td>
<td>Añadida advertencia destacada + <strong>acción #1</strong> de
verificación satelital (Advertencia, §0, §7, §8).</td>
</tr>
<tr>
<td>6</td>
<td><strong>Riesgo NaTech</strong> (Refinería El Palito, Puerto Cabello)
omitido (TIER 1)</td>
<td>Añadido a recomendaciones inmediatas (§8.5).</td>
</tr>
<tr>
<td>7</td>
<td><strong>Maiquetía punto único de falla</strong> + arquitectura
RDC/OSOCC/UNDAC/LEMA + cuello OFAC/cívico-militar (TIER 1)</td>
<td>Añadido (§8.9).</td>
</tr>
<tr>
<td>8</td>
<td><strong>Sistema de salud/hospitales, síndrome de aplastamiento,
contexto epidémico</strong> omitidos (TIER 1)</td>
<td>Añadido (§8.6).</td>
</tr>
<tr>
<td>9</td>
<td><strong>Bug <code>people_trapped=0</code></strong> no elevado a
bloqueante (TIER 1)</td>
<td>Elevado a <strong>acción de datos #1</strong> (§0, §8.8, §10).</td>
</tr>
<tr>
<td>10</td>
<td><strong>“Regla de 72 h”</strong> sobre-aplicada; Caraballeda aislada
apenas inicia búsqueda</td>
<td>Matizada; no aplicar mecánicamente (§8.2).</td>
</tr>
<tr>
<td>11</td>
<td><strong>Autoalbergue 60–80%</strong> ignorado → brecha de refugios
inflada</td>
<td>Incorporado; apoyo a familias anfitrionas (§7).</td>
</tr>
<tr>
<td>12</td>
<td><strong>Poblaciones vulnerables / protección / MHPSS</strong>
omitidas</td>
<td>Añadidas (§8.7, §8.10).</td>
</tr>
<tr>
<td>13</td>
<td><strong>PAGER</strong> mal caracterizado (“total potencial”)</td>
<td>Corregido a <strong>distribución de probabilidad por rangos</strong>
(§0, §7).</td>
</tr>
<tr>
<td>14</td>
<td><strong>Padrón CNE</strong> ingenuo para verificar desaparecidos
(excluye menores, politizable)</td>
<td>Reemplazado por admisiones hospitalarias, albergues, <strong>RFL
CICR</strong>, telecom, registro civil (§8.13).</td>
</tr>
<tr>
<td>15</td>
<td><strong>Tsunami / DVI / pronóstico Omori / costeo
paramétrico</strong> ausentes</td>
<td>Añadidos (§6.4, §8.13, §8.16).</td>
</tr>
<tr>
<td>16</td>
<td><strong>Incoherencia 95&gt;77</strong> y duplicados de topónimo</td>
<td>Reconocida; cifras por lugar tratadas como ±indicativas (§2,
§4).</td>
</tr>
</tbody>
</table>
<p><strong>Lo que el informe NO afirma como hecho</strong> (por
exigencia del red-team): que el 71% pruebe efecto de sitio; grados
EMS-98 desde color; licuefacción como mecanismo dominante; ventana de
rescate “cerrada a 96 h”; “desaparecidos” = sepultados; demolición por
categorías sin inspección.</p>
<hr />
<h2 id="10-limitaciones-y-vacíos-de-datos">10. Limitaciones y vacíos de
datos</h2>
<ul>
<li><strong>Datos no oficiales</strong> (96% comunidad, 2,4% con foto,
19% sin clasificar) con <strong>sesgo de adopción/político</strong> de
la plataforma fuente.</li>
<li><strong>Punto ciego epicentral</strong> (Yaracuy/Carabobo) — el daño
de campo cercano está probablemente subrepresentado.</li>
<li><strong><code>people_trapped</code> = 0</strong> pese a 9 reportes
de “atrapados” → <strong>subregistro del dato más sensible a la
vida</strong>; corregir captura/agregación.</li>
<li><strong>Topónimos duplicados/variantes</strong> e incoherencias
(95&gt;77) → conteos por lugar ±indicativos.</li>
<li><strong>Sin censo estructural oficial ni datos geotécnicos de
campo</strong> (boreholes, Vs30, freático) → efectos de sitio
<strong>inferidos</strong>, no medidos.</li>
<li><strong>Cifras de víctimas volátiles</strong>; “desaparecidos”
distorsionados por caída de telecomunicaciones.</li>
</ul>
<h2 id="11-fuentes">11. Fuentes</h2>
<ul>
<li>Wikipedia (ES/EN): <em>Terremotos de Venezuela de 2026 / 2026
Venezuela earthquakes</em>.</li>
<li>CNN en Español / CNN, Infobae, ReliefWeb (Situation Reports),
Britannica, El Tiempo, Univisión, Mundiario, La República — cobertura
24–27/06/2026.</li>
<li>FUNVISIS — <em>Geología de Vargas</em>; literatura del
<strong>terremoto de Caracas de 1967</strong> (efecto de sitio
Caraballeda/Macuto); SciELO/Dialnet — Tragedia de Vargas 1999.</li>
<li>USGS — PAGER, ShakeMap; Copernicus EMS / ARIA-InSAR (verificación
recomendada).</li>
<li>Datos primarios: SISMO911 <code>/api/danos-estructurales</code> (820
reportes, corte 28/06/2026), fuente
<code>sosvenezuela2026.com</code>.</li>
</ul>
<hr />
<p><em>Informe generado por SISMO911 con asistencia de IA (lentes
estructural · geológica · gestión de desastres) y <strong>revisión
adversarial multidisciplinaria</strong>. Las evaluaciones basadas en
reportes ciudadanos y/o imágenes son <strong>preliminares</strong> y no
sustituyen la inspección en sitio. Las cifras de víctimas son
<strong>rangos en evolución</strong>.</em></p>
`;

const PAGE = `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Informe de Daños — Costa de La Guaira · Terremoto VE 24-jun-2026 · SISMO911</title>
<meta name="description" content="Informe de evaluación de daños del terremoto doble de Venezuela (24-jun-2026, Falla de San Sebastián) en la costa de La Guaira: 820 reportes ciudadanos analizados con lentes estructural, geológica y de gestión de desastres, y revisión adversarial.">
<meta name="robots" content="index,follow"><link rel="canonical" href="https://sismo911.com/informe-danos">
<meta property="og:type" content="article"><meta property="og:site_name" content="SISMO911"><meta property="og:locale" content="es_VE">
<meta property="og:title" content="Informe de Daños — Costa de La Guaira (Terremoto VE 24-jun-2026)">
<meta property="og:description" content="71% de los colapsos reportados se concentran en la costa de La Guaira. Análisis multidisciplinario con revisión adversarial.">
<meta property="og:url" content="https://sismo911.com/informe-danos"><meta property="og:image" content="https://sismo911.com/og/og-default.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/logo.svg"><meta name="theme-color" content="#00173a">
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>body{background:#f5f7fa;margin:0}.report-wrap{max-width:900px;margin:0 auto;padding:24px 20px 60px;font-family:'Inter',Arial,sans-serif}
${REPORT_CSS}
.report-wrap h1,.report-wrap h2,.report-wrap h3,.report-wrap h4{font-family:'Public Sans',sans-serif}
@media(max-width:640px){.report-wrap{padding:14px}}
.toolbar{position:sticky;top:0;z-index:30;background:#00173a;color:#fff;display:flex;gap:14px;align-items:center;padding:10px 16px;flex-wrap:wrap}
.toolbar a{color:#fff;text-decoration:none;font-size:13px;font-weight:600}.toolbar a:hover{opacity:.75}.toolbar .sp{margin-left:auto}
.btn{background:#b3261e;color:#fff!important;padding:6px 12px;border-radius:6px}</style></head>
<body>
<div class="toolbar"><a href="/"><b>SISMO911</b></a><a href="/danos">Mapa de daños</a><a href="/estados">Estados</a><a href="/refugios">Refugios</a><span class="sp"></span><a class="btn" href="/informe-danos.pdf" download>Descargar PDF</a></div>
<div class="report-wrap">${REPORT_BODY}</div>
</body></html>`;

informeDanos.get('/informe-danos', (c) => c.html(PAGE));
