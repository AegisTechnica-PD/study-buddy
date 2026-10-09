-- Only needed if you already ran schema.sql before the hybrid scoring update.
alter table answers add column if not exists method text;
alter table answers add column if not exists self_rating text;
