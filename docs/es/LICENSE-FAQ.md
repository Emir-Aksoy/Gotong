# Preguntas frecuentes sobre la licencia

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../LICENSE-FAQ.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

> **AipeHub en su totalidad tiene licencia bajo la [Licencia MIT](../../LICENSE).**
> Esta página responde las preguntas comunes de "¿puedo / debo / qué debo
> tener en cuenta" en formato de preguntas frecuentes. No es asesoramiento legal —
> para trabajo real de cumplimiento corporativo, habla con tu propio abogado.
>
> Versión en español: este documento · Versión en chino: [`docs/zh/LICENSE-FAQ.md`](../zh/LICENSE-FAQ.md)

---

## 1. ¿Puedo incrustar AipeHub en mi producto de código cerrado / SaaS / herramienta interna?

**Sí.** MIT está entre las licencias OSS más permisivas. Permite:

- ✅ Uso comercial, incluido reempaquetar todo AipeHub y venderlo
- ✅ Modificar el código fuente, renombrarlo (aunque si lo renombras, por favor di "basado en AipeHub")
- ✅ Derivados de código cerrado — tus cambios **no** tienen que ser de código abierto
- ✅ Incluir `@aipehub/core` en un SaaS de código cerrado como dependencia npm

**El único requisito estricto**: mantener el archivo LICENSE + el aviso de
copyright (listar AipeHub en la página NOTICE / Third-Party-Licenses de tu producto
es suficiente).

---

## 2. Modifiqué el código fuente — ¿debo contribuir los cambios de vuelta?

**No.** MIT no es copyleft. Puedes:

- Mantener tus modificaciones privadas
- Enviarlas como parte de un producto comercial
- Nunca enviar un PR upstream — eso está completamente bien

Dicho esto, damos la bienvenida a los PRs — cuanto mejor sea el proyecto, más barata
será tu próxima actualización. Ver [`CONTRIBUTING.md`](../../CONTRIBUTING.md) para el
proceso.

---

## 3. ¿Qué debo tener en cuenta al usar las plantillas de prompts de terceros en `templates/community/` comercialmente?

`templates/community/` recopila dos fuentes upstream:

