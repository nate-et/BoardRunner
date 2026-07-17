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
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (err) {
  autoUpdater = null;
}

const APP_NAME = 'BoardRunner';
app.setName(APP_NAME);

const USER_DATA = app.getPath('userData');
const BUNDLED_CONFIG_PATH = path.join(__dirname, 'config.json');
const USER_CONFIG_PATH = path.join(USER_DATA, 'config.json');
const BACKUP_DIR = path.join(USER_DATA, 'backups');
const LOG_DIR = path.join(USER_DATA, 'logs');
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray.png');

let tray = null;
let adminWindow = null;
let previewWindow = null;
let configCache = null;
let rotationPaused = false;
let displayWindows = new Map();
let runtimeState = new Map();
let screenSnapshots = new Map();
let identifyWindows = [];
let quitting = false;

let watchdogInterval = null;
let updateState = { status: 'idle', currentVersion: app.getVersion(), availableVersion: null, downloaded: false, lastCheckedAt: null, error: null };
let displayChangeDebounce = null;
let recoveryHooksRegistered = false;

const dashboardHealth = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getLogPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${date}.log`);
}

function writeLog(prefix, message) {
  ensureDir(LOG_DIR);
  const line = `[${new Date().toISOString()}] [${prefix}] ${message}`;
  console.log(line);

  try {
    fs.appendFileSync(getLogPath(), line + '\n', 'utf8');
  } catch (err) {
    console.error('Log write failed:', err.message);
  }
}

function defaultConfig() {
  return {
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
      stagedPublishEnabled: true,
      applyMode: 'next-rotation',
      autoUpdateEnabled: true,
      autoUpdateCheckOnStartup: true,
      autoUpdateCheckIntervalMinutes: 60,
      autoUpdateOwner: '',
      autoUpdateRepo: 'BoardRunner',
      autoUpdateAllowPrerelease: false,
      autoUpdateAutoDownload: true,
      autoUpdateInstallAutomatically: true,
      autoUpdateInstallHourLocal: 3
    },
    playlists: [],
    screens: [
      {
        id: 'screen-1',
        name: 'Operations',
        displayIndex: 0,
        enabled: true
      },
      {
        id: 'screen-2',
        name: 'Performance',
        displayIndex: 1,
        enabled: true
      }
    ],
    dashboards: []
  };
}

function readConfigFile() {
  ensureDir(USER_DATA);

  if (fs.existsSync(USER_CONFIG_PATH)) {
    const raw = fs.readFileSync(USER_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  }

  let initialConfig;

  if (fs.existsSync(BUNDLED_CONFIG_PATH)) {
    const raw = fs.readFileSync(BUNDLED_CONFIG_PATH, 'utf8');
    initialConfig = JSON.parse(raw);
  } else {
    initialConfig = defaultConfig();
  }

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(initialConfig, null, 2), 'utf8');
  return initialConfig;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Config must be an object');
  }

  if (!config.settings || typeof config.settings !== 'object') {
    throw new Error('Config must contain settings');
  }

  if (!Array.isArray(config.screens)) {
    throw new Error('Config must contain screens array');
  }

  if (!Array.isArray(config.dashboards)) {
    throw new Error('Config must contain dashboards array');
  }
  if (config.playlists !== undefined && !Array.isArray(config.playlists)) {
    throw new Error('Config playlists must be an array');
  }

  const screenIds = new Set();

  for (const [i, scr] of config.screens.entries()) {
    if (!scr.id || typeof scr.id !== 'string') {
      throw new Error(`Screen ${i + 1} is missing id`);
    }

    if (!scr.name || typeof scr.name !== 'string') {
      throw new Error(`Screen ${i + 1} is missing name`);
    }

    if (screenIds.has(scr.id)) {
      throw new Error(`Duplicate screen id: ${scr.id}`);
    }

    screenIds.add(scr.id);

    if (scr.displayIndex !== undefined && Number(scr.displayIndex) < 0) {
      throw new Error(`Screen ${scr.name} has invalid displayIndex`);
    }
  }

  for (const [i, db] of config.dashboards.entries()) {
    if (!db.id || typeof db.id !== 'string') {
      throw new Error(`Dashboard ${i + 1} is missing id`);
    }

    if (!db.name || typeof db.name !== 'string') {
      throw new Error(`Dashboard ${i + 1} is missing name`);
    }

    if (!db.url || typeof db.url !== 'string') {
      throw new Error(`Dashboard ${db.name} is missing URL`);
    }

    if (db.screenId && !screenIds.has(db.screenId)) {
      throw new Error(`Dashboard ${db.name} references an invalid screen`);
    }

    if (Number(db.durationMs || 0) <= 0) {
      throw new Error(`Dashboard ${db.name} has invalid durationMs`);
    }

    if (Number(db.zoomFactor || 0) <= 0) {
      throw new Error(`Dashboard ${db.name} has invalid zoomFactor`);
    }

    if (Number(db.sequence || 0) <= 0) {
      throw new Error(`Dashboard ${db.name} has invalid sequence`);
    }

    if (db.scrollOffsetPx !== undefined && Number(db.scrollOffsetPx) < 0) {
      throw new Error(`Dashboard ${db.name} has invalid scrollOffsetPx`);
    }
  }

  const dashboardIds = new Set(config.dashboards.map((db) => db.id));
  const playlistIds = new Set();

  for (const [i, playlist] of (config.playlists || []).entries()) {
    if (!playlist.id || typeof playlist.id !== 'string') {
      throw new Error(`Playlist ${i + 1} is missing id`);
    }
    if (!playlist.name || typeof playlist.name !== 'string') {
      throw new Error(`Playlist ${i + 1} is missing name`);
    }
    if (playlistIds.has(playlist.id)) {
      throw new Error(`Duplicate playlist id: ${playlist.id}`);
    }
    playlistIds.add(playlist.id);
    if (!Array.isArray(playlist.items)) {
      throw new Error(`Playlist ${playlist.name} must contain items array`);
    }
    for (const [itemIndex, item] of playlist.items.entries()) {
      if (!item.dashboardId || !dashboardIds.has(item.dashboardId)) {
        throw new Error(`Playlist ${playlist.name} item ${itemIndex + 1} references an invalid dashboard`);
      }
      if (Number(item.durationMs || 0) <= 0) {
        throw new Error(`Playlist ${playlist.name} item ${itemIndex + 1} has invalid durationMs`);
      }
    }
  }

  for (const scr of config.screens) {
    if (scr.playlistId && !playlistIds.has(scr.playlistId)) {
      throw new Error(`Screen ${scr.name} references an invalid playlist`);
    }
  }
}


function createId(prefix, source, index = 0) {
  const safe = String(source || `${prefix}-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `${prefix}-${index + 1}`;
  return `${prefix}-${safe}`;
}

function migrateDashboardsToPlaylists(config) {
  const migrated = {
    ...config,
    settings: { ...(config.settings || {}) },
    screens: Array.isArray(config.screens) ? config.screens.map((screenItem) => ({ ...screenItem })) : [],
    dashboards: Array.isArray(config.dashboards) ? config.dashboards.map((dashboardItem) => ({ ...dashboardItem })) : [],
    playlists: Array.isArray(config.playlists) ? config.playlists.map((playlist) => ({ ...playlist, items: Array.isArray(playlist.items) ? playlist.items.map((item) => ({ ...item })) : [] })) : []
  };

  if (migrated.playlists.length > 0) {
    return migrated;
  }

  migrated.playlists = migrated.screens.map((screenItem, index) => {
    const dashboardsForScreen = migrated.dashboards
      .filter((dashboardItem) => dashboardItem.screenId === screenItem.id)
      .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));

    const playlistId = createId('playlist', screenItem.name || screenItem.id, index);
    screenItem.playlistId = playlistId;

    return {
      id: playlistId,
      name: `${screenItem.name || `Screen ${index + 1}`} Playlist`,
      description: 'Migrated from screen-assigned dashboards',
      items: dashboardsForScreen.map((dashboardItem, itemIndex) => ({
        id: createId('pli', `${dashboardItem.id}-${itemIndex + 1}`, itemIndex),
        dashboardId: dashboardItem.id,
        durationMs: Number(dashboardItem.durationMs || 30000),
        zoomFactor: Number(dashboardItem.zoomFactor || 1),
        scrollOffsetPx: Number(dashboardItem.scrollOffsetPx || 0),
        settleMs: Number(dashboardItem.settleMs || 3000),
        timeoutMs: Number(dashboardItem.timeoutMs || 20000),
        enabled: dashboardItem.enabled !== false
      }))
    };
  });

  return migrated;
}

