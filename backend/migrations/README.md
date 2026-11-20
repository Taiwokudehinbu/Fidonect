# Fidonect database migrations

These files are additive and idempotent. They do **not** delete user data,
drop tables, reseed institutions, or change the official production URL.

> Do not re-run the older `backend/supabase-phase1.sql` after this migration:
> it used to create a broad profile-read policy. That policy is now safe
> (own-row only), but this migration remains the source of truth for profile
> visibility and the `visible_profiles` view.
>
> Run the files in the order below. Do not re-run Phase 2 after Phase 3A: Phase 2
> replaces `open_conversation()` with the older two-gate version. If an older
> migration is re-run, re-run Phase 3A afterward to restore the listing-request
> messaging gate. Phase 3A is discovery-only — it does not add bookings,
> reservations, payments, or marketplace transactions.

## Order (run in Supabase SQL Editor, one file at a time)

1. **Take a backup first.** See `scripts/backup-supabase.mjs` and the runbook below.
2. `20261114_phase0_security.sql`
   - creates `user_roles`, `has_role()`, `admin_audit_log`
   - creates the privacy-safe `visible_profiles` view
   - replaces the broad `profiles` SELECT policy
   - removes direct conversation/participant inserts
   - scopes avatar uploads to `avatars/<your-user-id>/...`
   - adds indexes and admin moderation policies
3. `20261114_phase1_scholarships.sql`
   - creates `scholarships` and `scholarship_bookmarks`
   - adds RLS, indexes, updated-at trigger
   - grants public read only to published rows
4. `20261116_phase2_mentorship_hubs_fido.sql`
   - creates `mentor_profiles`, `mentor_requests`, `fido_feedback`
   - creates the filtered public `mentor_directory` view
   - adds richer, source-attributed and verifiable `hub_pages` columns
   - extends `open_conversation()` so an accepted mentorship request also
     unlocks private messaging
   - keeps all mentor/hub content empty or unverified until an admin acts
5. `20261118_phase3_accommodation_services.sql`
   - creates `campus_listings` and `listing_requests`
   - creates the filtered public `campus_listing_directory` view
   - adds admin approval and optional source verification for accommodation
     and campus-service listings
   - extends `open_conversation()` so an accepted listing request also unlocks
     private messaging
   - is discovery-only: no bookings, reservations, payments, or marketplace
     transactions
6. Seed the first admin role using `20261114_seed_admin_role.example.sql`
   (copy it, replace the placeholder email, run it once).

## Backup runbook

The migration files are safe to preview, but a verified backup is still
required before a production schema change. Use one of these:

### Option A — service-role export (recommended, no DB password)

Set `SUPABASE_SERVICE_ROLE_KEY` locally in `backend/.env` (never commit it),
then run:

```sh
node scripts/backup-supabase.mjs
```

It writes JSON exports and downloaded avatar objects under
`backups/supabase-<timestamp>/`. Keep that folder off the repo/cloud until the
migration is verified.

### Option B — direct database dump

If you have the pooler connection string, set `DATABASE_URL` locally and run
`pg_dump` (Supabase dashboard > Project Settings > Database > Connection
string). Do not paste the URL into chat or a commit.

### Option C — dashboard backup

Supabase dashboard > Database > Backups. Availability depends on the plan.

## Verification after migration

```sql
-- broad profile read must be gone
select policyname, cmd, qual from pg_policies
where schemaname = 'public' and tablename = 'profiles';

-- privacy-safe view should exist and expose no email column
select * from public.visible_profiles limit 1;

-- direct messaging writes must be revoked
select has_table_privilege('authenticated', 'public.participants', 'INSERT') as participants_insert;
select has_table_privilege('authenticated', 'public.conversations', 'INSERT') as conversations_insert;

-- no avatar write policy should allow a bare bucket match; every write policy
-- must include the storage.foldername(name) = auth.uid() check
select policyname, cmd, with_check from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname ilike '%avatar%'
order by policyname, cmd;

-- scholarships should exist and be empty until an admin adds verified content
select count(*) from public.scholarships;

-- Phase 2 tables start empty; existing hub rows must start unverified
select count(*) from public.mentor_profiles;
select count(*) from public.mentor_requests;
select count(*) from public.fido_feedback;
select count(*) from public.hub_pages where verified;

-- public mentor view must expose no email or private evidence
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'mentor_directory'
order by ordinal_position;

-- Phase 2 policies should exist on all four surfaces
select tablename, policyname, cmd from pg_policies
where schemaname = 'public'
  and tablename in ('mentor_profiles', 'mentor_requests', 'hub_pages', 'fido_feedback')
order by tablename, policyname;

-- Phase 2 guard triggers/functions must exist
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('is_verified_mentor','guard_mentor_profile_update',
                  'lock_mentor_request_participants','open_conversation')
order by proname;

select event_object_table, trigger_name
from information_schema.triggers
where trigger_schema = 'public'
  and event_object_table in ('mentor_profiles','mentor_requests','hub_pages')
order by event_object_table, trigger_name;

-- Phase 3 tables start empty; no placeholder listings are seeded
select count(*) from public.campus_listings;
select count(*) from public.listing_requests;
select count(*) from public.campus_listing_directory;

-- Public listing view must expose no email, source URL, admin note, or phone
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'campus_listing_directory'
order by ordinal_position;

-- Phase 3 policies and helper objects
select tablename, policyname, cmd from pg_policies
where schemaname = 'public'
  and tablename in ('campus_listings', 'listing_requests')
order by tablename, policyname;

select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('guard_campus_listing_update',
                  'lock_listing_request_participants',
                  'public_listing_owner', 'open_conversation')
order by proname;

select event_object_table, trigger_name
from information_schema.triggers
where trigger_schema = 'public'
  and event_object_table in ('campus_listings','listing_requests')
order by event_object_table, trigger_name;

-- Phase 3 least privilege: anon reads only the filtered view; authenticated
-- users can insert/update through RLS but cannot delete or truncate.
select
  has_table_privilege('anon', 'public.campus_listings', 'SELECT') as anon_table_read,
  has_table_privilege('anon', 'public.campus_listing_directory', 'SELECT') as anon_view_read,
  has_table_privilege('authenticated', 'public.campus_listings', 'INSERT') as auth_insert,
  has_table_privilege('authenticated', 'public.campus_listings', 'UPDATE') as auth_update,
  has_table_privilege('authenticated', 'public.campus_listings', 'DELETE') as auth_delete,
  has_table_privilege('authenticated', 'public.campus_listings', 'TRUNCATE') as auth_truncate;
```

Then:
- Log in as the seeded admin and open `/admin` to manage scholarships, mentor
  verification, institution information, and Fido feedback.
- Open `/scholarships` and `/mentors` and confirm honest empty states before
  adding content.
- Verify login, profile photo upload, connections, messages, mentor request
  acceptance/messaging, and the 588-institution directory still work.
- Confirm Fido labels hub content `Community` until an admin marks that hub
  verified, and that sources appear when an official URL exists.

## Rollback

The migrations only add objects/policies. To roll back the tightest policy
without touching data, re-create the previous broad profile policy **only while
you investigate**, then remove it again:

```sql
-- Emergency only: re-opens profile emails to every authenticated user.
-- create policy "read profiles" on public.profiles for select to authenticated using (true);
```

Do not drop the new tables/columns to roll back; they are additive and harmless.
To hide Phase 2 mentor listings without losing applications, set
`mentor_profiles.status = 'paused'` (or `listed = false`) instead of deleting rows.
