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
