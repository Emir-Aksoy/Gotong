# AipeHub

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../../README.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

[English](../../README.md) · [中文文档](../../docs/zh/README.md)

**IA + Persona + Hub** — un sustrato autoalojado donde personas y agentes de IA colaboran como participantes iguales, y las organizaciones se federan sin entregar sus claves, datos ni facturación.

AipeHub no es un agente, ni otro framework de agentes. Es la **capa que hay debajo de ellos**: un registro, un bus de mensajes, un enrutador de tareas, un enlace de federación gobernado y un transcript de solo-adición. Los agentes LangGraph / CrewAI, agentes de codificación CLI (Claude Code, Codex) y personas se conectan todos como el mismo `Participant`. El Hub mantiene las señales fluyendo y los límites aplicados — nunca ejecuta el LLM, por lo que cada decisión permanece con los participantes.

### IA en la que realmente puedes confiar para lo que importa

La mayoría de las herramientas de IA te dan dos opciones: entregar todo a una nube que no controlas, o conectarlo todo tú mismo. AipeHub es la tercera opción — **IA que puedes apuntar a tu hogar, tu familia o tu dinero, porque los límites son reales y son tuyos:**

- **Hay un humano en el bucle donde importa.** Las acciones reversibles (apagar las luces) simplemente ocurren; las irreversibles (cerrar la puerta con llave, gastar dinero, enviar datos de un niño a través de un enlace) esperan a que una persona confirme en una bandeja de entrada. El flujo de trabajo no puede saltarse la barrera.
- **Tus claves y datos se quedan en tu disco.** Las credenciales viven cifradas en tu propio directorio `.aipehub/`. Federar con otro hub comparte una capacidad, no tu vault.
- **Nada decide en la oscuridad.** Cada despacho y resultado es un transcript de solo-adición que puedes leer. El framework nunca ejecuta el modelo, así que no hay ninguna decisión oculta.

→ Consulta las [**plantillas insignia**](../../docs/zh/FLAGSHIP-TEMPLATES.md) para hubs que una persona no técnica puede importar y ejecutar hoy (hogar inteligente, café, hub de aprendizaje familiar, hub de codificación personal), cada uno con la barrera de gobernanza mostrada claramente y una demo de un solo comando. ¿Quieres compartir la tuya? [`templates/community/templates/`](../../templates/community/templates/).

## Ideas clave

- **El Hub es tonto a propósito.** No ejecuta LLMs ni posee bucles de agentes. Enruta mensajes, despacha tareas, persiste el transcript y emite eventos. Las decisiones permanecen con los participantes.
- **Los humanos son de primera clase.** Un humano es un `Participant` igual que un agente. Las primitivas asíncronas y de larga duración del Hub se aplican a ambos.
- **Una interfaz, dos formas de despliegue.** Los agentes implementan el mismo contrato `Participant` tanto si se ejecutan en proceso como a través de la red. Los agentes locales y remotos comparten el mismo registro y el mismo planificador.
- **Planificación enchufable.** Tres estrategias de enrutamiento de tareas de serie: asignación explícita, coincidencia de capacidades y reclamación por difusión.
- **Trae tu propio LLM.** Una pequeña clase base `LlmAgent` + una interfaz `LlmProvider` neutral te permiten respaldar un agente con Claude, GPT o cualquier otro modelo sin tocar el Hub.

## Estado

**Autoalojado, basado en archivos y gobernado para uso multiorg.** Un espacio de trabajo es un directorio en disco (`.aipehub/`) — elimina el directorio y el espacio desaparece; cópialo y has entregado la sala a un compañero de equipo; los reinicios son transparentes. Sobre eso: un vault de credenciales por org, federación entre orgs con contratos de confianza por enlace (lista blanca de capacidades · barrera de clases de datos · cuota · revocación), bandejas de entrada de aprobación human-in-the-loop y un libro mayor de uso y costes. El Hub aún nunca ejecuta un LLM — cada decisión permanece con los participantes.

Los paquetes npm están con el ámbito `@aipehub/*`; el SDK de Python es `aipehub` en PyPI. Licencia: [MIT](../../LICENSE).

## Elige tu puerta

> **¿Perdido?** Empieza en [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md) — una sola página que une uso, licencia, incorporación de agentes, descargas de plantillas, equipos multiusuario y federación multiquipo en una narrativa. La tabla siguiente es el desglose por rol.

