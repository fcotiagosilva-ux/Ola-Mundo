-- Onboarding multi-tenant: barbearias e convites de uso único.
-- Execute após schema.sql, booking-runtime.sql e operations-runtime.sql.

create table if not exists public.barbershop_invites (
  id uuid primary key default gen_random_uuid(),
  barbershop_id uuid not null references public.barbershops(id) on delete cascade,
  role public.user_role not null check (role in ('manager', 'professional')),
  invited_name text,
  token_hash text not null unique,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  claimed_by uuid references public.profiles(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.barbershop_invites enable row level security;
revoke all on public.barbershop_invites from public, anon, authenticated;

drop function if exists public.list_my_barbershops();
create function public.list_my_barbershops()
returns table(id uuid, name text, slug text, address text, phone text, status text)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
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

create or replace function public.create_barbershop_with_manager_invite(
  p_name text,
  p_address text,
  p_phone text,
  p_slug text
)
returns table(barbershop_id uuid, barbershop_name text, slug text, invite_token text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_shop_id uuid;
  v_token text := encode(gen_random_bytes(32), 'hex');
  v_slug text := lower(trim(p_slug));
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'super_admin'
  ) then
    raise exception 'SEM_PERMISSAO_PARA_CRIAR_BARBEARIA';
  end if;
  if nullif(trim(p_name), '') is null
     or coalesce(v_slug, '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'DADOS_DA_BARBEARIA_INVALIDOS';
  end if;

  insert into public.barbershops(name, slug, address, phone)
  values(trim(p_name), v_slug, nullif(trim(p_address), ''), nullif(trim(p_phone), ''))
  returning id into v_shop_id;

  insert into public.barbershop_members(barbershop_id, user_id)
  values(v_shop_id, auth.uid())
  on conflict do nothing;

  insert into public.barbershop_invites(
    barbershop_id, role, token_hash, expires_at, created_by
  )
  values(
    v_shop_id, 'manager', encode(digest(v_token, 'sha256'), 'hex'),
    now() + interval '14 days', auth.uid()
  );

  return query select v_shop_id, trim(p_name), v_slug, v_token;
end;
$$;

create or replace function public.create_professional_invite(
  p_barbershop_id uuid,
  p_professional_name text
)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_token text := encode(gen_random_bytes(32), 'hex');
begin
  if auth.uid() is null
     or nullif(trim(p_professional_name), '') is null
     or not exists (
       select 1 from public.profiles me
       where me.id = auth.uid() and me.role in ('manager', 'super_admin')
     )
     or (
       not public.is_member(p_barbershop_id)
       and not exists (
         select 1 from public.profiles me
         where me.id = auth.uid() and me.role = 'super_admin'
       )
     )
     or not exists (
       select 1 from public.barbershops b
       where b.id = p_barbershop_id and b.status = 'active'
     ) then
    raise exception 'SEM_PERMISSAO_OU_DADOS_INVALIDOS_PARA_CONVIDAR_PROFISSIONAL';
  end if;

  insert into public.barbershop_invites(
    barbershop_id, role, invited_name, token_hash, expires_at, created_by
  )
  values(
    p_barbershop_id, 'professional', trim(p_professional_name),
    encode(digest(v_token, 'sha256'), 'hex'), now() + interval '14 days', auth.uid()
  );

  return v_token;
end;
$$;

create or replace function public.create_manager_invite(p_barbershop_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_token text := encode(gen_random_bytes(32), 'hex');
begin
  if auth.uid() is null
     or not exists (
       select 1 from public.profiles p
       where p.id = auth.uid() and p.role = 'super_admin'
     )
     or not exists (
       select 1 from public.barbershops b
       where b.id = p_barbershop_id and b.status = 'active'
     ) then
    raise exception 'SEM_PERMISSAO_OU_BARBEARIA_INVALIDA_PARA_CONVIDAR_GESTOR';
  end if;

  insert into public.barbershop_invites(
    barbershop_id, role, token_hash, expires_at, created_by
  )
  values(
    p_barbershop_id, 'manager', encode(digest(v_token, 'sha256'), 'hex'),
    now() + interval '14 days', auth.uid()
  );

  return v_token;
end;
$$;

create or replace function public.claim_barbershop_invite(p_token text)
returns table(role public.user_role, barbershop_name text, slug text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_invite public.barbershop_invites;
  v_profile public.profiles;
  v_shop public.barbershops;
begin
  if auth.uid() is null then
    raise exception 'LOGIN_NECESSARIO';
  end if;
  if length(coalesce(p_token, '')) <> 64 then
    raise exception 'CONVITE_INVALIDO_OU_EXPIRADO';
  end if;

  select i.* into v_invite
  from public.barbershop_invites i
  where i.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and i.claimed_at is null
    and i.expires_at > now()
  for update;
  if not found then
    raise exception 'CONVITE_INVALIDO_OU_EXPIRADO_JA_UTILIZADO';
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

  select p.* into v_profile from public.profiles p where p.id = auth.uid() for update;
  if not found then
    raise exception 'PERFIL_DO_USUARIO_NAO_ENCONTRADO';
  end if;
  if v_invite.role = 'manager' and v_profile.role not in ('client', 'manager', 'super_admin') then
    raise exception 'PERFIL_NAO_PODE_ASSUMIR_GESTAO';
  end if;
  if v_invite.role = 'professional' and v_profile.role not in ('client', 'professional') then
    raise exception 'PERFIL_NAO_PODE_ASSUMIR_FUNCAO_PROFISSIONAL';
  end if;
  if v_invite.role = 'professional' and exists (
    select 1 from public.professionals p where p.id = auth.uid()
  ) then
    raise exception 'USUARIO_JA_CADASTRADO_COMO_PROFISSIONAL';
  end if;

  select b.* into v_shop from public.barbershops b
  where b.id = v_invite.barbershop_id and b.status = 'active';
  if not found then
    raise exception 'BARBEARIA_INDISPONIVEL';
  end if;

  update public.profiles as target_profile
  set full_name = coalesce(v_invite.invited_name, target_profile.full_name),
      role = case
        when target_profile.role = 'super_admin' then target_profile.role
        else v_invite.role
      end
  where target_profile.id = auth.uid();

  insert into public.barbershop_members(barbershop_id, user_id)
  values(v_invite.barbershop_id, auth.uid())
  on conflict do nothing;

  if v_invite.role = 'professional' then
    insert into public.professionals(id, barbershop_id, active)
    values(auth.uid(), v_invite.barbershop_id, true);
  end if;

  update public.barbershop_invites
  set claimed_at = now(), claimed_by = auth.uid()
  where id = v_invite.id;

  return query select v_invite.role, v_shop.name, v_shop.slug;
end;
$$;

revoke all on function public.list_my_barbershops() from public, anon;
grant execute on function public.list_my_barbershops() to authenticated;
revoke all on function public.create_barbershop_with_manager_invite(text, text, text, text) from public, anon;
grant execute on function public.create_barbershop_with_manager_invite(text, text, text, text) to authenticated;
revoke all on function public.create_professional_invite(uuid, text) from public, anon;
grant execute on function public.create_professional_invite(uuid, text) to authenticated;
revoke all on function public.create_manager_invite(uuid) from public, anon;
grant execute on function public.create_manager_invite(uuid) to authenticated;
revoke all on function public.claim_barbershop_invite(text) from public, anon;
grant execute on function public.claim_barbershop_invite(text) to authenticated;

notify pgrst, 'reload schema';
