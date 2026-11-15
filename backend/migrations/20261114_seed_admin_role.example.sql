-- Copy this file, replace the placeholder email with the admin account email,
-- and run it once in the Supabase SQL Editor AFTER the security migration.
-- Never commit a real admin email if you treat it as private.

insert into public.user_roles (user_id, role)
select id, 'super_admin'
from public.profiles
where lower(email) = lower('admin@example.com')
on conflict do nothing;

-- Confirm:
-- select u.email, r.role from public.user_roles r
-- join public.profiles u on u.id = r.user_id;
