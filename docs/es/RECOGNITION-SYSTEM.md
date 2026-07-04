# Sistema de reconocimiento

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../RECOGNITION-SYSTEM.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

> Este sistema otorga **solo reconocimiento** — sin dinero, sin token, sin recompensa.
> Su "moneda" es la procedencia honesta, la atribución visible y un camino documentado
> hacia una voz real sobre la dirección del proyecto.
>
> 中文版 / Chino: [`zh/RECOGNITION-SYSTEM.md`](../zh/RECOGNITION-SYSTEM.md) ·
> Última actualización: 2026-06-27

---

## 1. Por qué solo reconocimiento

La forma a largo plazo de Gotong es un **mercado gobernado de componentes
reutilizables** — plantillas, adaptadores, conectores de bases de conocimiento —
construido para que las personas confíen en él lo suficiente como para apuntarlo a su
hogar, su familia o su dinero (ver [`GOVERNANCE.md`](../../GOVERNANCE.md) § "Path to a
component committee"). Para que un mercado viva, los contribuidores necesitan un motivo
para entregar su buen trabajo — y para seguir manteniéndolo.

Sopesamos cuatro candidatos y **solo hacemos los dos primeros**:

| Candidato | Qué es | Decisión |
|---|---|---|
| **A — marcador de citas en FLAGSHIP** | Renderizar el ranking "quién se bifurca más" en un documento registrado en el repositorio, visible sin desplegar un sitio estático. | ✅ hacer |
| **B — una escalera de mantenedores cuantificada** | Dar al camino de promoción de `GOVERNANCE.md` una medida **ligera y medible** + un `MAINTAINERS.md`. | ✅ hacer |
| **C — una capa económica / de recompensas** | Recompensas, tokens, reparto de ingresos. | ❌ descartar |
| **D — no hacer nada** | Mantener el statu quo. | ❌ descartar |

**Descartar C es deliberado, no perezoso.** La estrella del norte dice que el framework
no ejecuta el LLM, el estado son archivos en disco, las credenciales se quedan locales,
la federación es entre pares — y una capa de incentivos que introduce dinero
ensuciaría inmediatamente ese modelo de confianza: ¿quién custodia el libro mayor?
¿cómo se liquida una división de ingresos entre hubs? ¿quién tiene la autoridad para
fijar un precio? Cada uno de estos arrastra el proyecto de vuelta hacia un centro,
lejos de "el Hub es tonto y las decisiones viven con los participantes." **Un sistema de
reconocimiento puro es nativamente file-first y nativamente descentralizado:** la
atribución es una línea `provenance` en un archivo de plantilla, el marcador es un
cálculo determinista, la promoción es consenso lazy en un issue público — ninguno de
ellos necesita un depósito de dinero central.

Así que la "moneda" de este sistema son tres cosas, y ninguna cuesta nada:

1. **Procedencia honesta** — `provenance.derivedFrom` fluye el crédito de vuelta
   upstream.
2. **Atribución visible** — el marcador y el índice insignia ponen tu nombre en el lugar
   más visible.
3. **Un camino documentado hacia una voz** — el buen trabajo sostenido gana la condición
   de mantenedor y una voz real, no un pago.

Esas tres son también la prueba para cualquier cosa que *añadamos* al sistema: tiene que
no costar nada y tirar hacia archivos-y-personas, no hacia un centro. **El pilar ⑤ a
continuación — reconocer la difusión — es la única extensión deliberada.** Amplía la
*atribución visible* para cubrir el trabajo de llevar el proyecto a las personas, que los
cuatro pilares originales, todos anclados en artefactos dentro del repositorio,
estructuralmente no pueden ver. No introduce dinero ni un backend de rastreo; son dos
archivos markdown.

---

## 2. Los pilares

Este sistema está formado por cinco pilares. Los cuatro primeros (①–④) **ya existen y
ya están conectados** — este documento nombra partes existentes como un sistema en lugar
de inventar un subsistema. El quinto (⑤) es la **única adición deliberada**: dos
artefactos ligeros y file-first que reconocen el trabajo de *llevar el proyecto a las
personas* — el trabajo que los cuatro primeros estructuralmente no pueden ver.

### Pilar ① — el marcador de citas (el crédito fluye de vuelta)

> "Quién se remezcla más" es "quién es más útil."

Cada manifiesto de plantilla lleva un `provenance.derivedFrom`. Cuando bifurcas una
plantilla, escribes el slug upstream en tu propio `derivedFrom`. El marcador ordena por
**grado de entrada** — cuántas plantillas se declaran derivadas de ti.

- **Mecanismo**: las funciones puras `loadCorpus` + `buildModel` en
  `packages/web/scripts/build-site.mjs` calculan el grado de entrada desde el corpus
  validado.
- **Dos objetivos de renderizado, un cálculo**:
  - El sitio estático ([`zh/COMMUNITY-SITE.md`](../zh/COMMUNITY-SITE.md)) lo renderiza;
  - El **documento registrado** (la sección "marcador de citas" de
    [`zh/FLAGSHIP-TEMPLATES.md`](../zh/FLAGSHIP-TEMPLATES.md)) también lo renderiza —
    este es el **pilar A**, escrito en un bloque marcador
    `<!-- LEADERBOARD:START -->` por `pnpm build:leaderboard`
    (`build-leaderboard-doc.mjs`). Puedes ver el ranking en el repositorio sin
    desplegar jamás un sitio estático.
- **Guardia contra desvíos**: `packages/web/tests/build-leaderboard-doc.test.ts`
  re-renderiza desde el corpus real y afirma que el bloque registrado es
  byte-idéntico — añade un borde `derivedFrom` pero olvida volver a ejecutar
  `pnpm build:leaderboard`, y el CI nombra el fallo en lugar de dejar que la tabla
  se pudra silenciosamente.
- **Clasifica plantillas, no personas.** Este es el límite honesto que importa: el
  marcador mide cuánto se reutiliza un *componente*; no ejecuta un culto a la
  personalidad ni acuña puntos de recuento gamificables.

### Pilar ② — la escalera de mantenedores (un camino hacia una voz)

> El punto final de la buena contribución es **confianza + responsabilidad**, no un
> premio.

"Becoming a maintainer" de `GOVERNANCE.md` da una medida **deliberadamente ligera y
medible** (este es el **pilar B**):

- **Un historial, no un recuento**: del orden de ~5 PRs fusionados no triviales — o el
  equivalente (una plantilla insignia que mantienes, un adaptador sustancial, revisión /
  clasificación sostenida) — durante un par de meses. El número es un **suelo** para
  "hemos visto suficiente de tu juicio," nunca un **objetivo** que cosechar con PRs de
  paso.
- **Sensibilidad a la línea de diseño**: tus PRs y revisiones muestran que buscas un
  *participante*, no el Hub, cuando la lógica necesita un hogar (ver `GOVERNANCE.md` §
  "The one non-negotiable").
- **Nominado en abierto**: un mantenedor existente te nomina en un issue público
  (la auto-nominación está bien); el consenso lazy pasa, el guardián confirma y tu
  nombre llega a [`MAINTAINERS.md`](../../MAINTAINERS.md) en ese mismo PR.

`MAINTAINERS.md` hoy solo tiene al mantenedor fundador. El punto completo de ese
archivo es que el **segundo** mantenedor se une por un camino que está **escrito**, no
por una palmada en el hombro — una línea de responsabilidad nunca debería ser un
hábito no escrito. Cuando el volumen de contribuciones crezca lo suficiente como para
que la curación sea un trabajo permanente, `GOVERNANCE.md` ya registra el plan para
establecer un **comité de componentes**.

### Pilar ③ — compartir sin fricción (hacer que entregarlo sea barato)

> La fricción es el enemigo del incentivo. Instalar una plantilla es un clic; enviar
> una no debería ser veinte pasos.

- **Instalación con un clic**: la **galería de plantillas** en el panel "Workflows" de
  administración ([`zh/TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md)) lista las
  plantillas curadas enviadas con el framework, instalación con un clic reutilizando el
  `POST /templates/import` existente.
- **Envío en cinco pasos**: el flujo de envío de plantillas de la comunidad vive en
  [`templates/community/templates/README.md`](../../templates/community/templates/README.md)
  — copia una insignia → hazla tuya → declara la procedencia → ejecuta
  `pnpm check:templates` localmente → abre un PR.
- **La barra es seguridad y honestidad, no gusto**: el nivel de comunidad solo pide
  "licencia clara, analiza correctamente, cero secretos en texto plano, procedencia
  declarada" (`GOVERNANCE.md` § "Community templates"); alcánzalo y se fusiona. En este
  nivel curamos *seguridad y honestidad*, no tu gusto.

La conveniencia en sí misma es un incentivo: cuanto más barato sea entregar una
plantilla, más personas publicarán los buenos flujos de trabajo que acaparan
privadamente — y cada publicación honesta y atribuida le da al upstream una cita más
del pilar ①.

### Pilar ④ — ejemplares compartidos (cosas que vale la pena remezclar)

> Un marcador necesita cosas que citar; primero debe haber ejemplares que valgan la
> pena citar.

- **Nivel insignia**: [`zh/FLAGSHIP-TEMPLATES.md`](../zh/FLAGSHIP-TEMPLATES.md) — un
  pequeño conjunto curado que el proyecto avala y recomienda a un usuario no técnico.
  La barra es más alta (demo determinista + postura de gobernanza clara + un
  mantenedor, ver `GOVERNANCE.md` § "Flagship templates").
- **Galería integrada**: las plantillas incrustadas con el framework, instalables con
  un clic desde la UI de administración.
- **examples/**: demos de extremo a extremo, cada uno un punto de partida bifurcable.

Los ejemplares son la **semilla** del bucle: sin buenos ejemplares, compartir sin
fricción no tiene nada que compartir y el marcador no tiene nada que clasificar. Escribe
bien un ejemplar, declara su postura de gobernanza claramente, y las personas lo
bifurcan, lo citan y hacen crecer su propio trabajo encima de él.

<a id="pillar-5"></a>

### Pilar ⑤ — reconocer la difusión (el alcance es trabajo real)

> Un buen producto solo mejora llegando a las personas. Los cuatro pilares anteriores
> recompensan el trabajo que deja rastro *dentro del repositorio*; llevar el proyecto
> *a las personas* no deja ninguna arista `derivedFrom` — así que sin un quinto pilar
> permanece invisible.

Los cuatro primeros pilares comparten un punto ciego: están anclados en artefactos
dentro del repositorio. El marcador cuenta aristas de `provenance`; la escalera de
mantenedores cuenta PRs fusionados; ambos son ciegos a la persona que escribe el
tutorial que por fin hace que la federación encaje, da la charla que trae a cincuenta
personas al proyecto, gestiona el espacio donde los nuevos usuarios dejan de estar
perdidos, o traduce la documentación a un idioma que el equipo central no habla. **Ese
trabajo es la diferencia entre un buen framework que nadie descubre y un buen framework
que la gente realmente usa** — y la mayoría del código abierto lo infraacredita. En la
era de la IA la brecha es más aguda: construir es más barato que nunca, así que el
trabajo escaso y decisivo es *el descubrimiento y la confianza* — y ese es exactamente
el trabajo que los cuatro primeros pilares no pueden ver. Reconocerlo es un
diferenciador deliberado, no una ocurrencia tardía.

Así que el pilar ⑤ añade dos artefactos ligeros y file-first — y nada más pesado:

- **Un registro tipificado de contribuidores — [`CONTRIBUTORS.md`](../../CONTRIBUTORS.md).** Una
  tabla mantenida a mano que registra *todo* tipo de contribución, grande o pequeña,
  junto al código, usando el vocabulario de emoji de [All Contributors](https://allcontributors.org)
  — 💻 código, 📖 docs, 🌍 traducción, 📝 blog, 📹 vídeo, 📢 charla, ✅ tutorial,
  💬 apoyo a la comunidad, 📋 organización de eventos. Es **un registro, no un
  ranking**: declara *lo que hiciste*, en abierto, con tu nombre — no ordena a las
  personas por un número. Un esfuerzo significativo de difusión aterriza en el registro
  igual que una funcionalidad fusionada, y ningún esfuerzo es demasiado pequeño para
  registrar. Usamos la *taxonomía* de All Contributors pero **no** su bot ni su
  GitHub Action (el repositorio no gasta presupuesto de Actions en contabilidad, y una
  tabla markdown es la cosa más ligera y honesta); se te añade con un PR normal.
- **Un escaparate curado de aprendizaje — [`LEARN.md`](../../LEARN.md).** El mejor material
  comunitario para aprender Gotong — vídeos, charlas, tutoriales, posts — cada uno
  acreditado a su autor y enlazado desde el README. Este es el **análogo de difusión del
  pilar ④**: las plantillas insignia son las mejores cosas para *mezclar*; las entradas
  de LEARN son las mejores cosas *de las que aprender*. Curar el vídeo de alguien aquí
  es un acto concreto y visible de reconocimiento — y también es el lugar al que va un
  nuevo usuario para aprender del mejor material que la comunidad ha hecho.

**Lo que reconocemos es el trabajo de alcanzar — no un número de alcance.** Deliberadamente
*no* construimos un "marcador de difusión" basado en vistas, seguidores o recuentos de
referidos: son manipulables, necesitarían un backend de rastreo que el North Star no
quiere (el Hub es tonto; el estado son archivos), y arrastrarían el proyecto hacia la
vanidad. No podemos medir honestamente "cuántas personas trajo tu vídeo", pero *sí*
podemos registrar honestamente "hiciste el vídeo" y *sí* podemos curar "este vídeo es
suficientemente bueno como para enviar nuevos usuarios a él." Eso registra la
contribución y evita la trampa métrica en un solo movimiento — de la misma manera que el
pilar ① **clasifica plantillas, no personas**, el pilar ⑤ **registra y cura trabajo, no
tamaño de audiencia**.

Y la difusión gana standing, no solo una fila: la escalera de mantenedores de
`GOVERNANCE.md` cuenta el trabajo sostenido de difusión — stewardship de localización,
gestión de la comunidad, material educativo sostenido — como una **vía equivalente** al
código hacia una voz real en el proyecto (pilar ②). Una persona que nunca escribe una
línea de código del framework pero mantiene la documentación viva en tres idiomas y
responde a los nuevos usuarios cada semana está contribuyendo exactamente el tipo de
juicio sostenido que la escalera busca reconocer.

---

## 3. Cómo los pilares se refuerzan mutuamente

Los pilares ①–④ no son cuatro cosas aisladas — son un **bucle de
auto-refuerzo** que gira una vez que una persona ya está dentro del repositorio:

```
   ④ ejemplares  ──bifurcar──▶  ③ compartir sin fricción  ──PR + procedencia honesta──▶  ① marcador
        ▲                                                                                     │
        │                                                                   citado = atribución visible
        │                                                                                     │
        └──────────────  buen trabajo sostenido  ◀──②  escalera de mantenedores  ◀──────────┘
                       (nuevos ejemplares / manteniendo los viejos / revisando los de otros)
```

1. Empiezas desde un **ejemplar insignia (④)**;
2. lo haces tuyo, lo entregas a través de **compartir sin fricción (③)**, y
   **atribuyes honestamente** al upstream en `provenance`;
3. tu procedencia honesta añade una **cita (①)** al upstream, que sube en el
   marcador — el crédito fluye de vuelta;
4. tu propia plantilla comienza a bifurcarse y citarse, y tu nombre llega al
   marcador y al índice insignia;
5. el buen trabajo sostenido (nuevos ejemplares, mantener los viejos, revisar los de
   otros) te sube por la **escalera de mantenedores (②)** hacia la confianza y una
   voz — y como mantenedor avales nuevos ejemplares insignia (④), y el bucle gira
   de nuevo.

**Ningún paso necesita dinero.** Lo que impulsa el bucle completo es "mi cosa es
útil, la gente la usa, mi nombre está en abierto, y lo que digo empieza a contar" —
reconocimiento puro, y exactamente suficiente.

**Dónde encaja el pilar ⑤.** El bucle anterior es el volante *dentro del repositorio*
— gira una vez que una persona ya está aquí. El pilar ⑤ amplía la boca del embudo: el
trabajo de difusión (una charla, un vídeo, una traducción, una sala de comunidad
próspera) es cómo una persona *llega* a los ejemplares en primer lugar, y cómo el trabajo
que luego publica encuentra su propia audiencia. No cambia el bucle de cuatro pilares;
alimenta personas hacia él y lleva el output del bucle hacia afuera. Reconocerlo mantiene
visibles a las personas que hacen ese trabajo, en lugar de tratar la distribución como
algo que simplemente ocurre.

---

## 4. Lo que no hacemos (límite honesto)

- **Sin dinero / sin token / sin recompensa** (candidato C, descartado).
- **El marcador no clasifica personas**: clasifica cuánto se reutiliza una plantilla,
  no puntos personales gamificables.
- **Reconocemos el trabajo de difusión, no una puntuación de difusión**: sin marcador
  de vistas / seguidores / referidos — esos son manipulables y necesitarían un backend
  de rastreo que el North Star rechaza. [`CONTRIBUTORS.md`](../../CONTRIBUTORS.md)
  registra *lo que hiciste*; [`LEARN.md`](../../LEARN.md) cura *de qué vale la pena
  aprender*; ninguno ordena a las personas por tamaño de audiencia.
- **La promoción no es automática**: ~5 PRs es un suelo, no un interruptor; la decisión
  final es un juicio humano + consenso lazy en un issue público, no un contador que se
  desbloquea.
- **Casi ninguna maquinaria nueva**: los pilares ①–④ son cosas que **ya existen y ya
  están conectadas**. El pilar ⑤ añade exactamente dos archivos markdown mantenidos a
  mano (`CONTRIBUTORS.md`, `LEARN.md`) — sin bot, sin GitHub Action, sin servicio de
  rastreo. Esa es toda la superficie "nueva", y es deliberadamente la cosa más ligera que
  podría funcionar.

---

## 5. Documentos relacionados

| Quiero saber | Leer |
|---|---|
| Índice insignia + marcador de citas (pilares ①④) | [`zh/FLAGSHIP-TEMPLATES.md`](../zh/FLAGSHIP-TEMPLATES.md) |
| Proceso de decisión + escalera de mantenedores (pilar ②) | [`GOVERNANCE.md`](../../GOVERNANCE.md) |
| Lista de mantenedores actual (pilar ②) | [`MAINTAINERS.md`](../../MAINTAINERS.md) |
| Registro tipificado de contribuidores — todos los tipos de contribución (pilar ⑤) | [`CONTRIBUTORS.md`](../../CONTRIBUTORS.md) |
| Escaparate curado de aprendizaje / vídeos (pilar ⑤) | [`LEARN.md`](../../LEARN.md) |
| Galería de plantillas instalación con un clic (pilar ③) | [`zh/TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) |
| Flujo de envío de plantillas de la comunidad (pilar ③) | [`templates/community/templates/README.md`](../../templates/community/templates/README.md) |
| Sitio de la comunidad sin cómputo (el otro objetivo de renderizado del marcador) | [`zh/COMMUNITY-SITE.md`](../zh/COMMUNITY-SITE.md) |
| La sala de estar de la comunidad (Discussions) | [`zh/COMMUNITY-DISCUSSIONS.md`](../zh/COMMUNITY-DISCUSSIONS.md) |
| 中文版 (Chino) | [`zh/RECOGNITION-SYSTEM.md`](../zh/RECOGNITION-SYSTEM.md) |
