update institutions set ownership = 'Federal',
  state = case when name like '%Ibadan%' then 'Oyo' when name like '%FUTA%' or name like '%Akure%' then 'Ondo' else state end
where ownership is null and (name like '%Ibadan%' or name like '%FUTA%' or name like '%Akure%');
