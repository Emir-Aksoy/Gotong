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

La forma a largo plazo de AipeHub es un **mercado gobernado de componentes
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

---

## 2. Los cuatro pilares

Este sistema está formado por cuatro cosas que **ya existen y ya están conectadas**.
No son maquinaria nueva — este documento nombra partes existentes como un sistema.

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

---

## 3. Cómo los cuatro pilares se refuerzan mutuamente

Los cuatro pilares no son cuatro cosas aisladas — son un **bucle de
auto-refuerzo**:

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

---

## 4. Lo que no hacemos (límite honesto)

- **Sin dinero / sin token / sin recompensa** (candidato C, descartado).
- **El marcador no clasifica personas**: clasifica cuánto se reutiliza una plantilla,
  no puntos personales gamificables.
- **La promoción no es automática**: ~5 PRs es un suelo, no un interruptor; la decisión
  final es un juicio humano + consenso lazy en un issue público, no un contador que se
  desbloquea.
- **No se inventa ninguna maquinaria nueva para ello**: los cuatro pilares son cosas que
  **ya existen y ya están conectadas**; este documento los nombra como un sistema, no
  añade un subsistema.

---

## 5. Documentos relacionados

| Quiero saber | Leer |
|---|---|
| Índice insignia + marcador de citas (pilares ①④) | [`zh/FLAGSHIP-TEMPLATES.md`](../zh/FLAGSHIP-TEMPLATES.md) |
| Proceso de decisión + escalera de mantenedores (pilar ②) | [`GOVERNANCE.md`](../../GOVERNANCE.md) |
| Lista de mantenedores actual (pilar ②) | [`MAINTAINERS.md`](../../MAINTAINERS.md) |
| Galería de plantillas instalación con un clic (pilar ③) | [`zh/TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) |
| Flujo de envío de plantillas de la comunidad (pilar ③) | [`templates/community/templates/README.md`](../../templates/community/templates/README.md) |
| Sitio de la comunidad sin cómputo (el otro objetivo de renderizado del marcador) | [`zh/COMMUNITY-SITE.md`](../zh/COMMUNITY-SITE.md) |
| La sala de estar de la comunidad (Discussions) | [`zh/COMMUNITY-DISCUSSIONS.md`](../zh/COMMUNITY-DISCUSSIONS.md) |
| 中文版 (Chino) | [`zh/RECOGNITION-SYSTEM.md`](../zh/RECOGNITION-SYSTEM.md) |
