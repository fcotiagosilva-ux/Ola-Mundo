-- Vincula os quatro serviços da Barbearia Kings ao Tiaguim.
-- Execute no SQL Editor do Supabase.

do $$
declare
  v_shop_id uuid;
  v_professional_id uuid := '0dbf4b49-1430-4558-9222-3882f6268764';
  v_service_count integer;
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

  select count(*) into v_service_count
  from public.services
  where barbershop_id = v_shop_id
    and active
    and name in ('Barba', 'Corte + Barba', 'Corte tradicional', 'Sobrancelha');

  if v_service_count <> 4 then
    raise exception 'ESPERADOS_4_SERVICOS_ATIVOS_ENCONTRADOS_%', v_service_count;
  end if;

  insert into public.professional_services (professional_id, service_id)
  select v_professional_id, id
  from public.services
  where barbershop_id = v_shop_id
    and active
    and name in ('Barba', 'Corte + Barba', 'Corte tradicional', 'Sobrancelha')
  on conflict (professional_id, service_id) do nothing;

  if (
    select count(*)
    from public.professional_services ps
    join public.services s on s.id = ps.service_id
    where ps.professional_id = v_professional_id
      and s.barbershop_id = v_shop_id
      and s.active
      and s.name in ('Barba', 'Corte + Barba', 'Corte tradicional', 'Sobrancelha')
  ) <> 4 then
    raise exception 'VINCULACAO_INCOMPLETA';
  end if;
end $$;

select s.name, s.price, s.duration_minutes,
       (ps.professional_id is not null) as vinculado_ao_tiaguim
from public.services s
left join public.professional_services ps
  on ps.service_id = s.id
 and ps.professional_id = '0dbf4b49-1430-4558-9222-3882f6268764'
where s.barbershop_id = (
  select id from public.barbershops where slug = 'barbearia-kings'
)
  and s.name in ('Barba', 'Corte + Barba', 'Corte tradicional', 'Sobrancelha')
order by s.name;
