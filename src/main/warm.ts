import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, AccountsState, AppSettings, Result, WarmEntry, WarmState, WarmSummary } from '@shared/types'
import type { CswapDriver } from './cswap/driver'

// A 5-hour window starts with the first message and runs for five hours. An account that
// nobody touched has no window at all, so the day it is finally needed it has the full five
// hours to wait out. Sending one tiny message to every idle account starts those windows
// ahead of time — and spreading the messages out spreads the resets, so there is nearly
// always an account about to roll over. Every ping goes through `cswap run` (session mode):
// a separate profile, so the live login and whatever terminal is using it stay as they are.

const HOUR = 3600_000
const WINDOW = 5 * HOUR
// After a successful ping the usage numbers can lag (cswap polls idle accounts rarely), so
// an account pinged recently is taken as warm whatever the list still says.
const TRUST_PING_FOR = WINDOW - 15 * 60_000
const RETRY_AFTER_FAILURE = 30 * 60_000
// e2e shortens the cadence; nothing else sets this.
const TICK_MS = Number(process.env.CSWAP_DESKTOP_WARM_TICK_MS) || 60_000
// Weekly quota that is already gone cannot start anything — the ping would just be refused.
const WEEKLY_FULL = 99.5

export function windowIdle(a: Account, now: number): boolean {
  const u = a.usage
  if (!u) return false // no measurement is not the same as an idle window
  const w = u.fiveHour
  if (!w) return !!u.sevenDay // the usage call worked and reported no 5-hour window
  if (w.resetsAt) {
    const t = Date.parse(w.resetsAt)
    return Number.isFinite(t) && t <= now
  }
  return w.pct <= 0
}

export function whyNot(a: Account, s: Pick<AppSettings, 'keepWarmExclude'>, entry: WarmEntry | undefined, now: number): string | null {
  if (a.active) return 'active'
  if (a.disabled) return 'disabled'
  if (a.usageStatus !== 'ok') return a.usageStatus
  if (s.keepWarmExclude.some((e) => e.toLowerCase() === a.email.toLowerCase())) return 'excluded'
  if ((a.usage?.sevenDay?.pct ?? 0) >= WEEKLY_FULL) return 'weekly-exhausted'
  if (!windowIdle(a, now)) return 'running'
  if (entry) {
    const age = now - Date.parse(entry.at)
    if (entry.ok && age < TRUST_PING_FOR) return 'just-warmed'
    if (!entry.ok && age < RETRY_AFTER_FAILURE) return 'backing-off'
  }
  return null
}

// Idle accounts worth pinging, the ones with the most weekly quota left first.
export function warmCandidates(accounts: Account[], settings: Pick<AppSettings, 'keepWarmExclude'>, entries: Record<string, WarmEntry>, now: number): Account[] {
  return accounts
    .filter((a) => whyNot(a, settings, entries[a.email], now) === null)
    .sort((x, y) => (x.usage?.sevenDay?.pct ?? 0) - (y.usage?.sevenDay?.pct ?? 0) || x.number - y.number)
}

export interface WarmDeps {
  driver: CswapDriver
  accounts: () => AccountsState
  refresh: () => Promise<AccountsState>
  settings: () => AppSettings
  userData: string
  now?: () => number
}

export class WarmScheduler extends EventEmitter {
  private data: WarmState = { running: null, lastPingAt: null, entries: {} }
  private file: string
  private dir: string
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private now: () => number

  constructor(private deps: WarmDeps) {
    super()
    this.now = deps.now ?? Date.now
    this.file = join(deps.userData, 'warm.json')
    this.dir = join(deps.userData, 'warm')
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<WarmState>
        this.data = { running: null, lastPingAt: raw.lastPingAt ?? null, entries: raw.entries ?? {} }
      }
    } catch {
      /* a damaged file just means nothing is remembered */
    }
  }

  getState(): WarmState {
    return { ...this.data, entries: { ...this.data.entries } }
  }

  // Called at start and whenever the settings change.
  configure(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!this.deps.settings().keepWarm) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    setTimeout(() => void this.tick(), Math.min(20_000, TICK_MS)).unref?.()
  }

  // One look at the accounts: ping at most one idle account, and not sooner than the
  // stagger after the last ping, so the windows (and their resets) end up spread out.
  async tick(): Promise<void> {
    const s = this.deps.settings()
    if (!s.keepWarm || this.busy || !this.deps.driver.getBinary()) return
    this.busy = true
    try {
      const state = this.deps.accounts()
      // Judging from old numbers would ping accounts that have been used since.
      const age = state.fetchedAt ? this.now() - Date.parse(state.fetchedAt) : Infinity
      const fresh = age < 10 * 60_000 ? state : await this.deps.refresh()
      if (!fresh.payload) return
      const gap = s.keepWarmStaggerMin * 60_000
      const last = this.data.lastPingAt ? Date.parse(this.data.lastPingAt) : 0
      if (gap > 0 && this.now() - last < gap) return
      const next = warmCandidates(fresh.payload.accounts, s, this.data.entries, this.now())[0]
      if (next) await this.ping(next)
    } finally {
      this.busy = false
    }
  }

  // A named account is pinged whatever its window looks like; with no name, every idle
  // one is, one after the other, without waiting for the stagger.
  async warmNow(target?: string): Promise<Result<WarmSummary>> {
    if (this.busy) return { ok: false, error: { type: 'Busy', message: 'A warm-up is already running.' } }
    if (!this.deps.driver.getBinary()) return { ok: false, error: { type: 'NotFound', message: 'cswap is not installed or not found' } }
    this.busy = true
    try {
      const state = await this.deps.refresh()
      const accounts = state.payload?.accounts ?? []
      let list: Account[]
      if (target) {
        const a = accounts.find((x) => String(x.number) === target || x.email === target || x.alias === target)
        if (!a) return { ok: false, error: { type: 'AccountNotFoundError', message: `No account found with identifier: ${target}` } }
        if (a.active) return { ok: false, error: { type: 'Active', message: 'This is the account your terminals are using, so its window starts with your next message anyway.' } }
        list = [a]
      } else {
        list = warmCandidates(accounts, this.deps.settings(), this.data.entries, this.now())
      }
      const summary: WarmSummary = { attempted: 0, ok: 0, failed: 0 }
      for (const a of list) {
        summary.attempted++
        if (await this.ping(a)) summary.ok++
        else summary.failed++
      }
      return { ok: true, value: summary }
    } finally {
      this.busy = false
    }
  }

  // The caller holds `busy` for the whole run.
  private async ping(a: Account): Promise<boolean> {
    this.data.running = a.email
    this.emit('state', this.getState())
    let entry: WarmEntry
    try {
      mkdirSync(this.dir, { recursive: true })
      const r = await this.deps.driver.warmUp(String(a.number), this.deps.settings().keepWarmModel || 'haiku', this.dir)
      entry = r.ok ? { at: new Date(this.now()).toISOString(), ok: true } : { at: new Date(this.now()).toISOString(), ok: false, message: r.error.message }
    } catch (e) {
      entry = { at: new Date(this.now()).toISOString(), ok: false, message: (e as Error).message }
    }
    this.data.entries[a.email] = entry
    this.data.lastPingAt = entry.at
    this.data.running = null
    this.save()
    this.emit('state', this.getState())
    void this.deps.refresh()
    return entry.ok
  }

  private save(): void {
    try {
      mkdirSync(this.deps.userData, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ lastPingAt: this.data.lastPingAt, entries: this.data.entries }, null, 2))
      renameSync(tmp, this.file)
    } catch {
      /* remembering is a convenience, never a failure */
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
