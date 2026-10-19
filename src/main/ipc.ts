import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { readFileSync } from 'node:fs'
import type { AppCore } from './core'
import { appInfo } from './core'
import { launchSession } from './session'
import { checkForUpdate } from './update'
import { IPC, type AddAccountOptions, type AddTokenOptions, type AppSettings, type ExportOptions, type ImportOptions, type OAuthCommitOptions, type OAuthStartOptions } from '@shared/types'

// e2e seam: when set, native dialogs answer from this JSON file instead of opening
// ({ directory, openFile, saveFile, binary } — a null means "cancelled").
function stubbedDialog(kind: 'directory' | 'openFile' | 'saveFile' | 'binary'): string | null | undefined {
  const f = process.env.CSWAP_DESKTOP_TEST_DIALOGS
  if (!f) return undefined
  try {
    const stub = JSON.parse(readFileSync(f, 'utf8')) as Record<string, string | null>
    return kind in stub ? stub[kind] : null
  } catch {
    return null
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
}

export function registerIpc(core: AppCore, getWindow: () => BrowserWindow | null): void {
  core.on('accounts', (s) => broadcast(IPC.evAccounts, s))
  core.on('autoEvent', (e) => broadcast(IPC.evAutoEvent, e))
  core.on('autoStatus', (s) => broadcast(IPC.evAutoStatus, s))
  core.on('log', (e) => broadcast(IPC.evCommandLog, e))
  core.on('settings', (s) => broadcast(IPC.evSettings, s))
  core.on('updater', (s) => broadcast(IPC.evUpdater, s))
  core.on('binary', (b) => broadcast(IPC.evBinary, b))
  core.on('oauth', (s) => broadcast(IPC.evOAuth, s))
  core.on('warm', (s) => broadcast(IPC.evWarm, s))

  const d = core.driver
  ipcMain.handle(IPC.getAccounts, () => core.getAccounts())
  ipcMain.handle(IPC.refresh, () => core.refresh())
  ipcMain.handle(IPC.getStatus, () => d.status())

  ipcMain.handle(IPC.switchTo, async (_e, target: string, force?: boolean) => core.afterMutation(await d.switchTo(target, !!force)))
  ipcMain.handle(IPC.rotate, async (_e, strategy?: 'best' | 'next-available') => core.afterMutation(await d.rotate(strategy)))
  ipcMain.handle(IPC.addAccount, async (_e, o: AddAccountOptions) => core.afterMutation(await d.addAccount(o.slot, o.alias, o.overwrite)))
  ipcMain.handle(IPC.addToken, async (_e, o: AddTokenOptions) => core.afterMutation(await d.addToken(o.token, o.email, o.slot, o.overwrite)))
  ipcMain.handle(IPC.removeAccount, async (_e, t: string) => core.afterMutation(await d.removeAccount(t)))
  ipcMain.handle(IPC.setDisabled, async (_e, t: string, v: boolean) => core.afterMutation(await d.setDisabled(t, v)))
  ipcMain.handle(IPC.setAlias, async (_e, t: string, a: string | null) => core.afterMutation(await d.setAlias(t, a)))
  ipcMain.handle(IPC.moveAccount, async (_e, t: string, slot: number) => core.afterMutation(await d.moveAccount(t, slot)))
  ipcMain.handle(IPC.swapAccounts, async (_e, a: string, b: string) => core.afterMutation(await d.swapAccounts(a, b)))

  ipcMain.handle(IPC.listMappings, () => core.listMappings())
  ipcMain.handle(IPC.mapDirectory, (_e, t: string, p: string) => d.mapDirectory(t, p))
  ipcMain.handle(IPC.unmapDirectory, (_e, p: string) => d.unmapDirectory(p))
  ipcMain.handle(IPC.pickDirectory, async () => {
    const stub = stubbedDialog('directory')
    if (stub !== undefined) return stub
    const w = getWindow()
    const r = await dialog.showOpenDialog(w ?? new BrowserWindow({ show: false }), { properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0] ?? null
  })

  ipcMain.handle(IPC.getConfig, () => d.config())
  ipcMain.handle(IPC.setConfig, (_e, k: string, v: string | null) => d.setConfig(k, v))

  ipcMain.handle(IPC.exportAccounts, async (_e, o: ExportOptions) => {
    let file = stubbedDialog('saveFile')
    if (file === undefined) {
      const r = await dialog.showSaveDialog(getWindow()!, {
        title: 'Export accounts',
        defaultPath: `claude-swap-${new Date().toISOString().slice(0, 10)}.cswap`,
        filters: [{ name: 'cswap export', extensions: ['cswap', 'json'] }]
      })
      file = r.canceled ? null : r.filePath || null
    }
    if (!file) return { ok: true, value: null }
    const out = await d.exportAccounts(file, o.account, o.full)
    return out.ok ? { ok: true, value: { path: file, output: out.value } } : out
  })
  ipcMain.handle(IPC.importAccounts, async (_e, o: ImportOptions) => {
    let file = stubbedDialog('openFile')
    if (file === undefined) {
      const r = await dialog.showOpenDialog(getWindow()!, {
        title: 'Import accounts',
        properties: ['openFile'],
        filters: [{ name: 'cswap export', extensions: ['cswap', 'json'] }, { name: 'All files', extensions: ['*'] }]
      })
      file = r.canceled ? null : r.filePaths[0] || null
    }
    if (!file) return { ok: true, value: null }
    const out = await core.afterMutation(await d.importAccounts(file, o.force))
    return out.ok ? { ok: true, value: { path: file, output: out.value } } : out
  })

  ipcMain.handle(IPC.listUnclaimed, () => core.listUnclaimed())
  ipcMain.handle(IPC.purgeUnclaimed, (_e, id: string) => d.purgeUnclaimed(id))
  ipcMain.handle(IPC.upgradeCswap, async () => {
    const r = await d.upgrade()
    await core.detectBinary()
    void core.refresh()
    return r
  })

  ipcMain.handle(IPC.tokenStatus, () => d.tokenStatus())
  ipcMain.handle(IPC.launchSession, (_e, t: string, cwd?: string) => launchSession(d.getBinary(), t, cwd))
  ipcMain.handle(IPC.oauthStart, (_e, o: OAuthStartOptions) => core.login.start(o ?? {}))
  ipcMain.handle(IPC.oauthReopen, (_e, id: string) => core.login.reopen(id))
  ipcMain.handle(IPC.oauthSubmitCode, (_e, id: string, text: string) => core.login.submitCode(id, text))
  ipcMain.handle(IPC.oauthCommit, (_e, id: string, o: OAuthCommitOptions) => core.login.commit(id, o ?? {}))
  ipcMain.handle(IPC.oauthCancel, (_e, id: string) => core.login.cancel(id))
  ipcMain.handle(IPC.warmState, () => core.warm.getState())
  ipcMain.handle(IPC.warmNow, (_e, target?: string) => core.warm.warmNow(target))
  ipcMain.handle(IPC.checkForUpdate, () => checkForUpdate(appInfo().version))
  ipcMain.handle(IPC.updaterState, () => core.updater.getState())
  ipcMain.handle(IPC.updaterCheck, () => core.updater.check())
  ipcMain.handle(IPC.updaterInstall, () => core.updater.install())
  ipcMain.handle(IPC.autoOnce, async (_e, o?: { dryRun?: boolean }) => core.afterMutation(await d.autoOnce(!!o?.dryRun)))
  ipcMain.handle(IPC.autoStart, (_e, o?: { dryRun?: boolean }) => {
    core.settings.set({ autoDryRun: !!o?.dryRun })
    return core.auto.start(d.getBinary(), o)
  })
  ipcMain.handle(IPC.autoStop, () => core.auto.stop())
  ipcMain.handle(IPC.autoStatus, () => core.auto.getStatus())
  ipcMain.handle(IPC.autoEvents, () => core.auto.getEvents())

  ipcMain.handle(IPC.getSettings, () => core.settings.get())
  ipcMain.handle(IPC.setSettings, async (_e, patch: Partial<AppSettings>) => {
    const before = core.settings.get()
    const s = core.settings.set(patch)
    if (patch.cswapPath !== undefined && patch.cswapPath !== before.cswapPath) {
      await core.detectBinary()
      void core.refresh()
    }
    if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== before.launchAtLogin && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin, args: ['--hidden'] })
    }
    return s
  })
  ipcMain.handle(IPC.getBinaryInfo, () => core.getBinaryInfo())
  ipcMain.handle(IPC.detectBinary, async () => {
    const info = await core.detectBinary()
    void core.refresh()
    return info
  })
  ipcMain.handle(IPC.pickBinary, async () => {
    const stub = stubbedDialog('binary')
    if (stub !== undefined) return stub
    const w = getWindow()
    const r = await dialog.showOpenDialog(w!, { title: 'Locate the cswap executable', properties: ['openFile'] })
    return r.canceled ? null : r.filePaths[0] ?? null
  })
  ipcMain.handle(IPC.installCswap, () => core.installCswap())
  ipcMain.handle(IPC.getCommandLog, () => d.getLog())
  ipcMain.handle(IPC.clearCommandLog, () => d.clearLog())
  ipcMain.handle(IPC.getVaultPath, () => core.getVaultPath())
  ipcMain.handle(IPC.openPath, (_e, p: string) => void shell.openPath(p))
  ipcMain.handle(IPC.openExternal, (_e, u: string) => {
    if (/^https?:\/\//.test(u)) void shell.openExternal(u)
  })
  ipcMain.handle(IPC.getAppInfo, () => appInfo())
  ipcMain.handle(IPC.windowControl, (_e, action: 'minimize' | 'maximize' | 'close' | 'hide') => {
    const w = getWindow()
    if (!w) return
    if (action === 'minimize') w.minimize()
    else if (action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize()
    else if (action === 'hide') w.hide()
    else w.close()
  })
}
