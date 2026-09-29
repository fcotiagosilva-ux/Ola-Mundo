# SuaBarbeariaAqui

Protótipo mobile-first de um SaaS para gestão e agendamento de barbearias.

## Executar

Abra [`site-exemplo/index.html`](./site-exemplo/index.html) no navegador. O frontend é estático e não depende de build ou instalação. A agenda de agendamento lê serviços e disponibilidade real do Supabase.

## Backend Supabase

[`supabase/schema.sql`](./supabase/schema.sql) contém a modelagem multi-tenant completa, políticas RLS, disponibilidade e a função `create_appointment`. A constraint `appointments_no_overlap` usa um exclusion constraint do PostgreSQL para rejeitar duas reservas sobrepostas para o mesmo profissional mesmo sob concorrência.

Para produção, execute o schema no SQL Editor do Supabase. O frontend está configurado com a URL e a chave publishable/anon em [`site-exemplo/supabase-config.js`](./site-exemplo/supabase-config.js). Nunca exponha a service role key no cliente.

### Ativar agendamento real

1. Execute `supabase/public-booking-read-policies.sql` (caso ainda não esteja aplicado).
2. Execute `supabase/booking-runtime.sql` para criar RPCs de profissionais ativos, horários disponíveis e confirmação segura. O script também repara perfis ausentes de usuários Auth existentes, sem conceder privilégios.
3. Execute `supabase/operations-runtime.sql` para ativar agenda, métricas protegidas, relatórios de serviços e cancelamento por regra de antecedência. O script solicita a atualização do cache de schema da API ao terminar.
4. Execute `supabase/tenant-onboarding-runtime.sql` para habilitar criação protegida de unidades, convites de gestor/profissional de uso único e o link de agendamento por unidade.
5. Abra `site-exemplo/index.html`, clique em **Novo agendamento**, escolha uma unidade e siga os horários disponíveis. O cliente precisa entrar ou criar conta para confirmar.

O painel mostra dados reais e permanece vazio/indisponível quando não há sessão, registros ou permissão. Clientes veem somente seus agendamentos; profissionais veem apenas sua própria agenda; métricas financeiras ficam restritas aos perfis `manager` e `super_admin`.

No formulário de autenticação, o usuário informa se é cliente ou se tem uma barbearia. Essa escolha nos metadados da conta não concede permissões. Os links de convite, emitidos por usuários autorizados, expiram em 14 dias e só podem ser usados uma vez; quem recebe o link pode reivindicar o convite, então compartilhe-o somente com o destinatário correto.

Se a API retornar `Could not find the function ... in the schema cache` após aplicar uma migração, execute `NOTIFY pgrst, 'reload schema';` no SQL Editor e recarregue o site.

## Publicação e e-mail

- A configuração [netlify.toml](./netlify.toml) publica `site-exemplo/` como site estático com cabeçalhos básicos de segurança. O projeto está publicado em https://barberly-kings.netlify.app e conectado à branch `main`.
- Em Supabase **Authentication → URL Configuration**, defina `https://barberly-kings.netlify.app` como Site URL e inclua `https://barberly-kings.netlify.app/**` em Redirect URLs para os convites de cadastro e confirmação de e-mail.
- Para confirmação confiável de e-mail em produção, configure SMTP próprio em **Project Settings → Authentication → SMTP Settings** e teste signup/reset. Não coloque senha SMTP ou `service_role` no repositório.
- Antes do lançamento, execute também `supabase/operations-runtime.sql`; ele ativa lista de agendamentos, cancelamento dentro das regras, métricas e relatórios com acesso restrito.
- Execute `supabase/tenant-onboarding-runtime.sql` após as demais migrações para liberar os controles de onboarding protegidos por perfil.

## Ativação do ambiente

1. Execute `supabase/schema.sql` no SQL Editor.
2. Em **Authentication > Users**, crie o usuário inicial com e-mail e senha.
3. Copie o UUID desse usuário e execute `supabase/seed.sql`, substituindo os placeholders.
4. Confirme que o navegador mostra **Supabase conectado**.
5. Cadastre profissionais e serviços usando os UUIDs da barbearia.

Para o usuário Tiaguim já criado, execute [register-professional-tiaguim.sql](./supabase/register-professional-tiaguim.sql) no SQL Editor para vinculá-lo à Barbearia Kings.

Para inserir os quatro serviços iniciais e vinculá-los ao Tiaguim, execute [seed-services-kings.sql](./supabase/seed-services-kings.sql).

Se o seed tiver sido executado mais de uma vez, execute [fix-kings-catalog-and-hours.sql](./supabase/fix-kings-catalog-and-hours.sql) para remover duplicidades, vincular o catálogo e configurar o horário padrão de segunda a sábado, das 09:00 às 18:00.

Se precisar reaplicar somente os vínculos de serviços do Tiaguim, execute [link-tiaguim-services.sql](./supabase/link-tiaguim-services.sql); a consulta final confirma cada vínculo.

Se o SQL Editor confirmar os vínculos mas a API REST pública retornar vazio, execute [public-booking-read-policies.sql](./supabase/public-booking-read-policies.sql) para conceder leitura pública limitada a profissionais, serviços e barbearias ativas.

O arquivo `seed.sql` é deliberadamente um template: não há como criar usuários do Supabase Auth usando a chave pública do navegador. A `service_role` só deve ser usada em um ambiente administrativo seguro, nunca no frontend.
