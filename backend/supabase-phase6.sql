-- Phase 6: private 1-to-1 messaging (connection-gated). Supabase dashboard > SQL Editor.
-- Run ONE statement at a time, in order. Requires the Phase 3 `connections` table.
-- Additive only; no existing table is modified. No group chats in v1.

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

-- 6: conversations — read/update only your own threads; creation is verified by the API
drop policy if exists "read own conversations" on conversations;
create policy "read own conversations" on conversations
  for select to authenticated using (exists (
    select 1 from participants p
    where p.conversation_id = conversations.id and p.user_id = auth.uid()));
drop policy if exists "create conversations" on conversations;
create policy "create conversations" on conversations
  for insert to authenticated with check (true);
drop policy if exists "touch own conversations" on conversations;
create policy "touch own conversations" on conversations
  for update to authenticated using (exists (
    select 1 from participants p
    where p.conversation_id = conversations.id and p.user_id = auth.uid()))
  with check (exists (
    select 1 from participants p
    where p.conversation_id = conversations.id and p.user_id = auth.uid()));

-- 7: participants — read rows in your own threads; join only over an accepted connection
drop policy if exists "read thread participants" on participants;
create policy "read thread participants" on participants
  for select to authenticated using (
    user_id = auth.uid() or conversation_id in (
      select conversation_id from participants where user_id = auth.uid()));
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
  for select to authenticated using (exists (
    select 1 from participants p
    where p.conversation_id = messages.conversation_id and p.user_id = auth.uid()));
drop policy if exists "send own thread messages" on messages;
create policy "send own thread messages" on messages
  for insert to authenticated with check (
    sender_id = auth.uid() and exists (
      select 1 from participants p
      where p.conversation_id = messages.conversation_id and p.user_id = auth.uid()));
drop policy if exists "mark others read" on messages;
create policy "mark others read" on messages
  for update to authenticated using (
    sender_id <> auth.uid() and exists (
      select 1 from participants p
      where p.conversation_id = messages.conversation_id and p.user_id = auth.uid()))
  with check (
    sender_id <> auth.uid() and exists (
      select 1 from participants p
      where p.conversation_id = messages.conversation_id and p.user_id = auth.uid()));

-- 9 (OPTIONAL, future realtime only — skip for v1 polling): expose new rows to Realtime.
-- alter publication supabase_realtime add table messages;
-- Realtime also needs: supabase-js in the frontend + login session + a postgres_changes
-- channel on messages. v1 uses 8-second polling instead — no new keys or dependencies.
