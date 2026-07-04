# Matriz de dimensiones del producto + Usuario más adecuado (con la variable precio/rendimiento de DeepSeek)

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../PRODUCT-MATRIX.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

> Fecha de archivo: 2026-06-21. Este documento registra dos **matrices de comparación a nivel de producto** (una tabla de fortalezas, una tabla de debilidades, elaboradas la mañana del 2026-06-21) y adjunta un juicio: "desde el ángulo del usuario, qué tipo de usuario con una **necesidad real que no está cubierta hoy** nos queda mejor" — considerando deliberadamente la variable externa de que "la nueva API de DeepSeek en los últimos dos meses ha reducido drásticamente el precio/rendimiento de LLM."
>
> Lectura complementaria: [`COMPETITIVE-LANDSCAPE.md`](../COMPETITIVE-LANDSCAPE.md) (la encuesta panorámica del 2026-05-29 de 30+ proyectos entre pistas). Ese es el "mapa de pistas"; este es "cara a cara a nivel de producto + usuario objetivo." Las celdas de ambas matrices son **juicios aproximados al nivel de posicionamiento del producto** (basados en material público), no pruebas ítem por ítem; la verificación precisa de cualquier proveedor en particular puede investigarse por separado.

---

## 1. Matriz de fortalezas: producto × dimensión (Gotong en la última fila)

> ✅ lo tiene · ⚠️ parcial / solo en tier de pago / nivel primitivo · ❌ ninguno / no es su posicionamiento. Las dimensiones están **elegidas según la postura de diseño de Gotong** — por lo que su ventaja aquí es estructural, con "ventaja de campo propio" (la matriz de debilidades intercambia las dimensiones que realmente interesan a los compradores empresariales, y la brecha se invierte de inmediato).

| Producto representativo | OSS | Auto-alojado | Dueño de datos/credenciales | Gobernanza·auditoría·RBAC | Aprobación HITL | Federación entre orgs | Continuidad personal↔org | Framework no ejecuta LLM |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **Salesforce Agentforce** | ❌ | ❌ | ❌ | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| **Microsoft** Copilot Studio/Agent 365 | ❌ | ❌ | ⚠️ | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| **ServiceNow** AI Agents | ❌ | ❌ | ❌ | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| **Google** Gemini Enterprise | ❌ | ❌ | ❌ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ |
| **LangGraph** | ✅ | ✅ | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| **CrewAI** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| **MS Agent Framework** (SDK) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ |
| **n8n** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ |
| **Dify** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| **Flowise** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| **Temporal / Windmill** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ |
| **Odysseus** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Goose** (Block) | ✅ | ✅ | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| **OpenClaw / Hermes** (clase) | ✅ | ✅ | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| **🟢 Gotong** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Glosario de dimensiones**: federación entre orgs = agentes de diferentes hubs/orgs soberanas colaborando (las credenciales se quedan en casa); continuidad personal↔org = una sola pila que escala fluidamente desde el modo personal hasta el equipo y luego entre orgs; el framework no ejecuta el LLM = el framework solo enruta/contabiliza, nunca decide por los participantes (el Hub es tonto).

**Cómo leer esta tabla**:
- Las **tres columnas más a la derecha** (federación entre orgs / personal↔org / framework no ejecuta LLM) **son ✅ solo para Gotong**, con todos los demás en ❌/⚠️ — este es el verdadero espacio en blanco de Gotong.
- Plataformas comerciales (4 primeras filas): máxima puntuación en gobernanza/HITL, pero **OSS·auto-alojado·dueño-de-datos son todos ❌** (SaaS, el proveedor tiene el modelo de confianza; algunos ofrecen VPC pero sigue siendo tenancy en el fondo).
- Frameworks OSS / plataformas auto-alojadas (7 filas del medio): máxima puntuación en OSS·auto-alojado, pero **gobernanza solo ⚠️, entre orgs todos ❌** (dentro de una sola org).
- Agentes personales (OpenClaw/Hermes/Goose/Odysseus): máxima puntuación en auto-alojado, pero **gobernanza·entre orgs·ruta de continuidad todos ❌** (una sola persona, una sola máquina).
- **Gotong es la única fila completamente verde** — pero precisamente porque las dimensiones se eligieron según su postura, por lo que la tabla de debilidades a continuación debe leerse junto a ella.

