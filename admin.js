let appState = null;
let configModel = null;
let eventsBound = false;
let selectedScreenId = null;
let selectedDashboardId = null;
let draggedDashboardId = null;

const els = {
  toastContainer: document.getElementById('toastContainer'),
  errorBanner: document.getElementById('errorBanner'),

  pageTitle: document.getElementById('pageTitle'),
  pageSubtitle: document.getElementById('pageSubtitle'),

  statusRotation: document.getElementById('statusRotation'),
  statusStartup: document.getElementById('statusStartup'),
  statusKiosk: document.getElementById('statusKiosk'),

  navButtons: Array.from(document.querySelectorAll('.nav-btn')),
  views: Array.from(document.querySelectorAll('.view')),

  btnSaveAll: document.getElementById('btnSaveAll'),
  btnIdentify: document.getElementById('btnIdentify'),
  btnIdentifyFromMap: document.getElementById('btnIdentifyFromMap'),
  btnReload: document.getElementById('btnReload'),
  btnPauseResume: document.getElementById('btnPauseResume'),
  btnOpenLogs: document.getElementById('btnOpenLogs'),

  btnCreateBackup: document.getElementById('btnCreateBackup'),
  btnExportConfig: document.getElementById('btnExportConfig'),
  btnImportConfig: document.getElementById('btnImportConfig'),
  btnOpenConfigFolder: document.getElementById('btnOpenConfigFolder'),

  ovConfiguredScreens: document.getElementById('ovConfiguredScreens'),
  ovConfiguredDashboards: document.getElementById('ovConfiguredDashboards'),
  ovDetectedDisplays: document.getElementById('ovDetectedDisplays'),
  ovRuntimeScreens: document.getElementById('ovRuntimeScreens'),
  overviewRuntimeCards: document.getElementById('overviewRuntimeCards'),
  overviewDisplays: document.getElementById('overviewDisplays'),
  screenDisplayMap: document.getElementById('screenDisplayMap'),

  screensList: document.getElementById('screensList'),
  dashboardsList: document.getElementById('dashboardsList'),
  runtimeCards: document.getElementById('runtimeCards'),

  settingKioskMode: document.getElementById('settingKioskMode'),
  settingTrayOnlyStartup: document.getElementById('settingTrayOnlyStartup'),
  settingHideAdminToTray: document.getElementById('settingHideAdminToTray'),
  settingStartWithWindows: document.getElementById('settingStartWithWindows'),
  settingIdentifyOverlaySeconds: document.getElementById('settingIdentifyOverlaySeconds'),

  screenForm: document.getElementById('screenForm'),
  screenEditorPanel: document.getElementById('screenEditorPanel'),
  screenFormTitle: document.getElementById('screenFormTitle'),
  screenFormSubtitle: document.getElementById('screenFormSubtitle'),
  screenId: document.getElementById('screenId'),
  screenName: document.getElementById('screenName'),
  screenDisplayIndex: document.getElementById('screenDisplayIndex'),
  screenEnabled: document.getElementById('screenEnabled'),
  btnAddScreen: document.getElementById('btnAddScreen'),
  btnResetScreen: document.getElementById('btnResetScreen'),

  dashboardForm: document.getElementById('dashboardForm'),
  dashboardEditorPanel: document.getElementById('dashboardEditorPanel'),
  dashboardFormTitle: document.getElementById('dashboardFormTitle'),
  dashboardFormSubtitle: document.getElementById('dashboardFormSubtitle'),
  dashboardId: document.getElementById('dashboardId'),
  dashboardName: document.getElementById('dashboardName'),
  dashboardUrl: document.getElementById('dashboardUrl'),
  dashboardScreenId: document.getElementById('dashboardScreenId'),
  dashboardSequence: document.getElementById('dashboardSequence'),
  dashboardDurationSec: document.getElementById('dashboardDurationSec'),
  dashboardZoomPercent: document.getElementById('dashboardZoomPercent'),
  dashboardScrollOffsetPx: document.getElementById('dashboardScrollOffsetPx'),
  dashboardSettleMs: document.getElementById('dashboardSettleMs'),
  dashboardTimeoutMs: document.getElementById('dashboardTimeoutMs'),
  dashboardEnabled: document.getElementById('dashboardEnabled'),
  btnAddDashboard: document.getElementById('btnAddDashboard'),
  btnPreviewDashboard: document.getElementById('btnPreviewDashboard'),
  btnResetDashboard: document.getElementById('btnResetDashboard'),
  dashboardFilterScreen: document.getElementById('dashboardFilterScreen')
};

const viewMeta = {
  overview: {
    title: 'Overview',
    subtitle: 'Quick summary of screens, dashboards and current playback'
  },
  screens: {
    title: 'Screens',
    subtitle: 'Assign named screens to physical displays'
  },
  dashboards: {
    title: 'Dashboards',
    subtitle: 'Manage URLs, order, display time, zoom and offset per screen'
  },
  settings: {
    title: 'Settings',
    subtitle: 'Control app startup and behaviour'
  },
  runtime: {
    title: 'Runtime',
    subtitle: 'See what is currently playing on each active screen'
  }
};

function showError(message) {
  console.error(message);

  if (!els.errorBanner) return;

  els.errorBanner.textContent = message;
  els.errorBanner.classList.remove('hidden');
}

function clearError() {
  if (!els.errorBanner) return;

  els.errorBanner.textContent = '';
  els.errorBanner.classList.add('hidden');
}

function showToast(message, type = 'info', timeoutMs = 3500) {
  if (!els.toastContainer) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  els.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';

    setTimeout(() => {
      toast.remove();
    }, 180);
  }, timeoutMs);
}

function showSuccess(message) {
  clearError();
  showToast(message, 'success');
}