function mergeConfigWithDefaults(config) {
  const defaults = defaultConfig();
  const migrated = normaliseDashboardUrls(migrateDashboardsToPlaylists(config || defaults));

  return {
    settings: {
      ...defaults.settings,
      ...(migrated.settings || {})
    },
    screens: Array.isArray(migrated.screens) ? migrated.screens : defaults.screens,
    dashboards: Array.isArray(migrated.dashboards) ? migrated.dashboards : defaults.dashboards,
    playlists: Array.isArray(migrated.playlists) ? migrated.playlists : defaults.playlists
  };
}

function loadConfig() {
  const cfg = mergeConfigWithDefaults(readConfigFile());
  validateConfig(cfg);
  configCache = cfg;
  rotationPaused = false;
  applyStartupSetting();
  return cfg;
}

function writeUserConfig(config) {
  ensureDir(USER_DATA);
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}


function getTimestampForFileName() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
}

function createConfigBackup(reason = 'manual') {
  ensureDir(BACKUP_DIR);

  let sourceConfig = configCache;

  if (!sourceConfig && fs.existsSync(USER_CONFIG_PATH)) {
    sourceConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf8'));
  }

  if (!sourceConfig) {
    sourceConfig = defaultConfig();
  }

  const timestamp = getTimestampForFileName();
  const fileName = `BoardRunner-config-${reason}-${timestamp}.json`;
  const backupPath = path.join(BACKUP_DIR, fileName);

  fs.writeFileSync(backupPath, JSON.stringify(sourceConfig, null, 2), 'utf8');

  writeLog('backup', `Config backup created: ${backupPath}`);
  pruneOldConfigBackups();

  return backupPath;
}

function pruneOldConfigBackups(maxBackups = 25) {
  try {
    ensureDir(BACKUP_DIR);

    const files = fs.readdirSync(BACKUP_DIR)
      .filter((file) => file.toLowerCase().endsWith('.json'))
      .map((file) => {
        const fullPath = path.join(BACKUP_DIR, file);
        const stat = fs.statSync(fullPath);
        return {
          file,
          fullPath,
          mtime: stat.mtimeMs
        };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const oldFiles = files.slice(maxBackups);

    for (const oldFile of oldFiles) {
      fs.unlinkSync(oldFile.fullPath);
      writeLog('backup', `Old config backup pruned: ${oldFile.fullPath}`);
    }

  } catch (err) {
    writeLog('backup', `Failed to prune old config backups: ${err.message}`);
  }
}


function saveConfig(config) {
  const merged = mergeConfigWithDefaults(normaliseDashboardUrls(config));
  validateConfig(merged);

  if (fs.existsSync(USER_CONFIG_PATH) || configCache) {
    createConfigBackup('pre-save');
  }

  writeUserConfig(merged);

  configCache = merged;
  applyStartupSetting();
  setupWatchdog();
  configureAutoUpdater();
  writeLog('config', `Config saved to ${USER_CONFIG_PATH}`);
}


function persistCurrentConfig() {
  if (!configCache) return;
  writeUserConfig(configCache);
}


function sanitizeDashboardUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) return raw;

  const hrefMatch = raw.match(/href\s*=\s*["']([^"']+)["']/i);
  if (hrefMatch && hrefMatch[1]) {
    raw = hrefMatch[1].trim();
  }

  raw = raw
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }

  return raw;
}

function normaliseDashboardUrls(config) {
  if (!config || !Array.isArray(config.dashboards)) return config;
  config.dashboards = config.dashboards.map((dashboard) => ({
    ...dashboard,
    url: sanitizeDashboardUrl(dashboard.url)
  }));
  return config;
}

function clearDashboardHealthState(reason = 'manual') {
  dashboardHealth.clear();
  writeLog('health', `Dashboard health state cleared (${reason})`);
}

function getSetting(name, fallback) {
  if (!configCache || !configCache.settings) return fallback;
  return configCache.settings[name] ?? fallback;
}

function isKioskMode() {
  return !!getSetting('kioskMode', true);
}

function getDetectedDisplays() {
  return screen.getAllDisplays().map((d, index) => ({
    index,
    id: d.id,
    label: `Display ${index + 1}`,
    primary: d.id === screen.getPrimaryDisplay().id,
    bounds: d.bounds,
    size: `${d.size.width}x${d.size.height}`
  }));
}

function getDisplayForIndex(displayIndex) {
  const displays = screen.getAllDisplays();

  if (typeof displayIndex === 'number' && displays[displayIndex]) {
    return displays[displayIndex];
  }

  return screen.getPrimaryDisplay();
}

function getStartupOptions(enabled) {
  if (process.platform !== 'win32') {
    return { openAtLogin: false };
  }

  if (process.defaultApp) {
    return {
      openAtLogin: enabled,
      path: process.execPath,
      args: [path.resolve(process.argv[1])]
    };
  }

  return {
    openAtLogin: enabled,
    path: process.execPath,
    args: []
  };
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
  try {
    if (process.platform !== 'win32') return false;
    return app.getLoginItemSettings(getStartupOptions(true)).openAtLogin;
  } catch {
    return !!getSetting('startWithWindows', false);
  }
}

function createTray() {
  const icon = fs.existsSync(TRAY_ICON_PATH)
    ? nativeImage.createFromPath(TRAY_ICON_PATH)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  refreshTrayMenu();

  tray.on('double-click', () => {
    showAdminWindow();
  });
}

function refreshTrayMenu() {
  if (!tray) return;

  const menu = Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { type: 'separator' },
    {
      label: 'Open Admin',
      click: () => showAdminWindow()
    },
    {
      label: rotationPaused ? 'Resume Rotation' : 'Pause Rotation',
      click: () => {
        rotationPaused = !rotationPaused;
        writeLog('tray', rotationPaused ? 'Rotation paused' : 'Rotation resumed');

        if (!rotationPaused) {
          restartAllPlaylists();
        }

        refreshTrayMenu();
        notifyAdminState();
      }
    },
    {
      label: 'Reload Screens',
      click: () => {
        reloadCurrentScreens();
      }
    },
    {
      label: 'Identify Displays',
      click: () => {
        identifyDisplays();
      }
    },
    { type: 'separator' },
    {
      label: isKioskMode() ? 'Disable Kiosk Mode' : 'Enable Kiosk Mode',
      click: () => {
        configCache.settings.kioskMode = !isKioskMode();
        persistCurrentConfig();
        applyKioskModeToAllWindows();
        refreshTrayMenu();
        notifyAdminState();
      }
    },
    {
      label: getSetting('startWithWindows', false)
        ? 'Disable Start with Windows'
        : 'Enable Start with Windows',
      click: () => {
        configCache.settings.startWithWindows = !getSetting('startWithWindows', false);
        persistCurrentConfig();
        applyStartupSetting();
        refreshTrayMenu();
        notifyAdminState();
      }
    },
    { type: 'separator' },
    {
      label: 'Open Logs Folder',
      click: () => {
        ensureDir(LOG_DIR);
        shell.openPath(LOG_DIR);
      }
    },
    {
      label: 'Exit',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
}

function createAdminWindow() {
  if (adminWindow && !adminWindow.isDestroyed()) {
    return adminWindow;
  }

  adminWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1100,
    minHeight: 760,
    title: `${APP_NAME} Admin`,
    autoHideMenuBar: true,
    backgroundColor: '#111111',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  adminWindow.loadFile(path.join(__dirname, 'admin.html'));

  adminWindow.on('close', (e) => {
    const hideToTray = !!getSetting('hideAdminToTray', true);

    if (!quitting && hideToTray) {
      e.preventDefault();
      adminWindow.hide();
    }
  });

  adminWindow.on('closed', () => {
    adminWindow = null;
  });

  return adminWindow;
}

function showAdminWindow() {
  const win = createAdminWindow();

  if (!win.isVisible()) {
    win.show();
  }

  if (win.isMinimized()) {
    win.restore();
  }

  win.focus();
}

function createPreviewWindow() {
  if (previewWindow && !previewWindow.isDestroyed()) {
    return previewWindow;
  }

  previewWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: `${APP_NAME} Preview`,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  previewWindow.once('ready-to-show', () => {
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.show();
      previewWindow.focus();
    }
  });

  previewWindow.on('closed', () => {
    previewWindow = null;
  });

  previewWindow.webContents.setAudioMuted(true);
  previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  return previewWindow;
}


async function captureScreenSnapshot(screenId) {
  try {
    const win = displayWindows.get(screenId);
    if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return null;

    const image = await win.webContents.capturePage();
    const resized = image.resize({ width: 640, quality: 'good' });
    const dataUrl = resized.toDataURL();
    const snapshot = {
      screenId,
      capturedAt: new Date().toISOString(),
      dataUrl
    };

    screenSnapshots.set(screenId, snapshot);
    notifyAdminState();
    return snapshot;
  } catch (err) {
    writeLog('snapshot', `Failed to capture ${screenId}: ${err.message}`);
    return null;
  }
}

