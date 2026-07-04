# Contribuir a Gotong

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../../CONTRIBUTING.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

Gracias por considerar una contribución — y nos referimos a todo tipo de contribución, grande o pequeña. Construir algo nuevo y llevar el proyecto a las personas cuentan igual. Un parche, un informe de error, una traducción, un tutorial, una charla, una respuesta de apoyo en Discussions — todo es bienvenido. Todo se reconoce — ver [`CONTRIBUTORS.md`](../../CONTRIBUTORS.md), el escaparate curado de aprendizaje [`LEARN.md`](../../LEARN.md), y por qué lo hacemos en [`docs/RECOGNITION-SYSTEM.md`](../RECOGNITION-SYSTEM.md).

## Reglas básicas

- **Sé amable.** Trata a cualquiera en el rastreador de issues / PRs de la manera en que querrías que un ingeniero senior te tratara en un mal día.
- **PRs pequeños.** Los cambios independientes se envían más rápido que los mega-PRs. Si una función se divide limpiamente, envía las partes por separado.
- **El Hub se mantiene tonto.** La idea de diseño completa de Gotong es que el Hub enruta / persiste y no posee lógica de agente. Los parches que metan llamadas LLM, bucles de agentes o reglas de negocio en el Hub serán redirigidos.
- **El protocolo wire tiene versiones.** Cualquier cosa que cambie las formas de mensajes a nivel de protocolo pasa por `docs/PROTOCOL.md` y un incremento de versión de protocolo. Los cambios solo locales no.
- **Sin dependencias sorpresa.** Añadir una dependencia en tiempo de ejecución (especialmente las nativas) es una decisión real — abre un issue primero.

## Flujo de trabajo

```bash
# haz fork en GitHub, luego:
git clone git@github.com:<tú>/Gotong.git
cd Gotong
pnpm install
pnpm build

# haz cambios…

pnpm -r typecheck      # todos los 19+ paquetes verifican tipos sin errores
pnpm -r test           # vitest en todos los paquetes
pnpm test:python       # pytest del python-sdk
```

Convenciones:

- TypeScript en modo estricto, ESM con extensiones `.js` en rutas de importación relativas (la resolución "node16/nodenext" de TypeScript lo requiere).
- Las pruebas viven junto al código que cubren (`packages/*/tests/`).
- Lint no está aplicado por una herramienta todavía; empareja el estilo de los archivos existentes.
- Mensajes de commit: imperativo ("add foo", no "added foo"). Un párrafo para commits no triviales es bienvenido.

## Estructura del repositorio

```
packages/
  core/           Hub + registro + planificador + transcript + Space
  protocol/       Tipos de protocolo wire (sin runtime)
  transport-ws/   Adaptador WebSocket del lado del Hub
  sdk-node/       SDK de Node para agentes remotos (connect + AgentParticipant)
  web/            Servidor web embebible + SPA estática
  host/           Binario de producción (controlado por env, sin estado de demo)
  llm/            Clase base LlmAgent + interfaz LlmProvider
  llm-anthropic/  Proveedor Anthropic
  llm-openai/     Proveedor OpenAI
python-sdk/       SDK de Python (espejo de sdk-node)
examples/         Demos ejecutables
docs/             Documentación larga de arquitectura / protocolo / despliegue
```

## Áreas en las que trabajar

Si quieres una tarea de inicio con poco contexto, busca issues etiquetados con `good-first-issue`. Algunos temas siempre bienvenidos:

- **Documentación**: errores tipográficos, ejemplos más claros, traducciones (el proyecto tiene mantenedores de habla china; los documentos solo en inglés todavía son más escasos).
- **Cobertura de pruebas**: especialmente para los casos límite del planificador y las rutas de migración en disco del Space.
- **Proveedores LLM adicionales**: copia la forma de `packages/llm-anthropic`.
- **A11y / i18n en la UI de administración**: JavaScript vainilla, sin framework, área de superficie pequeña.

## Contribuir una plantilla

No tienes que escribir TypeScript para contribuir. Gotong incluye **plantillas** — YAML autocontenido que alguien importa para obtener un hub funcional (agentes + flujos de trabajo + referencias de bases de conocimiento, nunca secretos ni contenido de conocimiento).

- Un solo prompt adaptado → [`templates/community/`](../../templates/community/).
- Un hub importable completo (multi-agente + flujos de trabajo) → [`templates/community/templates/`](../../templates/community/templates/) — ese README recorre el flujo de 5 pasos: copia un ejemplo insignia, adáptalo, declara la procedencia (`derivedFrom`), valida localmente con `pnpm check:templates`, abre un PR.

La barra para ser *fusionado como plantilla de la comunidad* (la licencia está clara, analiza correctamente, sin secretos literales) es más baja que la barra para ser *enviado como insignia* (demo determinista, postura de gobernanza declarada, mantenido). Ver [`GOVERNANCE.md`](../../GOVERNANCE.md).

## Difundir la palabra también cuenta

Si escribiste un tutorial, diste una charla o mantuviste la documentación viva en
tu idioma, eso es una contribución de primera clase — no una categoría secundaria.

- **Abre un pull request en [`CONTRIBUTORS.md`](../../CONTRIBUTORS.md)** añadiendo
  una fila para ti mismo (o para otra persona). Enlaza el artefacto en la
  descripción del PR para que un maintainer pueda verlo.
- **Si tu material es un vídeo, tutorial o charla que enseña Gotong bien**,
  también puede ser curado en [`LEARN.md`](../../LEARN.md) — el escaparate al
  que se dirige a los nuevos usuarios. Pide que sea añadido en el mismo PR.

La escalera de mantenedores ([`GOVERNANCE.md`](../../GOVERNANCE.md)) cuenta el
trabajo sostenido de difusión — localización, gestionar la comunidad, material
educativo — como **equivalente al código** hacia una voz real en el proyecto.

## Reportar errores

Un informe de error útil tiene:

- Lo que intentaste (línea de comando completa, variables de entorno completas)
- Lo que esperabas
- Lo que ocurrió (salida de error completa si la hay, extracto de `transcript.jsonl` si el error está en enrutamiento / persistencia)
- Versiones: `node --version`, `pnpm --version`, SO

Para errores de forma de red (trabajadores desconectándose, agentes no siendo enrutados), incluye la instantánea de `/api/state` — es el "qué cree el hub que está pasando" canónico.

## Seguridad

Los problemas de seguridad **no** pertenecen al rastreador público de issues. Ver [`SECURITY.md`](../../SECURITY.md).

## Licencia

Al contribuir aceptas que tu trabajo se ofrece bajo la [licencia MIT](../../LICENSE) utilizada por el proyecto. Sin CLA.
