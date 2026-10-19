import { EventEmitter } from 'node:events'
import type { Account, AppSettings, OAuthCommitOptions, OAuthStartOptions, OAuthState, PlainOutput, Result } from '@shared/types'
import { openInBrowser } from './browser'
import type { CswapDriver } from './cswap/driver'
import { buildEnvelope, LoginSession, type Fetch } from './oauth'

export interface LoginDeps {
  driver: CswapDriver
  accounts: () => Account[]
  settings: () => AppSettings
  refresh: () => Promise<unknown>
  fetch: Fetch
  /** Opens a URL in the system default browser. */
  openDefault: (url: string) => void
  now?: () => number
}

const sameIdentity = (a: Account, email: string, org: string): boolean => a.email.toLowerCase() === email.toLowerCase() && (a.organizationUuid || '') === org

export function lowestFreeSlot(accounts: Account[]): number {
  const taken = new Set(accounts.map((a) => a.number))
  let n = 1
  while (taken.has(n)) n++
  return n
}

// Which slot `cswap import` put it in, from what the CLI printed.
export function slotFromImportOutput(text: string): number | null {
  const m = text.match(/Imported .*? → slot (\d+)/) ?? text.match(/Overwrote .*? \(slot (\d+)\)/) ?? text.match(/Replaced .*? \(slot (\d+)/)
  return m ? Number(m[1]) : null
}

// One browser sign-in at a time: opens the page, waits for the code, then — once the
// person is known — writes the login into the vault through `cswap import`. The live
// Claude Code login is never read or written, so terminals mid-task are unaffected.
export class LoginManager extends EventEmitter {
  private session: LoginSession | null = null
  private opened: 'chrome' | 'default' | null = null
  private slot: number | undefined
  private commitError: string | undefined
  private result: OAuthState['result']

  constructor(private deps: LoginDeps) {
    super()
  }

  async start(o: OAuthStartOptions): Promise<Result<OAuthState>> {
    this.discard()
    const session = new LoginSession({ fetch: this.deps.fetch, manual: o.manual, loginHint: o.email, now: this.deps.now })
    try {
      await session.start()
    } catch (e) {
      session.dispose()
      return { ok: false, error: { type: 'ListenError', message: `Could not listen for the browser on this machine: ${(e as Error).message}` } }
    }
    this.session = session
    this.slot = o.slot
    this.commitError = undefined
    this.result = undefined
    session.on('change', () => this.emit('state', this.state()))
    this.opened = this.open(session)
    return { ok: true, value: this.state() }
  }

  reopen(id: string): Result<OAuthState> {
    const s = this.take(id)
    if (!s) return gone()
    this.opened = this.open(s)
    return { ok: true, value: this.state() }
  }

  async submitCode(id: string, text: string): Promise<Result<OAuthState>> {
    const s = this.take(id)
    if (!s) return gone()
    await s.submit(text)
    return { ok: true, value: this.state() }
  }

  cancel(id: string): void {
    if (this.session?.id === id) this.discard()
  }

  state(): OAuthState {
    const s = this.session
    if (!s) return { id: '', stage: 'cancelled', url: '', manual: false, browser: null }
    const snap = s.snapshot()
    const out: OAuthState = { id: s.id, stage: snap.stage, url: snap.url, manual: snap.manual, browser: this.opened, slot: this.slot, error: this.commitError ?? snap.error, result: this.result }
    if (snap.account) {
      const existing = this.deps.accounts().find((a) => sameIdentity(a, snap.account!.email, snap.account!.organizationUuid))
      out.identity = { email: snap.account.email, organizationName: snap.account.organizationName, organizationUuid: snap.account.organizationUuid, plan: snap.account.plan, existingSlot: existing?.number ?? null }
      out.mismatch = this.slot !== undefined && existing?.number !== this.slot
    }
    return out
  }

  async commit(id: string, o: OAuthCommitOptions): Promise<Result<OAuthState>> {
    const s = this.take(id)
    if (!s) return gone()
    const snap = s.snapshot()
    if (snap.stage !== 'ready' || !snap.account) return { ok: false, error: { type: 'NotReady', message: 'The sign-in has not finished yet.' } }
    const st = this.state()
    if (st.mismatch && !o.asNew) {
      return { ok: false, error: { type: 'IdentityMismatch', message: `You signed in as ${snap.account.email}, which is not the account in slot ${this.slot}.` } }
    }
    this.commitError = undefined
    s.setStage('committing')

    const accounts = this.deps.accounts()
    const existing = accounts.find((a) => sameIdentity(a, snap.account!.email, snap.account!.organizationUuid))
    const number = existing?.number ?? lowestFreeSlot(accounts)
    // An overwrite rewrites the whole record, so what it carried has to be put back.
    const alias = o.alias?.trim() || existing?.alias
    const envelope = buildEnvelope(snap.account, number, alias, (this.deps.now ?? Date.now)())
    const r = await this.deps.driver.importEnvelope(JSON.stringify(envelope), !!existing)
    if (!r.ok) {
      this.commitError = r.error.message
      s.setStage('ready') // the tokens are still here — retry without signing in again
      return { ok: false, error: r.error }
    }
    const text = `${r.value.stdout}\n${r.value.stderr}`
    if (/Skipped /.test(text) && !/Imported |Overwrote |Replaced /.test(text)) {
      this.commitError = 'cswap skipped the account instead of storing it.'
      s.setStage('ready')
      return { ok: false, error: { type: 'ImportSkipped', message: this.commitError } }
    }
    s.release()
    let slot = slotFromImportOutput(text)
    if (slot === null) {
      await this.deps.refresh()
      slot = this.deps.accounts().find((a) => sameIdentity(a, snap.account!.email, snap.account!.organizationUuid))?.number ?? null
    }
    if (existing?.disabled && slot !== null) await this.deps.driver.setDisabled(String(slot), true)
    const note = text.split(/\r?\n/).find((l) => l.startsWith('Note:'))
    this.result = { slot, output: summarize(r.value), note }
    s.setStage('done')
    void this.deps.refresh()
    return { ok: true, value: this.state() }
  }

  private open(s: LoginSession): 'chrome' | 'default' {
    const cfg = this.deps.settings()
    return openInBrowser(s.url, { browser: cfg.loginBrowser, privateWindow: cfg.loginPrivate }, this.deps.openDefault)
  }

  private take(id: string): LoginSession | null {
    return this.session && this.session.id === id ? this.session : null
  }

  private discard(): void {
    const s = this.session
    this.session = null
    if (!s) return
    s.cancel()
    s.dispose()
  }

  dispose(): void {
    this.discard()
  }
}

const gone = (): Result<OAuthState> => ({ ok: false, error: { type: 'Gone', message: 'That sign-in is no longer active. Start it again.' } })

function summarize(out: PlainOutput): string {
  const lines = `${out.stderr}\n${out.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(Imported|Overwrote|Replaced)/.test(l))
  return lines[0] ?? 'Stored'
}
