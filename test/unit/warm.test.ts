import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CswapDriver, parseWarmReply, warmArgs } from '../../src/main/cswap/driver'
import { warmCandidates, whyNot, windowIdle, WarmScheduler } from '../../src/main/warm'
import { DEFAULT_SETTINGS, type Account, type AccountsState, type AppSettings, type WarmEntry } from '@shared/types'

const ROOT = resolve(__dirname, '..', '..')
const FAKE = process.platform === 'win32' ? join(ROOT, 'test', 'fake-cswap', 'fake-cswap.cmd') : join(ROOT, 'test', 'fake-cswap', 'fake-cswap.mjs')

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)
const iso = (ms: number): string => new Date(ms).toISOString()
const H = 3600_000

function acct(n: number, over: Partial<Account> = {}): Account {
  return { number: n, email: `u${n}@example.com`, organizationName: '', organizationUuid: '', isOrganization: false, active: false, usageStatus: 'ok', usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 10 + n } }, ...over }
}
const settings = (over: Partial<AppSettings> = {}): AppSettings => ({ ...DEFAULT_SETTINGS, keepWarm: true, keepWarmStaggerMin: 0, ...over })

describe('windowIdle', () => {
  it('an idle window is one with no reset time, or whose reset has passed', () => {
    expect(windowIdle(acct(1), NOW)).toBe(true)
    expect(windowIdle(acct(1, { usage: { fiveHour: { pct: 0, resetsAt: iso(NOW - 60_000) }, sevenDay: { pct: 5 } } }), NOW)).toBe(true)
  })
  it('a window that is running, with or without usage on it, is not idle', () => {
    expect(windowIdle(acct(1, { usage: { fiveHour: { pct: 0, resetsAt: iso(NOW + 2 * H) }, sevenDay: { pct: 5 } } }), NOW)).toBe(false)
    expect(windowIdle(acct(1, { usage: { fiveHour: { pct: 40, resetsAt: iso(NOW + 2 * H) }, sevenDay: { pct: 5 } } }), NOW)).toBe(false)
    expect(windowIdle(acct(1, { usage: { fiveHour: { pct: 40 }, sevenDay: { pct: 5 } } }), NOW)).toBe(false)
  })
  it('an account with no measurement is unknown, never "idle"', () => {
    expect(windowIdle(acct(1, { usage: null }), NOW)).toBe(false)
  })
  it('a usage reading with no 5-hour window at all counts as idle when the weekly one came through', () => {
    expect(windowIdle(acct(1, { usage: { sevenDay: { pct: 5 } } }), NOW)).toBe(true)
    expect(windowIdle(acct(1, { usage: {} }), NOW)).toBe(false)
  })
})

describe('whyNot / warmCandidates', () => {
  const s = { keepWarmExclude: [] as string[] }
  it('skips the account in use, held-out ones, ones that need a login, and left-out ones', () => {
    expect(whyNot(acct(1, { active: true }), s, undefined, NOW)).toBe('active')
    expect(whyNot(acct(1, { disabled: true }), s, undefined, NOW)).toBe('disabled')
    expect(whyNot(acct(1, { usageStatus: 'relogin_required', usage: null }), s, undefined, NOW)).toBe('relogin_required')
    expect(whyNot(acct(1, { usageStatus: 'api_key', usage: null }), s, undefined, NOW)).toBe('api_key')
    expect(whyNot(acct(1), { keepWarmExclude: ['U1@example.com'] }, undefined, NOW)).toBe('excluded')
  })
  it('skips an account with no weekly quota left — the ping would only be refused', () => {
    expect(whyNot(acct(1, { usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 100 } } }), s, undefined, NOW)).toBe('weekly-exhausted')
    expect(whyNot(acct(1, { usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 99 } } }), s, undefined, NOW)).toBeNull()
  })
  it('trusts a recent successful ping over a list that has not caught up, and backs off after a failure', () => {
    const ok: WarmEntry = { at: iso(NOW - 2 * H), ok: true }
    expect(whyNot(acct(1), s, ok, NOW)).toBe('just-warmed')
    expect(whyNot(acct(1), s, { at: iso(NOW - 5 * H), ok: true }, NOW)).toBeNull() // a whole window ago: due again
    const bad: WarmEntry = { at: iso(NOW - 10 * 60_000), ok: false, message: 'x' }
    expect(whyNot(acct(1), s, bad, NOW)).toBe('backing-off')
    expect(whyNot(acct(1), s, { ...bad, at: iso(NOW - 45 * 60_000) }, NOW)).toBeNull()
  })
  it('orders candidates by weekly quota left, then slot', () => {
    const list = [acct(1, { usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 80 } } }), acct(2, { usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 10 } } }), acct(3, { usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 10 } } }), acct(4, { active: true })]
    expect(warmCandidates(list, s, {}, NOW).map((a) => a.number)).toEqual([2, 3, 1])
  })
})

