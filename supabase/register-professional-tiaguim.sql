-- Cadastro do profissional Tiaguim na Barbearia Kings.
-- Execute no SQL Editor do projeto Supabase.

do $$
declare
  v_shop_id uuid;
  v_user_id uuid := '0dbf4b49-1430-4558-9222-3882f6268764';
begin
  select id into v_shop_id
  from public.barbershops
  where slug = 'barbearia-kings'
    and status = 'active';

  if v_shop_id is null then
    raise exception 'BARBEARIA_KINGS_NAO_ENCONTRADA';
  end if;

  insert into public.profiles (id, full_name, role)
  values (v_user_id, 'Tiaguim', 'professional')
  on conflict (id) do update
    set full_name = 'Tiaguim',
        role = 'professional';

  insert into public.barbershop_members (barbershop_id, user_id)
  values (v_shop_id, v_user_id)
  on conflict (barbershop_id, user_id) do nothing;

  insert into public.professionals (id, barbershop_id, bio, active)
  values (v_user_id, v_shop_id, 'Especialista em cortes e barba.', true)
  on conflict (id) do update
    set barbershop_id = excluded.barbershop_id,
        active = true;
end $$;

select p.id, p.full_name, p.role, pr.barbershop_id, pr.active
from public.profiles p
join public.professionals pr on pr.id = p.id
where p.id = '0dbf4b49-1430-4558-9222-3882f6268764';
