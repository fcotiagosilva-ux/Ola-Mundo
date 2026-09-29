-- Painel operacional e cancelamento autenticado.
-- Execute no SQL Editor após schema.sql e booking-runtime.sql.

drop function if exists public.list_my_barbershops();

create or replace function public.list_my_barbershops()
returns table(id uuid, name text, slug text, address text, phone text, status text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select b.id, b.name, b.slug, b.address, b.phone, b.status
  from public.barbershops b
  where auth.uid() is not null
    and b.status = 'active'
    and (
      public.is_member(b.id)
      or exists (
        select 1 from public.profiles me
        where me.id = auth.uid() and me.role = 'super_admin'
      )
    )
  order by b.name;
$$;

create or replace function public.list_my_appointments()
returns table (
  id uuid,
  barbershop_id uuid,
  client_id uuid,
  client_name text,
  professional_id uuid,
  professional_name text,
  service_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  status public.appointment_status,
  price numeric,
  cancellation_hours integer,
  can_cancel boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'LOGIN_NECESSARIO';
  end if;

  return query
  select a.id, a.barbershop_id, a.client_id,
         client.full_name, a.professional_id, professional.full_name,
         s.name, a.starts_at, a.ends_at, a.status, a.price,
         b.cancellation_hours,
         a.status in ('pending', 'confirmed')
           and (
             (a.client_id = auth.uid()
              and a.starts_at > now() + make_interval(hours => b.cancellation_hours))
             or (public.is_member(a.barbershop_id)
                 and a.professional_id = auth.uid())
             or exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'super_admin')
             or (public.is_member(a.barbershop_id)
                 and exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'manager'))
           )
  from public.appointments a
  join public.profiles client on client.id = a.client_id
  join public.profiles professional on professional.id = a.professional_id
  join public.services s on s.id = a.service_id
  join public.barbershops b on b.id = a.barbershop_id
  where a.client_id = auth.uid()
     or exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'super_admin')
     or (public.is_member(a.barbershop_id)
         and (exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'manager')
              or a.professional_id = auth.uid()))
  order by a.starts_at;
end;
$$;

create or replace function public.cancel_my_appointment(p_appointment_id uuid)
returns public.appointments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments;
  v_cancellation_hours integer;
  v_is_member boolean;
  v_is_manager boolean;
begin
  if auth.uid() is null then
    raise exception 'LOGIN_NECESSARIO';
  end if;

  select a
    into v_appointment
  from public.appointments a
  where a.id = p_appointment_id
  for update of a;

  if not found then
    raise exception 'AGENDAMENTO_NAO_ENCONTRADO';
  end if;

  select b.cancellation_hours into v_cancellation_hours
  from public.barbershops b
  where b.id = v_appointment.barbershop_id;

  v_is_member := public.is_member(v_appointment.barbershop_id);
  select exists(select 1 from public.profiles me where me.id = auth.uid() and me.role in ('manager','super_admin'))
    into v_is_manager;
  if v_appointment.client_id <> auth.uid()
     and not (
       (v_is_member and (v_is_manager or v_appointment.professional_id = auth.uid()))
       or exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'super_admin')
     ) then
    raise exception 'SEM_PERMISSAO_PARA_CANCELAR';
  end if;
  if v_appointment.status not in ('pending', 'confirmed') then
    raise exception 'AGENDAMENTO_NAO_CANCELAVEL';
  end if;
  if v_appointment.client_id = auth.uid()
     and v_appointment.starts_at <= now() + make_interval(hours => v_cancellation_hours) then
    raise exception 'PRAZO_MINIMO_PARA_CANCELAMENTO';
  end if;

  update public.appointments
  set status = 'cancelled'
  where id = p_appointment_id
  returning * into v_appointment;

  return v_appointment;
end;
$$;

create or replace function public.barbershop_dashboard_metrics(p_barbershop_id uuid)
returns table (
  revenue_today numeric,
  revenue_month numeric,
  appointments_today bigint,
  appointments_month bigint,
  active_clients_month bigint,
  average_ticket_month numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today_start timestamptz := date_trunc('day', now() at time zone 'America/Sao_Paulo')
                                at time zone 'America/Sao_Paulo';
  v_month_start timestamptz := date_trunc('month', now() at time zone 'America/Sao_Paulo')
                                at time zone 'America/Sao_Paulo';
begin
  if auth.uid() is null
     or not exists (
       select 1 from public.profiles me
       where me.id = auth.uid()
         and (
           me.role = 'super_admin'
           or (me.role = 'manager' and public.is_member(p_barbershop_id))
         )
     ) then
    raise exception 'SEM_PERMISSAO_PARA_METRICAS';
  end if;

  return query
  select
    coalesce(sum(a.price) filter (where a.status = 'completed' and a.starts_at >= v_today_start), 0),
    coalesce(sum(a.price) filter (where a.status = 'completed' and a.starts_at >= v_month_start), 0),
    count(*) filter (where a.starts_at >= v_today_start and a.starts_at < v_today_start + interval '1 day'),
    count(*) filter (where a.starts_at >= v_month_start),
    count(distinct a.client_id) filter (
      where a.starts_at >= v_month_start
        and a.status in ('pending','confirmed','completed')
    ),
    coalesce(avg(a.price) filter (where a.status = 'completed' and a.starts_at >= v_month_start), 0)
  from public.appointments a
  where a.barbershop_id = p_barbershop_id
    and a.starts_at >= v_month_start;
end;
$$;

create or replace function public.barbershop_service_report(p_barbershop_id uuid)
returns table(service_name text, completed_count bigint, completed_revenue numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
     or not exists (
       select 1 from public.profiles me
       where me.id = auth.uid()
         and (
           me.role = 'super_admin'
           or (me.role = 'manager' and public.is_member(p_barbershop_id))
         )
     ) then
    raise exception 'SEM_PERMISSAO_PARA_RELATORIOS';
  end if;

  return query
  select s.name, count(a.id), coalesce(sum(a.price),0)
  from public.services s
  left join public.appointments a
    on a.service_id = s.id
   and a.barbershop_id = p_barbershop_id
   and a.status = 'completed'
   and a.starts_at >= date_trunc('month', now() at time zone 'America/Sao_Paulo')
                         at time zone 'America/Sao_Paulo'
  where s.barbershop_id = p_barbershop_id
  group by s.id, s.name
  order by count(a.id) desc, s.name;
end;
$$;

revoke all on function public.list_my_appointments() from public, anon;
grant execute on function public.list_my_appointments() to authenticated;
revoke all on function public.list_my_barbershops() from public, anon;
grant execute on function public.list_my_barbershops() to authenticated;
revoke all on function public.cancel_my_appointment(uuid) from public, anon;
grant execute on function public.cancel_my_appointment(uuid) to authenticated;
revoke all on function public.barbershop_dashboard_metrics(uuid) from public, anon;
grant execute on function public.barbershop_dashboard_metrics(uuid) to authenticated;
revoke all on function public.barbershop_service_report(uuid) from public, anon;
grant execute on function public.barbershop_service_report(uuid) to authenticated;

notify pgrst, 'reload schema';
