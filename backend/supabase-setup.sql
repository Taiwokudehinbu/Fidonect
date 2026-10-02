-- Run this once in Supabase dashboard > SQL Editor > New query.
-- Creates the beginner test table, one record, and public read access.

create table if not exists institutions (
  id bigint generated always as identity primary key,
  name text not null,
  location text
);

insert into institutions (name, location)
select 'University of Lagos (UNILAG)', 'Akoka, Lagos'
where not exists (select 1 from institutions where name = 'University of Lagos (UNILAG)');

alter table institutions enable row level security;

drop policy if exists "public read" on institutions;
create policy "public read" on institutions
  for select to anon using (true);
