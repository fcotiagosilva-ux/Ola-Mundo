-- Cadastro seguro de serviços e horários semanais dos profissionais.
-- Execute após schema.sql, booking-runtime.sql, operations-runtime.sql
-- e tenant-onboarding-runtime.sql.

create or replace function public.create_barbershop_service(
  p_barbershop_id uuid,
  p_name text,
  p_price numeric,
  p_duration_minutes integer,
  p_professional_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service_id uuid;
  v_valid_professionals integer;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles actor
    where actor.id = auth.uid()
      and (
        actor.role = 'super_admin'
        or (actor.role = 'manager' and public.is_member(p_barbershop_id))
      )
  ) then
    raise exception 'SEM_PERMISSAO_PARA_CADASTRAR_SERVICO';
  end if;

  if nullif(trim(p_name), '') is null
     or p_price is null or p_price < 0
     or p_duration_minutes is null
     or p_duration_minutes not between 5 and 480
     or coalesce(cardinality(p_professional_ids), 0) = 0
     or not exists (
       select 1 from public.barbershops b
       where b.id = p_barbershop_id and b.status = 'active'
     ) then
    raise exception 'DADOS_DO_SERVICO_INVALIDOS';
  end if;

  select count(distinct p.id)::integer into v_valid_professionals
  from public.professionals p
  where p.id = any(p_professional_ids)
    and p.barbershop_id = p_barbershop_id
    and p.active;

  if v_valid_professionals <> cardinality(p_professional_ids) then
    raise exception 'PROFISSIONAIS_INVALIDOS_PARA_BARBEARIA';
  end if;

  insert into public.services(barbershop_id, name, price, duration_minutes, active)
  values(p_barbershop_id, trim(p_name), p_price, p_duration_minutes, true)
  returning id into v_service_id;

  insert into public.professional_services(professional_id, service_id)
  select distinct professional_id, v_service_id
  from unnest(p_professional_ids) as selected(professional_id);

  return v_service_id;
end;
$$;

create or replace function public.save_professional_weekly_schedule(
  p_professional_id uuid,
  p_schedule jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shop_id uuid;
  v_schedule_count integer;
  v_distinct_days integer;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles actor
    join public.professionals professional on professional.id = p_professional_id
    where actor.id = auth.uid()
      and professional.active
      and (
        actor.role = 'super_admin'
        or (actor.role = 'manager' and public.is_member(professional.barbershop_id))
      )
  ) then
    raise exception 'SEM_PERMISSAO_PARA_CONFIGURAR_HORARIOS';
  end if;

  select professional.barbershop_id into v_shop_id
  from public.professionals professional
  join public.barbershops shop on shop.id = professional.barbershop_id
  where professional.id = p_professional_id
    and professional.active
    and shop.status = 'active';
  if not found then
    raise exception 'PROFISSIONAL_OU_BARBEARIA_INDISPONIVEL';
  end if;

  if p_schedule is null or jsonb_typeof(p_schedule) <> 'array' then
    raise exception 'AGENDA_SEMANAL_INVALIDA';
  end if;
  if jsonb_array_length(p_schedule) > 7 then
    raise exception 'AGENDA_SEMANAL_INVALIDA';
  end if;

  select count(*)::integer, count(distinct schedule.weekday)::integer
  into v_schedule_count, v_distinct_days
  from jsonb_to_recordset(p_schedule) as schedule(
    weekday smallint,
    start_time time,
    end_time time
  );

  if v_schedule_count <> jsonb_array_length(p_schedule)
     or v_schedule_count <> v_distinct_days
     or exists (
       select 1
       from jsonb_to_recordset(p_schedule) as schedule(
         weekday smallint,
         start_time time,
         end_time time
       )
       where schedule.weekday is null
          or schedule.weekday not between 0 and 6
          or schedule.start_time is null
          or schedule.end_time is null
          or schedule.start_time >= schedule.end_time
     ) then
    raise exception 'AGENDA_SEMANAL_INVALIDA';
  end if;

  delete from public.professional_availability
  where professional_id = p_professional_id;

  insert into public.professional_availability(
    professional_id, weekday, start_time, end_time
  )
  select p_professional_id, schedule.weekday, schedule.start_time, schedule.end_time
  from jsonb_to_recordset(p_schedule) as schedule(
    weekday smallint,
    start_time time,
    end_time time
  );

  return v_schedule_count;
end;
$$;

revoke all on function public.create_barbershop_service(uuid, text, numeric, integer, uuid[]) from public, anon;
grant execute on function public.create_barbershop_service(uuid, text, numeric, integer, uuid[]) to authenticated;
revoke all on function public.save_professional_weekly_schedule(uuid, jsonb) from public, anon;
grant execute on function public.save_professional_weekly_schedule(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
