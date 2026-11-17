-- Fidonect Phase 2: mentorship, verified institution information, Fido feedback.
-- Additive and idempotent. Run after 20261114_phase0_security.sql and
-- 20261114_phase1_scholarships.sql.
--
-- Safety:
--   * no table, column, user, institution, connection, message or post is dropped
--   * no rows are deleted and no institution data is reseeded
--   * mentor/hub content starts empty (or unverified) until an admin verifies it
--   * public mentor reads go through a filtered view; email and verification
--     evidence are never exposed there
--
-- Verified means: an administrator checked the mentor's evidence, or checked an
-- institution information source and marked the page verified. The app must not
-- show a verified badge without one of those admin actions.

-- ---------------------------------------------------------------------------
-- 1. Mentor profiles (one row per user who applies)
-- ---------------------------------------------------------------------------
create table if not exists public.mentor_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  institution_id bigint references public.institutions(id) on delete set null,
  institution_name text not null check (char_length(institution_name) between 2 and 160),
  faculty text check (faculty is null or char_length(faculty) <= 160),
  department text check (department is null or char_length(department) <= 160),
  programme text check (programme is null or char_length(programme) <= 160),
  level text check (level is null or char_length(level) <= 80),
  bio text not null check (char_length(bio) between 20 and 2000),
  help_areas text[] not null default '{}'::text[]
    check (coalesce(array_length(help_areas, 1), 0) <= 8),
  verification_method text not null
    check (verification_method in ('institutional_email', 'student_id', 'other')),
  -- Private admin evidence only (for example "student portal profile link").
  -- Users are warned not to paste ID numbers, passwords, or document images.
  verification_detail text check (verification_detail is null or char_length(verification_detail) <= 300),
  admin_note text check (admin_note is null or char_length(admin_note) <= 500),
  -- Application consent to a public mentor listing. The listing never includes
  -- email, verification evidence, or profile contact details.
  listed boolean not null default true,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'rejected', 'paused')),
  verified_at timestamptz,
  verified_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mentor_profiles_status_idx
  on public.mentor_profiles (status, updated_at desc);
create index if not exists mentor_profiles_institution_idx
  on public.mentor_profiles (institution_id) where status = 'verified';

alter table public.mentor_profiles enable row level security;
revoke all on public.mentor_profiles from anon;
grant select, insert, update on public.mentor_profiles to authenticated;

drop policy if exists "read own mentor profile" on public.mentor_profiles;
create policy "read own mentor profile" on public.mentor_profiles
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "admins read mentor profiles" on public.mentor_profiles;
create policy "admins read mentor profiles" on public.mentor_profiles
  for select to authenticated using (
    public.has_role('super_admin') or public.has_role('content_admin') or public.has_role('moderator')
  );

drop policy if exists "apply own mentor profile" on public.mentor_profiles;
create policy "apply own mentor profile" on public.mentor_profiles
  for insert to authenticated with check (
    user_id = auth.uid()
    and status = 'pending'
    and verified_at is null
    and verified_by is null
  );

-- Applicants may edit their own application, but every edit resets it to
-- pending review. Only an admin policy below can mark it verified.
drop policy if exists "update own mentor application" on public.mentor_profiles;
create policy "update own mentor application" on public.mentor_profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and status = 'pending'
    and verified_at is null
    and verified_by is null
  );

drop policy if exists "admins update mentor profiles" on public.mentor_profiles;
create policy "admins update mentor profiles" on public.mentor_profiles
  for update to authenticated
  using (
    public.has_role('super_admin') or public.has_role('content_admin')
  )
  with check (
    public.has_role('super_admin') or public.has_role('content_admin')
  );

drop policy if exists "admins delete mentor profiles" on public.mentor_profiles;
create policy "admins delete mentor profiles" on public.mentor_profiles
  for delete to authenticated using (public.has_role('super_admin'));

-- A self-edit always resets the row to pending review and clears admin-only
-- fields, even if a client bypasses the API and calls PostgREST directly.
create or replace function public.guard_mentor_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and auth.uid() = old.user_id
     and not public.has_role('super_admin')
     and not public.has_role('content_admin') then
    new.user_id := old.user_id;
    new.status := 'pending';
    new.verified_at := null;
    new.verified_by := null;
    new.admin_note := null;
  end if;
  return new;
end $$;

drop trigger if exists mentor_profiles_guard_update on public.mentor_profiles;
create trigger mentor_profiles_guard_update
  before update on public.mentor_profiles
  for each row execute function public.guard_mentor_profile_update();

-- Public directory view. It deliberately exposes no email and no private
-- verification evidence, and only lists admin-verified mentors who opted in.
create or replace view public.mentor_directory
with (security_invoker = false) as
select
  m.user_id,
  p.name,
  p.photo_url,
  p.user_type,
  m.institution_id,
  m.institution_name,
  m.faculty,
  m.department,
  m.programme,
  m.level,
  m.bio,
  m.help_areas,
  m.verified_at,
  m.updated_at,
  i.location as institution_location,
  i.ownership,
  i.kind
