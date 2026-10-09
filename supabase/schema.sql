-- Study Buddy schema. Run once in the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- ---------- profiles ----------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null,
  role text not null default 'student' check (role in ('admin','student')),
  grade text,
  daily_goal_minutes int not null default 20,
  created_at timestamptz not null default now()
);

create or replace function is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;

-- ---------- decks, sources, cards ----------
create table if not exists decks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  subject text,
  created_at timestamptz not null default now()
);

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references decks(id) on delete cascade,
  owner_id uuid not null references profiles(id) on delete cascade,
  filename text not null,
  storage_path text not null,
  status text not null default 'uploaded' check (status in ('uploaded','processing','done','error')),
  error text,
  card_count int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists cards (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references decks(id) on delete cascade,
  owner_id uuid not null references profiles(id) on delete cascade,
  source_id uuid references sources(id) on delete set null,
  front text not null,
  back text not null,
  wrong_answers jsonb not null default '[]'::jsonb,
  kind text not null default 'term' check (kind in ('term','scenario')),
  explanation text,
  concept_card_id uuid references cards(id) on delete set null,
  status text not null default 'active' check (status in ('active','pending')),
  created_at timestamptz not null default now()
);
create index if not exists cards_deck_idx on cards(deck_id);

-- ---------- learning state and analytics ----------
create table if not exists card_stats (
  user_id uuid not null references profiles(id) on delete cascade,
  card_id uuid not null references cards(id) on delete cascade,
  box int not null default 1,
  due_at timestamptz not null default now(),
  correct_count int not null default 0,
  wrong_count int not null default 0,
  last_seen timestamptz,
  primary key (user_id, card_id)
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  deck_id uuid references decks(id) on delete set null,
  mode text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  active_seconds int not null default 0,
  cards_answered int not null default 0,
  correct int not null default 0,
  unsure int not null default 0,
  score_pct numeric,
  completed boolean not null default false
);
create index if not exists sessions_user_idx on sessions(user_id, started_at);

create table if not exists answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  deck_id uuid references decks(id) on delete set null,
  card_id uuid references cards(id) on delete cascade,
  result text not null check (result in ('correct','unsure','wrong')),
  method text,        -- auto | verified | self | override
  self_rating text,   -- what the student claimed in flip mode
  response_ms int,
  created_at timestamptz not null default now()
);
create index if not exists answers_user_idx on answers(user_id, created_at);

-- ---------- row level security ----------
alter table profiles   enable row level security;
alter table decks      enable row level security;
alter table sources    enable row level security;
alter table cards      enable row level security;
alter table card_stats enable row level security;
alter table sessions   enable row level security;
alter table answers    enable row level security;

create policy profiles_select on profiles for select using (id = auth.uid() or is_admin());
create policy profiles_update on profiles for update using (is_admin());

create policy decks_all    on decks    for all using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());
create policy sources_all  on sources  for all using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());
create policy cards_all    on cards    for all using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());

create policy stats_all    on card_stats for all using (user_id = auth.uid() or is_admin()) with check (user_id = auth.uid());
create policy sessions_all on sessions   for all using (user_id = auth.uid() or is_admin()) with check (user_id = auth.uid());
create policy answers_all  on answers    for all using (user_id = auth.uid() or is_admin()) with check (user_id = auth.uid());

-- ---------- math facts ----------
create table if not exists math_fact_stats (
  user_id uuid not null references profiles(id) on delete cascade,
  op text not null check (op in ('add','sub','mul','div')),
  a int not null,
  b int not null,
  box int not null default 1,
  due_at timestamptz not null default now(),
  correct_count int not null default 0,
  wrong_count int not null default 0,
  avg_ms int,
  last_seen timestamptz,
  primary key (user_id, op, a, b)
);

create table if not exists math_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  op text not null check (op in ('add','sub','mul','div')),
  a int not null,
  b int not null,
  given text,
  correct boolean not null,
  response_ms int,
  is_retry boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists math_attempts_user_idx on math_attempts(user_id, created_at);

alter table math_fact_stats enable row level security;
alter table math_attempts   enable row level security;
create policy math_stats_all    on math_fact_stats for all using (user_id = auth.uid() or is_admin()) with check (user_id = auth.uid());
create policy math_attempts_all on math_attempts   for all using (user_id = auth.uid() or is_admin()) with check (user_id = auth.uid());

-- ---------- private storage for PDFs ----------
insert into storage.buckets (id, name, public) values ('pdfs', 'pdfs', false) on conflict (id) do nothing;

create policy pdfs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'pdfs' and ((storage.foldername(name))[1] = auth.uid()::text or is_admin()));
create policy pdfs_select on storage.objects for select to authenticated
  using (bucket_id = 'pdfs' and ((storage.foldername(name))[1] = auth.uid()::text or is_admin()));
create policy pdfs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'pdfs' and ((storage.foldername(name))[1] = auth.uid()::text or is_admin()));

-- ---------- ONE-TIME ADMIN SETUP ----------
-- 1. In Supabase > Authentication > Users, click "Add user" and create:
--      email: paul@studyapp.internal   password: (your choice)   auto-confirm: on
-- 2. Then run this (edit the display name if you like):
--
-- insert into profiles (id, username, display_name, role)
-- select id, 'paul', 'Paul', 'admin' from auth.users where email = 'paul@studyapp.internal';