function scheduleScreenSnapshot(screenId, delayMs = 1000) {
  setTimeout(() => {
    captureScreenSnapshot(screenId).catch((err) => {
      writeLog('snapshot', `Snapshot schedule failed for ${screenId}: ${err.message}`);
    });
  }, delayMs);
}

function clearTimers(screenId) {
  const state = runtimeState.get(screenId);
  if (!state) return;

  if (state.nextTimer) clearTimeout(state.nextTimer);
  if (state.loadFailTimer) clearTimeout(state.loadFailTimer);

  state.nextTimer = null;
  state.loadFailTimer = null;
}

function getDashboardHealth(dashboardId) {
  if (!dashboardHealth.has(dashboardId)) {
    dashboardHealth.set(dashboardId, {
      failures: 0,
      cooldownUntil: null,
      lastStatus: 'unknown',
      lastError: null,
      lastCheckedAt: null,
      history: []
    });
  }

  return dashboardHealth.get(dashboardId);
}

function isDashboardCoolingDown(dashboardId) {
  const info = getDashboardHealth(dashboardId);
  return !!(info.cooldownUntil && info.cooldownUntil > Date.now());
}

function recordDashboardHealthEvent(dashboardId, status, detail = {}) {
  const info = getDashboardHealth(dashboardId);
  const event = {
    status,
    at: new Date().toISOString(),
    dashboardId,
    dashboardName: detail.dashboardName || '',
    screenId: detail.screenId || '',
    screenName: detail.screenName || '',
    url: detail.url || '',
    reason: detail.reason || '',
    loadMs: detail.loadMs || null,
    offsetRequested: detail.offsetRequested ?? null,
    offsetApplied: detail.offsetApplied ?? null,
    offsetTarget: detail.offsetTarget || '',
    pageHeight: detail.pageHeight ?? null,
    viewportHeight: detail.viewportHeight ?? null
  };
  info.lastStatus = status;
  info.lastError = status === 'ok' ? null : event.reason;
  info.lastCheckedAt = event.at;
  info.history = [event, ...(info.history || [])].slice(0, 10);
  return event;
}

function noteDashboardSuccess(dashboardId, detail = {}) {
  const info = getDashboardHealth(dashboardId);

  if (info.failures > 0 || info.cooldownUntil) {
    writeLog('health', `Dashboard recovered: ${dashboardId}`);
  }

  info.failures = 0;
  info.cooldownUntil = null;
}

function noteDashboardFailure(dashboard, reason) {
  const info = getDashboardHealth(dashboard.id);
  const maxFailures = Number(getSetting('maxConsecutiveFailures', 3)) || 3;
  const cooldownMinutes = Number(getSetting('dashboardCooldownMinutes', 10)) || 10;

  info.failures += 1;

  writeLog(
    'health',
    `Dashboard failed: ${dashboard.name} | reason=${reason} | failures=${info.failures}/${maxFailures}`
  );

  if (info.failures >= maxFailures) {
    info.failures = 0;
    info.cooldownUntil = Date.now() + cooldownMinutes * 60 * 1000;

    writeLog(
      'health',
      `Dashboard cooled down: ${dashboard.name} until ${new Date(info.cooldownUntil).toISOString()}`
    );
  }
}

function getPlaylistForScreen(screenId) {
  const screenItem = configCache.screens.find((screen) => screen.id === screenId);
  const playlist = screenItem && screenItem.playlistId
    ? (configCache.playlists || []).find((item) => item.id === screenItem.playlistId)
    : null;

  if (playlist && Array.isArray(playlist.items) && playlist.items.length > 0) {
    const playlistDashboards = playlist.items
      .filter((item) => item.enabled !== false)
      .map((item, index) => {
        const dashboard = configCache.dashboards.find((candidate) => candidate.id === item.dashboardId);
        if (!dashboard || dashboard.enabled === false || isDashboardCoolingDown(dashboard.id)) return null;
        return {
          ...dashboard,
          playlistItemId: item.id || `${playlist.id}-${dashboard.id}-${index}`,
          playlistId: playlist.id,
          playlistName: playlist.name,
          sequence: index + 1,
          durationMs: Number(item.durationMs ?? dashboard.durationMs ?? 30000),
          zoomFactor: Number(item.zoomFactor ?? dashboard.zoomFactor ?? dashboard.defaultZoomFactor ?? 1),
          scrollOffsetPx: Number(item.scrollOffsetPx ?? dashboard.scrollOffsetPx ?? dashboard.defaultScrollOffsetPx ?? 0),
          settleMs: Number(item.settleMs ?? dashboard.settleMs ?? 3000),
          timeoutMs: Number(item.timeoutMs ?? dashboard.timeoutMs ?? 20000)
        };
      })
      .filter(Boolean);

    if (playlistDashboards.length > 0) {
      return playlistDashboards;
    }

    const cooldownBypassed = playlist.items
      .filter((item) => item.enabled !== false)
      .map((item, index) => {
        const dashboard = configCache.dashboards.find((candidate) => candidate.id === item.dashboardId);
        if (!dashboard || dashboard.enabled === false) return null;
        return {
          ...dashboard,
          playlistItemId: item.id || `${playlist.id}-${dashboard.id}-${index}`,
          playlistId: playlist.id,
          playlistName: playlist.name,
          sequence: index + 1,
          durationMs: Number(item.durationMs ?? dashboard.durationMs ?? 30000),
          zoomFactor: Number(item.zoomFactor ?? dashboard.zoomFactor ?? dashboard.defaultZoomFactor ?? 1),
          scrollOffsetPx: Number(item.scrollOffsetPx ?? dashboard.scrollOffsetPx ?? dashboard.defaultScrollOffsetPx ?? 0),
          settleMs: Number(item.settleMs ?? dashboard.settleMs ?? 3000),
          timeoutMs: Number(item.timeoutMs ?? dashboard.timeoutMs ?? 20000)
        };
      })
      .filter(Boolean);

    if (cooldownBypassed.length > 0) {
      writeLog('playlist', `Playlist ${playlist.name} only had cooled-down dashboards for ${screenId}; bypassing cooldown to keep playback running`);
      return cooldownBypassed;
    }

    writeLog('playlist', `Playlist ${playlist.name} produced no playable dashboards for ${screenId}; falling back to legacy screen assignments`);
  }

  const legacyPlayable = configCache.dashboards
    .filter((d) => d.enabled !== false && d.screenId === screenId)
    .filter((d) => !isDashboardCoolingDown(d.id))
    .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));

  if (legacyPlayable.length > 0) return legacyPlayable;

  return configCache.dashboards
    .filter((d) => d.enabled !== false && d.screenId === screenId)
    .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
}

function createDisplayWindow(displayBounds, title, partitionKey) {
  const kiosk = isKioskMode();

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

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  return win;
}

function closeAllDisplayWindows() {
  for (const [screenId, win] of displayWindows.entries()) {
    clearTimers(screenId);

    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  }

  displayWindows.clear();
  screenSnapshots.clear();
}

function scheduleNext(screenId, delayMs) {
  const state = runtimeState.get(screenId);
  if (!state) return;

  if (state.nextTimer) {
    clearTimeout(state.nextTimer);
  }

  state.nextTimer = setTimeout(() => {
    if (rotationPaused) return;
    advancePlaylist(screenId);
  }, delayMs);
}

function rebuildPlaylistIfNeeded(screenId) {
  const state = runtimeState.get(screenId);
  if (!state) return;

  state.playlist = getPlaylistForScreen(screenId);

  if (state.index >= state.playlist.length) {
    state.index = 0;
  }
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function isProbablyTransparentOrInvalid(r, g, b, a) {
  return a === 0 || Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b);
}

function normaliseCssRgbToHex(value) {
  if (!value || typeof value !== 'string') return null;

  const trimmed = value.trim().toLowerCase();

  if (trimmed === 'transparent' || trimmed === 'rgba(0, 0, 0, 0)') {
    return null;
  }

  if (trimmed.startsWith('#')) {
    if (trimmed.length === 4) {
      return '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
    }

    if (trimmed.length === 7) {
      return trimmed;
    }

    return null;
  }

  const rgbaMatch = trimmed.match(/rgba?\(([^)]+)\)/);

  if (!rgbaMatch) return null;

  const parts = rgbaMatch[1]
    .split(',')
    .map((part) => part.trim())
    .map(Number);

  if (parts.length < 3) return null;

  const r = Math.max(0, Math.min(255, Math.round(parts[0])));
  const g = Math.max(0, Math.min(255, Math.round(parts[1])));
  const b = Math.max(0, Math.min(255, Math.round(parts[2])));

  const a = parts.length >= 4 ? Number(parts[3]) : 1;

  if (a === 0) return null;

  return rgbToHex(r, g, b);
}


