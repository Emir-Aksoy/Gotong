# GitHub Discussions — el "salón" de la comunidad (cero cómputo, habilitación única)

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../COMMUNITY-DISCUSSIONS.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

> Elemento 8 de la lista de verificación pre-lanzamiento. En una línea: **Issues es el mostrador de atención al cliente, Discussions es el salón** — hacer preguntas, mostrar resultados y proponer ideas ocurre aquí; GitHub lo alberga de forma gratuita, **cero cómputo** igual que la página de inicio/clasificación.

---

## 1. Por qué Discussions (y no otro servicio más)

Misma postura que [`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md): para un proyecto file-first cuyo hub no ejecuta el LLM en sí, **la infraestructura de la comunidad tampoco debería necesitar un servidor**. GitHub Discussions alberga todo el "salón" — hilos, categorías, @menciones, Markdown, búsqueda — todo trabajo de GitHub, sin una línea de backend de nuestra parte.

- **Issues** = el mostrador de atención al cliente para "algo está roto / faltante" (cerrable, asignable, con estado).
- **Discussions** = el salón para "quiero preguntar / mostrar / charlar" (abierto, votable, puede marcar una mejor respuesta).

Estas dos entradas ya están enrutadas en [`.github/ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml) — al abrir un issue, el enlace de contacto "💬 Pregunta o discusión" envía a las personas a Discussions. **Entonces antes de que Discussions esté habilitado, ese enlace es un 404**; una vez habilitado entra en funcionamiento de inmediato.

---

## 2. ⚠️ La única acción manual: habilitar Discussions (Claude no puede ayudar)

**Habilitar Discussions es un interruptor de configuración del repositorio, no un archivo — ni Claude ni CI pueden activarlo.** Este paso debe realizarlo el propietario del repositorio en la interfaz web:

1. Abre `https://github.com/Emir-Aksoy/Gotong/settings` (**Configuración** del repositorio).
2. Desplázate hasta la sección **Features**, marca **Discussions**.
3. GitHub **creará automáticamente las categorías predeterminadas**: Announcements / General / **Ideas** / Polls / **Q&A** / **Show and tell**. Las tres plantillas de formulario entregadas con este repositorio (ver §4) apuntan a las tres en negrita y se adjuntan **automáticamente en el momento** en que habilitas, sin necesidad de crear categorías manualmente.

> Esto es lo que significa "el andamiaje está listo, solo falta un interruptor": los archivos de plantilla, el borrador de la publicación de bienvenida, el enlace de enrutamiento de issues y la documentación están todos en el repositorio; haces clic en Features → Discussions y el salón se abre.

Después de habilitar, se recomiendan dos cosas más (todas unos pocos clics en la interfaz web, opcionales pero recomendadas):

- **Fija una publicación de bienvenida**: publica el borrador del §5 como Discussion en la categoría General y haz clic en "Pin."
- **(Opcional) añade una categoría personalizada "Templates"**: si el intercambio de plantillas supera a Show and tell, crea una separada; pero el Show and tell predeterminado es suficiente al principio — no añadas prematuramente.

---

## 3. Mapa de categorías (las tres que están listas con el framework)

| Categoría | slug | Formulario | Para qué sirve |
|---|---|---|---|
| **Q&A** | `q-a` | [`q-a.yml`](../../.github/DISCUSSION_TEMPLATE/q-a.yml) | Ayuda, preguntas. Se puede marcar una "mejor respuesta." |
| **Ideas** | `ideas` | [`ideas.yml`](../../.github/DISCUSSION_TEMPLATE/ideas.yml) | Proponer características / direcciones. El formulario incentiva la alineación con la estrella del norte (el hub no ejecuta el LLM / file-first / federación punto a punto). |
| **Show and tell** | `show-and-tell` | [`show-and-tell.yml`](../../.github/DISCUSSION_TEMPLATE/show-and-tell.yml) | Mostrar tu hub / flujo de trabajo / plantilla. **Convenientemente guía la entrega de la plantilla a la galería** + escribir `derivedFrom` para que el crédito fluya de vuelta. |
| Announcements | `announcements` | — | Solo mantenedores (lanzamientos, cambios importantes). Sin formulario. |
| General | `general` | — | La publicación de bienvenida + conversación sin categorizar. Sin formulario. |

