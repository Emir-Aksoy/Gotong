# Página de inicio de la comunidad + Galería de plantillas + Clasificación de citas (sitio estático sin cómputo)

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../COMMUNITY-SITE.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

> Elemento 7 de la lista de verificación pre-lanzamiento. En una línea: **la comunidad necesita cero cómputo** — constrúyela como un conjunto de archivos estáticos, déjala caer en cualquier host estático gratuito y está en vivo; la caja en la nube queda como respaldo.

---

## 1. Por qué "cero cómputo"

La postura de diseño completa de AipeHub es **el hub no ejecuta el LLM en sí / el estado son todos archivos de disco / las credenciales se quedan en tu máquina / la federación es punto a punto**. Siguiendo esa postura hasta el final, **la infraestructura de la comunidad tampoco necesita un servidor**:

- **GitHub ya alberga la sustancia** — una plantilla es un archivo, una entrega es un PR.
- **Lo único que falta es una tienda** — y la tienda de un proyecto file-first es en sí misma un conjunto de archivos estáticos.

Entonces esta tienda = un generador + los archivos estáticos que produce. El generador es [`packages/web/scripts/build-site.mjs`](../../packages/web/scripts/build-site.mjs), que produce `site/` (raíz del repositorio, ignorado por git):

- `index.html` — un único archivo autocontenido (sin framework, sin runtime, CSS en línea): el hero de la narrativa de confianza + una cuadrícula de tarjetas de galería de plantillas + la tabla de clasificación de citas.
- `templates.json` — un feed legible por máquina `aipehub.site/v1` (la tienda también es datos, file-first).

Deja caer `site/` en cualquier nivel gratuito de GitHub Pages / Cloudflare Pages / Netlify y la tienda estará en vivo a **$0**. La caja de Tencent Cloud 2c2G sigue inactiva como respaldo.

---

## 2. Cómo construir

```bash
pnpm build:site          # script raíz, delega a packages/web
# o
pnpm -C packages/web build:site
```

Salida:

```
build-site: 11 templates → site/ (index.html + templates.json), 2 on the leaderboard
```

`site/` es un artefacto derivado que se **construye bajo demanda y no se registra** (misma postura que `dist-portable/`, ver `.gitignore`). La única fuente de verdad permanece en `examples/` y `templates/community/` (separación plantilla/framework); la tienda es su proyección de solo lectura — cambia una plantilla y vuelve a ejecutar el generador.

**Determinismo**: el generador no escribe marcas de tiempo y ordena de forma estable → las mismas entradas producen un `site/` **idéntico byte a byte**, por lo que las reconstrucciones no generan diferencias sin sentido.

---

## 3. Corpus = el mismo conjunto que es validado

El generador escanea **exactamente** las mismas dos raíces que la puerta de validación a nivel de repositorio (`pnpm check:templates` / [`tests/all-templates-parse.test.ts`](../../packages/web/tests/all-templates-parse.test.ts)) valida:

| origen | ruta | nota |
|---|---|---|
| `flagship` | `examples/*/template/*.template.ya?ml` | plantillas insignia entregadas con el framework |
| `community` | `templates/community/templates/**/*.ya?ml` | donde aterrizan las entregas de la comunidad |

Así que "cada plantilla que pasa CI aparece en la tienda" se cumple **por construcción** — un manifiesto que no se puede analizar nunca puede llegar a una tarjeta (falla `check:templates` y nunca entra).

---

## 4. Clasificación de citas = in-degree de `provenance.derivedFrom`

La clasificación lee el campo de procedencia aditiva `template.provenance.derivedFrom` (elemento 6 de la lista de verificación pre-lanzamiento):

- Una entrada `derivedFrom` es una **arista de cita**: declara "esta plantilla está adaptada de quién."
- Clasificación = **in-degree** = "cuántas plantillas derivan de mí."
- Una arista hace referencia al **slug** de la plantilla objetivo (su identificador público, ver a continuación), por lo que cuando haces fork de una plantilla, escribir el **slug del upstream** en tu `provenance.derivedFrom` completa el linaje de atribución.

Las dos aristas de cita reales entregadas con el framework (también escritas en `CLAUDE.md`):

```yaml
# examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml
provenance:
  derivedFrom: [personal-coding-hub]   # ejemplo hermano, mismo esqueleto de dispatch

# examples/tea-chain-hq/template/chain-hq.template.yaml
provenance:
  derivedFrom: [tea-supply-link]       # ESPEJO, la orquestación entre orgs en dirección inversa
```

→ En la clasificación `personal-coding-hub` y `tea-supply-link` reciben cada uno 1 voto.

**Los errores tipográficos no se absorben silenciosamente**: cuando `derivedFrom` apunta a un slug inexistente, el generador imprime un `WARNING … no template with that slug` en stderr (`buildModel` lo recopila en `unresolved`), nunca lo omite silenciosamente como 0 votos.

