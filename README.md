# Gestor VPS

Panel web para ver y manejar la VPS: CPU, RAM, disco, red y swap (con gráfico de la última hora) y todos los contenedores Docker, con su CPU, RAM, estado y salud. Desde el panel se pueden ver los logs de cada contenedor e iniciarlo, reiniciarlo o detenerlo.

URL: `https://gestor.strategiccode.cl` (también responde en `usage.strategiccode.cl` si ese nombre tiene registro DNS).

## Cómo funciona

- Node 22, **sin dependencias de npm**: solo la librería estándar.
- Lee las métricas del host desde `/proc` (montado en solo lectura en `/host/proc`).
- Habla con Docker por `/var/run/docker.sock`.
- Solo mide la CPU y la RAM de cada contenedor mientras alguien tiene el panel abierto. Las métricas del host se toman siempre, cada 5 s, y se guarda la última hora en memoria.

```text
src/
  server.js   rutas HTTP y API
  auth.js     contraseña, cookie de sesión y bloqueo por intentos
  host.js     CPU, RAM, disco y red del host
  usage.js    CPU y RAM por contenedor
  docker.js   cliente mínimo de la API de Docker
public/       página del panel y login (HTML, CSS y JS sin compilar)
```

## Configuración (`.env`)

| Variable | Qué hace |
|---|---|
| `ADMIN_PASSWORD` | Contraseña del panel. Obligatoria. |
| `SESSION_SECRET` | Firma la cookie. Si la cambias, se cierran todas las sesiones. |
| `SESSION_HOURS` | Cuánto dura la sesión (12 por defecto). |
| `PROTECTED_CONTAINERS` | Contenedores que no se pueden **detener** desde la web (sí reiniciar). |

## Levantar o actualizar

Desde `/root/reverse-proxy`:

```bash
docker compose up -d --build --no-deps gestor
```

Si cambias el `.env`, basta con `docker compose up -d --no-deps gestor`.

Logs de accesos y acciones (logins y reinicios, con IP): `docker logs web_gestor`.

## Seguridad

Quien entra al panel controla Docker, y eso equivale a ser root en la VPS. Por eso:

- La cookie de sesión es `HttpOnly`, `Secure` y `SameSite=Strict`, y los POST se rechazan si no vienen de la propia página.
- Tras 5 contraseñas incorrectas, esa IP queda bloqueada 15 min. nginx además limita el login a 10 intentos por minuto.
- El contenedor corre sin root y sin capabilities, con sistema de archivos de solo lectura. Solo tiene acceso al grupo `docker` (GID 112 en esta VPS).
- `proxy_principal` y `web_gestor` no se pueden detener desde la web: detenerlos cortaría el acceso al panel.

Para restringirlo aún más, se puede limitar a ciertas IPs en `Empresa/conf.d/gestor.strategiccode.cl.conf` con `allow <ip>; deny all;`.
