-- Fidonect Phase 4A — rolled-back database flow test.
--
-- Run this in the Supabase SQL Editor (as the `postgres` role) AFTER applying
-- 20261120_phase4_partnerships_alumni_recruitment.sql.
--
-- The script starts a transaction, uses one existing institution and existing
-- profiles, exercises the partner, alumni, recruitment, and public-view rules,
-- and ends with ROLLBACK. It never keeps test rows, never edits existing rows,
-- and is safe to re-run while an unused institution and profile remain available.
--
-- This is a verification script, not a migration. Do not run it as part of the
-- migration sequence and do not remove the final ROLLBACK.

begin;

-- 1. Pick unused, non-admin real rows so the test is repeatable on a live
-- database. Admin accounts are excluded because they are allowed to verify
-- partners and alumni; the test checks the non-admin member rules.
select
  set_config('p4.partner_user', coalesce((
    select p.id::text
    from public.profiles p
    where not exists (
      select 1 from public.institution_partner_members m where m.user_id = p.id
    )
      and not exists (
        select 1 from public.user_roles ur where ur.user_id = p.id
      )
    order by p.created_at nulls last, p.id
    limit 1
  ), ''), true),
  set_config('p4.alumni_user', coalesce((
    select p.id::text
    from public.profiles p
    where coalesce(p.visibility, 'public') <> 'private'
      and not exists (
        select 1 from public.alumni_profiles a where a.user_id = p.id
      )
      and not exists (
        select 1 from public.user_roles ur where ur.user_id = p.id
      )
    order by p.created_at nulls last, p.id
    limit 1
  ), ''), true),
  set_config('p4.inst', coalesce((
    select i.id::text
    from public.institutions i
    where not exists (
      select 1 from public.institution_partners ip where ip.institution_id = i.id
    )
    order by i.id
    limit 1
  ), ''), true);

select set_config('p4.inst_name', coalesce((
  select i.name
  from public.institutions i
  where i.id = nullif(current_setting('p4.inst', true), '')::bigint
), ''), true);

do $$
begin
  if coalesce(current_setting('p4.partner_user', true), '') = ''
     or coalesce(current_setting('p4.alumni_user', true), '') = ''
     or coalesce(current_setting('p4.inst', true), '') = ''
     or coalesce(current_setting('p4.inst_name', true), '') = '' then
    raise exception 'Phase 4 test needs 1 institution without a partner and non-admin profile(s)';
  end if;
end $$;

-- 2. Admin/service-role action: create a pending partner and attach a member.
insert into public.institution_partners (
  institution_id, status, public_summary, official_url,
  verification_method, listed
) values (
  current_setting('p4.inst')::bigint,
  'pending',
  'Rollback test partner summary used only for Phase 4 database verification.',
  'https://example.edu',
  'official_website',
  false
);

insert into public.institution_partner_members (
  institution_id, user_id, member_role, status
) values (
  current_setting('p4.inst')::bigint,
  current_setting('p4.partner_user')::uuid,
  'owner',
  'active'
);

