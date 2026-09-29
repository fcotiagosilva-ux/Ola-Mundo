-- Runtime seguro de disponibilidade e agendamento para clientes.
-- Execute no SQL Editor antes de ativar o fluxo real no frontend.

revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
revoke insert on public.appointments from anon, authenticated;

insert into public.profiles (id, full_name, phone)
select
  u.id,
  coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), nullif(split_part(u.email, '@', 1), ''), 'Cliente'),
  u.raw_user_meta_data ->> 'phone'
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;

create or replace function public.list_active_professionals(p_barbershop_id uuid)
returns table(id uuid, full_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, pr.full_name
  from public.professionals p
  join public.profiles pr on pr.id = p.id
  join public.barbershops b on b.id = p.barbershop_id
  where p.barbershop_id = p_barbershop_id
    and p.active and b.status = 'active';
$$;

create or replace function public.available_appointment_slots(
  p_professional_id uuid,
  p_service_id uuid,
  p_date date
) returns table(slot_start timestamptz, local_time time)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_duration integer;
begin
  select s.duration_minutes
    into v_duration
  from public.professionals p
  join public.professional_services ps on ps.professional_id = p.id
  join public.services s on s.id = ps.service_id
  join public.barbershops b on b.id = p.barbershop_id
  where p.id = p_professional_id
    and s.id = p_service_id
    and p.active and s.active and b.status = 'active';

  if not found then
    raise exception 'PROFISSIONAL_OU_SERVICO_INDISPONIVEL';
  end if;

  if p_date < (now() at time zone 'America/Sao_Paulo')::date then
    return;
  end if;

  return query
  with windows as (
    select a.start_time, a.end_time
    from public.professional_availability a
    where a.professional_id = p_professional_id
      and a.weekday = extract(dow from p_date)::smallint
  ), candidates as (
    select p_date + w.start_time + (g.slot_offset * interval '15 minutes') as local_start,
           w.end_time
    from windows w
    cross join lateral generate_series(
      0,
      greatest(0, floor(extract(epoch from (w.end_time - w.start_time - make_interval(mins => v_duration))) / 900)::integer)
    ) as g(slot_offset)
  )
  select (c.local_start at time zone 'America/Sao_Paulo'),
         c.local_start::time
  from candidates c
  where c.local_start + make_interval(mins => v_duration) <= p_date + c.end_time
    and c.local_start > (now() at time zone 'America/Sao_Paulo')
    and not exists (
      select 1
      from public.appointments a
      where a.professional_id = p_professional_id
        and a.status in ('pending', 'confirmed')
        and tstzrange(a.starts_at, a.ends_at, '[)') &&
            tstzrange(
              c.local_start at time zone 'America/Sao_Paulo',
              (c.local_start + make_interval(mins => v_duration)) at time zone 'America/Sao_Paulo',
              '[)'
            )
    )
  order by c.local_start;
end;
$$;

create or replace function public.create_appointment(
  p_barbershop_id uuid,
  p_professional_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz
) returns public.appointments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_duration integer;
  v_price numeric;
  v_appointment public.appointments;
  v_local_start timestamp;
  v_is_available boolean;
begin
  if auth.uid() is null or auth.uid() <> p_client_id then
    raise exception 'CLIENTE_NAO_AUTENTICADO_OU_DIVERGENTE';
  end if;

  insert into public.profiles (id, full_name, phone)
  select
    u.id,
    coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), nullif(split_part(u.email, '@', 1), ''), 'Cliente'),
    u.raw_user_meta_data ->> 'phone'
  from auth.users u
  where u.id = auth.uid()
  on conflict (id) do nothing;

  select s.duration_minutes, s.price
    into v_duration, v_price
  from public.services s
  join public.professional_services ps on ps.service_id = s.id
  join public.professionals p on p.id = ps.professional_id
  join public.barbershops b on b.id = p.barbershop_id
  where s.id = p_service_id
    and s.barbershop_id = p_barbershop_id
    and p.id = p_professional_id
    and p.barbershop_id = p_barbershop_id
    and s.active and p.active and b.status = 'active';

  if not found then
    raise exception 'SERVICO_OU_PROFISSIONAL_INDISPONIVEL';
  end if;

  v_local_start := p_starts_at at time zone 'America/Sao_Paulo';
  if mod(extract(epoch from (v_local_start - date_trunc('day', v_local_start)))::integer, 900) <> 0 then
    raise exception 'HORARIO_INVALIDO_INTERVALO_15_MINUTOS';
  end if;
  select exists (
    select 1
    from public.professional_availability a
    where a.professional_id = p_professional_id
      and a.weekday = extract(dow from v_local_start)::smallint
      and v_local_start::time >= a.start_time
      and (v_local_start + make_interval(mins => v_duration))::time <= a.end_time
  ) into v_is_available;

  if not v_is_available or p_starts_at <= now() then
    raise exception 'HORARIO_FORA_DA_DISPONIBILIDADE';
  end if;

  insert into public.appointments(
    barbershop_id, professional_id, client_id, service_id, starts_at, ends_at, price
  ) values (
    p_barbershop_id, p_professional_id, p_client_id, p_service_id, p_starts_at,
    p_starts_at + make_interval(mins => v_duration), v_price
  ) returning * into v_appointment;

  return v_appointment;
exception when exclusion_violation then
  raise exception 'HORARIO_INDISPONIVEL';
end;
$$;

revoke all on function public.list_active_professionals(uuid) from public;
grant execute on function public.list_active_professionals(uuid) to anon, authenticated;
revoke all on function public.available_appointment_slots(uuid, uuid, date) from public;
grant execute on function public.available_appointment_slots(uuid, uuid, date) to anon, authenticated;
revoke all on function public.create_appointment(uuid, uuid, uuid, uuid, timestamptz) from public, anon;
grant execute on function public.create_appointment(uuid, uuid, uuid, uuid, timestamptz) to authenticated;
