-- Supabase one-time SQL setup for:
-- - Entities (contacts & groups with names)
-- - Automation rules
-- - App settings
-- - Message logs
-- - RLS policies for Admin Panel (authenticated users)
-- Notes:
-- - Bridge uses SUPABASE_SERVICE_ROLE_KEY and bypasses RLS.
-- - Admin panel should use anon key + Supabase Auth (RLS applies).

create extension if not exists pgcrypto;

-- Enums
do $$ begin
  create type entity_type as enum ('contact', 'group');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type contacts_mode as enum ('allowlist', 'denylist');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type group_default_rule as enum ('disabled', 'enabled', 'mentionOnly');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type automation_rule as enum ('default', 'enabled', 'disabled', 'mentionOnly');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type message_direction as enum ('inbound', 'outbound');
exception when duplicate_object then null;
end $$;

-- Utility: updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Core settings (single row, id=1)
create table if not exists public.app_settings (
  id int primary key check (id = 1),
  ignore_from_me boolean not null default true,
  contacts_mode public.contacts_mode not null default 'denylist',
  groups_default_rule public.group_default_rule not null default 'disabled',
  reply_send_to text not null default 'sameChat' check (reply_send_to in ('sameChat', 'directToSender')),
  reply_prefix text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id)
values (1)
on conflict (id) do nothing;

drop trigger if exists trg_app_settings_updated_at on public.app_settings;
create trigger trg_app_settings_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();

-- Entities: contacts & groups (name + jid)
create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  type public.entity_type not null,
  jid text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_entities_type on public.entities(type);
create index if not exists idx_entities_name on public.entities(name);

drop trigger if exists trg_entities_updated_at on public.entities;
create trigger trg_entities_updated_at
before update on public.entities
for each row execute function public.set_updated_at();

-- Per-entity automation override (default/enabled/disabled/mentionOnly)
create table if not exists public.entity_automation (
  entity_id uuid primary key references public.entities(id) on delete cascade,
  rule public.automation_rule not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_entity_automation_rule on public.entity_automation(rule);

drop trigger if exists trg_entity_automation_updated_at on public.entity_automation;
create trigger trg_entity_automation_updated_at
before update on public.entity_automation
for each row execute function public.set_updated_at();

-- Flattened view for bridge & admin UI convenience
create or replace view public.entity_rules as
select
  e.jid,
  e.type,
  e.name,
  coalesce(a.rule, 'default'::public.automation_rule) as rule
from public.entities e
left join public.entity_automation a on a.entity_id = e.id;

-- Message logs
create table if not exists public.message_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  direction public.message_direction not null,
  chat_jid text not null,
  sender_jid text,
  message_id text,
  text text,
  automated boolean not null default false,
  n8n_request_id uuid,
  n8n_status int,
  n8n_error text
);

create index if not exists idx_message_logs_created_at on public.message_logs(created_at desc);
create index if not exists idx_message_logs_chat_jid on public.message_logs(chat_jid);
create index if not exists idx_message_logs_sender_jid on public.message_logs(sender_jid);
create index if not exists idx_message_logs_n8n_request_id on public.message_logs(n8n_request_id);

-- RLS
alter table public.app_settings enable row level security;
alter table public.entities enable row level security;
alter table public.entity_automation enable row level security;
alter table public.message_logs enable row level security;

-- Admin panel access: any authenticated user can manage settings & entities
drop policy if exists "app_settings_select_authenticated" on public.app_settings;
create policy "app_settings_select_authenticated"
on public.app_settings for select
to authenticated
using (true);

drop policy if exists "app_settings_write_authenticated" on public.app_settings;
create policy "app_settings_write_authenticated"
on public.app_settings for update
to authenticated
using (true)
with check (true);

drop policy if exists "entities_all_authenticated" on public.entities;
create policy "entities_all_authenticated"
on public.entities for all
to authenticated
using (true)
with check (true);

drop policy if exists "entity_automation_all_authenticated" on public.entity_automation;
create policy "entity_automation_all_authenticated"
on public.entity_automation for all
to authenticated
using (true)
with check (true);

-- Logs: authenticated users can read; bridge inserts via service role (bypasses RLS)
drop policy if exists "message_logs_select_authenticated" on public.message_logs;
create policy "message_logs_select_authenticated"
on public.message_logs for select
to authenticated
using (true);

-- WhatsApp auth persistence (for free hosting without persistent disk)
-- Supports multiple instances via instance_id (default instance_id = 'default')
create table if not exists public.wa_auth_creds (
  instance_id text primary key,
  creds jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_wa_auth_creds_updated_at on public.wa_auth_creds;
create trigger trg_wa_auth_creds_updated_at
before update on public.wa_auth_creds
for each row execute function public.set_updated_at();

create table if not exists public.wa_auth_keys (
  instance_id text not null,
  type text not null,
  id text not null,
  data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (instance_id, type, id)
);

create index if not exists idx_wa_auth_keys_instance_type on public.wa_auth_keys(instance_id, type);

drop trigger if exists trg_wa_auth_keys_updated_at on public.wa_auth_keys;
create trigger trg_wa_auth_keys_updated_at
before update on public.wa_auth_keys
for each row execute function public.set_updated_at();

alter table public.wa_auth_creds enable row level security;
alter table public.wa_auth_keys enable row level security;

drop policy if exists "wa_auth_creds_all_authenticated" on public.wa_auth_creds;
create policy "wa_auth_creds_all_authenticated"
on public.wa_auth_creds for all
to authenticated
using (true)
with check (true);

drop policy if exists "wa_auth_keys_all_authenticated" on public.wa_auth_keys;
create policy "wa_auth_keys_all_authenticated"
on public.wa_auth_keys for all
to authenticated
using (true)
with check (true);
