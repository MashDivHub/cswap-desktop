import type {
  AccountsState,
  AppSettings,
  AutoEvent,
  AutoStatus,
  CommandLogEntry,
  CswapApi,
  ListPayload,
  OAuthState,
  Result,
  WarmState
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

// Browser-only stand-in for the preload API so the renderer can be developed and
// screenshotted with plain `vite`. Mirrors test/fake-cswap's seed data.
export function createMockApi(): CswapApi {
  const iso = (s: number) => new Date(Date.now() + s * 1000).toISOString()
  const win = (p: number, s: number, weekly = false) => ({ pct: p, resetsAt: iso(s), countdown: '', clock: '', ...(weekly ? { expectedPct: 50, aheadOfPace: p > 55, willLastToReset: p < 90 } : {}) })
  let payload: ListPayload = {
    schemaVersion: 1,
    activeAccountNumber: 1,
    accounts: [
      { number: 1, email: 'you@example.com', organizationName: "you@example.com's Organization", organizationUuid: 'org-1', isOrganization: true, active: true, usageStatus: 'ok', alias: 'main', usage: { fiveHour: win(45, 12600), sevenDay: win(12, 180000, true), scoped: [{ name: 'Fable', ...win(17, 180000, true) }] }, usageFetchedAt: iso(-40), usageAgeSeconds: 40 },
      { number: 2, email: 'work@company.com', organizationName: 'Company Inc', organizationUuid: 'org-2', isOrganization: true, active: false, usageStatus: 'ok', usage: { fiveHour: win(100, 1800), sevenDay: win(61, 250000, true), scoped: [{ name: 'Fable', ...win(100, 250000, true) }] }, usageFetchedAt: iso(-300), usageAgeSeconds: 300 },
      { number: 3, email: 'spare@example.com', organizationName: '', organizationUuid: '', isOrganization: false, active: false, usageStatus: 'ok', disabled: true, usage: { fiveHour: win(3, 9000), sevenDay: win(40, 400000, true) }, usageFetchedAt: iso(-900), usageAgeSeconds: 900 },
      { number: 4, email: 'api-key-4@token.local', organizationName: '', organizationUuid: '', isOrganization: false, active: false, usageStatus: 'api_key', usage: null },
      { number: 5, email: 'old@example.com', organizationName: '', organizationUuid: '', isOrganization: false, active: false, usageStatus: 'token_expired', usage: null, lastGoodUsage: { fiveHour: win(88, 3000), sevenDay: win(70, 100000, true) }, lastGoodAgeSeconds: 7200 }
    ]
  }
  let settings: AppSettings = { ...DEFAULT_SETTINGS }
  let auto: AutoStatus = { running: false }
  const autoEvents: AutoEvent[] = []
  const log: CommandLogEntry[] = []
  const listeners: Record<string, Set<(v: unknown) => void>> = {}
  const emit = (ch: string, v: unknown) => listeners[ch]?.forEach((f) => f(v))
  const on = <T,>(ch: string) => (cb: (v: T) => void) => {
    ;(listeners[ch] ??= new Set()).add(cb as (v: unknown) => void)
    return () => listeners[ch]?.delete(cb as (v: unknown) => void)
  }
  const plans = { 'you@example.com': { label: 'Max 5x', tier: 'default_claude_max_5x', subscription: 'max', seenAt: new Date().toISOString() }, 'work@example.com': { label: 'Pro', tier: 'default_claude_pro', subscription: 'pro', seenAt: new Date(Date.now() - 864e5).toISOString() } }
  const state = (): AccountsState => ({ payload, fetchedAt: new Date().toISOString(), refreshing: false, error: null, plans })
  const okOut = (stdout = 'ok'): Result<{ stdout: string; stderr: string; exitCode: number }> => ({ ok: true, value: { stdout, stderr: '', exitCode: 0 } })
  const record = (args: string[]) => {
    const e: CommandLogEntry = { id: log.length + 1, at: new Date().toISOString(), args, exitCode: 0, durationMs: 120, ok: true, stdout: 'ok', stderr: '' }
    log.push(e)
    emit('log', e)
  }
  const setActive = (n: number) => {
    payload = { ...payload, activeAccountNumber: n, accounts: payload.accounts.map((a) => ({ ...a, active: a.number === n })) }
    emit('accounts', state())
  }
  let warm: WarmState = { running: null, lastPingAt: new Date(Date.now() - 40 * 60_000).toISOString(), entries: { 'spare@example.com': { at: new Date(Date.now() - 40 * 60_000).toISOString(), ok: true } } }
  let login: OAuthState | null = null
  const find = (t: string) => payload.accounts.find((a) => String(a.number) === t || a.email === t || a.alias === t)

  return {
    getAccounts: async () => state(),
    refresh: async () => {
      record(['list', '--json'])
      return state()
    },
    getStatus: async () => ({ ok: true, value: { schemaVersion: 1, active: { ...payload.accounts[0], managed: true }, totalManagedAccounts: payload.accounts.length } }),
    switchTo: async (t) => {
      const a = find(t)
      record(['switch', t, '--json'])
      if (!a) return { ok: false, error: { type: 'AccountNotFoundError', message: `No account found with identifier: ${t}` } }
      const from = payload.accounts.find((x) => x.active)!
      setActive(a.number)
      return { ok: true, value: { schemaVersion: 1, switched: from.number !== a.number, from: { number: from.number, email: from.email }, to: { number: a.number, email: a.email }, strategy: 'direct', reason: 'switched', message: `Switched to Account-${a.number} (${a.email})`, warnings: [] } }
    },
    rotate: async (s) => {
      record(['switch', '--json', ...(s ? ['--strategy', s] : [])])
      const en = payload.accounts.filter((a) => !a.disabled)
      const i = en.findIndex((a) => a.active)
      const to = en[(i + 1) % en.length]
      setActive(to.number)
      return { ok: true, value: { schemaVersion: 1, switched: true, from: null, to: { number: to.number, email: to.email }, strategy: s ?? 'rotation', reason: 'switched', message: `Switched to Account-${to.number}`, warnings: [] } }
    },
    addAccount: async (o) => {
      record(['add', ...(o.slot ? ['--slot', String(o.slot)] : [])])
      return okOut('Added Account 6: new@example.com')
    },
    addToken: async (o) => {
      record(['add-token', '-', ...(o.email ? ['--email', o.email] : [])])
      return okOut('Added Account 6')
    },
    removeAccount: async (t) => {
      record(['remove', t])
      const a = find(t)
      payload = { ...payload, accounts: payload.accounts.filter((x) => x !== a) }
      emit('accounts', state())
      return okOut()
    },
    setDisabled: async (t, d) => {
      record([d ? 'disable' : 'enable', t])
      payload = { ...payload, accounts: payload.accounts.map((a) => (a === find(t) ? { ...a, disabled: d || undefined } : a)) }
      emit('accounts', state())
      return okOut()
    },
    setAlias: async (t, al) => {
      record(['alias', t, al ?? '--unset'])
      payload = { ...payload, accounts: payload.accounts.map((a) => (a === find(t) ? { ...a, alias: al ?? undefined } : a)) }
      emit('accounts', state())
      return okOut()
    },
    moveAccount: async (t, s) => {
      record(['move', t, String(s)])
      return okOut()
    },
    swapAccounts: async (a, b) => {
      record(['swap', a, b])
      return okOut()
    },
    listMappings: async () => ({ ok: true, value: [{ path: '/home/you/work/client-app', email: 'work@company.com', account: payload.accounts[1] }, { path: 'D:\\CREATE\\side-project', email: 'gone@example.com' }] }),
    mapDirectory: async (t, p) => {
      record(['map', t, p])
      return okOut()
    },
    unmapDirectory: async (p) => {
      record(['unmap', p])
      return okOut()
    },
    pickDirectory: async () => '/home/you/new-dir',
    getConfig: async () => ({
      ok: true,
      value: {
        schemaVersion: 1,
        path: '/home/you/.local/share/claude-swap/settings.json',
        settings: [
          { key: 'autoswitch.threshold', value: 90, isSet: false },
          { key: 'autoswitch.intervalSeconds', value: 60, isSet: false },
          { key: 'autoswitch.cooldownSeconds', value: 300, isSet: false },
          { key: 'autoswitch.hysteresisPct', value: 10, isSet: false },
          { key: 'autoswitch.strategy', value: 'best', isSet: false },
          { key: 'autoswitch.includeApiKeyAccounts', value: false, isSet: false },
          { key: 'autoswitch.unhealthyTicks', value: 3, isSet: false },
          { key: 'autoswitch.model', value: 'Fable', isSet: true },
          { key: 'ui.theme', value: 'auto', isSet: false }
        ]
      }
    }),
    setConfig: async (k, v) => {
      record(['config', 'set', k, String(v)])
      return okOut()
    },
    exportAccounts: async () => ({ ok: true, value: { path: '/home/you/claude-swap.cswap', output: { stdout: 'Exported 5 accounts', stderr: '', exitCode: 0 } } }),
    importAccounts: async () => ({ ok: true, value: { path: '/home/you/claude-swap.cswap', output: { stdout: 'Imported 0, skipped 5', stderr: '', exitCode: 0 } } }),
    listUnclaimed: async () => ({ ok: true, value: [{ id: 'a1b2c3', slot: '2', reason: 'keychain locked' }] }),
    purgeUnclaimed: async () => okOut(),
    upgradeCswap: async () => okOut('claude-swap is already at the latest version'),
    tokenStatus: async () => okOut('Account-1: you@example.com\n  token: valid (expires in 6h) source=keychain\nAccount-2: work@company.com\n  token: expired'),
    launchSession: async (t, cwd) => ({ ok: true, value: { command: `cswap run ${t}`, cwd: cwd ?? '/home/you' } }),
    oauthStart: async (o) => {
      record(['oauth', o.slot ? `relogin ${o.slot}` : 'add'])
      const id = Math.random().toString(16).slice(2, 10)
      login = { id, stage: 'waiting', url: 'https://claude.com/cai/oauth/authorize?code=true&client_id=mock', manual: !!o.manual, browser: 'chrome', slot: o.slot }
      const mine = login
      // The browser step, played out: the person signs in a moment later.
      setTimeout(() => {
        if (login?.id !== id) return
        login = { ...mine, stage: 'ready', identity: { email: o.email ?? 'new.person@example.com', organizationName: '', organizationUuid: 'org-new', plan: 'Max 20x', existingSlot: o.slot ?? null } }
        emit('oauth', login)
      }, 2500)
      return { ok: true, value: login }
    },
    oauthReopen: async () => ({ ok: true, value: login! }),
    oauthSubmitCode: async () => ({ ok: true, value: login! }),
    oauthCommit: async () => {
      login = { ...login!, stage: 'done', result: { slot: login!.slot ?? 6, output: 'Imported → slot 6' } }
      emit('oauth', login)
      return { ok: true, value: login }
    },
    oauthCancel: async () => {
      login = null
    },
    warmState: async () => warm,
    warmNow: async (t) => {
      record(['run', t ?? 'idle', '--', '-p', 'ok'])
      warm = { ...warm, running: t ? (find(t)?.email ?? null) : 'spare@example.com' }
      emit('warm', warm)
      await new Promise((r) => setTimeout(r, 1200))
      const email = warm.running ?? 'spare@example.com'
      warm = { running: null, lastPingAt: new Date().toISOString(), entries: { ...warm.entries, [email]: { at: new Date().toISOString(), ok: true } } }
      emit('warm', warm)
      return { ok: true, value: { attempted: 1, ok: 1, failed: 0 } }
    },
    updaterState: async () => ({ status: 'disabled', current: '0.0.0-browser' }),
    updaterCheck: async () => ({ status: 'disabled', current: '0.0.0-browser' }),
    updaterInstall: async () => {},
    checkForUpdate: async () => ({ current: '0.1.0', latest: '0.1.0', url: 'https://github.com/TheSkinnyRat/cswap-desktop/releases/latest', updateAvailable: false }),
    autoOnce: async () => ({ ok: true, value: { exitCode: 2, outcome: 'no-action', events: [{ schemaVersion: 1, event: 'no-switch', ts: new Date().toISOString(), reason: 'below-threshold', detail: 'active headroom 55%' }] } }),
    autoStart: async (o) => {
      auto = { running: true, pid: 4242, startedAt: new Date().toISOString(), dryRun: !!o?.dryRun, exitCode: null }
      emit('autoStatus', auto)
      const ev: AutoEvent = { schemaVersion: 1, event: 'poll', ts: new Date().toISOString(), active: { number: 1, email: 'you@example.com' }, headroomPct: { '1': 55, '2': 0, '3': 60 }, threshold: 90, windowsPct: { '1': { '5h': 45, '7d': 12 }, '2': { '5h': 100, '7d': 61 } } }
      autoEvents.push(ev)
      emit('autoEvent', ev)
      return auto
    },
    autoStop: async () => {
      auto = { running: false, exitCode: 0 }
      emit('autoStatus', auto)
      return auto
    },
    autoStatus: async () => auto,
    autoEvents: async () => autoEvents,
    getSettings: async () => settings,
    setSettings: async (p) => {
      settings = { ...settings, ...p }
      emit('settings', settings)
      return settings
    },
    getBinaryInfo: async () => ({ path: '/home/you/.local/bin/cswap', source: 'uv', version: '0.25.0', candidates: [] }),
    detectBinary: async () => ({ path: '/home/you/.local/bin/cswap', source: 'uv', version: '0.25.0', candidates: [] }),
    pickBinary: async () => null,
    installCswap: async () => okOut('installed'),
    getCommandLog: async () => log,
    clearCommandLog: async () => {
      log.length = 0
    },
    getVaultPath: async () => '/home/you/.local/share/claude-swap',
    openPath: async () => {},
    openExternal: async (u) => {
      window.open(u, '_blank')
    },
    getAppInfo: async () => ({ version: '0.0.0-browser', platform: 'linux', electron: '' }),
    windowControl: async () => {},
    onAccounts: on('accounts'),
    onAutoEvent: on('autoEvent'),
    onAutoStatus: on('autoStatus'),
    onCommandLog: on('log'),
    onSettings: on('settings'),
    onNavigate: on('navigate'),
    onUpdater: on('updater'),
    onBinary: on('binary'),
    onOAuth: on('oauth'),
    onWarm: on('warm')
  }
}