function showFailure(message) {
  showError(message);
  showToast(message, 'error', 5000);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function uid(prefix) {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normaliseConfig() {
  if (!configModel || typeof configModel !== 'object') {
    configModel = {
      settings: {},
      screens: [],
      dashboards: []
    };
  }

  if (!configModel.settings || typeof configModel.settings !== 'object') {
    configModel.settings = {};
  }

  if (!Array.isArray(configModel.screens)) {
    configModel.screens = [];
  }

  if (!Array.isArray(configModel.dashboards)) {
    configModel.dashboards = [];
  }
}

function getDetectedDisplays() {
  if (!appState || !Array.isArray(appState.detectedDisplays)) return [];
  return appState.detectedDisplays;
}

function getRuntimeScreens() {
  if (!appState || !Array.isArray(appState.runtimeScreens)) return [];
  return appState.runtimeScreens;
}

function getScreenName(screenIdValue) {
  const match = configModel.screens.find((screenItem) => screenItem.id === screenIdValue);
  return match ? match.name : '(unassigned)';
}

function screenExists(screenIdValue) {
  return configModel.screens.some((screenItem) => screenItem.id === screenIdValue);
}


function getDashboardHealthInfo(dashboardIdValue) {
  if (!appState || !Array.isArray(appState.dashboardHealth)) return null;
  return appState.dashboardHealth.find((item) => item.dashboardId === dashboardIdValue) || null;
}
function formatHealthTime(value) {
  if (!value) return 'Never';
  try { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch (_) { return String(value); }
}
function renderDashboardHealthSummary() {
  const healthItems = Array.isArray(appState?.dashboardHealth) ? appState.dashboardHealth : [];
  const total = configModel.dashboards.length;
  const ok = healthItems.filter((item) => item.lastStatus === 'ok').length;
  const failed = healthItems.filter((item) => item.lastStatus === 'fail').length;
  const unknown = Math.max(0, total - ok - failed);
  return `
    <div class="dashboard-health-summary">
      <div><span>Dashboard Health</span><strong>${ok} OK</strong></div>
      <div><span>Failures</span><strong>${failed}</strong></div>
      <div><span>Awaiting data</span><strong>${unknown}</strong></div>
      <p>Health is populated after a dashboard completes a load or a preview. Existing already-loaded dashboards will show data after the next rotation, reload or preview.</p>
    </div>
  `;
}
function renderDashboardHealthHistory(dashboardIdValue) {
  const health = getDashboardHealthInfo(dashboardIdValue);
  if (!health || !Array.isArray(health.history) || health.history.length === 0) {
    return `
      <div class="dashboard-health-history empty">
        <strong>Recent health</strong>
        <span>Awaiting first load event. Click Preview or wait for the next rotation/reload.</span>
      </div>
    `;
  }
  const latest = health.history[0];
  const latestClass = latest.status === 'ok' ? 'enabled' : 'disabled';
  return `
    <div class="dashboard-health-history">
      <div class="dashboard-health-head">
        <strong>Recent health</strong>
        <span class="badge ${latestClass}">${latest.status === 'ok' ? 'Last OK' : 'Last failed'}</span>
      </div>
      <div class="health-history-list">
        ${health.history.slice(0, 5).map((item) => `
          <div class="health-history-row ${item.status === 'ok' ? 'ok' : 'fail'}">
            <span>${item.status === 'ok' ? 'OK' : 'FAIL'}</span>
            <span>${formatHealthTime(item.at)}</span>
            <span>${item.status === 'ok' ? `${item.loadMs || '?'}ms · ${Number(item.offsetApplied || 0)}px offset` : escapeHtml(item.reason || 'Unknown failure')}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}
function renderPreviewDiagnostics(result) {
  const diagnostics = result && result.previewDiagnostics ? result.previewDiagnostics : null;
  if (!diagnostics) return;
  const scroll = diagnostics.scrollResult || {};
  const metrics = diagnostics.pageMetrics || {};
  let panel = document.getElementById('previewDiagnosticsPanel');
  if (!panel && els.dashboardForm) {
    panel = document.createElement('div');
    panel.id = 'previewDiagnosticsPanel';
    panel.className = 'preview-diagnostics-panel';
    els.dashboardForm.insertAdjacentElement('afterend', panel);
  }
  if (!panel) return;
  panel.innerHTML = `
    <h4>Preview diagnostics</h4>
    <div class="preview-diagnostics-grid">
      <div><span>Offset requested</span><strong>${Number(diagnostics.scrollOffsetPx || 0)}px</strong></div>
      <div><span>Offset applied</span><strong>${Number(scroll.appliedOffset || 0)}px</strong></div>
      <div><span>Scroll target</span><strong>${escapeHtml(scroll.target || 'none')}</strong></div>
      <div><span>Max offset</span><strong>${Number(scroll.maxOffset || 0)}px</strong></div>
      <div><span>Page height</span><strong>${Number(metrics.pageHeight || 0)}px</strong></div>
      <div><span>Viewport</span><strong>${Number(metrics.viewportHeight || 0)}px</strong></div>
      <div><span>Zoom</span><strong>${Math.round(Number(diagnostics.zoomFactor || 1) * 100)}%</strong></div>
      <div><span>Loaded</span><strong>${formatHealthTime(diagnostics.loadedAt)}</strong></div>
    </div>
    ${scroll.error ? `<p class="preview-diagnostics-error">${escapeHtml(scroll.error)}</p>` : ''}
  `;
}

function formatSecondsFromMs(ms) {
  return `${Math.round(Number(ms || 0) / 1000)} sec`;
}

function formatPercentFromZoom(zoomFactor) {
  return `${Math.round(Number(zoomFactor || 1) * 100)}%`;
}

function setView(viewName) {
  els.navButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewName);
  });

  els.views.forEach((view) => {
    view.classList.toggle('active', view.id === `view-${viewName}`);
  });

  if (els.pageTitle) {
    els.pageTitle.textContent = viewMeta[viewName]?.title || 'Admin';
  }

  if (els.pageSubtitle) {
    els.pageSubtitle.textContent = viewMeta[viewName]?.subtitle || '';
  }
}

function scrollFormIntoView(formElement) {
  if (!formElement) return;

  formElement.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
    inline: 'nearest'
  });
}

function flashForm(panelElement) {
  if (!panelElement) return;

  panelElement.classList.remove('form-flash');
  void panelElement.offsetWidth;
  panelElement.classList.add('form-flash');

  setTimeout(() => {
    panelElement.classList.remove('form-flash');
  }, 1600);
}

function bindStatusStrip() {
  const settings = configModel.settings || {};

  if (els.statusRotation) {
    els.statusRotation.textContent = `Rotation: ${appState && appState.rotationPaused ? 'Paused' : 'Running'}`;
  }

  if (els.statusStartup) {
    els.statusStartup.textContent = `Startup: ${settings.startWithWindows ? 'On' : 'Off'}`;
  }

  if (els.statusKiosk) {
    els.statusKiosk.textContent = `Kiosk: ${settings.kioskMode ? 'On' : 'Off'}`;
  }

  if (els.btnPauseResume) {
    els.btnPauseResume.textContent = appState && appState.rotationPaused ? 'Resume Rotation' : 'Pause Rotation';
  }
}


