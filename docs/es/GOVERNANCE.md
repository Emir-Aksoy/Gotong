# Gobernanza de AipeHub

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../../GOVERNANCE.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

Este documento describe **cómo se toman las decisiones** en AipeHub: quién mantiene
el proyecto, cómo llega un cambio, cómo una plantilla de la comunidad entra en la galería oficial,
y qué ocurre cuando la gente no está de acuerdo. Es deliberadamente pequeño —
el proyecto es joven, y una estructura de gobernanza pesada en un proyecto pequeño es
solo ceremonial. Haremos crecer este documento a medida que crezca la comunidad, no antes.

Este documento se enmarca bajo la constitución del proyecto, [`CHARTER.md`](../../CHARTER.md):
la carta dice *qué* es AipeHub y en qué se niega a convertirse; esto dice *cómo*
decidimos. Donde los dos se encuentran — por ejemplo, "el framework no ejecuta el LLM" — la
carta es la fuente y este es la aplicación.

Si solo lees una cosa: **la línea de diseño no está sujeta a negociación, pero
casi todo lo demás sí.** Ver [Lo único no negociable](#lo-único-no-negociable).

---

## Roles

Mantenemos tres roles. No hay un cuarto nivel secreto.

| Rol | Qué significa | Cómo se obtiene |
|---|---|---|
| **Contribuidor** | Cualquiera que abra un issue, envíe un PR, presente una plantilla o ayude en Discussions. | Solo aparecer. Sin solicitud. |
| **Mantenedor** | Puede revisar y fusionar PRs, clasificar issues y publicar versiones. Responsable de un subsistema o del proyecto en su totalidad. | Un historial de contribuciones buenas y alineadas con el diseño, luego nominado abiertamente — ver [Convertirse en mantenedor](#convertirse-en-mantenedor). |
| **Administrador** | Árbitro final en decisiones controvertidas y guardián de la línea de diseño. Hoy es el mantenedor fundador. | En manos del fundador hasta que el proyecto sea lo suficientemente grande para elegir administradores (ver [Comité de componentes](#camino-hacia-un-comité-de-componentes)). |

Los mantenedores actuales están listados en [`MAINTAINERS.md`](../../MAINTAINERS.md) — hoy
es solo el mantenedor fundador, quien también es el administrador, el revisor y el
gestor de versiones. Este documento existe precisamente para que ese arreglo sea
**temporal y esté escrito**, no un hábito, y la siguiente sección es el camino
que toma el segundo mantenedor.

### Convertirse en mantenedor

La escalera es deliberadamente ligera — este es un proyecto joven, y el objetivo es
crecer un grupo de personas que mantengan la línea de diseño, no crear barreras. Una guía
aproximada, no una lista de verificación a manipular:

- **Un historial, no un recuento.** Del orden de ~5 PRs no triviales fusionados —
  o el equivalente: una plantilla de referencia que mantienes actualizada, un adaptador
  sustancial, ayuda sostenida de revisión / clasificación, mantener la documentación viva
  en un idioma que el equipo central no habla, gestionar la comunidad para que los nuevos
  usuarios no se queden atascados, o material educativo sostenido que trae personas al
  proyecto (ver [pilar ⑤ del sistema de reconocimiento](RECOGNITION-SYSTEM.md#pillar-5)
  y [`CONTRIBUTORS.md`](../../CONTRIBUTORS.md)) — durante un par de meses. El número es un piso
  para "hemos visto suficiente de tu trabajo para confiar en tu juicio", nunca un objetivo
  a alcanzar con PRs superficiales.
- **Una comprensión de la línea de diseño.** Tus PRs y revisiones muestran que buscas un
  *participante*, no el Hub, cuando la lógica necesita un hogar (ver
  [Lo único no negociable](#lo-único-no-negociable)).
- **Nominado abiertamente.** Un mantenedor existente te nomina en un issue público —
  la auto-nominación está bien, simplemente di por qué. La aprobación es por consenso perezoso
  entre los mantenedores y el administrador lo confirma; tu nombre llega a
  [`MAINTAINERS.md`](../../MAINTAINERS.md) en ese mismo PR.

Lo que asumes: revisar los PRs de otros en tu área, mantener la línea de diseño,
y responder a issues de lo que mantienes. Es una responsabilidad que también puedes
dejar — retírate en cualquier momento y te moveremos a emérito en `MAINTAINERS.md`
en lugar de fingir que aún estás disponible.

Hoy hay exactamente un mantenedor — el administrador fundador — por lo que esta escalera está
**escrita pero dormida**: no hay nadie que nominar todavía. Está aquí para que el
*segundo* mantenedor se incorpore por un camino conocido, no por un toque informal en el hombro.

---

## Cómo llega un cambio

La mayoría de los cambios son aburridos, y lo aburrido es bueno:

1. **Abre un issue primero** para cualquier cosa no trivial — una nueva dependencia, un
   cambio de forma de protocolo, un nuevo paquete, un cambio de comportamiento en la programación o
   federación. Los PRs de corrección de errores tipográficos y las correcciones pequeñas de documentación pueden saltarse esto.
2. **Envía un PR pequeño.** Un cambio, un PR. Ver [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
3. **Un mantenedor lo revisa.** Las revisiones comprueban tres cosas, en orden:
   corrección, la [línea de diseño](#lo-único-no-negociable), y simplicidad.
4. **Fusionar.** Consenso perezoso: si ningún mantenedor objeta dentro de una ventana
   razonable y CI / comprobaciones locales pasan, se fusiona. Las objeciones se resuelven mediante
   discusión; un bloqueo genuino va al administrador.

No requerimos un CLA. Al contribuir, ofreces tu trabajo bajo la
[licencia MIT](../../LICENSE) del proyecto.

### Decisiones que necesitan más que un PR

Algunas categorías reciben cuidado adicional, y un mantenedor las ralentizará
intencionadamente:

- **Cambios en el protocolo de wire** — cualquier cosa que altere las formas en
  [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md). Estos obtienen un incremento de versión y una
  nota explícita de migración.
- **Cambios de schema irreversibles** (eliminar una columna / tabla). Aunque el
  proyecto no promete compatibilidad hacia adelante antes de la v1.0, discutimos el radio de
  explosión antes de eliminar datos persistidos.
- **Nuevas dependencias de runtime**, especialmente las nativas. Abre un issue.
- **Eliminar una superficie de API pública.** Describe el impacto primero, incluso si
  crees que nadie la usa.

---

## Cómo una plantilla entra en la galería oficial

AipeHub incluye **plantillas** (`aipehub.template/v1` — un YAML autocontenido que
lleva un equipo de agentes + workflows + *referencias* a bases de conocimiento, pero nunca
secretos, contenido de conocimiento ni personal). El umbral para ser *enviado con el
framework* — para aparecer en la galería de un clic en la admin UI y en el
sitio público — es más alto que el umbral para ser *aceptado como plantilla de la comunidad*.

Hay dos niveles, y son promesas diferentes:

### Plantillas de la comunidad — "comprobamos la licencia y se analiza"

Viven bajo [`templates/community/`](../../templates/community/). Para ser fusionada, una
plantilla de la comunidad debe:

1. **Analizarse.** Pasa el `parseTemplate` real (y cada workflow embebido
   pasa el `parseWorkflow` real). Esto es aplicado por una prueba de validación automatizada,
   no por un ojo humano — ver
   [`templates/community/templates/README.md`](../../templates/community/templates/README.md).
2. **Llevar procedencia honesta.** Si se deriva de otra plantilla o de una
   biblioteca de prompts upstream, lo declara en el bloque `provenance`
   (`derivedFrom`, `author`, `notes`). La procedencia es cómo fluye el crédito de citas
   hacia arriba — no la elimines.
3. **No llevar secretos.** Cada credencial es un marcador de posición `${ENV}`. Una plantilla
   con una clave literal en ella es rechazada, sin excepciones.
4. **Tener una licencia clara y compatible con uso comercial** para cualquier material
   upstream adaptado (CC0 / MIT / Apache-2.0 / BSD). Las fuentes sin licencia o solo
   para uso no comercial no son aceptadas. Ver
   [`templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md).

Eso es todo. Una plantilla de la comunidad que cumple el umbral se fusiona. No estamos
curarando el gusto en este nivel — estamos curado la *seguridad y la honestidad*.

### Plantillas de referencia — "las avalamos"

Un pequeño conjunto curado (ver [`docs/zh/FLAGSHIP-TEMPLATES.md`](../../docs/zh/FLAGSHIP-TEMPLATES.md))
que el proyecto recomienda activamente a un usuario no técnico. Además del umbral
de la comunidad, una plantilla de referencia debe:

1. **Incluir un demo determinístico** que se ejecuta sin clave de API y auto-valida su
   propio comportamiento (la convención de `examples/*`). Un revisor puede demostrar que funciona en
   un solo comando.
2. **Declarar su postura de gobernanza claramente** — qué puede tocar, qué no puede,
   y dónde hay un humano en el bucle. Una plantilla que puede cerrar una puerta,
   gastar dinero o enviar los datos de un niño a través de un enlace de federación debe mostrar la
   gate de confirmación humana, no enterrarla.
3. **Estar mantenida.** Una plantilla de referencia tiene un mantenedor que responde a los issues
   al respecto. Si se deteriora y nadie la arregla, vuelve al nivel de la comunidad.

La promoción de comunidad → referencia es una decisión de mantenedor, tomada abiertamente
en un issue. La degradación es lo mismo.

---

## Cuando la gente no está de acuerdo

El desacuerdo es normal y bienvenido — es cómo se pone a prueba un diseño.
El proceso:

1. **Discútelo en el issue / PR.** Expón el compromiso, no solo la
   conclusión. "Prefiero X" es débil; "X porque Y, al costo de Z" es útil.
2. **Un mantenedor toma la decisión** si la discusión se estanca. Los mantenedores deben
   explicar *por qué*, en el registro.
3. **El administrador es el árbitro** para decisiones genuinamente contestadas, y la
   autoridad final sobre si un cambio cruza la línea de diseño. Este es un
   recurso, no un paso rutinario — un administrador que tiene que resolver empates con frecuencia es un
   administrador que no ha logrado hacer crecer el banco de mantenedores.

Las disputas de conducta se manejan por separado — ver
[`CODE_OF_CONDUCT.md`](../../CODE_OF_CONDUCT.md).

---

## Lo único no negociable

AipeHub tiene exactamente un compromiso arquitectónico que un PR no puede eliminar por votación,
porque cambiarlo significa que el proyecto ya no es AipeHub:

> **El framework no ejecuta el LLM.** El Hub enruta mensajes, despacha
> tareas, escribe el transcript y emite eventos. Cada decisión permanece en los
> participantes — agentes, humanos, servicios externos. El estado son archivos en disco;
> las credenciales permanecen locales; la federación es punto a punto con fronteras explícitas por enlace.

Los parches que ponen llamadas a LLM, bucles de agentes o reglas de negocio *en el Hub* serán
redirigidos — no porque la idea sea mala, sino porque pertenece a un
participante, no al sustrato. Todo lo demás — schedulers, proveedores,
adaptadores, transportes, UI, plantillas — está abierto a cambio.

---

## Camino hacia un comité de componentes

La forma a largo plazo de este proyecto es un **mercado de componentes gobernados y
reutilizables** — plantillas, adaptadores, conectores de bases de conocimiento — en los que
la gente confíe lo suficiente para apuntar a su hogar, su familia o su dinero.
Curar ese mercado es más de lo que una sola persona puede hacer, y más de lo que una sola
persona *debería* hacer.

Cuando la base de contribuidores sea lo suficientemente grande como para que la curación de la galería sea un
trabajo real y recurrente, estableceremos un **comité de componentes**: un pequeño grupo
elegido de mantenedores responsable de qué se promueve a referencia, cómo
se muestra el crédito de citas, y cómo se resuelven las disputas entre autores de plantillas. Este
documento se enmendará en ese momento para describir cómo se nominan, eligen y
rotan los miembros del comité.

Estamos escribiendo este párrafo ahora, mientras el proyecto es pequeño, para que el
comité sea un **hito planificado con un mandato escrito** en lugar de una
toma de poder ad hoc más adelante. El desencadenante es el volumen sostenido de contribuciones, no una
fecha.

---

## Capítulos regionales

El estado final es un grafo libre de hubs soberanos, no una plataforma central — y el
lado humano de ese grafo son **capítulos regionales**: grupos locales, arraigados en un idioma
o comunidad, que ejecutan sus propios hubs, curan plantillas para sus comunidades,
y ayudan a los recién llegados en su propia lengua. La carta ([`CHARTER.md`](../../CHARTER.md) §11)
los acoge; esta sección dice cómo funciona uno en la práctica.

Un capítulo es **soberano, no una franquicia.** Posee su sala y no responde a ningún
propietario central. No se requiere el permiso de nadie para *iniciar* uno — eso
contradiría toda la premisa de "ninguna parte única cuyo permiso necesitas para seguir funcionando"
sobre la que descansa el proyecto. Puedes levantar un hub, reunir una comunidad local y
curar plantillas para ellos hoy, y llamarlo un capítulo de AipeHub.

Lo que un capítulo **no** es:

- **No es la voz oficial del proyecto.** Un capítulo habla por su propia comunidad,
  no por AipeHub. No establece la línea de diseño, no ratifica la carta, ni decide
  qué se promueve a referencia — esas cosas permanecen con los mantenedores y el administrador en
  el repositorio canónico ([`MAINTAINERS.md`](../../MAINTAINERS.md)).
- **No es un fork que mantiene la línea.** Un capítulo puede ejecutar una compilación modificada para su propia
  gente, pero la carta, el protocolo y el conjunto de referencia autorizados viven en el
  repositorio canónico. Un capítulo que quiere que sus cambios sean *el* AipeHub los envía
  upstream como pull requests, como cualquier otro.

### El reconocimiento es opcional y ligero

Dirigir un capítulo no necesita bendición. Estar **listado** como un capítulo reconocido — enlazado
desde el proyecto para que los recién llegados puedan encontrarte — es un pequeño paso opcional, y funciona de forma similar
a la promoción de plantillas:

1. **Anúncialo en Discussions** — quién eres, la región / idioma / comunidad que
   atiendes, y dónde vive tu hub.
2. **Un mantenedor lo avala en un issue público.** El umbral es honestidad, no tamaño: representas
   el proyecto con veracidad, sigues el
   [`CODE_OF_CONDUCT.md`](../../CODE_OF_CONDUCT.md), y no reclamas un estatus oficial que
   no tienes.
3. **El reconocimiento puede retirarse** de la misma manera en que se otorgó — en un issue público, con
   razones — si un capítulo representa mal el proyecto o rompe la línea de conducta. El
   proyecto no puede (y no intentará) cerrar el hub de un capítulo — esa es su
   sala soberana — pero puede dejar de listarlo y pedirle que deje de implicar un
   respaldo que ya no tiene.

Cuando el **comité de componentes** se establezca (ver arriba), curar la lista de capítulos y
resolver disputas entre capítulos se convierte en una parte natural de su mandato; hasta entonces
es una decisión ligera de mantenedor.

---

## Uso del nombre AipeHub

El código es [MIT](../../LICENSE) — puedes embebido, modificarlo y enviarlo en productos comerciales o
de código cerrado, con la licencia y el aviso de copyright conservados. La **licencia
cubre el código; no entrega el nombre e identidad del proyecto.** No hay aquí
una marca registrada, y no fingiremos lo contrario — lo que sigue es una
**norma comunitaria**, pedida de buena fe, no una amenaza legal:

- **El uso descriptivo es bienvenido.** "Construido sobre AipeHub", "un hub de AipeHub", "el capítulo
  AipeHub Malaysia" — di estas cosas libremente. Son verdaderas, y nos alegra que las digas.
- **No impliques un respaldo que no tienes.** No nombres un producto, fork o
  servicio de una manera que lo presente *como* AipeHub-el-proyecto o como oficialmente bendecido
  por él — sin "AipeHub Oficial", sin un clon que se presenta como la descarga canónica.
- **No rebrandices el proyecto canónico.** Una distribución modificada es tuya para enviar,
  pero el "AipeHub" autorizado — la carta, la línea de diseño, el conjunto de referencia — es
  el que está en el repositorio canónico. Si tu fork diverge en espíritu, dale tu propio
  nombre; la licencia MIT garantiza que puedes, y un nombre honesto sirve mejor a tus usuarios
  que uno prestado.

Esta es la versión más ligera de protección de nombre que funciona: suficiente para que "AipeHub" siga
significando lo que la carta describe — gobernado, file-first, humano en el bucle — y nada
más.

---

## Enmienda de este documento

Los cambios de gobernanza se realizan igual que el código: abre un issue, envía un PR, obtén
la revisión del mantenedor. Los cambios en [Lo único no negociable](#lo-único-no-negociable)
requieren la aprobación del administrador y una declaración clara de por qué la línea de diseño debería
moverse. Esperamos que esa sección nunca cambie. El resto está pensado para crecer.
