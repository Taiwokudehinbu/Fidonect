-- Fidonect Phase 4A: institution partnerships, alumni, recruitment.
-- Additive and idempotent. Run after the Phase 0, Phase 1, Phase 2, and
-- Phase 3A migrations.
--
-- Scope:
--   * admin-verified institution partner accounts and public pages
--   * admin-approved partner announcements
--   * opt-in, admin-reviewed alumni profiles and a public directory
--   * admin-approved opportunities from verified institution partners
--   * external application links only; no CV uploads, in-app applications,
--     payments, bookings, or automated recruitment decisions
--
-- Safety:
--   * no table, column, user, institution, connection, message, or post is dropped
--   * no rows are deleted and no institution data is reseeded
--   * every new table starts empty
--   * public reads go through filtered views that never expose email, phone,
--     private verification evidence, admin notes, private source URLs, or CVs

-- ---------------------------------------------------------------------------
-- 1. Shared updated_at helper (already present after Phase 1/2; re-asserted)
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Institution partners and scoped partner members
-- ---------------------------------------------------------------------------
create table if not exists public.institution_partners (
  institution_id bigint primary key references public.institutions(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'rejected', 'paused')),
  public_summary text check (
    public_summary is null or char_length(public_summary) between 20 and 1200
  ),
  official_url text check (official_url is null or official_url ~ '^https?://'),
  verification_method text not null default 'official_website'
    check (verification_method in ('official_email', 'official_letter', 'official_website', 'other')),
  verification_detail text check (
    verification_detail is null or char_length(verification_detail) <= 1000
  ),
  admin_note text check (admin_note is null or char_length(admin_note) <= 500),
  listed boolean not null default false,
  verified_at timestamptz,
  verified_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists institution_partners_status_idx
  on public.institution_partners (status, updated_at desc);
create index if not exists institution_partners_listed_idx
  on public.institution_partners (updated_at desc)
  where status = 'verified' and listed = true;

