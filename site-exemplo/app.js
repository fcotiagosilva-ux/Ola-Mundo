const config = window.BARBERLY_CONFIG;
const projectUrl = config.supabaseUrl.replace(/\/rest\/v1\/?$/, '');
const apiBase = `${projectUrl}/rest/v1`;
const authBase = `${projectUrl}/auth/v1`;
const statusElement = document.querySelector('#supabase-status');
const toast = document.querySelector('#toast');
const bookingForm = document.querySelector('#booking-form');
const bookingModal = document.querySelector('#booking-modal');
const authModal = document.querySelector('#auth-modal');
const shopModal = document.querySelector('#shop-modal');
const inviteModal = document.querySelector('#invite-modal');
const clientLinkModal = document.querySelector('#client-link-modal');
const serviceModal = document.querySelector('#service-modal');
const hoursModal = document.querySelector('#hours-modal');
const bookingFeedback = document.querySelector('#booking-feedback');
const authFeedback = document.querySelector('#auth-feedback');
const bookingShop = document.querySelector('#booking-shop');
const bookingProfessional = document.querySelector('#booking-professional');
const bookingService = document.querySelector('#booking-service');
const bookingDate = document.querySelector('#booking-date');
const bookingTime = document.querySelector('#booking-time');
const bookingSubmit = document.querySelector('#booking-submit');
const authButton = document.querySelector('#auth-trigger');
const appointmentTable = document.querySelector('#appointment-table');
const agendaItems = document.querySelector('#agenda-items');
const agendaMessage = document.querySelector('#agenda-message');
const labels = {overview:'Visão geral',agenda:'Agenda',shops:'Barbearias',registers:'Cadastros',appointments:'Agendamentos',reports:'Relatórios'};
const appointmentsById = new Map();
let session = readSession();
let shops = [];
let loadedAppointments = [];
let selectedAppointmentSlot = null;
let authMode = 'signin';
let registerType = 'professionals';
let registerShops = [];
let registerRows = [];
let profileRecord = null;
let managedShops = [];
let pendingInviteToken = new URLSearchParams(window.location.search).get('invite');
let requestedShopSlug = new URLSearchParams(window.location.search).get('barbershop');
let linkedRequestedShop = null;
let inviteInProgress = false;

function readSession() {
  try {
    return JSON.parse(localStorage.getItem('barberly-session') || 'null');
  } catch {
    return null;
  }
}

function slugify(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function inviteSignupUrl(token) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('invite', token);
  return url.toString();
}

async function copyInputValue(inputId, button) {
  const input = document.querySelector(`#${inputId}`);
  try {
    await navigator.clipboard.writeText(input.value);
    showToast('Link copiado.');
  } catch (error) {
    input.focus();
    input.select();
    const copied = document.execCommand('copy');
    if (!copied) {
      showToast('Não foi possível copiar. Selecione e copie o link manualmente.', true);
      return;
    }
    showToast('Link copiado.');
  }
  button.disabled = true;
  window.setTimeout(() => { button.disabled = false; }, 1000);
}

async function processPendingInvite() {
  if (!session?.access_token || !pendingInviteToken || inviteInProgress) return false;
  inviteInProgress = true;
  try {
    const result = await supabaseRequest('rpc/claim_barbershop_invite', {
      method:'POST',
      body:JSON.stringify({p_token:pendingInviteToken})
    });
    const invite = Array.isArray(result) ? result[0] : result;
    pendingInviteToken = null;
    registerShops = [];
    const url = new URL(window.location.href);
    url.searchParams.delete('invite');
    window.history.replaceState({}, '', url);
    await loadOperationalData();
    showToast(`Cadastro vinculado à ${invite.barbershop_name}.`);
    return true;
  } catch (error) {
    setFeedback(authFeedback, `Não foi possível usar o convite: ${error.message}`, true);
    openModal(authModal);
    return false;
  } finally {
    inviteInProgress = false;
  }
}

function setInviteLink(inputId, token) {
  document.querySelector(`#${inputId}`).value = inviteSignupUrl(token);
}

function saveSession(value) {
  session = value;
  registerShops = [];
  if (!value) profileRecord = null;
  if (value) localStorage.setItem('barberly-session', JSON.stringify(value));
  else localStorage.removeItem('barberly-session');
  updateAuthButton();
  updateIdentity();
  if (value) {
    loadOperationalData().catch(error => {
      showToast(`Não foi possível carregar os dados da conta: ${error.message}`, true);
      console.error('Falha ao carregar os dados da conta autenticada.', error);
    });
  }
  else clearOperationalData();
}

async function handleAuthCallback() {
  if (!window.location.hash) return false;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const errorDescription = params.get('error_description');
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const type = params.get('type');
  if (!errorDescription && (!accessToken || !refreshToken || type !== 'signup')) return false;

  window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
  if (errorDescription) {
    setAuthMode('signin');
    openAuth();
    setFeedback(authFeedback, `Não foi possível confirmar o e-mail: ${errorDescription}`, true);
    return true;
  }

  try {
    const user = await request(`${authBase}/user`, {}, accessToken);
    saveSession({
      access_token:accessToken,
      refresh_token:refreshToken,
      token_type:params.get('token_type') || 'bearer',
      expires_in:Number(params.get('expires_in') || 3600),
      user
    });
    if (pendingInviteToken) {
      await processPendingInvite();
    } else {
      await loadIdentity();
      await ensureRequestedClientShopLink();
      if (bookingModal.classList.contains('open')) await loadShops();
      showToast('E-mail confirmado. Sua conta está conectada.');
    }
  } catch (error) {
    setAuthMode('signin');
    openAuth();
    setFeedback(authFeedback, `E-mail confirmado, mas não foi possível iniciar a sessão: ${error.message}`, true);
    console.error('Falha ao concluir a sessão após confirmar o e-mail.', error);
  }
  return true;
}