function getScreenForDisplay(displayIndexValue) {
  return configModel.screens.find((screenItem) => Number(screenItem.displayIndex) === Number(displayIndexValue));
}

function getDashboardCountForScreen(screenIdValue) {
  return configModel.dashboards.filter((dashboardItem) => dashboardItem.screenId === screenIdValue).length;
}


function getRuntimeScreenForScreenId(screenIdValue) {
  return getRuntimeScreens().find((item) => item.screenId === screenIdValue) || null;
}

function renderScreenSnapshot(runtimeItem, label = 'screen') {
  const snapshot = runtimeItem && runtimeItem.snapshot ? runtimeItem.snapshot : null;
  if (snapshot && snapshot.dataUrl) {
    return `
      <div class="screen-snapshot live">
        <img src="${snapshot.dataUrl}" alt="Live preview for ${escapeHtml(label)}">
        <span>Live preview · ${formatHealthTime(snapshot.capturedAt)}</span>
      </div>
    `;
  }
  return `
    <div class="screen-snapshot placeholder">
      <div class="snapshot-grid"></div>
      <span>No live preview yet</span>
    </div>
  `;
}

function renderDisplayMap(targetElement, compact = false) {
  if (!targetElement) return;

  const detected = getDetectedDisplays();

  if (detected.length === 0) {
    targetElement.innerHTML = `<div class="display-map-card unassigned"><h4>No displays detected</h4><p class="muted">Electron did not report any physical displays.</p></div>`;
    return;
  }

  targetElement.innerHTML = detected.map((displayItem) => {
    const assignedScreen = getScreenForDisplay(displayItem.index);
    const dashboardCount = assignedScreen ? getDashboardCountForScreen(assignedScreen.id) : 0;
    const isSelected = assignedScreen && assignedScreen.id === selectedScreenId;
    const runtimeItem = assignedScreen ? getRuntimeScreenForScreenId(assignedScreen.id) : null;

    return `
      <div class="display-map-card ${assignedScreen ? '' : 'unassigned'} ${isSelected ? 'selected' : ''}" data-display-index="${displayItem.index}">
        <div class="display-card-topline"><h4>${escapeHtml(displayItem.label)}${displayItem.primary ? ' (Primary)' : ''}</h4><span>${escapeHtml(displayItem.size)}</span></div>
        ${renderScreenSnapshot(runtimeItem, assignedScreen ? assignedScreen.name : displayItem.label)}
        <div class="display-map-screen">
          <div>
            <strong>${escapeHtml(assignedScreen ? assignedScreen.name : 'Unassigned')}</strong><br>
            <span>${assignedScreen ? `${dashboardCount} dashboard${dashboardCount === 1 ? '' : 's'}` : 'Click to create a screen mapping'}</span>
          </div>
          <span class="badge ${assignedScreen && assignedScreen.enabled !== false ? 'enabled' : assignedScreen ? 'disabled' : 'warn'}">${assignedScreen ? assignedScreen.enabled !== false ? 'Enabled' : 'Disabled' : 'Unassigned'}</span>
        </div>
        ${compact ? '' : `<div class="display-map-geometry"><div>X ${displayItem.bounds.x}</div><div>Y ${displayItem.bounds.y}</div><div>W ${displayItem.bounds.width}</div><div>H ${displayItem.bounds.height}</div></div>`}
      </div>
    `;
  }).join('');
}

function selectDisplay(displayIndexValue) {
  const assignedScreen = getScreenForDisplay(displayIndexValue);

  if (assignedScreen) {
    populateScreenForm(assignedScreen.id);
    return;
  }

  selectedScreenId = null;
  setView('screens');
  resetScreenForm();

  if (els.screenDisplayIndex) els.screenDisplayIndex.value = String(displayIndexValue);
  if (els.screenName) els.screenName.value = `Display ${Number(displayIndexValue) + 1}`;

  renderScreens();
  if (els.screenForm) els.screenForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  flashForm(els.screenEditorPanel);
}

function renderOverview() {
  const displays = getDetectedDisplays();
  const runtime = getRuntimeScreens();

  if (els.ovConfiguredScreens) els.ovConfiguredScreens.textContent = String(configModel.screens.length);
  if (els.ovConfiguredDashboards) els.ovConfiguredDashboards.textContent = String(configModel.dashboards.length);
  if (els.ovDetectedDisplays) els.ovDetectedDisplays.textContent = String(displays.length);
  if (els.ovRuntimeScreens) els.ovRuntimeScreens.textContent = String(runtime.length);

  if (els.overviewRuntimeCards) {
    if (runtime.length === 0) {
      els.overviewRuntimeCards.innerHTML = `
        <div class="runtime-card">
          <h4>No active playback</h4>
          <p class="muted">No wallboard windows are currently running.</p>
        </div>
      `;
    } else {
      els.overviewRuntimeCards.innerHTML = runtime.map((item) => `
        <div class="runtime-card">
          <h4>${escapeHtml(item.screenName || item.screenId)}</h4>
          <div class="meta-row">
            <span class="badge">Display ${Number(item.displayIndex) + 1}</span>
            <span class="badge">${Number(item.currentIndex) + 1} / ${item.totalItems}</span>
          </div>
          <p><strong>Current:</strong> ${escapeHtml(item.currentDashboard || 'N/A')}</p>
          <p class="url-line">${escapeHtml(item.currentUrl || '')}</p>
        </div>
      `).join('');
    }
  }

  renderDisplayMap(els.overviewDisplays, true);
}


