const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbit', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  copyText: (text) => ipcRenderer.invoke('app:copy-text', { text }),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', { url }),

  // Windows Host Mode APIs
  getHostStatus: () => ipcRenderer.invoke('host:get-status'),
  unlockHost: (username, password) => ipcRenderer.invoke('host:unlock', { username, password }),
  enableFirewall: () => ipcRenderer.invoke('host:enable-firewall'),
  checkFirewall: () => ipcRenderer.invoke('host:check-firewall'),
  enableAdminTakeover: () => ipcRenderer.invoke('host:enable-admin'),
  enableSystemAccess: () => ipcRenderer.invoke('host:enable-system-access'),
  pairMac: (pairingId, pin, name) => ipcRenderer.invoke('host:pair-mac', { pairingId, pin, name }),
  revokeClient: (uuid) => ipcRenderer.invoke('host:revoke-client', { uuid }),
  setKeepAwake: (enabled) => ipcRenderer.invoke('host:keep-awake', { enabled }),

  // Mac / Remote Takeover Client APIs
  listPcs: () => ipcRenderer.invoke('client:list-pcs'),
  addPc: (address) => ipcRenderer.invoke('client:add-pc', { address }),
  removePc: (address) => ipcRenderer.invoke('client:remove-pc', { address }),
  startPairing: (address) => ipcRenderer.invoke('client:start-pair', { address }),
  cancelPairing: () => ipcRenderer.invoke('client:cancel-pair'),
  connectToPc: (address, quality, monitor) =>
    ipcRenderer.invoke('client:connect', { address, quality, monitor }),
  disconnectSession: () => ipcRenderer.invoke('client:disconnect'),
  send: (payload) => ipcRenderer.send('client:send', payload),
  syncClipboardToPc: () => ipcRenderer.invoke('client:sync-clipboard-to-pc'),
  uploadFileDialog: (remoteDir) => ipcRenderer.invoke('client:upload-file-dialog', { remoteDir }),

  // Event Subscriptions
  onFrame: (callback) => {
    const handler = (_event, meta, binBuffer) => callback(meta, binBuffer);
    ipcRenderer.on('client:frame', handler);
    return () => ipcRenderer.removeListener('client:frame', handler);
  },
  onEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('client:event', handler);
    return () => ipcRenderer.removeListener('client:event', handler);
  },
  onPairComplete: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('client:pair-Complete', handler);
    return () => ipcRenderer.removeListener('client:pair-Complete', handler);
  },
  onDisconnected: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('client:disconnected', handler);
    return () => ipcRenderer.removeListener('client:disconnected', handler);
  }
});
