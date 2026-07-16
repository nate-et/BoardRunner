const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  nativeImage,
  screen,
  shell,
  powerMonitor
} = require('electron');

const path = require('path');
const fs = require('fs');

const APP_NAME = 'BoardRunner';
app.setName(APP_NAME);

const USER_DATA = app.getPath('userData');
const USER_CONFIG_PATH = path.join(USER_DATA, 'config.json');
const BUNDLED_CONFIG_PATH = path.join(__dirname, 'config.json');
const BACKUP_DIR = path.join(USER_DATA, 'backups');
const LOG_DIR = path.join(USER_DATA, 'logs');
const APP_STATE_PATH = path.join(USER_DATA, 'app-state.json');
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray.png');

let tray = null;
let adminWindow = null;
let previewWindow = null;
let configCache = null;
let rotationPaused = false;
let displayWindows = new Map();
let runtimeState = new Map();
let diagnosticsState = new Map();
let dashboardHealth = new Map();
let identifyWindows = [];
let watchdogInterval = null;
let displayChangeDebounce = null;
let recoveryHooksRegistered = false;
let appReadyAtMs = 0;
let screenGeneration = 0;
let quitting = false;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function logPath() {
  ensureDir(LOG_DIR);
  return path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
}

function writeLog(scope, message) {
  const line = `[${new Date().toISOString()}] [${scope}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(logPath(), line + '\n', 'utf8'); } catch (_) {}
}

function defaultConfig() {
  return {
    configVersion: 2,
    settings: {
      kioskMode: true,
      trayOnlyStartup: true,
      hideAdminToTray: true,
      startWithWindows: false,
      identifyOverlaySeconds: 4,
      watchdogReloadMinutes: 15,
      maxConsecutiveFailures: 3,
      dashboardCooldownMinutes: 10,
      restartOnResume: true,
      restartOnDisplayChange: true,
      scrollOffsetMaxWaitSeconds: 20,
      scrollOffsetRetryIntervalMs: 1000,
      scrollOffsetStabiliseChecks: true,
      fadeTransitions: true
    },
    screens: [
      { id: 'screen-1', name: 'Operations', displayIndex: 0, enabled: true },
      { id: 'screen-2', name: 'Performance', displayIndex: 1, enabled: true }
    ],
    dashboards: []
  };
}

function migrateConfig(config) {
  const d = defaultConfig();
  const c = config && typeof config === 'object' ? config : {};
  const migrated = {
    configVersion: 2,
    settings: { ...d.settings, ...(c.settings || {}) },
    screens: Array.isArray(c.screens) ? c.screens : d.screens,
    dashboards: Array.isArray(c.dashboards) ? c.dashboards : d.dashboards
  };
  migrated.dashboards.forEach((db) => {
    if (db.scrollOffsetPx === undefined) db.scrollOffsetPx = 0;
    if (db.settleMs === undefined) db.settleMs = 3000;
    if (db.timeoutMs === undefined) db.timeoutMs = 20000;
    if (db.zoomFactor === undefined) db.zoomFactor = 1;
    if (db.durationMs === undefined) db.durationMs = 30000;
    if (db.sequence === undefined) db.sequence = 1;
    if (db.enabled === undefined) db.enabled = true;
  });
  return migrated;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Config must be an object');
  if (!Array.isArray(config.screens)) throw new Error('Config must contain screens array');
  if (!Array.isArray(config.dashboards)) throw new Error('Config must contain dashboards array');
  const screenIds = new Set();
  for (const [index, scr] of config.screens.entries()) {
    if (!scr.id) throw new Error(`Screen ${index + 1} is missing id`);
    if (!scr.name) throw new Error(`Screen ${index + 1} is missing name`);
    if (screenIds.has(scr.id)) throw new Error(`Duplicate screen id: ${scr.id}`);
    screenIds.add(scr.id);
  }
  for (const [index, db] of config.dashboards.entries()) {
    if (!db.id) throw new Error(`Dashboard ${index + 1} is missing id`);
    if (!db.name) throw new Error(`Dashboard ${index + 1} is missing name`);
    if (!db.url) throw new Error(`Dashboard ${db.name || index + 1} is missing URL`);
    try { new URL(db.url); } catch { throw new Error(`Dashboard ${db.name} has an invalid URL`); }
    if (!screenIds.has(db.screenId)) throw new Error(`Dashboard ${db.name} references an invalid screen`);
    if (Number(db.durationMs || 0) <= 0) throw new Error(`Dashboard ${db.name} has invalid duration`);
    if (Number(db.zoomFactor || 0) <= 0) throw new Error(`Dashboard ${db.name} has invalid zoom`);
    if (Number(db.scrollOffsetPx || 0) < 0) throw new Error(`Dashboard ${db.name} has invalid offset`);
  }
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readConfigFile() {
  ensureDir(USER_DATA);
  const userConfig = readJsonIfExists(USER_CONFIG_PATH);
  if (userConfig) return userConfig;
  const bundled = readJsonIfExists(BUNDLED_CONFIG_PATH) || defaultConfig();
  const migrated = migrateConfig(bundled);
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(migrated, null, 2), 'utf8');
  return migrated;
}

function writeConfigFile(config) {
  ensureDir(USER_DATA);
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function getTimestampForFileName() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function pruneOldBackups(maxBackups = 25) {
  try {
    ensureDir(BACKUP_DIR);
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => ({ file, full: path.join(BACKUP_DIR, file), mtime: fs.statSync(path.join(BACKUP_DIR, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    files.slice(maxBackups).forEach((file) => fs.unlinkSync(file.full));
  } catch (err) {
    writeLog('backup', `Failed pruning backups: ${err.message}`);
  }
}

function createConfigBackup(reason = 'manual') {
  ensureDir(BACKUP_DIR);
  const backupPath = path.join(BACKUP_DIR, `BoardRunner-config-${reason}-${getTimestampForFileName()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(configCache || readConfigFile(), null, 2), 'utf8');
  pruneOldBackups();
  writeLog('backup', `Config backup created: ${backupPath}`);
  return backupPath;
}

