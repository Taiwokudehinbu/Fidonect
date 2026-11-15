# Fidonect database migrations

These files are additive and idempotent. They do **not** delete user data,
drop tables, reseed institutions, or change the official production URL.

> Do not re-run the older `backend/supabase-phase1.sql` after this migration:
> it used to create a broad profile-read policy. That policy is now safe
> (own-row only), but this migration remains the source of truth for profile
> visibility and the `visible_profiles` view.

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
4. Seed the first admin role using `20261114_seed_admin_role.example.sql`
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

-- scholarships should exist and be empty until an admin adds verified content
select count(*) from public.scholarships;
```

Then:
- Log in as the seeded admin and open `/admin` to manage scholarships.
- Open `/scholarships` and confirm the empty state (not a crash) before adding content.
- Verify login, profile photo upload, connections, messages, and the 588-institution directory still work.

## Rollback

The migrations only add objects/policies. To roll back the tightest policy
without touching data, re-create the previous broad profile policy **only while
you investigate**, then remove it again:

```sql
-- Emergency only: re-opens profile emails to every authenticated user.
-- create policy "read profiles" on public.profiles for select to authenticated using (true);
```

Do not drop the new tables/columns to roll back; they are additive and harmless.
