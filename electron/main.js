const { app, BrowserWindow, Menu, Tray, clipboard, nativeImage, nativeTheme, shell, globalShortcut, ipcMain, dialog, net, protocol, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const isDev = process.env.NODE_ENV === 'development';
const { createMcpLocalServer } = require('./mcpLocalServer');
// Network stack selection for main process outbound requests: npm undici@8 ProxyAgent (getFetchDispatcher)
// is incompatible with the handler protocol of Node's built-in fetch. Mixing them throws before dialing:
// UND_ERR_INVALID_ARG: invalid onRequestStart method. Invocations carrying a dispatcher must use the matching
// version of undiciFetch. Most targets work with built-in fetch when no proxy is needed, and x.com edge WAF
// allows built-in undici based on TLS fingerprint while returning 403 for npm undici@8 (see details in X handlers).
const { fetch: undiciFetch, ProxyAgent } = require('undici');
const { summarizeFetchError, fetchAcrossStacks, timeoutSignalFromBudget, followRedirectsManually, toFailureResult } = require('./mainFetch');
// Diagnostics tap wrapper: side-effect free logging (passes arguments, responses, and errors through as-is, see netTap.js).
// The Chromium stack (net.fetch) is covered at zero call sites via session.webRequest observer
// (per Electron documentation: net.fetch triggers webRequest handlers by default), avoiding double wrapping.
// All new identifiers contain uppercase Fetch, and `fetch.bind(` does not match the outboundFetchGate
// bare-call regex (which also requires the destructuring line below to be preserved byte-for-byte).
const diagTap = require('./netTap');
const { createDiagLogger } = require('./diagLogger');
const { buildSystemInfo } = require('./systemInfo');
const redact = require('./redact');
const { setNetworkRecorder } = require('./plugins/webSearch');
let diagDebug = false;
const diagLog = createDiagLogger({
  logsDir: path.join(app.getPath('userData'), 'logs', 'diagnostics'),
  // Relax disk budget in debug mode: 20MB/day, 40MB total (normal mode: 5MB/day, 20MB)
  maxFileBytes: () => (diagDebug ? 20 * 1024 * 1024 : 5 * 1024 * 1024),
  maxTotalBytes: () => (diagDebug ? 40 * 1024 * 1024 : 20 * 1024 * 1024),
  maxFiles: 7,
});
const undiciFetchTapped = diagTap.wrapFetch(undiciFetch, {
  source: 'main:undici',
  record: (entry) => diagLog.record(entry),
  isDebugMode: () => diagDebug,
});
const builtinFetchTapped = diagTap.wrapFetch(fetch.bind(globalThis), {
  source: 'main:node-fetch',
  record: (entry) => diagLog.record(entry),
  isDebugMode: () => diagDebug,
});
const { createPluginManager } = require('./plugins/pluginManager');
const { createPluginMarketplace } = require('./plugins/pluginMarketplace');
const { downloadReleaseAsset } = require('./plugins/releaseDownload');
const { loadPluginRegistry } = require('./plugins/pluginRegistryFeed');
const { PAGE_SCHEME, pageCsp } = require('./plugins/pluginPage');
const {
  DEFAULT_DESKTOP_PREFS,
  normalizeDesktopPrefs,
  loadDesktopPrefs,
  saveDesktopPrefs,
  getLinuxAutostartPath,
  buildLinuxDesktopEntry,
} = require('./desktopPrefs');
const {
  saveEncryptedXAuth,
  loadEncryptedXAuth,
  clearEncryptedXAuth,
} = require('./xAuthStorage');

let mainWindow;
let tray = null;
// True only when the user explicitly quits (tray menu / Cmd+Q / before-quit).
// Distinguishes "hide to tray" from "really exit" for close-to-tray (#345).
let isQuitting = false;
// In-memory desktop prefs (#345). Source of truth on disk:
// `<userData>/desktop-prefs.json`. Defaults: autoLaunch OFF, tray ON.
let desktopPrefs = { ...DEFAULT_DESKTOP_PREFS };

// ── Process-level diagnostics (previously invisible crash evidence) ──
// Recording must never itself throw: every handler is guarded, and a failure
// inside diagLog degrades to its in-memory ring.
process.on('uncaughtException', (error) => {
  try {
    diagLog.record({
      level: 'error',
      module: 'electron.process',
      message: 'uncaughtException',
      data: redact.sanitizeError(error),
    });
  } catch { /* swallow — diagnostics must not crash the crash handler */ }
});
process.on('unhandledRejection', (reason) => {
  try {
    diagLog.record({
      level: 'error',
      module: 'electron.process',
      message: 'unhandledRejection',
      data: redact.sanitizeError(reason),
    });
  } catch { /* swallow */ }
});
app.on('render-process-gone', (_event, details) => {
  try {
    diagLog.record({
      level: 'error',
      module: 'electron.app',
      message: `Render process gone: ${details?.reason ?? 'unknown'}`,
      data: { reason: details?.reason, exitCode: details?.exitCode, details: redact.sanitizeForLog(details) },
    });
  } catch { /* swallow */ }
});
app.on('child-process-gone', (_event, details) => {
  try {
    diagLog.record({
      level: 'error',
      module: 'electron.app',
      message: `Child process gone: ${details?.type ?? 'unknown'} ${details?.reason ?? ''}`,
      data: { type: details?.type, reason: details?.reason, exitCode: details?.exitCode },
    });
  } catch { /* swallow */ }
});

// `--hidden` is appended to our own Linux autostart entry so login starts in tray.
const startHidden = process.argv.includes('--hidden');

// ── Single instance (#345): a second launch restores the existing window
// instead of spawning a duplicate tray icon.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

protocol.registerSchemesAsPrivileged([{ scheme: PAGE_SCHEME, privileges: { standard: true, secure: true } }]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      enableRemoteModule: false,
      // Production: keep same-origin + block mixed content. Local files load via loadFile.
      // Dev may relax for Vite HMR / local services if needed later — keep secure by default.
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Keep DevTools enabled in production as well (accessible via menu toggleDevTools role)
      devTools: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../build/icon.png'),
    titleBarStyle: 'default', // Use default title bar to avoid overlap issues
    show: false,
    // Windows/Linux hides the native top menu bar (Edit/View/Window), press Alt to reveal temporarily.
    // Application menus are still installed via Menu.setApplicationMenu, so role shortcuts (Ctrl+C/V, Ctrl+Shift+I, etc.) remain active.
    // macOS top menu is system-wide and persistent, so keep it visible.
    autoHideMenuBar: process.platform === 'darwin' ? false : true,
    frame: true, // Preserve window frame
    backgroundColor: '#ffffff', // Set background color to prevent white-screen flicker
    titleBarOverlay: false, // Disable title bar overlay
    trafficLightPosition: { x: 20, y: 20 } // macOS traffic light buttons position
  });

  // Error handling and loading events (fallback attempted only once to prevent did-fail-load loop)
  let fallbackAttempted = false;
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('Failed to load:', errorCode, errorDescription, validatedURL);
    const fallbackPath = path.join(__dirname, '../dist/index.html');
    const alreadyOnFallback =
      typeof validatedURL === 'string' &&
      (validatedURL.includes('/dist/index.html') || validatedURL.endsWith('dist/index.html'));
    if (!fallbackAttempted && !alreadyOnFallback && fs.existsSync(fallbackPath)) {
      fallbackAttempted = true;
      console.log('Loading fallback page:', fallbackPath);
      mainWindow.loadFile(fallbackPath);
    }
  });

  mainWindow.webContents.on('dom-ready', () => {
    if (isDev) console.log('DOM ready');
    // Inject basic styles to prevent white flash
    mainWindow.webContents.insertCSS('body { background-color: #ffffff; }');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (isDev) console.log('Page finished loading');
    // Show window once page loading finishes (avoids flashing when auto-starting hidden to tray via --hidden)
    if (!startHidden && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });

  // Renderer console errors that escaped every try/catch: record a capped
  // sample (unique-error storms bypass repeat aggregation, so a token bucket
  // here is the hard bound). Handles both the legacy (event, level, message)
  // and the details-object event shapes across Electron versions.
  let rendererConsoleErrorBudget = { windowStart: 0, used: 0 };
  mainWindow.webContents.on('console-message', (...args) => {
    try {
      const first = args[1];
      const level = first && typeof first === 'object' ? first.level : args[1];
      const message = first && typeof first === 'object' ? first.message : args[2];
      const isError = level === 3 || level === 'error';
      if (!isError) return;
      const nowMs = Date.now();
      if (nowMs - rendererConsoleErrorBudget.windowStart >= 60_000) {
        rendererConsoleErrorBudget.windowStart = nowMs;
        rendererConsoleErrorBudget.used = 0;
      }
      if (rendererConsoleErrorBudget.used >= 30) return;
      rendererConsoleErrorBudget.used += 1;
      const details = first && typeof first === 'object' ? first : {};
      // Stacks are NOT available here: Electron 44's console-message details
      // only carry message/level/lineNumber/sourceId/frame. Uncaught renderer
      // errors get their (sanitized) stacks from the renderer-side
      // ui.global entries (globalErrorHandlers, installed before any app
      // code) forwarded over diagnosticsBridge IPC; this handler is only the
      // last-resort backstop for errors that escape that path.
      const data = {};
      if (details.sourceId || details.lineNumber) {
        data.sourceId = details.sourceId;
        data.lineNumber = details.lineNumber;
      }
      diagLog.record({
        level: 'error',
        module: 'electron.renderer-console',
        message: String(message ?? '').slice(0, 2000),
        ...(Object.keys(data).length > 0 ? { data } : {}),
      });
    } catch { /* never break the window */ }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // Production environment: try multiple potential paths
    const possiblePaths = [
      path.join(__dirname, '../dist/index.html'),
      path.join(process.resourcesPath, 'app.asar/dist/index.html'),
      path.join(process.resourcesPath, 'app/dist/index.html'),
      path.join(process.resourcesPath, 'dist/index.html'),
      path.join(__dirname, '../build/index.html')
    ];

    let indexPath = null;
    for (const testPath of possiblePaths) {
      try {
        if (fs.existsSync(testPath)) {
          indexPath = testPath;
          break;
        }
      } catch (error) {
        // Ignore filesystem errors and continue to the next path
        continue;
      }
    }

    if (indexPath) {
      console.log('Loading application from:', indexPath);
      mainWindow.loadFile(indexPath).catch(error => {
        console.error('Failed to load file:', error);
        // Show error page on load failure
        mainWindow.loadURL('data:text/html,<h1>Application Load Error</h1><p>Could not load the main application. Please restart the app.</p>');
      });
    } else {
      console.error('Could not find index.html in any expected location');
      console.log('Checked paths:', possiblePaths);
      console.log('Current directory:', __dirname);
      console.log('Process resources path:', process.resourcesPath);
      // Display detailed error message
      const errorHtml = '<h1>Application Not Found</h1><p>Could not locate the application files.</p><p>Please reinstall the application.</p>';
      mainWindow.loadURL('data:text/html,' + encodeURIComponent(errorHtml));
    }
  }

  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow.show();
  });

  // Provide stable menu and editing shortcuts (production environment)
  const menuTemplate = process.platform === 'darwin' ? [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    }
  ] : [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    if (!event.url.startsWith(`${PAGE_SCHEME}://`)) {
      event.preventDefault();
      return;
    }
    const current = event.frame?.url;
    if (current?.startsWith(`${PAGE_SCHEME}://`)) {
      const previousPage = new URL(current);
      const nextPage = new URL(event.url);
      if (previousPage.hostname !== nextPage.hostname ||
        previousPage.pathname.split('/')[1] !== nextPage.pathname.split('/')[1]) event.preventDefault();
    }
  });

  mainWindow.on('close', (event) => {
    // #345: Close minimizes to tray by default (configurable in Settings > General). True quit only occurs via isQuitting.
    if (!isQuitting && desktopPrefs.closeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('minimize', (event) => {
    // #345: Minimize hides to tray by default.
    if (desktopPrefs.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const PROXY_CONFIG_PATH = path.join(app.getPath('userData'), 'proxy-config.json');

function loadProxyConfig() {
  try {
    if (fs.existsSync(PROXY_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(PROXY_CONFIG_PATH, 'utf-8'));
    }
  } catch (e) { console.error('Failed to load proxy config:', e); }
  return { enabled: false, type: 'http', host: '', port: 7890 };
}

function saveProxyConfig(config) {
  fs.writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function applyProxy(config) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (config.enabled && config.host && config.port) {
    let auth = '';
    if (config.username) {
      auth = config.password
        ? encodeURIComponent(config.username) + ':' + encodeURIComponent(config.password) + '@'
        : encodeURIComponent(config.username) + '@';
    }
    const proxyUrl = config.type === 'socks5'
      ? 'socks5://' + auth + config.host + ':' + config.port
      : 'http://' + auth + config.host + ':' + config.port;
    await mainWindow.webContents.session.setProxy({
      proxyRules: proxyUrl,
      proxyBypassRules: '<local>;localhost;127.0.0.1'
    });
    // Never log credentials embedded in proxy URLs
    const redactedProxyUrl = proxyUrl.replace(/\/\/[^@/]+@/, '//***:***@');
    console.log('[Proxy] Applied:', redactedProxyUrl);
  } else {
    await mainWindow.webContents.session.setProxy({ mode: 'system' });
    console.log('[Proxy] Disabled, using system proxy settings');
  }
}

function getFetchDispatcher() {
  const config = loadProxyConfig();
  if (config.enabled && config.host && config.port) {
    let auth = '';
    if (config.username) {
      auth = config.password
        ? encodeURIComponent(config.username) + ':' + encodeURIComponent(config.password) + '@'
        : encodeURIComponent(config.username) + '@';
    }
    const proxyUrl = config.type === 'socks5'
      ? 'socks5://' + auth + config.host + ':' + config.port
      : 'http://' + auth + config.host + ':' + config.port;
    try {
      return new ProxyAgent(proxyUrl);
    } catch (err) {
      throw new Error(`Failed to initialize configured proxy agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (envProxy) {
    try {
      return new ProxyAgent(envProxy);
    } catch (err) {
      throw new Error(`Failed to initialize environment proxy agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return undefined;
}

// X tweet channel: main process fetches unauthenticated x.com home page
ipcMain.handle('x-fetch-timeline', async (_event, handle) => {
  if (typeof handle !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    return { success: false, error: 'invalid handle' };
  }
  try {
    const timelineUrl = `https://x.com/${handle}`;
    const timelineHeaders = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    const { response } = await fetchAcrossStacks([
      // Preferred Node stack: when no app proxy is set, use built-in fetch — x.com edge WAF
      // allows built-in undici based on TLS fingerprinting (viable since #356) but returns
      // 403 HTML challenge pages for npm undici@8 (verified empirically); when an app proxy
      // is configured, built-in fetch cannot take undici@8's ProxyAgent (incompatible handler
      // protocol), so we must use the matching version of undici fetch.
      {
        name: 'undici',
        run: async ({ remainingMs }) => {
          const dispatcher = getFetchDispatcher();
          const fetchImpl = dispatcher ? undiciFetchTapped : builtinFetchTapped;
          return fetchImpl(timelineUrl, {
            headers: timelineHeaders,
            signal: timeoutSignalFromBudget(remainingMs, 20_000),
            ...(dispatcher ? { dispatcher } : {}),
          });
        },
        // When edge returns 403/429 based on fingerprinting, consider this stack a miss and fall back to Chromium stack
        onResponseRetryable: (response) => response.status === 403 || response.status === 429,
      },
      // Fallback Chromium stack: follows session proxy (including "system proxy") and uses system certificate trust store
      {
        name: 'chromium',
        run: ({ remainingMs }) => net.fetch(timelineUrl, {
          headers: timelineHeaders,
          signal: timeoutSignalFromBudget(remainingMs, 20_000),
        }),
      },
    ], { totalTimeoutMs: 20_000 });
    if (!response.ok) {
      return { success: false, error: `x.com responded ${response.status}` };
    }
    const html = await response.text();
    return { success: true, html };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Telegram channel: main process fetches public t.me/s/<name> web preview (renderer process is restricted by CORS;
// net.fetch uses Chromium's network stack and automatically follows proxies configured in the app)
ipcMain.handle('telegram-fetch-channel', async (_event, channel, before) => {
  if (typeof channel !== 'string' || !/^[A-Za-z0-9_]{3,64}$/.test(channel)) {
    return { success: false, error: 'invalid channel' };
  }
  if (before !== undefined && before !== null && before !== '' &&
      (typeof before !== 'string' || !/^\d{1,20}$/.test(before))) {
    return { success: false, error: 'invalid before cursor' };
  }
  try {
    const suffix = before ? `?before=${before}` : '';
    const telegramUrl = `https://t.me/s/${channel}${suffix}`;
    const telegramHeaders = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    const { response } = await fetchAcrossStacks([
      // Preferred Chromium stack: follows session proxy (including in-app proxy and "system proxy" mode)
      {
        name: 'chromium',
        run: ({ remainingMs }) => net.fetch(telegramUrl, {
          headers: telegramHeaders,
          signal: timeoutSignalFromBudget(remainingMs, 20_000),
        }),
      },
      // Fallback undici: follows in-app proxy / environment variable proxy (fallback when Chromium stack is unavailable)
      {
        name: 'undici',
        run: async ({ remainingMs }) => {
          const dispatcher = getFetchDispatcher();
          return undiciFetchTapped(telegramUrl, {
            headers: telegramHeaders,
            signal: timeoutSignalFromBudget(remainingMs, 20_000),
            ...(dispatcher ? { dispatcher } : {}),
          });
        },
      },
    ], { totalTimeoutMs: 20_000 });
    if (!response.ok) {
      return { success: false, error: `t.me responded ${response.status}` };
    }
    const html = await response.text();
    return { success: true, html };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// WebDAV: main process proxies DAV requests.
// Renderer has webSecurity enabled, and desktop runs from file:// origin without a backend,
// so direct browser connections get blocked by WebDAV server CORS policies (PROPFIND/MKCOL/PUT, etc.).
// Preferred: Node-based fetch via undici, follows in-app proxy / environment proxy; on network-level failure, fall back
// to Chromium stack (net.fetch), which respects session proxy (including "system proxy") and uses the system
// certificate store — enabling success in many scenarios where undici direct fails (system proxy/VPN only
// applied to Chromium, enterprise root cert installed in OS keychain, self-signed cert trusted by OS, etc.).
// Host has no allowlist: WebDAV is commonly hosted on user-owned cloud drives or local LAN NAS.
const WEBDAV_ALLOWED_METHODS = new Set([
  'GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'OPTIONS',
  'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK',
]);
ipcMain.handle('webdav-request', async (_event, params) => {
  const { url, method, headers, body, timeoutMs } = params ?? {};
  if (typeof url !== 'string') {
    return { success: false, error: 'invalid url' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { success: false, error: 'invalid url' };
  }
  // Allow http(s) only: prevent local protocols like file:/data: from being read by main process
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { success: false, error: 'unsupported protocol' };
  }
  const upperMethod = typeof method === 'string' ? method.toUpperCase() : '';
  if (!WEBDAV_ALLOWED_METHODS.has(upperMethod)) {
    return { success: false, error: 'invalid method' };
  }
  // Header values must be non-CRLF strings to prevent header injection
  const safeHeaders = {};
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string' || /[\r\n]/.test(key) || /[\r\n]/.test(value)) continue;
      safeHeaders[key] = value;
    }
  }
  // Match frontend maximum timeout (WebDAV upload up to 300s); multiple stacks share this budget
  const timeout = Number.isFinite(timeoutMs)
    ? Math.min(Math.max(Math.trunc(timeoutMs), 1000), 300000)
    : 60000;
  // GET/HEAD with body is rejected by undici (and disallowed by Chromium stack)
  const hasBody = !!body && upperMethod !== 'GET' && upperMethod !== 'HEAD';
  const stacks = [
    {
      name: 'undici',
      run: async ({ remainingMs }) => {
        const dispatcher = getFetchDispatcher();
        return undiciFetchTapped(parsed.toString(), {
          method: upperMethod,
          headers: safeHeaders,
          ...(hasBody ? { body } : {}),
          signal: timeoutSignalFromBudget(remainingMs, timeout),
          ...(dispatcher ? { dispatcher } : {}),
        });
      },
    },
    // net.fetch automatic redirect still forwards Authorization on cross-origin redirects (verified on Electron 44);
    // DAV requests with Basic credentials must follow redirects manually, stripping credentials on cross-origin.
    {
      name: 'chromium',
      run: ({ remainingMs }) => followRedirectsManually(net.fetch, parsed.toString(), {
        method: upperMethod,
        headers: safeHeaders,
        ...(hasBody ? { body } : {}),
        signal: timeoutSignalFromBudget(remainingMs, timeout),
      }),
    },
  ];
  // LOCK/POST are non-idempotent: replaying across stacks on network failure may cause duplicate locks/submissions, so use single stack
  const eligibleStacks = upperMethod === 'LOCK' || upperMethod === 'POST'
    ? stacks.slice(0, 1)
    : stacks;
  try {
    const { response } = await fetchAcrossStacks(eligibleStacks, { totalTimeoutMs: timeout });
    const text = await response.text();
    return {
      success: true,
      status: response.status,
      statusText: response.statusText,
      body: text,
      contentType: response.headers.get('content-type') ?? undefined,
    };
  } catch (error) {
    // Normalize timeout and structured cause for renderer to map to actionable recovery hints
    return toFailureResult(error);
  }
});

// X tweet channel authenticated flow: main process proxies x.com GraphQL / static asset GET requests
// (with user's auth_token/ct0 cookies; uses Node fetch to retain TLS fingerprint and bypass Chromium custom header restrictions)
// Only URLs corresponding to controlled operations are allowed (caller cannot request arbitrary x.com paths):
// - Authenticated home page (queryId extraction entrypoint)
// - abs.twimg.com main bundle script (queryId extraction source, never includes X cookies)
// - GraphQL UserTweets / UserByScreenName (dynamic queryId, fixed operation name)
// Guest flow without login (auth is null): fallback used by renderer when auth is missing or authenticated requests
// hit edge 403 — x.com main site edge WAF blocks Node network stack with 403 HTML challenge pages based on TLS
// fingerprint, so guest GraphQL must use Chromium stack (net.fetch, empirically verified 200); guest token activation
// endpoint is on api.x.com without fingerprint blocking, so undici (following app proxy) is preferred.
// Guest cannot access authenticated home page, so queryId extraction entrypoint switches x.com/home to public landing page.
const X_HOME_URL = 'https://x.com/home';
const X_MAIN_JS_PATTERN = /^https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[a-zA-Z0-9_-]+\.js$/;
const X_GRAPHQL_API_PATTERN = /^https:\/\/x\.com\/i\/api\/graphql\/[A-Za-z0-9_-]+\/(UserTweets|UserByScreenName)(\?.*)?$/;
const isAllowedXProxyUrl = (url) =>
  url === X_HOME_URL || X_MAIN_JS_PATTERN.test(url) || X_GRAPHQL_API_PATTERN.test(url);
const X_COOKIE_VALUE_PATTERN = /^[\w%+/=.~-]+$/;
const X_BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// x.com public web client Bearer (public-by-design): distributed to all visitors via x.com frontend JS,
// public constant sent by browsers with every x.com request, not user credentials, no privileged access,
// generic GitGuardian high-entropy detection here is a false positive.
const X_BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const X_GUEST_ACTIVATE_URL = 'https://api.x.com/1.1/guest/activate.json';
/** In-process cache for guest token: activation endpoint is rate-limited, reused across requests; force refreshed on 403/401 */
let xGuestToken = null;

async function fetchXGuestToken() {
  const activateHeaders = {
    'User-Agent': X_BROWSER_UA,
    'Authorization': `Bearer ${X_BEARER_TOKEN}`,
  };
  const { response } = await fetchAcrossStacks([
    {
      name: 'undici',
      run: async ({ remainingMs }) => {
        const dispatcher = getFetchDispatcher();
        const fetchImpl = dispatcher ? undiciFetchTapped : builtinFetchTapped;
        return fetchImpl(X_GUEST_ACTIVATE_URL, {
          method: 'POST',
          headers: activateHeaders,
          signal: timeoutSignalFromBudget(remainingMs, 15_000),
          ...(dispatcher ? { dispatcher } : {}),
        });
      },
    },
    {
      name: 'chromium',
      run: ({ remainingMs }) => net.fetch(X_GUEST_ACTIVATE_URL, {
        method: 'POST',
        headers: activateHeaders,
        signal: timeoutSignalFromBudget(remainingMs, 15_000),
      }),
    },
  ], { totalTimeoutMs: 15_000 });
  if (!response.ok) {
    throw new Error(`x.com guest token activate failed (${response.status})`);
  }
  const payload = await response.json();
  if (typeof payload?.guest_token !== 'string' || !/^\d{6,}$/.test(payload.guest_token)) {
    throw new Error('x.com guest token activate returned invalid payload');
  }
  return payload.guest_token;
}

async function getXGuestToken(forceRefresh = false) {
  if (xGuestToken && !forceRefresh) return xGuestToken;
  xGuestToken = await fetchXGuestToken();
  return xGuestToken;
}

ipcMain.handle('x-fetch-graphql', async (_event, url, auth) => {
  if (typeof url !== 'string' || !isAllowedXProxyUrl(url)) {
    return { success: false, error: 'invalid url' };
  }
  const authToken = typeof auth?.authToken === 'string' ? auth.authToken.trim().replace(/^["']|["']$/g, '').trim() : '';
  const ct0 = typeof auth?.ct0 === 'string' ? auth.ct0.trim().replace(/^["']|["']$/g, '').trim() : '';
  const hasCookieAuth = !!(authToken && ct0 && X_COOKIE_VALUE_PATTERN.test(authToken) && X_COOKIE_VALUE_PATTERN.test(ct0));
  // Cookies explicitly provided but format is invalid: caller specified authenticated flow, reject directly rather than silently falling back to guest
  if (auth && !hasCookieAuth) {
    return { success: false, error: 'invalid auth cookies' };
  }
  try {
    if (hasCookieAuth) {
      // GraphQL API requests send proprietary headers such as Bearer/CSRF; sending these headers with HTML pages
      // and static assets actually causes x.com to reject with 401 (empirically verified), so only send UA + Cookie
      const isApiCall = url.startsWith('https://x.com/i/api/');
      const headers = isApiCall
        ? {
            'User-Agent': X_BROWSER_UA,
            'Accept': '*/*',
            'Authorization': `Bearer ${X_BEARER_TOKEN}`,
            'X-CSRF-Token': ct0,
            'X-Twitter-Auth-Type': 'OAuth2Session',
            'X-Twitter-Active-User': 'yes',
            'Cookie': `auth_token=${authToken}; ct0=${ct0}`,
          }
        : {
            'User-Agent': X_BROWSER_UA,
            'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
            ...(url.startsWith('https://x.com/') ? { 'Cookie': `auth_token=${authToken}; ct0=${ct0}` } : {}),
          };
      // redirect: 'error' — reject cross-origin (and all) redirects to prevent cookies from leaking beyond allowed domains
      const dispatcher = getFetchDispatcher();
      // Built-in fetch TLS fingerprint is accepted by x.com edge (viable since #356); npm undici@8
      // fingerprint receives a 403. Only use matching version of undici fetch when app proxy dispatcher
      // is needed (if edge still returns 403, renderer will automatically fall back to guest flow)
      const fetchImpl = dispatcher ? undiciFetchTapped : builtinFetchTapped;
      const response = await fetchImpl(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (typeof response.url === 'string' && response.url && !isAllowedXProxyUrl(response.url)) {
        return { success: false, error: 'redirect blocked' };
      }
      if (!response.ok) {
        return { success: false, error: `x.com responded ${response.status}` };
      }
      const body = await response.text();
      return { success: true, body };
    }

    // Unauthenticated guest flow: Chromium stack (net.fetch; Cookie is a forbidden request header
    // and cannot be explicitly sent via net.fetch, but guest flow does not require it anyway)
    const targetUrl = url === X_HOME_URL ? 'https://x.com/' : url;
    const isApiCall = targetUrl.startsWith('https://x.com/i/api/');
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = isApiCall
        ? {
            'User-Agent': X_BROWSER_UA,
            'Accept': '*/*',
            'Authorization': `Bearer ${X_BEARER_TOKEN}`,
            'x-guest-token': await getXGuestToken(attempt > 0),
            'X-Twitter-Active-User': 'yes',
          }
        : {
            'User-Agent': X_BROWSER_UA,
            'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          };
      const response = await net.fetch(targetUrl, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const body = await response.text();
        return { success: true, body };
      }
      // Guest token may have expired or been revoked: force refresh once and retry if API request returns 403/401
      if (isApiCall && (response.status === 403 || response.status === 401) && attempt === 0) {
        continue;
      }
      return { success: false, error: `x.com responded ${response.status}` };
    }
    return { success: false, error: 'x.com responded 403' };
  } catch (error) {
    // Undici network errors are uniformly "fetch failed"; the actual reason is in the cause chain
    return { success: false, error: summarizeFetchError(error).message };
  }
});

ipcMain.handle('x-auth:save', async (_event, auth) => {
  if (auth === null || auth === undefined) {
    console.log('[x-auth:save] clearing (null payload)');
    return saveEncryptedXAuth({ fs, pathModule: path, userDataPath: app.getPath('userData'), safeStorage }, null);
  }
  if (typeof auth !== 'object' || Array.isArray(auth)) {
    console.warn('[x-auth:save] rejected: invalid auth payload type');
    return { success: false, error: 'invalid auth payload' };
  }
  const authToken = typeof auth.authToken === 'string' ? auth.authToken.trim().replace(/^["']|["']$/g, '').trim() : '';
  const ct0 = typeof auth.ct0 === 'string' ? auth.ct0.trim().replace(/^["']|["']$/g, '').trim() : '';
  if (!authToken && !ct0) {
    console.log('[x-auth:save] clearing (empty tokens)');
    return saveEncryptedXAuth({ fs, pathModule: path, userDataPath: app.getPath('userData'), safeStorage }, null);
  }
  if (
    !authToken ||
    !ct0 ||
    authToken.length > 512 ||
    ct0.length > 512 ||
    !X_COOKIE_VALUE_PATTERN.test(authToken) ||
    !X_COOKIE_VALUE_PATTERN.test(ct0)
  ) {
    console.warn('[x-auth:save] rejected: invalid auth cookies', { authTokenLen: authToken.length, ct0Len: ct0.length });
    return { success: false, error: 'invalid auth cookies' };
  }
  const result = saveEncryptedXAuth({ fs, pathModule: path, userDataPath: app.getPath('userData'), safeStorage }, { authToken, ct0 });
  console.log('[x-auth:save] result:', result.success ? 'OK' : `FAIL: ${result.error}`);
  return result;
});

ipcMain.handle('x-auth:get', async () => {
  const result = loadEncryptedXAuth({ fs, pathModule: path, userDataPath: app.getPath('userData'), safeStorage });
  console.log('[x-auth:get] result:', result ? 'found credentials' : 'no credentials on disk');
  return result;
});

ipcMain.handle('x-auth:clear', async () => {
  const result = clearEncryptedXAuth({ fs, pathModule: path, userDataPath: app.getPath('userData') });
  console.log('[x-auth:clear] result:', result.success ? 'OK' : `FAIL: ${result.error}`);
  return result;
});

ipcMain.handle('set-proxy', async (event, config) => {
  saveProxyConfig(config);
  await applyProxy(config);
  return { success: true };
});

ipcMain.handle('get-proxy', () => {
  return loadProxyConfig();
});

ipcMain.handle('test-proxy', async (event, config) => {
  const net = require('net');
  const connectToProxy = () => new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.on('connect', () => resolve(socket));
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Connection timeout')); });
    socket.on('error', (err) => reject(err));
    socket.connect(config.port, config.host);
  });
  try {
    if (config.type === 'socks5') {
      const socket = await connectToProxy();
      return await new Promise((resolve) => {
        const greeting = config.username
          ? Buffer.from([0x05, 0x02, 0x00, 0x02])
          : Buffer.from([0x05, 0x01, 0x00]);
        socket.setTimeout(5000);
        socket.write(greeting);
        let step = 0;
        let buffered = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          buffered = Buffer.concat([buffered, chunk]);
          if (step === 0) {
            if (buffered.length < 2) return;
            const data = buffered;
            if (data[0] !== 0x05) { socket.destroy(); resolve({ success: false, error: 'Invalid SOCKS5 version' }); return; }
            if (data[1] === 0xFF) { socket.destroy(); resolve({ success: false, error: 'No acceptable auth method' }); return; }
            if (data[1] === 0x02 && config.username && config.password) {
              step = 1;
              buffered = Buffer.alloc(0);
              const userBuf = Buffer.from(config.username, 'utf8');
              const passBuf = Buffer.from(config.password, 'utf8');
              const authReq = Buffer.alloc(3 + userBuf.length + passBuf.length);
              authReq[0] = 0x01; authReq[1] = userBuf.length;
              userBuf.copy(authReq, 2);
              authReq[2 + userBuf.length] = passBuf.length;
              passBuf.copy(authReq, 3 + userBuf.length);
              socket.write(authReq);
            } else { socket.destroy(); resolve({ success: true }); }
          } else if (step === 1) {
            if (buffered.length < 2) return;
            const data = buffered;
            socket.destroy();
            resolve(data[0] === 0x01 && data[1] === 0x00
              ? { success: true }
              : { success: false, error: 'SOCKS5 authentication failed' });
          }
        });
        socket.on('timeout', () => { socket.destroy(); resolve({ success: false, error: 'SOCKS5 handshake timeout' }); });
        socket.on('error', (err) => resolve({ success: false, error: err.message }));
      });
    } else {
      const socket = await connectToProxy();
      return await new Promise((resolve) => {
        socket.setTimeout(5000);
        const authHeader = config.username && config.password
          ? 'Proxy-Authorization: Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64') + '\r\n'
          : '';
        socket.write('CONNECT httpbin.org:443 HTTP/1.1\r\nHost: httpbin.org:443\r\n' + authHeader + '\r\n');
        let responseData = '';
        socket.on('data', (data) => {
          responseData += data.toString();
          if (responseData.includes('\r\n\r\n')) {
            socket.destroy();
            if (responseData.includes('200')) resolve({ success: true });
            else if (responseData.includes('407')) resolve({ success: false, error: 'Proxy authentication required' });
            else resolve({ success: false, error: 'Proxy rejected: ' + (responseData.split('\r\n')[0] || 'Unknown') });
          }
        });
        socket.on('timeout', () => { socket.destroy(); resolve({ success: false, error: 'HTTP proxy handshake timeout' }); });
        socket.on('error', (err) => resolve({ success: false, error: err.message }));
      });
    }
  } catch (e) { return { success: false, error: e.message }; }
});


// ── Desktop prefs: auto-launch + tray behavior (#345) ──
// Defaults: autoLaunch OFF, closeToTray/minimizeToTray ON (see desktopPrefs.js).

function getDesktopUserDataPath() {
  return app.getPath('userData');
}

function reloadDesktopPrefs() {
  desktopPrefs = loadDesktopPrefs({ fs, pathModule: path, userDataPath: getDesktopUserDataPath() });
  return desktopPrefs;
}

function persistDesktopPrefs(next) {
  desktopPrefs = saveDesktopPrefs(
    { fs, pathModule: path, userDataPath: getDesktopUserDataPath() },
    normalizeDesktopPrefs({ ...desktopPrefs, ...next }),
  );
  return desktopPrefs;
}

/**
 * Apply the auto-launch OS setting. Best-effort: never throws, reports errors.
 * - Windows/macOS: Electron built-in login-item settings.
 * - Linux: freedesktop `~/.config/autostart/*.desktop` entry.
 */
async function applyAutoLaunch(enabled) {
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: !!enabled,
        openAsHidden: true,
        // Windows: start resident in tray like the Linux --hidden entry.
        ...(process.platform === 'win32' ? { args: ['--hidden'] } : {}),
      });
    } else if (process.platform === 'linux') {
      const autostartPath = getLinuxAutostartPath({ homeDir: os.homedir(), pathModule: path });
      if (enabled) {
        fs.mkdirSync(path.dirname(autostartPath), { recursive: true });
        fs.writeFileSync(
          autostartPath,
          buildLinuxDesktopEntry({ execPath: process.execPath }),
        );
      } else if (fs.existsSync(autostartPath)) {
        fs.unlinkSync(autostartPath);
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve the tray icon path for the current platform and theme.
 * macOS prefers the monochrome template image (system recolors it for
 * light/dark menu bars); other platforms pick the black/white monochrome
 * variant from the system theme, falling back to the legacy color icons.
 */
function resolveTrayIcon() {
  // macOS menu bar requires monochrome template image (pure black + alpha), system adapts to light/dark appearance automatically;
  // other platforms lack a template mechanism and switch between black and white variants according to system theme.
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(path.join(__dirname, 'assets', 'trayTemplate.png'));
  } else {
    candidates.push(path.join(__dirname, 'assets', nativeTheme.shouldUseDarkColors ? 'tray-white.png' : 'tray-black.png'));
  }
  candidates.push(
    path.join(__dirname, 'assets', 'tray-32.png'),
    path.join(__dirname, 'assets', 'tray-16.png'),
    path.join(__dirname, '..', 'public', 'icon.png'),
    path.join(__dirname, '..', 'dist', 'icon.png'),
  );
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const template = [
    {
      label: 'Show Main Window',
      click: () => restoreMainWindow(),
    },
    { type: 'separator' },
    {
      label: 'Launch at Login',
      type: 'checkbox',
      checked: desktopPrefs.autoLaunch,
      click: async (item) => {
        await setAutoLaunchWithRollback(!!item.checked);
        refreshTrayMenu();
      },
    },
    {
      label: 'Minimize to Tray on Close',
      type: 'checkbox',
      checked: desktopPrefs.closeToTray,
      click: (item) => {
        persistDesktopPrefs({ closeToTray: !!item.checked });
        refreshTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip('GitHub Stars Manager');
}

/** Set auto-launch with disk persistence; rolls back the pref on OS failure. */
async function setAutoLaunchWithRollback(enabled) {
  const previous = { ...desktopPrefs };
  persistDesktopPrefs({ autoLaunch: !!enabled });
  const applied = await applyAutoLaunch(!!enabled);
  if (!applied.success) {
    try {
      persistDesktopPrefs(previous);
    } catch {
      desktopPrefs = previous;
    }
    return { success: false, prefs: { ...desktopPrefs }, error: applied.error };
  }
  refreshTrayMenu();
  return { success: true, prefs: { ...desktopPrefs } };
}

/** Create the tray with the resolved icon (marked as template on macOS) and menu wiring. */
function createTray() {
  if (tray && !tray.isDestroyed()) {
    refreshTrayMenu();
    return;
  }
  try {
    const iconPath = resolveTrayIcon();
    const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        restoreMainWindow();
      }
    });
    refreshTrayMenu();
  } catch (err) {
    console.error('Failed to create tray:', err);
    tray = null;
  }
}

function destroyTray() {
  try {
    if (tray && !tray.isDestroyed()) tray.destroy();
  } catch {
    // Best-effort cleanup during shutdown.
  }
  tray = null;
}

// Non-macOS tray icon follows system light/dark theme changes (macOS uses template image for automatic adaptation).
nativeTheme.on('updated', () => {
  if (process.platform === 'darwin') return;
  if (!tray || tray.isDestroyed()) return;
  const iconPath = resolveTrayIcon();
  if (iconPath) tray.setImage(nativeImage.createFromPath(iconPath));
});

ipcMain.handle('desktop:getPrefs', () => ({ ...desktopPrefs }));

ipcMain.handle('desktop:setAutoLaunch', async (_e, enabled) =>
  setAutoLaunchWithRollback(!!enabled),
);

ipcMain.handle('desktop:setCloseToTray', (_e, enabled) => {
  const prefs = persistDesktopPrefs({ closeToTray: !!enabled });
  refreshTrayMenu();
  return { success: true, prefs: { ...prefs } };
});

ipcMain.handle('desktop:setMinimizeToTray', (_e, enabled) => {
  const prefs = persistDesktopPrefs({ minimizeToTray: !!enabled });
  refreshTrayMenu();
  return { success: true, prefs: { ...prefs } };
});

ipcMain.handle('desktop:show', () => {
  restoreMainWindow();
  return { success: true };
});


// ── MCP local server (read-only tools for agents) ──
let mcpConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 3927,
  token: '',
};
let mcpSnapshot = null;
const mcpServer = createMcpLocalServer(() => ({
  config: mcpConfig,
  snapshot: mcpSnapshot,
}));

/** Desktop MCP must only bind loopback. */
function normalizeMcpHost(_rawHost) {
  return '127.0.0.1';
}

ipcMain.handle('mcp:setConfig', async (_e, config) => {
  const previousHost = mcpConfig.host;
  const previousPort = mcpConfig.port;
  mcpConfig = {
    enabled: !!config?.enabled,
    host: normalizeMcpHost(config?.host),
    port:
      typeof config?.port === 'number' && config.port >= 1 && config.port <= 65535
        ? config.port
        : 3927,
    token: typeof config?.token === 'string' ? config.token : '',
  };
  const addressChanged = mcpConfig.host !== previousHost || mcpConfig.port !== previousPort;
  if (!mcpConfig.enabled || addressChanged) {
    await mcpServer.stop();
  }
  return { success: true };
});

ipcMain.handle('mcp:getConfig', async () => mcpConfig);

ipcMain.handle('mcp:pushSnapshot', async (_e, snapshot) => {
  mcpSnapshot = snapshot || null;
  return { success: true };
});

ipcMain.handle('mcp:start', async () => {
  try {
    return await mcpServer.start();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('mcp:stop', async () => mcpServer.stop());

ipcMain.handle('mcp:getStatus', async () => mcpServer.getStatus());

// ── Trusted local plugin host (discovery, lifecycle, and restricted IPC) ──
let pluginManager = null;
let pluginMarketplace = null;

// Page Bridge system export operations (V1.4): write to clipboard and "host download". Implementations are only
// available in the main process and invoked after permission checks in capabilityRouter; save location is always
// confirmed by the user in native dialogs, matching Release Asset downloads.
const pluginHostOperations = {
  clipboardWrite({ text }) {
    clipboard.writeText(text);
    return null;
  },
  clipboardWriteImage({ buffer }) {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) {
      throw Object.assign(new Error('Clipboard image payload is invalid'), { code: 'PLUGIN_CLIPBOARD_IMAGE_INVALID' });
    }
    clipboard.writeImage(image);
    return null;
  },
  async saveFile({ fileName, buffer }) {
    // Plugin only provides suggested name: strip path separators and control characters, append .png if extension is missing.
    // Final save location is still confirmed by user in native dialog, matching Release Asset downloads.
    const suggested = path.basename(typeof fileName === 'string' ? fileName : '')
      .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_');
    const safeName = suggested && suggested !== '.' ? suggested : 'plugin-export';
    const defaultPath = path.extname(safeName) ? safeName : `${safeName}.png`;
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath,
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.promises.writeFile(result.filePath, buffer);
    // Do not write to clipboard: this operation only validates downloads:create; writing to clipboard would bypass clipboard:write.
    return { fileName: path.basename(result.filePath) };
  },
};

function getPluginManager() {
  if (!pluginManager) {
    pluginManager = createPluginManager({
      pluginsRoot: path.join(app.getPath('userData'), 'plugins'),
      hostOperations: pluginHostOperations,
      // Plugin capability log mirror: written to diagnostics log while writing to plugin's own log file
      logMirror: (entry) => diagLog.record(entry),
    });
  }
  return pluginManager;
}

// Plugin marketplace (self-hosted plugin sources): source list and directory cache maintained in main process, installation reuses pluginManager.
function getPluginMarketplace() {
  if (!pluginMarketplace) {
    pluginMarketplace = createPluginMarketplace({
      statePath: path.join(app.getPath('userData'), 'plugins-marketplace.json'),
      stagingRoot: path.join(app.getPath('userData'), 'plugin-staging'),
      fetchImpl: (url, options) => net.fetch(url, options),
      pluginManager: getPluginManager(),
    });
  }
  return pluginMarketplace;
}

ipcMain.handle('plugins:list', async () => getPluginManager().list());
ipcMain.handle('plugins:installFromDirectory', async () => {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Select plugin directory',
    properties: ['openDirectory'],
  });
  if (selection.canceled || selection.filePaths.length !== 1) return { success: false, canceled: true };
  return getPluginManager().installFromDirectory(selection.filePaths[0]);
});
ipcMain.handle('plugins:enable', async (_event, pluginId, grantedPermissions) =>
  getPluginManager().enable(pluginId, grantedPermissions)
);
ipcMain.handle('plugins:disable', async (_event, pluginId) =>
  getPluginManager().disable(pluginId)
);
ipcMain.handle('plugins:uninstall', async (_event, pluginId, removePluginData) =>
  getPluginManager().uninstall(pluginId, removePluginData)
);
ipcMain.handle('plugins:runAction', async (_event, request) => {
  const operation = await getPluginManager().runAction(request);
  if (operation.success && operation.result.type === 'open-external') {
    try {
      await shell.openExternal(operation.result.url);
    } catch {
      return {
        success: false,
        error: { code: 'PLUGIN_EXTERNAL_OPEN_FAILED', message: 'Failed to open the external URL' },
      };
    }
  }
  return operation;
});
ipcMain.handle('plugins:runProcessor', async (_event, request) =>
  getPluginManager().runProcessor(request)
);
ipcMain.handle('plugins:pushSnapshot', async (_event, snapshot) =>
  getPluginManager().updateSnapshot(snapshot)
);
ipcMain.handle('plugins:runReleaseProcessor', async (_event, request) =>
  getPluginManager().runReleaseProcessor(request)
);
ipcMain.handle('plugins:downloadReleaseAsset', async (_event, request) => {
  const resolved = getPluginManager().getDownloadAsset(
    request?.pluginId,
    request?.releaseId,
    request?.assetId
  );
  if (!resolved.success) return resolved;
  return downloadReleaseAsset({
    fetchImpl: (url, options) => net.fetch(url, options),
    showSaveDialog: (...args) => dialog.showSaveDialog(...args),
    ownerWindow: mainWindow,
    ...resolved.value,
  });
});
// Community plugin registry (Development guidelines §17): main process fetches and validates entries; renderer only receives validated structure.
// No plugin packages are downloaded here, and no installation actions are performed.
ipcMain.handle('plugins:loadRegistry', async () => loadPluginRegistry({
  fetchImpl: (url, options) => net.fetch(url, options),
}));
// Plugin marketplace (self-hosted plugin sources): CRUD and traversal of sources, installing/updating plugins from sources.
// Installation downloads entire plugin directory, reusing pluginManager validation and placement, never handling files in renderer.
ipcMain.handle('plugins:marketplace:getState', async () => getPluginMarketplace().getState());
ipcMain.handle('plugins:marketplace:addSource', async (_event, input) =>
  getPluginMarketplace().addSource(input)
);
ipcMain.handle('plugins:marketplace:updateSource', async (_event, input) =>
  getPluginMarketplace().updateSource(input)
);
ipcMain.handle('plugins:marketplace:removeSource', async (_event, input) =>
  getPluginMarketplace().removeSource(input)
);
ipcMain.handle('plugins:marketplace:refresh', async (_event, options) =>
  getPluginMarketplace().refresh(options)
);
ipcMain.handle('plugins:marketplace:install', async (_event, request) =>
  getPluginMarketplace().install(request)
);
ipcMain.handle('plugins:runExporter', async (_event, request) =>
  getPluginManager().runExporter(request)
);
function isMainPluginFrame(event) {
  return mainWindow && event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame;
}
ipcMain.handle('plugins:getPage', async (event, pluginId, pageId) => {
  if (!isMainPluginFrame(event)) return { success: false, error: { code: 'PLUGIN_IPC_DENIED', message: 'Plugin IPC requires the main frame' } };
  return getPluginManager().getPage(pluginId, pageId);
});
ipcMain.handle('plugins:requestPageCapability', async (event, request) => {
  if (!isMainPluginFrame(event)) return { success: false, error: { code: 'PLUGIN_IPC_DENIED', message: 'Plugin IPC requires the main frame' } };
  return getPluginManager().requestPageCapability(request);
});
ipcMain.handle('plugins:getSearchEndpoint', async (event) => {
  if (!isMainPluginFrame(event)) return { endpoint: null };
  return getPluginManager().getSearchEndpoint();
});
ipcMain.handle('plugins:configureWebSearch', async (event, endpoint) => {
  if (!isMainPluginFrame(event)) return { success: false, error: { code: 'PLUGIN_IPC_DENIED', message: 'Plugin IPC requires the main frame' } };
  return getPluginManager().configureWebSearch(endpoint);
});
ipcMain.handle('plugins:searchWeb', async (event, request) => {
  if (!isMainPluginFrame(event)) return { success: false, error: { code: 'PLUGIN_IPC_DENIED', message: 'Plugin IPC requires the main frame' } };
  return getPluginManager().searchWeb(request);
});

// ── Diagnostics IPC (append/flush/read/exportBundle) ──
// The renderer bridge batches entries (2s / 32 items) and piggybacks its
// current debug-mode flag so main-process capture level follows the same
// switch with zero extra IPC round-trips.

function applyDiagnosticsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (typeof payload.debugMode === 'boolean') diagDebug = payload.debugMode;
  return payload.entries;
}

ipcMain.handle('diagnostics:append', (_event, payload) => {
  try {
    const entries = applyDiagnosticsPayload(payload);
    if (entries === null) return { success: false, error: 'invalid payload' };
    return diagLog.ingestRenderer(entries);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// One-way shutdown path: pagehide/beforeunload flush before the page dies.
ipcMain.on('diagnostics:flush', (_event, payload) => {
  try {
    const entries = applyDiagnosticsPayload(payload);
    if (entries !== null) diagLog.ingestRenderer(entries);
  } catch { /* shutdown must never throw */ }
});

ipcMain.handle('diagnostics:read', async (_event, options) => {
  try {
    const since = typeof options?.since === 'string' ? options.since : undefined;
    const limit = Number.isFinite(options?.limit)
      ? Math.min(Math.max(Math.trunc(options.limit), 1), 5000)
      : 2000;
    const main = await diagLog.readTail({ since, sources: ['main'], limit });
    return { success: true, main, plugins: readPluginLogTails({ limit }) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), main: [], plugins: [] };
  }
});

ipcMain.handle('diagnostics:exportBundle', async (_event, payload) => exportDiagnosticsBundle(payload));

/** Read the tail of every plugin's own JSONL log (<userData>/plugin-logs). */
function readPluginLogTails({ limit = 1000 } = {}) {
  const logsRoot = path.join(app.getPath('userData'), 'plugin-logs');
  const result = [];
  try {
    const names = fs.readdirSync(logsRoot)
      .filter((name) => name.endsWith('.log'))
      .sort()
      .slice(0, 100);
    for (const name of names) {
      const pluginId = name.slice(0, -4);
      let content = '';
      try { content = fs.readFileSync(path.join(logsRoot, name), 'utf8'); } catch { continue; }
      const lines = content.split('\n').filter(Boolean).slice(-200);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          result.push({
            id: `${name}-${result.length}`,
            timestamp: typeof parsed.at === 'string' ? parsed.at : new Date(0).toISOString(),
            level: parsed.level === 'warning' ? 'warn' : (['debug', 'info', 'warn', 'error'].includes(parsed.level) ? parsed.level : 'info'),
            module: pluginId,
            message: typeof parsed.message === 'string' ? parsed.message : '',
            ...(parsed.metadata === undefined ? {} : { data: parsed.metadata }),
            source: 'plugins',
          });
        } catch { /* torn line after rotation — skip */ }
      }
    }
  } catch { /* no plugin logs yet */ }
  return result.slice(-limit);
}

/**
 * Halve-then-drop the oldest records (by timestamp, across every source)
 * until the SERIALIZED (indent=2, same as the writeFile) bundle fits the
 * budget. Returns null when even a metadata-only bundle would exceed the
 * cap — the caller must then fail the export instead of writing a file.
 */
function fitBundleSize(bundle, maxBytes) {
  const serializedLength = (obj) => Buffer.byteLength(JSON.stringify(obj, null, 2), 'utf8');
  if (serializedLength(bundle) <= maxBytes) return bundle;
  const out = { ...bundle, truncated: true, sources: { ...bundle.sources } };
  const lists = [
    { host: out, key: 'frontendLogs' },
    { host: out, key: 'backendLogs' },
    { host: out.sources, key: 'main' },
    { host: out.sources, key: 'network' },
    { host: out.sources, key: 'plugins' },
  ];
  for (;;) {
    if (serializedLength(out) <= maxBytes) return out;
    // Find the source holding the globally oldest record and drop its
    // oldest eighth (at least one entry). Each array is chronological, so
    // prefix drops mirror "drop oldest first" while keeping this O(log n)
    // re-serializations instead of one per record.
    let target = -1;
    let targetTs = null;
    lists.forEach(({ host, key }, li) => {
      const arr = Array.isArray(host[key]) ? host[key] : [];
      if (arr.length === 0) return;
      const ts = typeof arr[0]?.timestamp === 'string' ? arr[0].timestamp : '';
      if (targetTs === null || ts < targetTs) {
        targetTs = ts;
        target = li;
      }
    });
    if (target < 0) return null;
    const { host, key } = lists[target];
    const arr = host[key];
    host[key] = arr.slice(Math.max(1, Math.floor(arr.length / 8)));
  }
}

/**
 * Export-side trust boundary: the renderer may submit networkEntries or
 * frontendLogs directly, so string values that look like embedded JSON
 * (e.g. a captured request body containing X auth cookies) are parsed and
 * re-sanitized as objects before they can land in the exported file.
 */
function deepRedactEmbeddedJson(value, depth = 0) {
  if (depth > 6) return value;
  if (typeof value === 'string') {
    const trimmed = value.length <= 256 * 1024 ? value.trim() : '';
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          const sanitized = redact.sanitizeForLog(parsed);
          return JSON.stringify(sanitized);
        }
      } catch {
        // Not JSON — leave the string as-is (already sanitized upstream).
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => deepRedactEmbeddedJson(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedactEmbeddedJson(v, depth + 1);
    return out;
  }
  return value;
}

function redactExportedEntries(entries) {
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    if (entry.data === undefined) return entry;
    return { ...entry, data: deepRedactEmbeddedJson(entry.data) };
  });
}

async function exportDiagnosticsBundle(payload = {}) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: 'main window unavailable' };
    const windowHours = payload.windowHours === null || payload.windowHours === undefined
      ? null
      : Math.min(Math.max(Math.trunc(Number(payload.windowHours) || 24), 1), 168);
    const since = windowHours ? new Date(Date.now() - windowHours * 3_600_000).toISOString() : undefined;
    const capEntries = (value, max) => (Array.isArray(value) ? value.filter((e) => (
      e
      && typeof e === 'object'
      && (!since || (typeof e.timestamp === 'string' && e.timestamp >= since))
    )) : []).slice(-max);
    const mainLogs = await diagLog.readTail({ since, limit: 2000 });
    const bundle = fitBundleSize({
      format: 'github-stars-manager-logs-v2',
      exportDate: new Date().toISOString(),
      appVersion: app.getVersion(),
      sessionId: diagLog.sessionId,
      environment: buildSystemInfo({
        os,
        versions: process.versions,
        appVersion: app.getVersion(),
        sessionId: diagLog.sessionId,
        proxyConfig: loadProxyConfig(),
        plugins: await listPluginsForSnapshot(),
        renderer: payload.environment && typeof payload.environment === 'object' ? payload.environment : {},
      }),
      sanitizationNote: typeof payload.sanitizationNote === 'string'
        ? payload.sanitizationNote
        : 'Tokens, API keys, passwords and emails are masked before writing.',
      frontendLogs: redactExportedEntries(capEntries(payload.frontendLogs, 2000)),
      backendLogs: redactExportedEntries(capEntries(payload.backendLogs, 2000)),
      sources: {
        main: mainLogs,
        network: redactExportedEntries(capEntries(payload.networkEntries, 1000)),
        plugins: capEntries(readPluginLogTails({ limit: 1500 }), 1500),
      },
    }, 5 * 1024 * 1024);
    if (!bundle) {
      return { success: false, error: 'diagnostics bundle exceeds size budget even after truncation' };
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `github-stars-manager-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    await fs.promises.writeFile(result.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    diagLog.record({
      level: 'info',
      module: 'electron.diagnostics',
      message: 'Diagnostics bundle exported',
      data: { windowHours },
    });
    return { success: true, filePath: result.filePath };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Best-effort plugin manifest summary for snapshots; never throws. */
async function listPluginsForSnapshot() {
  try {
    const result = await getPluginManager().list();
    return (result?.plugins ?? []).map((plugin) => ({
      id: plugin?.manifest?.id,
      version: plugin?.manifest?.version,
      enabled: !!plugin?.enabled,
    }));
  } catch {
    return [];
  }
}

// ── Chromium-stack request observer (zero call-site coverage for net.fetch,
// and every renderer/Chromium request through the default session) ──
const DIAGNOSTICS_WEBREQUEST_FILTER = { urls: ['http://*/*', 'https://*/*'] };

function isLoopbackHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function shouldSkipDiagnosticsUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    if (!isLoopbackHost(url.hostname)) return false;
    // Local MCP server is an inbound read-only interface, not an outbound request
    if (mcpConfig.enabled && url.port === String(mcpConfig.port)) return true;
    // Skip Vite dev server traffic in dev mode
    if (isDev && url.port === '5173') return true;
    return false;
  } catch {
    return true;
  }
}

function flattenHeaderRecord(headers) {
  const flat = {};
  for (const [key, value] of Object.entries(headers || {})) {
    flat[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return flat;
}

function attachDiagnosticsWebRequestObserver(targetSession) {
  const inflight = new Map();
  const rememberRequest = (details) => {
    if (shouldSkipDiagnosticsUrl(details.url)) return;
    if (inflight.size >= 1000) {
      const oldest = inflight.keys().next().value;
      inflight.delete(oldest);
    }
    inflight.set(details.id, {
      url: details.url,
      method: details.method,
      startedAt: Date.now(),
      redirects: 0,
      via: details.webContentsId ? 'renderer' : 'main',
      resourceType: details.resourceType,
    });
  };
  // ⚠️ onBeforeRequest is a BLOCKING listener: on Electron 44 a listener that
  // never calls its callback hangs EVERY matching request until the caller's
  // own timeout aborts it (net::ERR_ABORTED) — empirically verified. The
  // callback form with an immediate callback({}) is required, even though the
  // bookkeeping itself is synchronous.
  targetSession.webRequest.onBeforeRequest(DIAGNOSTICS_WEBREQUEST_FILTER, (details, callback) => {
    try {
      rememberRequest(details);
    } finally {
      callback({});
    }
  });
  targetSession.webRequest.onBeforeRedirect(DIAGNOSTICS_WEBREQUEST_FILTER, (details) => {
    const pending = inflight.get(details.id);
    if (pending) pending.redirects += 1;
  });
  targetSession.webRequest.onCompleted(DIAGNOSTICS_WEBREQUEST_FILTER, (details) => {
    const pending = inflight.get(details.id) ?? {
      url: details.url,
      method: details.method,
      startedAt: Date.now(),
      redirects: 0,
      via: details.webContentsId ? 'renderer' : 'main',
      resourceType: details.resourceType,
    };
    inflight.delete(details.id);
    if (shouldSkipDiagnosticsUrl(details.url)) return;
    const failed = details.statusCode >= 400;
    if (!diagDebug && !failed) return;
    try {
      diagLog.record({
        level: failed ? 'warn' : 'debug',
        module: 'electron.webRequest',
        message: `${pending.method} ${redact.redactUrl(pending.url)} → ${details.statusCode}`,
        data: {
          url: redact.redactUrl(pending.url),
          method: pending.method,
          status: details.statusCode,
          durationMs: Date.now() - pending.startedAt,
          redirects: pending.redirects,
          via: pending.via,
          resourceType: pending.resourceType,
          fromCache: !!details.fromCache,
          ...(diagDebug && details.responseHeaders
            ? { responseHeaders: redact.sanitizeForLog({ headers: flattenHeaderRecord(details.responseHeaders) }).headers }
            : {}),
        },
      });
    } catch { /* observer must never break the request path */ }
  });
  targetSession.webRequest.onErrorOccurred(DIAGNOSTICS_WEBREQUEST_FILTER, (details) => {
    const pending = inflight.get(details.id);
    inflight.delete(details.id);
    if (shouldSkipDiagnosticsUrl(details.url)) return;
    try {
      // Same level policy as netTap: user aborts (net::ERR_ABORTED) are
      // normal control flow → info; transient network conditions → warn.
      const netLevel = diagTap.classifyNetErrorCode(details.error);
      diagLog.record({
        level: netLevel,
        module: 'electron.webRequest',
        message: `${details.method} ${redact.redactUrl(details.url)} ${netLevel === 'info' ? 'aborted' : 'failed'}`,
        data: {
          url: redact.redactUrl(details.url),
          method: details.method,
          error: details.error,
          // details.timestamp is the event clock, not an epoch offset — only
          // the remembered start time yields a meaningful duration.
          ...(pending ? { durationMs: Date.now() - pending.startedAt } : {}),
          via: details.webContentsId ? 'renderer' : 'main',
          resourceType: details.resourceType,
        },
      });
    } catch { /* observer must never break the request path */ }
  });
}


if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    restoreMainWindow();
  });
}

app.whenReady().then(() => {
  // Chromium stack observer: covers all net.fetch (plugin marketplace/registry/asset downloads/X/Telegram/
  // WebDAV fallback stack) and renderer requests made via session; node:https in webSearch.js
  // goes through neither undici nor Chromium, and is manually recorded in that file (setNetworkRecorder).
  attachDiagnosticsWebRequestObserver(session.defaultSession);
  setNetworkRecorder((entry) => diagLog.record(entry));
  protocol.handle(PAGE_SCHEME, (request) => {
    const resource = getPluginManager().readPageResource(request.url);
    if (!resource) return new Response('Not Found', { status: 404 });
    return new Response(resource.body, {
      headers: {
        'Content-Type': resource.mimeType,
        'Content-Security-Policy': pageCsp(new URL(request.url).hostname),
        'Access-Control-Allow-Origin': 'null',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });
  reloadDesktopPrefs();
  void getPluginManager().initialize().catch((error) => {
    console.error('Failed to initialize plugins:', error instanceof Error ? error.message : 'Unknown error');
  });
  // Self-heal the OS login item on every start (e.g. path changed after update).
  if (desktopPrefs.autoLaunch) {
    void applyAutoLaunch(true).then((result) => {
      if (!result.success) console.error('Failed to apply auto-launch:', result.error);
    });
  }
  createTray();
  createWindow();
  // `--hidden` (Linux autostart) starts resident in tray without flashing.
  if (startHidden && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  const savedProxy = loadProxyConfig();
  if (savedProxy.enabled && savedProxy.host && savedProxy.port) {
    applyProxy(savedProxy);
  }
  // DevTools shortcut only in development
  if (isDev) {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) {
        focused.webContents.toggleDevTools();
      }
    });
  }
  // Startup environment snapshot (previously absent from the journal).
  // The snapshot's own sessionId field is dropped: the journal entry carries
  // sessionId at the top level, and a UUID value inside `data` would trip the
  // sanitizer's generic-secret pattern.
  void listPluginsForSnapshot().then((plugins) => {
    const snapshot = buildSystemInfo({
      os,
      versions: process.versions,
      appVersion: app.getVersion(),
      sessionId: diagLog.sessionId,
      proxyConfig: savedProxy,
      plugins,
      routeMode: null,
    });
    delete snapshot.sessionId;
    diagLog.record({
      level: 'info',
      module: 'electron.system',
      message: 'Session started',
      data: snapshot,
    });
  });
});

app.on('window-all-closed', () => {
  void mcpServer.stop();
  // #345: close-to-tray prevents this from firing while resident; when the
  // user disabled it, keep the historical behavior (quit on Win/Linux).
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Allow the real quit path to bypass the close-to-tray interceptor.
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  destroyTray();
  void mcpServer.stop();
  pluginManager?.shutdown();
  // Synchronous final drain: journal writes are appendFileSync, so this
  // completes instantly with nothing left in flight — the quit path stays
  // free of async waiting (and of the hang risks that come with it).
  try {
    diagLog.flushSync();
  } catch { /* quit must never be blocked by diagnostics */ }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
