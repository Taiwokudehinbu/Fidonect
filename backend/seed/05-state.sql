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
