# Plantillas insignia — hubs que una persona común puede importar y usar

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../FLAGSHIP-TEMPLATES.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

> Esta es una lista de plantillas **respaldadas**. "Insignia" no significa "las mejores," significa "las garantizamos": cada una incluye una **demo determinista** (un comando, sin clave, afirma su propio comportamiento), cada una hace pública su **postura de gobernanza** (qué puede tocar, qué no puede, dónde un humano es el guardián), y cada una está **mantenida**.
>
> ¿Quieres ver todas las plantillas (incluyendo el nivel comunitario)? La "Galería de plantillas → Flujos de trabajo" en la UI de administración. ¿Quieres enviar una tú mismo? [`templates/community/templates/`](../../templates/community/templates/). Los criterios de selección para esta lista están escritos en [`GOVERNANCE.md`](../../GOVERNANCE.md).

---

## Por qué estas

El diferenciador de AipeHub no es "poder llamar a la IA" — eso está en todas partes. Es que **te atreves a apuntar la IA a tu hogar, tu familia, tu dinero**, porque los límites son reales y son tuyos:

- **Un humano es el guardián de las acciones críticas.** Las reversibles (apagar una luz) simplemente ocurren; las irreversibles (cerrar una puerta con llave, gastar dinero, enviar datos de un niño) se suspenden y esperan que un humano lo confirme en la bandeja de entrada — el flujo de trabajo **no puede saltarse** ese guardián.
- **Las claves y los datos están en tu propio disco.** Las credenciales están cifradas en tu directorio `.aipehub/`. La federación con otro hub comparte una **capacidad**, no tu bóveda.
- **Sin decisiones de caja negra.** Cada despacho y resultado es una transcripción legible y de solo lectura. El framework nunca ejecuta el modelo; no hay juicios ocultos.

Cada plantilla a continuación son estos tres principios **aplicados a una cosa concreta**.

---

## De un vistazo

| Plantilla | Para quién | Dónde un humano es el guardián (postura de gobernanza) | Ejecútala (sin clave) |
|---|---|---|---|
| **smart-home-hub** Hogar inteligente | personas con dispositivos de hogar inteligente | luces/AA ocurren directamente; **cerrar la puerta con llave, activar la seguridad** esperan confirmación en la bandeja de entrada del residente | `pnpm demo:smart-home-hub` |
| **family-learning-hub** Aprendizaje familiar | padres que abren IA para sus hijos | los temas fuera de la lista blanca y los datos de un niño que salen **ambos requieren aprobación parental**; la suscripción y los datos se quedan en casa | `pnpm demo:family-learning-hub` |
| **cafe-ops** Operaciones del local | dueño / encargado de tienda pequeña | pago de horas extra: **el asistente solo sugiere, el encargado decide el dinero**; la programación de turnos necesita confirmación del encargado | `pnpm demo:cafe-ops` |
| **personal-coding-hub** Codificación personal | personas que quieren que la IA les ayude a escribir código | los comandos peligrosos (rm -rf / push --force) se suspenden esperando tu aprobación; la división del trabajo la decides tú | `pnpm demo:personal-coding-hub` |
| **codex-deepseek-hub** Codificación (Codex+DeepSeek) | igual, conjunto de modelos diferente | igual | `pnpm demo:codex-deepseek-hub` |
| **personal-research-hub** Investigación personal | personas con un montón de material para desenredar | compilación de solo lectura, convirtiendo material en bruto en una wiki interconectada | `pnpm demo:personal-research-hub` |
| **battle-monk-training** Crecimiento personal | personas que quieren un plan de entrenamiento diario | solo escribe tu propio registro de crecimiento; no da consejos médicos/psicológicos | `pnpm demo:battle-monk-training` |
| **warband-club** Club de afición | comunidad de interés / guerra grupal | el archivo compartido es de lectura/escritura para todos; las decisiones importantes pasan por la confirmación del líder | `pnpm demo:warband-club` |
| **tea-supply-link** Suministro entre organizaciones | tiendas que tratan con un proveedor | el pedido **necesita aprobación humana antes de cruzar las líneas organizacionales**; el proveedor cotiza el dinero, un humano decide | `pnpm demo:tea-supply-link` |
| **tea-chain-hq** Casa matriz de la cadena | sedes que gestionan tiendas franquiciadas | una directiva de reprices **necesita la aprobación del gerente regional antes del despliegue**; la tienda es una parte soberana, no un subordinado | `pnpm demo:tea-chain-hq` |

