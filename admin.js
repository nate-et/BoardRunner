let appState = null;
let configModel = null;
let eventsBound = false;
let selectedPlaylistId = null;
let selectedDashboardId = null;
let draggedDashboardId = null;
let draggedPlaylistIndex = null;
let dirty = false;
let studioUpdateTimer = null;

const els = {
  toastContainer: document.getElementById('toastContainer'),
  errorBanner: document.getElementById('errorBanner'),
  pageTitle: document.getElementById('pageTitle'),
  pageSubtitle: document.getElementById('pageSubtitle'),
  statusRotation: document.getElementById('statusRotation'),
  statusStartup: document.getElementById('statusStartup'),
  statusKiosk: document.getElementById('statusKiosk'),
  statusUnsaved: document.getElementById('statusUnsaved'),
  navButtons: Array.from(document.querySelectorAll('.nav-btn')),
  views: Array.from(document.querySelectorAll('.view')),
  btnSaveAll: document.getElementById('btnSaveAll'),
  btnReload: document.getElementById('btnReload'),
  btnIdentify: document.getElementById('btnIdentify'),
  btnIdentifyFromMap: document.getElementById('btnIdentifyFromMap'),
  btnPauseResume: document.getElementById('btnPauseResume'),
  btnCreateBackup: document.getElementById('btnCreateBackup'),
  btnExportConfig: document.getElementById('btnExportConfig'),
  btnImportConfig: document.getElementById('btnImportConfig'),
  btnOpenConfigFolder: document.getElementById('btnOpenConfigFolder'),
  btnOpenLogs: document.getElementById('btnOpenLogs'),
  commandHero: document.getElementById('commandHero'),
  homeScreenGrid: document.getElementById('homeScreenGrid'),
  displayGrid: document.getElementById('displayGrid'),
  playlistLibrary: document.getElementById('playlistLibrary'),
  playlistDropZone: document.getElementById('playlistDropZone'),
  playlistSelect: document.getElementById('playlistSelect'),
  playlistName: document.getElementById('playlistName'),
  applyPlaylistScreen: document.getElementById('applyPlaylistScreen'),
  librarySearch: document.getElementById('librarySearch'),
  btnAddPlaylist: document.getElementById('btnAddPlaylist'),
  btnSavePlaylistName: document.getElementById('btnSavePlaylistName'),
  btnDuplicatePlaylist: document.getElementById('btnDuplicatePlaylist'),
  btnApplyPlaylist: document.getElementById('btnApplyPlaylist'),
  dashboardLibraryList: document.getElementById('dashboardLibraryList'),
  dashboardForm: document.getElementById('dashboardForm'),
  dashboardEditorPanel: document.getElementById('dashboardEditorPanel'),
  dashboardFormTitle: document.getElementById('dashboardFormTitle'),
  dashboardFormSubtitle: document.getElementById('dashboardFormSubtitle'),
  dashboardId: document.getElementById('dashboardId'),
  dashboardName: document.getElementById('dashboardName'),
  dashboardUrl: document.getElementById('dashboardUrl'),
  dashboardDurationSec: document.getElementById('dashboardDurationSec'),
  dashboardZoomPercent: document.getElementById('dashboardZoomPercent'),
  dashboardScrollOffsetPx: document.getElementById('dashboardScrollOffsetPx'),
  dashboardTags: document.getElementById('dashboardTags'),
  dashboardSettleMs: document.getElementById('dashboardSettleMs'),
  dashboardTimeoutMs: document.getElementById('dashboardTimeoutMs'),
  dashboardEnabled: document.getElementById('dashboardEnabled'),
  btnAddDashboard: document.getElementById('btnAddDashboard'),
  btnPreviewDashboard: document.getElementById('btnPreviewDashboard'),
  btnResetDashboard: document.getElementById('btnResetDashboard'),
  studioDashboardSelect: document.getElementById('studioDashboardSelect'),
  studioOffsetRange: document.getElementById('studioOffsetRange'),
  studioOffsetNumber: document.getElementById('studioOffsetNumber'),
  studioZoomRange: document.getElementById('studioZoomRange'),
  studioZoomNumber: document.getElementById('studioZoomNumber'),
  btnStudioOpenPreview: document.getElementById('btnStudioOpenPreview'),
  btnStudioReset: document.getElementById('btnStudioReset'),
  btnStudioApplyDefault: document.getElementById('btnStudioApplyDefault'),
  studioDiagnostics: document.getElementById('studioDiagnostics'),
  runtimeCards: document.getElementById('runtimeCards'),
  settingKioskMode: document.getElementById('settingKioskMode'),
  settingTrayOnlyStartup: document.getElementById('settingTrayOnlyStartup'),
  settingHideAdminToTray: document.getElementById('settingHideAdminToTray'),
  settingStartWithWindows: document.getElementById('settingStartWithWindows'),
  settingIdentifyOverlaySeconds: document.getElementById('settingIdentifyOverlaySeconds'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
  sideDrawer: document.getElementById('sideDrawer')
};

const viewMeta = {
  home: { title: 'Command Centre', subtitle: 'Live wallboard estate, playlists and staged changes' },
  displays: { title: 'Displays', subtitle: 'Assign physical displays, screens and playlists visually' },
  playlists: { title: 'Playlists', subtitle: 'Drag dashboards into rotations and apply them to screens' },
  library: { title: 'Dashboard Library', subtitle: 'Reusable dashboard sources and health' },
  studio: { title: 'Offset Studio', subtitle: 'Tune offsets and zoom with live preview feedback' },
  runtime: { title: 'Runtime', subtitle: 'Current playback, previews and health state' },
  settings: { title: 'Settings', subtitle: 'Application startup and behaviour' }
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function uid(prefix) {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return `${prefix}-${window.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}
function showError(message) { console.error(message); if (els.errorBanner) { els.errorBanner.textContent = message; els.errorBanner.classList.remove('hidden'); } }
function clearError() { if (els.errorBanner) { els.errorBanner.textContent = ''; els.errorBanner.classList.add('hidden'); } }
function showToast(message, type = 'info', timeoutMs = 3500) {
  if (!els.toastContainer) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  els.toastContainer.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)'; setTimeout(() => toast.remove(), 180); }, timeoutMs);
}
function showSuccess(message) { clearError(); showToast(message, 'success'); }
function showFailure(message) { showError(message); showToast(message, 'error', 5200); }
function markDirty() { dirty = true; renderDirtyState(); }
function clearDirty() { dirty = false; renderDirtyState(); }
function renderDirtyState() { if (els.statusUnsaved) els.statusUnsaved.classList.toggle('hidden', !dirty); }

function normaliseConfig() {
  if (!configModel || typeof configModel !== 'object') configModel = { settings: {}, screens: [], dashboards: [], playlists: [] };
  configModel.settings = configModel.settings || {};
  configModel.screens = Array.isArray(configModel.screens) ? configModel.screens : [];
  configModel.dashboards = Array.isArray(configModel.dashboards) ? configModel.dashboards : [];
  configModel.playlists = Array.isArray(configModel.playlists) ? configModel.playlists : [];
  if (configModel.playlists.length === 0 && configModel.screens.length > 0) migrateToPlaylists();
  if (!selectedPlaylistId && configModel.playlists.length > 0) selectedPlaylistId = configModel.playlists[0].id;
}

function makeId(prefix, source) {
  const safe = String(source || prefix).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42) || prefix;
  return `${prefix}-${safe}-${Math.floor(Math.random() * 10000)}`;
}

function migrateToPlaylists() {
  configModel.playlists = configModel.screens.map((screenItem, index) => {
    const playlistId = makeId('playlist', screenItem.name || screenItem.id || index);
    screenItem.playlistId = playlistId;
    const dashboards = configModel.dashboards
      .filter((dashboard) => dashboard.screenId === screenItem.id)
      .sort((a,b) => Number(a.sequence || 0) - Number(b.sequence || 0));
    return {
      id: playlistId,
      name: `${screenItem.name || `Screen ${index + 1}`} Playlist`,
      description: 'Migrated from dashboard screen assignments',
      items: dashboards.map((dashboard, itemIndex) => ({
        id: makeId('pli', `${dashboard.id}-${itemIndex}`),
        dashboardId: dashboard.id,
        durationMs: Number(dashboard.durationMs || 30000),
        zoomFactor: Number(dashboard.zoomFactor || 1),
        scrollOffsetPx: Number(dashboard.scrollOffsetPx || 0),
        settleMs: Number(dashboard.settleMs || 3000),
        timeoutMs: Number(dashboard.timeoutMs || 20000),
        enabled: dashboard.enabled !== false
      }))
    };
  });
}

function getDetectedDisplays() { return appState && Array.isArray(appState.detectedDisplays) ? appState.detectedDisplays : []; }
function getRuntimeScreens() { return appState && Array.isArray(appState.runtimeScreens) ? appState.runtimeScreens : []; }
function getDashboard(id) { return configModel.dashboards.find((dashboard) => dashboard.id === id); }
function getPlaylist(id) { return configModel.playlists.find((playlist) => playlist.id === id); }
function getScreen(id) { return configModel.screens.find((screen) => screen.id === id); }
function getScreenForDisplay(displayIndex) { return configModel.screens.find((screen) => Number(screen.displayIndex) === Number(displayIndex)); }
function getRuntimeForScreen(screenId) { return getRuntimeScreens().find((runtime) => runtime.screenId === screenId) || null; }
function formatSeconds(ms) { return `${Math.round(Number(ms || 0) / 1000)}s`; }
function formatPercent(value) { return `${Math.round(Number(value || 1) * 100)}%`; }
function formatTime(value) { if (!value) return 'Never'; try { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return String(value); } }
function getHealth(id) { return appState && Array.isArray(appState.dashboardHealth) ? appState.dashboardHealth.find((item) => item.dashboardId === id) : null; }

function setView(viewName) {
  els.navButtons.forEach((button) => button.classList.toggle('active', button.dataset.view === viewName));
  els.views.forEach((view) => view.classList.toggle('active', view.id === `view-${viewName}`));
  if (els.pageTitle) els.pageTitle.textContent = viewMeta[viewName]?.title || 'BoardRunner';
  if (els.pageSubtitle) els.pageSubtitle.textContent = viewMeta[viewName]?.subtitle || '';
}

function renderSnapshot(runtimeItem, label = 'Screen') {
  const snapshot = runtimeItem && runtimeItem.snapshot ? runtimeItem.snapshot : null;
  if (snapshot && snapshot.dataUrl) {
    return `<div class="screen-shot is-live"><img src="${snapshot.dataUrl}" alt="Preview for ${escapeHtml(label)}"><span>Live snapshot · ${formatTime(snapshot.capturedAt)}</span></div>`;
  }
  return `<div class="screen-shot empty"><div class="grid-wash"></div><span>Preview appears after next load</span></div>`;
}

function renderStatusStrip() {
  const settings = configModel.settings || {};
  if (els.statusRotation) els.statusRotation.textContent = `Rotation: ${appState && appState.rotationPaused ? 'Paused' : 'Running'}`;
  if (els.statusStartup) els.statusStartup.textContent = `Startup: ${settings.startWithWindows ? 'On' : 'Off'}`;
  if (els.statusKiosk) els.statusKiosk.textContent = `Kiosk: ${settings.kioskMode ? 'On' : 'Off'}`;
  if (els.btnPauseResume) els.btnPauseResume.textContent = appState && appState.rotationPaused ? 'Resume Rotation' : 'Pause Rotation';
}

function renderHome() {
  const screens = configModel.screens;
  const playlists = configModel.playlists;
  const runtime = getRuntimeScreens();
  const health = Array.isArray(appState?.dashboardHealth) ? appState.dashboardHealth : [];
  const failed = health.filter((item) => item.lastStatus === 'fail').length;
  const ok = health.filter((item) => item.lastStatus === 'ok').length;
  if (els.commandHero) {
    els.commandHero.innerHTML = `
      <div>
        <span class="eyebrow">BoardRunner 3.0</span>
        <h3>${failed ? `${failed} dashboard issue${failed === 1 ? '' : 's'} detected` : 'Wallboard estate healthy'}</h3>
        <p>${screens.length} screens · ${playlists.length} playlists · ${configModel.dashboards.length} dashboards · ${runtime.length} live runtime windows</p>
      </div>
      <div class="hero-actions">
        <button class="primary" type="button" data-action="publish">Publish Changes</button>
        <button type="button" data-action="reload">Reload Screens</button>
        <button type="button" data-action="identify">Identify</button>
      </div>
    `;
  }
  if (els.homeScreenGrid) {
    els.homeScreenGrid.innerHTML = screens.map((screen) => renderScreenCard(screen)).join('') || emptyState('No screens configured', 'Create a display assignment from the Displays view.');
  }
}

function renderScreenCard(screen) {
  const runtime = getRuntimeForScreen(screen.id);
  const playlist = getPlaylist(screen.playlistId);
  return `
    <article class="screen-card" data-screen-id="${escapeHtml(screen.id)}">
      ${renderSnapshot(runtime, screen.name)}
      <div class="screen-card-body">
        <div class="card-title-row">
          <h3>${escapeHtml(screen.name)}</h3>
          <span class="health-dot ${runtime ? 'ok' : 'idle'}"></span>
        </div>
        <p class="muted">Display ${Number(screen.displayIndex) + 1} · ${playlist ? escapeHtml(playlist.name) : 'No playlist assigned'}</p>
        <div class="card-now">
          <span>Now</span>
          <strong>${escapeHtml(runtime?.currentDashboard || 'Not playing')}</strong>
        </div>
      </div>
    </article>
  `;
}

function emptyState(title, message) { return `<div class="empty-state"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`; }

function renderDisplays() {
  const displays = getDetectedDisplays();
  if (!els.displayGrid) return;
  if (displays.length === 0) { els.displayGrid.innerHTML = emptyState('No displays detected', 'Electron has not reported any physical displays yet.'); return; }
  els.displayGrid.innerHTML = displays.map((display) => {
    const assigned = getScreenForDisplay(display.index);
    const runtime = assigned ? getRuntimeForScreen(assigned.id) : null;
    const playlist = assigned ? getPlaylist(assigned.playlistId) : null;
    return `
      <article class="display-card-v3 ${assigned ? '' : 'unassigned'}" data-display-index="${display.index}">
        <div class="monitor-frame">${renderSnapshot(runtime, assigned ? assigned.name : display.label)}</div>
        <div class="display-body">
          <div class="card-title-row"><h3>${escapeHtml(display.label)}${display.primary ? ' · Primary' : ''}</h3><span>${escapeHtml(display.size)}</span></div>
          <p>${assigned ? escapeHtml(assigned.name) : 'Unassigned'} · ${playlist ? escapeHtml(playlist.name) : 'No playlist'}</p>
          <div class="item-actions"><button type="button" data-display-configure="${display.index}">Configure</button><button type="button" data-display-identify="${display.index}">Identify</button></div>
        </div>
      </article>
    `;
  }).join('');
}

function renderPlaylistControls() {
  if (els.playlistSelect) {
    els.playlistSelect.innerHTML = configModel.playlists.map((playlist) => `<option value="${escapeHtml(playlist.id)}">${escapeHtml(playlist.name)}</option>`).join('');
    if (selectedPlaylistId && getPlaylist(selectedPlaylistId)) els.playlistSelect.value = selectedPlaylistId;
  }
  if (els.applyPlaylistScreen) {
    els.applyPlaylistScreen.innerHTML = configModel.screens.map((screen) => `<option value="${escapeHtml(screen.id)}">${escapeHtml(screen.name)}</option>`).join('');
  }
}

function renderPlaylistBuilder() {
  renderPlaylistControls();
  const playlist = getPlaylist(selectedPlaylistId) || configModel.playlists[0];
  if (!playlist) { if (els.playlistDropZone) els.playlistDropZone.innerHTML = emptyState('No playlist yet', 'Create a playlist to start building rotations.'); return; }
  selectedPlaylistId = playlist.id;
  if (els.playlistName) els.playlistName.value = playlist.name;
  renderPlaylistLibrary();
  if (els.playlistDropZone) {
    if (!playlist.items.length) {
      els.playlistDropZone.innerHTML = `<div class="drop-empty">Drop dashboards here to build this playlist</div>`;
    } else {
      els.playlistDropZone.innerHTML = playlist.items.map((item, index) => renderPlaylistItem(item, index)).join('');
    }
  }
}

function renderPlaylistLibrary() {
  if (!els.playlistLibrary) return;
  const term = (els.librarySearch?.value || '').toLowerCase();
  const dashboards = configModel.dashboards.filter((dashboard) => !term || dashboard.name.toLowerCase().includes(term) || dashboard.url.toLowerCase().includes(term));
  els.playlistLibrary.innerHTML = dashboards.map((dashboard) => `
    <div class="mini-dashboard" draggable="true" data-library-dashboard="${escapeHtml(dashboard.id)}">
      <strong>${escapeHtml(dashboard.name)}</strong>
      <span>${escapeHtml(dashboard.url)}</span>
    </div>
  `).join('') || emptyState('No dashboards found', 'Add dashboards in the Dashboard Library.');
}

function renderPlaylistItem(item, index) {
  const dashboard = getDashboard(item.dashboardId);
  return `
    <div class="playlist-item" draggable="true" data-playlist-index="${index}">
      <div class="drag-handle">⋮⋮</div>
      <div class="playlist-item-main">
        <strong>${escapeHtml(dashboard?.name || 'Missing dashboard')}</strong>
        <span>${dashboard ? escapeHtml(dashboard.url) : 'Invalid dashboard reference'}</span>
      </div>
      <div class="playlist-item-controls">
        <label>Secs <input type="number" data-item-field="durationSec" data-index="${index}" value="${Math.round(Number(item.durationMs || 30000) / 1000)}" min="1"></label>
        <label>Zoom <input type="number" data-item-field="zoomPercent" data-index="${index}" value="${Math.round(Number(item.zoomFactor || 1) * 100)}" min="10" step="5"></label>
        <label>Offset <input type="number" data-item-field="scrollOffsetPx" data-index="${index}" value="${Number(item.scrollOffsetPx || 0)}" min="0" step="10"></label>
        <button type="button" data-item-studio="${index}">Tune</button>
        <button type="button" data-item-remove="${index}">Remove</button>
      </div>
    </div>
  `;
}

function renderDashboardLibrary() {
  if (!els.dashboardLibraryList) return;
  els.dashboardLibraryList.innerHTML = configModel.dashboards.map((dashboard) => {
    const health = getHealth(dashboard.id);
    const status = health?.lastStatus || 'unknown';
    return `
      <article class="dashboard-card-v3 ${dashboard.id === selectedDashboardId ? 'selected' : ''}">
        <div class="card-title-row"><h3>${escapeHtml(dashboard.name)}</h3><span class="badge ${status === 'ok' ? 'enabled' : status === 'fail' ? 'disabled' : 'warn'}">${status === 'ok' ? 'Healthy' : status === 'fail' ? 'Failed' : 'Awaiting Data'}</span></div>
        <p class="url-line">${escapeHtml(dashboard.url)}</p>
        <div class="metric-row"><span>${formatSeconds(dashboard.durationMs)}</span><span>${formatPercent(dashboard.zoomFactor || dashboard.defaultZoomFactor)}</span><span>Offset ${Number(dashboard.scrollOffsetPx || dashboard.defaultScrollOffsetPx || 0)}px</span></div>
        <div class="item-actions"><button type="button" data-dashboard-edit="${escapeHtml(dashboard.id)}">Edit</button><button type="button" data-dashboard-preview="${escapeHtml(dashboard.id)}">Preview</button><button type="button" data-dashboard-studio="${escapeHtml(dashboard.id)}">Offset Studio</button><button type="button" data-dashboard-delete="${escapeHtml(dashboard.id)}">Delete</button></div>
      </article>
    `;
  }).join('') || emptyState('No dashboards yet', 'Add your first dashboard source.');
}

function renderRuntime() {
  if (!els.runtimeCards) return;
  const runtime = getRuntimeScreens();
  if (!runtime.length) { els.runtimeCards.innerHTML = emptyState('No active runtime screens', 'No wallboard windows are currently playing.'); return; }
  els.runtimeCards.innerHTML = runtime.map((item) => `
    <article class="runtime-card-v3">
      ${renderSnapshot(item, item.screenName || item.screenId)}
      <div>
        <div class="card-title-row"><h3>${escapeHtml(item.screenName || item.screenId)}</h3><span class="badge enabled">Live</span></div>
        <p><strong>Playlist:</strong> ${escapeHtml(item.currentPlaylist || 'Legacy rotation')}</p>
        <p><strong>Current:</strong> ${escapeHtml(item.currentDashboard || 'N/A')}</p>
        <p class="url-line">${escapeHtml(item.currentUrl || '')}</p>
      </div>
    </article>
  `).join('');
}

function renderSettings() {
  const settings = configModel.settings || {};
  if (els.settingKioskMode) els.settingKioskMode.checked = !!settings.kioskMode;
  if (els.settingTrayOnlyStartup) els.settingTrayOnlyStartup.checked = !!settings.trayOnlyStartup;
  if (els.settingHideAdminToTray) els.settingHideAdminToTray.checked = !!settings.hideAdminToTray;
  if (els.settingStartWithWindows) els.settingStartWithWindows.checked = !!settings.startWithWindows;
  if (els.settingIdentifyOverlaySeconds) els.settingIdentifyOverlaySeconds.value = Number(settings.identifyOverlaySeconds || 4);
}

function renderStudioOptions() {
  if (!els.studioDashboardSelect) return;
  els.studioDashboardSelect.innerHTML = configModel.dashboards.map((dashboard) => `<option value="${escapeHtml(dashboard.id)}">${escapeHtml(dashboard.name)}</option>`).join('');
  if (selectedDashboardId && getDashboard(selectedDashboardId)) els.studioDashboardSelect.value = selectedDashboardId;
  syncStudioFromDashboard();
}

function syncStudioFromDashboard() {
  const dashboard = getDashboard(els.studioDashboardSelect?.value || selectedDashboardId) || configModel.dashboards[0];
  if (!dashboard) return;
  selectedDashboardId = dashboard.id;
  const offset = Number(dashboard.scrollOffsetPx || dashboard.defaultScrollOffsetPx || 0);
  const zoom = Math.round(Number(dashboard.zoomFactor || dashboard.defaultZoomFactor || 1) * 100);
  if (els.studioOffsetRange) els.studioOffsetRange.value = offset;
  if (els.studioOffsetNumber) els.studioOffsetNumber.value = offset;
  if (els.studioZoomRange) els.studioZoomRange.value = zoom;
  if (els.studioZoomNumber) els.studioZoomNumber.value = zoom;
}

function getStudioDashboardModel() {
  const dashboard = getDashboard(els.studioDashboardSelect?.value || selectedDashboardId) || configModel.dashboards[0];
  if (!dashboard) return null;
  return {
    ...dashboard,
    zoomFactor: Number(els.studioZoomNumber?.value || 100) / 100,
    scrollOffsetPx: Number(els.studioOffsetNumber?.value || 0)
  };
}

function renderAll() {
  normaliseConfig();
  renderStatusStrip();
  renderHome();
  renderDisplays();
  renderPlaylistBuilder();
  renderDashboardLibrary();
  renderRuntime();
  renderSettings();
  renderStudioOptions();
  renderDirtyState();
}

function buildDashboardFromForm() {
  return {
    id: els.dashboardId.value || uid('db'),
    name: els.dashboardName.value.trim(),
    url: els.dashboardUrl.value.trim(),
    sequence: 1,
    durationMs: Number(els.dashboardDurationSec.value || 30) * 1000,
    zoomFactor: Number(els.dashboardZoomPercent.value || 100) / 100,
    scrollOffsetPx: Number(els.dashboardScrollOffsetPx.value || 0),
    defaultZoomFactor: Number(els.dashboardZoomPercent.value || 100) / 100,
    defaultScrollOffsetPx: Number(els.dashboardScrollOffsetPx.value || 0),
    tags: String(els.dashboardTags.value || '').split(',').map((item) => item.trim()).filter(Boolean),
    settleMs: Number(els.dashboardSettleMs.value || 3000),
    timeoutMs: Number(els.dashboardTimeoutMs.value || 20000),
    enabled: !!els.dashboardEnabled.checked
  };
}

function resetDashboardForm() {
  selectedDashboardId = null;
  if (els.dashboardFormTitle) els.dashboardFormTitle.textContent = 'Add Dashboard';
  if (els.dashboardFormSubtitle) els.dashboardFormSubtitle.textContent = 'Create or update a dashboard source';
  if (els.dashboardId) els.dashboardId.value = '';
  if (els.dashboardName) els.dashboardName.value = '';
  if (els.dashboardUrl) els.dashboardUrl.value = '';
  if (els.dashboardDurationSec) els.dashboardDurationSec.value = '30';
  if (els.dashboardZoomPercent) els.dashboardZoomPercent.value = '100';
  if (els.dashboardScrollOffsetPx) els.dashboardScrollOffsetPx.value = '0';
  if (els.dashboardTags) els.dashboardTags.value = '';
  if (els.dashboardSettleMs) els.dashboardSettleMs.value = '3000';
  if (els.dashboardTimeoutMs) els.dashboardTimeoutMs.value = '20000';
  if (els.dashboardEnabled) els.dashboardEnabled.checked = true;
}

function populateDashboardForm(id) {
  const dashboard = getDashboard(id);
  if (!dashboard) return;
  selectedDashboardId = id;
  setView('library');
  if (els.dashboardFormTitle) els.dashboardFormTitle.textContent = 'Edit Dashboard';
  if (els.dashboardFormSubtitle) els.dashboardFormSubtitle.textContent = `Editing ${dashboard.name}`;
  els.dashboardId.value = dashboard.id;
  els.dashboardName.value = dashboard.name;
  els.dashboardUrl.value = dashboard.url;
  els.dashboardDurationSec.value = Math.round(Number(dashboard.durationMs || 30000) / 1000);
  els.dashboardZoomPercent.value = Math.round(Number(dashboard.zoomFactor || dashboard.defaultZoomFactor || 1) * 100);
  els.dashboardScrollOffsetPx.value = Number(dashboard.scrollOffsetPx || dashboard.defaultScrollOffsetPx || 0);
  els.dashboardTags.value = Array.isArray(dashboard.tags) ? dashboard.tags.join(', ') : '';
  els.dashboardSettleMs.value = Number(dashboard.settleMs || 3000);
  els.dashboardTimeoutMs.value = Number(dashboard.timeoutMs || 20000);
  els.dashboardEnabled.checked = dashboard.enabled !== false;
  renderDashboardLibrary();
}

async function previewDashboard(dashboard) {
  try {
    const result = await window.wallboardApi.previewDashboard(dashboard);
    if (!result.ok) { showFailure(`Preview failed: ${result.error}`); return; }
    renderStudioDiagnostics(result.previewDiagnostics);
    showSuccess('Preview opened.');
  } catch (err) { showFailure(`Preview failed: ${err.message}`); }
}

function renderStudioDiagnostics(diagnostics) {
  if (!els.studioDiagnostics) return;
  const scroll = diagnostics?.scrollResult || {};
  const metrics = diagnostics?.pageMetrics || {};
  els.studioDiagnostics.innerHTML = `
    <h4>Diagnostics</h4>
    <div class="diagnostics-grid">
      <div><span>Applied offset</span><strong>${Number(scroll.appliedOffset || diagnostics?.scrollOffsetPx || 0)}px</strong></div>
      <div><span>Target</span><strong>${escapeHtml(scroll.target || 'none')}</strong></div>
      <div><span>Max offset</span><strong>${Number(scroll.maxOffset || 0)}px</strong></div>
      <div><span>Page height</span><strong>${Number(metrics.pageHeight || 0)}px</strong></div>
      <div><span>Viewport</span><strong>${Number(metrics.viewportHeight || 0)}px</strong></div>
      <div><span>Zoom</span><strong>${Math.round(Number(diagnostics?.zoomFactor || 1) * 100)}%</strong></div>
    </div>
  `;
}

function openDisplayDrawer(displayIndex) {
  const display = getDetectedDisplays().find((item) => Number(item.index) === Number(displayIndex));
  const assigned = getScreenForDisplay(displayIndex);
  if (!els.sideDrawer || !display) return;
  els.sideDrawer.innerHTML = `
    <div class="drawer-header"><div><h3>${escapeHtml(display.label)}</h3><p>${escapeHtml(display.size)}${display.primary ? ' · Primary' : ''}</p></div><button type="button" data-close-drawer>×</button></div>
    <label class="field"><span>Assigned Screen</span><select id="drawerScreenSelect"><option value="">Unassigned</option>${configModel.screens.map((screen) => `<option value="${escapeHtml(screen.id)}" ${assigned?.id === screen.id ? 'selected' : ''}>${escapeHtml(screen.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Playlist</span><select id="drawerPlaylistSelect"><option value="">No playlist</option>${configModel.playlists.map((playlist) => `<option value="${escapeHtml(playlist.id)}" ${assigned?.playlistId === playlist.id ? 'selected' : ''}>${escapeHtml(playlist.name)}</option>`).join('')}</select></label>
    <div class="form-actions"><button class="primary" type="button" data-save-display="${display.index}">Save Assignment</button><button type="button" data-close-drawer>Cancel</button></div>
  `;
  els.sideDrawer.classList.remove('hidden');
  els.drawerBackdrop?.classList.remove('hidden');
}

function closeDrawer() { els.sideDrawer?.classList.add('hidden'); els.drawerBackdrop?.classList.add('hidden'); }

function saveDisplayAssignment(displayIndex) {
  const screenId = document.getElementById('drawerScreenSelect')?.value;
  const playlistId = document.getElementById('drawerPlaylistSelect')?.value;
  let screen = screenId ? getScreen(screenId) : null;
  if (!screen) {
    screen = { id: uid('screen'), name: `Display ${Number(displayIndex) + 1}`, displayIndex: Number(displayIndex), enabled: true, playlistId: playlistId || '' };
    configModel.screens.push(screen);
  } else {
    screen.displayIndex = Number(displayIndex);
    screen.playlistId = playlistId || screen.playlistId || '';
  }
  markDirty(); closeDrawer(); renderAll();
}

async function saveAll() {
  try {
    bindSettingsBackToModel();
    const result = await window.wallboardApi.saveConfig(configModel);
    if (!result.ok) { showFailure(`Publish failed: ${result.error}`); return; }
    configModel = deepClone(await window.wallboardApi.getConfig());
    appState = await window.wallboardApi.getState();
    normaliseConfig(); clearDirty(); renderAll(); showSuccess('Changes published and screens reloaded.');
  } catch (err) { showFailure(`Publish failed: ${err.message}`); }
}

function bindSettingsBackToModel() {
  configModel.settings.kioskMode = !!els.settingKioskMode?.checked;
  configModel.settings.trayOnlyStartup = !!els.settingTrayOnlyStartup?.checked;
  configModel.settings.hideAdminToTray = !!els.settingHideAdminToTray?.checked;
  configModel.settings.startWithWindows = !!els.settingStartWithWindows?.checked;
  configModel.settings.identifyOverlaySeconds = Number(els.settingIdentifyOverlaySeconds?.value || 4);
}

function currentPlaylist() { return getPlaylist(selectedPlaylistId) || configModel.playlists[0]; }

function addDashboardToCurrentPlaylist(dashboardId) {
  let playlist = currentPlaylist();
  if (!playlist) { playlist = { id: uid('playlist'), name: 'New Playlist', items: [] }; configModel.playlists.push(playlist); selectedPlaylistId = playlist.id; }
  const dashboard = getDashboard(dashboardId);
  if (!dashboard) return;
  playlist.items.push({ id: uid('pli'), dashboardId, durationMs: Number(dashboard.durationMs || 30000), zoomFactor: Number(dashboard.zoomFactor || 1), scrollOffsetPx: Number(dashboard.scrollOffsetPx || 0), settleMs: Number(dashboard.settleMs || 3000), timeoutMs: Number(dashboard.timeoutMs || 20000), enabled: true });
  markDirty(); renderPlaylistBuilder();
}

function bindEvents() {
  if (eventsBound) return; eventsBound = true;
  els.navButtons.forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  els.commandHero?.addEventListener('click', (e) => { const action = e.target.closest('button')?.dataset.action; if (action === 'publish') saveAll(); if (action === 'reload') window.wallboardApi.reloadScreens(); if (action === 'identify') window.wallboardApi.identifyDisplays(); });
  els.btnSaveAll?.addEventListener('click', saveAll);
  els.btnReload?.addEventListener('click', async () => { await window.wallboardApi.reloadScreens(); showSuccess('Screens reloaded.'); });
  els.btnIdentify?.addEventListener('click', async () => { await window.wallboardApi.identifyDisplays(); showSuccess('Identify displays triggered.'); });
  els.btnIdentifyFromMap?.addEventListener('click', async () => { await window.wallboardApi.identifyDisplays(); showSuccess('Identify displays triggered.'); });
  els.btnPauseResume?.addEventListener('click', async () => { await window.wallboardApi.toggleRotation(); });
  els.btnCreateBackup?.addEventListener('click', async () => { const r = await window.wallboardApi.createConfigBackup(); r.ok ? showSuccess('Backup created.') : showFailure(r.error); });
  els.btnExportConfig?.addEventListener('click', async () => { const r = await window.wallboardApi.exportConfig(); if (!r.cancelled) r.ok ? showSuccess('Config exported.') : showFailure(r.error); });
  els.btnImportConfig?.addEventListener('click', async () => { const r = await window.wallboardApi.importConfig(); if (!r.cancelled) { if (!r.ok) showFailure(r.error); else { configModel = deepClone(await window.wallboardApi.getConfig()); appState = await window.wallboardApi.getState(); renderAll(); showSuccess('Config imported.'); } } });
  els.btnOpenConfigFolder?.addEventListener('click', () => window.wallboardApi.openConfigFolder());
  els.btnOpenLogs?.addEventListener('click', () => window.wallboardApi.openLogFolder());
  els.displayGrid?.addEventListener('click', (e) => { const configure = e.target.closest('[data-display-configure]'); const card = e.target.closest('[data-display-index]'); if (configure) openDisplayDrawer(configure.dataset.displayConfigure); else if (card) openDisplayDrawer(card.dataset.displayIndex); });
  els.sideDrawer?.addEventListener('click', (e) => { if (e.target.closest('[data-close-drawer]')) closeDrawer(); const save = e.target.closest('[data-save-display]'); if (save) saveDisplayAssignment(save.dataset.saveDisplay); });
  els.drawerBackdrop?.addEventListener('click', closeDrawer);
  els.playlistSelect?.addEventListener('change', () => { selectedPlaylistId = els.playlistSelect.value; renderPlaylistBuilder(); });
  els.librarySearch?.addEventListener('input', renderPlaylistLibrary);
  els.btnAddPlaylist?.addEventListener('click', () => { const playlist = { id: uid('playlist'), name: 'New Playlist', items: [] }; configModel.playlists.push(playlist); selectedPlaylistId = playlist.id; markDirty(); renderPlaylistBuilder(); });
  els.btnSavePlaylistName?.addEventListener('click', () => { const playlist = currentPlaylist(); if (playlist && els.playlistName.value.trim()) { playlist.name = els.playlistName.value.trim(); markDirty(); renderAll(); } });
  els.btnDuplicatePlaylist?.addEventListener('click', () => { const playlist = currentPlaylist(); if (!playlist) return; const copy = deepClone(playlist); copy.id = uid('playlist'); copy.name = `${playlist.name} Copy`; copy.items.forEach((item) => item.id = uid('pli')); configModel.playlists.push(copy); selectedPlaylistId = copy.id; markDirty(); renderAll(); });
  els.btnApplyPlaylist?.addEventListener('click', () => { const screen = getScreen(els.applyPlaylistScreen.value); const playlist = currentPlaylist(); if (screen && playlist) { screen.playlistId = playlist.id; markDirty(); renderAll(); showSuccess(`Applied ${playlist.name} to ${screen.name}.`); } });
  els.playlistLibrary?.addEventListener('dragstart', (e) => { const card = e.target.closest('[data-library-dashboard]'); if (!card) return; draggedDashboardId = card.dataset.libraryDashboard; e.dataTransfer.setData('text/plain', draggedDashboardId); });
  els.playlistDropZone?.addEventListener('dragover', (e) => e.preventDefault());
  els.playlistDropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    const playlist = currentPlaylist();
    if (draggedDashboardId) {
      addDashboardToCurrentPlaylist(draggedDashboardId);
      draggedDashboardId = null;
      return;
    }
    if (playlist && draggedPlaylistIndex !== null && draggedPlaylistIndex !== undefined) {
      const target = e.target.closest('[data-playlist-index]');
      const from = Number(draggedPlaylistIndex);
      const to = target ? Number(target.dataset.playlistIndex) : playlist.items.length - 1;
      if (from >= 0 && to >= 0 && from !== to) {
        const [moved] = playlist.items.splice(from, 1);
        playlist.items.splice(to, 0, moved);
        markDirty();
        renderPlaylistBuilder();
      }
      draggedPlaylistIndex = null;
    }
  });
  els.playlistDropZone?.addEventListener('dragstart', (e) => { const item = e.target.closest('[data-playlist-index]'); if (!item) return; draggedPlaylistIndex = Number(item.dataset.playlistIndex); e.dataTransfer.setData('text/plain', String(draggedPlaylistIndex)); });
  els.playlistDropZone?.addEventListener('click', (e) => {
    const playlist = currentPlaylist(); if (!playlist) return;
    const remove = e.target.closest('[data-item-remove]'); const studio = e.target.closest('[data-item-studio]');
    if (remove) { playlist.items.splice(Number(remove.dataset.itemRemove), 1); markDirty(); renderPlaylistBuilder(); }
    if (studio) { const item = playlist.items[Number(studio.dataset.itemStudio)]; selectedDashboardId = item.dashboardId; setView('studio'); renderStudioOptions(); }
  });
  els.playlistDropZone?.addEventListener('change', (e) => { const input = e.target.closest('[data-item-field]'); if (!input) return; const playlist = currentPlaylist(); const item = playlist?.items[Number(input.dataset.index)]; if (!item) return; if (input.dataset.itemField === 'durationSec') item.durationMs = Number(input.value) * 1000; if (input.dataset.itemField === 'zoomPercent') item.zoomFactor = Number(input.value) / 100; if (input.dataset.itemField === 'scrollOffsetPx') item.scrollOffsetPx = Number(input.value); markDirty(); });
  els.dashboardForm?.addEventListener('submit', (e) => { e.preventDefault(); const model = buildDashboardFromForm(); const idx = configModel.dashboards.findIndex((dashboard) => dashboard.id === model.id); if (idx >= 0) configModel.dashboards[idx] = { ...configModel.dashboards[idx], ...model }; else configModel.dashboards.push(model); selectedDashboardId = model.id; markDirty(); renderAll(); populateDashboardForm(model.id); showSuccess('Dashboard saved in draft. Publish to apply.'); });
  els.btnAddDashboard?.addEventListener('click', () => { resetDashboardForm(); setView('library'); });
  els.btnResetDashboard?.addEventListener('click', resetDashboardForm);
  els.btnPreviewDashboard?.addEventListener('click', () => { const dashboard = buildDashboardFromForm(); if (!dashboard.url) return showFailure('Preview requires a URL.'); previewDashboard(dashboard); });
  els.dashboardLibraryList?.addEventListener('click', (e) => { const edit = e.target.closest('[data-dashboard-edit]'); const preview = e.target.closest('[data-dashboard-preview]'); const studio = e.target.closest('[data-dashboard-studio]'); const del = e.target.closest('[data-dashboard-delete]'); if (edit) populateDashboardForm(edit.dataset.dashboardEdit); if (preview) { const d = getDashboard(preview.dataset.dashboardPreview); if (d) previewDashboard(d); } if (studio) { selectedDashboardId = studio.dataset.dashboardStudio; setView('studio'); renderStudioOptions(); } if (del && window.confirm('Delete this dashboard?')) { configModel.dashboards = configModel.dashboards.filter((d) => d.id !== del.dataset.dashboardDelete); configModel.playlists.forEach((p) => p.items = p.items.filter((i) => i.dashboardId !== del.dataset.dashboardDelete)); markDirty(); renderAll(); } });
  els.studioDashboardSelect?.addEventListener('change', () => { selectedDashboardId = els.studioDashboardSelect.value; syncStudioFromDashboard(); });
  els.btnStudioOpenPreview?.addEventListener('click', () => { const model = getStudioDashboardModel(); if (model) previewDashboard(model); });
  [els.studioOffsetRange, els.studioOffsetNumber].forEach((el) => el?.addEventListener('input', (e) => { els.studioOffsetRange.value = e.target.value; els.studioOffsetNumber.value = e.target.value; scheduleStudioUpdate(); }));
  [els.studioZoomRange, els.studioZoomNumber].forEach((el) => el?.addEventListener('input', (e) => { els.studioZoomRange.value = e.target.value; els.studioZoomNumber.value = e.target.value; scheduleStudioUpdate(); }));
  document.querySelectorAll('[data-offset-nudge]').forEach((button) => button.addEventListener('click', () => { const next = Math.max(0, Number(els.studioOffsetNumber.value || 0) + Number(button.dataset.offsetNudge)); els.studioOffsetNumber.value = next; els.studioOffsetRange.value = next; scheduleStudioUpdate(); }));
  els.btnStudioReset?.addEventListener('click', () => { els.studioOffsetNumber.value = 0; els.studioOffsetRange.value = 0; scheduleStudioUpdate(); });
  els.btnStudioApplyDefault?.addEventListener('click', () => { const dashboard = getDashboard(selectedDashboardId); if (!dashboard) return; dashboard.scrollOffsetPx = Number(els.studioOffsetNumber.value || 0); dashboard.defaultScrollOffsetPx = dashboard.scrollOffsetPx; dashboard.zoomFactor = Number(els.studioZoomNumber.value || 100) / 100; dashboard.defaultZoomFactor = dashboard.zoomFactor; markDirty(); renderAll(); showSuccess('Offset and zoom applied to dashboard draft.'); });
  window.wallboardApi.onAppState((state) => { appState = state; renderStatusStrip(); renderHome(); renderDisplays(); renderRuntime(); renderDashboardLibrary(); });
}

function scheduleStudioUpdate() {
  clearTimeout(studioUpdateTimer);
  studioUpdateTimer = setTimeout(async () => {
    const model = getStudioDashboardModel();
    if (!model || !window.wallboardApi.updatePreviewView) return;
    const result = await window.wallboardApi.updatePreviewView(model);
    if (result.ok) renderStudioDiagnostics(result.previewDiagnostics);
  }, 180);
}

async function init() {
  try {
    if (!window.wallboardApi) throw new Error('window.wallboardApi is not available. Check preload.js.');
    configModel = deepClone(await window.wallboardApi.getConfig());
    appState = await window.wallboardApi.getState();
    normaliseConfig();
    bindEvents();
    renderAll();
    resetDashboardForm();
  } catch (err) { showFailure(`Admin UI initialisation failed: ${err.message}`); }
}

window.addEventListener('DOMContentLoaded', init);
