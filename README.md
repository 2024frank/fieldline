# Fieldline

A multi-tenant platform for running private LoRaWAN sensor networks, built for schools and campuses. One operator hosts the server; each organization gets its own walled-off workspace where they connect gateways, add sensors with written step-by-step guides, watch live readings, and route data anywhere.

Built on and battle-tested against a real deployment: a campus network at Oberlin College (Milesight gateway on a roof, air-quality and energy sensors, data flowing to a community dashboard).

## What it does

- **Admin-provisioned onboarding.** The operator creates an organization from a console; the org admin gets a professional welcome email with a temporary password. First sign-in forces a password change and captures the organization name.
- **Multi-tenant isolation.** Each organization maps to a ChirpStack tenant. Sensors, gateways, readings, users, API tokens, and webhooks are scoped per org, enforced in the backend on every route.
- **Sensor setup that actually helps.** Pick from a catalog of device types (Milesight AM/EM/WS/CT series with official decoders preloaded). The wizard generates the network key server-side and prints model-specific instructions: NFC ToolBox vs USB-C, power minimums for current transformers, activation gotchas, sub-band settings.
- **Gateway setup card.** Registering a gateway returns the exact settings to type into it, including the traps (disable the embedded network server, click Save *and* Apply).
- **Data out, three ways.** REST API with hashed org-scoped tokens, webhook integrations with real delivery tracking and HMAC signing, and CSV export.
- **Computed alerts.** Sensor silent, gateway offline, low battery — derived from live state, no cron or storage needed.

## Architecture

```
schools' browsers          operator's browser
        │                          │
   app/ (Next.js)            admin/ (Next.js)          ← Vercel or any Node host
        └────────────┬─────────────┘
                     ▼
             backend/ (Node + Hono)                    ← the only thing with secrets
        auth · orgs · provisioning · tokens
        alerts · webhooks · email (Resend)
              │                    │
              ▼                    ▼
      ChirpStack v4         services/datastore
      (LoRaWAN network      (MQTT → SQLite → REST,
       server, multi-        readings history + CSV)
       tenant)                     ▲
              ▲                    │ MQTT
              └────── mosquitto ───┘
                         ▲
                   LoRaWAN gateway(s) → sensors
```

- `backend/` — TypeScript, Hono. Talks to ChirpStack over gRPC-web + REST. Owns app users (scrypt hashes, JSON store on a volume), org lifecycle, device/gateway provisioning, tokens, webhook delivery worker, transactional email.
- `app/` — the school-facing console (Next.js App Router, React Query, Tailwind).
- `admin/` — the operator console: onboard organizations, add users to any org, manage who can operate the platform.
- `services/datastore` — small Flask service subscribing to ChirpStack MQTT uplinks, storing decoded readings in SQLite, serving latest/history/CSV.
- `services/datahub-pusher` — optional: pushes each new reading as CSV to an external endpoint with per-device tokens (built for Community Hub's Data Hub).
- `deploy/` — docker-compose for the whole server stack behind Caddy (automatic HTTPS; works on a bare IP via sslip.io).

## Quick start

Server (needs Docker):

```bash
cd deploy
# edit docker-compose.yml: replace every change-me, set your domain in Caddyfile
# add ChirpStack config under configuration/ (see chirpstack-docker upstream)
docker compose up -d
```

Frontends:

```bash
cd app    && cp .env.example .env && npm install && npm run dev
cd admin  && cp .env.example .env && npm install && npm run dev
```

First login: `admin` / your ChirpStack admin password (the backend verifies credentials against ChirpStack for bootstrap). Then use the operator console to onboard your first organization.

## Hard-won gotchas encoded in this code

These cost real hours on a real roof; the platform now handles or documents all of them:

- ChirpStack has no REST login; the JWT comes from gRPC-web, and its length is a protobuf varint.
- For LoRaWAN 1.0.x devices the AppKey goes in ChirpStack's `nwkKey` field.
- ChirpStack's "disable device" flag is inverted (`isDisabled`), and Milesight gateway "Connected" can mean connected to itself (embedded NS).
- Milesight sensor keys are write-only: you can never read a key back, only overwrite both sides.
- The EUI printed on a sensor's sticker can differ from what the configuration tool reports. The tool wins.
- CT-series current meters have no NFC and need 1.4 A through the clamp (or USB-C) to even power up.

More field notes: [chirpstack-deploy](https://github.com/2024frank/chirpstack-deploy).

## Bring your own hardware

Any LoRaWAN device can join — define a custom device type with your own payload decoder in the UI. See [docs/CUSTOM-DEVICES.md](docs/CUSTOM-DEVICES.md) for what DIY devices need (DevEUI/JoinEUI/AppKey, US915 sub-band 2), a radio-module cheat sheet (Wio-E5, Digi XBee LR, RFM95+LMIC), and a complete EnviroDIY Mayfly dissolved-oxygen example with payload spec and decoder.

## License

MIT