async function sampleTopRightBackgroundColorViaDom(wc, logPrefix) {
  try {
    const color = await wc.executeJavaScript(`
      (() => {
        const rightInsetPx = 140;
        const topInsetPx = 16;

        function isUsefulColor(value) {
          if (!value) return false;

          const normalised = String(value).trim().toLowerCase();

          if (!normalised) return false;
          if (normalised === 'transparent') return false;
          if (normalised === 'rgba(0, 0, 0, 0)') return false;

          return true;
        }

        function getBackgroundFromElement(el) {
          let current = el;

          while (current) {
            try {
              const style = window.getComputedStyle(current);
              const bg = style.backgroundColor;

              if (isUsefulColor(bg)) {
                return bg;
              }
            } catch (_) {}

            current = current.parentElement;
          }

          try {
            const htmlBg = window.getComputedStyle(document.documentElement).backgroundColor;
            if (isUsefulColor(htmlBg)) return htmlBg;
          } catch (_) {}

          try {
            const bodyBg = window.getComputedStyle(document.body).backgroundColor;
            if (isUsefulColor(bodyBg)) return bodyBg;
          } catch (_) {}

          return null;
        }

        const x = Math.max(0, window.innerWidth - rightInsetPx);
        const y = topInsetPx;

        const pointEl = document.elementFromPoint(x, y);
        const pointBg = getBackgroundFromElement(pointEl);

        if (pointBg) return pointBg;

        const candidates = [
          document.body,
          document.documentElement,
          document.querySelector('[class*="dashboard"]'),
          document.querySelector('[class*="page"]'),
          document.querySelector('[class*="container"]'),
          document.querySelector('[class*="content"]')
        ].filter(Boolean);

        for (const candidate of candidates) {
          const candidateBg = getBackgroundFromElement(candidate);
          if (candidateBg) return candidateBg;
        }

        return '#ffffff';
      })();
    `, true);

    const hex = normaliseCssRgbToHex(color) || '#ffffff';

    writeLog(logPrefix, `Sampled inset top-right background colour via DOM: ${hex} (${color})`);
    return hex;
  } catch (err) {
    writeLog(logPrefix, `DOM background sample failed: ${err.message}`);
    return '#ffffff';
  }
}

async function sampleTopRightBackgroundColorViaCapture(wc, logPrefix) {
  const owner = wc.getOwnerBrowserWindow();

  if (!owner || owner.isDestroyed()) return null;

  const bounds = owner.getBounds();

  const sampleSize = 18;
  const rightInsetPx = 140;
  const topInsetPx = 16;

  const x = Math.max(0, bounds.width - rightInsetPx);
  const y = topInsetPx;

  const image = await wc.capturePage({
    x,
    y,
    width: sampleSize,
    height: sampleSize
  });

  const bitmap = image.toBitmap();

  if (!bitmap || bitmap.length < 4) {
    writeLog(logPrefix, 'Background capture sample failed: empty bitmap');
    return null;
  }

  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let count = 0;

  for (let i = 0; i < bitmap.length; i += 4) {
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    const a = bitmap[i + 3];

    if (isProbablyTransparentOrInvalid(r, g, b, a)) continue;

    totalR += r;
    totalG += g;
    totalB += b;
    count += 1;
  }

  if (count === 0) {
    writeLog(logPrefix, 'Background capture sample failed: no valid pixels');
    return null;
  }

  const avgR = Math.round(totalR / count);
  const avgG = Math.round(totalG / count);
  const avgB = Math.round(totalB / count);

  const hex = rgbToHex(avgR, avgG, avgB);

  writeLog(logPrefix, `Sampled inset top-right background colour via capture: ${hex}`);
  return hex;
}

async function sampleTopRightBackgroundColor(wc, logPrefix) {
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));

    const captureColor = await sampleTopRightBackgroundColorViaCapture(wc, logPrefix);

    if (captureColor) {
      return captureColor;
    }
  } catch (err) {
    writeLog(logPrefix, `Background capture sample failed, falling back to DOM: ${err.message}`);
  }

  return sampleTopRightBackgroundColorViaDom(wc, logPrefix);
}

async function applyPageBackgroundColor(wc, color, logPrefix) {
  const safeColor = color || '#ffffff';

  try {
    const owner = wc.getOwnerBrowserWindow();

    if (owner && !owner.isDestroyed()) {
      owner.setBackgroundColor(safeColor);
    }

    await wc.executeJavaScript(`
      (() => {
        const color = ${JSON.stringify(safeColor)};

        try {
          document.documentElement.style.backgroundColor = color;
          document.body.style.backgroundColor = color;

          let filler = document.getElementById('boardrunner-bg-fill');

          if (!filler) {
            filler = document.createElement('div');
            filler.id = 'boardrunner-bg-fill';
            filler.style.position = 'fixed';
            filler.style.inset = '0';
            filler.style.zIndex = '-1';
            filler.style.pointerEvents = 'none';
            document.documentElement.appendChild(filler);
          }

          filler.style.backgroundColor = color;
        } catch (_) {}
      })();
    `, true);

    writeLog(logPrefix, `Applied sampled background colour: ${safeColor}`);
  } catch (err) {
    writeLog(logPrefix, `Failed to apply sampled background colour: ${err.message}`);
  }
}