async function request(url, options = {}, token = session?.access_token || config.supabaseAnonKey) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.msg || body?.message || `Supabase respondeu HTTP ${response.status}`;
    const details = body?.details ? ` (${body.details})` : '';
    const hint = body?.hint ? ` Dica: ${body.hint}` : '';
    const error = new Error(`${message}${details}${hint}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function supabaseRequest(path, options = {}) {
  try {
    return await request(`${apiBase}/${path}`, options);
  } catch (error) {
    if (error.status !== 401 || !session?.refresh_token) throw error;
    const refreshed = await request(`${authBase}/token?grant_type=refresh_token`, {
      method:'POST', body:JSON.stringify({refresh_token:session.refresh_token})
    }, config.supabaseAnonKey);
    saveSession(refreshed);
    return request(`${apiBase}/${path}`, options);
  }
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[char]);
}

function currency(value) {
  return Number(value || 0).toLocaleString('pt-BR', {style:'currency',currency:'BRL'});
}

function localDate(dateValue) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone:'America/Sao_Paulo', day:'2-digit', month:'short', year:'numeric'
  }).format(new Date(dateValue));
}

function localTime(dateValue) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone:'America/Sao_Paulo', hour:'2-digit', minute:'2-digit', hour12:false
  }).format(new Date(dateValue));
}

function localDay(dateValue) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(new Date(dateValue));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function localToday() {
  return localDay(new Date());
}

function showToast(message, isError = false) {
  toast.textContent = `${isError ? '!' : '✓'} ${message}`;
  toast.classList.toggle('error-toast', isError);
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 4000);
}

function setFeedback(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('feedback-error', isError);
}

function updateAuthButton() {
  authButton.textContent = session?.user?.email ? 'Sair' : 'Entrar';
  bookingSubmit.textContent = session ? 'Confirmar agendamento' : 'Entrar para agendar';
}

function updateIdentity() {
  const accountEmail = session?.user?.email?.trim().toLowerCase();
  document.body.classList.toggle('barberking-background', accountEmail === 'barberking380@gmail.com');
  const roleLabels = {client:'Cliente',professional:'Profissional',manager:'Gestor',super_admin:'Super administrador'};
  const role = roleLabels[profileRecord?.role] || (session ? 'Conta autenticada' : 'Não conectado');
  const accountName = profileRecord?.full_name || session?.user?.user_metadata?.full_name || session?.user?.email || 'Visitante';
  const name = profileRecord?.role === 'manager' && managedShops.length
    ? managedShops[0].name : accountName;
  const initials = name.split(/\s+/).slice(0,2).map(part => part[0]).join('').toUpperCase();
  document.querySelector('#welcome-heading').innerHTML = `${escapeText(session ? name : 'Visão da operação')} <span>✦</span>`;
  document.querySelector('#current-date').textContent = new Intl.DateTimeFormat('pt-BR', {
    timeZone:'America/Sao_Paulo', weekday:'long', day:'2-digit', month:'long', year:'numeric'
  }).format(new Date()).toLocaleUpperCase('pt-BR');
  document.querySelector('#workspace-name').textContent = name;
  document.querySelector('#workspace-role').textContent = role;
  document.querySelector('#workspace-avatar').textContent = initials || '?';
  document.querySelector('#profile-avatar').textContent = initials || '?';
  document.querySelector('.profile b').textContent = name;
  document.querySelector('.profile small').textContent = role;
  document.querySelector('#add-shop').hidden = profileRecord?.role !== 'super_admin';
  const canManageCatalog = ['manager','super_admin'].includes(profileRecord?.role);
  document.querySelector('#add-service').hidden = !canManageCatalog;
  document.querySelector('#manage-hours').hidden = !canManageCatalog;
}

async function loadIdentity() {
  if (!session?.user?.id) {
    profileRecord = null;
    updateIdentity();
    return;
  }
  try {
    const rows = await supabaseRequest(`profiles?select=full_name,role&id=eq.${encodeURIComponent(session.user.id)}&limit=1`);
    profileRecord = rows[0] || null;
    if (profileRecord?.role === 'manager' || profileRecord?.role === 'super_admin') {
      managedShops = await supabaseRequest('rpc/list_my_barbershops', {method:'POST',body:'{}'});
    } else {
      managedShops = [];
    }
    updateIdentity();
  } catch (error) {
    profileRecord = null;
    managedShops = [];
    updateIdentity();
    console.error('Falha ao carregar o perfil autenticado.', error);
  }
}

async function checkConnection() {
  try {
    await supabaseRequest('barbershops?select=id&limit=1');
    statusElement.textContent = 'Supabase conectado';
    statusElement.classList.add('connected');
  } catch (error) {
    statusElement.textContent = 'Supabase indisponível';
    statusElement.classList.add('error');
    console.error('Falha ao consultar o Supabase.', error);
  }
}

function clearOperationalData() {
  loadedAppointments = [];
  appointmentsById.clear();
  appointmentTable.innerHTML = '<tr><td colspan="7">Entre na sua conta para consultar agendamentos reais.</td></tr>';
  agendaItems.replaceChildren();
  agendaMessage.textContent = 'Entre com uma conta da equipe para consultar a agenda.';
  document.querySelectorAll('.metric-card strong').forEach(element => { element.textContent = '—'; });
  document.querySelector('#upcoming-list').innerHTML = '<p class="empty-state">Entre para ver os próximos agendamentos.</p>';
  document.querySelector('.chart-panel .chart').innerHTML = '<p class="empty-state">Entre com uma conta da equipe para consultar métricas reais.</p>';
  document.querySelector('.bottom-grid .shop-list').innerHTML = '<p class="empty-state">Entre com uma conta da equipe para consultar suas unidades.</p>';
  document.querySelector('.report-cards').innerHTML = '<article class="report-card"><strong>Relatórios protegidos</strong><p>Entre com uma conta vinculada a uma barbearia para consultar valores reais.</p></article>';
  document.querySelectorAll('.metric-card .positive,.metric-card .negative,.metric-card .sparkline').forEach(element => element.remove());
}

async function loadOperationalData() {
  if (!session?.access_token) {
    clearOperationalData();
    return;
  }
  await loadIdentity();
  await ensureRequestedClientShopLink();
  await Promise.all([loadAppointments(), loadDashboard()]);
}

async function ensureRequestedClientShopLink() {
  const linkKey = `${session?.user?.id}:${requestedShopSlug}`;
  if (profileRecord?.role !== 'client' || !requestedShopSlug || linkedRequestedShop === linkKey) return;
  const result = await supabaseRequest('rpc/claim_client_barbershop_link', {
    method:'POST',
    body:JSON.stringify({p_slug:requestedShopSlug})
  });
  const linkedShop = Array.isArray(result) ? result[0] : result;
  if (!linkedShop?.id) {
    throw new Error('A barbearia deste link não está disponível.');
  }
  linkedRequestedShop = linkKey;
}

async function loadAccessibleBarbershops() {
  if (!session?.access_token) {
    return supabaseRequest('barbershops?select=id,name,slug,phone,address,city,status&status=eq.active&order=name');
  }
  if (!profileRecord) return [];

  if (profileRecord.role === 'client') {
    await ensureRequestedClientShopLink();
    const links = await supabaseRequest('rpc/list_my_client_barbershops', {
      method:'POST', body:'{}'
    });
    const linkedIds = links.filter(shop => shop.status === 'active').map(shop => shop.id);
    if (!linkedIds.length) return [];
    const filter = `(${linkedIds.join(',')})`;
    return supabaseRequest(
      `barbershops?select=id,name,slug,phone,address,city,status&id=in.${encodeURIComponent(filter)}&status=eq.active&order=name`
    );
  }

  if (['manager','professional','super_admin'].includes(profileRecord.role)) {
    return supabaseRequest('rpc/list_my_barbershops', {method:'POST',body:'{}'});
  }

  return [];
}

async function loadDashboard() {
  const metrics = document.querySelectorAll('.metric-card strong');
  try {
    managedShops = await supabaseRequest('rpc/list_my_barbershops', {method:'POST',body:'{}'});
    updateIdentity();
    const shopList = document.querySelector('.bottom-grid .shop-list');
    if (!managedShops.length) {
      metrics.forEach(element => { element.textContent = '—'; });
      shopList.innerHTML = '<p class="empty-state">Sua conta não tem uma barbearia vinculada para exibir métricas.</p>';
      document.querySelector('.chart-panel .chart').innerHTML = '<p class="empty-state">As análises serão exibidas quando houver atendimentos registrados.</p>';
      document.querySelector('.report-cards').innerHTML = '<article class="report-card"><strong>Relatórios indisponíveis</strong><p>Esta conta não está vinculada a uma equipe de barbearia.</p></article>';
      return;
    }
    const shop = managedShops[0];
    const result = await supabaseRequest('rpc/barbershop_dashboard_metrics', {
      method:'POST', body:JSON.stringify({p_barbershop_id:shop.id})
    });
    const summary = Array.isArray(result) ? result[0] : result;
    metrics[0].textContent = currency(summary?.revenue_today);
    metrics[1].textContent = currency(summary?.revenue_month);
    metrics[2].textContent = Number(summary?.appointments_month || 0).toLocaleString('pt-BR');
    metrics[3].textContent = Number(summary?.active_clients_month || 0).toLocaleString('pt-BR');
    metrics[4].textContent = currency(summary?.average_ticket_month);
    shopList.innerHTML = `<div class="shop-row"><span class="shop-logo">BK</span><div><b>${escapeText(shop.name)}</b><small>Métricas reais do Supabase</small></div><strong>${currency(summary?.revenue_month)}<small> faturados no mês</small></strong><span class="status active">Ativa</span></div>`;
    document.querySelector('.chart-panel .chart').innerHTML = '<p class="empty-state">O gráfico será preenchido conforme os atendimentos forem concluídos.</p>';
    document.querySelectorAll('.metric-card .positive,.metric-card .negative,.metric-card .sparkline').forEach(element => element.remove());
    await loadReports(shop.id);
  } catch (error) {
    metrics.forEach(element => { element.textContent = '—'; });
    document.querySelector('.bottom-grid .shop-list').innerHTML = '<p class="empty-state">Métricas financeiras disponíveis somente para gestores da unidade.</p>';
    document.querySelector('.chart-panel .chart').innerHTML = '<p class="empty-state">Sua conta não tem permissão para acessar o relatório financeiro.</p>';
    document.querySelector('.report-cards').innerHTML = '<article class="report-card"><strong>Acesso restrito</strong><p>Relatórios financeiros são restritos a gestores e super administradores.</p></article>';
    console.error('Falha ao carregar as métricas operacionais.', error);
  }
}

async function loadReports(shopId) {
  try {
    const rows = await supabaseRequest('rpc/barbershop_service_report', {
      method:'POST', body:JSON.stringify({p_barbershop_id:shopId})
    });
    const completed = rows.filter(row => Number(row.completed_count) > 0);
    document.querySelector('.report-cards').innerHTML = completed.length
      ? completed.slice(0,6).map(row => `<article class="report-card"><small>Serviço concluído no mês</small><strong>${escapeText(row.service_name)}</strong><p>${Number(row.completed_count)} atendimento(s)<b>${currency(row.completed_revenue)}</b></p></article>`).join('')
      : '<article class="report-card"><small>Relatório do mês</small><strong>Sem atendimentos concluídos</strong><p>Os valores aparecerão quando serviços forem marcados como concluídos.</p></article>';
  } catch (error) {
    document.querySelector('.report-cards').innerHTML = `<article class="report-card"><strong>Relatório indisponível</strong><p>${escapeText(error.message)}</p></article>`;
  }
}

async function loadAppointments() {
  if (!session?.access_token) return;
  try {
    loadedAppointments = await supabaseRequest('rpc/list_my_appointments', {method:'POST',body:'{}'});
    appointmentsById.clear();
    loadedAppointments.forEach(item => appointmentsById.set(item.id, item));
    renderAppointments();
    renderAgenda();
    renderUpcoming();
  } catch (error) {
    appointmentTable.innerHTML = `<tr><td colspan="7">${escapeText(error.message)}</td></tr>`;
    agendaMessage.textContent = `Não foi possível carregar a agenda: ${error.message}`;
    console.error('Falha ao carregar agendamentos.', error);
  }
}

function renderAppointments() {
  const status = document.querySelector('#appointment-status-filter').value;
  const query = document.querySelector('#appointment-search').value.trim().toLocaleLowerCase('pt-BR');
  const result = loadedAppointments.filter(item => (!status || item.status === status)
    && (!query || [item.client_name,item.professional_name,item.service_name]
      .some(value => value?.toLocaleLowerCase('pt-BR').includes(query))));
  if (!result.length) {
    appointmentTable.innerHTML = '<tr><td colspan="7">Nenhum agendamento encontrado.</td></tr>';
    return;
  }
  const statusLabels = {pending:'Pendente',confirmed:'Confirmado',completed:'Concluído',cancelled:'Cancelado',no_show:'Não compareceu'};
  const canManageAppointments = ['manager','super_admin'].includes(profileRecord?.role);
  appointmentTable.innerHTML = result.map(item => {
    const canCancel = item.can_cancel && ['pending','confirmed'].includes(item.status);
    const canComplete = canManageAppointments
      && ['pending','confirmed'].includes(item.status)
      && new Date(item.ends_at).getTime() <= Date.now();
    const statusClass = item.status === 'confirmed' || item.status === 'completed' ? 'confirmed'
      : item.status === 'cancelled' ? 'paused' : 'pending';
    const actions = [
      canComplete
        ? `<button class="complete-appointment" data-appointment-id="${escapeText(item.id)}">Concluído</button>` : '',
      canCancel
        ? `<button class="cancel-appointment" data-appointment-id="${escapeText(item.id)}">Cancelar</button>` : ''
    ].filter(Boolean).join(' ');
    return `<tr><td><b>${escapeText(item.client_name)}</b></td><td>${localDate(item.starts_at)} · ${localTime(item.starts_at)}</td><td>${escapeText(item.professional_name)}</td><td>${escapeText(item.service_name)}</td><td><span class="status ${statusClass}">${statusLabels[item.status] || escapeText(item.status)}</span></td><td>${currency(item.price)}</td><td>${actions}</td></tr>`;
  }).join('');
}

function renderAgenda() {
  const date = document.querySelector('#agenda-date').value;
  const dayItems = loadedAppointments.filter(item => localDay(item.starts_at) === date
    && ['pending','confirmed'].includes(item.status));
  agendaItems.innerHTML = dayItems.map(item => `<div class="agenda-booking"><b>${localTime(item.starts_at)}–${localTime(item.ends_at)}</b><span>${escapeText(item.client_name)} · ${escapeText(item.service_name)}</span><small>${escapeText(item.professional_name)} · ${currency(item.price)}</small></div>`).join('');
  agendaMessage.textContent = dayItems.length ? `${dayItems.length} atendimento(s) neste dia.` : 'Nenhum atendimento agendado para esta data.';
}

function renderUpcoming() {
  const future = loadedAppointments
    .filter(item => ['pending','confirmed'].includes(item.status) && new Date(item.starts_at) >= new Date())
    .slice(0,4);
  document.querySelector('#upcoming-list').innerHTML = future.length
    ? future.map(item => `<div class="appointment"><span class="time">${localTime(item.starts_at)}<small>${localDate(item.starts_at)}</small></span><i class="line"></i><div><b>${escapeText(item.client_name)}</b><p>${escapeText(item.service_name)} · ${escapeText(item.professional_name)}</p></div></div>`).join('')
    : '<p class="empty-state">Nenhum próximo agendamento.</p>';
}

async function loadShopDirectory() {
  const container = document.querySelector('.shop-cards');
  try {
    if (session?.access_token && !profileRecord) await loadIdentity();
    const rows = await loadAccessibleBarbershops();
    const query = document.querySelector('#shop-search').value.trim().toLocaleLowerCase('pt-BR');
    const filtered = rows.filter(shop => !query || `${shop.name} ${shop.address || ''} ${shop.city || ''}`.toLocaleLowerCase('pt-BR').includes(query));
    document.querySelector('#shop-count').textContent = `${filtered.length} unidade(s) ativa(s)`;
    container.innerHTML = filtered.length
      ? filtered.map(shop => {
        const canManage = ['manager','super_admin'].includes(profileRecord?.role);
        const actions = canManage
          ? `<div class="shop-actions"><button class="outline-btn share-client-link" data-shop-slug="${escapeText(shop.slug)}">Link para clientes</button><button class="outline-btn invite-professional" data-shop-id="${escapeText(shop.id)}" data-shop-name="${escapeText(shop.name)}">＋ Profissional</button></div>`
          : '';
        const managerLink = profileRecord?.role === 'super_admin'
          ? `<button class="text-btn invite-manager" data-shop-id="${escapeText(shop.id)}" data-shop-name="${escapeText(shop.name)}">Gerar link para gestor</button>` : '';
        return `<article class="shop-card"><div class="shop-card-head"><span class="shop-logo">${escapeText(shop.name.slice(0,2).toUpperCase())}</span><span class="status active">Ativa</span></div><h3>${escapeText(shop.name)}</h3><p>${escapeText(shop.address || shop.city || 'Endereço não informado')}${shop.phone ? ` · ${escapeText(shop.phone)}` : ''}</p><div class="shop-stats"><span><b>/${escapeText(shop.slug)}</b><small>link público da unidade</small></span></div>${actions}${managerLink}</article>`;
      }).join('')
      : `<article class="shop-card"><p>${session?.access_token ? 'Nenhuma barbearia vinculada a esta conta. Acesse pelo link da barbearia ou solicite um convite.' : 'Nenhuma barbearia ativa encontrada.'}</p></article>`;
  } catch (error) {
    container.innerHTML = `<article class="shop-card"><p>${escapeText(error.message)}</p></article>`;
  }
}

async function loadShopProfessionals(barbershopId) {
  return supabaseRequest('rpc/list_active_professionals', {
    method:'POST',
    body:JSON.stringify({p_barbershop_id:barbershopId})
  });
}

function renderScheduleDays(rows = []) {
  const existing = new Map(rows.map(row => [Number(row.weekday), row]));
  const days = [
    ['Domingo',0],['Segunda-feira',1],['Terça-feira',2],['Quarta-feira',3],
    ['Quinta-feira',4],['Sexta-feira',5],['Sábado',6]
  ];
  document.querySelector('#schedule-days').innerHTML = days.map(([name, weekday]) => {
    const row = existing.get(weekday);
    const start = row?.start_time?.slice(0,5) || '09:00';
    const end = row?.end_time?.slice(0,5) || '18:00';
    return `<div class="schedule-day"><label class="schedule-enabled"><input type="checkbox" data-weekday="${weekday}" ${row ? 'checked' : ''}><span>${name}</span></label><label>Abre<input type="time" data-start="${weekday}" value="${start}" ${row ? 'required' : 'disabled'}></label><label>Fecha<input type="time" data-end="${weekday}" value="${end}" ${row ? 'required' : 'disabled'}></label></div>`;
  }).join('');
}

async function loadProfessionalSchedule(professionalId) {
  const feedback = document.querySelector('#schedule-feedback');
  const submit = document.querySelector('#schedule-form button[type="submit"]');
  if (!professionalId) {
    renderScheduleDays();
    submit.disabled = true;
    setFeedback(feedback, 'Selecione um profissional.');
    return;
  }
  try {
    const rows = await supabaseRequest(
      `professional_availability?select=weekday,start_time,end_time&professional_id=eq.${encodeURIComponent(professionalId)}&order=weekday,start_time`
    );
    const weekdayCounts = new Map();
    rows.forEach(row => weekdayCounts.set(row.weekday, (weekdayCounts.get(row.weekday) || 0) + 1));
    if ([...weekdayCounts.values()].some(count => count > 1)) {
      throw new Error('Este profissional possui mais de um período em algum dia. A tela permite um período por dia; ajuste esses intervalos antes de salvar.');
    }
    renderScheduleDays(rows);
    submit.disabled = false;
    setFeedback(feedback, '');
  } catch (error) {
    renderScheduleDays();
    submit.disabled = true;
    setFeedback(feedback, `Não foi possível carregar os horários: ${error.message}`, true);
  }
}

async function loadRegisters() {
  const table = document.querySelector('#register-table');
  const shopSelect = document.querySelector('#register-shop');
  table.innerHTML = '<tr><td>Carregando...</td></tr>';
  try {
    if (!registerShops.length) {
      if (session?.access_token && !profileRecord) await loadIdentity();
      registerShops = await loadAccessibleBarbershops();
      shopSelect.replaceChildren(...registerShops.map(shop => new Option(shop.name, shop.id)));
    }
    if (!shopSelect.value) {
      table.innerHTML = '<tr><td>Nenhuma barbearia vinculada a esta conta.</td></tr>';
      return;
    }
    registerRows = registerType === 'professionals'
      ? await supabaseRequest('rpc/list_active_professionals', {method:'POST',body:JSON.stringify({p_barbershop_id:shopSelect.value})})
      : await supabaseRequest(`services?select=id,name,price,duration_minutes,active&barbershop_id=eq.${encodeURIComponent(shopSelect.value)}&active=eq.true&order=name`);
    renderRegisters();
  } catch (error) {
    table.innerHTML = `<tr><td>${escapeText(error.message)}</td></tr>`;
  }
}

function renderRegisters() {
  const table = document.querySelector('#register-table');
  const query = document.querySelector('#register-search').value.trim().toLocaleLowerCase('pt-BR');
  const filtered = registerRows.filter(row => {
    const searchable = registerType === 'professionals' ? row.full_name : row.name;
    return (searchable || '').toLocaleLowerCase('pt-BR').includes(query);
  });
  if (registerType === 'professionals') {
    document.querySelector('#register-head').innerHTML = '<tr><th>PROFISSIONAL</th><th>STATUS</th></tr>';
    table.innerHTML = filtered.length
      ? filtered.map(row => `<tr><td><span class="avatar barber-a">${escapeText(row.full_name.slice(0,2).toUpperCase())}</span><b>${escapeText(row.full_name)}</b></td><td><span class="status active">Ativo</span></td></tr>`).join('')
      : '<tr><td colspan="2">Nenhum profissional ativo nesta barbearia.</td></tr>';
  } else {
    document.querySelector('#register-head').innerHTML = '<tr><th>SERVIÇO</th><th>DURAÇÃO</th><th>PREÇO</th><th>STATUS</th></tr>';
    table.innerHTML = filtered.length
      ? filtered.map(row => `<tr><td><b>${escapeText(row.name)}</b></td><td>${Number(row.duration_minutes)} min</td><td>${currency(row.price)}</td><td><span class="status active">Ativo</span></td></tr>`).join('')
      : '<tr><td colspan="4">Nenhum serviço ativo nesta barbearia.</td></tr>';
  }
}

function showView(view) {
  document.querySelectorAll('.view').forEach(element => element.classList.toggle('active-view', element.id === view));
  document.querySelectorAll('.nav-item').forEach(element => element.classList.toggle('active', element.dataset.view === view));
  document.querySelector('#breadcrumb').textContent = labels[view] || 'Visão geral';
  document.querySelector('.sidebar').classList.remove('open');
  if (view === 'agenda' || view === 'appointments') loadAppointments();
  if (view === 'reports') loadDashboard();
  if (view === 'shops') loadShopDirectory();
  if (view === 'registers') loadRegisters();
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelector('.mobile-menu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
document.querySelector('#shop-search').addEventListener('input', loadShopDirectory);
document.querySelector('#register-shop').addEventListener('change', loadRegisters);
document.querySelector('#register-search').addEventListener('input', renderRegisters);
document.querySelectorAll('[data-register-type]').forEach(button => button.addEventListener('click', () => {
  registerType = button.dataset.registerType;
  document.querySelectorAll('[data-register-type]').forEach(tab => tab.classList.toggle('active', tab === button));
  loadRegisters();
}));

document.querySelector('#add-service').addEventListener('click', async () => {
  const shopId = document.querySelector('#register-shop').value;
  if (!shopId) {
    showToast('Selecione uma barbearia antes de cadastrar o serviço.', true);
    return;
  }
  const form = document.querySelector('#service-form');
  const professionalList = document.querySelector('#service-professionals');
  form.reset();
  setFeedback(document.querySelector('#service-feedback'), 'Carregando profissionais...');
  professionalList.replaceChildren();
  openModal(serviceModal);
  try {
    const professionals = await loadShopProfessionals(shopId);
    professionalList.innerHTML = professionals.length
      ? professionals.map(professional => `<label class="selection-option"><input type="checkbox" name="service-professional" value="${escapeText(professional.id)}"><span>${escapeText(professional.full_name)}</span></label>`).join('')
      : '<p class="empty-state">Cadastre um profissional nesta unidade antes de adicionar serviços.</p>';
    setFeedback(document.querySelector('#service-feedback'), '');
  } catch (error) {
    setFeedback(document.querySelector('#service-feedback'), `Não foi possível carregar os profissionais: ${error.message}`, true);
  }
  form.dataset.shopId = shopId;
});

document.querySelector('#service-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const professionalIds = [...form.querySelectorAll('input[name="service-professional"]:checked')].map(input => input.value);
  if (!professionalIds.length) {
    setFeedback(document.querySelector('#service-feedback'), 'Selecione pelo menos um profissional habilitado para atender este serviço.', true);
    return;
  }
  submit.disabled = true;
  setFeedback(document.querySelector('#service-feedback'), 'Salvando serviço...');
  try {
    await supabaseRequest('rpc/create_barbershop_service', {
      method:'POST',
      body:JSON.stringify({
        p_barbershop_id:form.dataset.shopId,
        p_name:document.querySelector('#service-name').value.trim(),
        p_price:Number(document.querySelector('#service-price').value),
        p_duration_minutes:Number(document.querySelector('#service-duration').value),
        p_professional_ids:professionalIds
      })
    });
    closeModal(serviceModal);
    registerType = 'services';
    document.querySelectorAll('[data-register-type]').forEach(tab => tab.classList.toggle('active', tab.dataset.registerType === 'services'));
    await loadRegisters();
    showToast('Serviço cadastrado e vinculado aos profissionais selecionados.');
  } catch (error) {
    setFeedback(document.querySelector('#service-feedback'), `Não foi possível salvar o serviço: ${error.message}`, true);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#manage-hours').addEventListener('click', async () => {
  const shopId = document.querySelector('#register-shop').value;
  if (!shopId) {
    showToast('Selecione uma barbearia antes de configurar horários.', true);
    return;
  }
  const select = document.querySelector('#schedule-professional');
  document.querySelector('#schedule-form button[type="submit"]').disabled = true;
  select.replaceChildren();
  renderScheduleDays();
  setFeedback(document.querySelector('#schedule-feedback'), 'Carregando profissionais...');
  openModal(hoursModal);
  try {
    const professionals = await loadShopProfessionals(shopId);
    select.replaceChildren(...professionals.map(professional => new Option(professional.full_name, professional.id)));
    if (!professionals.length) {
      setFeedback(document.querySelector('#schedule-feedback'), 'Nenhum profissional ativo nesta barbearia.');
      return;
    }
    await loadProfessionalSchedule(select.value);
  } catch (error) {
    setFeedback(document.querySelector('#schedule-feedback'), `Não foi possível carregar os profissionais: ${error.message}`, true);
  }
});

document.querySelector('#schedule-professional').addEventListener('change', event => {
  loadProfessionalSchedule(event.currentTarget.value);
});

document.querySelector('#schedule-days').addEventListener('change', event => {
  const checkbox = event.target.closest('input[data-weekday]');
  if (!checkbox) return;
  const weekday = checkbox.dataset.weekday;
  const start = document.querySelector(`[data-start="${weekday}"]`);
  const end = document.querySelector(`[data-end="${weekday}"]`);
  start.disabled = !checkbox.checked;
  end.disabled = !checkbox.checked;
  start.required = checkbox.checked;
  end.required = checkbox.checked;
});

document.querySelector('#schedule-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const schedule = [...form.querySelectorAll('input[data-weekday]:checked')].map(checkbox => ({
    weekday:Number(checkbox.dataset.weekday),
    start_time:document.querySelector(`[data-start="${checkbox.dataset.weekday}"]`).value,
    end_time:document.querySelector(`[data-end="${checkbox.dataset.weekday}"]`).value
  }));
  submit.disabled = true;
  setFeedback(document.querySelector('#schedule-feedback'), 'Salvando disponibilidade semanal...');
  try {
    await supabaseRequest('rpc/save_professional_weekly_schedule', {
      method:'POST',
      body:JSON.stringify({
        p_professional_id:document.querySelector('#schedule-professional').value,
        p_schedule:schedule
      })
    });
    showToast('Horários semanais atualizados.');
    await loadProfessionalSchedule(document.querySelector('#schedule-professional').value);
  } catch (error) {
    setFeedback(document.querySelector('#schedule-feedback'), `Não foi possível salvar os horários: ${error.message}`, true);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#add-shop').addEventListener('click', () => {
  document.querySelector('#shop-form').reset();
  document.querySelector('#shop-invite-result').hidden = true;
  document.querySelector('#shop-form').hidden = false;
  setFeedback(document.querySelector('#shop-feedback'), '');
  openModal(shopModal);
});

document.querySelector('#shop-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = document.querySelector('#new-shop-name').value.trim();
  const slug = slugify(name);
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  if (!slug) {
    setFeedback(document.querySelector('#shop-feedback'), 'Informe um nome válido para criar o link da unidade.', true);
    return;
  }
  submit.disabled = true;
  setFeedback(document.querySelector('#shop-feedback'), 'Criando barbearia e convite do gestor...');
  try {
    const result = await supabaseRequest('rpc/create_barbershop_with_manager_invite', {
      method:'POST',
      body:JSON.stringify({
        p_name:name,
        p_address:document.querySelector('#new-shop-address').value.trim(),
        p_phone:document.querySelector('#new-shop-phone').value.trim(),
        p_slug:slug
      })
    });
    const created = Array.isArray(result) ? result[0] : result;
    setInviteLink('shop-invite-link', created.invite_token);
    document.querySelector('#shop-form').hidden = true;
    document.querySelector('#shop-invite-result').hidden = false;
    setFeedback(document.querySelector('#shop-feedback'), `Barbearia ${created.barbershop_name} criada. O convite do gestor expira em 14 dias.`);
    managedShops = await supabaseRequest('rpc/list_my_barbershops', {method:'POST',body:'{}'});
    updateIdentity();
    registerShops = [];
    await loadShopDirectory();
    await loadDashboard();
  } catch (error) {
    setFeedback(document.querySelector('#shop-feedback'), `Não foi possível criar a barbearia: ${error.message}`, true);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('.shop-cards').addEventListener('click', async event => {
  const professionalButton = event.target.closest('.invite-professional');
  const managerButton = event.target.closest('.invite-manager');
  const clientButton = event.target.closest('.share-client-link');
  if (clientButton) {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('barbershop', clientButton.dataset.shopSlug);
    url.searchParams.set('booking', '1');
    document.querySelector('#client-booking-link').value = url.toString();
    openModal(clientLinkModal);
    return;
  }
  if (professionalButton) {
    const form = document.querySelector('#invite-form');
    form.reset();
    form.hidden = false;
    document.querySelector('#professional-invite-result').hidden = true;
    document.querySelector('#invite-name-label').hidden = false;
    document.querySelector('#invite-title').textContent = `Adicionar profissional · ${professionalButton.dataset.shopName}`;
    document.querySelector('#invite-description').textContent = 'Gere um link individual de cadastro para a equipe. O link expira em 14 dias.';
    form.dataset.shopId = professionalButton.dataset.shopId;
    setFeedback(document.querySelector('#invite-feedback'), '');
    openModal(inviteModal);
    return;
  }
  if (managerButton) {
    const button = managerButton;
    button.disabled = true;
    try {
      document.querySelector('#professional-invite-result').hidden = true;
      const token = await supabaseRequest('rpc/create_manager_invite', {
        method:'POST', body:JSON.stringify({p_barbershop_id:button.dataset.shopId})
      });
      document.querySelector('#invite-title').textContent = `Convite de gestor · ${button.dataset.shopName}`;
      document.querySelector('#invite-description').textContent = 'Envie este link ao responsável da unidade. É de uso único e expira em 14 dias.';
      document.querySelector('#invite-form').hidden = true;
      document.querySelector('#invite-name-label').hidden = true;
      setInviteLink('professional-invite-link', token);
      document.querySelector('#professional-invite-result').hidden = false;
      openModal(inviteModal);
    } catch (error) {
      showToast(`Não foi possível criar o convite: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }
});

