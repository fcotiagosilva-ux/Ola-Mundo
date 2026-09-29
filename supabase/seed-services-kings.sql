-- Serviços iniciais da Barbearia Kings e vínculo com Tiaguim.
-- Execute no SQL Editor do projeto Supabase.

do $$
declare
  v_shop_id uuid;
  v_professional_id uuid := '0dbf4b49-1430-4558-9222-3882f6268764';
  v_service_id uuid;
begin
  select id into v_shop_id
  from public.barbershops
  where slug = 'barbearia-kings'
    and status = 'active';

  if v_shop_id is null then
    raise exception 'BARBEARIA_KINGS_NAO_ENCONTRADA';
  end if;

  if not exists (
    select 1 from public.professionals
    where id = v_professional_id
      and barbershop_id = v_shop_id
      and active
  ) then
    raise exception 'PROFISSIONAL_TIAGUIM_NAO_ENCONTRADO';
  end if;

  insert into public.services (barbershop_id, name, price, duration_minutes, active)
  values
    (v_shop_id, 'Corte tradicional', 55.00, 45, true),
    (v_shop_id, 'Barba', 45.00, 30, true),
    (v_shop_id, 'Corte + Barba', 85.00, 60, true),
    (v_shop_id, 'Sobrancelha', 25.00, 15, true)
  on conflict do nothing;

  insert into public.professional_services (professional_id, service_id)
  select v_professional_id, id
  from public.services
  where barbershop_id = v_shop_id
    and name in ('Corte tradicional', 'Barba', 'Corte + Barba', 'Sobrancelha')
  on conflict do nothing;
end $$;

select s.name, s.price, s.duration_minutes, s.active,
       ps.professional_id is not null as vinculado_ao_tiaguim
from public.services s
left join public.professional_services ps
  on ps.service_id = s.id
 and ps.professional_id = '0dbf4b49-1430-4558-9222-3882f6268764'
where s.barbershop_id = (
  select id from public.barbershops where slug = 'barbearia-kings'
)
order by s.name;