function repopulateSelectors() {
  const displays = getDetectedDisplays();

  if (els.screenDisplayIndex) {
    const existingDisplayValue = els.screenDisplayIndex.value;

    els.screenDisplayIndex.innerHTML = displays.map((displayItem) => {
      return `<option value="${displayItem.index}">${escapeHtml(displayItem.label)}${displayItem.primary ? ' (Primary)' : ''} — ${escapeHtml(displayItem.size)}</option>`;
    }).join('');

    if (existingDisplayValue !== '') {
      els.screenDisplayIndex.value = existingDisplayValue;
    }
  }

  const screenOptions = configModel.screens.map((screenItem) => {
    return `<option value="${escapeHtml(screenItem.id)}">${escapeHtml(screenItem.name)}</option>`;
  }).join('');

  if (els.dashboardScreenId) {
    const existingValue = els.dashboardScreenId.value;
    els.dashboardScreenId.innerHTML = screenOptions;

    if (existingValue && screenExists(existingValue)) {
      els.dashboardScreenId.value = existingValue;
    }
  }

  if (els.dashboardFilterScreen) {
    const currentValue = els.dashboardFilterScreen.value;
    els.dashboardFilterScreen.innerHTML = `<option value="">All screens</option>${screenOptions}`;

    if (currentValue && screenExists(currentValue)) {
      els.dashboardFilterScreen.value = currentValue;
    }
  }
}

function renderScreens() {
  renderDisplayMap(els.screenDisplayMap, false);

  if (!els.screensList) return;

  if (configModel.screens.length === 0) {
    els.screensList.innerHTML = `
      <div class="list-card">
        <h4>No screens yet</h4>
        <p class="muted">Add your first logical screen to get started.</p>
      </div>
    `;
    return;
  }

  const sorted = deepClone(configModel.screens).sort((a, b) => a.name.localeCompare(b.name));

  els.screensList.innerHTML = sorted.map((screenItem) => `
    <div class="list-card ${screenItem.id === selectedScreenId ? 'selected' : ''}">
      <h4>${escapeHtml(screenItem.name)}</h4>
      <div class="meta-row">
        <span class="badge">Display ${Number(screenItem.displayIndex) + 1}</span>
        <span class="badge ${screenItem.enabled !== false ? 'enabled' : 'disabled'}">${screenItem.enabled !== false ? 'Enabled' : 'Disabled'}</span>
      </div>
      <p class="muted">ID: ${escapeHtml(screenItem.id)}</p>
      <div class="item-actions">
        <button type="button" data-screen-edit="${escapeHtml(screenItem.id)}">Edit</button>
        <button type="button" data-screen-delete="${escapeHtml(screenItem.id)}">Delete</button>
      </div>
    </div>
  `).join('');
}

function getFilteredDashboards() {
  const filterScreenId = els.dashboardFilterScreen ? els.dashboardFilterScreen.value : '';
  let dashboards = deepClone(configModel.dashboards);

  dashboards = dashboards.filter((dashboardItem) => screenExists(dashboardItem.screenId));

  if (filterScreenId) {
    dashboards = dashboards.filter((dashboardItem) => dashboardItem.screenId === filterScreenId);
  }

  dashboards.sort((a, b) => {
    const aScreen = getScreenName(a.screenId);
    const bScreen = getScreenName(b.screenId);

    if (aScreen !== bScreen) return aScreen.localeCompare(bScreen);

    return Number(a.sequence || 0) - Number(b.sequence || 0);
  });

  return dashboards;
}

function renderDashboards() {
  if (!els.dashboardsList) return;

  const list = getFilteredDashboards();

  if (list.length === 0) {
    els.dashboardsList.innerHTML = `
      <div class="list-card">
        <h4>No dashboards found</h4>
        <p class="muted">Add a dashboard or change the filter.</p>
      </div>
    `;
    return;
  }

  els.dashboardsList.innerHTML = `
    ${renderDashboardHealthSummary()}
    <p class="drag-hint">Tip: drag dashboards up or down to reorder them. Reordering only applies within the same screen.</p>
    ${list.map((dashboardItem) => `
      <div class="list-card ${dashboardItem.id === selectedDashboardId ? 'selected' : ''}"
           draggable="true"
           data-dashboard-card="${escapeHtml(dashboardItem.id)}"
           data-dashboard-screen="${escapeHtml(dashboardItem.screenId)}">
        <h4>${escapeHtml(dashboardItem.name)}</h4>
        <div class="meta-row">
          <span class="badge">${escapeHtml(getScreenName(dashboardItem.screenId))}</span>
          <span class="badge">Seq ${Number(dashboardItem.sequence)}</span>
          <span class="badge">${formatSecondsFromMs(dashboardItem.durationMs)}</span>
          <span class="badge">${formatPercentFromZoom(dashboardItem.zoomFactor)}</span>
          <span class="badge">Offset ${Number(dashboardItem.scrollOffsetPx || 0)}px</span>
          <span class="badge ${dashboardItem.enabled !== false ? 'enabled' : 'disabled'}">${dashboardItem.enabled !== false ? 'Enabled' : 'Disabled'}</span>
        </div>
        <p class="url-line">${escapeHtml(dashboardItem.url)}</p>
        ${renderDashboardHealthHistory(dashboardItem.id)}
        <div class="item-actions">
          <button type="button" data-dashboard-edit="${escapeHtml(dashboardItem.id)}">Edit</button>
          <button type="button" data-dashboard-preview="${escapeHtml(dashboardItem.id)}">Preview</button>
          <button type="button" data-dashboard-delete="${escapeHtml(dashboardItem.id)}">Delete</button>
          <button type="button" data-dashboard-up="${escapeHtml(dashboardItem.id)}">↑</button>
          <button type="button" data-dashboard-down="${escapeHtml(dashboardItem.id)}">↓</button>
        </div>
      </div>
    `).join('')}
  `;
}

function renderSettings() {
  const settings = configModel.settings || {};

  if (els.settingKioskMode) els.settingKioskMode.checked = !!settings.kioskMode;
  if (els.settingTrayOnlyStartup) els.settingTrayOnlyStartup.checked = !!settings.trayOnlyStartup;
  if (els.settingHideAdminToTray) els.settingHideAdminToTray.checked = !!settings.hideAdminToTray;
  if (els.settingStartWithWindows) els.settingStartWithWindows.checked = !!settings.startWithWindows;
  if (els.settingIdentifyOverlaySeconds) els.settingIdentifyOverlaySeconds.value = Number(settings.identifyOverlaySeconds || 4);
}