document.querySelector('#invite-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  setFeedback(document.querySelector('#invite-feedback'), 'Gerando convite...');
  try {
    const token = await supabaseRequest('rpc/create_professional_invite', {
      method:'POST',
      body:JSON.stringify({
        p_barbershop_id:form.dataset.shopId,
        p_professional_name:document.querySelector('#invite-name').value.trim()
      })
    });
    setInviteLink('professional-invite-link', token);
    form.hidden = true;
    document.querySelector('#professional-invite-result').hidden = false;
    setFeedback(document.querySelector('#invite-feedback'), 'Convite criado; compartilhe este link com o profissional.');
  } catch (error) {
    setFeedback(document.querySelector('#invite-feedback'), `Não foi possível gerar o convite: ${error.message}`, true);
  } finally {
    submit.disabled = false;
  }
});

document.querySelectorAll('.copy-invite').forEach(button => button.addEventListener('click', () => {
  copyInputValue(button.dataset.copyTarget, button);
}));

function openModal(element) {
  element.classList.add('open');
  element.setAttribute('aria-hidden', 'false');
}
function closeModal(element) {
  element.classList.remove('open');
  element.setAttribute('aria-hidden', 'true');
}
function openBooking() {
  openModal(bookingModal);
  setFeedback(bookingFeedback, '');
  loadShops();
}
function openAuth() {
  setFeedback(authFeedback, '');
  openModal(authModal);
}