function createBackupIfVersionChanged() {
  let state = {};
  try { state = readJsonIfExists(APP_STATE_PATH) || {}; } catch (_) {}
  const version = app.getVersion();
  if (state.lastVersion && state.lastVersion !== version) {
    try { createConfigBackup(`pre-upgrade-${state.lastVersion}-to-${version}`); } catch (_) {}
  }
  try { fs.writeFileSync(APP_STATE_PATH, JSON.stringify({ ...state, lastVersion: version, lastStartedAt: new Date().toISOString() }, null, 2), 'utf8'); } catch (_) {}
}

function getSetting(name, fallback) {
  return configCache && configCache.settings ? configCache.settings[name] ?? fallback : fallback;
}

function loadConfig() {
  const config = migrateConfig(readConfigFile());
  validateConfig(config);
  configCache = config;
  rotationPaused = false;
  applyStartupSetting();
  return config;
}

function saveConfig(config) {
  const migrated = migrateConfig(config);
  validateConfig(migrated);
  if (configCache || fs.existsSync(USER_CONFIG_PATH)) createConfigBackup('pre-save');
  writeConfigFile(migrated);
  configCache = migrated;
  applyStartupSetting();
  setupWatchdog();
  writeLog('config', `Config saved to ${USER_CONFIG_PATH}`);
}

function getStartupOptions(enabled) {
  if (process.platform !== 'win32') return { openAtLogin: false };
  if (process.defaultApp) return { openAtLogin: enabled, path: process.execPath, args: [path.resolve(process.argv[1])] };
  return { openAtLogin: enabled, path: process.execPath, args: [] };
}

function applyStartupSetting() {
  if (process.platform !== 'win32') return;
  try {
    const enabled = !!getSetting('startWithWindows', false);
    app.setLoginItemSettings(getStartupOptions(enabled));
    writeLog('startup', `Start with Windows = ${enabled}`);
  } catch (err) {
    writeLog('startup', `Failed to apply startup setting: ${err.message}`);
  }
}

function getStartupStatus() {
  try { return process.platform === 'win32' ? app.getLoginItemSettings(getStartupOptions(true)).openAtLogin : false; }
  catch { return !!getSetting('startWithWindows', false); }
}

function getDetectedDisplays() {
  return screen.getAllDisplays().map((display, index) => ({
    index,
    id: display.id,
    label: `Display ${index + 1}`,
    primary: display.id === screen.getPrimaryDisplay().id,
    bounds: display.bounds,
    size: `${display.size.width}x${display.size.height}`
  }));
}

function getDisplayForIndex(displayIndex) {
  const displays = screen.getAllDisplays();
  return displays[Number(displayIndex)] || screen.getPrimaryDisplay();
}

function createTray() {
  const icon = fs.existsSync(TRAY_ICON_PATH) ? nativeImage.createFromPath(TRAY_ICON_PATH) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.on('double-click', showAdminWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { type: 'separator' },
    { label: 'Open Admin', click: showAdminWindow },
    { label: rotationPaused ? 'Resume Rotation' : 'Pause Rotation', click: toggleRotationInternal },
    { label: 'Reload Screens', click: reloadCurrentScreens },
    { label: 'Identify Displays', click: identifyDisplays },
    { type: 'separator' },
    { label: 'Open Config Folder', click: () => { ensureDir(USER_DATA); shell.openPath(USER_DATA); } },
    { label: 'Open Logs Folder', click: () => { ensureDir(LOG_DIR); shell.openPath(LOG_DIR); } },
    { label: 'Exit', click: () => { quitting = true; app.quit(); } }
  ]));
}

function createAdminWindow() {
  if (adminWindow && !adminWindow.isDestroyed()) return adminWindow;
  adminWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1160,
    minHeight: 780,
    title: `${APP_NAME} Admin`,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  adminWindow.loadFile(path.join(__dirname, 'admin.html'));
  adminWindow.on('close', (event) => {
    if (!quitting && getSetting('hideAdminToTray', true)) {
      event.preventDefault();
      adminWindow.hide();
    }
  });
  adminWindow.on('closed', () => { adminWindow = null; });
  return adminWindow;
}