Cada una también viene con `pnpm demo:<nombre>:template` — lee ese archivo de plantilla, lo analiza y previsualiza la arquitectura que declara (sin subproceso, sin clave), para que veas "qué va empaquetado en la plantilla, qué vive fuera de ella."

---

## Hogar y familia

### ⭐ smart-home-hub — Hogar inteligente (Xiaomi via Home Assistant)

**Quién / qué.** Un mayordomo del hogar controla tus dispositivos Xiaomi (o cualquier dispositivo integrado con HA) a través de Home Assistant, ejecutando una "rutina de buenas noches."

**Qué puede tocar.** Apagar las luces de las áreas comunes, cambiar el AA del dormitorio al modo sueño — estas son acciones **reversibles**, simplemente se ejecutan.

**Dónde un humano es el guardián (postura de gobernanza).** Cerrar la puerta principal con llave y activar la seguridad son acciones **físicas/de seguridad irreversibles** — el flujo de trabajo, al llegar a este paso, **se suspende** y espera a que el residente haga clic en "confirmar" en la bandeja de entrada `/me` antes de ejecutarse. Rechazar → ese paso es omitido por el guardián `when:` → **la puerta permanece sin cerrar** (fail-closed, bloqueando la siguiente acción, sin desbordamiento). Esto es exactamente cómo se ve "las reversibles se hacen directamente, las irreversibles necesitan confirmación humana" aplicado en un hogar.

**Separación plantilla/framework.** El cableado MCP del dispositivo en la plantilla usa marcadores de posición `${HA_MCP_SSE_URL}` / `${HA_TOKEN}` — qué Home Assistant conectas y qué token usas es configuración en tiempo de ejecución que se rellena después de la importación. El flujo de trabajo solo nombra capacidades (`home.apply-scene` / `home.secure`), nunca un dispositivo específico. Cambia los dispositivos, cambia el hogar y el flujo de trabajo no cambia una palabra. Esta plantilla **no tiene ranura KB** (el estado del dispositivo es HA en vivo, no se necesita una base de conocimiento separada).

- Ejecútala: `pnpm demo:smart-home-hub` (dos escenarios: aprobar → la puerta se cierra con llave; rechazar → la puerta permanece sin cerrar)
- Plantilla: [`examples/smart-home-hub/template/smart-home-hub.template.yaml`](../../examples/smart-home-hub/template/smart-home-hub.template.yaml)
- Cableado de Home Assistant real: ver el [README](../../examples/smart-home-hub/README.md)

### ⭐ family-learning-hub — Aprendizaje familiar (padres que abren IA para hijos)

**Quién / qué.** Un padre paga por una suscripción de IA, el niño aprende en un hub **separado**; el hub del niño llama a la suscripción del padre mediante autorización, y un tutor de IA (una recreación de `/teach` de Matt Pocock: establecer primero la misión, un pequeño paso, conocimiento antes que habilidad, citar una fuente primaria) guía la exploración del niño. Esta es la **más endurecida para producción** de la lista (ws federation real + supervisión por IM + DeepSeek real, todo ejecutado).

**Qué puede tocar.** Dentro de los temas de la lista blanca, el tutor enseña directamente; la **copia principal** de los registros de aprendizaje está en el hub del niño.

**Dónde un humano es el guardián (postura de gobernanza) — cuatro guardianes.**