document.querySelectorAll('#open-booking,#open-booking-agenda,#open-booking-list').forEach(button => button.addEventListener('click', openBooking));
document.querySelectorAll('.modal-close,.modal-close-btn').forEach(button => button.addEventListener('click', () => {
  const modal = button.closest('.modal-backdrop');
  if (modal) closeModal(modal);
}));
document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('click', event => {
  if (event.target === backdrop) closeModal(backdrop);
}));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.open').forEach(closeModal);
  }
});

async function loadShops() {
  bookingShop.disabled = true;
  setFeedback(bookingFeedback, 'Carregando barbearias...');
  try {
    if (session?.access_token) {
      await loadIdentity();
    }
    shops = await loadAccessibleBarbershops();
    bookingShop.replaceChildren(...shops.map(shop => new Option(shop.name, shop.id)));
    if (requestedShopSlug) {
      const requestedShop = shops.find(shop => shop.slug === requestedShopSlug);
      if (requestedShop) bookingShop.value = requestedShop.id;
    }
    bookingShop.disabled = shops.length === 0;
    if (!shops.length) {
      setFeedback(bookingFeedback, session?.access_token
        ? 'Sua conta ainda não está vinculada a uma barbearia. Abra o link recebido da unidade ou solicite um convite.'
        : 'Nenhuma barbearia ativa encontrada.');
      return;
    }
    setFeedback(bookingFeedback, '');
    await loadProfessionals();
  } catch (error) {
    setFeedback(bookingFeedback, `Não foi possível carregar as barbearias: ${error.message}`, true);
  }
}

