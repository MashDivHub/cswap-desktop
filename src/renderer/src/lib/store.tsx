import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AccountsState, AppSettings, AutoEvent, AutoStatus, CommandLogEntry, CswapBinaryInfo, UpdaterState, WarmState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api } from './api'

export type Page = 'accounts' | 'auto' | 'mappings' | 'log' | 'settings'

interface Store {
  accounts: AccountsState
  settings: AppSettings
  binary: CswapBinaryInfo | null
  auto: AutoStatus
  autoEvents: AutoEvent[]
  log: CommandLogEntry[]
  updater: UpdaterState
  warm: WarmState
  page: Page
  setPage: (p: Page) => void
  refresh: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  redetect: () => Promise<void>
  now: number
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [accounts, setAccounts] = useState<AccountsState>({ payload: null, fetchedAt: null, refreshing: true, error: null })
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [binary, setBinary] = useState<CswapBinaryInfo | null>(null)
  const [auto, setAuto] = useState<AutoStatus>({ running: false })
  const [autoEvents, setAutoEvents] = useState<AutoEvent[]>([])
  const [log, setLog] = useState<CommandLogEntry[]>([])
  const [updater, setUpdater] = useState<UpdaterState>({ status: 'disabled', current: '' })
  const [warm, setWarm] = useState<WarmState>({ running: null, lastPingAt: null, entries: {} })
  const [page, setPage] = useState<Page>('accounts')
  const [now, setNow] = useState(Date.now())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void api.getAccounts().then((s) => mounted.current && setAccounts(s))
    void api.getSettings().then((s) => mounted.current && setSettings(s))
    void api.getBinaryInfo().then((b) => mounted.current && setBinary(b))
    void api.autoStatus().then((a) => mounted.current && setAuto(a))
    void api.autoEvents().then((e) => mounted.current && setAutoEvents(e))
    void api.getCommandLog().then((l) => mounted.current && setLog(l))
    void api.updaterState().then((u) => mounted.current && setUpdater(u))
    void api.warmState().then((w) => mounted.current && setWarm(w))
    const offs = [
      api.onAccounts((s) => setAccounts(s)),
      api.onSettings((s) => setSettings(s)),
      api.onAutoStatus((a) => setAuto(a)),
      api.onAutoEvent((e) => setAutoEvents((prev) => [...prev.slice(-499), e])),
      api.onCommandLog((e) => setLog((prev) => [...prev.slice(-299), e])),
      api.onNavigate((p) => setPage(p as Page)),
      api.onUpdater((u) => setUpdater(u)),
      api.onBinary((b) => setBinary(b)),
      api.onWarm((w) => setWarm(w))
    ]
    const t = setInterval(() => setNow(Date.now()), 15000)
    return () => {
      mounted.current = false
      offs.forEach((f) => f())
      clearInterval(t)
    }
  }, [])

  const refresh = useCallback(async () => {
    setAccounts((s) => ({ ...s, refreshing: true }))
    const s = await api.refresh()
    setAccounts(s)
  }, [])
  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings((s) => ({ ...s, ...patch }))
    const s = await api.setSettings(patch)
    setSettings(s)
  }, [])
  const redetect = useCallback(async () => {
    setBinary(await api.detectBinary())
  }, [])

  const value = useMemo<Store>(
    () => ({ accounts, settings, binary, auto, autoEvents, log, updater, warm, page, setPage, refresh, updateSettings, redetect, now }),
    [accounts, settings, binary, auto, autoEvents, log, updater, warm, page, refresh, updateSettings, redetect, now]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('StoreProvider missing')
  return s
}

// Applies the theme class to <html>. 'system' follows the OS.
export function useTheme(theme: AppSettings['theme']): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}