---

## 2. Matriz de debilidades: comparación inversa honesta (intercambia las dimensiones que interesan a los compradores empresariales, y Gotong es el más débil)

La tabla anterior gana en "ventaja de campo propio." Intercambia las dimensiones que realmente pregunta un comprador empresarial, y la brecha se invierte de inmediato:

| Dimensión | Quién es fuerte (producto específico) | Gotong |
|---|---|---|
| Validación de clientes / escala | Salesforce Agentforce (8000+ clientes), ServiceNow | ❌ etapa temprana / uso propio |
| Integración del ecosistema (CRM/ITSM/Office/SAP) | Salesforce, ServiceNow, Microsoft | ❌ conéctalo tú mismo via MCP |
| Certificaciones de cumplimiento (SOC2/ISO/HIPAA) | todas las plataformas comerciales | ❌ sin certificaciones |
| Madurez out-of-box / no-code | n8n, Dify, Agentforce | ⚠️ necesita configuración / example-first |
| Modelo fuerte integrado + SLA + soporte comercial | todas las plataformas comerciales | ❌ (y por diseño no ejecuta el modelo; depende del MiMo/DeepSeek/Claude que conectes) |
| Madurez de orquestación visual | n8n, Flowise, Dify | ⚠️ principalmente YAML declarativo (vista DAG de solo lectura añadida) |

**Debilidad de efecto de red (listada aparte, porque es cuestión de vida o muerte para los productos de clase federación)**: el valor de la federación crece superlinealmente con el número de pares, mientras que al inicio en frío el conteo de pares = 0. Esta es la trampa mortal de todo producto "entre orgs" — el §4 a continuación explica por qué los usuarios objetivo que elegimos **traen sus propios pares y pueden sortear esta trampa**.

---

## 3. Conclusión en una línea

**Gotong no es "un mejor Agentforce" ni "un n8n más potente"; ocupa una celda de cruce que nadie más ocupa**: soberanía auto-alojada + federación entre orgs + gobernanza/HITL a nivel de org + una ruta de continuidad de personal a org + el framework no ejecuta el LLM. El precio es que es un producto en etapa temprana en "madurez / ecosistema / cumplimiento / validación de clientes" — que es exactamente donde las plataformas comerciales son más fuertes.

> Fuentes de datos: panorama de proveedores vdf.ai / guerras de plataformas Futurum / capa de protocolo Zylos / auto-alojado OSS Knowlee / HITL Strata, más mediciones del código fuente (32 paquetes / 85.7k LOC / ratio de pruebas >1:1 / 41 demos). Ver [`COMPETITIVE-LANDSCAPE.md`](../COMPETITIVE-LANDSCAPE.md).

---

## 4. Qué tipo de usuario nos queda mejor — "tiene una necesidad, pero no está cubierta hoy"

Apila las dos matrices y **las celdas servidas ya están saturadas; solo hay una celda desatendida**:

> **Pequeñas organizaciones que necesitan gobernanza / tutela / aprobación + soberanía de datos + colaboración entre límites, pero ① no pueden permitirse y no pueden usar plataformas de grado empresarial, y ② también están excluidas por el techo "una sola org, sin gobernanza" de los frameworks OSS.**

Esta celda está casi vacía hoy — no porque nadie quiera construirla, sino porque está bloqueada por **dos muros a la vez**:

- **Muro A (precio/madurez)**: las plataformas empresariales (Agentforce/ServiceNow/Microsoft/Google) tienen gobernanza e HITL, pero son SaaS de alto ACV, alto contacto y GTM y **simplemente no venden hacia abajo** a un hogar, una tienda de té de burbujas, un bufete de tres personas.
- **Muro B (arquitectura)**: los frameworks OSS (LangGraph/Dify/n8n) y los agentes personales (OpenClaw/Goose) son suficientemente baratos y auto-alojables, pero **arquitectónicamente no tienen federación entre orgs, ni gobernanza a nivel de org, ni puerta de aprobación de salida** — y ninguna cantidad de abaratamiento hace crecer esas capacidades.