async function loadProfessionals() {
  bookingProfessional.disabled = true;
  bookingService.disabled = true;
  bookingTime.disabled = true;
  bookingProfessional.replaceChildren();
  bookingService.replaceChildren();
  bookingTime.replaceChildren();
  selectedAppointmentSlot = null;
  try {
    const rows = await supabaseRequest('rpc/list_active_professionals', {
      method:'POST', body:JSON.stringify({p_barbershop_id:bookingShop.value})
    });
    bookingProfessional.replaceChildren(...rows.map(row => new Option(row.full_name || 'Profissional', row.id)));
    bookingProfessional.disabled = rows.length === 0;
    if (!rows.length) {
      setFeedback(bookingFeedback, 'Esta barbearia ainda não possui profissionais ativos.');
      return;
    }
    setFeedback(bookingFeedback, '');
    await loadServices();
  } catch (error) {
    setFeedback(bookingFeedback, `Não foi possível carregar os profissionais: ${error.message}`, true);
  }
}

async function loadServices() {
  bookingService.disabled = true;
  bookingTime.disabled = true;
  bookingService.replaceChildren();
  bookingTime.replaceChildren();
  selectedAppointmentSlot = null;
  try {
    const links = await supabaseRequest(`professional_services?select=service_id&professional_id=eq.${encodeURIComponent(bookingProfessional.value)}`);
    const ids = links.map(link => link.service_id);
    if (!ids.length) {
      setFeedback(bookingFeedback, 'Este profissional ainda não tem serviços associados.');
      return;
    }
    const filter = `(${ids.join(',')})`;
    const rows = await supabaseRequest(`services?select=id,name,price,duration_minutes&id=in.${encodeURIComponent(filter)}&barbershop_id=eq.${encodeURIComponent(bookingShop.value)}&active=eq.true&order=name`);
    bookingService.replaceChildren(...rows.map(service => new Option(
      `${service.name} · ${currency(service.price)} · ${service.duration_minutes} min`, service.id
    )));
    bookingService.disabled = rows.length === 0;
    if (!rows.length) {
      setFeedback(bookingFeedback, 'Nenhum serviço ativo associado a este profissional.');
      return;
    }
    setFeedback(bookingFeedback, '');
    await loadSlots();
  } catch (error) {
    setFeedback(bookingFeedback, `Não foi possível carregar os serviços: ${error.message}`, true);
  }
}

