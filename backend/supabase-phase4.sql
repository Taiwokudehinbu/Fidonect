-- Phase 4: community posts + safety reports. Supabase dashboard > SQL Editor,
-- ONE statement at a time. Additive only; live tables untouched.

-- 1/4: posts (author = profile id; school = institution name as shown)
create table if not exists posts (
  id bigint generated always as identity primary key,
  school text not null,
  author_id uuid not null references profiles(id) on delete cascade,
  author_name text not null default 'Student',
  text text not null check (char_length(text) between 1 and 1000),
  created_at timestamptz not null default now()
);

-- 2/4: reports (reporter-only writes; reads reserved for future moderators)
create table if not exists reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null references profiles(id) on delete cascade,
  target text not null,
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now()
);

-- 3/4: lock down
alter table posts enable row level security;
alter table reports enable row level security;

-- 4/4: policies (logged-in users post/report; everyone logged-in reads posts)
drop policy if exists "post own messages" on posts;
create policy "post own messages" on posts
  for insert to authenticated with check (auth.uid() = author_id);
drop policy if exists "read posts" on posts;
create policy "read posts" on posts
  for select to authenticated using (true);
drop policy if exists "file own reports" on reports;
create policy "file own reports" on reports
  for insert to authenticated with check (auth.uid() = reporter_id);
