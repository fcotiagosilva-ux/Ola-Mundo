-- Execute após o schema.sql e após criar o usuário Super Admin em
-- Authentication > Users. Substitua os valores entre <...>.

insert into public.barbershops (name, slug, phone, city)
values ('Barbearia Kings', 'barbearia-kings', '(11) 99999-0000', 'São Paulo')
on conflict (slug) do nothing
returning id;

-- Depois, use os IDs retornados para cadastrar serviços e profissionais.
-- O profissional precisa existir em auth.users e profiles antes deste insert.
-- Exemplo:
-- insert into public.services (barbershop_id, name, price, duration_minutes)
-- values ('<BARBERSHOP_UUID>', 'Corte + Barba', 85.00, 60);
-- insert into public.barbershop_members (barbershop_id, user_id)
-- values ('<BARBERSHOP_UUID>', '<AUTH_USER_UUID>');
-- update public.profiles set role = 'super_admin' where id = '<AUTH_USER_UUID>';