Gotong está justo en la grieta entre los dos muros: tiene la "gobernanza + HITL + soberanía de datos" de las plataformas empresariales, y también el "auto-alojado + barato + credenciales en tu máquina" de los frameworks OSS, **además de ser el único propietario de esas tres columnas (federación entre orgs / continuidad personal↔org / framework no ejecuta LLM)**.

### 4.1 Las dos cabezas de playa más nítidas, donde ya hemos construido los ejemplos

| Cabeza de playa | Quién | Por qué no está cubierta hoy | Los ejemplos que hemos construido |
|---|---|---|---|
| **A. Familia / educación** | padres que abren IA para hijos, IA soberana familiar multi-miembro, tutela parental+aprobación | las plataformas empresariales no venden a familias; los agentes personales son de una persona/una máquina sin tutela/soberanía entre miembros/puerta de aprobación | `family-learning-hub` (dos hubs soberanos + puerta de aprobación de salida + bloqueo de clase de datos de datos de niños), el tutor `/teach`, fork del transcript al padre |
| **B. PYME entre orgs** | cadena de suministro (tienda↔proveedor), cadenas de franquicias (HQ↔tienda), mentoría/clubes/proyectos entre empresas | las plataformas empresariales son demasiado pesadas/costosas para los muy pequeños, y su historia entre orgs sigue vinculada al proveedor; los frameworks OSS son de una sola org | `tea-supply-link`, `tea-chain-hq`, `warband-club`, `cafe-ops` |

Ampliando un círculo más, la misma celda también incluye **federaciones de pequeños equipos regulados**: consorcios de bufetes de abogados, clínicas, RFPs entre empresas, colaboración en investigación — todos "colaboración entre orgs + los datos deben quedarse en mis manos + necesitan auditoría/aprobación," igualmente desatendidos de frente hoy.

### 4.2 DeepSeek empujó sobre el "muro de precio" — exactamente la variable que señaló el usuario

El juicio del usuario es completamente válido: **un producto que antes no tenía caso de precio/rendimiento puede tenerlo después.** El mecanismo, explicado:

1. **Esta celda estaba históricamente bloqueada por una restricción doble**: ① el LLM es demasiado caro + ② ningún producto llena "soberanía + gobernanza + entre orgs + precio de consumidor." Las familias no pueden pagarlo, las tiendas de té de burbujas tienen márgenes ajustados, y "ejecutar el LLM en cada interacción, más mantener varios agentes activos para enrutamiento/consulta/latido" **no era rentable** a los precios antiguos del modelo — así que este tipo de IA auto-alojada y con gobernanza quedó atascada en demo, sin que nadie realmente lo pusiera en producción.
2. **La nueva API de DeepSeek en los últimos dos meses elimina la restricción ①** (costo del LLM). **Gotong llena exactamente la restricción ②** (el producto faltante). Junta los dos y esta celda, por primera vez, tiene tanto "asequible" como "algo que usar."
3. **La asimetría clave — los competidores también pueden usar el DeepSeek barato, pero los LLM baratos no les ayudan a llegar a esta celda**:
   - Plataformas empresariales: un LLM barato no cambia su GTM empresarial de alto contacto; **no van** a bajar a vender a familias/pequeñas tiendas solo para ahorrar tokens.
   - Frameworks OSS: un LLM barato **no puede añadir** federación entre orgs/gobernanza/HITL — una reducción de precio no rellena lo que la arquitectura carece.
   - Agentes personales: un LLM barato **no puede añadir** tutela/entre orgs/aprobación — son de una persona/una máquina por diseño.
   - → DeepSeek es una marea creciente que levanta a todos, pero **desbloquea de manera desproporcionada la celda de Gotong**: porque esa celda estaba bloqueada por "costo ∧ producto faltante" a la vez, DeepSeek elimina el costo, y **solo Gotong suministra el producto faltante**.
