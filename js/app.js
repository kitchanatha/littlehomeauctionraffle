import { createClient } from '@supabase/supabase-js';

// Same project as the main reservation site — this is the public/anon key, safe to ship
// client-side (Supabase's RLS + the SECURITY DEFINER functions in supabase-raffle.sql are
// what actually gate access, not this key).
const DEFAULT_SB_URL = 'https://kowsnqqznjgpfsumgsir.supabase.co';
const DEFAULT_SB_KEY = 'sb_publishable_7UW1aict4fPrLAdrPCLvaQ_4j0acB_J';

let totalItems = 20;
let itemsPerPage = 8;
let itemPrefix = '#';
let totalPages = Math.ceil(totalItems / itemsPerPage);
let currentPage = 1;

let supabase = null;
let syncEnabled = false;
let serverClockOffsetMs = 0;
let hasServerClock = false;
let adminClickCount = 0;

let currentRound = null; // { id, mode, window_seconds, status, opens_at, closes_at, drawn_at }
let board = {}; // item_id -> { entry_count, my_entry, winner_ign }
let pollInterval = null;
let drawAttempted = false;

function getEl(id) {
  return document.getElementById(id);
}

function safeGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { console.warn('LocalStorage error', e); }
}

function getAuthoritativeNow() {
  if (syncEnabled && hasServerClock) return Date.now() + serverClockOffsetMs;
  return Date.now();
}

async function syncServerClock() {
  if (!syncEnabled || !supabase) return false;
  const requestStartedAt = Date.now();
  const { data, error } = await supabase.rpc('raffle_server_time_ms');
  const responseReceivedAt = Date.now();
  if (error) {
    console.error('Server clock sync failed:', error);
    return false;
  }
  const serverTime = Number(data);
  if (!Number.isFinite(serverTime)) return false;
  const browserMidpoint = (requestStartedAt + responseReceivedAt) / 2;
  serverClockOffsetMs = serverTime - browserMidpoint;
  hasServerClock = true;
  return true;
}

// --- Supabase connection ---

function getSupabaseConfig() {
  const url = safeGet('raffle_sb_url');
  const key = safeGet('raffle_sb_key');
  return { url: url !== null ? url : DEFAULT_SB_URL, key: key !== null ? key : DEFAULT_SB_KEY };
}

function loadSupabaseConfig() {
  const { url, key } = getSupabaseConfig();
  syncEnabled = !!(url && key);
  const urlInp = getEl('supabase-url');
  const keyInp = getEl('supabase-key');
  if (urlInp) urlInp.value = url || '';
  if (keyInp) keyInp.value = key || '';
}

function saveSupabaseConfig() {
  const url = getEl('supabase-url').value.trim();
  const key = getEl('supabase-key').value.trim();
  safeSet('raffle_sb_url', url);
  safeSet('raffle_sb_key', key);
  alert('Settings saved. Reconnecting...');
  location.reload();
}
window.saveSupabaseConfig = saveSupabaseConfig;

function updateSyncStatus(mode, msg = '') {
  const statusEl = getEl('sync-status');
  if (!statusEl) return;
  statusEl.className = 'sync-status';
  if (mode === 'online') {
    statusEl.classList.add('status-online');
    statusEl.textContent = '● Mode: Cloud Sync (Online)';
  } else if (mode === 'error') {
    statusEl.classList.add('status-error');
    statusEl.textContent = `● Mode: Sync Error (${msg})`;
  } else {
    statusEl.classList.add('status-local');
    statusEl.textContent = '● Mode: Local Storage (raffles need Cloud Sync to be fair — connect Supabase above)';
  }
}

async function connectSupabase() {
  const { url, key } = getSupabaseConfig();
  try {
    supabase = createClient(url, key);
    const clockSynced = await syncServerClock();
    if (!clockSynced) {
      throw new Error('Raffle functions are not installed. Run supabase-raffle.sql in Supabase SQL Editor.');
    }

    const { data: cfg, error: cfgErr } = await supabase.rpc('get_raffle_config');
    if (cfgErr) throw cfgErr;
    if (cfg && cfg[0]) applyBoardConfig(cfg[0]);

    updateSyncStatus('online');
    startPolling();
  } catch (err) {
    console.error('Supabase connection failed:', err);
    updateSyncStatus('error', err.message);
  }
}

function applyBoardConfig(cfg) {
  if (!cfg) return;
  itemPrefix = cfg.prefix ?? itemPrefix;
  totalItems = cfg.total_items ?? totalItems;
  itemsPerPage = cfg.items_per_page ?? itemsPerPage;
  totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
  currentPage = Math.min(currentPage, totalPages);

  const prefixInput = getEl('item-prefix');
  if (prefixInput && document.activeElement !== prefixInput) prefixInput.value = itemPrefix;
  const totalInput = getEl('total-items');
  if (totalInput && document.activeElement !== totalInput) totalInput.value = totalItems;
  const perPageInput = getEl('items-per-page');
  if (perPageInput && document.activeElement !== perPageInput) perPageInput.value = itemsPerPage;
}

async function saveBoardConfig() {
  if (!syncEnabled || !supabase) return alert('Connect Cloud Sync first.');
  const actorIgn = requireAdminIgn();
  if (!actorIgn) return;

  const prefix = getEl('item-prefix').value;
  const total = parseInt(getEl('total-items').value, 10);
  const perPage = parseInt(getEl('items-per-page').value, 10);

  const { error } = await supabase.rpc('set_raffle_config', {
    p_prefix: prefix,
    p_total_items: total,
    p_items_per_page: perPage,
    p_actor_ign: actorIgn,
  });
  if (error) return alert('Failed: ' + error.message);

  const { data: cfg } = await supabase.rpc('get_raffle_config');
  if (cfg && cfg[0]) applyBoardConfig(cfg[0]);
  renderItems();
  alert('Board saved.');
}
window.saveBoardConfig = saveBoardConfig;

// --- IGN + admin gate ---

function saveGlobalIGN() {
  safeSet('guild_ign', getEl('global-ign').value.trim());
}
window.saveGlobalIGN = saveGlobalIGN;

function currentIgn() {
  return (getEl('global-ign')?.value || '').trim();
}

function requireAdminIgn() {
  const ign = currentIgn();
  if (!ign) {
    getEl('global-ign')?.focus();
    alert('Enter your IGN at the top first — it\'s checked against the admin list.');
    return null;
  }
  return ign;
}

// --- Admin trigger (10 clicks on the logo, same as the main site) ---

function setupAdminTrigger() {
  const trigger = getEl('admin-trigger');
  if (!trigger) return;
  trigger.addEventListener('click', () => {
    adminClickCount++;
    if (adminClickCount >= 10) {
      const actions = getEl('admin-actions');
      actions?.classList.toggle('hidden');
      adminClickCount = 0;
      if (actions && !actions.classList.contains('hidden')) {
        loadTimerAdmins();
        loadRoundHistory();
      }
    }
  });
}

// --- Admin allowlist (reuses the main site's timer_admins table/RPCs) ---

async function loadTimerAdmins() {
  const list = getEl('timer-admins-list');
  if (!list) return;
  if (!syncEnabled || !supabase) {
    list.innerHTML = '<li>Requires Cloud Sync (Supabase) to be enabled.</li>';
    return;
  }
  const { data, error } = await supabase.rpc('list_timer_admins');
  if (error) {
    list.innerHTML = '<li>Failed to load list.</li>';
    return;
  }
  renderTimerAdminsList(data || []);
}

function renderTimerAdminsList(admins) {
  const list = getEl('timer-admins-list');
  if (!list) return;
  list.innerHTML = '';
  if (admins.length === 0) {
    list.innerHTML = '<li>No one added yet — no one can start/draw rounds or edit the board until you add at least one IGN.</li>';
    return;
  }
  admins.forEach((admin) => {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'timer-admin-name';
    nameSpan.textContent = admin.ign;
    li.appendChild(nameSpan);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✖';
    removeBtn.className = 'unreserve-btn';
    removeBtn.onclick = () => removeTimerAdmin(admin.ign);
    li.appendChild(removeBtn);

    list.appendChild(li);
  });
}

async function addTimerAdmin() {
  if (!syncEnabled || !supabase) return alert('Connect Cloud Sync first.');
  const input = getEl('new-timer-admin-ign');
  const ign = input.value.trim();
  if (!ign) return;
  const addedBy = currentIgn();
  const { error } = await supabase.rpc('add_timer_admin', { p_ign: ign, p_added_by: addedBy || null });
  if (error) return alert('Failed: ' + error.message);
  input.value = '';
  await loadTimerAdmins();
}
window.addTimerAdmin = addTimerAdmin;