from public.mentor_profiles m
join public.profiles p on p.id = m.user_id
left join public.institutions i on i.id = m.institution_id
where m.status = 'verified'
  and m.listed = true
  and coalesce(p.visibility, 'public') <> 'private';

revoke all on public.mentor_directory from anon;
grant select on public.mentor_directory to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Mentor requests (prospective/existing student -> verified mentor)
-- ---------------------------------------------------------------------------
create table if not exists public.mentor_requests (
  id bigint generated always as identity primary key,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  mentor_id uuid not null references public.profiles(id) on delete cascade,
  topic text not null check (char_length(topic) between 3 and 120),
  message text not null check (char_length(message) between 10 and 2000),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled', 'completed')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> mentor_id)
);

create index if not exists mentor_requests_requester_idx
  on public.mentor_requests (requester_id, created_at desc);
create index if not exists mentor_requests_mentor_idx
  on public.mentor_requests (mentor_id, created_at desc);
create unique index if not exists mentor_requests_one_pending_idx
  on public.mentor_requests (requester_id, mentor_id) where status = 'pending';

-- Direct PostgREST inserts must not be able to target an unverified or unlisted
-- user. The API already checks the public view; this keeps the database honest
-- even if a client bypasses the API.
create or replace function public.is_verified_mentor(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.mentor_profiles m
    where m.user_id = uid and m.status = 'verified' and m.listed = true
  );
$$;
revoke all on function public.is_verified_mentor(uuid) from public;
revoke all on function public.is_verified_mentor(uuid) from anon;
grant execute on function public.is_verified_mentor(uuid) to authenticated, service_role;

alter table public.mentor_requests enable row level security;
revoke all on public.mentor_requests from anon;
grant select, insert, update on public.mentor_requests to authenticated;

drop policy if exists "read own mentor requests" on public.mentor_requests;
create policy "read own mentor requests" on public.mentor_requests
  for select to authenticated using (
    requester_id = auth.uid() or mentor_id = auth.uid()
  );

drop policy if exists "admins read mentor requests" on public.mentor_requests;
create policy "admins read mentor requests" on public.mentor_requests
  for select to authenticated using (
    public.has_role('super_admin') or public.has_role('content_admin') or public.has_role('moderator')
  );

drop policy if exists "create own mentor request" on public.mentor_requests;
create policy "create own mentor request" on public.mentor_requests
  for insert to authenticated with check (
    requester_id = auth.uid()
    and status = 'pending'
    and public.is_verified_mentor(mentor_id)
  );

drop policy if exists "mentor responds to request" on public.mentor_requests;
create policy "mentor responds to request" on public.mentor_requests
  for update to authenticated
  using (mentor_id = auth.uid() and status = 'pending')
  with check (mentor_id = auth.uid() and status in ('accepted', 'declined'));

drop policy if exists "requester cancels request" on public.mentor_requests;
create policy "requester cancels request" on public.mentor_requests
  for update to authenticated
  using (requester_id = auth.uid() and status = 'pending')
  with check (requester_id = auth.uid() and status = 'cancelled');

drop policy if exists "participants complete request" on public.mentor_requests;
create policy "participants complete request" on public.mentor_requests
  for update to authenticated
  using (
    status = 'accepted' and (requester_id = auth.uid() or mentor_id = auth.uid())
  )
  with check (
    status in ('accepted', 'completed') and (requester_id = auth.uid() or mentor_id = auth.uid())
  );

-- The two participants are immutable. RLS is row-level, so without this a
-- mentor could accept a request and rewrite requester_id to an unrelated user,
-- which would then wrongly unlock messaging with that user.
create or replace function public.lock_mentor_request_participants()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.requester_id <> old.requester_id or new.mentor_id <> old.mentor_id then
    raise exception 'mentor request participants cannot be changed';
  end if;
  return new;
end $$;

drop trigger if exists mentor_requests_lock_participants on public.mentor_requests;
create trigger mentor_requests_lock_participants
  before update on public.mentor_requests
  for each row execute function public.lock_mentor_request_participants();

-- An accepted mentorship request is also a valid reason to open a private
-- conversation. Replace the helper with the same behaviour plus that gate.
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
  select p1.conversation_id into cid
  from participants p1
  where p1.user_id = me
    and exists (select 1 from participants p2
                where p2.conversation_id = p1.conversation_id and p2.user_id = other)
  limit 1;
  if cid is not null then
    return cid;
  end if;
  if not exists (
    select 1 from connections c
    where c.status = 'accepted'
      and ((c.requester_id = me and c.addressee_id = other)
        or (c.requester_id = other and c.addressee_id = me))
  ) and not exists (
    select 1 from mentor_requests r
    where r.status = 'accepted'
      and ((r.requester_id = me and r.mentor_id = other)
        or (r.requester_id = other and r.mentor_id = me))
  ) then
    raise exception 'not connected';
  end if;
  insert into conversations default values returning id into cid;
  insert into participants (conversation_id, user_id) values (cid, me), (cid, other);
  return cid;
