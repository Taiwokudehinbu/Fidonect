-- DO NOT PASTE THIS FILE into the SQL Editor. Run backend/seed/01-alter.sql
-- through backend/seed/06-private.sql instead, one file per query (Ctrl+A, paste, Run).
-- This file is reference only. The runnable statements live in backend/seed/.

-- 1/5: category columns (public read policy already covers new columns)
alter table institutions add column if not exists ownership text, add column if not exists state text;

-- 2/5: backfill the existing UNILAG row
update institutions set ownership = 'Federal', state = 'Lagos'
where name = 'University of Lagos (UNILAG)';

-- 3/6: backfill rows seeded earlier without categories (e.g. Phase 2 UI/FUTA)
update institutions set ownership = 'Federal',
  state = case when name like '%Ibadan%' then 'Oyo' when name like '%FUTA%' or name like '%Akure%' then 'Ondo' else state end
where ownership is null and (name like '%Ibadan%' or name like '%FUTA%' or name like '%Akure%');

-- 4/6: Federal (20 incl. UNILAG, skipped if present)
insert into institutions (name, location, ownership, state)
select v.name, v.location, v.ownership, v.state from (values
('University of Lagos (UNILAG)', 'Akoka, Lagos', 'Federal', 'Lagos'),
('University of Ibadan (UI)', 'Ibadan, Oyo', 'Federal', 'Oyo'),
('Federal University of Technology, Akure (FUTA)', 'Akure, Ondo', 'Federal', 'Ondo'),
('Obafemi Awolowo University (OAU)', 'Ile-Ife, Osun', 'Federal', 'Osun'),
('Ahmadu Bello University (ABU)', 'Zaria, Kaduna', 'Federal', 'Kaduna'),
('University of Nigeria, Nsukka (UNN)', 'Nsukka, Enugu', 'Federal', 'Enugu'),
('University of Benin (UNIBEN)', 'Benin City, Edo', 'Federal', 'Edo'),
('University of Ilorin (UNILORIN)', 'Ilorin, Kwara', 'Federal', 'Kwara'),
('University of Calabar (UNICAL)', 'Calabar, Cross River', 'Federal', 'Cross River'),
('University of Port Harcourt (UNIPORT)', 'Choba, Rivers', 'Federal', 'Rivers'),
('Bayero University Kano (BUK)', 'Kano, Kano', 'Federal', 'Kano'),
('Federal University of Technology Minna (FUTMINNA)', 'Minna, Niger', 'Federal', 'Niger'),
('Federal University of Technology Owerri (FUTO)', 'Owerri, Imo', 'Federal', 'Imo'),
('Nnamdi Azikiwe University (UNIZIK)', 'Awka, Anambra', 'Federal', 'Anambra'),
('University of Uyo (UNIUYO)', 'Uyo, Akwa Ibom', 'Federal', 'Akwa Ibom'),
('University of Jos (UNIJOS)', 'Jos, Plateau', 'Federal', 'Plateau'),
('University of Maiduguri (UNIMAID)', 'Maiduguri, Borno', 'Federal', 'Borno'),
('Usmanu Danfodiyo University (UDUS)', 'Sokoto, Sokoto', 'Federal', 'Sokoto'),
('Federal University of Agriculture Abeokuta (FUNAAB)', 'Abeokuta, Ogun', 'Federal', 'Ogun'),
('Federal Polytechnic Ilaro', 'Ilaro, Ogun', 'Federal', 'Ogun')
) as v(name, location, ownership, state)
where not exists (select 1 from institutions i where i.name = v.name);

-- 5/6: State (15)
insert into institutions (name, location, ownership, state)
select v.name, v.location, v.ownership, v.state from (values
('Lagos State University (LASU)', 'Ojo, Lagos', 'State', 'Lagos'),
('Olabisi Onabanjo University (OOU)', 'Ago-Iwoye, Ogun', 'State', 'Ogun'),
('Adekunle Ajasin University (AAUA)', 'Akungba-Akoko, Ondo', 'State', 'Ondo'),
('Ekiti State University (EKSU)', 'Ado-Ekiti, Ekiti', 'State', 'Ekiti'),
('Osun State University (UNIOSUN)', 'Osogbo, Osun', 'State', 'Osun'),
('Ladoke Akintola University (LAUTECH)', 'Ogbomoso, Oyo', 'State', 'Oyo'),
('Kwara State University (KWASU)', 'Malete, Kwara', 'State', 'Kwara'),
('Benue State University (BSU)', 'Makurdi, Benue', 'State', 'Benue'),
('Rivers State University (RSU)', 'Port Harcourt, Rivers', 'State', 'Rivers'),
('Delta State University (DELSU)', 'Abraka, Delta', 'State', 'Delta'),
('Enugu State University (ESUT)', 'Enugu, Enugu', 'State', 'Enugu'),
('Kaduna State University (KASU)', 'Kaduna, Kaduna', 'State', 'Kaduna'),
('Yusuf Maitama Sule University Kano (YMSUK)', 'Kano, Kano', 'State', 'Kano'),
('Lagos State Polytechnic (LASPOTECH)', 'Ikorodu, Lagos', 'State', 'Lagos'),
('Moshood Abiola Polytechnic (MAPOLY)', 'Abeokuta, Ogun', 'State', 'Ogun')
) as v(name, location, ownership, state)
where not exists (select 1 from institutions i where i.name = v.name);

-- 6/6: Private (15)
insert into institutions (name, location, ownership, state)
select v.name, v.location, v.ownership, v.state from (values
('Covenant University', 'Ota, Ogun', 'Private', 'Ogun'),
('Afe Babalola University (ABUAD)', 'Ado-Ekiti, Ekiti', 'Private', 'Ekiti'),
('Bowen University', 'Iwo, Osun', 'Private', 'Osun'),
('Babcock University', 'Ilishan-Remo, Ogun', 'Private', 'Ogun'),
('American University of Nigeria (AUN)', 'Yola, Adamawa', 'Private', 'Adamawa'),
('Lead City University', 'Ibadan, Oyo', 'Private', 'Oyo'),
('Caleb University', 'Imota, Lagos', 'Private', 'Lagos'),
('Pan-Atlantic University', 'Lekki, Lagos', 'Private', 'Lagos'),
('Redeemer''s University', 'Ede, Osun', 'Private', 'Osun'),
('Landmark University', 'Omu-Aran, Kwara', 'Private', 'Kwara'),
('Mountain Top University', 'Makogi Oba, Ogun', 'Private', 'Ogun'),
('Bells University of Technology', 'Ota, Ogun', 'Private', 'Ogun'),
('Elizade University', 'Ilara-Mokin, Ondo', 'Private', 'Ondo'),
('Nile University of Nigeria', 'Abuja, FCT', 'Private', 'FCT'),
('Chrisland University', 'Abeokuta, Ogun', 'Private', 'Ogun')
) as v(name, location, ownership, state)
where not exists (select 1 from institutions i where i.name = v.name);