async function loadSlots() {
  bookingTime.disabled = true;
  bookingTime.replaceChildren();
  selectedAppointmentSlot = null;
  if (!bookingProfessional.value || !bookingService.value || !bookingDate.value) return;
  setFeedback(bookingFeedback, 'Consultando horários disponíveis...');
  try {
    const rows = await supabaseRequest('rpc/available_appointment_slots', {
      method:'POST',
      body:JSON.stringify({
        p_professional_id:bookingProfessional.value,
        p_service_id:bookingService.value,
        p_date:bookingDate.value
      })
    });
    bookingTime.replaceChildren(new Option('Selecione um horário', ''));
    rows.forEach(slot => {
      const option = new Option(slot.local_time.slice(0,5), slot.local_time.slice(0,5));
      option.dataset.startsAt = slot.slot_start;
      bookingTime.add(option);
    });
    bookingTime.disabled = rows.length === 0;
    bookingSubmit.disabled = true;
    setFeedback(bookingFeedback, rows.length ? `${rows.length} horário(s) disponível(is).` : 'Não há horários disponíveis nesta data.');
  } catch (error) {
    setFeedback(bookingFeedback, `Não foi possível consultar a disponibilidade: ${error.message}`, true);
  }
}

bookingShop.addEventListener('change', loadProfessionals);
bookingProfessional.addEventListener('change', loadServices);
bookingService.addEventListener('change', loadSlots);
bookingDate.addEventListener('change', loadSlots);
bookingTime.addEventListener('change', () => {
  selectedAppointmentSlot = bookingTime.selectedOptions[0]?.dataset.startsAt || null;
  bookingSubmit.disabled = !selectedAppointmentSlot;
});

