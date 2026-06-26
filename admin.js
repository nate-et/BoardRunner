let appState = null;
let configModel = null;
let eventsBound = false;

const els = {
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
  btnReload: document.getElementById('btnReload'),
  btnPauseResume: document.getElementById('btnPauseResume'),
  btnOpenLogs: document.getElementById('btnOpenLogs'),

  ovConfiguredScreens: document.getElementById('ovConfiguredScreens'),
  ovConfiguredDashboards: document.getElementById('ovConfiguredDashboards'),
  ovDetectedDisplays: document.getElementById('ovDetectedDisplays'),
  ovRuntimeScreens: document.getElementById('ovRuntimeScreens'),
  overviewRuntimeCards: document.getElementById('overviewRuntimeCards'),
  overviewDisplays: document.getElementById('overviewDisplays'),

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
  const match = configModel.screens.find((s) => s.id === screenIdValue);
  return match ? match.name : '(unassigned)';
}

function screenExists(screenIdValue) {
  return configModel.screens.some((s) => s.id === screenIdValue);
}

function formatSecondsFromMs(ms) {
  return `${Math.round(Number(ms || 0) / 1000)} sec`;
}

function formatPercentFromZoom(zoomFactor) {
  return `${Math.round(Number(zoomFactor || 1) * 100)}%`;
}

function setView(viewName) {
  els.navButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
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

  if (els.overviewDisplays) {
    if (displays.length === 0) {
      els.overviewDisplays.innerHTML = `
        <div class="display-card">
          <h4>No displays detected</h4>
        </div>
      `;
    } else {
      els.overviewDisplays.innerHTML = displays.map((d) => `
        <div class="display-card">
          <h4>${escapeHtml(d.label)}${d.primary ? ' (Primary)' : ''}</h4>
          <p>${escapeHtml(d.size)}</p>
          <p class="muted">X ${d.bounds.x}, Y ${d.bounds.y}, W ${d.bounds.width}, H ${d.bounds.height}</p>
        </div>
      `).join('');
    }
  }
}