async function removeTimerAdmin(ign) {
  if (!syncEnabled || !supabase) return;
  if (!confirm(`Remove "${ign}" from the admin list?`)) return;
  const { error } = await supabase.rpc('remove_timer_admin', { p_ign: ign });
  if (error) return alert('Failed: ' + error.message);
  await loadTimerAdmins();
}

// --- Round admin actions ---

async function startRound() {
  if (!syncEnabled || !supabase) return alert('Connect Cloud Sync first.');
  const actorIgn = requireAdminIgn();
  if (!actorIgn) return;

  const mode = getEl('round-mode').value;
  const windowSeconds = parseInt(getEl('round-window').value, 10);

  const { error } = await supabase.rpc('create_raffle_round', {
    p_mode: mode,
    p_window_seconds: windowSeconds,
    p_created_by: actorIgn,
  });
  if (error) return alert('Failed: ' + error.message);
  await refreshRound();
  await loadRoundHistory();
}
window.startRound = startRound;

async function forceDrawRound() {
  if (!syncEnabled || !supabase) return alert('Connect Cloud Sync first.');
  if (!currentRound) return alert('No round to draw.');
  // The server refuses to draw before closes_at no matter who asks — this button just
  // triggers an immediate check instead of waiting for the next poll tick, it can't force
  // an early draw (that's deliberate: no one, including admins, can cut a round short).
  const { data, error } = await supabase.rpc('draw_raffle_round', { p_round_id: currentRound.id });
  if (error) return alert('Failed: ' + error.message);
  if (data === 'not_closed_yet') return alert('Window hasn\'t closed yet — try again after it ends.');
  await refreshRound();
  await loadRoundHistory();
}
window.forceDrawRound = forceDrawRound;

async function loadRoundHistory() {
  const list = getEl('round-history-list');
  if (!list || !syncEnabled || !supabase) return;
  const { data, error } = await supabase.rpc('list_raffle_rounds');
  if (error || !data) {
    list.innerHTML = '<li>Failed to load history.</li>';
    return;
  }
  list.innerHTML = '';
  if (data.length === 0) {
    list.innerHTML = '<li>No rounds yet.</li>';
    return;
  }
  data.slice(0, 10).forEach((r) => {
    const li = document.createElement('li');
    const when = new Date(r.opens_at).toLocaleString();
    li.textContent = `#${r.id} · ${r.mode} · ${r.window_seconds}s · ${r.status}${r.status === 'drawn' ? ' ✅' : ''} · ${when}`;
    list.appendChild(li);
  });
}

// --- Round polling + board rendering ---

function startPolling() {
  if (pollInterval) return;
  refreshRound();
  pollInterval = setInterval(refreshRound, 2000);
}

async function refreshRound() {
  if (!syncEnabled || !supabase) return;
  const { data, error } = await supabase.rpc('get_current_raffle_round');
  if (error) {
    console.error('Failed to load current round:', error);
    return;
  }
  const round = data && data[0] ? data[0] : null;

  if (round && (!currentRound || currentRound.id !== round.id)) drawAttempted = false;
  currentRound = round;

  if (currentRound) {
    const now = getAuthoritativeNow();
    const closesAt = new Date(currentRound.closes_at).getTime();
    if (currentRound.status === 'open' && now >= closesAt && !drawAttempted) {
      drawAttempted = true;
      await supabase.rpc('draw_raffle_round', { p_round_id: currentRound.id }).catch(() => {});
      const { data: fresh } = await supabase.rpc('get_current_raffle_round');
      if (fresh && fresh[0]) currentRound = fresh[0];
    }

    const { data: boardRows } = await supabase.rpc('get_raffle_board', {
      p_round_id: currentRound.id,
      p_ign: currentIgn(),
    });
    board = {};
    (boardRows || []).forEach((row) => {
      board[row.item_id] = row;
    });
  } else {
    board = {};
  }

  renderRoundBanner();
  renderItems();
}

function renderRoundBanner() {
  const banner = getEl('round-banner');
  const adminStatus = getEl('round-admin-status');
  if (!banner) return;

  if (!currentRound) {
    banner.classList.add('hidden');
    if (adminStatus) adminStatus.textContent = 'No round running.';
    return;
  }

  banner.classList.remove('hidden');
  const modeLabel = currentRound.mode === 'single' ? 'Single entry' : 'Multi entry';

  if (currentRound.status === 'drawn') {
    banner.className = 'round-banner round-drawn';
    banner.textContent = `🎉 Round #${currentRound.id} (${modeLabel}) — results are in! Scroll down to see who won.`;
    if (adminStatus) adminStatus.textContent = `Round #${currentRound.id} drawn.`;
    return;
  }

  const now = getAuthoritativeNow();
  const closesAt = new Date(currentRound.closes_at).getTime();
  const remaining = Math.max(0, closesAt - now);
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;

  banner.className = 'round-banner round-open';
  banner.textContent = `🎟️ Round #${currentRound.id} (${modeLabel}) — entries close in ${timeStr}. Click any open item to enter — speed doesn't matter, winners are random!`;
  if (adminStatus) adminStatus.textContent = `Round #${currentRound.id} open, closes in ${timeStr}.`;
}

