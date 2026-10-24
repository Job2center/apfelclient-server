-- Run once in the existing Supabase project before using generated first-login names or admin changelog editing.
create table if not exists app_config (
  key text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at bigint not null default 0
);
alter table app_config enable row level security;
alter table users add column if not exists must_change_username boolean not null default false;