function showAdminWindow() {
  const win = createAdminWindow();
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function createPreviewWindow() {
  if (previewWindow && !previewWindow.isDestroyed()) return previewWindow;
  previewWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: `${APP_NAME} Preview`,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  previewWindow.once('ready-to-show', () => { if (!previewWindow.isDestroyed()) previewWindow.show(); });
  previewWindow.on('closed', () => { previewWindow = null; });
  previewWindow.webContents.setAudioMuted(true);
  previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return previewWindow;
}

function notifyAdminState() {
  if (adminWindow && !adminWindow.isDestroyed()) adminWindow.webContents.send('app-state', getAdminState());
}

function updateDiagnostics(screenId, patch) {
  const old = diagnosticsState.get(screenId) || {};
  diagnosticsState.set(screenId, { ...old, ...patch, screenId, updatedAt: new Date().toISOString() });
  notifyAdminState();
}

function clearTimers(screenId) {
  const state = runtimeState.get(screenId);
  if (!state) return;
  if (state.nextTimer) clearTimeout(state.nextTimer);
  if (state.loadFailTimer) clearTimeout(state.loadFailTimer);
  state.nextTimer = null;
  state.loadFailTimer = null;
}

function getPlaylistForScreen(screenId) {
  return configCache.dashboards
    .filter((dashboard) => dashboard.enabled !== false && dashboard.screenId === screenId)
    .filter((dashboard) => !isDashboardCoolingDown(dashboard.id))
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
}

function getDashboardHealth(dashboardId) {
  if (!dashboardHealth.has(dashboardId)) dashboardHealth.set(dashboardId, { failures: 0, cooldownUntil: null });
  return dashboardHealth.get(dashboardId);
}

function isDashboardCoolingDown(dashboardId) {
  const health = getDashboardHealth(dashboardId);
  return !!(health.cooldownUntil && health.cooldownUntil > Date.now());
}

function noteDashboardSuccess(dashboardId) {
  const health = getDashboardHealth(dashboardId);
  health.failures = 0;
  health.cooldownUntil = null;
}

function noteDashboardFailure(dashboard, reason) {
  const health = getDashboardHealth(dashboard.id);
  const maxFailures = Number(getSetting('maxConsecutiveFailures', 3)) || 3;
  const cooldownMinutes = Number(getSetting('dashboardCooldownMinutes', 10)) || 10;
  health.failures += 1;
  writeLog('health', `Dashboard failed: ${dashboard.name} | reason=${reason} | failures=${health.failures}/${maxFailures}`);
  if (health.failures >= maxFailures) {
    health.failures = 0;
    health.cooldownUntil = Date.now() + cooldownMinutes * 60 * 1000;
    writeLog('health', `Dashboard cooled down: ${dashboard.name}`);
  }
}

function createDisplayWindow(displayBounds, title, partitionKey) {
  const kiosk = !!getSetting('kioskMode', true);
  const win = new BrowserWindow({
    x: displayBounds.x,
    y: displayBounds.y,
    width: displayBounds.width,
    height: displayBounds.height,
    title,
    backgroundColor: '#ffffff',
    frame: !kiosk,
    fullscreen: kiosk,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `persist:${partitionKey}`,
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

function closeAllDisplayWindows() {
  screenGeneration += 1;
  for (const [screenId, win] of displayWindows.entries()) {
    clearTimers(screenId);
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.removeAllListeners('did-finish-load');
        win.webContents.removeAllListeners('did-stop-loading');
        win.webContents.removeAllListeners('did-fail-load');
      } catch (_) {}
      win.destroy();
    }
  }
  displayWindows.clear();
}

function scheduleNext(screenId, delayMs) {
  const state = runtimeState.get(screenId);
  if (!state) return;
  if (state.nextTimer) clearTimeout(state.nextTimer);
  state.nextTimer = setTimeout(() => {
    if (!rotationPaused) advancePlaylist(screenId);
  }, delayMs);
}

function rebuildPlaylistIfNeeded(screenId) {
  const state = runtimeState.get(screenId);
  if (!state) return;
  state.playlist = getPlaylistForScreen(screenId);
  if (state.index >= state.playlist.length) state.index = 0;
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sampleTopRightBackgroundColor(wc, logPrefix) {
  try {
    if (!wc || wc.isDestroyed()) return null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!wc || wc.isDestroyed()) return null;
    const owner = wc.getOwnerBrowserWindow();
    if (!owner || owner.isDestroyed()) return null;
    const bounds = owner.getBounds();
    const image = await wc.capturePage({ x: Math.max(0, bounds.width - 140), y: 16, width: 18, height: 18 });
    const bitmap = image.toBitmap();
    if (!bitmap || bitmap.length < 4) return null;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < bitmap.length; i += 4) {
      b += bitmap[i];
      g += bitmap[i + 1];
      r += bitmap[i + 2];
      count += 1;
    }
    const hex = rgbToHex(Math.round(r / count), Math.round(g / count), Math.round(b / count));
    writeLog(logPrefix, `Sampled inset top-right background colour via capture: ${hex}`);
    return hex;
  } catch (err) {
    writeLog(logPrefix, `Background sample failed: ${err.message}`);
    return null;
  }
}

async function applyPageBackgroundColor(wc, color, logPrefix) {
  try {
    if (!wc || wc.isDestroyed() || !color) return;
    const owner = wc.getOwnerBrowserWindow();
    if (owner && !owner.isDestroyed()) owner.setBackgroundColor(color);
    await wc.executeJavaScript(`(() => { try { document.documentElement.style.backgroundColor = ${JSON.stringify(color)}; document.body.style.backgroundColor = ${JSON.stringify(color)}; } catch (_) {} })();`, true);
    writeLog(logPrefix, `Applied sampled background colour: ${color}`);
  } catch (err) {
    writeLog(logPrefix, `Failed applying background colour: ${err.message}`);
  }
}

async function setPageFadeState(wc, visible, logPrefix) {
  if (!getSetting('fadeTransitions', true)) return;
  try {
    if (!wc || wc.isDestroyed()) return;
    await wc.executeJavaScript(`(() => { try { document.body.style.transition = 'opacity 420ms ease'; document.body.style.opacity = ${visible ? '1' : '0'}; } catch (_) {} })();`, true);
  } catch (err) {
    writeLog(logPrefix, `Fade transition failed: ${err.message}`);
  }
}

async function applyReliableScrollOffset(wc, dashboard, logPrefix) {
  const requestedOffsetPx = Math.max(0, Number(dashboard.scrollOffsetPx || 0));
  if (requestedOffsetPx <= 0) {
    updateDiagnostics(logPrefix, { offsetRequested: 0, offsetApplied: 0, offsetTarget: 'none', offsetStatus: 'not-required' });
    return { requestedOffset: 0, appliedOffset: 0, maxOffset: 0, target: 'none', attempts: 0, success: true, reason: 'not-required', bodyHeight: 0, htmlHeight: 0, viewportHeight: 0 };
  }

  const maxWaitSeconds = Number(getSetting('scrollOffsetMaxWaitSeconds', 20)) || 20;
  const retryIntervalMs = Number(getSetting('scrollOffsetRetryIntervalMs', 1000)) || 1000;
  const maxAttempts = Math.max(1, Math.ceil((maxWaitSeconds * 1000) / retryIntervalMs));
  updateDiagnostics(logPrefix, { readinessState: 'waiting-for-scrollable-content', offsetRequested: requestedOffsetPx, offsetStatus: 'pending', offsetAttempts: 0 });

  const result = await wc.executeJavaScript(`(() => new Promise((resolve) => {
    const requestedOffset = ${requestedOffsetPx};
    const retryIntervalMs = ${retryIntervalMs};
    const maxAttempts = ${maxAttempts};
    let attempts = 0;
    function metrics() {
      return {
        bodyHeight: document.body ? document.body.scrollHeight : 0,
        htmlHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
        viewportHeight: window.innerHeight || 0
      };
    }
    function targetName(el) {
      if (!el) return 'none';
      if (el === document.scrollingElement) return 'document.scrollingElement';
      if (el === document.documentElement) return 'document.documentElement';
      if (el === document.body) return 'document.body';
      return (el.tagName || 'unknown').toLowerCase() + (el.id ? '#' + el.id : '');
    }
    function scrollTargets() {
      const set = new Set([document.scrollingElement, document.documentElement, document.body].filter(Boolean));
      for (const el of Array.from(document.querySelectorAll('*'))) {
        try { if (el.scrollHeight > el.clientHeight + 5) set.add(el); } catch (_) {}
      }
      return Array.from(set)
        .map((el) => ({ el, maxOffset: Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0)) }))
        .filter((x) => x.maxOffset > 5)
        .sort((a, b) => b.maxOffset - a.maxOffset);
    }
    function apply() {
      attempts += 1;
      const m = metrics();
      const best = scrollTargets()[0];
      if (!best) return { requestedOffset, appliedOffset: 0, maxOffset: 0, target: 'none', before: 0, after: 0, attempts, success: false, reason: 'no-scroll-target', ...m };
      const appliedOffset = Math.min(requestedOffset, Math.max(0, best.maxOffset - 25));
      const el = best.el;
      const before = el.scrollTop || window.scrollY || 0;
      if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
        window.scrollTo(0, appliedOffset);
        document.documentElement.scrollTop = appliedOffset;
        document.body.scrollTop = appliedOffset;
      } else {
        el.scrollTop = appliedOffset;
      }
      const after = el.scrollTop || window.scrollY || 0;
      const success = Math.abs(after - appliedOffset) <= 8 || appliedOffset === 0;
      return { requestedOffset, appliedOffset, maxOffset: best.maxOffset, target: targetName(el), before, after, attempts, success, reason: success ? 'applied' : 'target-did-not-move', ...m };
    }
    function verifyLater() {
      [2000, 5000, 10000, 15000].forEach((delay) => setTimeout(() => { try { apply(); } catch (_) {} }, delay));
    }
    function tick() {
      const result = apply();
      if (result.success && result.maxOffset > 0) { verifyLater(); resolve(result); return; }
      if (attempts >= maxAttempts) { resolve(result); return; }
      setTimeout(tick, retryIntervalMs);
    }
    tick();
  }))();`, true);

  updateDiagnostics(logPrefix, {
    readinessState: result.success ? 'visible-offset-applied' : 'visible-offset-not-applied',
    offsetRequested: result.requestedOffset,
    offsetApplied: result.appliedOffset,
    offsetTarget: result.target,
    offsetStatus: result.success ? 'applied' : result.reason,
    offsetAttempts: result.attempts,
    pageHeight: Math.max(Number(result.bodyHeight || 0), Number(result.htmlHeight || 0)),
    viewportHeight: Number(result.viewportHeight || 0),
    maxOffset: Number(result.maxOffset || 0)
  });
  writeLog(logPrefix, `Scroll offset result: requested=${result.requestedOffset}px applied=${result.appliedOffset}px max=${result.maxOffset}px target=${result.target} attempts=${result.attempts} success=${result.success} reason=${result.reason}`);
  return result;
}

async function applyDashboardView(wc, dashboard, logPrefix) {
  const zoomFactor = Number(dashboard.zoomFactor || 1);
  const requestedOffsetPx = Math.max(0, Number(dashboard.scrollOffsetPx || 0));
  updateDiagnostics(logPrefix, { readinessState: 'applying-view', dashboardId: dashboard.id, dashboardName: dashboard.name, dashboardUrl: dashboard.url, zoomFactor, offsetRequested: requestedOffsetPx, startedAt: new Date().toISOString() });
  if (!wc || wc.isDestroyed()) return { zoomFactor, scrollOffsetPx: requestedOffsetPx, sampledBackgroundColor: null, scrollResult: { success: false, reason: 'webcontents-destroyed' } };
  await wc.setZoomFactor(zoomFactor);
  await setPageFadeState(wc, true, logPrefix);

  async function sample(label) {
    try {
      if (!wc || wc.isDestroyed()) return null;
      const color = await sampleTopRightBackgroundColor(wc, logPrefix);
      if (!color) return null;
      await applyPageBackgroundColor(wc, color, logPrefix);
      updateDiagnostics(logPrefix, { sampledBackgroundColor: color });
      writeLog(logPrefix, `Background sample applied (${label}): ${color}`);
      return color;
    } catch (err) {
      writeLog(logPrefix, `Background sample failed (${label}): ${err.message}`);
      return null;
    }
  }

  const background = await sample('initial');
  setTimeout(() => sample('delayed-1s'), 1000);
  setTimeout(() => sample('delayed-2.5s'), 2500);
  setTimeout(() => sample('delayed-5s'), 5000);

  const scrollResult = { requestedOffset: requestedOffsetPx, appliedOffset: 0, maxOffset: 0, target: 'none', success: requestedOffsetPx === 0, reason: requestedOffsetPx === 0 ? 'not-required' : 'queued' };
  updateDiagnostics(logPrefix, { readinessState: 'visible', readyAt: new Date().toISOString(), offsetStatus: requestedOffsetPx > 0 ? 'queued' : 'not-required' });
  if (requestedOffsetPx > 0) {
    applyReliableScrollOffset(wc, dashboard, logPrefix).catch((err) => {
      updateDiagnostics(logPrefix, { readinessState: 'visible-offset-error', offsetStatus: err.message });
    });
  }
  return { zoomFactor, scrollOffsetPx: requestedOffsetPx, sampledBackgroundColor: background, scrollResult };
}

async function loadDashboardIntoWindow(screenId) {
  const state = runtimeState.get(screenId);
  if (!state) return;
  const generation = state.generation;
  const win = displayWindows.get(screenId);
  if (!win || win.isDestroyed()) return;

  rebuildPlaylistIfNeeded(screenId);
  if (!state.playlist || state.playlist.length === 0) {
    updateDiagnostics(screenId, { readinessState: 'no-playable-dashboards', lastError: 'No playable dashboards currently available' });
    scheduleNext(screenId, 15000);
    return;
  }

  clearTimers(screenId);
  const current = state.playlist[state.index];
  const nextDashboard = state.playlist.length > 1 ? state.playlist[(state.index + 1) % state.playlist.length] : null;
  const wc = win.webContents;
  const durationMs = Number(current.durationMs || 30000);
  const settleMs = Number(current.settleMs || 3000);
  const timeoutMs = Number(current.timeoutMs || 20000);
  const visibleForMs = durationMs + settleMs;
  let completed = false;
  let didStopLoadingFallbackTimer = null;

  updateDiagnostics(screenId, {
    readinessState: 'loading-url',
    dashboardId: current.id,
    dashboardName: current.name,
    dashboardUrl: current.url,
    nextDashboardId: nextDashboard ? nextDashboard.id : null,
    nextDashboardName: nextDashboard ? nextDashboard.name : null,
    currentIndex: state.index,
    totalItems: state.playlist.length,
    loadStartedAt: new Date().toISOString(),
    visibleForMs,
    lastError: null
  });
  writeLog(screenId, `Loading: ${current.name} | ${current.url}`);

  function cleanup() {
    try {
      wc.removeListener('did-finish-load', onDidFinishLoad);
      wc.removeListener('did-stop-loading', onDidStopLoading);
      wc.removeListener('did-fail-load', onDidFailLoad);
    } catch (_) {}
    if (didStopLoadingFallbackTimer) clearTimeout(didStopLoadingFallbackTimer);
    if (state.loadFailTimer) clearTimeout(state.loadFailTimer);
    state.loadFailTimer = null;
  }

  async function finishLoad(source) {
    if (completed) return;
    if (generation !== screenGeneration) { writeLog(screenId, `Ignoring stale load completion from old screen generation: ${source}`); return; }
    completed = true;
    cleanup();
    try {
      updateDiagnostics(screenId, { readinessState: 'url-loaded', urlLoadedAt: new Date().toISOString(), loadCompletionSource: source });
      writeLog(screenId, `URL load completed via ${source}: ${current.name}`);
      const viewState = await applyDashboardView(wc, current, screenId);
      noteDashboardSuccess(current.id);
      const dashboardStartedAt = new Date();
      const nextRotationAt = new Date(dashboardStartedAt.getTime() + visibleForMs);
      updateDiagnostics(screenId, {
        readinessState: 'visible',
        dashboardStartedAt: dashboardStartedAt.toISOString(),
        nextRotationAt: nextRotationAt.toISOString(),
        visibleForMs,
        nextDashboardId: nextDashboard ? nextDashboard.id : null,
        nextDashboardName: nextDashboard ? nextDashboard.name : null,
        lastLoadedDashboard: current.name,
        lastLoadedUrl: current.url
      });
      writeLog(screenId, `Loaded OK: ${current.name} | zoom=${viewState.zoomFactor} | scrollOffset=${viewState.scrollOffsetPx}px | offsetStatus=${viewState.scrollOffsetPx > 0 ? 'background' : 'not-required'} | visibleFor=${visibleForMs}ms | next=${nextDashboard ? nextDashboard.name : 'none'}`);
      scheduleNext(screenId, visibleForMs);
      notifyAdminState();
    } catch (err) {
      if (generation !== screenGeneration) return;
      noteDashboardFailure(current, `post-load:${err.message}`);
      updateDiagnostics(screenId, { readinessState: 'post-load-error', lastError: err.message });
      writeLog(screenId, `Post-load error: ${err.message}`);
      scheduleNext(screenId, 5000);
    }
  }

  function onDidFinishLoad() { finishLoad('did-finish-load'); }
  function onDidStopLoading() {
    if (completed) return;
    didStopLoadingFallbackTimer = setTimeout(() => { if (!completed) finishLoad('did-stop-loading'); }, 400);
  }
  function onDidFailLoad(_, errorCode, errorDescription, validatedURL, isMainFrame) {
    if (!isMainFrame || completed || generation !== screenGeneration) return;
    completed = true;
    cleanup();
    noteDashboardFailure(current, `did-fail-load:${errorCode}:${errorDescription}`);
    updateDiagnostics(screenId, { readinessState: 'load-failed', lastError: `${errorCode}: ${errorDescription}`, failedUrl: validatedURL });
    writeLog(screenId, `Load failed (${errorCode}): ${errorDescription} - ${validatedURL}`);
    scheduleNext(screenId, 3000);
    notifyAdminState();
  }

  wc.once('did-finish-load', onDidFinishLoad);
  wc.once('did-stop-loading', onDidStopLoading);
  wc.once('did-fail-load', onDidFailLoad);

  state.loadFailTimer = setTimeout(() => {
    if (completed || generation !== screenGeneration) return;
    completed = true;
    cleanup();
    noteDashboardFailure(current, `timeout:${timeoutMs}`);
    updateDiagnostics(screenId, { readinessState: 'timeout', lastError: `Timed out after ${timeoutMs}ms` });
    writeLog(screenId, `Timed out after ${timeoutMs}ms: ${current.name}`);
    scheduleNext(screenId, 1000);
    notifyAdminState();
  }, timeoutMs);

  try { await win.loadURL(current.url); }
  catch (err) {
    if (completed || generation !== screenGeneration) return;
    completed = true;
    cleanup();
    noteDashboardFailure(current, `loadURL-exception:${err.message}`);
    updateDiagnostics(screenId, { readinessState: 'load-url-exception', lastError: err.message });
    writeLog(screenId, `Exception during loadURL: ${err.message}`);
    scheduleNext(screenId, 3000);
  }
}

function advancePlaylist(screenId) {
  const state = runtimeState.get(screenId);
  if (!state) return;
  rebuildPlaylistIfNeeded(screenId);
  if (!state.playlist || state.playlist.length === 0) {
    updateDiagnostics(screenId, { readinessState: 'playlist-empty', lastError: 'Playlist empty after rebuild' });
    scheduleNext(screenId, 15000);
    return;
  }
  state.index = (state.index + 1) % state.playlist.length;
  loadDashboardIntoWindow(screenId);
}

function restartAllPlaylists() {
  for (const [screenId, state] of runtimeState.entries()) {
    state.index = 0;
    state.playlist = getPlaylistForScreen(screenId);
    if (state.playlist.length > 0) loadDashboardIntoWindow(screenId);
  }
}

function reloadCurrentScreens() {
  for (const [screenId, win] of displayWindows.entries()) {
    if (win && !win.isDestroyed()) {
      updateDiagnostics(screenId, { readinessState: 'manual-reload', manualReloadAt: new Date().toISOString() });
      win.webContents.reloadIgnoringCache();
    }
  }
}

function toggleRotationInternal() {
  rotationPaused = !rotationPaused;
  if (!rotationPaused) restartAllPlaylists();
  refreshTrayMenu();
  notifyAdminState();
}

function applyKioskModeToAllWindows() {
  const kiosk = !!getSetting('kioskMode', true);
  for (const [, win] of displayWindows.entries()) {
    if (!win || win.isDestroyed()) continue;
    if (kiosk) { win.setMenuBarVisibility(false); win.setFullScreen(true); }
    else { win.setFullScreen(false); win.setSize(1280, 720); win.center(); }
  }
}

function startConfiguredScreens() {
  closeAllDisplayWindows();
  runtimeState = new Map();
  const generation = screenGeneration;
  const enabledScreens = configCache.screens.filter((s) => s.enabled !== false);
  writeLog('system', `Detected displays: ${screen.getAllDisplays().length}`);
  writeLog('system', `Enabled screens in config: ${enabledScreens.length}`);
  for (const scr of enabledScreens) {
    const playlist = getPlaylistForScreen(scr.id);
    if (playlist.length === 0) {
      updateDiagnostics(scr.id, { readinessState: 'skipped-no-dashboards', screenName: scr.name, displayIndex: scr.displayIndex, lastError: 'No enabled and healthy dashboards assigned' });
      continue;
    }
    const display = getDisplayForIndex(Number(scr.displayIndex || 0));
    const win = createDisplayWindow(display.bounds, scr.name, scr.id);
    displayWindows.set(scr.id, win);
    runtimeState.set(scr.id, { screen: scr, playlist, index: 0, nextTimer: null, loadFailTimer: null, generation });
    updateDiagnostics(scr.id, { screenName: scr.name, displayIndex: scr.displayIndex, readinessState: 'screen-created', playlistCount: playlist.length });
    loadDashboardIntoWindow(scr.id);
  }
  notifyAdminState();
}

function identifyDisplays() {
  closeIdentifyWindows();
  const seconds = Number(getSetting('identifyOverlaySeconds', 4)) || 4;
  for (const display of getDetectedDisplays()) {
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      fullscreen: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#000000',
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true }
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:rgba(0,0,0,.92);color:#fff;font-family:Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center}.box{text-align:center;border:4px solid #0f6cbd;border-radius:28px;padding:40px 70px;background:#111827}.label{font-size:96px;font-weight:700;margin-bottom:20px}.meta{font-size:34px;color:#cfd8e3}</style></head><body><div class="box"><div class="label">${display.label}</div><div class="meta">${display.size}${display.primary ? ' - Primary' : ''}</div></div></body></html>`;
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    overlay.once('ready-to-show', () => overlay.showInactive());
    identifyWindows.push(overlay);
  }
  setTimeout(closeIdentifyWindows, seconds * 1000);
}