async function applyDashboardView(wc, dashboard, logPrefix) {
  const zoomFactor = Number(dashboard.zoomFactor || 1);
  const requestedOffsetPx = Math.max(0, Number(dashboard.scrollOffsetPx || 0));

  await wc.setZoomFactor(zoomFactor);

  async function sampleAndApplyBackground(label) {
    try {
      const sampledBackgroundColor = await sampleTopRightBackgroundColor(wc, logPrefix);

      if (sampledBackgroundColor) {
        await applyPageBackgroundColor(wc, sampledBackgroundColor, logPrefix);
        writeLog(logPrefix, `Background sample applied (${label}): ${sampledBackgroundColor}`);
        return sampledBackgroundColor;
      }
    } catch (err) {
      writeLog(logPrefix, `Background sample/apply failed (${label}): ${err.message}`);
    }

    return null;
  }

  let finalBackgroundColor = null;
  let scrollResult = {
    applied: requestedOffsetPx === 0,
    target: 'none',
    requestedOffset: requestedOffsetPx,
    appliedOffset: 0,
    maxOffset: 0,
    before: 0,
    after: 0,
    fallbackTransform: false,
    error: null
  };
  let pageMetrics = { pageHeight: 0, viewportHeight: 0, scrollY: 0 };

  finalBackgroundColor = await sampleAndApplyBackground('initial');

  setTimeout(() => { sampleAndApplyBackground('delayed-1s'); }, 1000);
  setTimeout(() => { sampleAndApplyBackground('delayed-2.5s'); }, 2500);
  setTimeout(() => { sampleAndApplyBackground('delayed-5s'); }, 5000);

  try {
    const result = await wc.executeJavaScript(`
      (() => {
        const requestedOffset = ${requestedOffsetPx};

        function describe(el) {
          if (!el) return 'none';
          if (el === window) return 'window';
          if (el === document.scrollingElement) return 'document.scrollingElement';
          if (el === document.documentElement) return 'document.documentElement';
          if (el === document.body) return 'document.body';
          const tag = el.tagName ? el.tagName.toLowerCase() : 'unknown';
          const id = el.id ? '#' + el.id : '';
          const cls = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().replace(/\\s+/g, '.')
            : '';
          return tag + id + cls;
        }

        function clearFallbackTransform() {
          try {
            if (document.body && document.body.dataset.boardrunnerOffsetFallback === '1') {
              document.body.style.transform = '';
              document.body.style.transformOrigin = '';
              document.body.style.willChange = '';
              document.body.dataset.boardrunnerOffsetFallback = '0';
            }
          } catch (_) {}
        }

        function getMetrics() {
          const body = document.body;
          const root = document.documentElement;
          return {
            pageHeight: Math.max(
              body ? body.scrollHeight : 0,
              root ? root.scrollHeight : 0,
              body ? body.offsetHeight : 0,
              root ? root.offsetHeight : 0
            ),
            viewportHeight: window.innerHeight || 0,
            scrollY: window.scrollY || root.scrollTop || (body ? body.scrollTop : 0) || 0
          };
        }

        function getPotentialScrollTargets() {
          const targets = [];
          const seen = new Set();
          function add(el) {
            if (!el || seen.has(el)) return;
            seen.add(el);
            targets.push(el);
          }
          add(document.scrollingElement);
          add(document.documentElement);
          add(document.body);

          const points = [
            [Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)],
            [Math.floor(window.innerWidth * 0.25), Math.floor(window.innerHeight / 2)],
            [Math.floor(window.innerWidth * 0.75), Math.floor(window.innerHeight / 2)]
          ];
          points.forEach(([x, y]) => {
            let current = document.elementFromPoint(x, y);
            while (current) {
              add(current);
              current = current.parentElement;
            }
          });

          Array.from(document.querySelectorAll('*')).forEach((el) => {
            try {
              const style = window.getComputedStyle(el);
              const overflowY = style.overflowY;
              const overflow = style.overflow;
              const scrollLike = ['auto', 'scroll', 'overlay'].includes(overflowY) || ['auto', 'scroll', 'overlay'].includes(overflow);
              const hasActualScroll = el.scrollHeight > el.clientHeight + 4;
              if (scrollLike || hasActualScroll) add(el);
            } catch (_) {}
          });

          return targets;
        }

        function tryScrollTarget(el) {
          if (!el) return null;
          const isDocumentTarget = el === document.scrollingElement || el === document.documentElement || el === document.body;
          const maxOffset = isDocumentTarget
            ? Math.max(0, getMetrics().pageHeight - (window.innerHeight || 0))
            : Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));

          if (maxOffset <= 3 && requestedOffset > 0) return null;

          const appliedOffset = Math.min(requestedOffset, Math.max(0, maxOffset - 1));
          const before = isDocumentTarget ? (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0) : (el.scrollTop || 0);

          if (isDocumentTarget) {
            window.scrollTo({ top: appliedOffset, left: 0, behavior: 'auto' });
            document.documentElement.scrollTop = appliedOffset;
            if (document.body) document.body.scrollTop = appliedOffset;
          } else {
            el.scrollTop = appliedOffset;
          }

          const after = isDocumentTarget ? (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0) : (el.scrollTop || 0);
          const delta = Math.abs(after - appliedOffset);
          return {
            applied: requestedOffset === 0 || delta <= 3 || Math.abs(after - before) > 2,
            target: describe(el),
            requestedOffset,
            appliedOffset,
            maxOffset,
            before,
            after,
            fallbackTransform: false
          };
        }

        function applyFallbackTransform() {
          const metrics = getMetrics();
          const maxOffset = Math.max(0, metrics.pageHeight - metrics.viewportHeight);
          const appliedOffset = maxOffset > 0 ? Math.min(requestedOffset, maxOffset) : requestedOffset;

          if (!document.body) {
            return {
              applied: false,
              target: 'none',
              requestedOffset,
              appliedOffset: 0,
              maxOffset,
              before: 0,
              after: 0,
              fallbackTransform: false
            };
          }

          document.body.dataset.boardrunnerOffsetFallback = appliedOffset > 0 ? '1' : '0';
          document.body.style.transformOrigin = 'top left';
          document.body.style.willChange = 'transform';
          document.body.style.transform = appliedOffset > 0 ? 'translateY(-' + appliedOffset + 'px)' : '';

          return {
            applied: true,
            target: 'body.transformFallback',
            requestedOffset,
            appliedOffset,
            maxOffset,
            before: 0,
            after: appliedOffset,
            fallbackTransform: true
          };
        }

        function applyBoardRunnerOffset() {
          clearFallbackTransform();

          if (requestedOffset <= 0) {
            window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
            document.documentElement.scrollTop = 0;
            if (document.body) document.body.scrollTop = 0;
            return {
              applied: true,
              target: 'reset',
              requestedOffset,
              appliedOffset: 0,
              maxOffset: Math.max(0, getMetrics().pageHeight - getMetrics().viewportHeight),
              before: 0,
              after: 0,
              fallbackTransform: false
            };
          }

          const targets = getPotentialScrollTargets()
            .map((el) => {
              const isDocumentTarget = el === document.scrollingElement || el === document.documentElement || el === document.body;
              const maxOffset = isDocumentTarget
                ? Math.max(0, getMetrics().pageHeight - (window.innerHeight || 0))
                : Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
              const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
              const areaScore = rect ? Math.min(Math.max(0, rect.width) * Math.max(0, rect.height) / 1000, 800) : 0;
              const documentBonus = isDocumentTarget ? 500 : 0;
              return { el, maxOffset, score: maxOffset + areaScore + documentBonus };
            })
            .filter((item) => item.maxOffset > 3)
            .sort((a, b) => b.score - a.score);

          for (const item of targets) {
            const result = tryScrollTarget(item.el);
            if (result && result.applied && result.appliedOffset > 0) return result;
          }

          return applyFallbackTransform();
        }

        const first = applyBoardRunnerOffset();
        window.__boardrunnerApplyOffset = applyBoardRunnerOffset;
        window.__boardrunnerOffsetState = {
          requestedOffset,
          repairs: 0,
          observerEvents: 0
        };

        const reapplySchedule = [100,250,500,1000,2000,5000,10000,15000];
        reapplySchedule.forEach(delay => setTimeout(() => {
          applyBoardRunnerOffset();
          if (window.__boardrunnerOffsetState) window.__boardrunnerOffsetState.repairs++;
        }, delay));

        let repairTimer = null;
        function scheduleOffsetRepair() {
          clearTimeout(repairTimer);
          repairTimer = setTimeout(() => {
            applyBoardRunnerOffset();
            if (window.__boardrunnerOffsetState) window.__boardrunnerOffsetState.repairs++;
          }, 250);
        }

        if (!window.__boardrunnerOffsetObserver && document.documentElement) {
          window.__boardrunnerOffsetObserver = new MutationObserver(() => {
            if (window.__boardrunnerOffsetState) window.__boardrunnerOffsetState.observerEvents++;
            scheduleOffsetRepair();
          });
          window.__boardrunnerOffsetObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true
          });
        }

        setInterval(() => {
          try {
            const actual = window.scrollY || document.documentElement.scrollTop || (document.body ? document.body.scrollTop : 0) || 0;
            if (Math.abs(actual - requestedOffset) > 15) {
              applyBoardRunnerOffset();
            }
          } catch (_) {}
        }, 3000);

        return {
          ...first,
          metrics: getMetrics()
        };
      })();
    `, true);

    if (result) {
      scrollResult = {
        applied: !!result.applied,
        target: result.target || 'none',
        requestedOffset: result.requestedOffset ?? requestedOffsetPx,
        appliedOffset: result.appliedOffset ?? 0,
        maxOffset: result.maxOffset ?? 0,
        before: result.before ?? 0,
        after: result.after ?? 0,
        fallbackTransform: !!result.fallbackTransform,
        error: null
      };
      pageMetrics = result.metrics || pageMetrics;
    }

    writeLog(
      logPrefix,
      `Scroll offset result: requested=${scrollResult.requestedOffset}px applied=${scrollResult.appliedOffset}px max=${scrollResult.maxOffset}px target=${scrollResult.target} before=${scrollResult.before} after=${scrollResult.after} fallback=${scrollResult.fallbackTransform}`
    );
  } catch (scrollErr) {
    scrollResult.error = scrollErr.message;
    writeLog(logPrefix, `Failed to apply scroll offset: ${scrollErr.message}`);
  }

  try {
    pageMetrics = await wc.executeJavaScript(`(() => {
      const body = document.body;
      const root = document.documentElement;
      return {
        pageHeight: Math.max(body ? body.scrollHeight : 0, root ? root.scrollHeight : 0, body ? body.offsetHeight : 0, root ? root.offsetHeight : 0),
        viewportHeight: window.innerHeight || 0,
        scrollY: window.scrollY || root.scrollTop || (body ? body.scrollTop : 0) || 0
      };
    })();`, true);
  } catch (metricsErr) {
    writeLog(logPrefix, `Failed to read page metrics: ${metricsErr.message}`);
  }

  return {
    zoomFactor,
    scrollOffsetPx: requestedOffsetPx,
    sampledBackgroundColor: finalBackgroundColor,
    scrollResult,
    pageMetrics
  };
}

