-- Fidonect Phase 1: Scholarships
-- Additive and idempotent. Run after 20261114_phase0_security.sql.
-- No scholarship rows are seeded: content must be entered/verified by an admin.

create table if not exists public.scholarships (
  id bigint generated always as identity primary key,
  slug text not null unique,
  title text not null check (char_length(title) between 3 and 200),
  organisation text not null check (char_length(organisation) between 2 and 160),
  country text not null check (char_length(country) between 2 and 80),
  academic_level text not null check (char_length(academic_level) between 2 and 80),
  funding_type text not null check (char_length(funding_type) between 2 and 80),
  description text,
  eligibility text,
  required_documents text,
  deadline date,
  official_url text not null check (official_url ~ '^https?://'),
  verified boolean not null default false,
  verified_at timestamptz,
  verified_by uuid references public.profiles(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (
    to_tsvector('english',
      coalesce(title, '') || ' ' || coalesce(organisation, '') || ' ' ||
      coalesce(country, '') || ' ' || coalesce(description, ''))
  ) stored
);

create table if not exists public.scholarship_bookmarks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  scholarship_id bigint not null references public.scholarships(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, scholarship_id)
);

create index if not exists scholarships_status_idx on public.scholarships (status, published_at desc);
create index if not exists scholarships_deadline_idx on public.scholarships (deadline) where status = 'published';
create index if not exists scholarships_country_idx on public.scholarships (country);
create index if not exists scholarships_level_idx on public.scholarships (academic_level);
create index if not exists scholarships_funding_idx on public.scholarships (funding_type);
create index if not exists scholarships_verified_idx on public.scholarships (verified) where status = 'published';
create index if not exists scholarships_search_idx on public.scholarships using gin (search);
create index if not exists scholarship_bookmarks_user_idx on public.scholarship_bookmarks (user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scholarships_set_updated_at on public.scholarships;
create trigger scholarships_set_updated_at
  before update on public.scholarships
  for each row execute function public.set_updated_at();

alter table public.scholarships enable row level security;
alter table public.scholarship_bookmarks enable row level security;

grant select on public.scholarships to anon, authenticated;
grant select, insert, delete on public.scholarship_bookmarks to authenticated;
revoke all on public.scholarship_bookmarks from anon;

drop policy if exists "read published scholarships" on public.scholarships;
create policy "read published scholarships" on public.scholarships
  for select to anon, authenticated
  using (status = 'published' and (published_at is null or published_at <= now()));

drop policy if exists "admins read scholarships" on public.scholarships;
create policy "admins read scholarships" on public.scholarships
  for select to authenticated using (
    public.has_role('super_admin') or public.has_role('content_admin')
  );

drop policy if exists "admins insert scholarships" on public.scholarships;
create policy "admins insert scholarships" on public.scholarships
  for insert to authenticated with check (
    public.has_role('super_admin') or public.has_role('content_admin')
  );

drop policy if exists "admins update scholarships" on public.scholarships;
create policy "admins update scholarships" on public.scholarships
  for update to authenticated
  using (public.has_role('super_admin') or public.has_role('content_admin'))
  with check (public.has_role('super_admin') or public.has_role('content_admin'));

drop policy if exists "admins delete scholarships" on public.scholarships;
create policy "admins delete scholarships" on public.scholarships
  for delete to authenticated using (public.has_role('super_admin'));

drop policy if exists "read own scholarship bookmarks" on public.scholarship_bookmarks;
create policy "read own scholarship bookmarks" on public.scholarship_bookmarks
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "add own scholarship bookmarks" on public.scholarship_bookmarks;
create policy "add own scholarship bookmarks" on public.scholarship_bookmarks
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "remove own scholarship bookmarks" on public.scholarship_bookmarks;
create policy "remove own scholarship bookmarks" on public.scholarship_bookmarks
  for delete to authenticated using (user_id = auth.uid());

-- Verify after running:
-- select policyname, cmd, roles from pg_policies where tablename = 'scholarships';
-- select count(*) from public.scholarships;
