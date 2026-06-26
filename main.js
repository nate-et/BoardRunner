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

const USER_DATA = app.getPath('userData');
const BUNDLED_CONFIG_PATH = path.join(__dirname, 'config.json');
const USER_CONFIG_PATH = path.join(USER_DATA, 'config.json');
const LOG_DIR = path.join(USER_DATA, 'logs');
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray.png');

let tray = null;
let adminWindow = null;
let previewWindow = null;
let configCache = null;
let rotationPaused = false;
let displayWindows = new Map();
let runtimeState = new Map();
let identifyWindows = [];
let quitting = false;

let watchdogInterval = null;
let displayChangeDebounce = null;
let recoveryHooksRegistered = false;

// dashboardId -> { failures: number, cooldownUntil: number|null }
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
      restartOnDisplayChange: true
    },
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

  // If a writable user config already exists, always use that
  if (fs.existsSync(USER_CONFIG_PATH)) {
    const raw = fs.readFileSync(USER_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  }

  // Otherwise seed from bundled config if present
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

    if (!db.screenId || !screenIds.has(db.screenId)) {
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
}

function mergeConfigWithDefaults(config) {
  const defaults = defaultConfig();

  return {
    settings: {
      ...defaults.settings,
      ...(config.settings || {})
    },
    screens: Array.isArray(config.screens) ? config.screens : defaults.screens,
    dashboards: Array.isArray(config.dashboards) ? config.dashboards : defaults.dashboards
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

function saveConfig(config) {
  const merged = mergeConfigWithDefaults(config);
  validateConfig(merged);

  writeUserConfig(merged);

  configCache = merged;
  applyStartupSetting();
  setupWatchdog();
  writeLog('config', `Config saved to ${USER_CONFIG_PATH}`);
}

function persistCurrentConfig() {
  if (!configCache) return;
  writeUserConfig(configCache);
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
    backgroundColor: '#000000',
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
      cooldownUntil: null
    });
  }
  return dashboardHealth.get(dashboardId);
}

function isDashboardCoolingDown(dashboardId) {
  const info = getDashboardHealth(dashboardId);
  return !!(info.cooldownUntil && info.cooldownUntil > Date.now());
}

function noteDashboardSuccess(dashboardId) {
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
  return configCache.dashboards
    .filter((d) => d.enabled !== false && d.screenId === screenId)
    .filter((d) => !isDashboardCoolingDown(d.id))
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
    backgroundColor: '#000000',
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


async function applyDashboardView(wc, dashboard, logPrefix) {
  const zoomFactor = Number(dashboard.zoomFactor || 1);
  const scrollOffsetPx = Number(dashboard.scrollOffsetPx || 0);

  await wc.setZoomFactor(zoomFactor);

  if (scrollOffsetPx > 0) {
    try {
      const result = await wc.executeJavaScript(`
        (() => {
          const requestedOffset = ${scrollOffsetPx};

          function isScrollable(el) {
            if (!el) return false;

            const style = window.getComputedStyle(el);
            const overflowY = style.overflowY;

            const canScroll =
              (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
              el.scrollHeight > el.clientHeight + 5;

            return canScroll;
          }

          function getScrollableCandidates() {
            const candidates = [
              document.scrollingElement,
              document.documentElement,
              document.body
            ].filter(Boolean);

            const all = Array.from(document.querySelectorAll('*'));

            for (const el of all) {
              if (isScrollable(el)) {
                candidates.push(el);
              }
            }

            return candidates;
          }

          function getBestScrollableElement() {
            const candidates = getScrollableCandidates();

            let best = null;
            let bestScrollableDistance = 0;

            for (const el of candidates) {
              const scrollableDistance = Math.max(0, el.scrollHeight - el.clientHeight);

              if (scrollableDistance > bestScrollableDistance) {
                best = el;
                bestScrollableDistance = scrollableDistance;
              }
            }

            return best || document.scrollingElement || document.documentElement || document.body;
          }

          function applyScroll() {
            const target = getBestScrollableElement();

            if (!target) {
              return {
                applied: false,
                requestedOffset,
                appliedOffset: 0,
                maxOffset: 0,
                target: 'none'
              };
            }

            const maxOffset = Math.max(0, target.scrollHeight - target.clientHeight);
            const appliedOffset = Math.min(requestedOffset, maxOffset);

            target.scrollTop = appliedOffset;

            if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
              window.scrollTo(0, appliedOffset);
              document.documentElement.scrollTop = appliedOffset;
              document.body.scrollTop = appliedOffset;
            }

            return {
              applied: true,
              requestedOffset,
              appliedOffset,
              maxOffset,
              target:
                target === document.scrollingElement ? 'document.scrollingElement' :
                target === document.documentElement ? 'document.documentElement' :
                target === document.body ? 'document.body' :
                target.tagName.toLowerCase() + (target.id ? '#' + target.id : '') + (target.className ? '.' + String(target.className).replace(/\\s+/g, '.') : '')
            };
          }

          const first = applyScroll();

          setTimeout(applyScroll, 250);
          setTimeout(applyScroll, 750);
          setTimeout(applyScroll, 1500);
          setTimeout(applyScroll, 3000);

          return first;
        })();
      `, true);

      writeLog(
        logPrefix,
        `Applied scroll offset. requested=${result.requestedOffset}px applied=${result.appliedOffset}px max=${result.maxOffset}px target=${result.target}`
      );
    } catch (scrollErr) {
      writeLog(logPrefix, `Failed to apply scroll offset: ${scrollErr.message}`);
    }
  }

  return {
    zoomFactor,
    scrollOffsetPx
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

  writeLog(screenId, `Loading: ${current.name} | ${current.url}`);

  const onDidFinishLoad = async () => {
    try {
      if (state.loadFailTimer) {
        clearTimeout(state.loadFailTimer);
      }

      wc.removeListener('did-fail-load', onDidFailLoad);

      const viewState = await applyDashboardView(wc, current, screenId);
      noteDashboardSuccess(current.id);

      writeLog(
        screenId,
        `Loaded OK: ${current.name} | zoom=${viewState.zoomFactor} | scrollOffset=${viewState.scrollOffsetPx}px | visibleFor=${durationMs + settleMs}ms`
      );

      scheduleNext(screenId, durationMs + settleMs);
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
    await win.loadURL(current.url);
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
        writeLog('preview', `Preview loaded: ${dashboard.name || dashboard.url}`);
        finish({ ok: true });
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
      currentUrl: current ? current.url : ''
    };
  });

  return {
    rotationPaused,
    startupEnabled: getStartupStatus(),
    settings: configCache.settings,
    screens: configCache.screens,
    dashboards: configCache.dashboards,
    detectedDisplays: getDetectedDisplays(),
    runtimeScreens
  };
}

function notifyAdminState() {
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.webContents.send('app-state', getAdminState());
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

/* IPC */

ipcMain.handle('get-config', async () => configCache);

ipcMain.handle('get-state', async () => getAdminState());

ipcMain.handle('get-detected-displays', async () => getDetectedDisplays());

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
  reloadCurrentScreens();
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
    await previewDashboard(dashboard);
    return { ok: true };
  } catch (err) {
    writeLog('preview', `Preview failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

/* Electron startup */

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'Translate,BackForwardCache');

app.whenReady().then(() => {
  try {
    ensureDir(LOG_DIR);
    loadConfig();
    createTray();
    createAdminWindow();
    setupWatchdog();
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