-- 3. A partner member cannot verify or list their own institution.
select
  set_config('request.jwt.claim.sub', current_setting('p4.partner_user'), true),
  set_config('request.jwt.claims', json_build_object(
    'sub', current_setting('p4.partner_user'),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

update public.institution_partners
set status = 'verified', listed = true
where institution_id = current_setting('p4.inst')::bigint;

do $$
begin
  if not exists (
    select 1
    from public.institution_partners
    where institution_id = current_setting('p4.inst')::bigint
      and status = 'pending'
      and listed = false
  ) then
    raise exception 'RLS allowed a partner member to self-verify or self-list';
  end if;
end $$;

-- 4. Admin/service-role action: verify and list the partner.
reset role;
select
  set_config('request.jwt.claim.sub', '', true),
  set_config('request.jwt.claims', '{}', true);

update public.institution_partners
set status = 'verified', listed = true, verified_at = now()
where institution_id = current_setting('p4.inst')::bigint;

-- 5. A verified partner member can submit pending content only.
select
  set_config('request.jwt.claim.sub', current_setting('p4.partner_user'), true),
  set_config('request.jwt.claims', json_build_object(
    'sub', current_setting('p4.partner_user'),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

insert into public.partner_announcements (
  institution_id, author_id, title, body, category, status
) values (
  current_setting('p4.inst')::bigint,
  auth.uid(),
  'Rollback test announcement',
  'This announcement exists only inside the rolled-back Phase 4 database test.',
  'general',
  'pending'
);

select set_config('p4.ann', id::text, true)
from public.partner_announcements
where author_id = auth.uid()
order by id desc
limit 1;

insert into public.recruitment_opportunities (
  institution_id, posted_by, title, organisation, description,
  location, work_mode, role_type, application_url, status
) values (
  current_setting('p4.inst')::bigint,
  auth.uid(),
  'Rollback test internship',
  'Rollback Test Organisation',
  'This opportunity exists only inside the rolled-back Phase 4 database test.',
  'Remote',
  'remote',
  'internship',
  'https://example.org/apply',
  'pending'
);

select set_config('p4.opp', id::text, true)
from public.recruitment_opportunities
where posted_by = auth.uid()
order by id desc
limit 1;

-- 6. A partner cannot approve their own content; the guard trigger resets it.
update public.partner_announcements
set status = 'approved', published_at = now()
where id = current_setting('p4.ann')::bigint;

update public.recruitment_opportunities
set status = 'approved', published_at = now()
where id = current_setting('p4.opp')::bigint;

do $$
begin
  if not exists (
    select 1
    from public.partner_announcements
    where id = current_setting('p4.ann')::bigint
      and status = 'pending'
      and published_at is null
  ) then
    raise exception 'partner announcement self-approval was not reset to pending';
  end if;
  if not exists (
    select 1
    from public.recruitment_opportunities
    where id = current_setting('p4.opp')::bigint
      and status = 'pending'
      and published_at is null
  ) then
    raise exception 'partner opportunity self-approval was not reset to pending';
  end if;
end $$;

-- 7. Pending content never reaches the public views.
reset role;
select
  set_config('request.jwt.claim.sub', '', true),
  set_config('request.jwt.claims', '{}', true);
set local role anon;

do $$
begin
  if not exists (
    select 1 from public.institution_partner_directory
    where institution_id = current_setting('p4.inst')::bigint
  ) then
    raise exception 'verified listed partner missing from the public directory';
  end if;
  if exists (
    select 1 from public.partner_announcement_directory
    where id = current_setting('p4.ann')::bigint
  ) then
    raise exception 'pending announcement leaked into the public directory';
  end if;
  if exists (
    select 1 from public.recruitment_opportunity_directory
    where id = current_setting('p4.opp')::bigint
  ) then
    raise exception 'pending opportunity leaked into the public directory';
  end if;
  if exists (
    select 1 from public.alumni_directory
    where user_id = current_setting('p4.alumni_user')::uuid
  ) then
    raise exception 'pending alumni profile leaked into the public directory';
  end if;
end $$;

-- 8. Alumni self-edits reset review state; self-verification cannot stick.
reset role;
select
  set_config('request.jwt.claim.sub', current_setting('p4.alumni_user'), true),
  set_config('request.jwt.claims', json_build_object(
    'sub', current_setting('p4.alumni_user'),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

insert into public.alumni_profiles (
  user_id, institution_id, institution_name, graduation_year,
  bio, verification_method, listed, status
) values (
  auth.uid(),
  current_setting('p4.inst')::bigint,
  current_setting('p4.inst_name'),
  2020,
  'This alumni profile exists only inside the rolled-back Phase 4 database test.',
  'other',
  true,
  'pending'
);

update public.alumni_profiles
set status = 'verified', verified_at = now(), verified_by = auth.uid(), listed = true
where user_id = auth.uid();

do $$
begin
  if not exists (
    select 1
    from public.alumni_profiles
    where user_id = auth.uid()
      and status = 'pending'
      and verified_at is null
      and verified_by is null
  ) then
    raise exception 'alumni self-verification was not reset to pending';
  end if;
end $$;

-- 9. Admin/service-role action: approve the content and verify the alumnus.
reset role;
select
  set_config('request.jwt.claim.sub', '', true),
  set_config('request.jwt.claims', '{}', true);

update public.partner_announcements
set status = 'approved', published_at = now(), reviewed_at = now()
where id = current_setting('p4.ann')::bigint;

update public.recruitment_opportunities
set status = 'approved', published_at = now(), reviewed_at = now()
where id = current_setting('p4.opp')::bigint;

update public.alumni_profiles
set status = 'verified', verified_at = now(), listed = true
where user_id = current_setting('p4.alumni_user')::uuid;

-- 10. Approved rows now appear in the public views.
set local role anon;

do $$
begin
  if not exists (
    select 1 from public.partner_announcement_directory
    where id = current_setting('p4.ann')::bigint
  ) then
    raise exception 'approved announcement missing from the public directory';
  end if;
  if not exists (
    select 1 from public.recruitment_opportunity_directory
    where id = current_setting('p4.opp')::bigint
  ) then
    raise exception 'approved opportunity missing from the public directory';
  end if;
  if not exists (
    select 1 from public.alumni_directory
    where user_id = current_setting('p4.alumni_user')::uuid
  ) then
    raise exception 'verified listed alumnus missing from the public directory';
  end if;
end $$;

reset role;
select
  set_config('request.jwt.claim.sub', '', true),
  set_config('request.jwt.claims', '{}', true);

-- 11. Public views hide private columns, base tables stay locked down, RLS is on.
do $$
declare
  private_columns text[] := array[
    'email', 'phone', 'verification_detail', 'admin_note', 'source_url', 'cv_url', 'cv_path'
  ];
  view_names text[] := array[
    'institution_partner_directory', 'partner_announcement_directory',
    'alumni_directory', 'recruitment_opportunity_directory'
  ];
  base_tables text[] := array[
    'institution_partners', 'institution_partner_members', 'partner_announcements',
    'alumni_profiles', 'recruitment_opportunities'
  ];
begin
  if exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = any (view_names)
      and c.column_name = any (private_columns)
  ) then
    raise exception 'a Phase 4 public view exposes a private column';
  end if;

  if exists (
    select 1
    from unnest(base_tables) t(name)
    where has_table_privilege('anon', 'public.' || t.name, 'SELECT')
  ) then
    raise exception 'anon can read a Phase 4 base table directly';
  end if;

  if exists (
    select 1
    from unnest(base_tables) t(name)
    where has_table_privilege('authenticated', 'public.' || t.name, 'DELETE')
       or has_table_privilege('authenticated', 'public.' || t.name, 'TRUNCATE')
  ) then
    raise exception 'authenticated can delete or truncate a Phase 4 table';
  end if;

  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any (base_tables)
      and c.relrowsecurity = false
  ) then
    raise exception 'RLS is not enabled on a Phase 4 table';
  end if;
end $$;

-- 12. Leave no trace. A failed assertion aborts and rolls back automatically.
rollback;

-- After the run, re-check the production counts. They must match the pre-test
-- numbers:
--   select count(*) from public.institution_partners;
--   select count(*) from public.institution_partner_members;
--   select count(*) from public.partner_announcements;
--   select count(*) from public.alumni_profiles;
--   select count(*) from public.recruitment_opportunities;
--   select count(*) from public.institutions;   -- 588
