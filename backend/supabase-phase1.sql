-- Phase 1: profiles table + RLS. Supabase dashboard > SQL Editor.
-- The editor is flaky on batches: run ONE statement at a time, in order.
-- Never touches the live `institutions` table.

-- 1/5: table (id = Supabase Auth user id; visibility + consent per PRD §§22.5, 23.2)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null,
  user_type text not null default 'prospective',
  school text,
  faculty text,
  dept text,
  programme text,
  session text,
  interests text,
  visibility text not null default 'connections' check (visibility in ('public','connections','private')),
  consent_at timestamptz,
  created_at timestamptz not null default now()
);

-- 2/5: lock it down (deny-by-default; policies below re-open narrowly)
alter table profiles enable row level security;

-- 3/5: insert own profile only
drop policy if exists "insert own profile" on profiles;
create policy "insert own profile" on profiles
  for insert to authenticated with check (auth.uid() = id);

-- 4/5: any logged-in user can read profiles (needed for discovery; tighten later)
drop policy if exists "read profiles" on profiles;
create policy "read profiles" on profiles
  for select to authenticated using (true);

-- 5/5: update own profile only
drop policy if exists "update own profile" on profiles;
create policy "update own profile" on profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