function renderRuntime() {
  if (!els.runtimeCards) return;

  const runtime = getRuntimeScreens();

  if (runtime.length === 0) {
    els.runtimeCards.innerHTML = `
      <div class="runtime-card">
        <h4>No active runtime screens</h4>
        <p class="muted">Nothing is currently playing.</p>
      </div>
    `;
    return;
  }

  els.runtimeCards.innerHTML = runtime.map((item) => `
    <div class="runtime-card runtime-card-polished">
      ${renderScreenSnapshot(item, item.screenName || item.screenId)}
      <div class="runtime-details">
        <h4>${escapeHtml(item.screenName || item.screenId)}</h4>
        <div class="meta-row">
          <span class="badge">Display ${Number(item.displayIndex) + 1}</span>
          <span class="badge">${Number(item.currentIndex) + 1} / ${item.totalItems}</span>
        </div>
        <p><strong>Current Dashboard:</strong> ${escapeHtml(item.currentDashboard || 'N/A')}</p>
        <p class="url-line">${escapeHtml(item.currentUrl || '')}</p>
      </div>
    </div>
  `).join('');
}

function renderAll() {
  normaliseConfig();
  bindStatusStrip();
  repopulateSelectors();
  renderOverview();
  renderScreens();
  renderDashboards();
  renderSettings();
  renderRuntime();
}

function bindSettingsBackToModel() {
  configModel.settings.kioskMode = !!els.settingKioskMode?.checked;
  configModel.settings.trayOnlyStartup = !!els.settingTrayOnlyStartup?.checked;
  configModel.settings.hideAdminToTray = !!els.settingHideAdminToTray?.checked;
  configModel.settings.startWithWindows = !!els.settingStartWithWindows?.checked;
  configModel.settings.identifyOverlaySeconds = Number(els.settingIdentifyOverlaySeconds?.value || 4);
}

function buildDashboardFromForm() {
  return {
    id: els.dashboardId.value || uid('db'),
    name: els.dashboardName.value.trim(),
    url: els.dashboardUrl.value.trim(),
    screenId: els.dashboardScreenId.value,
    sequence: Number(els.dashboardSequence.value),
    durationMs: Number(els.dashboardDurationSec.value) * 1000,
    zoomFactor: Number(els.dashboardZoomPercent.value) / 100,
    scrollOffsetPx: Number(els.dashboardScrollOffsetPx?.value || 0),
    settleMs: Number(els.dashboardSettleMs.value),
    timeoutMs: Number(els.dashboardTimeoutMs.value),
    enabled: !!els.dashboardEnabled.checked
  };
}

function resetScreenForm() {
  if (els.screenFormTitle) els.screenFormTitle.textContent = 'Add Screen';
  if (els.screenFormSubtitle) els.screenFormSubtitle.textContent = 'Create or update a screen mapping';
  if (els.screenId) els.screenId.value = '';
  if (els.screenName) els.screenName.value = '';
  if (els.screenEnabled) els.screenEnabled.checked = true;

  const displays = getDetectedDisplays();

  if (els.screenDisplayIndex && displays.length > 0) {
    els.screenDisplayIndex.value = String(displays[0].index);
  }
}

function populateScreenForm(id) {
  const screenItem = configModel.screens.find((screen) => screen.id === id);

  if (!screenItem) return;

  selectedScreenId = id;
  renderScreens();
  setView('screens');

  if (els.screenFormTitle) els.screenFormTitle.textContent = 'Edit Screen';
  if (els.screenFormSubtitle) els.screenFormSubtitle.textContent = `Editing: ${screenItem.name}`;
  if (els.screenId) els.screenId.value = screenItem.id;
  if (els.screenName) els.screenName.value = screenItem.name;
  if (els.screenDisplayIndex) els.screenDisplayIndex.value = String(screenItem.displayIndex ?? 0);
  if (els.screenEnabled) els.screenEnabled.checked = screenItem.enabled !== false;

  if (els.screenForm) {
    scrollFormIntoView(els.screenForm);
    flashForm(els.screenEditorPanel);
  }

  setTimeout(() => {
    if (els.screenName) {
      els.screenName.focus();
      els.screenName.select();
    }
  }, 250);
}

function resetDashboardForm() {
  if (els.dashboardFormTitle) els.dashboardFormTitle.textContent = 'Add Dashboard';
  if (els.dashboardFormSubtitle) els.dashboardFormSubtitle.textContent = 'Create or update a dashboard entry';
  if (els.dashboardId) els.dashboardId.value = '';
  if (els.dashboardName) els.dashboardName.value = '';
  if (els.dashboardUrl) els.dashboardUrl.value = '';
  if (els.dashboardEnabled) els.dashboardEnabled.checked = true;
  if (els.dashboardSequence) els.dashboardSequence.value = '1';
  if (els.dashboardDurationSec) els.dashboardDurationSec.value = '30';
  if (els.dashboardZoomPercent) els.dashboardZoomPercent.value = '100';
  if (els.dashboardScrollOffsetPx) els.dashboardScrollOffsetPx.value = '0';
  if (els.dashboardSettleMs) els.dashboardSettleMs.value = '3000';
  if (els.dashboardTimeoutMs) els.dashboardTimeoutMs.value = '20000';

  if (els.dashboardScreenId && configModel.screens.length > 0) {
    els.dashboardScreenId.value = configModel.screens[0].id;
  }
}

function populateDashboardForm(id) {
  const dashboardItem = configModel.dashboards.find((dashboard) => dashboard.id === id);

  if (!dashboardItem) return;

  selectedDashboardId = id;
  renderDashboards();
  setView('dashboards');

  if (els.dashboardFormTitle) els.dashboardFormTitle.textContent = 'Edit Dashboard';
  if (els.dashboardFormSubtitle) els.dashboardFormSubtitle.textContent = `Editing: ${dashboardItem.name}`;
  if (els.dashboardId) els.dashboardId.value = dashboardItem.id;
  if (els.dashboardName) els.dashboardName.value = dashboardItem.name;
  if (els.dashboardUrl) els.dashboardUrl.value = dashboardItem.url;
  if (els.dashboardScreenId) els.dashboardScreenId.value = dashboardItem.screenId;
  if (els.dashboardSequence) els.dashboardSequence.value = String(dashboardItem.sequence);
  if (els.dashboardDurationSec) els.dashboardDurationSec.value = String(Math.round(Number(dashboardItem.durationMs) / 1000));
  if (els.dashboardZoomPercent) els.dashboardZoomPercent.value = String(Math.round(Number(dashboardItem.zoomFactor) * 100));
  if (els.dashboardScrollOffsetPx) els.dashboardScrollOffsetPx.value = String(Number(dashboardItem.scrollOffsetPx || 0));
  if (els.dashboardSettleMs) els.dashboardSettleMs.value = String(dashboardItem.settleMs);
  if (els.dashboardTimeoutMs) els.dashboardTimeoutMs.value = String(dashboardItem.timeoutMs);
  if (els.dashboardEnabled) els.dashboardEnabled.checked = dashboardItem.enabled !== false;

  if (els.dashboardForm) {
    scrollFormIntoView(els.dashboardForm);
    flashForm(els.dashboardEditorPanel);
  }

  setTimeout(() => {
    if (els.dashboardName) {
      els.dashboardName.focus();
      els.dashboardName.select();
    }
  }, 250);
}

