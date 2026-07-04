# Política de seguridad

<!-- doc-version: 1.0 -->
> **Versión del documento 1.0** · Traducción al español · Actualizado el 2026-06-27 · Fuente autorizada: [English](../../SECURITY.md). Si la traducción entra en conflicto con la versión en inglés, prevalece la versión en inglés.

## Cómo reportar una vulnerabilidad

**Por favor, no abras un issue público de GitHub, una discusión o un PR para problemas de seguridad.** Usa un canal privado:

### Preferido — reporte privado de vulnerabilidades de GitHub

Abre un aviso privado en:

> **<https://github.com/Emir-Aksoy/Gotong/security/advisories/new>**

El formulario integrado de GitHub te ofrece:

- hilo privado de extremo a extremo con los mantenedores (sin filtración de correo electrónico)
- adjuntos + pasos de reproducción en un solo lugar
- una cronología rastreada desde el reporte → corrección → asignación de CVE público

Este es el canal que leemos primero y respondemos más rápido. Necesitarás una cuenta gratuita de GitHub; ese es el único requisito previo.

### Sin canal de correo electrónico (pre-1.0)

Deliberadamente **no hay correo electrónico de seguridad** durante el período v0.x. `security@gotong.dev` aparece en revisiones antiguas de este repositorio como una dirección *aspiracional* — el dominio no está registrado y el buzón no está activado, por lo que el correo enviado a él no llega a ningún lugar. Hemos dejado de anunciarlo como alternativa en lugar de dejar un contacto muerto en el que alguien podría confiar con un reporte real.

