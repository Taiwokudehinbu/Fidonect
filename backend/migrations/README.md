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
> reservations, payments, or marketplace transactions. Phase 4A adds institution
> partners, opt-in alumni profiles, and an admin-approved recruitment board. It
> does not add payments, billing, bookings, CV uploads, in-app applications,
> automated screening, partner analytics, or raw student-data access.

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
6. `20261120_phase4_partnerships_alumni_recruitment.sql`
   - creates `institution_partners`, `institution_partner_members`,
     `partner_announcements`, `alumni_profiles`, and `recruitment_opportunities`
   - creates the filtered public views `institution_partner_directory`,
     `partner_announcement_directory`, `alumni_directory`, and
     `recruitment_opportunity_directory`
   - adds admin-only partner onboarding, scoped partner membership, admin
     content review, and opt-in alumni profiles
   - requires verified, listed partners for public partner content and verified,
     listed alumni for public alumni profiles
   - allows external opportunity application links only; no CV uploads,
     in-app applications, payments, billing, bookings, automated screening,
     partner analytics, or raw student-data access
   - every new table starts empty and no existing institution/user data is
     rewritten
7. Seed the first admin role using `20261114_seed_admin_role.example.sql`
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

-- Phase 4A tables start empty; no partners, alumni, announcements, or
-- opportunities are seeded.
select count(*) from public.institution_partners;
select count(*) from public.institution_partner_members;
select count(*) from public.partner_announcements;
select count(*) from public.alumni_profiles;
select count(*) from public.recruitment_opportunities;

-- Public views must expose no email, phone, verification_detail, admin_note,
-- source_url, or CV columns.
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and table_name in ('institution_partner_directory',
                     'partner_announcement_directory',
                     'alumni_directory',
                     'recruitment_opportunity_directory')
  and column_name in ('email', 'phone', 'verification_detail', 'admin_note',
                      'source_url', 'cv_url', 'cv')
order by table_name, column_name;

-- Phase 4A policies and helper objects.
select tablename, policyname, cmd from pg_policies
where schemaname = 'public'
  and tablename in ('institution_partners', 'institution_partner_members',
                    'partner_announcements', 'alumni_profiles',
                    'recruitment_opportunities')
order by tablename, policyname;

select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('is_partner_member', 'is_verified_partner',
                  'guard_partner_announcement_update',
                  'guard_alumni_profile_update',
                  'guard_recruitment_opportunity_update')
order by proname;

select event_object_table, trigger_name
from information_schema.triggers
where trigger_schema = 'public'
  and event_object_table in ('institution_partners',
                             'institution_partner_members',
                             'partner_announcements',
                             'alumni_profiles',
                             'recruitment_opportunities')
order by event_object_table, trigger_name;

-- Phase 4A least privilege: anon reads only the filtered public views;
-- authenticated users can insert/update through RLS but cannot delete or
-- truncate partner, alumni, or opportunity records.
select
  has_table_privilege('anon', 'public.institution_partners', 'SELECT') as anon_partner_table_read,
  has_table_privilege('anon', 'public.institution_partner_directory', 'SELECT') as anon_partner_view_read,
  has_table_privilege('anon', 'public.alumni_profiles', 'SELECT') as anon_alumni_table_read,
  has_table_privilege('anon', 'public.alumni_directory', 'SELECT') as anon_alumni_view_read,
  has_table_privilege('authenticated', 'public.institution_partners', 'DELETE') as auth_partner_delete,
  has_table_privilege('authenticated', 'public.alumni_profiles', 'DELETE') as auth_alumni_delete,
  has_table_privilege('authenticated', 'public.recruitment_opportunities', 'TRUNCATE') as auth_opportunity_truncate;
```

### Phase 4A rolled-back flow test

After the verification queries pass, run
`backend/migrations/tests/phase4_rollback_test.sql` in the Supabase SQL Editor
(as the `postgres` role). It opens a transaction, exercises partner
self-verification, partner content submission, self-approval reset, alumni
self-verification reset, admin approval, public-view visibility, RLS, and
least-privilege grants, then ends with `ROLLBACK`.

The script picks unused existing rows, inserts test rows only inside the
transaction, and leaves no data behind. If an assertion fails, the transaction
aborts and rolls back automatically. Do not remove the final `ROLLBACK` and do
not run the file as part of the migration order.

Then:
- Log in as the seeded admin and open `/admin` to manage scholarships, mentor
  verification, institution information, Fido feedback, housing/services,
  partners, partner announcements, alumni, and opportunities.
- Open `/scholarships`, `/mentors`, `/housing`, `/partners`, `/alumni`, and
  `/opportunities` and confirm honest empty states before adding content.
- Verify login, profile photo upload, connections, messages, mentor request
  acceptance/messaging, and the 588-institution directory still work.
- Confirm Fido labels hub content `Community` until an admin marks that hub
  verified, and that sources appear when an official URL exists.
- Confirm Phase 4A starts empty. Create a test partner only after confirming the
  institution relationship, attach a test partner member by account email,
  submit a partner announcement, confirm it is not public while pending, approve
  it as an admin, and confirm it appears on `/partners`. Then revoke or pause the
  test partner and confirm it disappears from public views.
- Submit an alumni application, confirm it is private while pending and that a
  self-edit resets it to pending, verify it as an admin, opt in to listing, and
  confirm the public card exposes no email, verification evidence, or admin note.
- Submit an opportunity as a verified partner member, confirm a pending record
  is not public, approve it as an admin, and confirm the public card links to the
  official external application page. Confirm a non-partner cannot submit one.

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
To hide Phase 4A partner, announcement, alumni, or opportunity content without
losing review history, set `status = 'paused'` or `listed = false` on the relevant
row instead of deleting it. Revoke partner members (`status = 'revoked'`) rather
than deleting their membership when access must be withdrawn.