1. **Lista blanca de temas + autoevaluación de contenido** → los temas fuera de la lista blanca, y el contenido que el tutor autocalificó como `flagged`, **se suspenden esperando aprobación parental**.
2. **Guardián de clasificación de datos**: los datos del niño están etiquetados como `child-learning`, y no pueden enviarse a un tercero que no esté autorizado para esa clase de datos (fail-closed).
3. **Jurisdicción**: el padre tiene la suscripción (el estrangulamiento económico) + un contrato de confianza por enlace de federación + bifurcación de transcripción en todo momento (el padre recibe una copia de supervisión).
4. **Credenciales / datos se quedan en casa**: dos hubs soberanos, los datos del niño envían una copia al padre desde el lado del niño, pero la suscripción y la bóveda no cruzan.

**Separación plantilla/framework.** El enlace entre organizaciones (qué par de niño, qué capacidades están permitidas como salida, la política de aprobación, `allowedDataClasses`) es **configuración de par en tiempo de ejecución**, ni en la plantilla ni en el flujo de trabajo. Dos plantillas: `family-tutor` del lado del padre (con el tutor + flujo de trabajo de lista blanca/aprobación), `child-desk` del lado del niño (sin suscripción + la copia principal del registro de aprendizaje).

- Ejecútala: `pnpm demo:family-learning-hub` (seis escenarios, incluyendo fuera de la lista blanca→padre aprueba / padre rechaza→la lección no se imparte)
- Plantillas: [`family-tutor`](../../examples/family-learning-hub/template/family-tutor.template.yaml) · [`child-desk`](../../examples/family-learning-hub/template/child-desk.template.yaml)
- Despliegue real (dos máquinas soberanas): [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](../zh/FAMILY-LEARNING-GO-LIVE.md) · Diseño: [`FAMILY-LEARNING-HUB-DESIGN.md`](../zh/FAMILY-LEARNING-HUB-DESIGN.md)

---

## Productividad personal

### personal-coding-hub — Codificación personal (división del trabajo Claude Code + Codex)

**Quién / qué.** Un "modelo" de enrutamiento analiza la tarea + tiene en cuenta tu disposición, y decide si despachar el trabajo a Claude Code o Codex; los dos agentes de codificación comparten un directorio de trabajo y colaboran vía `AGENTS.md` (la especificación) + `PROGRESS.md` (el testigo de handoff). También hay **consulta adversarial**: cuando surge un problema, varios agentes leen el código juntos, diagnostican primero a ciegas luego se contrainterrogan, y votan para converger en la causa raíz real.

**Dónde un humano es el guardián (postura de gobernanza).** Los comandos peligrosos (`rm -rf`, `git push --force`, `sudo`, `curl | sh` …) se suspenden **antes** de ejecutarse esperando tu aprobación; rechazar → fail-closed, el comando nunca se ejecutó. La división del trabajo es **tuya para decidir**: nómbrala ad hoc ("dale este a codex") o cambia la capa general de división en lenguaje sencillo (estilo OpenClaw, escrito de vuelta a `routing-policy.json`).

**Separación plantilla/framework.** La plantilla lleva 1 agente mentor (`coding-mentor`, DeepSeek + mcp-obsidian en línea) + 1 ranura de KB direccionable (la biblioteca de metodología, un puntero `presetData`). Los dos agentes de codificación CLI se **conectan en tiempo de ejecución** (CliParticipant no entra en el roster de agentes gestionados); el **contenido** del conocimiento vive fuera de la plantilla.

- Ejecútala: `pnpm demo:personal-coding-hub` (10 escenarios: división del trabajo / asignación explícita / redivisión en lenguaje sencillo / guardián de seguridad)
- Consulta: `pnpm demo:personal-coding-hub:consult`
- Plantilla: [`examples/personal-coding-hub/template/personal-coding-hub.template.yaml`](../../examples/personal-coding-hub/template/personal-coding-hub.template.yaml)

### codex-deepseek-hub — Codificación (Codex + DeepSeek TUI)

La **hermana** de personal-coding-hub: un conjunto de modelos diferente — Codex (el implementador rápido) + DeepSeek TUI (el líder de razonamiento). El mismo enrutamiento + redivisión en lenguaje sencillo + asignación explícita + guardián de seguridad, autónomo y sin tocar personal-coding-hub.

