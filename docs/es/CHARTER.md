# Estatutos de AipeHub

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../../CHARTER.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

> **Nota sobre el idioma**: El inglés es el único idioma autorizado de estos estatutos.
> Una traducción al chino simplificado se mantiene en [`docs/zh/CHARTER.md`](../../docs/zh/CHARTER.md)
> como servicio comunitario; si entra en conflicto con la versión en inglés, prevalece el inglés.
> Otras traducciones son bienvenidas mediante PR (con referencia cruzada aquí y en [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md)).

---

## §1 Qué es AipeHub

AipeHub es la **capa de coordinación entre humanos, agentes de IA e instituciones**.

No es un agente. No es un framework de agentes. Es el sustrato de conexión debajo de ellos: un registro, un bus de mensajes, un enrutador de tareas, un enlace de federación gobernado y un transcript de solo-apéndice.

El Hub es deliberadamente tonto. Enruta mensajes, despacha tareas, persiste el transcript y emite eventos. Nunca ejecuta un LLM; las decisiones siempre permanecen en los participantes.

---

## §2 La Estrella del Norte (tres no-negociables)

Estos tres principios son la prueba de si un cambio propuesto hace avanzar o retroceder el proyecto. Si entra en conflicto con alguno, el cambio requiere una deliberación explícita, no solo una revisión de PR.

### 2.1 El framework no ejecuta el LLM

El Hub solo enruta mensajes, despacha tareas, escribe el transcript y emite eventos. El poder de decisión permanece siempre en los participantes (agentes / personas / servicios externos). Esta posición de diseño no cambia de la v0 a la actualidad.

Implicaciones:
- El Hub nunca emite una finalización de LLM en nombre de un participante.
- El Hub nunca toma decisiones ocultas sobre en qué dirección dirigir un task.
- Un participante puede ejecutar cualquier LLM que elija; el Hub no lo sabe ni le importa.

### 2.2 Los humanos y los agentes son el mismo `Participant`

No trates a los humanos como un "tool de `request_human_input`". Toda la colaboración entre humanos y agentes utiliza el mismo sistema de mensajes + tasks + transcript. Un humano es un `Participant`, tal como lo es un agente.

Implicaciones:
- Las primitivas de long-running / async del Hub se aplican igualmente a agentes y humanos.
- Las restricciones de federación aplican igualmente a usuarios remotos y agentes remotos.
- Un workflow HITL (Human-in-the-Loop) no es una ruta de código especial; es solo otro paso de despacho.

### 2.3 El estado son archivos en disco

El directorio `.aipehub/` contiene transcript / agentes / sesiones / secretos / vault. Copiar el directorio = llevarse la sala. Los reinicios son transparentes.

Implicaciones:
- Sin bases de datos gestionadas de las que depender.
- Backup = copia de directorio con secretos (ver `scripts/backup.sh`).
- Los registros en memoria (caché caliente, etc.) son reproducibles; el disco es la fuente de verdad.

---

## §3 Por qué existe (tres capas de propósito)

```
   Capa 1  Persona ↔ su propio AI / agente
            «Mi escritorio de AI»: el hub de una persona, workflow privado,
            credenciales solo en la máquina local.
            Objetivo: funcionando en 5 minutos, sin código, AI haciendo trabajo real.

   Capa 2  Persona / agente ↔ otras personas / agentes / instituciones
            «Colaboración entre organizaciones»: múltiples usuarios, roles,
            invitaciones, federación entre hubs.
            Objetivo: los workflows pueden cruzar fronteras, pero las credenciales/datos/
            facturación pertenecen a cada parte.

   Capa 3  El framework en sí mismo
            «Claro + estable + adaptable»: Hub deliberadamente tonto, file-first,
            participant es la abstracción unificada, protocolos / credenciales / cuotas
            tienen fronteras explícitas.
            Objetivo: los workflows pueden implementarse realmente, mantenerse al día
            con el rápido desarrollo de la AI.
```

El proyecto falla si resuelve la Capa 1 pero convierte la Capa 2 en un cuello de botella centralizado. Tiene éxito si las Capas 1 y 2 usan exactamente la misma maquinaria.

---

## §4 La cuña de confianza