function repopulateSelectors() {
  const displays = getDetectedDisplays();

  if (els.screenDisplayIndex) {
    els.screenDisplayIndex.innerHTML = displays.map((d) => {
      return `<option value="${d.index}">${escapeHtml(d.label)}${d.primary ? ' (Primary)' : ''} — ${escapeHtml(d.size)}</option>`;
    }).join('');
  }

  const screenOptions = configModel.screens.map((s) => {
    return `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`;
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

  els.screensList.innerHTML = sorted.map((scr) => `
    <div class="list-card">
      <h4>${escapeHtml(scr.name)}</h4>
      <div class="meta-row">
        <span class="badge">Display ${Number(scr.displayIndex) + 1}</span>
        <span class="badge ${scr.enabled !== false ? 'enabled' : 'disabled'}">${scr.enabled !== false ? 'Enabled' : 'Disabled'}</span>
      </div>
      <p class="muted">ID: ${escapeHtml(scr.id)}</p>
      <div class="item-actions">
        <button type="button" data-screen-edit="${escapeHtml(scr.id)}">Edit</button>
        <button type="button" data-screen-delete="${escapeHtml(scr.id)}">Delete</button>
      </div>
    </div>
  `).join('');
}

function getFilteredDashboards() {
  const filterScreenId = els.dashboardFilterScreen ? els.dashboardFilterScreen.value : '';
  let dashboards = deepClone(configModel.dashboards);

  dashboards = dashboards.filter((d) => screenExists(d.screenId));

  if (filterScreenId) {
    dashboards = dashboards.filter((d) => d.screenId === filterScreenId);
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

  els.dashboardsList.innerHTML = list.map((db) => `
    <div class="list-card">
      <h4>${escapeHtml(db.name)}</h4>
      <div class="meta-row">
        <span class="badge">${escapeHtml(getScreenName(db.screenId))}</span>
        <span class="badge">Seq ${Number(db.sequence)}</span>
        <span class="badge">${formatSecondsFromMs(db.durationMs)}</span>
        <span class="badge">${formatPercentFromZoom(db.zoomFactor)}</span>
        <span class="badge">Offset ${Number(db.scrollOffsetPx || 0)}px</span>
        <span class="badge ${db.enabled !== false ? 'enabled' : 'disabled'}">${db.enabled !== false ? 'Enabled' : 'Disabled'}</span>
      </div>
      <p class="url-line">${escapeHtml(db.url)}</p>
      <div class="item-actions">
        <button type="button" data-dashboard-edit="${escapeHtml(db.id)}">Edit</button>
        <button type="button" data-dashboard-preview="${escapeHtml(db.id)}">Preview</button>
        <button type="button" data-dashboard-delete="${escapeHtml(db.id)}">Delete</button>
        <button type="button" data-dashboard-up="${escapeHtml(db.id)}">↑</button>
        <button type="button" data-dashboard-down="${escapeHtml(db.id)}">↓</button>
      </div>
    </div>
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
    <div class="runtime-card">
      <h4>${escapeHtml(item.screenName || item.screenId)}</h4>
      <div class="meta-row">
        <span class="badge">Display ${Number(item.displayIndex) + 1}</span>
        <span class="badge">${Number(item.currentIndex) + 1} / ${item.totalItems}</span>
      </div>
      <p><strong>Current Dashboard:</strong> ${escapeHtml(item.currentDashboard || 'N/A')}</p>
      <p class="url-line">${escapeHtml(item.currentUrl || '')}</p>
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
  const screen = configModel.screens.find((s) => s.id === id);
  if (!screen) return;

  setView('screens');

  if (els.screenFormTitle) els.screenFormTitle.textContent = 'Edit Screen';
  if (els.screenFormSubtitle) els.screenFormSubtitle.textContent = `Editing: ${screen.name}`;
  if (els.screenId) els.screenId.value = screen.id;
  if (els.screenName) els.screenName.value = screen.name;
  if (els.screenDisplayIndex) els.screenDisplayIndex.value = String(screen.displayIndex ?? 0);
  if (els.screenEnabled) els.screenEnabled.checked = screen.enabled !== false;

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
  const db = configModel.dashboards.find((d) => d.id === id);
  if (!db) return;

  setView('dashboards');

  if (els.dashboardFormTitle) els.dashboardFormTitle.textContent = 'Edit Dashboard';
  if (els.dashboardFormSubtitle) els.dashboardFormSubtitle.textContent = `Editing: ${db.name}`;
  if (els.dashboardId) els.dashboardId.value = db.id;
  if (els.dashboardName) els.dashboardName.value = db.name;
  if (els.dashboardUrl) els.dashboardUrl.value = db.url;
  if (els.dashboardScreenId) els.dashboardScreenId.value = db.screenId;
  if (els.dashboardSequence) els.dashboardSequence.value = String(db.sequence);
  if (els.dashboardDurationSec) els.dashboardDurationSec.value = String(Math.round(Number(db.durationMs) / 1000));
  if (els.dashboardZoomPercent) els.dashboardZoomPercent.value = String(Math.round(Number(db.zoomFactor) * 100));
  if (els.dashboardScrollOffsetPx) els.dashboardScrollOffsetPx.value = String(Number(db.scrollOffsetPx || 0));
  if (els.dashboardSettleMs) els.dashboardSettleMs.value = String(db.settleMs);
  if (els.dashboardTimeoutMs) els.dashboardTimeoutMs.value = String(db.timeoutMs);
  if (els.dashboardEnabled) els.dashboardEnabled.checked = db.enabled !== false;

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
    .filter((d) => d.screenId === screenIdValue)
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));

  items.forEach((item, index) => {
    item.sequence = index + 1;
  });
}

function moveDashboard(id, direction) {
  const current = configModel.dashboards.find((d) => d.id === id);
  if (!current) return;

  const list = configModel.dashboards
    .filter((d) => d.screenId === current.screenId)
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));

  const currentIndex = list.findIndex((d) => d.id === id);
  if (currentIndex < 0) return;

  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= list.length) return;

  const currentSeq = list[currentIndex].sequence;
  list[currentIndex].sequence = list[targetIndex].sequence;
  list[targetIndex].sequence = currentSeq;

  renumberScreenDashboards(current.screenId);
  renderDashboards();
}

async function previewDashboard(dashboard) {
  try {
    const result = await window.wallboardApi.previewDashboard(dashboard);

    if (!result.ok) {
      showError(`Preview failed: ${result.error}`);
      return;
    }

    clearError();
  } catch (err) {
    showError(`Preview failed: ${err.message}`);
  }
}

async function saveAll() {
  try {
    bindSettingsBackToModel();
    const result = await window.wallboardApi.saveConfig(configModel);

    if (!result.ok) {
      showError(`Save failed: ${result.error}`);
      return;
    }

    clearError();
    configModel = deepClone(await window.wallboardApi.getConfig());
    appState = await window.wallboardApi.getState();
    renderAll();
  } catch (err) {
    showError(`Save failed: ${err.message}`);
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

    const existingIndex = configModel.screens.findIndex((s) => s.id === model.id);

    if (existingIndex >= 0) {
      configModel.screens[existingIndex] = model;
    } else {
      configModel.screens.push(model);
    }

    renderAll();
    resetScreenForm();
    clearError();
  });
}

function bindDashboardFormEvents() {
  if (!els.dashboardForm) return;

  els.dashboardForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const model = buildDashboardFromForm();
    const existingIndex = configModel.dashboards.findIndex((d) => d.id === model.id);

    if (existingIndex >= 0) {
      configModel.dashboards[existingIndex] = model;
    } else {
      configModel.dashboards.push(model);
    }

    renumberScreenDashboards(model.screenId);
    renderAll();

    if (els.dashboardFilterScreen) {
      els.dashboardFilterScreen.value = model.screenId;
    }

    renderDashboards();
    resetDashboardForm();
    clearError();
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
        const inUse = configModel.dashboards.some((d) => d.screenId === deleteId);

        if (inUse) {
          showError('Cannot delete this screen because dashboards are still assigned to it.');
          return;
        }

        if (window.confirm('Delete this screen?')) {
          configModel.screens = configModel.screens.filter((s) => s.id !== deleteId);
          renderAll();
          resetScreenForm();
          clearError();
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
        const db = configModel.dashboards.find((d) => d.id === previewId);
        if (db) {
          previewDashboard(db);
        }
        return;
      }

      if (deleteId) {
        if (window.confirm('Delete this dashboard?')) {
          const existing = configModel.dashboards.find((d) => d.id === deleteId);

          configModel.dashboards = configModel.dashboards.filter((d) => d.id !== deleteId);

          if (existing) {
            renumberScreenDashboards(existing.screenId);
          }

          renderAll();
          resetDashboardForm();
          clearError();
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

function bindTopLevelEvents() {
  if (els.btnResetScreen) {
    els.btnResetScreen.addEventListener('click', resetScreenForm);
  }

  if (els.btnResetDashboard) {
    els.btnResetDashboard.addEventListener('click', resetDashboardForm);
  }

  if (els.btnAddScreen) {
    els.btnAddScreen.addEventListener('click', () => {
      setView('screens');
      resetScreenForm();
      els.screenName?.focus();
    });
  }

  if (els.btnAddDashboard) {
    els.btnAddDashboard.addEventListener('click', () => {
      setView('dashboards');
      resetDashboardForm();
      els.dashboardName?.focus();
    });
  }

  if (els.btnPreviewDashboard) {
    els.btnPreviewDashboard.addEventListener('click', async () => {
      const dashboard = buildDashboardFromForm();

      if (!dashboard.url) {
        showError('Preview requires a valid dashboard URL.');
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

  if (els.btnIdentify) {
    els.btnIdentify.addEventListener('click', async () => {
      try {
        await window.wallboardApi.identifyDisplays();
      } catch (err) {
        showError(`Identify Displays failed: ${err.message}`);
      }
    });
  }

  if (els.btnReload) {
    els.btnReload.addEventListener('click', async () => {
      try {
        await window.wallboardApi.reloadScreens();
      } catch (err) {
        showError(`Reload Screens failed: ${err.message}`);
      }
    });
  }

  if (els.btnPauseResume) {
    els.btnPauseResume.addEventListener('click', async () => {
      try {
        await window.wallboardApi.toggleRotation();
      } catch (err) {
        showError(`Pause/Resume failed: ${err.message}`);
      }
    });
  }

  if (els.btnOpenLogs) {
    els.btnOpenLogs.addEventListener('click', async () => {
      try {
        await window.wallboardApi.openLogFolder();
      } catch (err) {
        showError(`Open Logs failed: ${err.message}`);
      }
    });
  }

  els.navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      setView(btn.dataset.view);
    });
  });
}

function bindAppStateSubscription() {
  if (!window.wallboardApi || typeof window.wallboardApi.onAppState !== 'function') return;

  window.wallboardApi.onAppState((state) => {
    appState = state;
    bindStatusStrip();
    renderOverview();
    renderRuntime();
  });
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;

  bindScreenFormEvents();
  bindDashboardFormEvents();
  bindListDelegates();
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
    showError(`Admin UI initialisation failed: ${err.message}`);
  }
}

window.addEventListener('DOMContentLoaded', init);
