-- Phase 2: institution data (faculties > departments > programmes + hub pages).
-- Supabase dashboard > SQL Editor. Run ONE statement at a time, in order.
-- Never touches live `institutions` rows or `profiles`; everything is if-not-exists.

-- 1: faculties
create table if not exists faculties (
  id bigint generated always as identity primary key,
  institution_id bigint not null references institutions(id) on delete cascade,
  name text not null,
  unique(institution_id, name)
);

-- 2: departments
create table if not exists departments (
  id bigint generated always as identity primary key,
  faculty_id bigint not null references faculties(id) on delete cascade,
  name text not null,
  unique(faculty_id, name)
);

-- 3: programmes
create table if not exists programmes (
  id bigint generated always as identity primary key,
  department_id bigint not null references departments(id) on delete cascade,
  name text not null,
  unique(department_id, name)
);

-- 4: hub pages (one per institution)
create table if not exists hub_pages (
  institution_id bigint primary key references institutions(id) on delete cascade,
  overview text,
  clearance text,
  fees text,
  accommodation text,
  source text not null default 'Community',
  updated_at timestamptz not null default now()
);

-- 5: lock down (public SELECT policies come next; skip a statement if it errors "already exists")
alter table faculties enable row level security;
alter table departments enable row level security;
alter table programmes enable row level security;
alter table hub_pages enable row level security;

-- 6: public read (institution data is public by nature, PRD §7)
create policy "public read" on faculties for select to anon using (true);
create policy "public read" on departments for select to anon using (true);
create policy "public read" on programmes for select to anon using (true);
create policy "public read" on hub_pages for select to anon using (true);

-- 7: seed missing institutions (UNILAG row already exists)
insert into institutions (name, location)
select 'University of Ibadan (UI)', 'Ibadan, Oyo'
where not exists (select 1 from institutions where name = 'University of Ibadan (UI)');
insert into institutions (name, location)
select 'Yaba College of Technology (YabaTech)', 'Yaba, Lagos'
where not exists (select 1 from institutions where name = 'Yaba College of Technology (YabaTech)');

-- 8: seed faculties
insert into faculties (institution_id, name)
select id, 'Faculty of Science' from institutions where name = 'University of Lagos (UNILAG)'
on conflict (institution_id, name) do nothing;
insert into faculties (institution_id, name)
select id, 'Faculty of Engineering' from institutions where name = 'University of Lagos (UNILAG)'
on conflict (institution_id, name) do nothing;
insert into faculties (institution_id, name)
select id, 'Faculty of Science' from institutions where name = 'University of Ibadan (UI)'
on conflict (institution_id, name) do nothing;
insert into faculties (institution_id, name)
select id, 'School of Science' from institutions where name = 'Yaba College of Technology (YabaTech)'
on conflict (institution_id, name) do nothing;

-- 9: seed departments
insert into departments (faculty_id, name)
select f.id, 'Biology' from faculties f join institutions i on i.id = f.institution_id
where i.name = 'University of Lagos (UNILAG)' and f.name = 'Faculty of Science'
on conflict (faculty_id, name) do nothing;
insert into departments (faculty_id, name)
select f.id, 'Chemistry' from faculties f join institutions i on i.id = f.institution_id
where i.name = 'University of Lagos (UNILAG)' and f.name = 'Faculty of Science'
on conflict (faculty_id, name) do nothing;
insert into departments (faculty_id, name)
select f.id, 'Computer Engineering' from faculties f join institutions i on i.id = f.institution_id
where i.name = 'University of Lagos (UNILAG)' and f.name = 'Faculty of Engineering'
on conflict (faculty_id, name) do nothing;
insert into departments (faculty_id, name)
select f.id, 'Biology' from faculties f join institutions i on i.id = f.institution_id
where i.name = 'University of Ibadan (UI)' and f.name = 'Faculty of Science'
on conflict (faculty_id, name) do nothing;
insert into departments (faculty_id, name)
select f.id, 'Science Laboratory Technology' from faculties f join institutions i on i.id = f.institution_id
where i.name = 'Yaba College of Technology (YabaTech)' and f.name = 'School of Science'
on conflict (faculty_id, name) do nothing;

-- 10: seed programmes
insert into programmes (department_id, name)
select d.id, 'B.Sc. Biology' from departments d join faculties f on f.id = d.faculty_id join institutions i on i.id = f.institution_id
where i.name = 'University of Lagos (UNILAG)' and d.name = 'Biology'
on conflict (department_id, name) do nothing;
insert into programmes (department_id, name)
select d.id, 'B.Sc. Microbiology' from departments d join faculties f on f.id = d.faculty_id join institutions i on i.id = f.institution_id
where i.name = 'University of Lagos (UNILAG)' and d.name = 'Biology'
on conflict (department_id, name) do nothing;
insert into programmes (department_id, name)
select d.id, 'B.Sc. Chemistry' from departments d join faculties f on f.id = d.faculty_id join institutions i on i.id = f.institution_id
where i.name = 'University of Lagos (UNILAG)' and d.name = 'Chemistry'
on conflict (department_id, name) do nothing;
insert into programmes (department_id, name)
select d.id, 'B.Eng. Computer Engineering' from departments d join faculties f on f.id = d.faculty_id join institutions i on i.id = f.institution_id
where i.name = 'University of Lagos (UNILAG)' and d.name = 'Computer Engineering'
on conflict (department_id, name) do nothing;
insert into programmes (department_id, name)
select d.id, 'B.Sc. Zoology' from departments d join faculties f on f.id = d.faculty_id join institutions i on i.id = f.institution_id
where i.name = 'University of Ibadan (UI)' and d.name = 'Biology'
on conflict (department_id, name) do nothing;
insert into programmes (department_id, name)
select d.id, x.p from departments d join faculties f on f.id = d.faculty_id join institutions i on i.id = f.institution_id
cross join (values ('ND SLT'), ('HND SLT')) as x(p)
where i.name = 'Yaba College of Technology (YabaTech)' and d.name = 'Science Laboratory Technology'
on conflict (department_id, name) do nothing;

-- 11: seed UNILAG hub page
insert into hub_pages (institution_id, overview, clearance, fees, accommodation, source)
select id,
  'Federal university in Akoka, Lagos.',
  'JAMB admission letter, O-level results, birth certificate, LGA letter, passport photos.',
  'See official portal; varies by faculty.',
  'Hostels limited — apply early; private hostels in Akoka/Bariga.',
  'Official + Community'
from institutions where name = 'University of Lagos (UNILAG)'
on conflict (institution_id) do nothing;