**Slug = nombre del archivo**: GitHub adjunta el formulario en `.github/DISCUSSION_TEMPLATE/<slug>.yml` a la categoría del mismo nombre. Estos tres slugs son categorías predeterminadas que GitHub **crea automáticamente** al habilitar, por lo que las plantillas están "listas para usar" sin necesidad de crear categorías manualmente y hacer coincidir los nombres primero.

---

## 4. Plantillas de formulario (`.github/DISCUSSION_TEMPLATE/`)

Mismo enfoque que [`.github/ISSUE_TEMPLATE/`](../../.github/ISSUE_TEMPLATE/) — formularios estructurados que hacen que el publicador proporcione información útil desde el principio. Las tres plantillas tienen cada una un enfoque:

- **`q-a.yml`** — guía a dar "lo que estás tratando de hacer" (no solo el error) + "lo que intentaste" + versión + modo de ejecución; y empuja **los bugs de vuelta a Issues, los problemas de seguridad a SECURITY.md** — el salón no acepta esos dos.
- **`ideas.yml`** — pide "cuál es el problema" antes de "qué quieres," y hace que el proponente **sopese por sí mismo el encaje con la estrella del norte de tres capas** (cualquier cosa que requiera que el hub ejecute un LLM / oculte estado / centralice credenciales, dilo honestamente — no es un veto, pero da forma a la discusión).
- **`show-and-tell.yml`** — más allá de mostrar resultados, **presenta la guía de "¿puede esto ir a la galería de un clic?"**: enlaza al [flujo de entrega de plantillas de la comunidad](../../templates/community/templates/README.md), recoge `slug` y `derivedFrom` (alimentando la clasificación de citas), y convierte las dos reglas duras de la galería (las credenciales deben ser `${ENV}`, sin contenido de conocimiento/personal) en casillas de verificación.

> Los campos de formulario están en inglés — consistente con la convención existente de `.github/ISSUE_TEMPLATE/`; el bloque de introducción de cada formulario añade una pista en chino de una línea para acomodar a los usuarios con chino como idioma principal. La publicación de bienvenida (§5) es primero en chino, segundo en inglés.

---

## 5. Borrador de publicación de bienvenida / fijada (listo para copiar y pegar)

Después de habilitar Discussions, **copia el bloque completo a continuación**, publica una nueva Discussion en la categoría **General** con el título `👋 欢迎来到 Gotong 客厅 / Welcome`, y haz clic en **Pin**. El borrador original comienza con chino (el público principal de la comunidad) luego inglés; reordena según corresponda a tu audiencia.

```markdown
## 👋 Welcome to the Gotong living room

This is where the Gotong community hangs out — ask, show, and talk shop. The map:

- **🙋 A question?** Open one in **Q&A**. Say what you're trying to do and what you
  tried; someone will help.
- **🛠 Built something?** Show it in **Show & Tell**. If it's a template others can
  import-and-run, submit it to the one-click gallery via the
  [submit flow](../../tree/main/templates/community/templates).
- **💡 An idea?** Pitch it in **Ideas**. Gotong has a deliberate spine — aiming with
  it lands better: **the hub never runs an LLM · people and agents are the same
  Participant · state is files on disk · federation is peer-to-peer (workflows can
  cross org lines, but credentials/data/billing each stay home)**.
- **🐞 A bug?** That goes to [Issues](../../issues/new/choose), not here.
- **🔐 A security issue?** Please do **not** post it publicly — use the private
  channel in [SECURITY.md](../../blob/main/SECURITY.md).

New here? Start with the [5-minute overview](../../blob/main/docs/OVERVIEW.md) and the
[hands-on hubs](../../blob/main/docs/zh/HANDS-ON-HUBS.md). One house rule: be kind to
people, rigorous about ideas — full text in the
[Code of Conduct](../../blob/main/CODE_OF_CONDUCT.md). Have fun 🎉

---

## 👋 欢迎来到 Gotong 客厅

这里是 Gotong 的客厅——问问题、晒成果、聊想法的地方。先认认门:

- **🙋 有问题?** 去 **Q&A** 开一帖。说清楚你想做什么、试过什么,有人会帮你。
- **🛠 做了东西?** 去 **Show & Tell** 晒出来。如果是一个**别人能照着导入就跑**的
  模板,顺手按 [提交流程](../../tree/main/templates/community/templates) 提进一键画廊。
- **💡 有想法?** 去 **Ideas** 提。Gotong 有一条明确的脊梁,对着它提更容易被采纳:
  **框架不跑大模型 · 人和 agent 是同一种参与者 · 状态都是磁盘文件 · 联邦点对点
  (工作流能跨边界,但凭证/数据/计费各归各家)**。
- **🐞 发现 bug?** 那个去 [Issues](../../issues/new/choose),不在这里。
- **🔐 安全问题?** **千万别**公开发——走 [SECURITY.md](../../blob/main/SECURITY.md)
  里的私密上报通道。

新来的,从这两篇开始:
- [5 分钟总览](../../blob/main/docs/zh/OVERVIEW.md) —— 一页地图看懂所有概念。
- [开箱即用的 hub 案例](../../blob/main/docs/zh/HANDS-ON-HUBS.md) —— 挑一个最像你
  需求的,5 分钟跑起来。

一条公约:对人客气、对事较真。完整版见
[行为准则](../../blob/main/CODE_OF_CONDUCT.md)。玩得开心 🎉
```