| Eres… | Lee esto | TL;DR |
|---|---|---|
| 🧭 **Primera vez aquí** | [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md) | Mapa de 5 minutos de cada concepto + un recorrido "flujo de trabajo de pequeño equipo". |
| 🧑 **Un trabajador / admin uniéndose a una sala** | [`docs/HUMAN.md`](../../docs/HUMAN.md) | Abre la URL que te dio el operador; elige un apodo; ya estás dentro. |
| 🤖 **Escribiendo un agente para conectar** | [`docs/AGENT.md`](../../docs/AGENT.md) | `@aipehub/sdk-node` o Python `aipehub`. Subclasifica `AgentParticipant`. |
| 🧩 **Trayendo un agente LLM sin escribir código** | [`docs/TEMPLATES.md`](../../docs/TEMPLATES.md) + [`templates/`](../../templates/) | Manifiesto YAML → pegar / subir en la UI de administración → el host lo genera por ti. Dos conjuntos: originales del proyecto (`templates/agents/`) y adaptados por la comunidad CC0/MIT (`templates/community/`). |
| ⭐ **Solo quiero un hub que haga algo útil** | [`docs/zh/FLAGSHIP-TEMPLATES.md`](../../docs/zh/FLAGSHIP-TEMPLATES.md) (zh) | Galería seleccionada y enmarcada en confianza — importa una y funciona. Hogar inteligente, café, aprendizaje familiar, codificación personal. Cada una muestra qué puede/no puede tocar + una demo sin clave. |
| 🔧 **Ejecutando el servidor** | [`docs/DEPLOY.md`](../../docs/DEPLOY.md) | `pnpm host` para local, Caddy + systemd para público. |
| 🚀 **Saliendo en vivo (3 topologías)** | [`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md) + [`deploy/`](../../deploy/) | Host doméstico + IM, host en la nube + IM, o nube + IP directa. Copia `deploy/.env.home` / `.env.cloud`, sigue el runbook. El puente IM es long-poll saliente → una caja doméstica detrás de NAT no necesita túnel. (Runbook en zh; inglés pendiente.) |
| 🪢 **Federando dos hubs (equipo → org)** | [`docs/FEDERATION.md`](../../docs/FEDERATION.md) | `TeamBridgeAgent` hace que un sub-Hub completo aparezca upstream como un solo agente — mantiene los miembros internos / claves / subtareas privados. |
| 🔌 **Conduciendo un Hub desde Claude Desktop / Cursor / Cline** | [`docs/MCP.md`](../../docs/MCP.md) | `@aipehub/mcp-server` es un puente MCP — 5 herramientas (list / dispatch / evaluate / leaderboard / tasks). Añade 5 líneas a tu configuración de cliente MCP. |
| 🧰 **Dando a tus agentes el ecosistema de herramientas MCP** | [`docs/MCP.md`](../../docs/MCP.md#6-outbound--using-third-party-mcp-tools-from-your-agent) | `@aipehub/mcp-client` permite que tus agentes AipeHub adjunten Filesystem / GitHub / Slack / Postgres / cualquier servidor MCP. `LlmAgent` ejecuta un bucle de uso de herramientas de múltiples turnos de serie (v0.3+) — simplemente pasa `tools: toolset` y Claude / GPT deciden cuándo llamar a qué herramienta. |
| ⚖️ **Preocupado por la licencia / uso comercial** | [`docs/LICENSE-FAQ.md`](../../docs/LICENSE-FAQ.md) | MIT en todo. Embebible en código cerrado / SaaS. Las plantillas de la comunidad son CC0 + MIT. |
| 🧠 **Diseñando sobre él** | [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) + [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md) | El Hub es tonto a propósito; el protocolo de wire es v1.0. |
| 📊 **Dimensionando un despliegue** | [`docs/PERFORMANCE.md`](../../docs/PERFORMANCE.md) + [`docs/zh/CLOUD-RESOURCE-FOOTPRINT.md`](../../docs/zh/CLOUD-RESOURCE-FOOTPRINT.md) | Números de referencia previos al lanzamiento + cómo volver a ejecutar la prueba de carga en tu propio hardware. El documento zh añade una **medición real de producción** (Feishu + MiMo, un solo hub en una caja de 2 vCPU / 2 GiB) con estimaciones de capacidad por carga y factores de actualización — el estado estable es ~110–160 MiB de RAM y ~0 CPU porque la inferencia se ejecuta en el proveedor LLM, no en el host. |
| 🛟 **Operando en producción** | [`docs/OPERATIONS.md`](../../docs/OPERATIONS.md) | Guía de copia de seguridad/restauración, ejercicio de recuperación ante desastres, manejo de `secret.key`, solución de problemas. |
| 📡 **Monitoreo + alertas** | [`docs/MONITORING.md`](../../docs/MONITORING.md) | Configuración de scrape de Prometheus, 7 reglas de alerta con runbooks, JSON del panel de Grafana. |

### Añadir un agente — dos caminos

|  | Gestionado por el host (sin código) | SDK externo (tu código) |
|---|---|---|
| **Tú haces** | Pegar / subir un manifiesto YAML en la UI de administración | Escribir `AgentParticipant.handleTask`, llamar a `connect(url, agents)` |
| **Dónde se ejecuta** | Dentro del proceso del Hub (LocalAgentPool) | En cualquier lugar de la red |
| **Qué puede hacer** | Tareas LLM vía proveedores Anthropic / OpenAI / Mock | Cualquier cosa — LLMs, scrapers, datos privados, modelos ML, scripts |
| **La clave API vive** | Cifrada en `.aipehub/secrets.enc.json` (por agente o predeterminada del espacio de trabajo) | Donde tu código la lea |
| **Al reiniciar** | Re-generado automáticamente por `LocalAgentPool` | Tu código se reconecta (el SDK tiene reintento automático integrado) |
| **Mejor para** | Usuarios finales • roles estándar • plantillas de un clic | Desarrolladores • lógica privada • trabajadores en otros lenguajes |
| **Lee** | [`docs/TEMPLATES.md`](../../docs/TEMPLATES.md) | [`docs/AGENT.md`](../../docs/AGENT.md) |

Ambos caminos se conectan al mismo Hub. Mézclalos libremente — una sala puede tener `writer-zh` gestionado por el host junto a tu `rag-agent` conectado privado por SDK.

Qué es este proyecto — y qué se niega a ser: [`CHARTER.md`](../../CHARTER.md). ¿Contribuyendo? Ver [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Problemas de seguridad: [`SECURITY.md`](../../SECURITY.md). Historial de versiones: [`CHANGELOG.md`](../../CHANGELOG.md).

## Inicio rápido

### ¿Usuario no técnico? Doble clic, sin Node/Docker

El camino que no necesita **ni terminal, ni Node, ni Docker** en la máquina que lo ejecuta. Un mantenedor construye un paquete portátil autocontenido una vez:

```bash
node scripts/build-portable.mjs        # → dist-portable/AipeHub-macos-arm64/
```

Luego entrega la carpeta `AipeHub-macos-arm64/` completa a cualquiera. Ellos **hacen doble clic en `AipeHub.command`** → el navegador abre el asistente de configuración de 5 minutos. El paquete incluye su propio runtime de Node fijado + el host compilado + un `node_modules` real en disco (incluyendo el binding nativo de SQLite), por lo que ejecuta el host **completo** respaldado por identidad en una máquina sin nada instalado. Los datos viven en `~/.aipehub` (fuera de la carpeta), así que reemplazar el paquete nunca pierde datos.

Construido bajo demanda, aún no es una descarga comprometida/publicada (ese es el plan post-1.0) — por ahora "descargar y ejecutar" significa *construir la carpeta una vez, compartir la carpeta*. macOS arm64 en esta ronda. Descripción completa: [`docs/zh/PORTABLE-BUNDLE.md`](../../docs/zh/PORTABLE-BUNDLE.md).

### Ponerse en marcha en 30 segundos — elige uno

```bash
# A. Docker (recomendado — sin configuración de Node, funciona en macOS / Windows / Linux)
docker compose up
# → http://127.0.0.1:3000  + URL de administración impresa en los logs
# → el estado persiste bajo ./data

# B. Desde el código fuente (repo clonado, conjunto completo de demos disponible)
pnpm install
pnpm build
pnpm host
```

Ambos arrancan el mismo binario. Abre la URL de administración impresa → guarda el token → listo.

**Detalle de primer arranque (nuevo).** Después de arrancar, el host imprime un banner de siguiente paso prominente apuntando al asistente de configuración de loopback, y en un primer arranque local (loopback) abre tu navegador allí por ti:

```text
┌─ 下一步 / Next step ──────────────────────────

  打开浏览器完成 5 分钟设置 (设置向导,无需 token):
  Open your browser to finish the 5-minute setup:

      →  http://127.0.0.1:3000

  设置向导在本机回环 (loopback) 上运行。
  The setup wizard runs on loopback only.
└───────────────────────────────────────────────
  (已自动打开浏览器 / browser opened — AIPE_OPEN_BROWSER=0 关闭)
```

`AIPE_OPEN_BROWSER` controla la apertura automática: sin definir = `auto` (solo el primer arranque local), `1`/`always` = en cada arranque, `0`/`never` = desactivado. También se fuerza a desactivado cuando el host está expuesto en red — un servidor sin cabeza nunca abre un navegador, y el asistente no es accesible allí de todos modos (esa ruta usa el archivo del token de administración). El banner en sí siempre se imprime.

> 💡 **Distribución.** Sin `npm publish` en esta etapa — Docker (A) y el código fuente (B) son los dos caminos de instalación soportados. El plan npm anterior "en cola para v2.1" ha sido **eliminado del alcance**; la elección del registro (npm / JSR / solo-fuente) es una decisión abierta rastreada en [RELEASE-CHECKLIST](../../.github/RELEASE-CHECKLIST.md). Los binarios pre-construidos de un solo archivo para macOS / Windows son un elemento planificado pero no bloqueante — Docker ya cubre el caso "hacer clic y ejecutar" multiplataforma.

Indicadores de CLI (desde un repo construido):

```bash
pnpm exec aipehub-host --help       # referencia completa de variables de entorno
pnpm exec aipehub-host --version    # versión actual del host
```

Después de arrancar, sigue [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md) para el recorrido "qué hacer ahora".

**¿No arranca?** Ejecuta una verificación previa antes de arrancar — inspecciona el env `AIPE_*` exacto que lee el host (versión de Node, puertos realmente libres para enlazar, directorio de datos con permisos de escritura, clave maestra) e imprime, por cada verificación, ✓ / ⚠ / ✖ con una corrección en una línea:

```bash
pnpm exec aipehub doctor          # solo informe
pnpm exec aipehub doctor --fix    # también crea automáticamente un directorio de datos faltante (la única reparación segura y reversible)
```

Y si un arranque *falla*, el host convierte los fallos comunes y recuperables (puerto ya en uso, sin permiso para enlazar un puerto, clave maestra faltante/inválida, directorio de datos sin permisos de escritura, disco lleno) en un mensaje de una línea nombrando qué variable `AIPE_*` cambiar — no un rastreo de pila. Ver la sección de solución de problemas en [`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md) §十一.