El Reporte Privado de Vulnerabilidades de GitHub (anterior) es el **único** canal hoy: gratuito, privado y el que leemos primero. Si vale la pena configurar un buzón real es una decisión de [lista de verificación de lanzamiento](../../.github/RELEASE-CHECKLIST.md#security-contact) diferida hasta el inicio de la versión 1.0; mientras tanto, por favor usa el formulario de aviso.

Si genuinamente no puedes usar GitHub, abre una **discusión de GitHub no relacionada con seguridad** pidiendo a un mantenedor que se comunique — sin ningún detalle de vulnerabilidad — y organizaremos un canal privado para ese reporte único.

Incluye en tu aviso:

- una descripción del problema
- pasos de reproducción precisos
- el hash del commit que probaste (`git rev-parse HEAD`)
- (opcional) una corrección propuesta o parche
- (opcional) el nombre / alias con el que quieres ser acreditado en el aviso

### ¿Qué pasa con PGP?

**No** publicamos una clave PGP hoy. Razones:

- El canal de aviso privado de GitHub ya está cifrado TLS de extremo a extremo entre tú y la notificación del mantenedor, por lo que PGP añade poco.
- Mantener una clave PGP para un proyecto en fase temprana es más modos de fallo (claves perdidas, claves vencidas, ceremonias de firma) que beneficio.

Si la política de tu organización requiere divulgación cifrada con PGP, por favor contáctanos primero a través del canal de GitHub y organizaremos un intercambio de PGP fuera de banda para ese reporte único.

---

## Cronología de respuesta

| Fase | Objetivo |
|---|---|
| Acuse de recibo | dentro de **72 horas** del reporte |
| Primera clasificación + evaluación de severidad | dentro de **7 días** |
| Corrección o mitigación en `main` | alta severidad: **7 días**, media: **30 días**, baja: mejor esfuerzo |
| Divulgación pública | **7–14 días** después de que la corrección llegue (o por acuerdo mutuo) |

Recibirás una actualización en cada transición. Si no tienes noticias nuestras dentro de la ventana de acuse de recibo de 72 horas, eso en sí es un error — por favor escala a través de una Discusión de GitHub (general, no con contenido de seguridad), etiquetando a un mantenedor.

---

## Versiones soportadas

Gotong es pre-1.0 internamente (las etiquetas v2.0 / v2.1 que ves en `CHANGELOG.md` se refieren a la generación de reescritura file-first, no al umbral SemVer 1.0). Parcheamos problemas de seguridad solo en la rama `main` actual. **No hay rama LTS**.

Si necesitas estabilidad a largo plazo, fija un commit que hayas auditado y presupuesta para parches en el lugar; no podemos hacer backports indefinidamente.

---

## Modelo de amenaza

Gotong está diseñado para despliegues **pequeños, de confianza y de un solo inquilino** — un laboratorio de investigación, un equipo de proyecto, un pequeño grupo de vista previa pública. Los valores predeterminados asumen que la sala está operada por personas que confían entre sí.

En alcance (aceptamos reportes sobre):

- ✅ Acceso no autenticado a endpoints de administración
- ✅ Divulgación de tokens / cookies (entre usuarios, entre salas, entre procesos)
- ✅ Errores de cifrado / descifrado en `secrets.enc.json` y el archivo de clave maestra
- ✅ Bypass de autorización — p.ej. un trabajador alcanzando rutas solo de administración
- ✅ CSRF / clickjacking / XSS en la UI de administración incluida
- ✅ Agotamiento de recursos que requiere *ninguna* autenticación (DOS anónimo)
- ✅ Errores de análisis de protocolo wire que bloquean el host o corrompen el transcript
- ✅ Escalada de privilegios en el `TeamBridgeAgent` (p.ej. equipo local ganando visibilidad no deseada en el upstream)
- ✅ Problemas de confused-deputy en la ruta de generación de LocalAgentPool / agente gestionado

Fuera de alcance (baja prioridad — los parches son bienvenidos, pero no se manejan como seguridad):

- ❌ **Administradores no confiables.** Una vez que una cuenta tiene el rol de administrador, puede hacer cualquier cosa que exponga el rol de administrador. Si necesitas cortafuegos de administración interna, abre una solicitud de función.
- ❌ **DDoS a nivel de aplicación** por un usuario *autenticado*. La limitación de velocidad es por IP y se reinicia al reiniciar; no es una defensa contra el abuso interno deliberado.
- ❌ **Payloads de tareas enormes** que causan presión de memoria. Sin cuotas todavía.
- ❌ **Ataques de temporización de canal lateral** fuera de la comparación de tokens (la comparación de tokens en sí es de tiempo constante).
- ❌ Problemas que requieren acceso físico / de shell a la máquina host.
- ❌ Hallazgos contra las fuentes upstream de `templates/community/` — esos son repositorios de prompts de terceros bajo sus propias licencias y gobernanza; repórtalos directamente a ellos.

Si tu hallazgo está en el límite, envíalo a través del canal de aviso de GitHub y lo clasificaremos.

---

## Mitigaciones existentes (para que sepas qué defensas ya existen)

Al evaluar un problema, comprueba si alguna de estas ya lo cubre:

- **Almacenamiento de tokens**: los tokens de admin / trabajador se hashean con SHA-256 antes de escribirse en disco. El texto plano se muestra exactamente una vez en la creación. La verificación usa comparación de tiempo constante.
- **Almacenamiento de cookies**: HttpOnly siempre; `SameSite=Strict` + `Secure` cuando `GOTONG_COOKIE_SECURE=1` (requerido detrás de HTTPS).
- **CSRF**: `GOTONG_ALLOWED_HOSTS` aplica las verificaciones `Host:` y `Origin:` en cada método que cambia estado. **Configúralo en cada despliegue de producción.** Sin configurar significa "solo el loopback es seguro".
- **Limitación de velocidad**: `GOTONG_ADMIN_RATE_MAX` / `_SEC` limita los intentos de verificación de token de administración por IP por ventana deslizante. Predeterminados 10 / 60s.
- **Cabeceras de seguridad**: `X-Frame-Options: DENY`, un CSP estricto, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` en cada respuesta.
- **Barrera de admisión**: `GOTONG_GATING=admin-approval` (predeterminado) requiere que cada agente remoto sea aprobado por un humano antes de unirse. `gating=open` es **solo para desarrollo** y se rechaza en producción con una advertencia de inicio.
- **Cifrado de clave API**: las claves API del espacio de trabajo y por agente viven en `<space>/secrets.enc.json`, AES-256-GCM, clave maestra en `<space>/runtime/secret.key` (0600) o env `GOTONG_SECRET_KEY`. El archivo cifrado solo no es suficiente para recuperar las claves.
- **Vinculación de identidad por agente (v0.4)**: `authenticate()` puede devolver `{ ok: true, allowedAgents: [...] }` para que una clave API filtrada no pueda suplantar un id de agente arbitrario — solo a los que está vinculada.
- **El transcript es de solo adición**: no hay API para eliminar o reescribir entradas del transcript desde el runtime. La manipulación requiere acceso al sistema de archivos (que está fuera de alcance; ver "fuera de alcance" anterior).

---

## Divulgación coordinada

Seguimos la divulgación coordinada estándar:

1. Envías los detalles de forma privada (canal de aviso de GitHub preferido).
2. Los mantenedores confirman, delimitan el alcance, desarrollan y prueban una corrección.
3. La corrección llega a `main` (y a una rama de backport si se ha hecho algún compromiso LTS).
4. Divulgación pública 7–14 días después, con:
   - un id CVE (lo solicitaremos si es apropiado)
   - crédito a ti en el aviso, a menos que pidas permanecer anónimo
   - un resumen del impacto + mitigación en `CHANGELOG.md`

Si divulgas públicamente antes de que hayamos enviado una corrección, aun así enviaremos la corrección, pero el campo de crédito del aviso indicará "no coordinado".

---

## Lista de verificación de seguridad para operadores

Si estás **ejecutando** un hub, no reportando errores en él, la lista de verificación de endurecimiento del lado del despliegue vive en [`docs/DEPLOY.md` § "Lista de verificación de producción"](../../docs/DEPLOY.md#production-checklist).

En resumen:

- [ ] `GOTONG_COOKIE_SECURE=1` cuando se usa detrás de HTTPS
- [ ] `GOTONG_ALLOWED_HOSTS` configurado con tus nombres de host reales
- [ ] `GOTONG_GATING=admin-approval` (nunca `open` en internet público)
- [ ] Caddy / nginx termina TLS; backend enlazado a `127.0.0.1`
- [ ] `runtime/secret.key` (chmod 600) o env `GOTONG_SECRET_KEY` está configurado
- [ ] Existen copias de seguridad para el directorio `<space>/`
- [ ] Al menos 2 cuentas de administrador para que puedas recuperarte de un bloqueo
- [ ] `/healthz` monitorizado

---

Gracias por mantener el proyecto honesto. La mayoría de los reporteros nunca ven lo que hay al otro lado de un aviso privado — pero cada uno que recibimos hace el próximo despliegue un poco más seguro.
