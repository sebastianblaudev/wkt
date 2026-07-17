# Deploy a producción (servidor real)

Stack recomendado: **Render (web service)** + **Supabase (Postgres)**.

## 1. Rotar la clave de Supabase expuesta (CRÍTICO)
La `SUPABASE_SERVICE_KEY` (rol `service_role`) quedó en el histórico del repo.
1. En el dashboard de Supabase: **Project Settings → API → service_role key → regenerate**.
2. La vieja clave deja de funcionar de inmediato.
3. Nunca la vuelvas a commitear; vive solo en las env vars de Render.

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

## 3. Configurar el servicio en Render
1. Nuevo **Web Service** apuntando a este repo (rama `main`).
2. `render.yaml` ya define build/start/healthcheck. Usa plan **starter+**
   (el free tier se duerme y el audio PTT sufre).
3. En **Environment → Add Environment Variable**, pon (todas `sync: false`):
   - `SUPABASE_URL` — tu URL de Supabase.
   - `SUPABASE_SERVICE_KEY` — la clave NUEVA regenerada.
   - `SUPER_ADMIN_KEY` — string largo y aleatorio
     (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).
   - `SIGNAL_SECRET` — otro string aleatorio para derivar claves de señal HMAC.
   - `ALLOWED_ORIGINS` — orígenes del frontend separados por coma, p.ej.
     `https://tu-dominio.com,https://tu-app.onrender.com`.
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
3. En Render (o donde corra el server) define:
   - `TURN_SECRET` = el mismo secret.
   - `TURN_URLS` = `turn:<host>:3478?transport=udp,turn:<host>:3478?transport=tcp`.
   - `TURN_EXTERNAL_IP` = IP pública del host TURN.
4. El cliente recibe `turn` en `operation-config` y lo aplica al `rtcConfig`
   automáticamente. También soporta override build-time con `VITE_TURN_*`.

Nota: si no puedes hospedar coturn, usa un proveedor (Twilio/Twire) y pon sus
URLs+credenciales en `VITE_TURN_*` (menos ideal: la credencial va en el bundle).


## 5. Verificar
- `https://<tu-app>.onrender.com/health` → `{"status":"OK",...}`.
- Login super-admin con `SUPER_ADMIN_KEY`, crear tenant, unir operador con token.
- `npm test` local debe pasar 13/13.

## Notas de estabilidad
- `restartPolicy: on-failure`, `healthCheckPath: /health`, `numInstances: 1`
  (sube a 2+ cuando necesites redundancia; comparten la misma DB Supabase).
- El estado en memoria (Chaos Index, fusionMap) es por instancia; con varias
  instancias habría que moverlo a Redis. Para arrancar, 1 instancia es suficiente.