4. **Y los LLM baratos benefician a Gotong más que a otros** — un punto pasado por alto: el diseño de Gotong de "el framework no ejecuta el LLM, pero los participantes sí" naturalmente hace **muchas llamadas pequeñas a LLM** (un agente de enrutamiento decidiendo a quién despachar, consulta multi-agente, despertares proactivos de latido, los agentes de crecimiento de tres pilares, tutor+pantalla-de-temas+moderación-de-contenido…). Esta forma de "muchos participantes LLM baratos" era una **carga de costo** a los precios de modelos antiguos — exactamente lo que mantenía a los usuarios no empresariales fuera; una vez que DeepSeek corta el precio unitario, el diseño más natural de Gotong se convierte en el **punto óptimo de precio/rendimiento** — y es óptimo precisamente en los usuarios a los que el precio había excluido antes.

### 4.3 Por qué esta elección también convenientemente resuelve la trampa del "inicio en frío de la federación"

El §2 decía: la mayor trampa mortal para los productos de clase federación es **conteo de pares = 0**. Las dos cabezas de playa que elegimos **traen sus propios pares**:

- "padre + hijo" son **2 hubs soberanos** desde el primer movimiento;
- "tienda + proveedor," "HQ + franquicia," "maestro + aprendiz" son **≥2 partes** desde el primer movimiento.

En otras palabras, el **escenario de uso de este tipo de usuario es en sí mismo una federación emparejada/agrupada** — el segundo par no es algo que tengas que ir a buscar con desarrollo de negocios, lo trae el caso de uso. Esto es fundamentalmente diferente de "una empresa compra un único despliegue": un despliegue único de empresa no puede arrancar en frío una red de federación, mientras que un par de familias o una cadena de suministro **trae naturalmente el segundo nodo**. Entonces elegir esta celda es tanto "la necesidad más desatendida" como una forma de convertir el problema de arranque en frío del efecto de red de la federación de "trampa mortal" a "traído por el caso de uso."

### 4.4 Límites honestos (esto no es "ganar en piloto automático")

- **El precio del Muro A está superado, pero la "madurez" del Muro A no**: las familias/pequeñas tiendas quieren **verdaderamente out-of-box** (inicio en una línea, un shell de escritorio, incorporación a prueba de idiotas); Gotong sigue siendo example-first + necesita configuración. El precio/rendimiento desbloqueó la demanda, **la usabilidad es la próxima puerta**.
- **La confianza/cumplimiento sigue siendo una puerta dura para familias y pequeños equipos regulados**: proteger los datos de un niño, un consorcio de bufetes — sin respaldo de auditoría/cumplimiento aún no se atreverán a usarlo.
- **La distribución sigue siendo un problema de negocio, no de código**: los usuarios de esta celda están dispersos y son difíciles de adquirir; necesita una entrada sin código + una galería de plantillas + clientes de referencia reales, no unas pocas funciones más.

---

## 5. Una línea para tomar decisiones

> **El objetivo más nítido es la pequeña organización que "necesita gobernanza/tutela/entre orgs, pero las plataformas empresariales no pueden llegar y los frameworks OSS no pueden crecer hasta ahí" — familia/educación primero, colaboración entre orgs para PYME segundo.** Históricamente estaban bloqueados tanto por "el LLM es demasiado caro" como por "no existe tal producto"; la reducción de precios de DeepSeek en los últimos dos meses eliminó lo primero, Gotong es exactamente la respuesta a lo segundo, y el caso de uso de este tipo de usuario **trae su propio par de federación**, resolviendo convenientemente el arranque en frío. Los competidores también pueden usar DeepSeek barato, pero una reducción de precio no puede rellenar la gobernanza entre orgs que carece su arquitectura — **la ventana de precio/rendimiento de esta celda está estructuralmente abierta para Gotong.** Las luchas duras restantes están en usabilidad, respaldo de confianza y distribución — no en tecnología.