function closeIdentifyWindows() {
  for (const win of identifyWindows) if (win && !win.isDestroyed()) win.close();
  identifyWindows = [];
}

async function previewDashboard(dashboard) {
  if (!dashboard || !dashboard.url) throw new Error('Preview requires a dashboard URL');
  const win = createPreviewWindow();
  const timeoutMs = Number(dashboard.timeoutMs || 20000);
  return new Promise(async (resolve, reject) => {
    let done = false;
    let stopTimer = null;
    function cleanup() {
      clearTimeout(timeout);
      if (stopTimer) clearTimeout(stopTimer);
      win.webContents.removeListener('did-finish-load', finished);
      win.webContents.removeListener('did-stop-loading', stopped);
      win.webContents.removeListener('did-fail-load', failed);
    }
    async function complete(source) {
      if (done) return;
      done = true;
      cleanup();
      try {
        const state = await applyDashboardView(win.webContents, dashboard, 'preview');
        win.setTitle(`${APP_NAME} Preview - ${dashboard.name || 'Dashboard'} (${state.scrollOffsetPx}px offset)`);
        writeLog('preview', `Preview loaded via ${source}: ${dashboard.name || dashboard.url}`);
        resolve({ ok: true });
      } catch (err) {
        reject(err);
      }
    }
    function finished() { complete('did-finish-load'); }
    function stopped() { if (!done) stopTimer = setTimeout(() => complete('did-stop-loading'), 400); }
    function failed(_, code, description, url, mainFrame) {
      if (!mainFrame || done) return;
      done = true;
      cleanup();
      reject(new Error(`Preview load failed (${code}): ${description} - ${url}`));
    }
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`Preview timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    win.webContents.once('did-finish-load', finished);
    win.webContents.once('did-stop-loading', stopped);
    win.webContents.once('did-fail-load', failed);
    try { await win.loadURL(dashboard.url); }
    catch (err) { if (!done) { done = true; cleanup(); reject(err); } }
  });
}

function getDiagnosticsState() {
  return {
    app: {
      name: APP_NAME,
      version: app.getVersion(),
      userData: USER_DATA,
      configPath: USER_CONFIG_PATH,
      logDir: LOG_DIR,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage()
    },
    screens: Array.from(diagnosticsState.values())
  };
}

function getAdminState() {
  const runtimeScreens = Array.from(runtimeState.entries()).map(([screenId, state]) => {
    const current = state.playlist && state.playlist[state.index] ? state.playlist[state.index] : null;
    const next = state.playlist && state.playlist.length > 1 ? state.playlist[(state.index + 1) % state.playlist.length] : null;
    const diagnostics = diagnosticsState.get(screenId) || null;
    return {
      screenId,
      screenName: state.screen ? state.screen.name : screenId,
      displayIndex: state.screen ? state.screen.displayIndex : 0,
      currentIndex: state.index,
      totalItems: state.playlist ? state.playlist.length : 0,
      currentDashboard: current ? current.name : '',
      currentUrl: current ? current.url : '',
      nextDashboard: next ? next.name : '',
      nextDashboardId: next ? next.id : '',
      dashboardStartedAt: diagnostics ? diagnostics.dashboardStartedAt : null,
      nextRotationAt: diagnostics ? diagnostics.nextRotationAt : null,
      visibleForMs: diagnostics ? diagnostics.visibleForMs : null,
      diagnostics
    };
  });
  return {
    rotationPaused,
    startupEnabled: getStartupStatus(),
    settings: configCache.settings,
    screens: configCache.screens,
    dashboards: configCache.dashboards,
    detectedDisplays: getDetectedDisplays(),
    runtimeScreens,
    diagnostics: getDiagnosticsState()
  };
}

function setupWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = null;
  const minutes = Number(getSetting('watchdogReloadMinutes', 15)) || 0;
  if (minutes <= 0) {
    writeLog('watchdog', 'Watchdog disabled');
    return;
  }
  watchdogInterval = setInterval(() => {
    if (rotationPaused) return;
    for (const [screenId, win] of displayWindows.entries()) {
      const diag = diagnosticsState.get(screenId) || {};
      if (!win || win.isDestroyed()) { startConfiguredScreens(); return; }
      if (['timeout', 'load-failed', 'load-url-exception', 'post-load-error'].includes(diag.readinessState)) loadDashboardIntoWindow(screenId);
      else win.webContents.reloadIgnoringCache();
    }
  }, minutes * 60 * 1000);
  writeLog('watchdog', `Watchdog enabled: every ${minutes} minute(s)`);
}

function debouncedDisplayReconfigure(reason) {
  if (!getSetting('restartOnDisplayChange', true)) return;
  if (appReadyAtMs && Date.now() - appReadyAtMs < 8000) {
    writeLog('display', `Ignored display topology change during startup grace period (${reason})`);
    return;
  }
  if (displayChangeDebounce) clearTimeout(displayChangeDebounce);
  displayChangeDebounce = setTimeout(() => {
    writeLog('display', `Display topology changed, rebuilding screens (${reason})`);
    startConfiguredScreens();
  }, 2500);
}

function registerRecoveryHooks() {
  if (recoveryHooksRegistered) return;
  recoveryHooksRegistered = true;
  screen.on('display-added', () => debouncedDisplayReconfigure('display-added'));
  screen.on('display-removed', () => debouncedDisplayReconfigure('display-removed'));
  screen.on('display-metrics-changed', () => debouncedDisplayReconfigure('display-metrics-changed'));
  powerMonitor.on('resume', () => {
    if (getSetting('restartOnResume', true)) startConfiguredScreens();
  });
}

ipcMain.handle('get-config', async () => configCache);
ipcMain.handle('get-state', async () => getAdminState());
ipcMain.handle('get-detected-displays', async () => getDetectedDisplays());
ipcMain.handle('get-diagnostics', async () => getDiagnosticsState());
ipcMain.handle('open-config-folder', async () => { ensureDir(USER_DATA); await shell.openPath(USER_DATA); return { ok: true, path: USER_DATA }; });
ipcMain.handle('open-log-folder', async () => { ensureDir(LOG_DIR); await shell.openPath(LOG_DIR); return { ok: true, path: LOG_DIR }; });
ipcMain.handle('create-config-backup', async () => { try { return { ok: true, path: createConfigBackup('manual') }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('export-config', async () => {
  try {
    const result = await dialog.showSaveDialog(adminWindow || undefined, {
      title: 'Export BoardRunner Config',
      defaultPath: `BoardRunner-config-export-${getTimestampForFileName()}.json`,
      filters: [{ name: 'JSON Config', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(configCache || readConfigFile(), null, 2), 'utf8');
    return { ok: true, path: result.filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('import-config', async () => {
  try {
    const result = await dialog.showOpenDialog(adminWindow || undefined, { title: 'Import BoardRunner Config', properties: ['openFile'], filters: [{ name: 'JSON Config', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { ok: false, cancelled: true };
    const imported = migrateConfig(JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8')));
    validateConfig(imported);
    createConfigBackup('pre-import');
    writeConfigFile(imported);
    configCache = imported;
    applyStartupSetting();
    setupWatchdog();
    startConfiguredScreens();
    applyKioskModeToAllWindows();
    refreshTrayMenu();
    notifyAdminState();
    return { ok: true, path: result.filePaths[0], config: configCache };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('save-config', async (_, config) => {
  try {
    saveConfig(config);
    startConfiguredScreens();
    applyKioskModeToAllWindows();
    refreshTrayMenu();
    notifyAdminState();
    return { ok: true };
  } catch (err) {
    writeLog('config', `Save failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('reload-screens', async () => { reloadCurrentScreens(); return { ok: true }; });
ipcMain.handle('toggle-rotation', async () => { toggleRotationInternal(); return { ok: true, rotationPaused }; });
ipcMain.handle('identify-displays', async () => { identifyDisplays(); return { ok: true }; });
ipcMain.handle('show-admin', async () => { showAdminWindow(); return { ok: true }; });
ipcMain.handle('preview-dashboard', async (_, dashboard) => {
  try { await previewDashboard(dashboard); return { ok: true }; }
  catch (err) { writeLog('preview', `Preview failed: ${err.message}`); return { ok: false, error: err.message }; }
});

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'Translate,BackForwardCache');

app.whenReady().then(() => {
  try {
    appReadyAtMs = Date.now();
    ensureDir(USER_DATA);
    ensureDir(LOG_DIR);
    ensureDir(BACKUP_DIR);
    loadConfig();
    createBackupIfVersionChanged();
    createTray();
    createAdminWindow();
    setupWatchdog();
    registerRecoveryHooks();
    startConfiguredScreens();
    if (!getSetting('trayOnlyStartup', true)) showAdminWindow();
    writeLog('system', `Application started. Version=${app.getVersion()} Writable config path: ${USER_CONFIG_PATH}`);
  } catch (err) {
    dialog.showErrorBox(APP_NAME, err.message);
    app.quit();
  }
});

app.on('before-quit', () => { quitting = true; if (watchdogInterval) clearInterval(watchdogInterval); });
app.on('window-all-closed', (event) => event.preventDefault());
