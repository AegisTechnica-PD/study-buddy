-- Only needed if you already ran schema.sql before the application-questions update.
alter table cards add column if not exists kind text not null default 'term' check (kind in ('term','scenario'));
alter table cards add column if not exists explanation text;
alter table cards add column if not exists concept_card_id uuid references cards(id) on delete set null;