function setAuthMode(mode) {
  authMode = mode;
  const signUp = mode === 'signup';
  document.querySelector('#auth-title').textContent = signUp ? 'Criar sua conta' : 'Entrar';
  document.querySelector('#auth-description').textContent = pendingInviteToken
    ? 'Você recebeu um convite seguro para se cadastrar e acessar uma barbearia.'
    : signUp ? 'Cadastre-se para fazer agendamentos.' : 'Entre para confirmar seu agendamento.';
  document.querySelector('#auth-role-note').textContent = signUp
    ? pendingInviteToken
      ? 'Ao concluir o cadastro, o convite vinculará sua conta somente à barbearia e à função autorizadas nele.'
      : 'Sua escolha informa como você pretende usar o SuaBarbeariaAqui. Para acessar a gestão, a equipe precisa vincular sua conta à barbearia.'
    : 'A seleção não altera as permissões da sua conta. O acesso é determinado pelo perfil já autorizado no sistema.';
  document.querySelector('#auth-name-field').hidden = !signUp;
  document.querySelector('#auth-name').required = signUp;
  document.querySelector('#auth-password').autocomplete = signUp ? 'new-password' : 'current-password';
  document.querySelector('#auth-mode-toggle').textContent = signUp ? 'Já tenho conta' : 'Criar conta';
  document.querySelector('#auth-form button[type="submit"]').textContent = signUp ? 'Criar conta' : 'Entrar';
}

