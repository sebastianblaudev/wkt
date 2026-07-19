# Deploy a producción (servidor real)

Stack recomendado: **InstaPods (container always-on)** + **Supabase (Postgres)**.
(El `render.yaml` se mantiene como referencia pero el despliegue objetivo es
InstaPods vía el `Dockerfile` de este repo. Cualquier host de containers
compatible funciona igual: HostStack, Railway, Fly.io, etc.)

## 1. Rotar la clave de Supabase expuesta (CRÍTICO)
La `SUPABASE_SERVICE_KEY` (rol `service_role`) quedó en el histórico del repo.
1. En el dashboard de Supabase: **Project Settings → API → service_role key → regenerate**.
2. La vieja clave deja de funcionar de inmediato.
3. Nunca la vuelvas a commitear; vive solo en las env vars de InstaPods.

## 2. Aplicar el esquema de base de datos
```bash
cp .env.example .env
# Rellena SUPABASE_URL y la NUEVA SUPABASE_SERVICE_KEY en .env
npm run db:apply
```
Si el script falla (tu proyecto no expone `rpc/exec` o `/sql`), pega el
contenido de `schema.sql` manualmente en el **SQL Editor** de Supabase.

El schema crea:
- `operations` (id PK, admin_password hasheado con bcrypt)
- `channels` (op_id FK, name, UNIQUE(op_id, name))
- `operation_tokens` (token PK, op_id FK, expires_at +24h, used_at)
- `units` (id PK, op_id FK, callsign, socket_id, status, last_seen, lat, lng)

## 3. Configurar el servicio en InstaPods
1. Crea la app conectando tu repo de GitHub (`sebastianblaudev/wkt`), rama `main`.
2. El `Dockerfile` de este repo define build/start/healthcheck. Elige el plan
   **Micro (512MB, ~€5/mo)** o superior — es always-on (nunca se duerme).
3. En **Environment → Variables**, pon:
    - `SUPABASE_URL` — tu URL de Supabase.
    - `SUPABASE_SERVICE_KEY` — la clave NUEVA regenerada.
    - `SUPER_ADMIN_KEY` — string largo y aleatorio
      (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).
    - `SIGNAL_SECRET` — otro string aleatorio para derivar claves de señal HMAC.
    - `ALLOWED_ORIGINS` — orígenes del frontend separados por coma, p.ej.
      `https://tu-dominio.com,https://tu-app.instapods.app`.
    - `PORT` — InstaPods lo asigna; el server lo lee automáticamente.
    - `AI_PROVIDER_URL` / `AI_API_KEY` (opcional, para LLM real).
    - `VITE_TURN_URLS` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL`
      (build-time) si usas TURN.


## 4. TURN server (audio tras NAT celular)
Sin TURN, el audio P2P falla en muchas redes móviles. La forma recomendada y
segura es **coturn con `static-auth-secret`**, donde el Node server genera
credenciales efímeras (username = timestamp de expiración, HMAC con el secret)
y las entrega al cliente dentro de `operation-config`. El secreto NUNCA va al
navegador.

1. Genera un secret: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
2. Levanta coturn: `TURN_SECRET=<secret> TURN_EXTERNAL_IP=<ip-publica> docker compose up -d`
   (`docker-compose.yml` ya lo define).
 3. En InstaPods (o donde corra el server) define:
    - `TURN_SECRET` = el mismo secret.
    - `TURN_URLS` = `turn:<host>:3478?transport=udp,turn:<host>:3478?transport=tcp`.
    - `TURN_EXTERNAL_IP` = IP pública del host TURN.
4. El cliente recibe `turn` en `operation-config` y lo aplica al `rtcConfig`
   automáticamente. También soporta override build-time con `VITE_TURN_*`.

Nota: si no puedes hospedar coturn, usa un proveedor (Twilio/Twire) y pon sus
URLs+credenciales en `VITE_TURN_*` (menos ideal: la credencial va en el bundle).


## 5. Verificar
- `https://<tu-app>.instapods.app/health` → `{"status":"OK",...}`.
- Login super-admin con `SUPER_ADMIN_KEY`, crear tenant, unir operador con token.
- `npm test` local debe pasar los tests de ai.cjs.

## 6. Operational AI (centro de mando)
El producto incluye un cerebro de IA operacional que funciona SIN API keys
(motor determinista de reglas + plantillas en `ai.cjs`). Esto es lo que hace:

- **Resumen de turno**: al unirse y cada 15s, el admin recibe `ai-insight`
  con un resumen del turno (eventos, GPS, SOS, despachos).
- **Supervisor en tiempo real**: propone acciones según caos, SOS activos e
  incidentes abiertos (`PRIORITIZE_SOS`, `SPLIT_COMMS`, `MONITOR`, ...).
- **Despacho inteligente**: ante un SOS recomienda la unidad ACTIVE más cercana
  al objetivo y (en modo AUTO) la fuerza al canal del incidente.
- **Memoria operacional**: al final de cada ciclo guarda `operational_memory`
  (turnos previos, zonas SOS, unidades débiles) y genera predicciones.
- **Timeline / Replay**: endpoint `GET /timeline/:opId` y evento socket
  `request-timeline` devuelven el `event_log` del turno para reproducirlo.

### Modos de autonomía
En el panel "AI COMMAND CENTER" del admin (`admin.html`):
- `SUGGEST_ONLY` (default): solo sugiere.
- `SUGGEST_APPROVE`: sugiere; el admin aprueba con "APROBAR" para ejecutar.
- `AUTO_EXECUTE`: la IA ejecuta despachos automáticamente.

Se persisten en `operations.autonomy_mode`. Para usar un LLM real, define
`AI_PROVIDER_URL` + `AI_API_KEY` y reemplaza los cuerpos de `ai.cjs`.


## Notas de estabilidad
- El `Dockerfile` incluye HEALTHCHECK en `/health`; InstaPods reinicia solo si
  el proceso cae. Mantén `numInstances: 1` (sube a 2+ cuando necesites
  redundancia; comparten la misma DB Supabase).
- El estado en memoria (Chaos Index, fusionMap, autonomyMode, opUnitState) es
  por instancia; con varias
  instancias habría que moverlo a Redis. Para arrancar, 1 instancia es suficiente.
