-- Only needed if you already ran schema.sql before the math facts update.

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