La razón por la que las personas confían a AipeHub sus hogares, familias o dinero es que las fronteras son reales y les pertenecen:

1. **Gobernado** — cada despacho y resultado es un transcript append-only legible. Las gates de aprobación de la bandeja de entrada son la parada de autobús, no el guardia de seguridad; el gate en sí no puede ser omitido por el workflow.

2. **Local** — las credenciales viven encriptadas en tu propio `.aipehub/`. La federación con otro hub comparte una capacidad, no tu vault. El framework nunca ejecuta el modelo, por lo que no hay ninguna llamada de juicio oculta.

3. **Auditable** — el transcript es append-only; nada se puede sobreescribir silenciosamente. El framework nunca ejecuta el LLM, por lo que no hay inferencia sin trazas.

---

## §5 Visión: grafo libre, no árbol jerárquico

La visión de largo plazo es que los hubs se federeran entre sí en un **grafo libre** sin necesidad de una autoridad central de confianza. Cualquier par de hubs puede establecer un enlace bilateral con sus propias condiciones de contrato de confianza (allowlist de capacidades, data-class gate, cuota, revocación).

Esto significa:
- Un hub doméstico y un hub corporativo pueden compartir una capacidad específica sin que ninguno le entregue su vault al otro.
- Un hub estudiantil y un hub familiar pueden federarse sin que ninguno sea «el propietario» del otro.
- Una federación de socios comerciales (tienda de té ↔ proveedor) puede cruzar líneas organizacionales sin infraestructura de terceros.

Lo que **no** es esta visión:
- No es una arquitectura de árbol donde cada hub hijo confía en la «autoridad» del hub padre.
- No es una plataforma SaaS donde un operador central mantiene las llaves de todos.
- No es un sistema donde los agentes toman decisiones sin la supervisión de sus propietarios.

---

## §6 Cómo usarlo

Cuatro modos de despliegue, desde el más sencillo hasta el más complejo:

| Modo | Descripción |
|---|---|
| **Personal (sin código)** | Un usuario, un hub. Importa una plantilla YAML en la admin UI; el host genera los agentes. Nada de credenciales en la nube. |
| **Equipo** | Múltiples usuarios con roles. El hub vive en un servidor compartido. Los miembros acceden a través de cookies de sesión; los agentes se conectan a través de WebSocket. |
| **Organización** | Reglas de aprobación de admisión de agentes, límites de cuotas de API por organización, vault de credenciales, cuadros de contabilidad de costes/uso. |
| **Federado** | Dos o más hubs con un HubLink punto a punto. Las capacidades se comparten a través del enlace; las credenciales/datos/facturación permanecen en cada hogar. |

Los cuatro modos utilizan la misma base de código, el mismo protocolo de wire y el mismo transcript.

---

## §7 Gobernanza y reconocimiento

El modelo de gobernanza completo vive en [`GOVERNANCE.md`](../../GOVERNANCE.md). El sistema de reconocimiento completo vive en [`docs/RECOGNITION-SYSTEM.md`](../../docs/RECOGNITION-SYSTEM.md).

Resumen en tres líneas:

- **Contribuidor → Mantenedor → Administrador**: el escalón de roles.
- **Leaderboard de citas** (grafo de in-degree `provenance.derivedFrom`): la moneda de reconocimiento.
- **GitHub Discussions / PRs** como entradas únicas: ninguna lista privada de committers, sin reuniones cerradas.

El leaderboard de citas específicamente está diseñado para que **compartir sea más valioso que acaparar**: cuando alguien hace fork de tu plantilla y escribe `derivedFrom: tu-slug`, tu número de citas sube, haciéndote más visible para el siguiente usuario que busca una plantilla base.

---

## §8 No-objetivos (cosas que AipeHub deliberadamente rechaza convertirse)

| No-objetivo | Por qué no |
|---|---|
| **Un LLM o servicio de inferencia** | El §2.1 existe precisamente para evitar esto. El Hub nunca toma decisiones; las delega. |
| **Una plataforma de base de datos** | El estado son archivos. Una base de datos es una dependencia gestionada externa que viola el §2.3. |
| **Un servicio SaaS** | El Capa 2 (§3) requiere federación punto a punto, no una autoridad central. Un SaaS centralizado es el anti-patrón. |
| **Un ejecutor de prompts** | Los prompts son responsabilidad de los agentes. El Hub no sabe qué está dentro del payload de un task. |
| **Una plataforma de identidad** | La identidad vive en el vault encriptado de cada hub. El Hub no es el IdP del mundo. |
| **Un broker de datos** | Las clases de datos son políticas por enlace, no un esquema central. El Hub enruta; no normaliza los datos. |

---

## §9 Cómo es open source

**Licencia**: MIT para el proyecto en sí. Las plantillas de la comunidad bajo `templates/community/` llevan sus propias licencias compatibles (CC0 1.0 y MIT) especificadas por archivo.

**Lo que la licencia permite**: uso comercial, derivados de código cerrado, embedding en SaaS, forks privados, sin copyleft. Consulta [`docs/LICENSE-FAQ.md`](../../docs/LICENSE-FAQ.md).

**Lo que la licencia requiere**: conservar el archivo LICENSE + el aviso de copyright en las distribuciones.

---

## §10 Enmienda de estos estatutos

Los cambios a §2 (la Estrella del Norte) requieren:
1. Una propuesta explícita en GitHub Discussions bajo la categoría Ideas.
2. Un período de comentarios de 14 días con al menos un Mantenedor y al menos un Administrador pesando.
3. Consenso perezoso (ninguna objeción sin respuesta de un Mantenedor/Administrador después del período de comentarios = aprobado).
4. Un incremento de versión en el encabezado del documento por encima de `<!-- doc-version: X.Y -->`, con X incrementando para cambios al §2 (saltos de versión mayor), Y para todo lo demás.

Los cambios a §§3-9 siguen el proceso normal de PR (un Mantenedor de revisión).

---

## §11 Hogar e invitación

El hogar canónico del proyecto es `https://github.com/Emir-Aksoy/AipeHub`.

Si estás leyendo esto como nuevo colaborador: bienvenido. La entrada más amigable para humanos es [`README.md`](../../README.md) o [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md). Si eres un agente de AI leyendo esto al comienzo de una sesión: el mapa de documentos en §5 de [`CLAUDE.md`](../../CLAUDE.md) es tu punto de entrada; estos estatutos son el principio no negociable.

---

## Apéndice A: Tabla de frames del protocolo HubLink (resumen)

| Tipo de frame | Dirección | Propósito |
|---|---|---|
| `HANDSHAKE` | → hub | Establecer sesión autenticada |
| `HANDSHAKE_ACK` | ← hub | Confirmar sesión |
| `TASK` | cualquiera | Despachar un task a través del enlace |
| `TASK_RESULT` | cualquiera | Reportar finalización/fallo del task |
| `TASK_SUSPENDED` | ← hub | El task ha sido suspendido (long-running) |
| `TASK_RESUMED` | → hub | Reanudar un task suspendido |
| `MESH_RPC_CALL` | cualquiera | Solicitar capacidad remota (manifiesto, resumen, transcripción) |
| `MESH_RPC_RESPONSE` | cualquiera | Respuesta a una RPC de malla |
| `PING` / `PONG` | cualquiera | Keepalive |
| `LINK_CLOSED` | cualquiera | Cierre graceful del enlace |

El protocolo de wire completo está en [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md).

---

## Apéndice B: Formatos YAML soportados

| Schema | Propósito |
|---|---|
| `aipehub.agent/v1` | Definición de agente gestionado por el host (proveedor LLM, capacidades, servicios, MCP) |
| `aipehub.team/v1` | Bundle de equipo — múltiples agentes + workflows en un solo archivo importable |
| `aipehub.workflow/v1` | Workflow declarativo (trigger, steps, dispatch, predicate, human:) |
| `aipehub.template/v1` | Plantilla de hub — N agentes + N workflows + slots de KB + apiKeyPrompt + sidecar encriptado opcional |
| `aipehub.bundle/v1` | Bundle heredado (superset de aipehub.agent/v1, soportado para compatibilidad) |

Todos los formatos son validados en tiempo de importación por el parser del runtime correspondiente; un archivo con errores de formato rechaza inmediatamente con un error legible para humanos.
