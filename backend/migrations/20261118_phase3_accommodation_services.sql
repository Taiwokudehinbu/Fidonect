-- Fidonect Phase 3A: accommodation + campus-service discovery.
-- Additive and idempotent. Run after the Phase 0, Phase 1, and Phase 2
-- migrations.
--
-- Scope:
--   * community-submitted accommodation and service listings
--   * admin approval before a listing is public
--   * "verified" means an admin checked the source, never a self-claim
--   * contact happens through an in-app request; accepted requests unlock
--     private messaging
--   * no bookings, reservations, payments, or marketplace transactions
--
-- Safety:
--   * no table, column, user, institution, connection, message or post is dropped
--   * no rows are deleted and no institution data is reseeded
--   * public reads go through a filtered view that never exposes owner email,
--     exact private addresses, phone numbers, or admin evidence

-- ---------------------------------------------------------------------------
-- 1. Campus listings (accommodation and services)
-- ---------------------------------------------------------------------------
create table if not exists public.campus_listings (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('accommodation', 'service')),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  institution_id bigint references public.institutions(id) on delete set null,
  institution_name text not null check (char_length(institution_name) between 2 and 160),
  title text not null check (char_length(title) between 3 and 120),
  description text not null check (char_length(description) between 20 and 2000),
  area text check (area is null or char_length(area) <= 120),
  -- Free text only. Fidonect does not process, collect, or guarantee payments.
  price_text text check (price_text is null or char_length(price_text) <= 120),
  price_period text check (
    price_period is null or price_period in ('year', 'month', 'semester', 'one-off', 'negotiable')
  ),
  distance_text text check (distance_text is null or char_length(distance_text) <= 120),
  amenities text[] not null default '{}'::text[]
    check (coalesce(array_length(amenities, 1), 0) <= 12),
  available_from date,
  -- Community submissions are labelled Community until an admin verifies the
  -- source. The source URL is admin evidence and is never exposed publicly.
  source text not null default 'Community' check (char_length(source) between 2 and 120),
  source_url text check (source_url is null or source_url ~ '^https?://'),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'paused')),
  verified boolean not null default false,
  verified_at timestamptz,
  verified_by uuid references public.profiles(id) on delete set null,
  admin_note text check (admin_note is null or char_length(admin_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campus_listings_status_idx
  on public.campus_listings (status, updated_at desc);
create index if not exists campus_listings_kind_idx
  on public.campus_listings (kind, status, updated_at desc);
create index if not exists campus_listings_institution_idx
  on public.campus_listings (institution_id, status)
  where status = 'approved';
create index if not exists campus_listings_owner_idx
  on public.campus_listings (owner_id, updated_at desc);

alter table public.campus_listings enable row level security;
revoke all on public.campus_listings from anon;
grant select, insert, update on public.campus_listings to authenticated;

drop policy if exists "read own campus listings" on public.campus_listings;
create policy "read own campus listings" on public.campus_listings
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists "admins read campus listings" on public.campus_listings;
create policy "admins read campus listings" on public.campus_listings
  for select to authenticated using (
    public.has_role('super_admin') or public.has_role('content_admin') or public.has_role('moderator')
  );

drop policy if exists "create own campus listing" on public.campus_listings;
create policy "create own campus listing" on public.campus_listings
  for insert to authenticated with check (
    owner_id = auth.uid()
    and status = 'pending'
    and verified = false
    and verified_at is null
    and verified_by is null
    and source = 'Community'
  );

-- A user edit always returns the listing to admin review. The trigger below
-- also clears admin-only fields if a client bypasses the API.
drop policy if exists "update own campus listing" on public.campus_listings;
create policy "update own campus listing" on public.campus_listings
  for update to authenticated
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and status = 'pending'
    and verified = false
    and verified_at is null
    and verified_by is null
    and source = 'Community'
  );

drop policy if exists "admins update campus listings" on public.campus_listings;
create policy "admins update campus listings" on public.campus_listings
  for update to authenticated
  using (public.has_role('super_admin') or public.has_role('content_admin'))
  with check (public.has_role('super_admin') or public.has_role('content_admin'));

drop policy if exists "admins delete campus listings" on public.campus_listings;
create policy "admins delete campus listings" on public.campus_listings
  for delete to authenticated using (public.has_role('super_admin'));

create or replace function public.guard_campus_listing_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and auth.uid() = old.owner_id
     and not public.has_role('super_admin')
     and not public.has_role('content_admin') then
    new.owner_id := old.owner_id;
    new.status := 'pending';
    new.verified := false;
    new.verified_at := null;
    new.verified_by := null;
    new.admin_note := null;
    new.source := 'Community';
  end if;
  return new;
end $$;

drop trigger if exists campus_listings_guard_update on public.campus_listings;
create trigger campus_listings_guard_update
  before update on public.campus_listings
  for each row execute function public.guard_campus_listing_update();

drop trigger if exists campus_listings_set_updated_at on public.campus_listings;
create trigger campus_listings_set_updated_at
  before update on public.campus_listings
  for each row execute function public.set_updated_at();

-- Public directory view. It exposes no email, private address, phone number,
-- source URL, admin note, or verification evidence. Only admin-approved
-- listings from non-private profiles are visible.
create or replace view public.campus_listing_directory
with (security_invoker = false) as
select
  l.id,
  l.kind,
  l.owner_id,
  p.name as owner_name,
  p.photo_url as owner_photo_url,
  p.user_type as owner_user_type,
  l.institution_id,
  l.institution_name,
  l.title,
  l.description,
  l.area,
  l.price_text,
  l.price_period,
  l.distance_text,
  l.amenities,
  l.available_from,
  l.source,
  l.verified,
  l.verified_at,
  l.updated_at,
  i.location as institution_location,
  i.ownership,
  i.kind as institution_kind
from public.campus_listings l
join public.profiles p on p.id = l.owner_id
left join public.institutions i on i.id = l.institution_id
where l.status = 'approved'
  and coalesce(p.visibility, 'public') <> 'private';

revoke all on public.campus_listing_directory from anon;
grant select on public.campus_listing_directory to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Listing requests (student -> listing owner)
-- ---------------------------------------------------------------------------
create table if not exists public.listing_requests (
  id bigint generated always as identity primary key,
  listing_id bigint not null references public.campus_listings(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  message text not null check (char_length(message) between 10 and 1000),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled', 'completed')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> owner_id)
);

create index if not exists listing_requests_requester_idx
  on public.listing_requests (requester_id, created_at desc);
create index if not exists listing_requests_owner_idx
  on public.listing_requests (owner_id, created_at desc);
create unique index if not exists listing_requests_one_pending_idx
  on public.listing_requests (requester_id, listing_id) where status = 'pending';

-- Returns the owner only for a public, approved listing from a non-private
-- profile. Direct PostgREST inserts cannot target hidden or unapproved rows.
create or replace function public.public_listing_owner(lid bigint)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select l.owner_id
  from public.campus_listings l
  join public.profiles p on p.id = l.owner_id
  where l.id = lid
    and l.status = 'approved'
    and coalesce(p.visibility, 'public') <> 'private'
  limit 1;
$$;
revoke all on function public.public_listing_owner(bigint) from public;
revoke all on function public.public_listing_owner(bigint) from anon;
grant execute on function public.public_listing_owner(bigint) to authenticated, service_role;

alter table public.listing_requests enable row level security;
revoke all on public.listing_requests from anon;
grant select, insert, update on public.listing_requests to authenticated;

drop policy if exists "read own listing requests" on public.listing_requests;
create policy "read own listing requests" on public.listing_requests
  for select to authenticated using (
    requester_id = auth.uid() or owner_id = auth.uid()
  );

drop policy if exists "admins read listing requests" on public.listing_requests;
create policy "admins read listing requests" on public.listing_requests
  for select to authenticated using (
    public.has_role('super_admin') or public.has_role('content_admin') or public.has_role('moderator')
  );

drop policy if exists "create own listing request" on public.listing_requests;
create policy "create own listing request" on public.listing_requests
  for insert to authenticated with check (
    requester_id = auth.uid()
    and status = 'pending'
    and requester_id <> owner_id
    and owner_id = public.public_listing_owner(listing_id)
  );

drop policy if exists "owner responds to listing request" on public.listing_requests;
create policy "owner responds to listing request" on public.listing_requests
  for update to authenticated
  using (owner_id = auth.uid() and status = 'pending')
  with check (owner_id = auth.uid() and status in ('accepted', 'declined'));

drop policy if exists "requester cancels listing request" on public.listing_requests;
create policy "requester cancels listing request" on public.listing_requests
  for update to authenticated
  using (requester_id = auth.uid() and status = 'pending')
  with check (requester_id = auth.uid() and status = 'cancelled');

drop policy if exists "participants complete listing request" on public.listing_requests;
create policy "participants complete listing request" on public.listing_requests
  for update to authenticated
  using (
    status = 'accepted' and (requester_id = auth.uid() or owner_id = auth.uid())
  )
  with check (
    status in ('accepted', 'completed') and (requester_id = auth.uid() or owner_id = auth.uid())
  );

-- The listing and both participants are immutable. Without this, an owner
-- could accept a request and rewrite requester_id to an unrelated user, which
-- would wrongly unlock messaging with that user.
create or replace function public.lock_listing_request_participants()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.listing_id <> old.listing_id
     or new.requester_id <> old.requester_id
     or new.owner_id <> old.owner_id then
    raise exception 'listing request participants cannot be changed';
  end if;
  return new;
end $$;

drop trigger if exists listing_requests_lock_participants on public.listing_requests;
create trigger listing_requests_lock_participants
  before update on public.listing_requests
  for each row execute function public.lock_listing_request_participants();

-- An accepted listing request is also a valid reason to open a private
-- conversation. Replace the Phase 2 helper with the same behaviour plus this
-- additional gate.
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
  ) and not exists (
    select 1 from listing_requests r
    where r.status = 'accepted'
      and ((r.requester_id = me and r.owner_id = other)
        or (r.requester_id = other and r.owner_id = me))
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

-- Verify after running:
--   select count(*) from public.campus_listings;       -- starts at 0
--   select count(*) from public.listing_requests;      -- starts at 0
--   select count(*) from public.campus_listing_directory; -- starts at 0
--   select column_name from information_schema.columns
--     where table_schema = 'public' and table_name = 'campus_listing_directory'
--     order by ordinal_position;
--   select tablename, policyname, cmd from pg_policies
--     where schemaname = 'public'
--       and tablename in ('campus_listings', 'listing_requests')
--     order by tablename, policyname;
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and proname in ('guard_campus_listing_update',
--                       'lock_listing_request_participants',
--                       'public_listing_owner', 'open_conversation')
--     order by proname;