create table if not exists public.institution_partner_members (
  institution_id bigint not null references public.institution_partners(institution_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  member_role text not null default 'owner'
    check (member_role in ('owner', 'editor')),
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (institution_id, user_id)
);

create index if not exists institution_partner_members_user_idx
  on public.institution_partner_members (user_id, status);

-- A partner member can read their own partner row and their institution's
-- submissions, but cannot add themselves, verify the partner, or act for
-- another institution.
create or replace function public.is_partner_member(pid bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.institution_partner_members m
    join public.institution_partners p on p.institution_id = m.institution_id
    where m.institution_id = pid
      and m.user_id = auth.uid()
      and m.status = 'active'
      and p.status in ('pending', 'verified')
  );
$$;
revoke all on function public.is_partner_member(bigint) from public;
revoke all on function public.is_partner_member(bigint) from anon;
grant execute on function public.is_partner_member(bigint) to authenticated, service_role;

-- Content submission requires a verified partner, but public visibility also
-- requires the partner to be listed.
create or replace function public.is_verified_partner(pid bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.institution_partners p
    where p.institution_id = pid
      and p.status = 'verified'
  );
$$;
revoke all on function public.is_verified_partner(bigint) from public;
revoke all on function public.is_verified_partner(bigint) from anon;
grant execute on function public.is_verified_partner(bigint) to authenticated, service_role;

alter table public.institution_partners enable row level security;
revoke all on public.institution_partners from anon, authenticated;
grant select, insert, update on public.institution_partners to authenticated;

drop policy if exists "read own or admin partners" on public.institution_partners;
create policy "read own or admin partners" on public.institution_partners
  for select to authenticated using (
    public.is_partner_member(institution_id)
    or public.has_role('super_admin')
    or public.has_role('content_admin')
    or public.has_role('moderator')
  );

drop policy if exists "admins insert partners" on public.institution_partners;
create policy "admins insert partners" on public.institution_partners
  for insert to authenticated with check (public.has_role('super_admin'));

drop policy if exists "admins update partners" on public.institution_partners;
create policy "admins update partners" on public.institution_partners
  for update to authenticated
  using (public.has_role('super_admin'))
  with check (public.has_role('super_admin'));

alter table public.institution_partner_members enable row level security;
revoke all on public.institution_partner_members from anon, authenticated;
grant select, insert, update on public.institution_partner_members to authenticated;

drop policy if exists "read own or admin partner members" on public.institution_partner_members;
create policy "read own or admin partner members" on public.institution_partner_members
  for select to authenticated using (
    user_id = auth.uid()
    or public.has_role('super_admin')
    or public.has_role('content_admin')
    or public.has_role('moderator')
  );

drop policy if exists "admins insert partner members" on public.institution_partner_members;
create policy "admins insert partner members" on public.institution_partner_members
  for insert to authenticated with check (public.has_role('super_admin'));

drop policy if exists "admins update partner members" on public.institution_partner_members;
create policy "admins update partner members" on public.institution_partner_members
  for update to authenticated
  using (public.has_role('super_admin'))
  with check (public.has_role('super_admin'));

drop trigger if exists institution_partners_set_updated_at on public.institution_partners;
create trigger institution_partners_set_updated_at
  before update on public.institution_partners
  for each row execute function public.set_updated_at();

drop trigger if exists institution_partner_members_set_updated_at on public.institution_partner_members;
create trigger institution_partner_members_set_updated_at
  before update on public.institution_partner_members
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Partner announcements
-- ---------------------------------------------------------------------------
create table if not exists public.partner_announcements (
  id bigint generated always as identity primary key,
  institution_id bigint not null references public.institution_partners(institution_id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  title text not null check (char_length(title) between 3 and 160),
  body text not null check (char_length(body) between 20 and 4000),
  category text not null default 'general'
    check (category in ('general', 'admission', 'registration', 'event', 'deadline', 'opportunity')),
  link_url text check (link_url is null or link_url ~ '^https?://'),
  expires_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'paused')),
  admin_note text check (admin_note is null or char_length(admin_note) <= 500),
  published_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists partner_announcements_status_idx
  on public.partner_announcements (status, updated_at desc);
create index if not exists partner_announcements_institution_idx
  on public.partner_announcements (institution_id, created_at desc);
create index if not exists partner_announcements_public_idx
  on public.partner_announcements (institution_id, published_at desc)
  where status = 'approved';

alter table public.partner_announcements enable row level security;
revoke all on public.partner_announcements from anon, authenticated;
grant select, insert, update on public.partner_announcements to authenticated;

drop policy if exists "read own or admin partner announcements" on public.partner_announcements;
create policy "read own or admin partner announcements" on public.partner_announcements
  for select to authenticated using (
    public.is_partner_member(institution_id)
    or public.has_role('super_admin')
    or public.has_role('content_admin')
    or public.has_role('moderator')
  );

drop policy if exists "partners create announcements" on public.partner_announcements;
create policy "partners create announcements" on public.partner_announcements
  for insert to authenticated with check (
    author_id = auth.uid()
    and status = 'pending'
    and admin_note is null
    and published_at is null
    and reviewed_at is null
    and reviewed_by is null
    and public.is_partner_member(institution_id)
    and public.is_verified_partner(institution_id)
  );

drop policy if exists "partners update pending announcements" on public.partner_announcements;
create policy "partners update pending announcements" on public.partner_announcements
  for update to authenticated
  using (
    author_id = auth.uid()
    and status = 'pending'
    and public.is_partner_member(institution_id)
    and public.is_verified_partner(institution_id)
  )
  with check (
    author_id = auth.uid()
    and status = 'pending'
    and admin_note is null
    and published_at is null
    and reviewed_at is null
    and reviewed_by is null
    and public.is_partner_member(institution_id)
    and public.is_verified_partner(institution_id)
  );

drop policy if exists "admins update partner announcements" on public.partner_announcements;
create policy "admins update partner announcements" on public.partner_announcements
  for update to authenticated
  using (public.has_role('super_admin') or public.has_role('content_admin'))
  with check (public.has_role('super_admin') or public.has_role('content_admin'));

create or replace function public.guard_partner_announcement_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and auth.uid() = old.author_id
     and not public.has_role('super_admin')
     and not public.has_role('content_admin') then
    new.institution_id := old.institution_id;
    new.author_id := old.author_id;
    new.status := 'pending';
    new.admin_note := null;
    new.published_at := null;
    new.reviewed_at := null;
    new.reviewed_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists partner_announcements_guard_update on public.partner_announcements;
create trigger partner_announcements_guard_update
  before update on public.partner_announcements
  for each row execute function public.guard_partner_announcement_update();

drop trigger if exists partner_announcements_set_updated_at on public.partner_announcements;
create trigger partner_announcements_set_updated_at
  before update on public.partner_announcements
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Alumni profiles
-- ---------------------------------------------------------------------------
create table if not exists public.alumni_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  institution_id bigint references public.institutions(id) on delete set null,
  institution_name text not null check (char_length(institution_name) between 2 and 160),
  graduation_year int not null check (graduation_year between 1950 and 2100),
  faculty text check (faculty is null or char_length(faculty) <= 160),
  department text check (department is null or char_length(department) <= 160),
  programme text check (programme is null or char_length(programme) <= 160),
  current_role text check (current_role is null or char_length(current_role) <= 160),
  current_organisation text check (
    current_organisation is null or char_length(current_organisation) <= 160
  ),
  industry text check (industry is null or char_length(industry) <= 120),
  location text check (location is null or char_length(location) <= 120),
  bio text not null check (char_length(bio) between 20 and 2000),
  help_areas text[] not null default '{}'::text[]
    check (coalesce(array_length(help_areas, 1), 0) <= 8),
  open_to_mentoring boolean not null default false,
  open_to_referrals boolean not null default false,
  verification_method text not null
    check (verification_method in ('institutional_email', 'alumni_id', 'other')),
  verification_detail text check (
    verification_detail is null or char_length(verification_detail) <= 300
  ),
  listed boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'rejected', 'paused')),
  verified_at timestamptz,
  verified_by uuid references public.profiles(id) on delete set null,
  admin_note text check (admin_note is null or char_length(admin_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists alumni_profiles_status_idx
  on public.alumni_profiles (status, updated_at desc);
create index if not exists alumni_profiles_institution_idx
  on public.alumni_profiles (institution_id, graduation_year desc)
  where status = 'verified' and listed = true;
create index if not exists alumni_profiles_flags_idx
  on public.alumni_profiles (open_to_mentoring, open_to_referrals)
  where status = 'verified' and listed = true;

alter table public.alumni_profiles enable row level security;
revoke all on public.alumni_profiles from anon, authenticated;
grant select, insert, update on public.alumni_profiles to authenticated;

drop policy if exists "read own alumni profile" on public.alumni_profiles;
create policy "read own alumni profile" on public.alumni_profiles
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "admins read alumni profiles" on public.alumni_profiles;
create policy "admins read alumni profiles" on public.alumni_profiles
  for select to authenticated using (
    public.has_role('super_admin')
    or public.has_role('content_admin')
    or public.has_role('moderator')
  );

drop policy if exists "apply own alumni profile" on public.alumni_profiles;
create policy "apply own alumni profile" on public.alumni_profiles
  for insert to authenticated with check (
    user_id = auth.uid()
    and status = 'pending'
    and verified_at is null
    and verified_by is null
    and admin_note is null
  );

drop policy if exists "update own alumni application" on public.alumni_profiles;
create policy "update own alumni application" on public.alumni_profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and status = 'pending'
    and verified_at is null
    and verified_by is null
    and admin_note is null
  );

drop policy if exists "admins update alumni profiles" on public.alumni_profiles;
create policy "admins update alumni profiles" on public.alumni_profiles
  for update to authenticated
  using (public.has_role('super_admin') or public.has_role('content_admin'))
  with check (public.has_role('super_admin') or public.has_role('content_admin'));

create or replace function public.guard_alumni_profile_update()
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
end;
$$;

drop trigger if exists alumni_profiles_guard_update on public.alumni_profiles;
create trigger alumni_profiles_guard_update
  before update on public.alumni_profiles
  for each row execute function public.guard_alumni_profile_update();

drop trigger if exists alumni_profiles_set_updated_at on public.alumni_profiles;
create trigger alumni_profiles_set_updated_at
  before update on public.alumni_profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Recruitment opportunities (verified partners only)
-- ---------------------------------------------------------------------------
create table if not exists public.recruitment_opportunities (
  id bigint generated always as identity primary key,
  institution_id bigint not null references public.institution_partners(institution_id) on delete cascade,
  posted_by uuid references public.profiles(id) on delete set null,
  title text not null check (char_length(title) between 3 and 160),
  organisation text not null check (char_length(organisation) between 2 and 160),
  description text not null check (char_length(description) between 20 and 5000),
  location text check (location is null or char_length(location) <= 160),
  work_mode text not null default 'onsite'
    check (work_mode in ('onsite', 'hybrid', 'remote')),
  role_type text not null
    check (role_type in ('internship', 'graduate', 'job', 'volunteer')),
  eligibility text check (eligibility is null or char_length(eligibility) <= 2000),
  deadline date,
  application_url text not null check (application_url ~ '^https?://'),
  source_url text check (source_url is null or source_url ~ '^https?://'),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'closed')),
  admin_note text check (admin_note is null or char_length(admin_note) <= 500),
  published_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recruitment_opportunities_status_idx
  on public.recruitment_opportunities (status, updated_at desc);