document.querySelector('#auth-mode-toggle').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
authButton.addEventListener('click', () => {
  if (!session) {
    setAuthMode('signin');
    openAuth();
    return;
  }
  saveSession(null);
  showToast('Sessão encerrada.');
});

document.querySelector('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const email = document.querySelector('#auth-email').value.trim();
  const password = document.querySelector('#auth-password').value;
  const name = document.querySelector('#auth-name').value.trim();
  const accountType = document.querySelector('#auth-account-type').value;
  const endpoint = authMode === 'signup' ? 'signup' : 'token?grant_type=password';
  const authUrl = authMode === 'signup'
    ? `${authBase}/signup?redirect_to=${encodeURIComponent(window.location.href)}`
    : `${authBase}/${endpoint}`;
  const payload = authMode === 'signup'
    ? {email,password,data:{full_name:name,intended_account_type:accountType}}
    : {email,password};
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  setFeedback(authFeedback, authMode === 'signup' ? 'Criando sua conta...' : 'Entrando...');
  try {
    const result = await request(authUrl, {method:'POST',body:JSON.stringify(payload)}, config.supabaseAnonKey);
    if (result.access_token) {
      saveSession(result);
      const inviteClaimed = pendingInviteToken ? await processPendingInvite() : true;
      if (inviteClaimed && !pendingInviteToken) {
        await loadIdentity();
        await ensureRequestedClientShopLink();
        if (bookingModal.classList.contains('open')) await loadShops();
      }
      if (inviteClaimed) closeModal(authModal);
      setFeedback(bookingFeedback, 'Conta conectada. Selecione um horário e confirme o agendamento.');
      if (inviteClaimed) showToast('Login realizado.');
    } else {
      setAuthMode('signin');
      setFeedback(authFeedback, accountType === 'client'
        ? 'Conta criada. Confirme seu e-mail e depois entre para agendar.'
        : 'Conta criada. Confirme seu e-mail; a equipe precisa vincular sua conta à barbearia para liberar a gestão.');
    }
  } catch (error) {
    setFeedback(authFeedback, error.message, true);
  } finally {
    submit.disabled = false;
  }
});

if (pendingInviteToken) {
  document.querySelector('#auth-account-type').value = 'barbershop';
  if (session?.access_token) {
    processPendingInvite();
  } else {
    setAuthMode('signup');
    openAuth();
  }
} else if (new URLSearchParams(window.location.search).get('booking') === '1') {
  openBooking();
}

bookingForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!session?.user?.id) {
    openAuth();
    setFeedback(authFeedback, 'Entre ou crie uma conta para concluir o agendamento.');
    return;
  }
  if (!selectedAppointmentSlot) {
    setFeedback(bookingFeedback, 'Selecione uma data e um horário disponível.', true);
    return;
  }
  bookingSubmit.disabled = true;
  setFeedback(bookingFeedback, 'Confirmando seu agendamento...');
  try {
    await supabaseRequest('rpc/create_appointment', {
      method:'POST',
      body:JSON.stringify({
        p_barbershop_id:bookingShop.value,
        p_professional_id:bookingProfessional.value,
        p_client_id:session.user.id,
        p_service_id:bookingService.value,
        p_starts_at:selectedAppointmentSlot
      })
    });
    closeModal(bookingModal);
    showToast('Agendamento confirmado.');
    bookingForm.reset();
    bookingDate.value = localToday();
    selectedAppointmentSlot = null;
    bookingTime.replaceChildren();
    await loadAppointments();
  } catch (error) {
    setFeedback(bookingFeedback, `Não foi possível confirmar: ${error.message}`, true);
    if (error.message.includes('HORARIO_INDISPONIVEL')) await loadSlots();
  } finally {
    bookingSubmit.disabled = false;
    updateAuthButton();
  }
});

appointmentTable.addEventListener('click', async event => {
  const button = event.target.closest('.cancel-appointment,.complete-appointment');
  if (!button) return;
  const appointment = appointmentsById.get(button.dataset.appointmentId);
  const appointmentId = button.dataset.appointmentId;
  if (!appointment || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appointmentId)) {
    showToast('Identificador de agendamento inválido. Atualize a lista e tente novamente.', true);
    return;
  }
  const isComplete = button.classList.contains('complete-appointment');
  const actionText = isComplete ? 'Marcar como concluído' : 'Cancelar';
  if (!window.confirm(`${actionText} o atendimento de ${appointment.client_name} em ${localDate(appointment.starts_at)} às ${localTime(appointment.starts_at)}?`)) return;
  button.disabled = true;
  try {
    await supabaseRequest(`rpc/${isComplete ? 'complete_my_appointment' : 'cancel_my_appointment'}`, {
      method:'POST', body:JSON.stringify({p_appointment_id:appointmentId})
    });
    showToast(isComplete ? 'Atendimento marcado como concluído.' : 'Agendamento cancelado.');
    await loadAppointments();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#appointment-search').addEventListener('input', renderAppointments);
document.querySelector('#appointment-status-filter').addEventListener('change', renderAppointments);
document.querySelector('#refresh-appointments').addEventListener('click', loadAppointments);
document.querySelector('#refresh-agenda').addEventListener('click', loadAppointments);
document.querySelector('#agenda-date').addEventListener('change', renderAgenda);

bookingDate.min = localToday();
bookingDate.value = localToday();
document.querySelector('#agenda-date').min = localToday();
document.querySelector('#agenda-date').value = localToday();
updateAuthButton();
updateIdentity();
handleAuthCallback().then(hasCallback => {
  if (!hasCallback && session?.access_token) return loadOperationalData();
  else if (!hasCallback) clearOperationalData();
}).catch(error => {
  setAuthMode('signin');
  openAuth();
  setFeedback(authFeedback, `Não foi possível concluir a confirmação do e-mail: ${error.message}`, true);
  console.error('Falha ao processar o retorno de confirmação do e-mail.', error);
});
updateIdentity();
checkConnection();