- Ejecútala: `pnpm demo:codex-deepseek-hub`
- Plantilla: [`examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml`](../../examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml)

### personal-research-hub — Hub de investigación / conocimiento personal

**Quién / qué.** Un bibliotecario **compila** tu material de origen en bruto en una wiki Obsidian interconectada (LLM como compilador), luego te permite "preguntar a tu wiki." Tres agentes LLM gestionados (bibliotecario / compilador / investigador) se trasladan como equipo.

**Postura de gobernanza.** La compilación es una **transformación de solo lectura** de bruto a notas + backlinks; las respuestas citan fuentes y se archivan en `wiki/answers/`.

- Ejecútala: `pnpm demo:personal-research-hub`
- Plantilla: [`examples/personal-research-hub/template/personal-research-hub.template.yaml`](../../examples/personal-research-hub/template/personal-research-hub.template.yaml)

### battle-monk-training — Crecimiento personal (cuerpo / mente / conocimiento, tres pilares)

**Quién / qué.** Un preceptor despacha el entrenamiento de hoy a los tres pilares (cuerpo / mente / conocimiento), cada uno avanzando al siguiente rango basándose en los rangos ya entrenados en tu registro, con la continuidad como núcleo del diseño — el KB de Obsidian **almacena tu estado** (no el material de referencia). Un estilo monástico sombrío y frío (un homenaje fan original, dirigido a usuarios al estilo de Warhammer 40k).

**Postura de gobernanza / límite de seguridad.** **Solo escribe tu propio registro de crecimiento**; estos son datos personales, **no consejos médicos / psicológicos** — no los trates como la única base para nada.

- Ejecútala: `pnpm demo:battle-monk-training`
- Plantilla: [`examples/battle-monk-training/template/battle-monk-training.template.yaml`](../../examples/battle-monk-training/template/battle-monk-training.template.yaml)

---

## Organizaciones y entre organizaciones

### cafe-ops — Operaciones del local (tienda de bubble tea / café)

**Quién / qué.** Los procesos formales de una tienda pequeña: incorporación de nuevos empleados (aprendizaje del SOP del puesto, autoservicio del miembro), programación de turnos (confirmación del encargado), pago de horas extra (aprobación del encargado). La primera plantilla con `workflows[]` no vacío — el valor de una organización está en el proceso formal.

**Dónde un humano es el guardián (postura de gobernanza).** Pago de horas extra: **el asistente solo sugiere la cantidad, el encargado decide el dinero**: el asistente calcula el multiplicador por tipo de día (día laborable 1,5 / día de descanso 2 / día festivo 3), pero el flujo de trabajo, al llegar al paso de aprobación, se suspende y solo se promulga una vez que el encargado aprueba en la bandeja de entrada. **El dinero se calcula de forma determinista, no por un LLM; un humano decide.**

- Ejecútala: `pnpm demo:cafe-ops` (incluye la reanudación en dos pasos de horas extra con HITL)
- Plantilla: [`examples/cafe-ops/template/cafe-ops.template.yaml`](../../examples/cafe-ops/template/cafe-ops.template.yaml)

### warband-club — Club de afición (archivo compartido)

**Quién / qué.** La **cara de colaboración** de una comunidad de interés / tropa de guerra (versus la cara de gestión de cafe-ops): un archivo compartido que todo el grupo lee y escribe — el esquema de pintura / informe de batalla que tú envías, otros pueden buscar; la respuesta que recibes puede provenir de la contribución anterior de alguien más = colaboración.

**Postura de gobernanza.** El archivo compartido es de lectura/escritura para todos; las decisiones importantes (una convocatoria) pasan por la confirmación `human:` del líder. Compartido dentro de un hub, sin federación.

- Ejecútala: `pnpm demo:warband-club`
- Plantilla: [`examples/warband-club/template/warband-club.template.yaml`](../../examples/warband-club/template/warband-club.template.yaml)

