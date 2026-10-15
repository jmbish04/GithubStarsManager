const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) contextBridge.exposeInMainWorld('electronAPI', {
  setProxy: (config) => ipcRenderer.invoke('set-proxy', config),
  getProxy: () => ipcRenderer.invoke('get-proxy'),
  testProxy: (config) => ipcRenderer.invoke('test-proxy', config),
  xFetchTimeline: (handle) => ipcRenderer.invoke('x-fetch-timeline', handle),
  xFetchGraphQL: (url, auth) => ipcRenderer.invoke('x-fetch-graphql', url, auth),
  xAuth: {
    save: (auth) => ipcRenderer.invoke('x-auth:save', auth),
    get: () => ipcRenderer.invoke('x-auth:get'),
    clear: () => ipcRenderer.invoke('x-auth:clear'),
  },
  telegramFetchChannel: (channel, before) => ipcRenderer.invoke('telegram-fetch-channel', channel, before),
  // WebDAV: main process proxies DAV requests to bypass renderer CORS restrictions
  webdavRequest: (params) => ipcRenderer.invoke('webdav-request', params),
  desktop: {
    getPrefs: () => ipcRenderer.invoke('desktop:getPrefs'),
    setAutoLaunch: (enabled) => ipcRenderer.invoke('desktop:setAutoLaunch', enabled),
    setCloseToTray: (enabled) => ipcRenderer.invoke('desktop:setCloseToTray', enabled),
    setMinimizeToTray: (enabled) => ipcRenderer.invoke('desktop:setMinimizeToTray', enabled),
    show: () => ipcRenderer.invoke('desktop:show'),
  },
  // Diagnostic logging bridge: batched append (invoke) and pre-unload flush (send, one-way, no await)
  diagnostics: {
    append: (payload) => ipcRenderer.invoke('diagnostics:append', payload),
    flush: (payload) => ipcRenderer.send('diagnostics:flush', payload),
    read: (options) => ipcRenderer.invoke('diagnostics:read', options),
    exportBundle: (payload) => ipcRenderer.invoke('diagnostics:exportBundle', payload),
  },
  mcp: {
    setConfig: (config) => ipcRenderer.invoke('mcp:setConfig', config),
    getConfig: () => ipcRenderer.invoke('mcp:getConfig'),
    pushSnapshot: (snapshot) => ipcRenderer.invoke('mcp:pushSnapshot', snapshot),
    start: () => ipcRenderer.invoke('mcp:start'),
    stop: () => ipcRenderer.invoke('mcp:stop'),
    getStatus: () => ipcRenderer.invoke('mcp:getStatus'),
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    installFromDirectory: () => ipcRenderer.invoke('plugins:installFromDirectory'),
    enable: (pluginId, grantedPermissions) => ipcRenderer.invoke('plugins:enable', pluginId, grantedPermissions),
    disable: (pluginId) => ipcRenderer.invoke('plugins:disable', pluginId),
    uninstall: (pluginId, removePluginData) => ipcRenderer.invoke('plugins:uninstall', pluginId, removePluginData),
    runAction: (request) => ipcRenderer.invoke('plugins:runAction', request),
    runProcessor: (request) => ipcRenderer.invoke('plugins:runProcessor', request),
    pushSnapshot: (snapshot) => ipcRenderer.invoke('plugins:pushSnapshot', snapshot),
    runReleaseProcessor: (request) => ipcRenderer.invoke('plugins:runReleaseProcessor', request),
    downloadReleaseAsset: (request) => ipcRenderer.invoke('plugins:downloadReleaseAsset', request),
    runExporter: (request) => ipcRenderer.invoke('plugins:runExporter', request),
    getPage: (pluginId, pageId) => ipcRenderer.invoke('plugins:getPage', pluginId, pageId),
    requestPageCapability: (request) => ipcRenderer.invoke('plugins:requestPageCapability', request),
    getSearchEndpoint: () => ipcRenderer.invoke('plugins:getSearchEndpoint'),
    configureWebSearch: (endpoint) => ipcRenderer.invoke('plugins:configureWebSearch', endpoint),
    searchWeb: (request) => ipcRenderer.invoke('plugins:searchWeb', request),
    // Community plugin registry (Dev guideline §17): read-only verified registry, excluding installation actions
    registry: {
      load: () => ipcRenderer.invoke('plugins:loadRegistry'),
    },
    // Plugin marketplace (self-hosted sources): source management + directory traversal + install/update from source
    marketplace: {
      getState: () => ipcRenderer.invoke('plugins:marketplace:getState'),
      addSource: (input) => ipcRenderer.invoke('plugins:marketplace:addSource', input),
      updateSource: (input) => ipcRenderer.invoke('plugins:marketplace:updateSource', input),
      removeSource: (input) => ipcRenderer.invoke('plugins:marketplace:removeSource', input),
      refresh: (options) => ipcRenderer.invoke('plugins:marketplace:refresh', options),
      install: (request) => ipcRenderer.invoke('plugins:marketplace:install', request),
    },
  },
});