async function loadDashboardIntoWindow(screenId) {
  const state = runtimeState.get(screenId);

  if (!state) return;

  const win = displayWindows.get(screenId);

  if (!win || win.isDestroyed()) return;

  rebuildPlaylistIfNeeded(screenId);

  if (!state.playlist || state.playlist.length === 0) {
    writeLog(screenId, 'No playable dashboards currently available');
    scheduleNext(screenId, 15000);
    notifyAdminState();
    return;
  }

  clearTimers(screenId);

  const current = state.playlist[state.index];
  const wc = win.webContents;

  const durationMs = Number(current.durationMs || 30000);
  const settleMs = Number(current.settleMs || 3000);
  const timeoutMs = Number(current.timeoutMs || 20000);
  const loadStartedMs = Date.now();
  const loadUrl = sanitizeDashboardUrl(current.url);
  current.url = loadUrl;

  writeLog(screenId, `Loading: ${current.name} | ${loadUrl}`);

  const onDidFinishLoad = async () => {
    try {
      if (state.loadFailTimer) {
        clearTimeout(state.loadFailTimer);
      }

      wc.removeListener('did-fail-load', onDidFailLoad);

      const viewState = await applyDashboardView(wc, current, screenId);
      noteDashboardSuccess(current.id, {
        dashboardName: current.name,
        screenId,
        screenName: state.screen ? state.screen.name : '',
        url: current.url,
        loadMs: Date.now() - loadStartedMs,
        offsetRequested: Number(current.scrollOffsetPx || 0),
        offsetApplied: viewState.scrollResult ? viewState.scrollResult.appliedOffset : null,
        offsetTarget: viewState.scrollResult ? viewState.scrollResult.target : '',
        pageHeight: viewState.pageMetrics ? viewState.pageMetrics.pageHeight : null,
        viewportHeight: viewState.pageMetrics ? viewState.pageMetrics.viewportHeight : null
      });

      writeLog(
        screenId,
        `Loaded OK: ${current.name} | zoom=${viewState.zoomFactor} | scrollOffset=${viewState.scrollOffsetPx}px | bg=${viewState.sampledBackgroundColor || 'none'} | visibleFor=${durationMs + settleMs}ms`
      );

      scheduleNext(screenId, durationMs + settleMs);
      scheduleScreenSnapshot(screenId, 600);
      scheduleScreenSnapshot(screenId, 3000);
      notifyAdminState();
    } catch (err) {
      noteDashboardFailure(current, `post-load:${err.message}`);
      writeLog(screenId, `Post-load error: ${err.message}`);
      scheduleNext(screenId, 5000);
    }
  };

  const onDidFailLoad = (_, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;

    if (state.loadFailTimer) {
      clearTimeout(state.loadFailTimer);
    }

    wc.removeListener('did-finish-load', onDidFinishLoad);

    noteDashboardFailure(current, `did-fail-load:${errorCode}:${errorDescription}`);
    writeLog(screenId, `Load failed (${errorCode}): ${errorDescription} - ${validatedURL}`);

    scheduleNext(screenId, 3000);
    notifyAdminState();
  };

  wc.once('did-finish-load', onDidFinishLoad);
  wc.once('did-fail-load', onDidFailLoad);

  state.loadFailTimer = setTimeout(() => {
    wc.removeListener('did-finish-load', onDidFinishLoad);
    wc.removeListener('did-fail-load', onDidFailLoad);

    noteDashboardFailure(current, `timeout:${timeoutMs}`);
    writeLog(screenId, `Timed out after ${timeoutMs}ms: ${current.name}`);

    scheduleNext(screenId, 1000);
    notifyAdminState();
  }, timeoutMs);

  try {
    await win.loadURL(loadUrl);
  } catch (err) {
    if (state.loadFailTimer) {
      clearTimeout(state.loadFailTimer);
    }

    wc.removeListener('did-finish-load', onDidFinishLoad);
    wc.removeListener('did-fail-load', onDidFailLoad);

    noteDashboardFailure(current, `loadURL-exception:${err.message}`);
    writeLog(screenId, `Exception during loadURL: ${err.message}`);
    scheduleNext(screenId, 3000);
  }
}

function advancePlaylist(screenId) {
  const state = runtimeState.get(screenId);

  if (!state) return;

  rebuildPlaylistIfNeeded(screenId);

  if (!state.playlist || state.playlist.length === 0) {
    writeLog(screenId, 'Playlist empty after rebuild, retrying later');
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

    if (state.playlist.length > 0) {
      loadDashboardIntoWindow(screenId);
    } else {
      writeLog(screenId, 'No dashboards available on playlist restart');
    }
  }
}

function reloadCurrentScreens() {
  for (const [screenId, win] of displayWindows.entries()) {
    if (win && !win.isDestroyed()) {
      writeLog('reload', `Reloading ${screenId}`);
      win.webContents.reloadIgnoringCache();
      scheduleScreenSnapshot(screenId, 3500);
    }
  }
}

function applyKioskModeToAllWindows() {
  const kiosk = isKioskMode();

  for (const [, win] of displayWindows.entries()) {
    if (!win || win.isDestroyed()) continue;

    if (kiosk) {
      win.setMenuBarVisibility(false);
      win.setFullScreen(true);
    } else {
      win.setFullScreen(false);
      win.setSize(1280, 720);
      win.center();
    }
  }

  writeLog('display', `Kiosk mode = ${kiosk}`);
}

function startConfiguredScreens() {
  clearDashboardHealthState('screen restart');
  closeAllDisplayWindows();
  runtimeState = new Map();

  const enabledScreens = configCache.screens.filter((s) => s.enabled !== false);

  writeLog('system', `Detected displays: ${screen.getAllDisplays().length}`);
  writeLog('system', `Enabled screens in config: ${enabledScreens.length}`);

  for (const scr of enabledScreens) {
    const playlist = getPlaylistForScreen(scr.id);

    if (playlist.length === 0) {
      writeLog('system', `Skipping ${scr.name} - no enabled and healthy dashboards assigned`);
      continue;
    }

    const display = getDisplayForIndex(Number(scr.displayIndex || 0));
    const key = scr.id;

    const win = createDisplayWindow(display.bounds, scr.name, key);

    displayWindows.set(key, win);
    runtimeState.set(key, {
      screen: scr,
      playlist,
      index: 0,
      nextTimer: null,
      loadFailTimer: null
    });

    loadDashboardIntoWindow(key);
    scheduleScreenSnapshot(key, 6000);
  }

  notifyAdminState();
}

function identifyDisplays() {
  closeIdentifyWindows();

  const seconds = Number(getSetting('identifyOverlaySeconds', 4)) || 4;
  const displays = getDetectedDisplays();

  for (const display of displays) {
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
      webPreferences: {
        contextIsolation: true,
        sandbox: true
      }
    });

    const html = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.92);
            color: #ffffff;
            font-family: Segoe UI, Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .box {
            text-align: center;
            border: 4px solid #0f6cbd;
            border-radius: 28px;
            padding: 40px 70px;
            background: #111827;
            box-shadow: 0 0 40px rgba(0,0,0,0.4);
          }
          .label {
            font-size: 96px;
            font-weight: 700;
            margin-bottom: 20px;
          }
          .meta {
            font-size: 34px;
            color: #cfd8e3;
          }
        </style>
      </head>
      <body>
        <div class="box">
          <div class="label">${display.label}</div>
          <div class="meta">${display.size}${display.primary ? ' • Primary' : ''}</div>
        </div>
      </body>
      </html>
    `;

    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    overlay.once('ready-to-show', () => overlay.showInactive());
    identifyWindows.push(overlay);
  }

  setTimeout(closeIdentifyWindows, seconds * 1000);
  writeLog('display', 'Identify displays triggered');
}


function identifySingleDisplay(displayIndex) {
  closeIdentifyWindows();
  const seconds = Number(getSetting('identifyOverlaySeconds', 4)) || 4;
  const displays = getDetectedDisplays();
  const display = displays.find((item) => Number(item.index) === Number(displayIndex));

  if (!display) {
    writeLog('display', `Identify single display failed: display ${displayIndex} not found`);
    return false;
  }

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
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });

  const html = `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        html, body { margin:0; width:100%; height:100%; background:rgba(0,0,0,.92); color:#fff; font-family:Segoe UI, Arial, sans-serif; display:flex; align-items:center; justify-content:center; }
        .box { text-align:center; border:4px solid #627cff; border-radius:34px; padding:48px 84px; background:#202124; box-shadow:0 0 50px rgba(0,0,0,.48); }
        .label { font-size:96px; font-weight:800; margin-bottom:18px; }
        .meta { font-size:34px; color:#dbeafe; }
      </style>
    </head>
    <body>
      <div class="box">
        <div class="label">${display.label}</div>
        <div class="meta">${display.size}${display.primary ? ' • Primary' : ''}</div>
      </div>
    </body>
    </html>
  `;

  overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  overlay.once('ready-to-show', () => overlay.showInactive());
  identifyWindows.push(overlay);
  setTimeout(closeIdentifyWindows, seconds * 1000);
  writeLog('display', `Identify single display triggered: ${display.label}`);
  return true;
}

function closeIdentifyWindows() {
  for (const win of identifyWindows) {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  }

  identifyWindows = [];
}

async function previewDashboard(dashboard) {
  if (!dashboard || !dashboard.url) {
    throw new Error('Preview requires a dashboard URL');
  }

  dashboard.url = sanitizeDashboardUrl(dashboard.url);
  const win = createPreviewWindow();
  const timeoutMs = Number(dashboard.timeoutMs || 20000);

  writeLog('preview', `Previewing: ${dashboard.name || dashboard.url}`);

  return new Promise(async (resolve, reject) => {
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutHandle);
      win.webContents.removeListener('did-finish-load', onDidFinishLoad);
      win.webContents.removeListener('did-fail-load', onDidFailLoad);
      resolve(result);
    };

    const fail = (message) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutHandle);
      win.webContents.removeListener('did-finish-load', onDidFinishLoad);
      win.webContents.removeListener('did-fail-load', onDidFailLoad);
      reject(new Error(message));
    };

    const onDidFinishLoad = async () => {
      try {
        const viewState = await applyDashboardView(win.webContents, dashboard, 'preview');
        win.setTitle(`${APP_NAME} Preview - ${dashboard.name || 'Dashboard'} (${viewState.scrollOffsetPx}px offset)`);
        if (dashboard.id) {
          recordDashboardHealthEvent(dashboard.id, 'ok', {
            dashboardName: dashboard.name || '',
            screenId: 'preview',
            screenName: 'Preview',
            url: dashboard.url,
            reason: 'preview',
            offsetRequested: Number(dashboard.scrollOffsetPx || 0),
            offsetApplied: viewState.scrollResult ? viewState.scrollResult.appliedOffset : null,
            offsetTarget: viewState.scrollResult ? viewState.scrollResult.target : '',
            pageHeight: viewState.pageMetrics ? viewState.pageMetrics.pageHeight : null,
            viewportHeight: viewState.pageMetrics ? viewState.pageMetrics.viewportHeight : null
          });
        }
        writeLog('preview', `Preview loaded: ${dashboard.name || dashboard.url}`);
        finish({
          ok: true,
          previewDiagnostics: {
            dashboardId: dashboard.id || '',
            dashboardName: dashboard.name || '',
            url: dashboard.url,
            zoomFactor: viewState.zoomFactor,
            scrollOffsetPx: viewState.scrollOffsetPx,
            sampledBackgroundColor: viewState.sampledBackgroundColor || null,
            scrollResult: viewState.scrollResult || null,
            pageMetrics: viewState.pageMetrics || null,
            loadedAt: new Date().toISOString()
          }
        });
      } catch (err) {
        fail(`Preview post-load failed: ${err.message}`);
      }
    };

    const onDidFailLoad = (_, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      fail(`Preview load failed (${errorCode}): ${errorDescription} - ${validatedURL}`);
    };

    const timeoutHandle = setTimeout(() => {
      fail(`Preview timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    win.webContents.once('did-finish-load', onDidFinishLoad);
    win.webContents.once('did-fail-load', onDidFailLoad);

    try {
      await win.loadURL(dashboard.url);
    } catch (err) {
      fail(`Preview loadURL exception: ${err.message}`);
    }
  });
}

