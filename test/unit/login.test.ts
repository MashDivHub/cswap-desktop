import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CswapDriver } from '../../src/main/cswap/driver'
import { lowestFreeSlot, LoginManager, slotFromImportOutput } from '../../src/main/login'
import { endpoints, type Fetch } from '../../src/main/oauth'
import { DEFAULT_SETTINGS, type Account, type OAuthState } from '@shared/types'

const ROOT = resolve(__dirname, '..', '..')
const FAKE = process.platform === 'win32' ? join(ROOT, 'test', 'fake-cswap', 'fake-cswap.cmd') : join(ROOT, 'test', 'fake-cswap', 'fake-cswap.mjs')

let dir: string
let statePath: string
const state = (): { accounts: Record<string, Record<string, unknown>>; log: string[][]; lastImport?: { force: boolean; accounts: string[] } } => JSON.parse(readFileSync(statePath, 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cswap-login-'))
  statePath = join(dir, 'state.json')
  process.env.FAKE_CSWAP_STATE = statePath
  process.env.CSWAP_DESKTOP_TEST_NO_SPAWN = '1'
})
// LoginManager refreshes the list in the background once it is done; let that finish
// before the scratch directory goes, or the fake CLI recreates it.
const pending = new Set<Promise<unknown>>()
afterEach(async () => {
  while (pending.size) await Promise.all([...pending])
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CSWAP_DESKTOP_TEST_NO_SPAWN
})

const SECRET_ACCESS = 'sk-ant-oat01-SECRET-ACCESS-TOKEN'
const SECRET_REFRESH = 'sk-ant-ort01-SECRET-REFRESH-TOKEN'

// Anthropic, as far as this test is concerned: whoever `who` is signs in.
function anthropic(who: { email: string; org: string }): Fetch {
  return async (url) => {
    const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
    if (url === endpoints().token) return ok({ access_token: SECRET_ACCESS, refresh_token: SECRET_REFRESH, expires_in: 28800, scope: 'user:inference user:profile' })
    if (url === endpoints().profile) {
      return ok({ account: { uuid: `uuid-${who.email}`, email: who.email }, organization: { uuid: who.org, name: who.email, organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } })
    }
    return { ok: false, status: 404, text: async () => '{}' }
  }
}

async function harness(who: { email: string; org: string }, seed?: object): Promise<{ d: CswapDriver; m: LoginManager; accounts: () => Account[]; opened: string[]; states: OAuthState[] }> {
  if (seed) writeFileSync(statePath, JSON.stringify(seed))
  const d = new CswapDriver()
  d.setBinary(FAKE)
  let accounts: Account[] = []
  const refresh = (): Promise<void> => {
    const p = (async (): Promise<void> => {
      const r = await d.list()
      if (r.ok) accounts = r.value.accounts
    })()
    pending.add(p)
    void p.finally(() => pending.delete(p))
    return p
  }
  await refresh()
  const opened: string[] = []
  const m = new LoginManager({ driver: d, accounts: () => accounts, settings: () => ({ ...DEFAULT_SETTINGS }), refresh, fetch: anthropic(who), openDefault: (u) => opened.push(u) })
  const states: OAuthState[] = []
  m.on('state', (s: OAuthState) => states.push(s))
  return { d, m, accounts: () => accounts, opened, states }
}

// The browser coming back: what Anthropic's redirect does after the person signs in.
async function comeBack(st: OAuthState): Promise<void> {
  const u = new URL(st.url)
  await globalThis.fetch(`${u.searchParams.get('redirect_uri')}?code=CODE&state=${u.searchParams.get('state')}`)
}
const until = async (m: LoginManager, stage: string): Promise<OAuthState> => {
  for (let i = 0; i < 100; i++) {
    if (m.state().stage === stage) return m.state()
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`never reached ${stage}; at ${m.state().stage} (${m.state().error})`)
}