| Fuente | Licencia | Uso comercial | Nota |
|---|---|---|---|
| [`awesome-chatgpt-prompts`](https://github.com/f/awesome-chatgpt-prompts) | **CC0 1.0** (dominio público) | ✅ cualquier uso | La atribución legalmente **no es requerida**; mantenemos la línea de fuente por respeto |
| [`awesome-chatgpt-prompts-zh`](https://github.com/PlexPt/awesome-chatgpt-prompts-zh) | **MIT** | ✅ cualquier uso | **Debes mantener** el aviso de copyright + licencia |

¿Cómo se mantiene el aviso? `templates/community/` ya lo lleva en tres capas:

1. Un **comentario de encabezado de 4 líneas** en cada archivo yaml: `# Source` /
   `# Upstream` / `# License` / `# Adapted`
2. El archivo agregado
   [`templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md)
   mantiene el texto MIT completo + un resumen CC0 + las URLs de los repositorios
   upstream
3. El [`README.md`](../../templates/community/README.md) del directorio
   explica las reglas de adaptación y la matriz de licencias

Siempre que redistribuyas `templates/community/` **con esas tres capas intactas**
(fork de git / URL raw en la nube / CDN interno — todo bien), estás completamente en
cumplimiento.

> "Pegué el contenido de una plantilla en la UI de administración y aterrizó en mi
> `secrets.enc.json` / `agents.json` — ¿es eso distribución?" —
> **No.** Simplemente la estás usando dentro de tu propio despliegue, no
> transmitiéndola a terceros. No se necesita ninguna acción de atribución.

---

## 4. ¿Puedo cambiar el LICENSE y volver a publicar esto como "nuestro" producto?

Puedes **cambiar el nombre del producto y añadir tu propia línea de licencia**,
pero **no puedes eliminar el texto MIT original**:

- ✅ Tu derivado puede llamarse `BobHub`, y puede ser Apache-2.0 /
  propietario / algo que tú mismo escribiste
- ✅ Puedes poner tu propio copyright en tu propio archivo LICENSE
- ⚠️ Pero **debes mantener, en algún lugar** (p.ej. NOTICE.md o
  THIRD-PARTY.md), el texto MIT original de AipeHub + la línea de copyright upstream
- ❌ **No puedes** afirmar "AipeHub es nuestro trabajo original" — eso es
  fraude, independientemente de la licencia

---

## 5. Importé un prompt privado que un compañero de trabajo escribió con GPT como agente — ¿algún riesgo de licencia?

**Ninguno en el lado de AipeHub.** Los prompts que tú o tu empresa escribís son
activos propios de tu empresa; AipeHub es solo el contenedor de tiempo de ejecución.
Sin embargo, deberías confirmar:

- Si el resultado de GPT de tu compañero de trabajo cumple con los términos de
  servicio de OpenAI (la política de OpenAI sobre la "propiedad" de la salida del
  modelo ha variado con el tiempo — pregunta al área legal)
- Si el prompt **cita** extractos del código / artículo de otra persona, si la propia
  licencia de esa cita lo permite

Ninguno es algo que el proyecto AipeHub gobierne — MIT licencia el software en sí,
no el contenido que generas con él.

---

## 6. Estoy desplegando AipeHub dentro de la intranet de un cliente — ¿qué archivos de licencia entrego?

Como mínimo:

- El archivo `LICENSE` de la raíz del repositorio de AipeHub
- Si usas `templates/community/`: trae también `LICENSE-NOTICES.md`
- Si incrustas el paquete npm `@aipehub/core`: el paquete incluye su propia
  licencia en la instalación; la redistribución downstream solo necesita mantener
  `node_modules/@aipehub/*/LICENSE` sin eliminar

Un patrón común es una página de "Licencias de terceros" en tu producto que lista
todos los textos de licencias OSS upstream. Añade el MIT de AipeHub ahí y listo.

---

## 7. ¿Las dependencias de tiempo de ejecución de AipeHub contienen copyleft estilo GPL/AGPL?

Actualmente no. Las dependencias principales:

| Dependencia | Licencia |
|---|---|
| `ws` (WebSocket) | MIT |
| `yaml` | ISC |
| `better-sqlite3` (opcional) | MIT |
| `@anthropic-ai/sdk` (dep peer opcional) | MIT |
| `openai` (dep peer opcional) | Apache-2.0 |
| `vitest` (solo desarrollo) | MIT |
| `tsx` (solo desarrollo) | MIT |

Todas permisivas. Si alguna vez se propusiera una dependencia GPL/AGPL abriríamos
primero un issue; nuestra tendencia es **evitar** dependencias copyleft para mantener
la flexibilidad downstream.

---

## 8. ¿El protocolo wire de AipeHub es parte de la licencia?

No. El formato de trama JSON descrito en `docs/PROTOCOL.md` es una
**especificación de facto** — cualquiera puede implementar su propio servidor hub o SDK
**sin ningún permiso**. Alentamos los puertos al ecosistema de lenguajes
(Go / Rust / SDKs de navegador etc.); cada uno elige su propia licencia.

---

## 9. ¿Cómo reporto una vulnerabilidad?

A través del **Aviso de seguridad de GitHub** (envío privado) en el repositorio del
proyecto — ese es el único canal de seguridad; deliberadamente no hay correo electrónico
de seguridad (ver [`SECURITY.md`](../../SECURITY.md)). Publicar detalles de
vulnerabilidad en un issue público **no está bien** — aunque la licencia lo permitiría.

---

## 10. ¿Mi empresa puede bifurcar AipeHub internamente sin abrir el código del fork?

**Por supuesto.** MIT no se propaga. Puedes:

- Bifurcar en tu Git privado → modificar libremente → desplegar en la intranet
- Renombrar el fork y desplegarlo de forma privada para los clientes
- Vender los artefactos de compilación del fork como un binario de código cerrado

Siempre que **el entregable final mantenga la licencia MIT original de AipeHub en
algún lugar** (típicamente una página de "avisos de código abierto"), estás listo.

---

## TL;DR

> "**Simplemente úsalo.**" — El 99 % del uso ordinario no necesita ninguna acción
> adicional más allá de mantener el archivo LICENSE + la línea de copyright.
> `templates/community/` añade un paso: mantener `LICENSE-NOTICES.md`.
> Todo lo demás solo se activa cuando haces una de las cosas especiales
> mencionadas arriba.

> ¿Todavía no estás seguro? Abre una GitHub Discussion y haremos lo posible;
> para decisiones reales de cumplimiento, pregunta al abogado de tu empresa.
