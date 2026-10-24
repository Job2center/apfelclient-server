-- ApfelClient schema for Supabase (Postgres). Paste into SQL Editor and run.
create table if not exists users (
  username text primary key,
  is_admin boolean not null default false,
  salt text not null,
  pass_hash text not null,
  created_at bigint not null,
  last_login bigint not null default 0,
  hwid text,
  license_type text,
  license_granted_at bigint,
  license_expires_at bigint,
  open_request_type text,
  open_request_at bigint,
  reset_month text,
  resets_used integer not null default 0,
  must_change_pw boolean not null default false,
  must_change_username boolean not null default false,
  discord_id text,
  changelog_seen text not null default ''
);

create table if not exists tokens (
  token_hash text primary key,
  username text not null references users(username) on delete cascade,
  created_at bigint not null
);

create table if not exists notifications (
  id bigint generated always as identity primary key,
  username text not null references users(username) on delete cascade,
  text text not null,
  at bigint not null,
  read boolean not null default false
);

create table if not exists requests (
  id bigint generated always as identity primary key,
  username text not null references users(username) on delete cascade,
  type text not null,
  at bigint not null,
  status text not null default 'open'
);

-- Giveaway: genau eine Zeile (id = '1'). Ohne diese Tabelle ging der
-- Giveaway-Zustand bei jedem Server-Neustart verloren.
create table if not exists giveaway (
  id text primary key,
  payload jsonb,
  updated_at bigint not null default 0,
  restarts integer not null default 0
);

-- Anonyme Telemetrie (Mod-Starts + Crashes). Kein Name, kein HWID.
create table if not exists telemetry (
  id bigint generated always as identity primary key,
  at bigint not null,
  kind text not null,
  mod text,
  launcher text,
  mc text,
  os text,
  java text,
  error text,
  detail text
);

-- Admin-editable changelog overlay (keeps release-file entries as defaults).
create table if not exists app_config (
  key text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at bigint not null default 0
);

create index if not exists idx_notifications_user on notifications(username);
create index if not exists idx_requests_status on requests(status);
create index if not exists idx_telemetry_at on telemetry(at desc);

-- Altbestand nachziehen, falls users schon existiert:
alter table users add column if not exists changelog_seen text not null default '';
alter table users add column if not exists must_change_username boolean not null default false;

-- Zugriffsschutz: nur der Render-Server (service_role) darf die Tabellen
-- benutzen. Die anon-/authenticated-Rollen bekommen bewusst KEINE Rechte,
-- weil der Client ausschliesslich ueber unsere API spricht.
-- Policies sind bewusst keine vorhanden: service_role umgeht RLS.
alter table users enable row level security;
alter table tokens enable row level security;
alter table notifications enable row level security;
alter table requests enable row level security;
alter table giveaway enable row level security;
alter table telemetry enable row level security;
alter table app_config enable row level security;