function getAdminState() {
  const runtimeScreens = Array.from(runtimeState.entries()).map(([screenId, state]) => {
    const current = state.playlist && state.playlist[state.index]
      ? state.playlist[state.index]
      : null;

    return {
      screenId,
      screenName: state.screen ? state.screen.name : screenId,
      displayIndex: state.screen ? state.screen.displayIndex : 0,
      currentIndex: state.index,
      totalItems: state.playlist ? state.playlist.length : 0,
      currentDashboard: current ? current.name : '',
      currentUrl: current ? current.url : '',
      currentPlaylist: current ? current.playlistName || '' : '',
      snapshot: screenSnapshots.get(screenId) || null
    };
  });

  return {
    rotationPaused,
    startupEnabled: getStartupStatus(),
    settings: configCache.settings,
    screens: configCache.screens,
    playlists: configCache.playlists || [],
    dashboards: configCache.dashboards,
    dashboardHealth: configCache.dashboards.map((dashboard) => {
      const info = getDashboardHealth(dashboard.id);
      return {
        dashboardId: dashboard.id,
        dashboardName: dashboard.name,
        failures: info.failures || 0,
        cooldownUntil: info.cooldownUntil ? new Date(info.cooldownUntil).toISOString() : null,
        lastStatus: info.lastStatus || 'unknown',
        lastError: info.lastError || null,
        lastCheckedAt: info.lastCheckedAt || null,
        history: info.history || []
      };
    }),
    detectedDisplays: getDetectedDisplays(),
    runtimeScreens,
    updateState
  };
}

function notifyAdminState() {
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.webContents.send('app-state', getAdminState());
  }
}


function setUpdateState(patch) {
  updateState = {
    ...updateState,
    ...patch,
    currentVersion: app.getVersion()
  };
  notifyAdminState();
}

function getAutoUpdateOwner() {
  const owner = String(getSetting('autoUpdateOwner', '') || '').trim();
  if (owner) return owner;
  try {
    const pkg = require(path.join(__dirname, 'package.json'));
    const repo = pkg.repository && (pkg.repository.url || pkg.repository);
    const match = String(repo || '').match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/i);
    return match ? match[1] : '';
  } catch (_) {
    return '';
  }
}

function getAutoUpdateRepo() {
  const repo = String(getSetting('autoUpdateRepo', 'BoardRunner') || '').trim();
  if (repo) return repo;
  try {
    const pkg = require(path.join(__dirname, 'package.json'));
    const raw = pkg.repository && (pkg.repository.url || pkg.repository);
    const match = String(raw || '').match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/i);
    return match ? match[2] : '';
  } catch (_) {
    return '';
  }
}

function configureAutoUpdater() {
  if (!autoUpdater) {
    setUpdateState({ status: 'disabled', error: 'electron-updater dependency is not installed' });
    writeLog('update', 'Auto updater unavailable: electron-updater dependency not installed');
    return false;
  }

  const enabled = !!getSetting('autoUpdateEnabled', true);
  if (!enabled) {
    setUpdateState({ status: 'disabled', error: null });
    writeLog('update', 'Auto updater disabled by config');
    return false;
  }

  const owner = getAutoUpdateOwner();
  const repo = getAutoUpdateRepo();
  if (!owner || !repo) {
    setUpdateState({ status: 'not-configured', error: 'GitHub owner/repo not configured' });
    writeLog('update', 'Auto updater not configured: set settings.autoUpdateOwner and settings.autoUpdateRepo');
    return false;
  }

  autoUpdater.autoDownload = !!getSetting('autoUpdateAutoDownload', true);
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = !!getSetting('autoUpdateAllowPrerelease', false);
  autoUpdater.setFeedURL({ provider: 'github', owner, repo });

  if (!configureAutoUpdater.handlersRegistered) {
    autoUpdater.on('checking-for-update', () => {
      setUpdateState({ status: 'checking', lastCheckedAt: new Date().toISOString(), error: null });
      writeLog('update', 'Checking for updates');
    });
    autoUpdater.on('update-available', (info) => {
      setUpdateState({ status: 'available', availableVersion: info.version || null, downloaded: false, error: null });
      writeLog('update', `Update available: ${info.version || 'unknown'}`);
    });
    autoUpdater.on('update-not-available', (info) => {
      setUpdateState({ status: 'current', availableVersion: info.version || null, downloaded: false, error: null });
      writeLog('update', 'No update available');
    });
    autoUpdater.on('download-progress', (progress) => {
      setUpdateState({ status: 'downloading', progress: Math.round(progress.percent || 0), error: null });
    });
    autoUpdater.on('update-downloaded', (info) => {
      setUpdateState({ status: 'downloaded', availableVersion: info.version || null, downloaded: true, progress: 100, error: null });
      writeLog('update', `Update downloaded: ${info.version || 'unknown'}; will install on quit, when requested, or at the configured install hour`);
      if (shouldInstallDownloadedUpdateNow()) {
        installDownloadedUpdate('downloaded-during-install-window');
      }
    });
    autoUpdater.on('error', (err) => {
      setUpdateState({ status: 'error', error: err.message || String(err) });
      writeLog('update', `Updater error: ${err.message || err}`);
    });
    configureAutoUpdater.handlersRegistered = true;
  }

  setUpdateState({ status: 'ready', error: null });
  writeLog('update', `Auto updater configured for GitHub ${owner}/${repo}`);
  return true;
}

async function checkForUpdatesManual() {
  if (!app.isPackaged) {
    setUpdateState({ status: 'dev-mode', error: 'Updater only runs in packaged builds' });
    return { ok: false, error: 'Updater only runs in packaged builds' };
  }
  if (!configureAutoUpdater()) {
    return { ok: false, error: updateState.error || 'Updater is not configured' };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true, state: updateState };
  } catch (err) {
    setUpdateState({ status: 'error', error: err.message });
    return { ok: false, error: err.message };
  }
}