### tea-supply-link — Suministro entre organizaciones (tienda de té ↔ proveedor)

**Quién / qué.** La primera plantilla **entre organizaciones**: el flujo de trabajo de reabastecimiento de una tienda de té orquesta un paso hasta **el hub del proveedor**.

**Dónde un humano es el guardián (postura de gobernanza).** El paso de pedido entre organizaciones pasa por un **guardián de aprobación de salida** (transparente al flujo de trabajo, por lo que el flujo de trabajo **no** tiene paso `human:`) — solo después de que el encargado aprueba cruza el límite, el proveedor cotiza línea por línea por catálogo + inventario en vivo, y el recibo fluye de vuelta para archivarse localmente. El proveedor calcula el dinero, un humano decide enviarlo.

**Separación plantilla/framework (punto de enseñanza).** El enlace entre organizaciones (qué par es el proveedor, qué capacidades están permitidas como salida, la política de aprobación) es **configuración de par en tiempo de ejecución**, ni en la plantilla ni en el flujo de trabajo — el paso `place` solo escribe la capacidad `supplier.confirm-order`, nunca nombrando un par.

- Ejecútala: `pnpm demo:tea-supply-link`
- Plantilla (lado de la tienda): [`examples/tea-supply-link/template/tea-shop.template.yaml`](../../examples/tea-supply-link/template/tea-shop.template.yaml)
- Runbook de operador de dos máquinas: [`docs/zh/FEDERATION-RUNBOOK.md`](../zh/FEDERATION-RUNBOOK.md)

### tea-chain-hq — Casa matriz de la cadena (sede → tiendas franquiciadas)

**Quién / qué.** El **espejo, dirección inversa** de tea-supply-link: ese va hacia arriba (tienda→proveedor), este va hacia abajo (sede→tienda franquiciada). En la cadena de tres capas `sede → tienda → proveedor`, la tienda está en el medio.

**Dónde un humano es el guardián (postura de gobernanza).** El paso entre organizaciones de desplegar una directiva de reprices pasa por un guardián de aprobación de salida — solo después de que el gerente regional aprueba cruza el límite, la tienda aplica de forma determinista el reprices según su propio menú, y el recibo fluye de vuelta. **La tienda es una organización soberana, no un objeto subordinado.**

- Ejecútala: `pnpm demo:tea-chain-hq`
- Plantilla (lado de la sede): [`examples/tea-chain-hq/template/chain-hq.template.yaml`](../../examples/tea-chain-hq/template/chain-hq.template.yaml)

---

## Ejecuta cualquiera con un solo comando (determinista, sin clave)

Cada insignia tiene una **demo determinista**: ejecuta el flujo completo con sustitutos deterministas, afirmando su propio comportamiento, sin clave API, sin dispositivo real / cuenta real necesaria. Esta es la mitad verificable de "la garantizamos" — un comando prueba que realmente funciona:

```bash
pnpm demo:smart-home-hub          # hogar: aprobar→la puerta se cierra con llave / rechazar→la puerta permanece sin cerrar
pnpm demo:family-learning-hub     # familia: fuera de la lista blanca→padre aprueba / padre rechaza→la lección no se imparte
pnpm demo:cafe-ops                # local: horas extra con HITL, el encargado decide el dinero
pnpm demo:personal-coding-hub     # codificación: división del trabajo + guardián de seguridad
pnpm demo:personal-research-hub   # investigación: bruto → wiki interconectada
pnpm demo:battle-monk-training    # crecimiento: cuerpo/mente/conocimiento tres pilares
pnpm demo:warband-club            # club: archivo compartido + confirmación del líder
pnpm demo:tea-supply-link         # entre orgs: el pedido entre límites necesita aprobación humana
pnpm demo:tea-chain-hq            # cadena: el despliegue de reprices necesita aprobación humana
pnpm demo:codex-deepseek-hub      # codificación (Codex + DeepSeek)
```