create index if not exists recruitment_opportunities_institution_idx
  on public.recruitment_opportunities (institution_id, created_at desc);
create index if not exists recruitment_opportunities_public_idx
  on public.recruitment_opportunities (institution_id, published_at desc)
  where status = 'approved';
create index if not exists recruitment_opportunities_role_idx
  on public.recruitment_opportunities (role_type, work_mode)
  where status = 'approved';

alter table public.recruitment_opportunities enable row level security;
revoke all on public.recruitment_opportunities from anon, authenticated;
grant select, insert, update on public.recruitment_opportunities to authenticated;

drop policy if exists "read own or admin opportunities" on public.recruitment_opportunities;
create policy "read own or admin opportunities" on public.recruitment_opportunities
  for select to authenticated using (
    public.is_partner_member(institution_id)
    or public.has_role('super_admin')
    or public.has_role('content_admin')
    or public.has_role('moderator')
  );

drop policy if exists "partners create opportunities" on public.recruitment_opportunities;
create policy "partners create opportunities" on public.recruitment_opportunities
  for insert to authenticated with check (
    posted_by = auth.uid()
    and status = 'pending'
    and admin_note is null
    and published_at is null
    and reviewed_at is null
    and reviewed_by is null
    and public.is_partner_member(institution_id)
    and public.is_verified_partner(institution_id)
  );