function installDownloadedUpdate(reason = 'manual') {
  if (!autoUpdater || !updateState.downloaded) {
    return { ok: false, error: 'No downloaded update is ready to install' };
  }
  writeLog('update', `Installing downloaded update now (${reason})`);
  setUpdateState({ status: 'installing', error: null });
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
}

function shouldInstallDownloadedUpdateNow(date = new Date()) {
  if (!updateState.downloaded) return false;
  if (!getSetting('autoUpdateInstallAutomatically', true)) return false;
  const preferredHour = Number(getSetting('autoUpdateInstallHourLocal', 3));
  if (!Number.isFinite(preferredHour)) return false;
  return date.getHours() === Math.max(0, Math.min(23, Math.floor(preferredHour)));
}

function setupAutoInstallScheduler() {
  if (setupAutoInstallScheduler.interval) {
    clearInterval(setupAutoInstallScheduler.interval);
    setupAutoInstallScheduler.interval = null;
  }

  setupAutoInstallScheduler.interval = setInterval(() => {
    try {
      if (shouldInstallDownloadedUpdateNow()) {
        installDownloadedUpdate('scheduled');
      }
    } catch (err) {
      writeLog('update', `Scheduled update install failed: ${err.message}`);
    }
  }, 5 * 60 * 1000);
}

function setupAutoUpdateScheduler() {
  if (!app.isPackaged) {
    writeLog('update', 'Skipping auto updater in development mode');
    return;
  }
  if (!configureAutoUpdater()) return;

  if (getSetting('autoUpdateCheckOnStartup', true)) {
    setTimeout(() => {
      checkForUpdatesManual().catch((err) => writeLog('update', `Startup update check failed: ${err.message}`));
    }, 15000);
  }

  setupAutoInstallScheduler();

  const minutes = Number(getSetting('autoUpdateCheckIntervalMinutes', 60)) || 0;
  if (minutes > 0) {
    setInterval(() => {
      checkForUpdatesManual().catch((err) => writeLog('update', `Scheduled update check failed: ${err.message}`));
    }, minutes * 60 * 1000);
    writeLog('update', `Auto update checks scheduled every ${minutes} minute(s)`);
  }
}

function setupWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }

  const minutes = Number(getSetting('watchdogReloadMinutes', 15)) || 0;

  if (minutes <= 0) {
    writeLog('watchdog', 'Watchdog disabled');
    return;
  }

  const intervalMs = minutes * 60 * 1000;

  watchdogInterval = setInterval(() => {
    if (rotationPaused) {
      writeLog('watchdog', 'Skipped watchdog reload because rotation is paused');
      return;
    }

    writeLog('watchdog', `Running periodic reload (${minutes} minute interval)`);
    reloadCurrentScreens();
  }, intervalMs);

  writeLog('watchdog', `Watchdog enabled: every ${minutes} minute(s)`);
}

function debouncedDisplayReconfigure(reason) {
  if (!getSetting('restartOnDisplayChange', true)) return;

  if (displayChangeDebounce) {
    clearTimeout(displayChangeDebounce);
  }

  displayChangeDebounce = setTimeout(() => {
    writeLog('display', `Display topology changed, rebuilding screens (${reason})`);
    startConfiguredScreens();
  }, 2000);
}

function registerRecoveryHooks() {
  if (recoveryHooksRegistered) return;

  recoveryHooksRegistered = true;

  screen.on('display-added', () => debouncedDisplayReconfigure('display-added'));
  screen.on('display-removed', () => debouncedDisplayReconfigure('display-removed'));
  screen.on('display-metrics-changed', () => debouncedDisplayReconfigure('display-metrics-changed'));

  powerMonitor.on('resume', () => {
    if (!getSetting('restartOnResume', true)) return;
    writeLog('power', 'System resumed from sleep, restarting playlists');
    startConfiguredScreens();
  });
}

ipcMain.handle('get-config', async () => configCache);

ipcMain.handle('get-state', async () => getAdminState());
ipcMain.handle('check-for-updates', async () => checkForUpdatesManual());
ipcMain.handle('install-downloaded-update', async () => installDownloadedUpdate());

ipcMain.handle('get-detected-displays', async () => getDetectedDisplays());

ipcMain.handle('capture-screen-snapshot', async (_, screenId) => {
  return await captureScreenSnapshot(screenId);
});

ipcMain.handle('open-config-folder', async () => {
  ensureDir(USER_DATA);
  await shell.openPath(USER_DATA);
  return { ok: true, path: USER_DATA };
});

ipcMain.handle('create-config-backup', async () => {
  try {
    const backupPath = createConfigBackup('manual');
    return { ok: true, path: backupPath };
  } catch (err) {
    writeLog('backup', `Manual backup failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('export-config', async () => {
  try {
    ensureDir(USER_DATA);

    const result = await dialog.showSaveDialog(adminWindow || undefined, {
      title: 'Export BoardRunner Config',
      defaultPath: `BoardRunner-config-export-${getTimestampForFileName()}.json`,
      filters: [
        { name: 'JSON Config', extensions: ['json'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, cancelled: true };
    }

    const exportConfig = configCache || readConfigFile();
    fs.writeFileSync(result.filePath, JSON.stringify(exportConfig, null, 2), 'utf8');

    writeLog('config', `Config exported to ${result.filePath}`);
    return { ok: true, path: result.filePath };
  } catch (err) {
    writeLog('config', `Export failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('import-config', async () => {
  try {
    const result = await dialog.showOpenDialog(adminWindow || undefined, {
      title: 'Import BoardRunner Config',
      properties: ['openFile'],
      filters: [
        { name: 'JSON Config', extensions: ['json'] }
      ]
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, cancelled: true };
    }

    const importPath = result.filePaths[0];
    const raw = fs.readFileSync(importPath, 'utf8');
    const importedConfig = mergeConfigWithDefaults(JSON.parse(raw));

    validateConfig(importedConfig);

    createConfigBackup('pre-import');
    writeUserConfig(importedConfig);

    configCache = importedConfig;
    applyStartupSetting();
    setupWatchdog();
    startConfiguredScreens();
    applyKioskModeToAllWindows();
    refreshTrayMenu();
    notifyAdminState();

    writeLog('config', `Config imported from ${importPath}`);

    return {
      ok: true,
      path: importPath,
      config: configCache
    };
  } catch (err) {
    writeLog('config', `Import failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
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

ipcMain.handle('reload-screens', async () => {
  startConfiguredScreens();
  return { ok: true };
});

ipcMain.handle('toggle-rotation', async () => {
  rotationPaused = !rotationPaused;

  if (!rotationPaused) {
    restartAllPlaylists();
  }

  notifyAdminState();
  refreshTrayMenu();

  return { ok: true, rotationPaused };
});

ipcMain.handle('identify-displays', async () => {
  identifyDisplays();
  return { ok: true };
});

ipcMain.handle('open-log-folder', async () => {
  ensureDir(LOG_DIR);
  await shell.openPath(LOG_DIR);

  return { ok: true };
});

ipcMain.handle('show-admin', async () => {
  showAdminWindow();
  return { ok: true };
});

ipcMain.handle('preview-dashboard', async (_, dashboard) => {
  try {
    const result = await previewDashboard(dashboard);
    return result || { ok: true };
  } catch (err) {
    writeLog('preview', `Preview failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update-preview-view', async (_, dashboard) => {
  try {
    if (!previewWindow || previewWindow.isDestroyed()) {
      return { ok: false, error: 'Preview window is not open' };
    }
    dashboard.url = sanitizeDashboardUrl(dashboard.url);
    const viewState = await applyDashboardView(previewWindow.webContents, dashboard, 'preview-live');
    previewWindow.setTitle(`${APP_NAME} Offset Studio - ${dashboard.name || 'Dashboard'} (${viewState.scrollOffsetPx}px offset)`);
    return { ok: true, previewDiagnostics: { scrollResult: viewState.scrollResult || null, pageMetrics: viewState.pageMetrics || null, zoomFactor: viewState.zoomFactor, scrollOffsetPx: viewState.scrollOffsetPx } };
  } catch (err) {
    writeLog('preview', `Live preview update failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'Translate,BackForwardCache');

app.whenReady().then(() => {
  try {
    ensureDir(LOG_DIR);
    loadConfig();
    createTray();
    createAdminWindow();
    setupWatchdog();
    setupAutoUpdateScheduler();
    registerRecoveryHooks();
    startConfiguredScreens();

    if (!getSetting('trayOnlyStartup', true)) {
      showAdminWindow();
    }

    writeLog('system', `Application started. Writable config path: ${USER_CONFIG_PATH}`);
  } catch (err) {
    dialog.showErrorBox(APP_NAME, err.message);
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;

  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});