import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type CswapApi } from '@shared/types'

function on<T>(channel: string) {
  return (cb: (v: T) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, v: T): void => cb(v)
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.removeListener(channel, h)
  }
}

const api: CswapApi = {
  getAccounts: () => ipcRenderer.invoke(IPC.getAccounts),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  switchTo: (t, f) => ipcRenderer.invoke(IPC.switchTo, t, f),
  rotate: (s) => ipcRenderer.invoke(IPC.rotate, s),
  addAccount: (o) => ipcRenderer.invoke(IPC.addAccount, o),
  addToken: (o) => ipcRenderer.invoke(IPC.addToken, o),
  removeAccount: (t) => ipcRenderer.invoke(IPC.removeAccount, t),
  setDisabled: (t, v) => ipcRenderer.invoke(IPC.setDisabled, t, v),
  setAlias: (t, a) => ipcRenderer.invoke(IPC.setAlias, t, a),
  moveAccount: (t, s) => ipcRenderer.invoke(IPC.moveAccount, t, s),
  swapAccounts: (a, b) => ipcRenderer.invoke(IPC.swapAccounts, a, b),
  listMappings: () => ipcRenderer.invoke(IPC.listMappings),
  mapDirectory: (t, p) => ipcRenderer.invoke(IPC.mapDirectory, t, p),
  unmapDirectory: (p) => ipcRenderer.invoke(IPC.unmapDirectory, p),
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  setConfig: (k, v) => ipcRenderer.invoke(IPC.setConfig, k, v),
  exportAccounts: (o) => ipcRenderer.invoke(IPC.exportAccounts, o),
  importAccounts: (o) => ipcRenderer.invoke(IPC.importAccounts, o),
  listUnclaimed: () => ipcRenderer.invoke(IPC.listUnclaimed),
  purgeUnclaimed: (id) => ipcRenderer.invoke(IPC.purgeUnclaimed, id),
  upgradeCswap: () => ipcRenderer.invoke(IPC.upgradeCswap),
  tokenStatus: () => ipcRenderer.invoke(IPC.tokenStatus),
  launchSession: (t, cwd) => ipcRenderer.invoke(IPC.launchSession, t, cwd),
  oauthStart: (o) => ipcRenderer.invoke(IPC.oauthStart, o),
  oauthReopen: (id) => ipcRenderer.invoke(IPC.oauthReopen, id),
  oauthSubmitCode: (id, t) => ipcRenderer.invoke(IPC.oauthSubmitCode, id, t),
  oauthCommit: (id, o) => ipcRenderer.invoke(IPC.oauthCommit, id, o),
  oauthCancel: (id) => ipcRenderer.invoke(IPC.oauthCancel, id),
  warmState: () => ipcRenderer.invoke(IPC.warmState),
  warmNow: (t) => ipcRenderer.invoke(IPC.warmNow, t),
  checkForUpdate: () => ipcRenderer.invoke(IPC.checkForUpdate),
  updaterState: () => ipcRenderer.invoke(IPC.updaterState),
  updaterCheck: () => ipcRenderer.invoke(IPC.updaterCheck),
  updaterInstall: () => ipcRenderer.invoke(IPC.updaterInstall),
  autoOnce: (o) => ipcRenderer.invoke(IPC.autoOnce, o),
  autoStart: (o) => ipcRenderer.invoke(IPC.autoStart, o),
  autoStop: () => ipcRenderer.invoke(IPC.autoStop),
  autoStatus: () => ipcRenderer.invoke(IPC.autoStatus),
  autoEvents: () => ipcRenderer.invoke(IPC.autoEvents),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (p) => ipcRenderer.invoke(IPC.setSettings, p),
  getBinaryInfo: () => ipcRenderer.invoke(IPC.getBinaryInfo),
  detectBinary: () => ipcRenderer.invoke(IPC.detectBinary),
  pickBinary: () => ipcRenderer.invoke(IPC.pickBinary),
  installCswap: () => ipcRenderer.invoke(IPC.installCswap),
  getCommandLog: () => ipcRenderer.invoke(IPC.getCommandLog),
  clearCommandLog: () => ipcRenderer.invoke(IPC.clearCommandLog),
  getVaultPath: () => ipcRenderer.invoke(IPC.getVaultPath),
  openPath: (p) => ipcRenderer.invoke(IPC.openPath, p),
  openExternal: (u) => ipcRenderer.invoke(IPC.openExternal, u),
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  windowControl: (a) => ipcRenderer.invoke(IPC.windowControl, a),
  onAccounts: on(IPC.evAccounts),
  onAutoEvent: on(IPC.evAutoEvent),
  onAutoStatus: on(IPC.evAutoStatus),
  onCommandLog: on(IPC.evCommandLog),
  onSettings: on(IPC.evSettings),
  onNavigate: on(IPC.evNavigate),
  onUpdater: on(IPC.evUpdater),
  onBinary: on(IPC.evBinary),
  onOAuth: on(IPC.evOAuth),
  onWarm: on(IPC.evWarm)
}

contextBridge.exposeInMainWorld('cswap', api)
contextBridge.exposeInMainWorld('platform', process.platform)
