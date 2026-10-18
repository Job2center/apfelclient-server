-- NUR RLS fuer bereits bestehende Tabellen (Rest von schema.sql).
-- Kann mehrfach ausgefuehrt werden, ist unschaedlich.
alter table users enable row level security;
alter table tokens enable row level security;
alter table notifications enable row level security;
alter table requests enable row level security;
alter table giveaway enable row level security;
alter table telemetry enable row level security;

-- Kontrolle: sollte fuer jede Tabelle "enabled" stehen.
select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename;