# Descripción general de Gotong · Mapa en 5 minutos

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../OVERVIEW.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

> ¿Buscas la versión en chino? → [`docs/zh/OVERVIEW.md`](../zh/OVERVIEW.md)
>
> Esta es la **página de mapa de una sola página** del proyecto. Al terminar sabrás qué
> es Gotong, qué hay bajo qué, cómo se conectan los participantes, de dónde vienen
> las plantillas, cómo colaboran algunas personas juntas y cómo federan las
> organizaciones sin entregar sus claves. Cada sección termina con un enlace → a la
> siguiente lectura cuando quieras profundizar.

---

## En una frase

**Gotong** es un **espacio de trabajo de colaboración auto-alojado para TypeScript y
Python**: personas y agentes de IA comparten una misma "sala", y un Hub
deliberadamente tonto despacha tareas, recoge resultados y registra toda la ejecución.

**No es un framework de agentes** (no ejecuta el LLM) — es un **sustrato
para la colaboración de múltiples participantes**, donde las organizaciones pueden
federar **sin entregar sus claves, datos ni facturación**.

---

## Qué es — y qué hay *debajo*

La mayoría de los proyectos "agente" son un agente o un framework para escribir el
bucle de un agente (LangGraph, CrewAI, AutoGen). Gotong no es **ninguno de los dos**
— es la capa en la que ellos se conectan. Un grafo de LangGraph, un equipo de CrewAI,
un agente de codificación CLI (Claude Code, Codex), un agente externo A2A y un humano
se unen a la misma sala como el mismo `Participant`. El Hub enruta sus mensajes,
despacha tareas, registra el transcript y hace cumplir los límites — **nunca ejecuta el
LLM**, por lo que cada decisión se queda con el participante.

Tres cosas lo convierten en algo más que un bus de mensajes:

- **Participantes iguales** — un humano es un `Participant`, exactamente igual que un
  agente. No existe un "tool de solicitar-entrada-humana"; las personas y los agentes
  colaboran a través de las mismas tareas + transcript, y los mismos primitivos
  asíncronos / de larga ejecución.
- **Gobernanza** — las acciones sensibles y entre organizaciones no se ejecutan sin más.
  Pueden requerir que un humano las apruebe desde una bandeja de entrada (proponer →
  revisar → confirmar), con un rastro de auditoría completo.
- **Soberanía** — cada espacio de trabajo es un directorio en disco que tú posees.
  Cuando dos organizaciones federan, credenciales, datos y facturación se quedan en
  casa; lo que cruza el límite está restringido por un **contrato de confianza por
  enlace**.

Esa combinación — no ningún protocolo individual inteligente — es lo que es Gotong.
Es el primer sustrato que pone la igualdad humano-agente, la federación entre
organizaciones gobernada y la soberanía auto-alojada en un único paquete ejecutable y
con prioridad de archivos.

---

## Una imagen

```
        ┌──────────────────────────────────────────────────────────┐
        │                       Un Espacio (.gotong/)             │
        │  ─────────────────────────────────────────────────────── │
        │                                                          │
        │   👤 admin       👤 worker      👤 worker                │
        │      Alice          Bob            Carol                 │
        │       │              │              │                    │
        │       │              │              │                    │
        │   ┌───┴──────────────┴──────────────┴───┐                │
        │   │       Hub  (solo enrutamiento)       │                │
        │   │  · dispatch                          │                │
        │   │  · transcript (solo adición)         │                │
        │   │  · planificador (3 estrategias)      │                │
        │   │  · puertas de gobernanza (aprobación ·│                │
        │   │    contratos de confianza · auditoría)│                │
        │   └───┬──────────────┬──────────────┬───┘                │
        │       │              │              │                    │
        │   🤖 gestionado      🤖 SDK externo  🪢 otro Hub          │
        │      por host         (Node / Py)    (federación HubLink) │
        │   (templates/      (tu código)      (sus claves se       │
        │    community/)                       quedan en casa)     │
        └──────────────────────────────────────────────────────────┘
                                  ↑
                     todo el estado son archivos
                   (.gotong/transcript.jsonl
                    .gotong/agents.json
                    .gotong/secrets.enc.json …)
```