describe('LoginManager', () => {
  it('adds a brand-new account without ever touching the live login', async () => {
    const h = await harness({ email: 'new.person@example.com', org: 'org-new' })
    const r = await h.m.start({})
    expect(r.ok).toBe(true)
    const st = r.ok ? r.value : null
    expect(st?.stage).toBe('waiting')
    expect(st?.browser).toBe('chrome')
    await comeBack(st!)
    const ready = await until(h.m, 'ready')
    expect(ready.identity).toMatchObject({ email: 'new.person@example.com', plan: 'Max 20x', existingSlot: null })
    expect(ready.mismatch).toBe(false)

    const c = await h.m.commit(ready.id, { alias: 'fresh' })
    expect(c.ok && c.value.stage).toBe('done')
    expect(c.ok && c.value.result?.slot).toBe(5)
    const added = state().accounts['5']
    expect(added).toMatchObject({ email: 'new.person@example.com', organizationUuid: 'org-new', alias: 'fresh', loginArrived: true })

    // Everything the app ran was a cswap call; none of them was a switch, an `add`
    // from the live login, or anything else that reads or writes ~/.claude.
    const verbs = state().log.map((a) => a[0])
    expect(verbs).toContain('import')
    expect(verbs).not.toContain('switch')
    expect(verbs).not.toContain('add')
    expect(state().lastImport).toEqual({ force: false, accounts: ['new.person@example.com'] })
    // …and the tokens went over stdin, not argv.
    expect(JSON.stringify(state().log)).not.toContain('SECRET')
    expect(JSON.stringify(h.d.getLog().map((e) => e.args))).not.toContain('SECRET')
    expect(h.d.getLog().find((e) => e.args[0] === 'import')?.args).toEqual(['import', '-'])
    h.m.dispose()
  })

  it('fixes a dead login in place: same slot, forced, alias kept', async () => {
    const h = await harness(
      { email: 'work@company.com', org: 'org-2222' },
      {
        version: '0.25.0',
        activeAccountNumber: 1,
        accounts: {
          1: { email: 'you@example.com', organizationName: '', organizationUuid: 'org-1111', usage: { five_hour: 45, seven_day: 12 } },
          2: { email: 'work@company.com', organizationName: 'Company Inc', organizationUuid: 'org-2222', alias: 'work', usageStatus: 'relogin_required' }
        },
        sequence: [1, 2],
        mappings: {},
        settings: {},
        unclaimed: {},
        liveIdentity: 'you@example.com',
        log: []
      }
    )
    expect(h.accounts()[1].usageStatus).toBe('relogin_required')
    const r = await h.m.start({ slot: 2, email: 'work@company.com' })
    const st = r.ok ? r.value : null
    expect(new URL(st!.url).searchParams.get('login_hint')).toBe('work@company.com')
    await comeBack(st!)
    const ready = await until(h.m, 'ready')
    expect(ready.identity?.existingSlot).toBe(2)
    expect(ready.mismatch).toBe(false)

    const c = await h.m.commit(ready.id, {})
    expect(c.ok && c.value.result?.slot).toBe(2)
    expect(state().lastImport?.force).toBe(true)
    expect(state().accounts['2']).toMatchObject({ alias: 'work', loginArrived: true })
    expect(state().accounts['2'].usageStatus).toBeUndefined() // healthy again
    expect(state().accounts['1']).not.toHaveProperty('loginArrived') // the live account was left alone
    h.m.dispose()
  })

  it('puts back the hold an overwrite would drop', async () => {
    const h = await harness(
      { email: 'spare@example.com', org: '' },
      { version: '0.25.0', activeAccountNumber: 1, accounts: { 1: { email: 'you@example.com', organizationUuid: 'org-1111', usage: { five_hour: 1, seven_day: 1 } }, 2: { email: 'spare@example.com', organizationUuid: '', disabled: true, usageStatus: 'token_expired' } }, sequence: [1, 2], mappings: {}, settings: {}, unclaimed: {}, liveIdentity: 'you@example.com', log: [] }
    )
    const st = (await h.m.start({ slot: 2 })) as { ok: true; value: OAuthState }
    await comeBack(st.value)
    await until(h.m, 'ready')
    await h.m.commit(st.value.id, {})
    expect(state().accounts['2'].disabled).toBe(true)
    h.m.dispose()
  })

  it('stops a re-login that landed on someone else, and changes nothing', async () => {
    const h = await harness({ email: 'someone.else@example.com', org: 'org-x' })
    const st = (await h.m.start({ slot: 2, email: 'work@company.com' })) as { ok: true; value: OAuthState }
    await comeBack(st.value)
    const ready = await until(h.m, 'ready')
    expect(ready.mismatch).toBe(true)
    const before = JSON.stringify(state().accounts)
    const c = await h.m.commit(ready.id, {})
    expect(!c.ok && c.error.type).toBe('IdentityMismatch')
    expect(JSON.stringify(state().accounts)).toBe(before)
    expect(state().log.map((a) => a[0])).not.toContain('import')

    // …but the person can choose to keep what they signed in with, as a new account.
    const kept = await h.m.commit(ready.id, { asNew: true })
    expect(kept.ok && kept.value.result?.slot).toBe(5)
    expect(state().accounts['5'].email).toBe('someone.else@example.com')
    expect(state().accounts['2'].email).toBe('work@company.com')
    h.m.dispose()
  })

  it('signing in as an account that is already managed refreshes it instead of duplicating', async () => {
    const h = await harness({ email: 'spare@example.com', org: '' })
    const st = (await h.m.start({})) as { ok: true; value: OAuthState }
    await comeBack(st.value)
    const ready = await until(h.m, 'ready')
    expect(ready.identity?.existingSlot).toBe(3)
    const c = await h.m.commit(ready.id, {})
    expect(c.ok && c.value.result?.slot).toBe(3)
    expect(Object.values(state().accounts).filter((a) => a.email === 'spare@example.com')).toHaveLength(1)
    expect(state().lastImport?.force).toBe(true)
    h.m.dispose()
  })

  it('keeps the login for a retry when cswap fails to store it', async () => {
    const h = await harness({ email: 'new.person@example.com', org: 'org-new' })
    const st = (await h.m.start({})) as { ok: true; value: OAuthState }
    await comeBack(st.value)
    const ready = await until(h.m, 'ready')
    process.env.FAKE_CSWAP_FAIL = 'import'
    const bad = await h.m.commit(ready.id, {})
    delete process.env.FAKE_CSWAP_FAIL
    expect(bad.ok).toBe(false)
    expect(h.m.state().stage).toBe('ready')
    expect(h.m.state().error).toMatch(/forced failure/)
    const retry = await h.m.commit(ready.id, {})
    expect(retry.ok && retry.value.stage).toBe('done')
    expect(h.m.state().error).toBeUndefined()
    h.m.dispose()
  })

  it('a new sign-in replaces the one before it, and a stale id is refused', async () => {
    const h = await harness({ email: 'a@example.com', org: 'o' })
    const first = (await h.m.start({})) as { ok: true; value: OAuthState }
    const second = (await h.m.start({})) as { ok: true; value: OAuthState }
    expect(second.value.id).not.toBe(first.value.id)
    const stale = await h.m.commit(first.value.id, {})
    expect(!stale.ok && stale.error.type).toBe('Gone')
    h.m.cancel(second.value.id)
    expect(h.m.state().stage).toBe('cancelled')
    h.m.dispose()
  })

  it('reopen hands the page to the browser again', async () => {
    const h = await harness({ email: 'a@example.com', org: 'o' })
    const st = (await h.m.start({})) as { ok: true; value: OAuthState }
    expect(h.m.reopen(st.value.id).ok).toBe(true)
    expect(h.m.reopen('nope').ok).toBe(false)
    h.m.dispose()
  })
})

describe('helpers', () => {
  it('lowestFreeSlot fills gaps', () => {
    const a = (n: number) => ({ number: n }) as Account
    expect(lowestFreeSlot([])).toBe(1)
    expect(lowestFreeSlot([a(1), a(2), a(4)])).toBe(3)
  })
  it('slotFromImportOutput reads the three outcomes', () => {
    expect(slotFromImportOutput('Imported me@x.com → slot 6\nDone: 1 imported')).toBe(6)
    expect(slotFromImportOutput('Overwrote me@x.com (slot 2)')).toBe(2)
    expect(slotFromImportOutput('Replaced me@x.com (slot 9 was quarantined: refresh token dead)')).toBe(9)
    expect(slotFromImportOutput('Skipped me@x.com (already exists, use --force)')).toBeNull()
  })
})