**Verifica que la sonda de clave funciona (sin clave real necesaria).** La trampa más común en el primer arranque es una clave LLM pegada que silenciosamente no funciona. El asistente de configuración captura esto con un camino de rescate "去补 key" de un clic; este comando recorre esa misma sonda de extremo a extremo para que sepas que el camino de rescate está conectado antes de incorporar usuarios:

```bash
pnpm check:onboarding          # hermético — prueba que una clave mala/vacía → "ve a añadir una clave", un error de red → "verifica la URL"
ANTHROPIC_API_KEY=… pnpm check:onboarding   # también hace un ida y vuelta de una clave REAL por la red (opt-in; se omite sin una)
```

Es hermético por defecto (sin red, sin gasto) y nunca registra tu clave. Salida 0 = todas las verificaciones que se ejecutaron pasaron. La verificación de clave real opt-in refleja el contrato de entorno de la puerta en vivo (`OPENAI_API_KEY` + `OPENAI_BASE_URL=https://api.deepseek.com` + `AIPE_LIVE_OPENAI_MODEL=deepseek-chat` para la ruta DeepSeek).

### Desplegar en un servidor en la nube (VPS)

¿Tienes una caja Ubuntu/Debian nueva? Pon el checkout en ella (`git clone` con tu clave, o `scp` — el repo es privado, así que no hay pull público), luego provee un servicio systemd en un comando:

```bash
# desde dentro del checkout, en el VPS
sudo bash deploy/cloud-quickstart.sh        # instalar Node+pnpm → construir → usuario+unidad
#   vista previa primero, no muta nada:  bash deploy/cloud-quickstart.sh --dry-run
```

Instala Node + pnpm, construye, crea el usuario de servicio `aipehub` y el directorio de datos, deja `/etc/aipehub.env` (de [`deploy/.env.cloud`](../../deploy/.env.cloud)), e instala una unidad systemd que refleja [`docs/zh/DEPLOY.md`](../../docs/zh/DEPLOY.md) §C.4. Se **detiene un paso antes de arrancar** — el archivo env se entrega con el dominio / clave maestra / lista blanca de host en blanco, y exponer una caja no configurada es inseguro. Imprime el último kilómetro seguro: rellena el env, ejecuta [`scripts/cloud-harden.sh`](../../scripts/cloud-harden.sh) (verificación de perímetro), pon Caddy + un firewall delante, luego `systemctl enable --now aipehub`.

> No hay **botón de "despliegue con un clic" en el navegador** mientras el repo es privado (esos necesitan un repo público o una cuenta de proveedor pre-vinculada a tu git). Este bootstrap copiable es el equivalente real y comprobable. Runbook completo — topología, riesgos de exposición de IP, incorporación de miembros IM: [`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md).

### 个人模式 (新, v4 Phase 7) — 一个人用 AI 干活, 0 配置

如果你就一个人, 想把 AipeHub 当成"我的 AI 桌面"用 (不是给团队开 hub),
直接 `docker compose up` 就行 — host 第一次启动检测到只有你一个用户,
**自动进入个人模式**:

```bash
docker compose up
# → http://127.0.0.1:3000/admin?token=<打印出来>
# → 首屏顶部不显示 "owner" 角色 chip (个人用户不需要看见组织角色)
# → 副标题写"我的 AI 桌面"(不是"管理员控制台")
# → 设置 tab 出现 [升级到团队模式] 按钮 — 哪天想拉人就点一下
```

个人模式与团队模式的差别就两点:
- 主页副标题文案不同 / role chip 隐藏
- 设置里多个升级按钮

**所有 admin tab 都还在**(用户管理 / peer / 配额 / audit 全可见),
但你不会被这些概念占满屏幕。需要时再用。

`AIPE_MODE=team` 可以强制 pin 团队模式(即使只有一个用户);
`AIPE_MODE=personal` 反过来——多用户时也强制 pin 个人模式(罕见,
通常给 dev / 测试场景)。

升级到团队后, 自动出现"邀请用户"流程, 跟着导出 admin URL 给团队成员;
路径见下一节 5-min personal growth workflow 或 [`docs/zh/OVERVIEW.md`](../../docs/zh/OVERVIEW.md)。

### Flujo de trabajo de crecimiento personal de 5 minutos (nuevo)

La primera experiencia lista-para-ejecutar que se entrega. 7 coaches (entrevista + cuerpo / mente / objetivos / recursos / relaciones + planificador de síntesis) ejecutan una pasada → un plan de pared de 12 semanas en markdown cae en el disco. El LLM predeterminado es **DeepSeek** (accesible en China continental, económico).

```text
1. Instala el host (Docker o código fuente, ver arriba)
2. Abre la URL de administración impresa → entra al admin
3. Solicita una clave API de DeepSeek: https://platform.deepseek.com (los nuevos usuarios obtienen 10 yuanes de crédito, suficiente para decenas de ejecuciones)
4. Admin → pestaña de flujos de trabajo → haz clic en [Importar equipo (bundle)] → haz clic en [🎁 Usar plantilla integrada: crecimiento personal]
   → pega la clave DeepSeek → [Importar]
   (7 agentes creados con un clic, el flujo de trabajo se registra automáticamente)
5. Haz clic en [Iniciar] en la tarjeta del flujo de trabajo → aparece un formulario de 4 secciones (situación actual / deseos / bloqueos / qué quieres aclarar esta vez)
6. Despacha → espera ~3.5 minutos (7 llamadas a la API de DeepSeek)
7. Pestaña de flujos de trabajo → desplázate hasta el final → panel "Informe de crecimiento" → haz clic en [Descargar]
   o: <space>/services/artifact/file/agent/growth-synthesist/reports/<caseId>/<date>.md
```

El informe incluye: perfil + cinco análisis dimensionales (cuerpo/mente/objetivos/recursos/relaciones) + trayectoria de desarrollo en una frase + **plan de pared de 12 semanas** (línea principal + secundaria, qué hacer cada semana) + **5 juicios de compensación** + plan de contingencia "qué hacer si no puedo" + "5 preguntas semilla sugeridas para responder la próxima vez que ejecutes el flujo de trabajo" (para usar la próxima vez).

> 🙏 **Sobre privacidad / datos**: tus 4 secciones de autodescripción se enviarán a DeepSeek (servidores en China continental) para inferencia. Cuando el flujo de trabajo termina, todos los resultados caen en el directorio `.aipehub-*/services/` de tu propio ordenador, no se sube nada a ninguna nube. Cada coach está diseñado como un acompañante con límites — el coach de cuerpo, al encontrar señales de alerta (dolor de pecho persistente / sangrado inexplicable, etc.), te indicará que consultes un médico; el coach de mente, al encontrar señales de riesgo, proporcionará líneas de crisis de 24h (nacional 400-161-9995 / Malasia Befrienders 03-7956 8144). **Esto no es un sustituto de un médico / psicólogo / asesor financiero / terapeuta de relaciones.**

¿Quieres cambiar a Anthropic Claude u OpenAI? Edita `templates/teams/personal-growth-team.yaml`, cambia el `provider` / `baseURL` / `model` de cada agente — las indicaciones del sistema son independientes del proveedor.

### Registro

El registro estructurado está **activado por defecto** — línea JSON por evento cuando stdout está canalizado (para `jq` / Loki / ELK / Datadog), impresión legible cuando stdout es un terminal. Tres variables de entorno lo controlan:

```bash
AIPE_LOG_LEVEL=info       # silent | trace | debug | info (predeterminado) | warn | error | fatal
AIPE_LOG_FORMAT=json      # json | pretty (predeterminado: auto por TTY)
AIPE_LOG_DISABLED=1       # escape hatch de desactivación total
```

Filtra por componente con `jq` una vez que tienes salida JSON:

```bash
pnpm host 2>&1 | jq 'select(.comp == "local-agents")'
```

### Demos (repo clonado)

Una vez que hayas ejecutado `pnpm install && pnpm build`, cada patrón de colaboración del framework tiene una demo ejecutable:

```bash
# demos en proceso (sin red)
pnpm demo                # dos agentes mock + un humano mock
pnpm demo:broadcast      # tres revisores compiten, los perdedores son cancelados

# demos de persistencia
pnpm demo:persist:fresh && pnpm demo:persist:resume
pnpm demo:persist:sqlite:fresh && pnpm demo:persist:sqlite:resume

# agentes remotos
pnpm demo:remote         # host + trabajador en procesos separados
pnpm demo:remote:python  # host Node + trabajador Python (entre lenguajes)
pnpm demo:cli-human      # terminal-como-humano bucle de aprobación

# agentes respaldados por LLM
pnpm demo:llm            # LlmAgent + proveedor mock (sin clave API necesaria)
pnpm demo:llm:real       # Claude/GPT real (necesita ANTHROPIC_API_KEY/OPENAI_API_KEY)

# v2.0 pila completa — UI web + admisión de agentes + panel de tareas
pnpm demo:open-space
pnpm demo:federated-team # un Hub se une a otro Hub como un solo agente
```

### 上手案例 — 5 个开箱即用的 hub (Hubs listos para usar)

Más allá de las demos de patrones anteriores, cinco casos `examples/` son **hubs completos y copiables** — cada uno incluye una demo determinista sin clave *y* una plantilla cargable de un archivo (agentes + flujos de trabajo + cableado KB). Tres personales ("mi escritorio de IA"), dos organizativos (modo equipo):

```bash
# hubs personales (el LLM enrutador orquesta sub-agentes / CLIs)
pnpm demo:personal-coding-hub      # enruta Claude Code + Codex en un repo compartido
pnpm demo:personal-research-hub    # compila fuentes brutas en un wiki Obsidian enlazado
pnpm demo:battle-monk-training     # un coach de crecimiento escribiendo estado en un Codex persistente

# hubs organizativos (flujos de trabajo declarativos + autoservicio surface.me + aprobación HITL human:)
pnpm demo:cafe-ops                 # tienda de bebidas/café: incorporación / turnos / horas extra, el gerente aprueba
pnpm demo:warband-club             # un club de fans colaborando sobre un archivo compartido
```

Elige uno, ve la demo determinista, luego sal en vivo con DeepSeek + Obsidian reales — el catálogo completo y el runbook de puesta en marcha está en **[`docs/zh/HANDS-ON-HUBS.md`](../../docs/zh/HANDS-ON-HUBS.md)**.

## Embebido — todo en un proceso

```ts
import { Hub, Space } from '@aipehub/core'

// v2.0: enlazar a un directorio; admins, trabajadores, transcript viven aquí
const { space, adminToken } = await Space.openOrInit('.aipehub', {
  name: 'my-space',
  adminDisplayName: 'Operator',
})
console.log(`URL de admin una vez: http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()
hub.register(new MyAgent())
hub.register(new MyHumanAdapter())

const result = await hub.dispatch({
  from: 'admin',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'why TypeScript' },
})

// para tests / demos en proceso sin persistencia:
const tmp = Hub.inMemory()
```

## Distribuido — los agentes se conectan desde otro proceso / máquina

Proceso host (el Hub):

```ts
import { Hub } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'

const hub = new Hub()
await hub.start()
await serveWebSocket(hub, { port: 4000 })
```

Proceso trabajador (cualquier agente, en cualquier lugar):

```ts
import { AgentParticipant, connect } from '@aipehub/sdk-node'

class MyAgent extends AgentParticipant {
  constructor() { super({ id: 'a1', capabilities: ['draft'] }) }
  protected async handleTask(task) { return { text: '…' } }
}

await connect({ url: 'ws://hub.example.com:4000', agents: [new MyAgent()] })
```

El `dispatch(...)` del Hub llega al agente remoto de manera idéntica a uno local. Ver [docs/PROTOCOL.md](../../docs/PROTOCOL.md) para el formato de wire y [examples/remote-agent](../../examples/remote-agent) para una demo de dos procesos ejecutable.

## Agentes respaldados por LLM

El Hub no llama a los LLMs. `LlmAgent` sí lo hace — es una clase base delgada que conecta una Task a un `LlmProvider` y convierte la respuesta en un `TaskResult`. Cambiar de proveedor es un cambio de una línea.

```ts
import { Hub } from '@aipehub/core'
import { LlmAgent } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'

const hub = new Hub()
await hub.start()

// Claude escribe borradores
hub.register(new LlmAgent({
  id: 'writer',
  capabilities: ['draft'],
  provider: new AnthropicProvider(),        // lee ANTHROPIC_API_KEY
  system: 'Escribes una frase concisa.',
}))

// GPT los revisa
hub.register(new LlmAgent({
  id: 'reviewer',
  capabilities: ['review'],
  provider: new OpenAIProvider(),            // lee OPENAI_API_KEY
  system: 'Devuelves una sugerencia de revisión.',
}))

const draft = await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'distributed agents' },
})
```

Sobreescribe `buildRequest(task)` para personalizar el ensamblaje del prompt (contexto recuperado, ejemplos de pocas tomas) o `parseResponse(response, task)` para post-procesar (extracción JSON, re-prompt de validación). Sobreescribe `handleTask(task)` para control total — razonamiento de múltiples pasos, reintentos, salidas estructuradas. Ver [`packages/llm`](../../packages/llm/src/agent.ts) y las dos demos en [`examples/llm-mock`](../../examples/llm-mock) y [`examples/llm-real`](../../examples/llm-real).

## Open Space — admins, trabajadores y agentes en una sala (v2.0)

Ancla el hub a un directorio `.aipehub/`; la identidad del admin, las cuentas de trabajadores y las admisiones de agentes con barrera viven allí. La UI web se divide en dos vistas (`/` trabajador, `/admin` admin). Los reinicios del Hub son transparentes — las cookies siguen funcionando, los admins siguen siendo admins, los transcripts crecen en lugar de reiniciarse.

```ts
import { Hub, Space } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'
import { serveWeb } from '@aipehub/web'

const { space, adminToken } = await Space.openOrInit('.aipehub', {
  name: 'my-space',
  adminDisplayName: 'Operator',
  config: { gating: 'admin-approval' },
})
console.log(`URL de admin una vez: http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()

await serveWebSocket(hub, { port: 4000, gating: (await space.config()).gating })
await serveWeb(hub, { port: 3000 })
// admin = /admin?token=<TOKEN>   |   trabajador = /
```

- **Admin** inicia sesión una vez con el token, luego conduce la sala: aprobar / rechazar admisiones de agentes pendientes, despachar tareas vía cualquiera de las tres estrategias, ver todas las tareas en un panel filtrable con un botón **Reintentar** en filas fallidas, escribir evaluaciones adjuntas a tareas específicas.
- **Trabajador** elige un apodo + capacidades en `/`, se convierte en un `HumanParticipant`. Una fila `workers.json` + una cookie HttpOnly los recuerda entre recargas y reinicios.
- **Agente** se conecta al puerto WebSocket; con `gating: 'admin-approval'` queda pendiente hasta que un admin actúa.

Demo completa ejecutable en [`examples/open-space`](../../examples/open-space). `pnpm demo:open-space` arranca host + agente en un terminal, luego apunta un navegador a las dos URLs que imprime.

## Servicios del Hub — memoria de agentes, artefactos, datastores (v2.2)

Un agente puede declarar qué estado quiere que el host mantenga en su nombre. Tres "servicios" de primera parte se incluyen hoy; la plomería es plugin-desde-el-día-1 así que añadir un cuarto es un paquete npm separado.

```yaml
# templates/agents/industry-coach-with-memory.yaml
schema: aipehub.agent/v1
agent:
  id: industry-coach
  capabilities: [intake]
  provider: anthropic
  model: claude-opus-4-7
  system: |
    Usa memory.recall antes de responder; artifact.write el informe
    después; cases.sql para comparaciones de industria estructuradas.
  uses:
    - { type: memory,    impl: file,   config: { kinds: [episodic, semantic] } }
    - { type: artifact,  impl: file,   config: { name: industry-reports } }
    - { type: datastore, impl: sqlite, config: { name: cases, schema: "..." } }
```

En el momento de la generación, el host resuelve cada entrada `uses:` a un handle tipado que el agente lee desde `ctx.memory`, `ctx.artifact`, `ctx.datastore.<name>`. El aislamiento basado en propietario es el predeterminado — dos agentes que piden `memory:file` obtienen dos almacenes diferentes. El diseño de datos vive bajo `<space>/services/`:

```
<space>/services/
├─ plugins.json                    # qué plugins cargar (sembrado automáticamente)
├─ memory/file/agent/<agentId>/    # un directorio por (plugin, propietario)
├─ artifact/file/agent/<agentId>/
└─ datastore/sqlite/agent/<agentId>/<name>.sqlite
```

La eliminación suave es un clic en la pestaña admin "服务 / Services"; los datos se mueven a `.trash/` por plugin, viven 30 días, luego un barredor en segundo plano los elimina definitivamente. La restauración es un POST hasta entonces. El diseño completo está en [`docs/services-rfc.md`](../../docs/services-rfc.md).

| Paquete | Qué proporciona |
|---|---|
| `@aipehub/services-sdk` | Contrato `ServicePlugin`, registro, cargador. La costura que implementan los autores de plugins. |
| `@aipehub/service-memory-file` | `memory:file` de primera parte — episódico / semántico / de trabajo como JSONL. |
| `@aipehub/service-artifact-file` | `artifact:file` de primera parte — directorios por propietario de archivos con guardas de MIME + tamaño. |
| `@aipehub/service-datastore-sqlite` | `datastore:sqlite` de primera parte — KV + SQL bruto en un `.sqlite` por nombre declarado. |

### Escribir tu propio plugin

```ts
// my-plugin/src/index.ts
import type { ServicePlugin } from '@aipehub/services-sdk'

class MyPlugin implements ServicePlugin {
  readonly type = 'memory'
  readonly impl = 'redis'
  readonly version = '0.1.0'

  async init(ctx) { /* abre el pool de redis */ }
  async validateConfig(raw) { /* analiza + rechaza formas incorrectas */ }
  async attach(owner, config) { /* devuelve un MemoryHandle */ }
  async detach(owner) { /* cierra el caché por propietario */ }
  async softDelete(owner) { /* devuelve un TrashRef; el host lo almacena */ }
  async restore(ref) { /* lanza TrashRestoreConflictError en colisión */ }
  async hardDelete(ref) { /* irreversible */ }
  async describe(owner) { /* instantánea de la UI de admin — sizeBytes, vista previa */ }
  async shutdown() { /* drenar + cerrar */ }
}

export default () => new MyPlugin()
```

Deja el nombre del paquete en `<space>/services/plugins.json` y reinicia el host — `loadPlugins` importa dinámicamente la entrada, llama a `init`, y el plugin está disponible para el `uses:` yaml de cada agente. Los fallos de carga de plugins son no fatales: un plugin defectuoso aparece en el log de arranque pero no bloquea el host.

> **Nota de despliegue**: el host resuelve los paquetes de plugins desde su propio `node_modules/`, por lo que los plugins de terceros necesitan estar instalados donde el host pueda verlos — `pnpm add my-org/aipehub-redis-memory` en el espacio de trabajo del host, o una dependencia `package.json` en la imagen de despliegue. Poner el nombre del paquete en `plugins.json` solo no es suficiente si el paquete en sí no está en disco.

## Paquetes

| Paquete | Propósito |
|---|---|
| `@aipehub/core` | Hub, registro, planificador, transcript, almacenamiento, clases base de Participant |
| `@aipehub/web` | UI de referencia embebible (HTTP + SSE + SPA vainilla) |
| `@aipehub/host` | Binario de producción — controlado por env, sin estado de demo, incluye `aipehub-host` |
| `@aipehub/protocol` | Tipos de protocolo wire + codec (sin runtime) |
| `@aipehub/transport-ws` | Transporte WebSocket del lado del Hub |
| `@aipehub/sdk-node` | SDK de Node para agentes remotos (también exporta `TeamBridgeAgent`) |
| `@aipehub/llm` | Clase base `LlmAgent` + interfaz `LlmProvider` + `MockLlmProvider` |
| `@aipehub/llm-anthropic` | Proveedor Anthropic Claude (dep de par: `@anthropic-ai/sdk`) |
| `@aipehub/llm-openai` | Proveedor OpenAI (dep de par: `openai`) |
| `@aipehub/services-sdk` | Contrato de plugin de Servicios del Hub (v2.2) — ver la sección anterior |
| `@aipehub/service-memory-file` | Plugin `memory:file` de primera parte (JSONL en disco) |
| `@aipehub/service-artifact-file` | Plugin `artifact:file` de primera parte (dirs por propietario, con barrera de MIME) |
| `@aipehub/service-datastore-sqlite` | Plugin `datastore:sqlite` de primera parte (KV + SQL) |
| `@aipehub/mcp-server` | Puente MCP (Model Context Protocol) — permite que Claude Desktop / Cursor conduzca un Hub |
| `aipehub` (PyPI, en `python-sdk/`) | SDK de Python — conecta agentes Python a un Hub sobre el mismo protocolo wire |

## Licencia

**MIT** para el proyecto en sí — ver [`LICENSE`](../../LICENSE).

- ✅ Uso comercial, derivados de código cerrado, embedding SaaS interno — todo permitido.
- ⚠️ Conserva el archivo LICENSE + aviso de copyright en tu distribución.
- Las plantillas de prompts de terceros bajo [`templates/community/`](../../templates/community/) llevan sus propias licencias (compatibles) — CC0 1.0 y MIT — agregadas textualmente en [`templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md).

Las preguntas comunes ("¿puedo embeber en código cerrado?", "¿debo atribuir las plantillas de la comunidad?", "¿está permitido hacer fork y renombrar?") se responden en [`docs/LICENSE-FAQ.md`](../../docs/LICENSE-FAQ.md).
