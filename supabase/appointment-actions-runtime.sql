-- Ações protegidas de confirmação e cancelamento de agendamentos.
-- Execute após operations-runtime.sql.

drop function if exists public.cancel_my_appointment(uuid);
create function public.cancel_my_appointment(p_appointment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments;
  v_cancellation_hours integer;
  v_cancelled_id uuid;
begin
  if auth.uid() is null then
    raise exception 'LOGIN_NECESSARIO';
  end if;

  select a.* into v_appointment
  from public.appointments a
  where a.id = p_appointment_id
  for update;

  if not found then
    raise exception 'AGENDAMENTO_NAO_ENCONTRADO';
  end if;

  if v_appointment.client_id <> auth.uid()
     and not exists (
       select 1
       from public.profiles actor
       where actor.id = auth.uid()
         and (
           actor.role = 'super_admin'
           or (
             actor.role = 'manager'
             and public.is_member(v_appointment.barbershop_id)
           )
           or (
             actor.role = 'professional'
             and v_appointment.professional_id = auth.uid()
             and public.is_member(v_appointment.barbershop_id)
           )
         )
     ) then
    raise exception 'SEM_PERMISSAO_PARA_CANCELAR';
  end if;

  if v_appointment.status not in ('pending', 'confirmed') then
    raise exception 'AGENDAMENTO_NAO_CANCELAVEL';
  end if;

  if v_appointment.client_id = auth.uid() then
    select b.cancellation_hours into v_cancellation_hours
    from public.barbershops b
    where b.id = v_appointment.barbershop_id;

    if v_appointment.starts_at <= now() + make_interval(hours => v_cancellation_hours) then
      raise exception 'PRAZO_MINIMO_PARA_CANCELAMENTO';
    end if;
  end if;

  update public.appointments a
  set status = 'cancelled'
  where a.id = p_appointment_id
  returning a.id into v_cancelled_id;

  return v_cancelled_id;
end;
$$;

create or replace function public.confirm_my_appointment(p_appointment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments;
  v_confirmed_id uuid;
begin
  if auth.uid() is null then
    raise exception 'LOGIN_NECESSARIO';
  end if;

  select a.* into v_appointment
  from public.appointments a
  where a.id = p_appointment_id
  for update;

  if not found then
    raise exception 'AGENDAMENTO_NAO_ENCONTRADO';
  end if;

  if not exists (
    select 1
    from public.profiles actor
    where actor.id = auth.uid()
      and (
        actor.role = 'super_admin'
        or (actor.role = 'manager' and public.is_member(v_appointment.barbershop_id))
      )
  ) then
    raise exception 'SEM_PERMISSAO_PARA_CONFIRMAR';
  end if;

  if v_appointment.status <> 'pending' then
    raise exception 'SOMENTE_AGENDAMENTOS_PENDENTES_PODEM_SER_CONFIRMADOS';
  end if;

  update public.appointments a
  set status = 'confirmed'
  where a.id = p_appointment_id
  returning a.id into v_confirmed_id;

  return v_confirmed_id;
end;
$$;

revoke all on function public.cancel_my_appointment(uuid) from public, anon;
grant execute on function public.cancel_my_appointment(uuid) to authenticated;
revoke all on function public.confirm_my_appointment(uuid) from public, anon;
grant execute on function public.confirm_my_appointment(uuid) to authenticated;

notify pgrst, 'reload schema';
