-- Corrige duplicidades, vincula serviços ao Tiaguim e configura a agenda padrão.
-- Execute uma vez no SQL Editor do projeto Supabase.

delete from public.professional_availability duplicate
using public.professional_availability keeper
where duplicate.professional_id = keeper.professional_id
  and duplicate.weekday = keeper.weekday
  and duplicate.start_time = keeper.start_time
  and duplicate.end_time = keeper.end_time
  and duplicate.id > keeper.id;

create unique index if not exists professional_availability_unique_window
  on public.professional_availability (professional_id, weekday, start_time, end_time);

do $$
declare
  v_shop_id uuid;
  v_professional_id uuid := '0dbf4b49-1430-4558-9222-3882f6268764';
begin
  select id into v_shop_id
  from public.barbershops
  where slug = 'barbearia-kings' and status = 'active';

  if v_shop_id is null then
    raise exception 'BARBEARIA_KINGS_NAO_ENCONTRADA';
  end if;

  if not exists (
    select 1 from public.professionals
    where id = v_professional_id and barbershop_id = v_shop_id and active
  ) then
    raise exception 'PROFISSIONAL_TIAGUIM_NAO_ENCONTRADO';
  end if;

  delete from public.services duplicate
  using public.services keeper
  where duplicate.barbershop_id = v_shop_id
    and keeper.barbershop_id = duplicate.barbershop_id
    and lower(keeper.name) = lower(duplicate.name)
    and keeper.id < duplicate.id;

  create unique index if not exists services_one_name_per_shop
    on public.services (barbershop_id, lower(name));

  insert into public.services (barbershop_id, name, price, duration_minutes, active)
  values
    (v_shop_id, 'Corte tradicional', 55.00, 45, true),
    (v_shop_id, 'Barba', 45.00, 30, true),
    (v_shop_id, 'Corte + Barba', 85.00, 60, true),
    (v_shop_id, 'Sobrancelha', 25.00, 15, true)
  on conflict (barbershop_id, (lower(name))) do update
    set price = excluded.price,
        duration_minutes = excluded.duration_minutes,
        active = true;

  insert into public.professional_services (professional_id, service_id)
  select v_professional_id, s.id
  from public.services s
  where s.barbershop_id = v_shop_id
    and s.name in ('Corte tradicional', 'Barba', 'Corte + Barba', 'Sobrancelha')
  on conflict (professional_id, service_id) do nothing;

  insert into public.professional_availability (professional_id, weekday, start_time, end_time)
  select v_professional_id, days.weekday, time '09:00', time '18:00'
  from generate_series(1, 6) as days(weekday)
  where not exists (
    select 1 from public.professional_availability a
    where a.professional_id = v_professional_id
      and a.weekday = days.weekday
      and a.start_time = time '09:00'
      and a.end_time = time '18:00'
  )
  on conflict (professional_id, weekday, start_time, end_time) do nothing;
end $$;

select s.name, s.price, s.duration_minutes,
       ps.professional_id is not null as vinculado_ao_tiaguim
from public.services s
left join public.professional_services ps
  on ps.service_id = s.id
 and ps.professional_id = '0dbf4b49-1430-4558-9222-3882f6268764'
where s.barbershop_id = (
  select id from public.barbershops where slug = 'barbearia-kings'
)
order by s.name;

select weekday, start_time, end_time
from public.professional_availability
where professional_id = '0dbf4b49-1430-4558-9222-3882f6268764'
order by weekday;
