-- Barberly SaaS: schema multi-tenant para Supabase/PostgreSQL.
create extension if not exists "pgcrypto";
create extension if not exists "btree_gist";

create type public.user_role as enum ('super_admin', 'manager', 'professional', 'client');
create type public.appointment_status as enum ('pending', 'confirmed', 'completed', 'cancelled', 'no_show');

create table public.barbershops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null check (slug ~ '^[a-z0-9-]+$'),
  phone text,
  address text,
  city text,
  status text not null default 'active' check (status in ('active', 'suspended')),
  cancellation_hours integer not null default 2 check (cancellation_hours >= 0),
  created_at timestamptz not null default now()
);
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  role public.user_role not null default 'client',
  created_at timestamptz not null default now()
);
create table public.barbershop_members (
  barbershop_id uuid references public.barbershops(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  primary key (barbershop_id, user_id)
);
create table public.services (
  id uuid primary key default gen_random_uuid(),
  barbershop_id uuid not null references public.barbershops(id) on delete cascade,
  name text not null, description text, price numeric(10,2) not null check (price >= 0),
  duration_minutes integer not null check (duration_minutes between 5 and 480),
  active boolean not null default true
);
create table public.professionals (
  id uuid primary key references public.profiles(id) on delete cascade,
  barbershop_id uuid not null references public.barbershops(id) on delete cascade,
  bio text, active boolean not null default true
);
create table public.professional_services (
  professional_id uuid references public.professionals(id) on delete cascade,
  service_id uuid references public.services(id) on delete cascade,
  primary key (professional_id, service_id)
);
create table public.professional_availability (
  id uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null, end_time time not null, check (start_time < end_time)
);
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  barbershop_id uuid not null references public.barbershops(id) on delete cascade,
  professional_id uuid not null references public.professionals(id),
  client_id uuid not null references public.profiles(id),
  service_id uuid not null references public.services(id),
  starts_at timestamptz not null, ends_at timestamptz not null,
  status public.appointment_status not null default 'pending',
  price numeric(10,2) not null check (price >= 0),
  notes text, created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'phone'
  );
  return new;
end; $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
-- Impede sobreposição no mesmo profissional, inclusive serviços com durações diferentes.
alter table public.appointments add constraint appointments_no_overlap
  exclude using gist (professional_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status in ('pending', 'confirmed'));

create or replace function public.create_appointment(
  p_barbershop_id uuid, p_professional_id uuid, p_client_id uuid,
  p_service_id uuid, p_starts_at timestamptz
) returns public.appointments language plpgsql security definer set search_path = public as $$
declare v_duration integer; v_price numeric; v_appointment public.appointments;
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
  if not exists (
    select 1 from professional_services ps
    join professionals p on p.id = ps.professional_id
    join barbershops b on b.id = p.barbershop_id
    where ps.professional_id = p_professional_id
      and ps.service_id = p_service_id
      and p.barbershop_id = p_barbershop_id
      and p.active
      and b.status = 'active'
  ) then
    raise exception 'PROFISSIONAL_OU_SERVICO_INDISPONIVEL';
  end if;
  select duration_minutes, price into v_duration, v_price from services
    where id = p_service_id and barbershop_id = p_barbershop_id and active;
  if not found then raise exception 'SERVICO_INDISPONIVEL'; end if;
  insert into appointments(barbershop_id, professional_id, client_id, service_id, starts_at, ends_at, price)
    values(p_barbershop_id, p_professional_id, p_client_id, p_service_id, p_starts_at,
      p_starts_at + make_interval(mins => v_duration), v_price)
    returning * into v_appointment;
  return v_appointment;
exception when exclusion_violation then
  raise exception 'HORARIO_INDISPONIVEL';
end; $$;

alter table public.barbershops enable row level security;
alter table public.profiles enable row level security;
alter table public.barbershop_members enable row level security;
alter table public.services enable row level security;
alter table public.professionals enable row level security;
alter table public.appointments enable row level security;
create policy "users read own profile" on profiles for select using (id = auth.uid());
create policy "users update own profile" on profiles for update using (id = auth.uid());
revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
create policy "public read active barbershops" on barbershops for select using (status = 'active');
create or replace function public.is_member(shop uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from barbershop_members where barbershop_id = shop and user_id = auth.uid());
$$;
create policy "public read active services" on services for select using (
  active and exists (select 1 from barbershops where id = services.barbershop_id and status = 'active')
);
create policy "public read active professionals" on professionals for select using (
  active and exists (select 1 from barbershops where id = professionals.barbershop_id and status = 'active')
);
create policy "members read tenant appointments" on appointments for select using (is_member(barbershop_id) or client_id = auth.uid());
create policy "clients create own appointments" on appointments for insert with check (
  client_id = auth.uid()
  and exists (select 1 from barbershops where id = barbershop_id and status = 'active')
  and exists (select 1 from professionals where id = professional_id and barbershop_id = appointments.barbershop_id and active)
  and exists (select 1 from services where id = service_id and barbershop_id = appointments.barbershop_id and active)
);
revoke insert on public.appointments from anon, authenticated;
grant execute on function public.create_appointment(uuid, uuid, uuid, uuid, timestamptz) to authenticated;
