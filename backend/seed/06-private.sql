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