---

## 5. Esquema de slug (identificador público)

Un slug es la **identidad pública estable** de una plantilla — la galería (`builtin-templates.ts`), `FLAGSHIP-TEMPLATES.md` y esta tienda usan el mismo identificador, por lo que el `derivedFrom` de un fork puede hacer referencia al upstream por "el nombre que todos conocen." Reglas de `assignSlugs`:

| Origen | slug |
|---|---|
| insignia, con **exactamente un** archivo de plantilla bajo `examples/<dir>` | nombre base de `<dir>` (p.ej. `examples/tea-supply-link` contiene `tea-shop.template.yaml` → slug `tea-supply-link`, **no** el nombre del archivo) |
| insignia, con **múltiples** archivos de plantilla bajo el mismo directorio | desambiguación por stem del nombre de archivo (p.ej. `examples/family-learning-hub` contiene `family-tutor` + `child-desk`) |
| comunidad | stem del nombre de archivo |

**Un conflicto es un fallo de construcción**: dos plantillas que calculan el mismo slug → `assignSlugs` lanza un error. Un identificador público ambiguo debe fallar ruidosamente en tiempo de construcción, nunca ser una tarjeta sobreescrita silenciosamente / una arista que apunte a la plantilla equivocada. (Este guardián de unicidad es un bache real que se golpeó: `family-tutor` y `child-desk` están en el mismo directorio y antes ambos tomaban el nombre del directorio `family-learning-hub` y colisionaban.)

---

## 6. Despliegue (hosting estático gratuito)

`site/` es un artefacto puramente estático; cualquier nivel gratuito funciona. Tomando **GitHub Pages** como ejemplo (no se necesita cuota de Actions — construye localmente, empuja manualmente la rama `gh-pages` o usa la convención de Pages `/docs`):

```bash
pnpm build:site
# luego publica el contenido de site/ en el host estático de tu elección:
#   · Cloudflare Pages / Netlify: arrastra site/ dentro, o conecta un hook "build: pnpm build:site,
#     output: site" (su nivel gratuito tiene su propia cuota de construcción, independiente de la cuota de Actions de este repositorio);
#   · GitHub Pages: construye localmente luego empuja site/ a la rama gh-pages.
```

> ⚠️ La **cuota de GitHub Actions de este repositorio está agotada**, así que la construcción de la tienda **no** depende del CI de este repositorio. El generador corre localmente (gratuito); la cuota de construcción propia del host estático es un asunto separado. `site/` no se registra, así que no añade bloat al repositorio.

---

## 7. Test anti-deterioro

[`tests/build-site.test.ts`](../../packages/web/tests/build-site.test.ts) fija la lógica pura del generador (su shell de IO está guardado, por lo que `import` no activa ninguna exploración de archivos y no escribe archivos):

- `assignSlugs` — las tres reglas de slug + el guardián de unicidad (la valla de regresión para ese bache real);
- `extractTemplate` — lee la superficie de visualización + `provenance.derivedFrom` (filtrando entradas vacías) de un manifiesto sin procesar, lanza ruidosamente en esquema incorrecto;
- `buildModel` — conteo de in-degree de citas + ordenamiento de clasificación + exposición de una referencia con error tipográfico como `unresolved`;
- `escapeHtml` / `render*` — los nombres/descripciones proporcionados por la comunidad son **no confiables**, los casos XSS fijan que `<script>` nunca puede escapar el marcado.

---

## 8. Límites (honestos)

- La tienda **no** es un editor de plantillas, ni instala nada — es una ventana de visualización de solo lectura. La instalación va a través del "one-click install" de la Galería de plantillas de la consola de administración / `POST /api/admin/templates/import` (ver [`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md)).
- La **separación plantilla/framework** no se rompe: la tienda solo lee la **estructura + referencias** de un manifiesto, nunca mostrando ni llevando contenido de conocimiento ni personal (decisiones #4/#5).
- `site/` es una instantánea de tiempo de construcción: después de cambiar `examples/*/template/` o añadir una plantilla de la comunidad, debes **volver a ejecutar** `pnpm build:site`; el test anti-deterioro es el centinela.

---

## Relacionado

- [`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) — la galería de instalación con un clic dentro de la consola de administración (otro consumidor del mismo corpus).
- [`FLAGSHIP-TEMPLATES.md`](../FLAGSHIP-TEMPLATES.md) — el índice seleccionado de plantillas insignia.
- [`HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md) — la comparación de ejemplos de hub listos para usar + runbook de go-live.
- `../../CONTRIBUTING.md` — el flujo de entrega de plantillas de la comunidad (con licencia clara + pasa `pnpm check:templates`).