function renderItems() {
  const container = getEl('items-container');
  if (!container) return;
  container.innerHTML = '';

  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
  const roundOpen = currentRound && currentRound.status === 'open';
  const roundDrawn = currentRound && currentRound.status === 'drawn';

  for (let i = startIndex; i < endIndex; i++) {
    const itemId = i + 1;
    const entry = board[itemId];
    const entryCount = entry?.entry_count ?? 0;
    const myEntry = !!entry?.my_entry;
    const winner = entry?.winner_ign ?? null;

    const itemElement = document.createElement('div');
    let cls = 'item-card';
    if (winner) cls += ' reserved';
    else if (!currentRound) cls += ' disabled';
    else if (!roundOpen) cls += ' disabled';
    itemElement.className = cls;

    if (roundOpen) {
      itemElement.onclick = () => enterRaffle(itemId);
    }

    const displayId = (i - startIndex) + 1;
    itemElement.innerHTML = `<div class="item-id">${itemPrefix}${displayId}</div>`;

    const statusDiv = document.createElement('div');
    statusDiv.className = 'item-status';
    if (winner) {
      statusDiv.textContent = `🏆 Won by ${winner}`;
    } else if (!currentRound) {
      statusDiv.textContent = 'No round running';
    } else if (roundDrawn) {
      statusDiv.textContent = entryCount > 0 ? 'No winner recorded' : '— no entries —';
    } else if (myEntry) {
      statusDiv.textContent = `✅ You're entered (${entryCount} in pool)`;
    } else {
      statusDiv.textContent = `🎟️ ${entryCount} entered — click to join`;
    }
    itemElement.appendChild(statusDiv);

    container.appendChild(itemElement);
  }

  const currentEl = getEl('current-page-val');
  if (currentEl) currentEl.textContent = currentPage;
  const totalPagesVal = getEl('total-pages-val');
  if (totalPagesVal) totalPagesVal.textContent = totalPages;
}

async function enterRaffle(itemId) {
  if (!syncEnabled || !supabase) return alert('Connect Cloud Sync first — raffles need a shared server to stay fair.');
  const ign = currentIgn();
  if (!ign) {
    getEl('global-ign')?.focus();
    return alert('Enter your IGN at the top first!');
  }
  if (!currentRound) return;

  const { data, error } = await supabase.rpc('enter_raffle', {
    p_round_id: currentRound.id,
    p_item_id: itemId,
    p_ign: ign,
  });
  if (error) return alert('Failed: ' + error.message);

  const messages = {
    entered: null, // no popup needed, the card updates itself
    already_entered: 'You\'re already entered for this item.',
    single_entry_limit: 'This round only allows one active entry per person — you\'re already in for a different item this round.',
    round_closed: 'Entries for this round have closed.',
    round_not_found: 'That round no longer exists.',
    invalid_ign: 'Enter your IGN at the top first!',
  };
  const msg = messages[data];
  if (msg) alert(msg);

  await refreshRound();
}

function changePage(delta) {
  const newPage = currentPage + delta;
  if (newPage >= 1 && newPage <= totalPages) {
    currentPage = newPage;
    renderItems();
  }
}
window.changePage = changePage;

// --- Init ---

async function init() {
  setupAdminTrigger();
  loadSupabaseConfig();

  const savedIGN = safeGet('guild_ign') || '';
  const globalInput = getEl('global-ign');
  if (globalInput) globalInput.value = savedIGN;

  totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
  const prefixInput = getEl('item-prefix');
  if (prefixInput) prefixInput.value = itemPrefix;
  const totalInput = getEl('total-items');
  if (totalInput) totalInput.value = totalItems;
  const perPageInput = getEl('items-per-page');
  if (perPageInput) perPageInput.value = itemsPerPage;

  if (syncEnabled) {
    await connectSupabase();
  } else {
    updateSyncStatus('local');
  }

  renderItems();
}

init();