drop policy if exists "partners update pending opportunities" on public.recruitment_opportunities;
create policy "partners update pending opportunities" on public.recruitment_opportunities
  for update to authenticated
  using (
    posted_by = auth.uid()
    and status = 'pending'
    and public.is_partner_member(institution_id)
    and public.is_verified_partner(institution_id)
  )
  with check (
    posted_by = auth.uid()
    and status = 'pending'
    and admin_note is null
    and published_at is null
    and reviewed_at is null
    and reviewed_by is null
    and public.is_partner_member(institution_id)
    and public.is_verified_partner(institution_id)
  );

drop policy if exists "admins update opportunities" on public.recruitment_opportunities;
create policy "admins update opportunities" on public.recruitment_opportunities
  for update to authenticated
  using (public.has_role('super_admin') or public.has_role('content_admin'))
  with check (public.has_role('super_admin') or public.has_role('content_admin'));

create or replace function public.guard_recruitment_opportunity_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and auth.uid() = old.posted_by
     and not public.has_role('super_admin')
     and not public.has_role('content_admin') then
    new.institution_id := old.institution_id;
    new.posted_by := old.posted_by;
    new.status := 'pending';
    new.admin_note := null;
    new.published_at := null;
    new.reviewed_at := null;
    new.reviewed_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists recruitment_opportunities_guard_update on public.recruitment_opportunities;
create trigger recruitment_opportunities_guard_update
  before update on public.recruitment_opportunities
  for each row execute function public.guard_recruitment_opportunity_update();

drop trigger if exists recruitment_opportunities_set_updated_at on public.recruitment_opportunities;
create trigger recruitment_opportunities_set_updated_at
  before update on public.recruitment_opportunities
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Public views (verified and listed only; no private evidence)
-- ---------------------------------------------------------------------------
create or replace view public.institution_partner_directory
with (security_invoker = false) as
select
  p.institution_id,
  i.name as institution_name,
  i.location,
  i.ownership,
  i.kind,
  p.public_summary,
  p.official_url,
  p.verified_at,
  p.updated_at
