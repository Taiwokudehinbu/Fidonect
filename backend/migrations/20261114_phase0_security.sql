-- Fidonect Phase 0.1 security hardening
-- Idempotent and additive. Run in Supabase SQL Editor after taking a backup.
-- It does not delete user data, drop tables, or touch institutions.
--
-- What this fixes:
--   1. profiles broad SELECT (email/PII exposure via PostgREST)
--   2. direct conversation/participant inserts (self-join bypass)
--   3. broad avatar uploads (any authenticated user could write any folder)
--   4. missing admin RBAC helpers/audit log
--   5. missing indexes used by discovery, messaging and moderation
--
-- The API reads a privacy-safe `visible_profiles` view and falls back to
-- `profiles` automatically before this migration is applied.

-- ---------------------------------------------------------------------------
-- 1. Roles, helper functions and audit log
-- ---------------------------------------------------------------------------
create table if not exists public.user_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('super_admin', 'content_admin', 'moderator')),
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);
alter table public.user_roles enable row level security;

create or replace function public.has_role(required text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = required
  );
$$;
revoke execute on function public.has_role(text) from public;
grant execute on function public.has_role(text) to authenticated, service_role;

drop policy if exists "read own roles" on public.user_roles;
create policy "read own roles" on public.user_roles
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "admins read roles" on public.user_roles;
create policy "admins read roles" on public.user_roles
  for select to authenticated using (public.has_role('super_admin'));

create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_email text,
  action text not null,
  target text,
  details jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_audit_log enable row level security;
drop policy if exists "admins read audit" on public.admin_audit_log;
create policy "admins read audit" on public.admin_audit_log
  for select to authenticated using (public.has_role('super_admin'));
drop policy if exists "admins write audit" on public.admin_audit_log;
create policy "admins write audit" on public.admin_audit_log
  for insert to authenticated with check (
    actor_id = auth.uid() and (
      public.has_role('super_admin') or
      public.has_role('content_admin') or
      public.has_role('moderator')
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Privacy-safe profile view
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER = false means the view owner (postgres) reads the base
-- table, so the view itself must enforce the visibility rules. It never
-- exposes email, consent_at or other private columns.
create or replace view public.visible_profiles
with (security_invoker = false) as
select
  p.id, p.name, p.user_type, p.school, p.faculty, p.dept, p.programme,
  p.session, p.interests, p.visibility, p.photo_url, p.created_at
from public.profiles p
where p.visibility <> 'private'
   or p.id = auth.uid()
   or exists (
     select 1 from public.connections c
     where c.status in ('pending', 'accepted')
       and (
         (c.requester_id = auth.uid() and c.addressee_id = p.id) or
         (c.addressee_id = auth.uid() and c.requester_id = p.id)
       )
   );
revoke all on public.visible_profiles from anon;
grant select on public.visible_profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Profiles: own row + admin read only (replaces `read profiles` using true)
-- ---------------------------------------------------------------------------
-- Remove every pre-existing SELECT policy on profiles except the two safe ones
-- below. This catches renamed versions of the old broad policy too.
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT'
      and policyname not in ('read own profile', 'admins read profiles')
  loop
    execute format('drop policy if exists %I on public.profiles', pol.policyname);
  end loop;
end $$;
drop policy if exists "read profiles" on public.profiles;
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated using (auth.uid() = id);
drop policy if exists "admins read profiles" on public.profiles;
create policy "admins read profiles" on public.profiles
  for select to authenticated using (
    public.has_role('super_admin') or
    public.has_role('content_admin') or
    public.has_role('moderator')
  );

-- Keep the existing insert/update policies (own row only) if they exist.
drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
  for insert to authenticated with check (auth.uid() = id);
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- 4. Messaging: no direct conversation/participant creation
--    Threads are created only by open_conversation(), a SECURITY DEFINER RPC
--    that re-checks the accepted connection.
-- ---------------------------------------------------------------------------
drop policy if exists "create conversations" on public.conversations;
drop policy if exists "join on accepted connection" on public.participants;
revoke insert on public.conversations from authenticated;
revoke insert on public.participants from authenticated;

-- Keep read/update policies from supabase-phase6.sql. Re-assert the safe ones
-- so this migration also works on a partially configured database.
drop policy if exists "read own conversations" on public.conversations;
create policy "read own conversations" on public.conversations
  for select to authenticated using (public.is_participant(id));
drop policy if exists "touch own conversations" on public.conversations;
create policy "touch own conversations" on public.conversations
  for update to authenticated
  using (public.is_participant(id))
  with check (public.is_participant(id));

drop policy if exists "read thread participants" on public.participants;
create policy "read thread participants" on public.participants
  for select to authenticated using (
    user_id = auth.uid() or public.is_participant(conversation_id)
  );

-- ---------------------------------------------------------------------------
-- 5. Avatars: one folder per user
-- ---------------------------------------------------------------------------
drop policy if exists "upload own avatars" on storage.objects;
drop policy if exists "update own avatars" on storage.objects;
drop policy if exists "delete own avatars" on storage.objects;
create policy "upload own avatars" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "update own avatars" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "delete own avatars" on storage.objects
  for delete to authenticated using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- 6. Admin moderation read access (posts/reports)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.posts') is not null then
    execute 'drop policy if exists "admins read posts" on public.posts';
    execute 'create policy "admins read posts" on public.posts for select to authenticated using (public.has_role(''super_admin'') or public.has_role(''content_admin'') or public.has_role(''moderator''))';
    execute 'drop policy if exists "admins delete posts" on public.posts';
    execute 'create policy "admins delete posts" on public.posts for delete to authenticated using (public.has_role(''super_admin'') or public.has_role(''moderator''))';
  end if;
  if to_regclass('public.reports') is not null then
    execute 'alter table public.reports add column if not exists status text not null default ''open''';
    execute 'drop policy if exists "admins read reports" on public.reports';
    execute 'create policy "admins read reports" on public.reports for select to authenticated using (public.has_role(''super_admin'') or public.has_role(''content_admin'') or public.has_role(''moderator''))';
    execute 'drop policy if exists "admins update reports" on public.reports';
    execute 'create policy "admins update reports" on public.reports for update to authenticated using (public.has_role(''super_admin'') or public.has_role(''moderator'')) with check (public.has_role(''super_admin'') or public.has_role(''moderator''))';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Indexes for the queries the app actually runs
-- ---------------------------------------------------------------------------
create index if not exists profiles_created_at_idx on public.profiles (created_at desc);
create index if not exists connections_requester_status_idx on public.connections (requester_id, status);
create index if not exists connections_addressee_status_idx on public.connections (addressee_id, status);
create index if not exists user_roles_user_idx on public.user_roles (user_id);
do $$
begin
  if to_regclass('public.posts') is not null then
    execute 'create index if not exists posts_created_at_idx on public.posts (created_at desc)';
  end if;
  if to_regclass('public.reports') is not null then
    execute 'create index if not exists reports_created_at_idx on public.reports (created_at desc)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Seed the first admin (run separately, replace the email)
-- ---------------------------------------------------------------------------
-- insert into public.user_roles (user_id, role)
-- select id, 'super_admin' from public.profiles
-- where lower(email) = lower('you@example.com')
-- on conflict do nothing;