Para ver cómo se analiza la plantilla misma (una vista previa de carga, también sin clave): reemplaza cualquiera de los anteriores con `pnpm demo:<nombre>:template`.

---

## Usarla de verdad

La demo determinista prueba que la lógica funciona; para realmente usar una insignia, toma estas rutas:

- **Instalación con un clic**: haz clic en una en la "Galería de plantillas → Flujos de trabajo" de la UI de administración y se instala en tu hub (ver [`docs/zh/TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md)).
- **Comparación de hub personal / org + incorporación real de DeepSeek/Obsidian**: [`docs/zh/HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md).
- **Puesta en marcha (tres topologías)**: [`docs/zh/GO-LIVE.md`](../zh/GO-LIVE.md).
- **Runbook de dos máquinas para federación entre organizaciones**: [`docs/zh/FEDERATION-RUNBOOK.md`](../zh/FEDERATION-RUNBOOK.md).
- **Despliegue de dos máquinas soberanas para aprendizaje familiar**: [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](../zh/FAMILY-LEARNING-GO-LIVE.md).

---

## Clasificación de citas (quién ha adaptado más)

La procedencia honesta es la única moneda de esta comunidad. Cuando haces fork de una plantilla, escribe su slug en tu `provenance.derivedFrom` — y el crédito fluye de vuelta hacia el upstream. La tabla a continuación clasifica por "cuántas plantillas declaran `derivedFrom` apuntando a ella" (veces citada = in-degree), **generada de forma determinista** por [`pnpm build:leaderboard`](../../packages/web/scripts/build-leaderboard-doc.mjs) desde el corpus de plantillas validado, el mismo cálculo que el de la [tienda estática](../COMMUNITY-SITE.md):

> Nota: el generador de clasificación actualmente escribe los marcadores en la fuente china ([`docs/zh/FLAGSHIP-TEMPLATES.md`](../zh/FLAGSHIP-TEMPLATES.md)). La instantánea a continuación es un espejo manual de esa tabla generada; reconectar el generador para apuntar a este documento en inglés es un seguimiento rastreado.

| # | Plantilla | Veces citada | Adaptada por |
|---|---|---|---|
| 1 | **Mentor de codificación personal (flujo de trabajo Karpathy)** (`personal-coding-hub`) | 1 | Mentor de codificación en pareja (Codex × DeepSeek TUI) |
| 2 | **Tienda de té (enlace de suministro entre organizaciones)** (`tea-supply-link`) | 1 | Sede de cadena de té (despliegue de directiva entre organizaciones) |

> La tabla está **generada**: después de añadir una arista `derivedFrom`, ejecuta `pnpm build:leaderboard` para volver a renderizar la fuente. `packages/web/tests/build-leaderboard-doc.test.ts` vigila que se mantenga sincronizada con el corpus real — editar a mano u olvidar volver a renderizar es detectado por el test. La clasificación clasifica **plantillas**, no personas — es un incentivo de **reconocimiento**, no una recompensa ni económica (ver [`docs/zh/RECOGNITION-SYSTEM.md`](../zh/RECOGNITION-SYSTEM.md) / [`RECOGNITION-SYSTEM.md`](../RECOGNITION-SYSTEM.md)).

---

## Quiero contribuir con una

Las insignias son pocas y respaldadas. La gran mayoría de las plantillas deberían ser del **nivel comunitario** — el listón es "licencia clara, se analiza, sin secretos en texto plano, tiene procedencia," no "garantizamos tu gusto." El flujo está en [`templates/community/templates/README.md`](../../templates/community/templates/README.md): copia una insignia → adáptala a la tuya → declara procedencia (`derivedFrom`) → `pnpm check:templates` localmente → abre un PR.

La procedencia honesta es la moneda de esta comunidad: `derivedFrom` hace fluir el crédito hacia el upstream, y la clasificación de citas estática simplemente cuenta "cuántas plantillas derivan de ti." La promoción del nivel comunitario al de insignia es una decisión del mantenedor en un issue público — los criterios están en [`GOVERNANCE.md`](../../GOVERNANCE.md).