from public.institution_partners p
join public.institutions i on i.id = p.institution_id
where p.status = 'verified'
  and p.listed = true;

revoke all on public.institution_partner_directory from anon, authenticated;
grant select on public.institution_partner_directory to anon, authenticated;

create or replace view public.partner_announcement_directory
with (security_invoker = false) as
select
  a.id,
  a.institution_id,
  i.name as institution_name,
  a.title,
  a.body,
  a.category,
  a.link_url,
  a.published_at,
  a.expires_at,
  a.updated_at,
  p.verified_at as partner_verified_at
from public.partner_announcements a
join public.institution_partners p on p.institution_id = a.institution_id
join public.institutions i on i.id = a.institution_id
where a.status = 'approved'
  and a.published_at is not null
  and (a.expires_at is null or a.expires_at > now())
  and p.status = 'verified'
  and p.listed = true;

revoke all on public.partner_announcement_directory from anon, authenticated;
grant select on public.partner_announcement_directory to anon, authenticated;

create or replace view public.alumni_directory
with (security_invoker = false) as
select
  a.user_id,
  p.name,
  p.photo_url,
  p.user_type,
  a.institution_id,
  a.institution_name,
  a.graduation_year,
  a.faculty,
  a.department,
  a.programme,
  a.current_role,
  a.current_organisation,
  a.industry,
  a.location,
  a.bio,
  a.help_areas,
  a.open_to_mentoring,
  a.open_to_referrals,
  a.verified_at,
  a.updated_at,
  i.location as institution_location,
  i.ownership,
  i.kind
from public.alumni_profiles a
join public.profiles p on p.id = a.user_id
left join public.institutions i on i.id = a.institution_id
where a.status = 'verified'
  and a.listed = true
  and coalesce(p.visibility, 'public') <> 'private';

revoke all on public.alumni_directory from anon, authenticated;
grant select on public.alumni_directory to anon, authenticated;

create or replace view public.recruitment_opportunity_directory
with (security_invoker = false) as
select
  o.id,
  o.institution_id,
  i.name as institution_name,
  o.title,
  o.organisation,
  o.description,
  o.location,
  o.work_mode,
  o.role_type,
  o.eligibility,
  o.deadline,
  o.application_url,
  o.published_at,
  o.updated_at,
  p.verified_at as partner_verified_at
from public.recruitment_opportunities o
join public.institution_partners p on p.institution_id = o.institution_id
join public.institutions i on i.id = o.institution_id
where o.status = 'approved'
  and o.published_at is not null
  and (o.deadline is null or o.deadline >= current_date)
  and p.status = 'verified'
  and p.listed = true;

revoke all on public.recruitment_opportunity_directory from anon, authenticated;
grant select on public.recruitment_opportunity_directory to anon, authenticated;

-- Verify after running:
--   select count(*) from public.institution_partners;             -- starts at 0
--   select count(*) from public.institution_partner_members;      -- starts at 0
--   select count(*) from public.partner_announcements;            -- starts at 0
--   select count(*) from public.alumni_profiles;                  -- starts at 0
--   select count(*) from public.recruitment_opportunities;        -- starts at 0
--   select column_name from information_schema.columns
--     where table_schema = 'public'
--       and table_name in ('institution_partner_directory',
--                          'partner_announcement_directory',
--                          'alumni_directory',
--                          'recruitment_opportunity_directory')
--     order by table_name, ordinal_position;
--   select tablename, policyname, cmd from pg_policies
--     where schemaname = 'public'
--       and tablename in ('institution_partners', 'institution_partner_members',
--                         'partner_announcements', 'alumni_profiles',
--                         'recruitment_opportunities')
--     order by tablename, policyname;
--   select relrowsecurity from pg_class
--     where oid in ('public.institution_partners'::regclass,
--                   'public.institution_partner_members'::regclass,
--                   'public.partner_announcements'::regclass,
--                   'public.alumni_profiles'::regclass,
--                   'public.recruitment_opportunities'::regclass);