> Los enlaces en el borrador anterior usan rutas relativas al repositorio de GitHub (`../../tree/main/…`, `../../blob/main/…`), que se resuelven correctamente a los archivos del repositorio una vez pegados en una Discussion. Previsualiza antes de publicar para confirmar que no hay enlaces rotos.

---

## 6. Cómo se integra con el resto

Este elemento no está aislado — conecta el salón con las líneas que la lista de verificación pre-lanzamiento ya estableció:

- **Enrutamiento de issues**: el enlace "💬 Pregunta o discusión" en [`ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml) ha apuntado durante mucho tiempo a `/discussions`; una vez habilitado, este enlace deja de ser un 404.
- **Galería de plantillas / clasificación**: el formulario de Show & Tell envía a los autores de plantillas al [flujo de entrega de plantillas de la comunidad](../../templates/community/templates/README.md); después de que una entrega es fusionada, aparece en la galería de un clic ([`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md)) y la tienda estática ([`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md)); el `derivedFrom` que recopila el formulario alimenta la clasificación de citas.
- **Gobernanza**: [`GOVERNANCE.md`](../../GOVERNANCE.md) lista Discussions como una de las entradas para contribuidores; las direcciones que toman forma en Ideas aterrizan a través del proceso de decisión de GOVERNANCE.

El elemento "Habilitar GitHub Discussions" en `.github/RELEASE-CHECKLIST.md` ahora apunta a este documento.

---

## 7. Límites (honestos)

- **Claude no puede habilitar Discussions**: ese es un interruptor en la Configuración del repositorio (§2), solo el propietario puede hacer clic en él en la interfaz web. Lo que este repositorio puede hacer — el "andamiaje": plantillas de formulario, borrador de publicación de bienvenida, enlace de enrutamiento, documentación — todo está listo.
- **Los formularios no son revisión**: las plantillas de Discussion solo **guían la publicación**, no bloquean ni validan. La validación real para que una plantilla entre en la galería es [`pnpm check:templates`](../../templates/community/templates/README.md) (pasando `parseTemplate` real), que es un asunto separado.
- **Sin migración forzada de historial**: los enlaces dispersos en los documentos de hoy que apuntan a `/discussions` (REAL-WORLD-TESTING, LICENSE-FAQ, etc.) entran en funcionamiento naturalmente una vez habilitado, sin necesidad de volver y editarlos.

---

## Relacionado

- [`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md) — la tienda estática sin cómputo (la otra mitad de la misma postura).
- [`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) — la galería de instalación con un clic dentro de la consola de administración.
- [`FLAGSHIP-TEMPLATES.md`](../FLAGSHIP-TEMPLATES.md) — el índice seleccionado de plantillas insignia + clasificación de citas.
- `../../CONTRIBUTING.md` · `../../GOVERNANCE.md` · `../../CODE_OF_CONDUCT.md` — los archivos raíz de la comunidad.
- [`templates/community/templates/README.md`](../../templates/community/templates/README.md) — el flujo de entrega de plantillas en 5 pasos.
