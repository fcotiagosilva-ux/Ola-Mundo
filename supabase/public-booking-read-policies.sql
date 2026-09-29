-- Leitura pública limitada a profissionais, serviços e barbearias ativas.
grant select on public.professional_services to anon, authenticated;
grant select on public.professional_availability to anon, authenticated;

alter table public.professional_services enable row level security;
alter table public.professional_availability enable row level security;

drop policy if exists "public read active professional services" on public.professional_services;
create policy "public read active professional services"
  on public.professional_services for select to anon, authenticated
  using (
    exists (
      select 1
      from public.professionals p
      join public.barbershops b on b.id = p.barbershop_id
      join public.services s on s.id = professional_services.service_id
      where p.id = professional_services.professional_id
        and s.barbershop_id = p.barbershop_id
        and p.active and s.active and b.status = 'active'
    )
  );

drop policy if exists "public read active professional availability" on public.professional_availability;
create policy "public read active professional availability"
  on public.professional_availability for select to anon, authenticated
  using (
    exists (
      select 1
      from public.professionals p
      join public.barbershops b on b.id = p.barbershop_id
      where p.id = professional_availability.professional_id
        and p.active and b.status = 'active'
    )
  );
