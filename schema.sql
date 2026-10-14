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
  resets_used integer not null default 0
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

create index if not exists idx_notifications_user on notifications(username);
create index if not exists idx_requests_status on requests(status);