function renumberScreenDashboards(screenIdValue) {
  const items = configModel.dashboards
    .filter((dashboardItem) => dashboardItem.screenId === screenIdValue)
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));

  items.forEach((item, index) => {
    item.sequence = index + 1;
  });
}

function moveDashboard(id, direction) {
  const current = configModel.dashboards.find((dashboardItem) => dashboardItem.id === id);

  if (!current) return;

  const list = configModel.dashboards
    .filter((dashboardItem) => dashboardItem.screenId === current.screenId)
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));

  const currentIndex = list.findIndex((dashboardItem) => dashboardItem.id === id);

  if (currentIndex < 0) return;

  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

  if (targetIndex < 0 || targetIndex >= list.length) return;

  const currentSeq = list[currentIndex].sequence;
  list[currentIndex].sequence = list[targetIndex].sequence;
  list[targetIndex].sequence = currentSeq;

  renumberScreenDashboards(current.screenId);
  selectedDashboardId = id;
  renderDashboards();

  showSuccess('Dashboard order updated. Click Save & Reload to persist.');
}

function getDashboardById(id) {
  return configModel.dashboards.find((dashboardItem) => dashboardItem.id === id);
}

function reorderDashboardByDrop(draggedId, targetId, placeAfterTarget) {
  if (!draggedId || !targetId || draggedId === targetId) return false;

  const dragged = getDashboardById(draggedId);
  const target = getDashboardById(targetId);

  if (!dragged || !target) return false;

  if (dragged.screenId !== target.screenId) {
    showFailure('Dashboards can only be reordered within the same screen.');
    return false;
  }

  const screenIdValue = dragged.screenId;

  const ordered = configModel.dashboards
    .filter((dashboardItem) => dashboardItem.screenId === screenIdValue)
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));

  const draggedIndex = ordered.findIndex((dashboardItem) => dashboardItem.id === draggedId);

  if (draggedIndex < 0) return false;

  const [draggedItem] = ordered.splice(draggedIndex, 1);

  let insertIndex = ordered.findIndex((dashboardItem) => dashboardItem.id === targetId);

  if (insertIndex < 0) return false;

  if (placeAfterTarget) {
    insertIndex += 1;
  }

  ordered.splice(insertIndex, 0, draggedItem);

  ordered.forEach((item, index) => {
    const real = configModel.dashboards.find((dashboardItem) => dashboardItem.id === item.id);

    if (real) {
      real.sequence = index + 1;
    }
  });

  selectedDashboardId = draggedId;

  renderAll();

  if (els.dashboardFilterScreen && screenExists(screenIdValue)) {
    els.dashboardFilterScreen.value = screenIdValue;
  }

  renderDashboards();

  showSuccess('Dashboard order updated. Click Save & Reload to persist.');
  return true;
}

async function previewDashboard(dashboard) {
  try {
    const result = await window.wallboardApi.previewDashboard(dashboard);

    if (!result.ok) {
      showFailure(`Preview failed: ${result.error}`);
      return;
    }

    renderPreviewDiagnostics(result);
    if (appState && Array.isArray(appState.dashboardHealth) && result.previewDiagnostics && result.previewDiagnostics.dashboardId) {
      const existing = appState.dashboardHealth.find((item) => item.dashboardId === result.previewDiagnostics.dashboardId);
      const event = {
        status: 'ok',
        at: result.previewDiagnostics.loadedAt,
        dashboardId: result.previewDiagnostics.dashboardId,
        dashboardName: result.previewDiagnostics.dashboardName,
        reason: 'preview',
        loadMs: null,
        offsetRequested: result.previewDiagnostics.scrollOffsetPx,
        offsetApplied: result.previewDiagnostics.scrollResult ? result.previewDiagnostics.scrollResult.appliedOffset : null,
        offsetTarget: result.previewDiagnostics.scrollResult ? result.previewDiagnostics.scrollResult.target : '',
        pageHeight: result.previewDiagnostics.pageMetrics ? result.previewDiagnostics.pageMetrics.pageHeight : null,
        viewportHeight: result.previewDiagnostics.pageMetrics ? result.previewDiagnostics.pageMetrics.viewportHeight : null
      };
      if (existing) {
        existing.lastStatus = 'ok';
        existing.lastCheckedAt = event.at;
        existing.history = [event, ...(existing.history || [])].slice(0, 10);
      } else {
        appState.dashboardHealth.push({ dashboardId: event.dashboardId, lastStatus: 'ok', lastCheckedAt: event.at, history: [event] });
      }
      renderDashboards();
    }
    showSuccess('Preview opened and diagnostics updated.');
  } catch (err) {
    showFailure(`Preview failed: ${err.message}`);
  }
}

async function saveAll() {
  try {
    bindSettingsBackToModel();

    const result = await window.wallboardApi.saveConfig(configModel);

    if (!result.ok) {
      showFailure(`Save failed: ${result.error}`);
      return;
    }

    configModel = deepClone(await window.wallboardApi.getConfig());
    appState = await window.wallboardApi.getState();

    renderAll();

    if (selectedDashboardId && configModel.dashboards.some((dashboardItem) => dashboardItem.id === selectedDashboardId)) {
      populateDashboardForm(selectedDashboardId);
    }

    if (selectedScreenId && configModel.screens.some((screenItem) => screenItem.id === selectedScreenId)) {
      populateScreenForm(selectedScreenId);
    }

    showSuccess('Configuration saved and screens reloaded.');
  } catch (err) {
    showFailure(`Save failed: ${err.message}`);
  }
}

