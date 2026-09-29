-- Vincula clientes às unidades dos links de agendamento que acessaram.
-- Execute após schema.sql, booking-runtime.sql e tenant-onboarding-runtime.sql.

create table if not exists public.client_barbershop_links (
  client_id uuid not null references public.profiles(id) on delete cascade,
  barbershop_id uuid not null references public.barbershops(id) on delete cascade,
  linked_at timestamptz not null default now(),
  primary key (client_id, barbershop_id)
);

alter table public.client_barbershop_links enable row level security;
revoke all on public.client_barbershop_links from public, anon, authenticated;

insert into public.client_barbershop_links(client_id, barbershop_id)
select distinct a.client_id, a.barbershop_id
from public.appointments a
join public.profiles p on p.id = a.client_id
where p.role = 'client'
on conflict do nothing;

create or replace function public.claim_client_barbershop_link(p_slug text)
returns table(id uuid, name text, slug text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
  v_shop public.barbershops;
begin
  if auth.uid() is null then
    raise exception 'LOGIN_NECESSARIO';
  end if;

  insert into public.profiles(id, full_name, phone)
  select u.id,
         coalesce(
           nullif(u.raw_user_meta_data ->> 'full_name', ''),
           nullif(split_part(u.email, '@', 1), ''),
           'Cliente'
         ),
         u.raw_user_meta_data ->> 'phone'
  from auth.users u
  where u.id = auth.uid()
  on conflict (id) do nothing;

  select p.* into v_profile
  from public.profiles p
  where p.id = auth.uid()
  for update;

  if not found or v_profile.role <> 'client' then
    raise exception 'SOMENTE_CLIENTES_PODEM_VINCULAR_BARBEARIAS';
  end if;

  select b.* into v_shop
  from public.barbershops b
  where b.slug = lower(trim(coalesce(p_slug, '')))
    and b.status = 'active';

  if not found then
    raise exception 'BARBEARIA_INVALIDA_OU_INDISPONIVEL';
  end if;

  insert into public.client_barbershop_links(client_id, barbershop_id)
  values(auth.uid(), v_shop.id)
  on conflict do nothing;

  return query select v_shop.id, v_shop.name, v_shop.slug;
end;
$$;

drop function if exists public.list_my_client_barbershops();
create function public.list_my_client_barbershops()
returns table(id uuid, name text, slug text, status text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select b.id, b.name, b.slug, b.status
  from public.client_barbershop_links link
  join public.barbershops b on b.id = link.barbershop_id
  where auth.uid() is not null
    and link.client_id = auth.uid()
    and exists (
      select 1 from public.profiles me
      where me.id = auth.uid() and me.role = 'client'
    )
  order by b.name;
$$;

create or replace function public.enforce_client_barbershop_link_on_appointment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.user_role;
begin
  perform 1
  from public.profiles p
  where p.id = new.client_id
  for update;

  select p.role into v_role
  from public.profiles p
  where p.id = new.client_id;

  if v_role is distinct from 'client' then
    return new;
  end if;

  if exists (
    select 1
    from public.client_barbershop_links link
    where link.client_id = new.client_id
  ) and not exists (
    select 1
    from public.client_barbershop_links link
    where link.client_id = new.client_id
      and link.barbershop_id = new.barbershop_id
  ) then
    raise exception 'CLIENTE_NAO_VINCULADO_A_BARBEARIA';
  end if;

  insert into public.client_barbershop_links(client_id, barbershop_id)
  values(new.client_id, new.barbershop_id)
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists enforce_client_barbershop_link_on_appointment
  on public.appointments;
create trigger enforce_client_barbershop_link_on_appointment
  after insert on public.appointments
  for each row
  execute function public.enforce_client_barbershop_link_on_appointment();

revoke all on function public.claim_client_barbershop_link(text) from public, anon;
grant execute on function public.claim_client_barbershop_link(text) to authenticated;
revoke all on function public.list_my_client_barbershops() from public, anon;
grant execute on function public.list_my_client_barbershops() to authenticated;
revoke all on function public.enforce_client_barbershop_link_on_appointment() from public, anon, authenticated;

notify pgrst, 'reload schema';