end $$;
revoke execute on function public.open_conversation(uuid) from public;
revoke execute on function public.open_conversation(uuid) from anon;
grant execute on function public.open_conversation(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Richer institution hub pages + verification
-- ---------------------------------------------------------------------------
alter table public.hub_pages add column if not exists admission text;
alter table public.hub_pages add column if not exists registration text;
alter table public.hub_pages add column if not exists dates text;
alter table public.hub_pages add column if not exists transport text;
alter table public.hub_pages add column if not exists facilities text;
alter table public.hub_pages add column if not exists faq jsonb not null default '[]'::jsonb;
alter table public.hub_pages add column if not exists official_links jsonb not null default '[]'::jsonb;
alter table public.hub_pages add column if not exists source_url text;
alter table public.hub_pages add column if not exists verified boolean not null default false;
alter table public.hub_pages add column if not exists verified_at timestamptz;
alter table public.hub_pages add column if not exists verified_by uuid references public.profiles(id) on delete set null;
alter table public.hub_pages add column if not exists last_reviewed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hub_pages_faq_array') then
    alter table public.hub_pages
      add constraint hub_pages_faq_array check (jsonb_typeof(faq) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hub_pages_official_links_array') then
    alter table public.hub_pages
      add constraint hub_pages_official_links_array check (jsonb_typeof(official_links) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hub_pages_source_url_http') then
    alter table public.hub_pages
      add constraint hub_pages_source_url_http check (source_url is null or source_url ~ '^https?://');
  end if;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists hub_pages_set_updated_at on public.hub_pages;
create trigger hub_pages_set_updated_at
  before update on public.hub_pages
  for each row execute function public.set_updated_at();

alter table public.hub_pages enable row level security;
grant select on public.hub_pages to anon, authenticated;
revoke insert, update, delete on public.hub_pages from anon;
grant insert, update, delete on public.hub_pages to authenticated;

drop policy if exists "public read" on public.hub_pages;
create policy "public read" on public.hub_pages
  for select to anon, authenticated using (true);

drop policy if exists "admins write hub pages" on public.hub_pages;
create policy "admins write hub pages" on public.hub_pages
  for insert to authenticated with check (
    public.has_role('super_admin') or public.has_role('content_admin')
  );

drop policy if exists "admins update hub pages" on public.hub_pages;
create policy "admins update hub pages" on public.hub_pages
  for update to authenticated
  using (public.has_role('super_admin') or public.has_role('content_admin'))
  with check (public.has_role('super_admin') or public.has_role('content_admin'));

drop policy if exists "admins delete hub pages" on public.hub_pages;
create policy "admins delete hub pages" on public.hub_pages
  for delete to authenticated using (public.has_role('super_admin'));

-- ---------------------------------------------------------------------------
-- 4. Fido feedback / correction mechanism
-- ---------------------------------------------------------------------------
create table if not exists public.fido_feedback (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete set null,
  question text not null check (char_length(question) between 3 and 500),
  answer_source text check (answer_source is null or char_length(answer_source) <= 40),
  school text check (school is null or char_length(school) <= 160),
  helpful boolean not null,
  correction text check (correction is null or char_length(correction) <= 2000),
  created_at timestamptz not null default now()
);

create index if not exists fido_feedback_created_idx
  on public.fido_feedback (created_at desc);
create index if not exists fido_feedback_unhelpful_idx
  on public.fido_feedback (created_at desc) where helpful = false;

alter table public.fido_feedback enable row level security;
revoke select, update, delete on public.fido_feedback from anon;
grant insert on public.fido_feedback to anon, authenticated;
grant select on public.fido_feedback to authenticated;

drop policy if exists "anonymous fido feedback" on public.fido_feedback;
create policy "anonymous fido feedback" on public.fido_feedback
  for insert to anon with check (user_id is null);

drop policy if exists "signed-in fido feedback" on public.fido_feedback;
create policy "signed-in fido feedback" on public.fido_feedback
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "admins read fido feedback" on public.fido_feedback;
create policy "admins read fido feedback" on public.fido_feedback
  for select to authenticated using (
    public.has_role('super_admin') or public.has_role('content_admin') or public.has_role('moderator')
  );

-- Verify after running:
--   select count(*) from public.mentor_profiles;              -- starts at 0
--   select count(*) from public.mentor_requests;              -- starts at 0
--   select count(*) from public.hub_pages where verified;     -- existing rows are unverified
--   select policyname, cmd from pg_policies where tablename in
--     ('mentor_profiles','mentor_requests','hub_pages','fido_feedback');