…y las tres columnas mostradas son solo ejemplos. El mismo slot de `Participant`
también alberga **agentes de codificación CLI / ACP** (Claude Code, Codex), **agentes
A2A externos** y **adaptadores de LangGraph / CrewAI** — todos transparentes para el
planificador.

---

## Las cuatro aristas — cómo Gotong se conecta al mundo

Gotong llega al resto del ecosistema a través de cuatro aristas. **Habla protocolos
abiertos donde existen** — no los reinventa:

| Arista | Protocolo | Dirección | Qué lleva |
|---|---|---|---|
| Herramientas y datos | **MCP** | ambas | Los agentes llaman herramientas MCP externas; los clientes externos (Claude Desktop, Cursor) manejan el Hub. |
| Agente ↔ agente | **A2A** | ambas | Un `message/send` entrante se convierte en un dispatch; una llamada saliente maneja un agente A2A remoto. |
| Agentes de codificación | **ACP** | saliente | El Hub genera y mantiene una sesión con Claude Code / Codex y lo maneja turno a turno. |
| Hub ↔ hub | **HubLink** | ambas | El enlace de federación propio de Gotong entre dos hubs — donde viven los contratos de confianza por enlace, el reenvío de tareas entre organizaciones y las puertas de aprobación. |

Los primeros tres son estándares del ecosistema que Gotong implementa. HubLink es el
único que le pertenece — **no** como un formato de cable inteligente (es WebSocket +
token de portador + JSON-RPC debajo) sino como el **contrato sobre lo que dos hubs
gobernados intercambian**: un manifiesto de capacidades, reenvío de tareas que preserva
la ascendencia y el contrato de confianza por enlace que se describe a continuación.

→ Más profundidad: [`MCP.md`](../MCP.md) · [`FEDERATION.md`](../FEDERATION.md) · [`PROTOCOL.md`](../PROTOCOL.md)

---

## Cómo empezar — ¿quién eres?