describe('driver pieces', () => {
  it('the ping is one short question, one turn, no tools, no transcript', () => {
    const args = warmArgs('haiku')
    expect(args).toEqual(['-p', 'Reply with the single word: ok', '--model', 'haiku', '--max-turns', '1', '--output-format', 'json', '--no-session-persistence', '--tools', ''])
  })
  it('parseWarmReply finds the JSON line after the "Launching" banner', () => {
    expect(parseWarmReply('Launching Account-2 (a@b.c) [session mode]\n{"type":"result","is_error":false,"result":"ok"}\n')).toEqual({ isError: false, text: 'ok' })
    expect(parseWarmReply('{"type":"result","is_error":true,"result":"Weekly limit reached"}')).toEqual({ isError: true, text: 'Weekly limit reached' })
    expect(parseWarmReply('Launching…\nnot json at all')).toBeNull()
  })
})

describe('WarmScheduler', () => {
  let dir: string
  let statePath: string
  const fakeState = (): { accounts: Record<string, Record<string, unknown>>; log: string[][] } => JSON.parse(readFileSync(statePath, 'utf8'))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cswap-warm-'))
    statePath = join(dir, 'state.json')
    process.env.FAKE_CSWAP_STATE = statePath
    delete process.env.FAKE_CSWAP_RUN_FAIL
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.FAKE_CSWAP_RUN_FAIL
  })

  // Account 1 is in use; 2 and 3 are idle; 4 is idle but out of weekly quota; 5 needs a login.
  function seed(): void {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: '0.25.0',
        activeAccountNumber: 1,
        accounts: {
          1: { email: 'a@example.com', organizationUuid: 'o1', usage: { five_hour: 45, seven_day: 12 } },
          2: { email: 'b@example.com', organizationUuid: 'o2', idle: true, usage: { five_hour: 0, seven_day: 30 } },
          3: { email: 'c@example.com', organizationUuid: 'o3', idle: true, usage: { five_hour: 0, seven_day: 10 } },
          4: { email: 'd@example.com', organizationUuid: 'o4', idle: true, usage: { five_hour: 0, seven_day: 100 } },
          5: { email: 'e@example.com', organizationUuid: 'o5', usageStatus: 'relogin_required' }
        },
        sequence: [1, 2, 3, 4, 5],
        mappings: {},
        settings: {},
        unclaimed: {},
        liveIdentity: 'a@example.com',
        log: []
      })
    )
  }

  function scheduler(cfg: Partial<AppSettings> = {}, clock: { t: number } = { t: NOW }): { w: WarmScheduler; d: CswapDriver; cfg: AppSettings; clock: { t: number } } {
    const d = new CswapDriver()
    d.setBinary(FAKE)
    const merged = settings(cfg)
    let state: AccountsState = { payload: null, fetchedAt: null, refreshing: false, error: null }
    // The scheduler refreshes in the background after a ping. The real cswap serialises
    // itself with file locks; the fake does not, so the tests wait for those refreshes
    // instead of letting two fake processes race on one state file.
    const pending = new Set<Promise<unknown>>()
    const refresh = (): Promise<AccountsState> => {
      const p = (async (): Promise<AccountsState> => {
        const r = await d.list()
        if (r.ok) state = { payload: r.value, fetchedAt: iso(clock.t), refreshing: false, error: null }
        return state
      })()
      pending.add(p)
      void p.finally(() => pending.delete(p))
      return p
    }
    const settle = async (): Promise<void> => {
      while (pending.size) await Promise.all([...pending])
    }
    const w = new WarmScheduler({ driver: d, accounts: () => state, refresh, settings: () => merged, userData: dir, now: () => clock.t })
    const tick = w.tick.bind(w)
    const warmNow = w.warmNow.bind(w)
    w.tick = async () => {
      await tick()
      await settle()
    }
    w.warmNow = async (t) => {
      const r = await warmNow(t)
      await settle()
      return r
    }
    return { w, d, cfg: merged, clock }
  }
  const pings = (): string[][] => fakeState().log.filter((a) => a[0] === 'run')

  it('each tick warms one idle account — most weekly quota first — and leaves the others alone', async () => {
    seed()
    const { w } = scheduler()
    await w.tick()
    expect(pings()).toHaveLength(1)
    expect(pings()[0].slice(0, 3)).toEqual(['run', '3', '--']) // slot 3 has the most weekly quota left
    expect(pings()[0]).toContain('-p')
    expect(w.getState().entries['c@example.com']).toMatchObject({ ok: true })
    expect(w.getState().lastPingAt).toBe(iso(NOW))
    expect(fakeState().accounts['3'].idle).toBe(false)
    await w.tick()
    expect(pings().map((p) => p[1])).toEqual(['3', '2'])
    await w.tick()
    expect(pings()).toHaveLength(2) // 1 is in use, 4 has no quota, 5 needs a login, 2 and 3 are warm
  })

  it('never touches the account in use or the live login', async () => {
    seed()
    const { w } = scheduler()
    for (let i = 0; i < 4; i++) await w.tick()
    expect(pings().map((p) => p[1])).not.toContain('1')
    const verbs = fakeState().log.map((a) => a[0])
    expect(verbs).not.toContain('switch')
    expect(verbs).not.toContain('add')
  })

  it('spaces warm-ups by the stagger so the resets spread out', async () => {
    seed()
    const clock = { t: NOW }
    const { w } = scheduler({ keepWarmStaggerMin: 30 }, clock)
    await w.tick()
    expect(pings()).toHaveLength(1)
    clock.t += 10 * 60_000
    await w.tick()
    expect(pings()).toHaveLength(1) // too soon
    clock.t += 21 * 60_000
    await w.tick()
    expect(pings()).toHaveLength(2)
  })

  it('does nothing while keep-warm is off', async () => {
    seed()
    const { w } = scheduler({ keepWarm: false })
    await w.tick()
    expect(pings()).toHaveLength(0)
  })

  it('leaves out accounts the person excluded', async () => {
    seed()
    const { w } = scheduler({ keepWarmExclude: ['c@example.com'] })
    await w.tick()
    expect(pings().map((p) => p[1])).toEqual(['2'])
  })

  it('records a failure, shows why, and backs off instead of hammering', async () => {
    seed()
    process.env.FAKE_CSWAP_RUN_FAIL = 'Weekly limit reached'
    const clock = { t: NOW }
    const { w } = scheduler({}, clock)
    await w.tick()
    expect(w.getState().entries['c@example.com']).toMatchObject({ ok: false, message: 'Weekly limit reached' })
    await w.tick() // next candidate (slot 2)
    await w.tick() // both backing off now
    expect(pings().map((p) => p[1])).toEqual(['3', '2'])
    delete process.env.FAKE_CSWAP_RUN_FAIL
    clock.t += 31 * 60_000
    await w.tick()
    expect(pings()).toHaveLength(3)
    expect(w.getState().entries['c@example.com'].ok).toBe(true)
  })

  it('remembers what it did across restarts', async () => {
    seed()
    const a = scheduler()
    await a.w.tick()
    expect(existsSync(join(dir, 'warm.json'))).toBe(true)
    const b = scheduler()
    expect(b.w.getState().entries['c@example.com']?.ok).toBe(true)
    expect(b.w.getState().lastPingAt).toBe(iso(NOW))
  })

  it('warmNow() with no name warms every idle account at once, ignoring the stagger', async () => {
    seed()
    const { w } = scheduler({ keepWarmStaggerMin: 90 })
    const r = await w.warmNow()
    expect(r).toEqual({ ok: true, value: { attempted: 2, ok: 2, failed: 0 } })
    expect(pings().map((p) => p[1])).toEqual(['3', '2'])
  })

  it('warmNow(name) pings that account whatever its window looks like — but not the one in use', async () => {
    seed()
    const { w } = scheduler()
    const r = await w.warmNow('d@example.com') // out of weekly quota: the ping is attempted, the CLI answers
    expect(r.ok && r.value.attempted).toBe(1)
    expect(pings().map((p) => p[1])).toEqual(['4'])
    const active = await w.warmNow('1')
    expect(!active.ok && active.error.type).toBe('Active')
    const nobody = await w.warmNow('nobody@nowhere')
    expect(!nobody.ok && nobody.error.type).toBe('AccountNotFoundError')
  })

  it('refuses to run two at once', async () => {
    seed()
    process.env.FAKE_CSWAP_DELAY = '250'
    const { w } = scheduler()
    const first = w.warmNow('2')
    await new Promise((r) => setTimeout(r, 30))
    const second = await w.warmNow('3')
    delete process.env.FAKE_CSWAP_DELAY
    expect(!second.ok && second.error.type).toBe('Busy')
    await first
  })

  it('reports itself running while a ping is in flight', async () => {
    seed()
    process.env.FAKE_CSWAP_DELAY = '200'
    const { w } = scheduler()
    const seen: (string | null)[] = []
    w.on('state', (st: { running: string | null }) => seen.push(st.running))
    await w.warmNow('2')
    delete process.env.FAKE_CSWAP_DELAY
    expect(seen).toContain('b@example.com')
    expect(seen.at(-1)).toBeNull()
  })
})
