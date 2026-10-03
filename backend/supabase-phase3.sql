-- Phase 3: connections. Supabase dashboard > SQL Editor, ONE statement at a time.
-- Requires Phase 1 `profiles` table first. Additive only; nothing existing is touched.

-- 1/4: table (requester = sender, addressee = receiver; no self-requests; no duplicates)
create table if not exists connections (
  id bigint generated always as identity primary key,
  requester_id uuid not null references profiles(id) on delete cascade,
  addressee_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz not null default now(),
  unique(requester_id, addressee_id),
  check (requester_id <> addressee_id)
);

-- 2/4: lock down
alter table connections enable row level security;

-- 3/4: send own requests only
drop policy if exists "request own connections" on connections;
create policy "request own connections" on connections
  for insert to authenticated with check (auth.uid() = requester_id);

-- 4/4: read own rows (sent or received) + respond to received ones
drop policy if exists "read own connections" on connections;
create policy "read own connections" on connections
  for select to authenticated using (auth.uid() = requester_id or auth.uid() = addressee_id);
drop policy if exists "respond to received" on connections;
create policy "respond to received" on connections
  for update to authenticated using (auth.uid() = addressee_id) with check (auth.uid() = addressee_id);
