## Deployment Guide (Render + Vercel + Supabase)

This repo contains:
- **Bridge service** (Baileys): `Example/n8n-bridge.ts` (deploy to **Render**)
- **Admin panel** (Next.js): `admin-panel/` (deploy to **Vercel**)
- **Supabase schema**: `supabase.sql` (run once in Supabase SQL editor)

UI language and all app text are English by design.

---

## 1) Supabase (run once)

1) Create a Supabase project.
2) Open **SQL Editor** and run the full script from `supabase.sql`.
3) In **Authentication**:
   - Enable Email/Password
   - Create at least one admin user (email/password) for the admin panel.

Tables created:
- `app_settings` (singleton row `id=1`)
- `entities` (contacts + groups with `name` and `jid`)
- `entity_automation` (per-entity rule override)
- `message_logs` (inbound/outbound logs)
- `entity_rules` view (flattened rules)

RLS:
- Admin panel (authenticated users) can manage settings & entities and read logs.
- Bridge uses **service role** key and bypasses RLS.

---

## 2) n8n webhook contract

Bridge sends (POST JSON):
- `requestId` (uuid)
- `receivedAt` (ISO)
- `chatJid`
- `senderJid` (for groups, participant JID)
- `isGroup`
- `messageId`
- `messageTimestamp`
- `text`

n8n should respond with JSON:
- `replyText` (string)
- Optional: `sendTo` = `sameChat` | `directToSender`
- Optional: `skipReply` = `true` to not send WhatsApp reply

Optional header from bridge:
- `x-bridge-secret: <N8N_SHARED_SECRET>` (if you set it in env)

---

## 3) Bridge service (Render)

### Files / entrypoint
- Script: `Example/n8n-bridge.ts`
- Start command: `yarn bridge`

### Port binding (important for Render Web Service)

The bridge runs a minimal HTTP server to satisfy Render's port binding checks.
- Health endpoint: `/health`
- Uses `PORT` (provided by Render) and `HOST` (defaults to `0.0.0.0`)

### Required environment variables (Render)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `N8N_WEBHOOK_URL`

Recommended:
- `N8N_TIMEOUT_MS` (default `15000`)
- `N8N_SHARED_SECRET` (optional)
- `LOG_LEVEL` (e.g. `info`)

WhatsApp auth storage (FREE plan compatible):
- WhatsApp session is persisted in **Supabase** (`wa_auth_creds`, `wa_auth_keys`).
- Optional: `WA_INSTANCE_ID` (default `default`) to support multiple WhatsApp accounts in one Supabase project.

Pairing (only for first-time login / re-login):
- `PAIRING_PHONE_NUMBER` (E.164 digits only, no spaces; example: `15551234567`)
  - After you see the pairing code in logs and pair successfully, you can remove this env.

### Render setup steps (no disk required)

1) Create a new **Web Service** on Render (from GitHub).
2) Set env vars (required):
   - plus all required vars above
3) Build command:
   - `yarn install`
4) Start command:
   - `yarn bridge`
5) Deploy, then open Render logs:
   - If not registered, it will print a **pairing code** (when `PAIRING_PHONE_NUMBER` is set).
6) Pair your WhatsApp (one time), confirm Supabase tables `wa_auth_creds`/`wa_auth_keys` are populated.

---

## 4) Admin panel (Vercel)

### Project
Admin panel lives in:
- `admin-panel/`

You should deploy **that folder** as a separate Vercel project (Root Directory = `admin-panel`).

### Required environment variables (Vercel)

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

### Vercel setup steps

1) Import GitHub repo into Vercel.
2) Set **Root Directory**: `admin-panel`
3) Add env vars above.
4) Deploy.
5) Open the admin panel URL and login with the Supabase Auth user you created.

---

## 5) Operational workflow (what you do day-to-day)

1) In Admin panel:
   - Add contacts/groups in **Entities**
   - Set their rules:
     - `enabled` / `disabled` / `mentionOnly` / `default`
2) In **Settings**:
   - `contacts_mode`:
     - `allowlist`: only contacts with rule `enabled` will trigger automation
     - `denylist`: all contacts trigger automation except those with rule `disabled`
   - `groups_default_rule`:
     - `disabled` / `enabled` / `mentionOnly`
3) Watch **Logs** to verify:
   - inbound messages, outbound replies, and n8n status/errors