function bindScreenFormEvents() {
  if (!els.screenForm) return;

  els.screenForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const model = {
      id: els.screenId.value || uid('screen'),
      name: els.screenName.value.trim(),
      displayIndex: Number(els.screenDisplayIndex.value),
      enabled: !!els.screenEnabled.checked
    };

    const existingIndex = configModel.screens.findIndex((screenItem) => screenItem.id === model.id);

    if (existingIndex >= 0) {
      configModel.screens[existingIndex] = model;
    } else {
      configModel.screens.push(model);
    }

    selectedScreenId = model.id;

    renderAll();
    populateScreenForm(model.id);
    showSuccess(`Screen saved: ${model.name}`);
  });
}

function bindDashboardFormEvents() {
  if (!els.dashboardForm) return;

  els.dashboardForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const model = buildDashboardFromForm();
    const existingIndex = configModel.dashboards.findIndex((dashboardItem) => dashboardItem.id === model.id);

    if (existingIndex >= 0) {
      configModel.dashboards[existingIndex] = model;
    } else {
      configModel.dashboards.push(model);
    }

    renumberScreenDashboards(model.screenId);

    selectedDashboardId = model.id;

    renderAll();

    if (els.dashboardFilterScreen) {
      els.dashboardFilterScreen.value = model.screenId;
    }

    renderDashboards();
    populateDashboardForm(model.id);
    showSuccess(`Dashboard saved: ${model.name}`);
  });
}

function bindListDelegates() {
  if (els.screensList) {
    els.screensList.addEventListener('click', (e) => {
      const button = e.target.closest('button');

      if (!button) return;

      const editId = button.getAttribute('data-screen-edit');
      const deleteId = button.getAttribute('data-screen-delete');

      if (editId) {
        populateScreenForm(editId);
        return;
      }

      if (deleteId) {
        const inUse = configModel.dashboards.some((dashboardItem) => dashboardItem.screenId === deleteId);

        if (inUse) {
          showFailure('Cannot delete this screen because dashboards are still assigned to it.');
          return;
        }

        if (window.confirm('Delete this screen?')) {
          configModel.screens = configModel.screens.filter((screenItem) => screenItem.id !== deleteId);

          if (selectedScreenId === deleteId) {
            selectedScreenId = null;
          }

          renderAll();
          resetScreenForm();
          showSuccess('Screen deleted.');
        }
      }
    });
  }

  if (els.dashboardsList) {
    els.dashboardsList.addEventListener('click', (e) => {
      const button = e.target.closest('button');

      if (!button) return;

      const editId = button.getAttribute('data-dashboard-edit');
      const previewId = button.getAttribute('data-dashboard-preview');
      const deleteId = button.getAttribute('data-dashboard-delete');
      const upId = button.getAttribute('data-dashboard-up');
      const downId = button.getAttribute('data-dashboard-down');

      if (editId) {
        populateDashboardForm(editId);
        return;
      }

      if (previewId) {
        const dashboardItem = configModel.dashboards.find((dashboard) => dashboard.id === previewId);
        if (dashboardItem) previewDashboard(dashboardItem);
        return;
      }

      if (deleteId) {
        if (window.confirm('Delete this dashboard?')) {
          const existing = configModel.dashboards.find((dashboardItem) => dashboardItem.id === deleteId);

          configModel.dashboards = configModel.dashboards.filter((dashboardItem) => dashboardItem.id !== deleteId);

          if (existing) {
            renumberScreenDashboards(existing.screenId);
          }

          if (selectedDashboardId === deleteId) {
            selectedDashboardId = null;
          }

          renderAll();
          resetDashboardForm();
          showSuccess('Dashboard deleted.');
        }

        return;
      }

      if (upId) {
        moveDashboard(upId, 'up');
        return;
      }

      if (downId) {
        moveDashboard(downId, 'down');
      }
    });
  }
}

function bindDashboardDragAndDrop() {
  if (!els.dashboardsList) return;

  els.dashboardsList.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-dashboard-card]');

    if (!card) return;

    if (e.target.closest('button, input, select, textarea, a')) {
      e.preventDefault();
      return;
    }

    draggedDashboardId = card.getAttribute('data-dashboard-card');
    card.classList.add('dragging');

    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedDashboardId);
    }
  });

  els.dashboardsList.addEventListener('dragover', (e) => {
    const card = e.target.closest('[data-dashboard-card]');

    if (!card || !draggedDashboardId) return;

    const dragged = getDashboardById(draggedDashboardId);
    const targetId = card.getAttribute('data-dashboard-card');
    const target = getDashboardById(targetId);

    if (!dragged || !target || dragged.screenId !== target.screenId) {
      return;
    }

    e.preventDefault();

    const cards = els.dashboardsList.querySelectorAll('[data-dashboard-card]');
    cards.forEach((item) => item.classList.remove('drag-over'));

    card.classList.add('drag-over');

    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  });

  els.dashboardsList.addEventListener('dragleave', (e) => {
    const card = e.target.closest('[data-dashboard-card]');

    if (!card) return;

    card.classList.remove('drag-over');
  });

  els.dashboardsList.addEventListener('drop', (e) => {
    const card = e.target.closest('[data-dashboard-card]');

    if (!card || !draggedDashboardId) return;

    e.preventDefault();

    const targetId = card.getAttribute('data-dashboard-card');
    const rect = card.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const placeAfterTarget = e.clientY > midpoint;

    reorderDashboardByDrop(draggedDashboardId, targetId, placeAfterTarget);

    draggedDashboardId = null;

    const cards = els.dashboardsList.querySelectorAll('[data-dashboard-card]');
    cards.forEach((item) => {
      item.classList.remove('dragging');
      item.classList.remove('drag-over');
    });
  });

  els.dashboardsList.addEventListener('dragend', () => {
    draggedDashboardId = null;

    const cards = els.dashboardsList.querySelectorAll('[data-dashboard-card]');
    cards.forEach((item) => {
      item.classList.remove('dragging');
      item.classList.remove('drag-over');
    });
  });
}