| Eres… | Primer paso | Lee más |
|---|---|---|
| **Desarrollador en solitario / quieres que funcione en 5 min** | `docker compose up` (o desde el código: `pnpm install && pnpm build && pnpm host`) → abre la URL de administración del primer arranque en tu navegador | [`README.md` Inicio rápido](../../README.md#quick-start) |
| **Solo quieres *probar un hub real*** | Importa un hub personal / equipo / entre organizaciones ya preparado y ejecútalo | [`zh/HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md) (zh) |
| **Operador de equipo pequeño / abriendo un hub para un equipo** | Modo LAN (enlazar `0.0.0.0`) o VPS + Caddy + systemd | [`DEPLOY.md`](../DEPLOY.md) |
| **Un usuario regular invitado a una sala** | Abre la URL de invitación → elige un apodo → comprueba tus capacidades → ya estás dentro | [`HUMAN.md`](../HUMAN.md) |
| **Quieres entender el diseño completo** | Esta página → `ARCHITECTURE.md` → `PROTOCOL.md` | [`ARCHITECTURE.md`](../ARCHITECTURE.md) |

---

## Licencia — MIT, compatible con uso comercial

Todo el proyecto tiene **licencia MIT**. Respuesta corta:

- ✅ El **uso comercial** está bien, incluido SaaS de código cerrado / herramientas internas / reventa
- ✅ Puedes **modificar** el código fuente, renombrarlo y volver a publicarlo
- ⚠️ Debes **mantener el archivo LICENSE + línea de copyright**

Las plantillas adaptadas de terceros en `templates/community/` llevan sus propias
licencias upstream (CC0 / MIT), todas compatibles con MIT y **todas permiten uso
comercial**.

Preguntas frecuentes completas en [`LICENSE-FAQ.md`](../LICENSE-FAQ.md) — responde las
preguntas típicas: "¿Puedo incrustar Gotong en mi propio producto de código cerrado? /
¿Tengo que atribuir estas plantillas cuando las use comercialmente? / ¿Puedo cambiar el
LICENSE y reempaquetar?"

---

## Cómo se conectan los participantes

El camino principal son **dos formas de añadir un agente LLM**:

| Camino A · Gestionado por host | Camino B · SDK externo |
|---|---|
| Rellena un formulario / importa YAML / pega una plantilla en la UI de administración → el host genera un `LlmAgent` dentro de su propio proceso | Escribe código (Node / Python) implementando `AgentParticipant.handleTask`, luego `connect(url, agents)` al puerto WebSocket del Hub |
| **0 líneas de código** | Tú escribes código |
| Solo agentes LLM (Anthropic / OpenAI / Mock envueltos) | **Cualquier tipo** (LLMs, raspadores, herramientas locales, lógica privada, modelos Python ML) |
| La clave del proveedor está cifrada en disco en `secrets.enc.json` (por agente o predeterminada del espacio de trabajo), o leída desde env | Tú gestionas la clave API; el agente se ejecuta en tu propia máquina |
| Auto-reiniciado cuando el host se reinicia | Tú posees su ciclo de vida; el SDK tiene reconexión automática integrada |
| Mejor para: usuarios regulares / roles LLM estándar / en producción en 60 segundos | Mejor para: desarrolladores / datos privados / sin exponer tu código |

→ Camino A: [`HUMAN.md §1 Agentes`](../HUMAN.md#1-智能体v21) + [`TEMPLATES.md`](../TEMPLATES.md)
→ Camino B: [`AGENT.md`](../AGENT.md)

…y porque todo es el mismo `Participant`, la misma sala también admite:

- **Agentes de codificación CLI / ACP** — el Hub maneja Claude Code / Codex a través de
  una sesión ACP mantenida (verificada en máquina real), con una puerta de acción
  peligrosa que puede aparcar comandos destructivos para aprobación humana.
- **Agentes A2A externos** — registra un agente remoto bajo una capacidad; un paso de
  flujo de trabajo lo enruta como cualquier otro.
- **Adaptadores de framework** — envuelve un grafo de LangGraph o un equipo de CrewAI
  como `Participant` a través del SDK de Python; el framework mismo nunca es importado
  por el Hub.

Todos **se mezclan libremente** — una sala puede tener un `writer-zh` gestionado por
host, tu propio `rag-agent` conectado por SDK y una sesión de codificación de Codex,
completamente transparente para el planificador.

---

## De dónde vienen las plantillas

```
                  templates/
                  ├── agents/           plantillas oficiales originales
                  ├── teams/            equipos oficiales originales
                  └── community/        adaptadas de terceros (CC0 + MIT)
```

Tres formas de obtenerlas, elige según tu gusto:

1. **Galería de plantillas, un clic** — la UI de administración incluye una galería de
   hubs ya preparados (personal / org / entre organizaciones); elige uno → instala →
   aterriza sus agentes + flujos de trabajo + slots de KB en tu Espacio.
2. **Copiar y pegar** — en GitHub, haz clic en **Raw** en un `.yaml` → copia → UI de
   administración "Agents → Import", pega.
3. **Descarga el archivo** — guarda el `.yaml` localmente → UI de administración
   "Upload file".

Cada archivo tiene un comentario de encabezado `# Source` / `# Upstream` / `# License`
/ `# Adapted`, por lo que **la procedencia upstream nunca se pierde**. El texto
completo de las licencias de terceros vive en
[`../templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md).

> **Las plantillas y el framework están separados por diseño.** Una plantilla lleva
> *estructura y referencias* — agentes, flujos de trabajo, slots de KB — nunca el
> *contenido* de conocimiento en sí, y nunca tus personas o secretos. Instalar una
> conecta las conexiones; nunca restaura los datos de otra organización.

→ Flujo completo: [`TEMPLATES.md`](../TEMPLATES.md)
→ Hubs ya preparados para instalar: [`zh/HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md) (zh)

---

## Algunas personas en una sala

Gotong modela un "equipo" como **una sala** = un directorio `.gotong/`. Tres niveles
de rol:

| Rol | URL | Qué puedes hacer en esta sala |
|---|---|---|
| **admin** | `/admin` | Configurar la sala, aprobar/rechazar solicitudes de agentes, despachar tareas, evaluar el trabajo, invitar a otros admins |
| **worker** | `/` (el banco de trabajo `/me`) | Elige un apodo + el trabajo que puedes hacer, ejecuta flujos de trabajo orientados a miembros para ti mismo, gestiona tu bandeja de entrada, completa o rechaza tareas |
| **agent** | puerto WS | Recibe automáticamente tareas despachadas, devuelve resultados |

### Un flujo de trabajo típico de equipo pequeño (con guion)

```
0  Alice (admin) inicia el hub → al arrancar el navegador muestra una URL
   de administración de un solo uso; la guarda en 1Password.
1  Alice configura una clave de proveedor en la UI de administración → la clave
   predeterminada del espacio de trabajo se cifra en disco.
2  Alice instala una plantilla (o importa storyteller.yaml) → el host
   genera inmediatamente un agente LLM, mostrado como en línea.
3  Alice envía URLs de invitación a Bob y Carol. Eligen apodos, comprueban
   las capacidades que pueden hacer (redactar / revisar) → están en la sala.
4  Alice despacha una tarea: "escribe un cuento infantil sobre la perseverancia",
   estrategia = capability:[story] → el narrador gestionado por host la reclama
   → 30s después llega un cuento de 600 palabras.
5  Un paso del flujo de trabajo necesita aprobación → se aparca en la bandeja
   de entrada de Bob; Bob lo aprueba desde su banco de trabajo /me, y la
   ejecución se reanuda — un humano en el bucle, no una llamada a herramienta.
6  Alice evalúa el trabajo; el marcador de contribuciones se actualiza; cada
   evento está en transcript.jsonl, por lo que un crash + reinicio recupera
   completamente.
```

**Conceptos clave** (detalles en HUMAN.md):

- **Tres estrategias de dispatch**: `direct` (por nombre), `capability` (por habilidad), `broadcast` (el primero que reclame gana)
- **Humano en el bucle**: un paso del flujo de trabajo puede despachar a la bandeja de entrada de una persona y esperar aprobar / elegir / editar antes de continuar
- **El banco de trabajo `/me`**: los miembros ejecutan sus propios flujos de trabajo orientados a miembros, ven sus ejecuciones recientes, gestionan sus propios agentes (BYO key), todo acotado a ellos mismos
- **Clave API, tres niveles**: privada por agente → predeterminada del espacio de trabajo → variable de entorno

→ Artículo completo: [`HUMAN.md`](../HUMAN.md)

---

## Entre organizaciones — federación gobernada

**Dos significados diferentes de "multi-equipo" — no los confundas:**

### Una sala, muchos roles (= la sección anterior)

Todos están en el mismo directorio `.gotong/`, el mismo proceso de hub. Este es el
predeterminado.

### Muchas salas, federadas (= verdadero entre organizaciones)

Cada org ejecuta su propio hub independiente (su propio `.gotong/`, sus propias
personas y agentes, **sus propias claves API y su propia facturación**). Dos hubs se
conectan a través de **HubLink**, y lo que uno puede pedir al otro está fijado por un
**contrato de confianza por enlace**:

- **lista de permisos de capacidades** — exactamente qué capacidades puede invocar el par
- **puerta de clase de datos** — qué clases de datos pueden cruzar el enlace (fail-closed)
- **cuota** — un techo de tasa / presupuesto por enlace, mantenido entre reconexiones
- **revocación** — cortar el enlace en cualquier momento
- **lista de permisos de base de conocimiento** — qué KBs compartidas puede alcanzar el par

El patrón más simple es `TeamBridgeAgent`: un sub-hub completo aparece upstream como un
**único agente**, sus miembros internos / claves / sub-tareas invisibles para el padre.

```
   Hub de la empresa (Bob es admin)
       │
       ├── agente · alice-team   ←─┐
       │                           │  TeamBridgeAgent  (sobre HubLink)
       │                  ┌────────┴───────┐
       │                  │ Hub de Alice   │ (Alice es admin)
       │                  │  · writer-bot  │   claves / personas / facturación
       │                  │  · reviewer-bot│   todo se queda en el hub de Alice
       │                  └────────────────┘
       └── agente · david-team   ←── otro equipo, misma idea
```

Más allá de la intermediación, **un flujo de trabajo en un hub puede dar un paso en la
capacidad de otro hub**. Si ese par requiere aprobación, el paso se aparca en la
bandeja de entrada de un humano hasta que alguien lo aprueba — la llamada entre
organizaciones es gobernada, en dos pasos y completamente auditable, y el YAML del
flujo de trabajo nunca nombra el par (solo nombra una capacidad; el enlace es
configuración en tiempo de ejecución).

**Por qué importa — la soberanía permanece intacta:**

- El upstream ve *resultados agregados* ("alice-team completó N tareas"), nunca las claves del par ni los datos brutos
- Cada hub mantiene su **propio almacén de credenciales** y su **propio registro de uso / costo** — la facturación es por hub
- ¿Quieres un PoC interno privado? Ejecuta un hub local — cero costo de incorporación
- ¿Quieres que toda la empresa colabore? Cuelga un enlace gobernado encima — **sin tocar la estructura de equipo existente**

→ Una máquina: [`FEDERATION.md`](../FEDERATION.md)
→ Dos máquinas / dos orgs, paso a paso: [`zh/FEDERATION-RUNBOOK.md`](../zh/FEDERATION-RUNBOOK.md) (zh)

---

## Lecturas adicionales — elige un camino

Elige el "qué quiero descubrir más ahora mismo" que aplique:

| Quiero… | Leer esto |
|---|---|
| Estar en marcha en cinco minutos | [`README.md` Inicio rápido](../../README.md#quick-start) |
| Probar un hub ya preparado (personal / org / entre orgs) | [`zh/HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md) (zh) |
| Ser admin / ser worker | [`HUMAN.md`](../HUMAN.md) |
| Escribir un agente externo | [`AGENT.md`](../AGENT.md) |
| Traer un agente LLM sin código | [`HUMAN.md §1`](../HUMAN.md#1-智能体v21) + [`TEMPLATES.md`](../TEMPLATES.md) |
| Dar a mis agentes el ecosistema de herramientas MCP | [`MCP.md`](../MCP.md) |
| Federar dos hubs (una máquina) | [`FEDERATION.md`](../FEDERATION.md) |
| Federar entre dos máquinas / orgs | [`zh/FEDERATION-RUNBOOK.md`](../zh/FEDERATION-RUNBOOK.md) (zh) |
| Desplegar para un equipo / salir en producción | [`DEPLOY.md`](../DEPLOY.md) + [`zh/GO-LIVE.md`](../zh/GO-LIVE.md) (zh) |
| La arquitectura completa / por qué está diseñada así | [`ARCHITECTURE.md`](../ARCHITECTURE.md) |
| El protocolo wire / escribir un SDK en otro lenguaje | [`PROTOCOL.md`](../PROTOCOL.md) |
| Uso comercial / derivados / límites de licencia | [`LICENSE-FAQ.md`](../LICENSE-FAQ.md) |
| Reportar un problema de seguridad | [`SECURITY.md`](../../SECURITY.md) |
| Contribuir código | [`CONTRIBUTING.md`](../../CONTRIBUTING.md) |
