-- Phase 6: private 1-to-1 messaging (connection-gated). Supabase dashboard > SQL Editor.
-- Run ONE statement at a time, in order. Requires the Phase 3 `connections` table.
-- Additive only; no existing table is modified. No group chats in v1.
-- RLS goes through a SECURITY DEFINER helper: policies must never subquery
-- `participants` from a policy on `participants` itself (PostgreSQL raises
-- 42P17 "infinite recursion detected in policy"), which also breaks every
-- policy on conversations/messages that joins through participants.
-- Threads are created via open_conversation(): INSERT ... RETURNING must also
-- pass the SELECT policy, and an empty conversation (no participants yet)
-- cannot pass it — direct inserts get 42501.

-- 1: conversations (one row per 1-to-1 thread; last_message_at kept fresh by the API)
create table if not exists conversations (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  last_message_at timestamptz
);

-- 2: participants (exactly the two chatters; enforced by the API)
create table if not exists participants (
  conversation_id bigint not null references conversations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(conversation_id, user_id)
);

-- 3: messages (read_at null = unread; no delete — history is preserved)
create table if not exists messages (
  id bigint generated always as identity primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

-- 4: indexes (conversation lookup, thread order, unread counts)
create index if not exists participants_user_idx on participants(user_id);
create index if not exists participants_convo_idx on participants(conversation_id);
create index if not exists messages_convo_idx on messages(conversation_id, id);
create index if not exists messages_unread_idx on messages(conversation_id, sender_id) where read_at is null;

-- 5: lock down (deny-by-default; policies below re-open narrowly)
alter table conversations enable row level security;
alter table participants enable row level security;
alter table messages enable row level security;

-- 5b: recursion-free membership check. Runs as the function owner (postgres),
-- which bypasses RLS, so it can read `participants` from any policy safely.
create or replace function public.is_participant(conv_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from participants p
    where p.conversation_id = conv_id and p.user_id = auth.uid());
$$;
revoke execute on function public.is_participant(bigint) from public;
grant execute on function public.is_participant(bigint) to authenticated, service_role;

-- 5c: create a thread atomically. Postgres applies SELECT policies to rows
-- returned by INSERT ... RETURNING, and supabase-js .insert().select() always
-- uses RETURNING — a brand-new conversation has no participants yet, so
-- is_participant(id) fails and the API gets 42501. One definer function writes
-- the conversation and both participant rows together (no RETURNING escapes).
create or replace function public.open_conversation(other uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  cid bigint;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;
  if other is null or other = me then
    raise exception 'cannot message yourself';
  end if;
  -- reuse an existing shared thread if there is one
  select p1.conversation_id into cid
  from participants p1
  where p1.user_id = me
    and exists (select 1 from participants p2
                where p2.conversation_id = p1.conversation_id and p2.user_id = other)
  limit 1;
  if cid is not null then
    return cid;
  end if;
  -- same gate the API applies before calling this function
  if not exists (
    select 1 from connections c
    where c.status = 'accepted'
      and ((c.requester_id = me and c.addressee_id = other)
        or (c.requester_id = other and c.addressee_id = me))) then
    raise exception 'not connected';
  end if;
  insert into conversations default values returning id into cid;
  insert into participants (conversation_id, user_id) values (cid, me), (cid, other);
  return cid;
end $$;
revoke execute on function public.open_conversation(uuid) from public;
grant execute on function public.open_conversation(uuid) to authenticated, service_role;

-- 6: conversations — read/update only your own threads; creation is verified by the API
drop policy if exists "read own conversations" on conversations;
create policy "read own conversations" on conversations
  for select to authenticated using (public.is_participant(id));
drop policy if exists "create conversations" on conversations;
create policy "create conversations" on conversations
  for insert to authenticated with check (true);
drop policy if exists "touch own conversations" on conversations;
create policy "touch own conversations" on conversations
  for update to authenticated
  using (public.is_participant(id))
  with check (public.is_participant(id));

-- 7: participants — read rows in your own threads; join only over an accepted connection
drop policy if exists "read thread participants" on participants;
create policy "read thread participants" on participants
  for select to authenticated using (
    user_id = auth.uid() or public.is_participant(conversation_id));
drop policy if exists "join on accepted connection" on participants;
create policy "join on accepted connection" on participants
  for insert to authenticated with check (
    user_id = auth.uid() or exists (
      select 1 from connections
      where status = 'accepted' and (
        (requester_id = auth.uid() and addressee_id = participants.user_id) or
        (addressee_id = auth.uid() and requester_id = participants.user_id))));

-- 8: messages — read/send only in your threads, as yourself; mark others' as read; never delete
drop policy if exists "read own thread messages" on messages;
create policy "read own thread messages" on messages
  for select to authenticated using (public.is_participant(conversation_id));
drop policy if exists "send own thread messages" on messages;
create policy "send own thread messages" on messages
  for insert to authenticated with check (
    sender_id = auth.uid() and public.is_participant(conversation_id));
drop policy if exists "mark others read" on messages;
create policy "mark others read" on messages
  for update to authenticated using (
    sender_id <> auth.uid() and public.is_participant(conversation_id))
  with check (
    sender_id <> auth.uid() and public.is_participant(conversation_id));

-- 9 (OPTIONAL, future realtime only — skip for v1 polling): expose new rows to Realtime.
-- alter publication supabase_realtime add table messages;
-- Realtime also needs: supabase-js in the frontend + login session + a postgres_changes
-- channel on messages. v1 uses 8-second polling instead — no new keys or dependencies.