function bindTopLevelEvents() {
  if (els.btnResetScreen) {
    els.btnResetScreen.addEventListener('click', () => {
      selectedScreenId = null;
      resetScreenForm();
      renderScreens();
    });
  }

  if (els.btnResetDashboard) {
    els.btnResetDashboard.addEventListener('click', () => {
      selectedDashboardId = null;
      resetDashboardForm();
      renderDashboards();
    });
  }

  if (els.btnAddScreen) {
    els.btnAddScreen.addEventListener('click', () => {
      selectedScreenId = null;
      setView('screens');
      resetScreenForm();
      renderScreens();
      els.screenName?.focus();
    });
  }

  if (els.btnAddDashboard) {
    els.btnAddDashboard.addEventListener('click', () => {
      selectedDashboardId = null;
      setView('dashboards');
      resetDashboardForm();
      renderDashboards();
      els.dashboardName?.focus();
    });
  }

  if (els.btnPreviewDashboard) {
    els.btnPreviewDashboard.addEventListener('click', async () => {
      const dashboard = buildDashboardFromForm();

      if (!dashboard.url) {
        showFailure('Preview requires a valid dashboard URL.');
        return;
      }

      await previewDashboard(dashboard);
    });
  }

  if (els.dashboardFilterScreen) {
    els.dashboardFilterScreen.addEventListener('change', renderDashboards);
  }

  if (els.btnSaveAll) {
    els.btnSaveAll.addEventListener('click', saveAll);
  }


  if (els.btnIdentifyFromMap) {
    els.btnIdentifyFromMap.addEventListener('click', async () => {
      try {
        await window.wallboardApi.identifyDisplays();
        showSuccess('Identify displays triggered.');
      } catch (err) {
        showFailure(`Identify Displays failed: ${err.message}`);
      }
    });
  }

  if (els.screenDisplayMap) {
    els.screenDisplayMap.addEventListener('click', (event) => {
      const card = event.target.closest('[data-display-index]');
      if (!card) return;
      selectDisplay(card.getAttribute('data-display-index'));
    });
  }

  if (els.overviewDisplays) {
    els.overviewDisplays.addEventListener('click', (event) => {
      const card = event.target.closest('[data-display-index]');
      if (!card) return;
      selectDisplay(card.getAttribute('data-display-index'));
    });
  }

  if (els.btnIdentify) {
    els.btnIdentify.addEventListener('click', async () => {
      try {
        await window.wallboardApi.identifyDisplays();
        showSuccess('Identify displays triggered.');
      } catch (err) {
        showFailure(`Identify Displays failed: ${err.message}`);
      }
    });
  }

  if (els.btnReload) {
    els.btnReload.addEventListener('click', async () => {
      try {
        await window.wallboardApi.reloadScreens();
        showSuccess('Screens reloaded.');
      } catch (err) {
        showFailure(`Reload Screens failed: ${err.message}`);
      }
    });
  }

  if (els.btnPauseResume) {
    els.btnPauseResume.addEventListener('click', async () => {
      try {
        await window.wallboardApi.toggleRotation();
      } catch (err) {
        showFailure(`Pause/Resume failed: ${err.message}`);
      }
    });
  }

  if (els.btnOpenLogs) {
    els.btnOpenLogs.addEventListener('click', async () => {
      try {
        await window.wallboardApi.openLogFolder();
      } catch (err) {
        showFailure(`Open Logs failed: ${err.message}`);
      }
    });
  }

  if (els.btnCreateBackup) {
    els.btnCreateBackup.addEventListener('click', async () => {
      try {
        const result = await window.wallboardApi.createConfigBackup();

        if (!result.ok) {
          showFailure(`Backup failed: ${result.error}`);
          return;
        }

        showSuccess('Config backup created.');
      } catch (err) {
        showFailure(`Backup failed: ${err.message}`);
      }
    });
  }

  if (els.btnExportConfig) {
    els.btnExportConfig.addEventListener('click', async () => {
      try {
        const result = await window.wallboardApi.exportConfig();

        if (result.cancelled) return;

        if (!result.ok) {
          showFailure(`Export failed: ${result.error}`);
          return;
        }

        showSuccess('Config exported successfully.');
      } catch (err) {
        showFailure(`Export failed: ${err.message}`);
      }
    });
  }

  if (els.btnImportConfig) {
    els.btnImportConfig.addEventListener('click', async () => {
      try {
        const confirmImport = window.confirm(
          'Importing a config will replace the current BoardRunner configuration. A backup will be created first. Continue?'
        );

        if (!confirmImport) return;

        const result = await window.wallboardApi.importConfig();

        if (result.cancelled) return;

        if (!result.ok) {
          showFailure(`Import failed: ${result.error}`);
          return;
        }

        selectedScreenId = null;
        selectedDashboardId = null;

        configModel = deepClone(await window.wallboardApi.getConfig());
        appState = await window.wallboardApi.getState();

        renderAll();
        resetScreenForm();
        resetDashboardForm();

        showSuccess('Config imported and screens reloaded.');
      } catch (err) {
        showFailure(`Import failed: ${err.message}`);
      }
    });
  }

  if (els.btnOpenConfigFolder) {
    els.btnOpenConfigFolder.addEventListener('click', async () => {
      try {
        const result = await window.wallboardApi.openConfigFolder();

        if (!result.ok) {
          showFailure(`Open config folder failed: ${result.error}`);
          return;
        }

        showSuccess('Config folder opened.');
      } catch (err) {
        showFailure(`Open config folder failed: ${err.message}`);
      }
    });
  }

  els.navButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setView(button.dataset.view);
    });
  });
}

function bindAppStateSubscription() {
  if (!window.wallboardApi || typeof window.wallboardApi.onAppState !== 'function') return;

  window.wallboardApi.onAppState((state) => {
    appState = state;
    bindStatusStrip();
    renderOverview();
    renderScreens();
    renderDashboards();
    renderRuntime();
  });
}

function bindEvents() {
  if (eventsBound) return;

  eventsBound = true;

  bindScreenFormEvents();
  bindDashboardFormEvents();
  bindListDelegates();
  bindDashboardDragAndDrop();
  bindTopLevelEvents();
  bindAppStateSubscription();
}

async function init() {
  try {
    if (!window.wallboardApi) {
      throw new Error('window.wallboardApi is not available. Check preload.js and BrowserWindow preload configuration.');
    }

    if (typeof window.wallboardApi.getConfig !== 'function') {
      throw new Error('window.wallboardApi.getConfig is missing. Check preload.js.');
    }

    clearError();

    configModel = deepClone(await window.wallboardApi.getConfig());
    appState = await window.wallboardApi.getState();

    normaliseConfig();
    bindEvents();
    renderAll();
    resetScreenForm();
    resetDashboardForm();
    setView('overview');
  } catch (err) {
    showFailure(`Admin UI initialisation failed: ${err.message}`);
  }
}

window.addEventListener('DOMContentLoaded', init);