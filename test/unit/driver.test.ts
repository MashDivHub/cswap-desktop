import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CswapDriver, parseMappings, parseUnclaimed } from '../../src/main/cswap/driver'
import { AutoSwitchRunner } from '../../src/main/cswap/auto'
import { runVersion } from '../../src/main/cswap/resolve'
import type { AutoEvent } from '@shared/types'

const ROOT = resolve(__dirname, '..', '..')
const FAKE = process.platform === 'win32' ? join(ROOT, 'test', 'fake-cswap', 'fake-cswap.cmd') : join(ROOT, 'test', 'fake-cswap', 'fake-cswap.mjs')

let dir: string
let statePath: string
const state = (): { activeAccountNumber: number; accounts: Record<string, Record<string, unknown>>; log: string[][]; mappings: Record<string, unknown>; settings: Record<string, unknown> } => JSON.parse(readFileSync(statePath, 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cswap-driver-'))
  statePath = join(dir, 'state.json')
  process.env.FAKE_CSWAP_STATE = statePath
  delete process.env.FAKE_CSWAP_FAIL
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function driver(): CswapDriver {
  const d = new CswapDriver()
  d.setBinary(FAKE)
  return d
}

describe('CswapDriver', () => {
  it('lists accounts from --json and records the call', async () => {
    const d = driver()
    const r = await d.list()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.schemaVersion).toBe(1)
    expect(r.value.accounts.map((a) => a.number)).toEqual([1, 2, 3, 4])
    expect(r.value.accounts[0].active).toBe(true)
    expect(r.value.accounts[2].disabled).toBe(true)
    expect(r.value.accounts[3].usageStatus).toBe('api_key')
    expect(d.getLog()).toHaveLength(1)
    expect(d.getLog()[0]).toMatchObject({ args: ['list', '--json'], exitCode: 0, ok: true })
  })

  it('switches by slot and reports from/to', async () => {
    const d = driver()
    const r = await d.switchTo('2')
    expect(r.ok && r.value.switched).toBe(true)
    expect(r.ok && r.value.to?.email).toBe('work@company.com')
    expect(state().activeAccountNumber).toBe(2)
  })

  it('switching to the active account is a no-op with reason already-active', async () => {
    const d = driver()
    const r = await d.switchTo('you@example.com')
    expect(r.ok && r.value.switched).toBe(false)
    expect(r.ok && r.value.reason).toBe('already-active')
  })

  it('surfaces the cswap error envelope as a typed error', async () => {
    const d = driver()
    const r = await d.switchTo('nobody@nowhere')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.type).toBe('AccountNotFoundError')
    expect(r.error.message).toContain('nobody@nowhere')
    expect(d.getLog()[0].ok).toBe(false)
  })

  it('rotate honours --strategy', async () => {
    const d = driver()
    const r = await d.rotate('best')
    expect(r.ok && r.value.strategy).toBe('best')
    expect(d.getLog()[0].args).toEqual(['switch', '--json', '--strategy', 'best'])
  })

  it('remove answers the [y/N] prompt on stdin and never on argv', async () => {
    const d = driver()
    const r = await d.removeAccount('3')
    expect(r.ok).toBe(true)
    expect(state().accounts['3']).toBeUndefined()
    expect(d.getLog()[0].args).toEqual(['remove', '3'])
    // the fake echoes the prompt to stdout; the answer must have arrived
    expect(d.getLog()[0].stdout).toContain('Removed Account-3')
  })

  it('add-token passes the token over stdin, not argv', async () => {
    const d = driver()
    const r = await d.addToken('sk-ant-oat01-SECRET-VALUE', 'me@corp.com')
    expect(r.ok).toBe(true)
    const logged = JSON.stringify(d.getLog()[0].args)
    expect(logged).not.toContain('SECRET')
    expect(d.getLog()[0].args).toEqual(['add-token', '-', '--email', 'me@corp.com'])
    expect(Object.values(state().accounts).some((a) => a.email === 'me@corp.com')).toBe(true)
  })

  it('add-token onto a taken slot without overwrite is cancelled by the stdin answer', async () => {
    const d = driver()
    const r = await d.addToken('sk-ant-api03-KEY', undefined, 2, false)
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.stdout).toContain('Cancelled')
    expect(state().accounts['2'].email).toBe('work@company.com')
    const r2 = await d.addToken('sk-ant-api03-KEY', undefined, 2, true)
    expect(r2.ok).toBe(true)
    expect(state().accounts['2'].email).toBe('api-key-2@token.local')
  })

  it('alias / disable / move / map / config / unclaimed round-trip through the CLI', async () => {
    const d = driver()
    expect((await d.setAlias('2', 'work')).ok).toBe(true)
    expect(state().accounts['2'].alias).toBe('work')
    expect((await d.setAlias('2', null)).ok).toBe(true)
    expect(state().accounts['2'].alias).toBeUndefined()
    const bad = await d.setAlias('2', '123')
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error.message).toMatch(/Invalid alias/)

    expect((await d.setDisabled('1', true)).ok).toBe(true)
    expect(state().accounts['1'].disabled).toBe(true)

    expect((await d.moveAccount('4', 9)).ok).toBe(true)
    expect(state().accounts['9'].email).toBe('api-key-4@token.local')
    expect((await d.swapAccounts('1', '2')).ok).toBe(true)
    expect(state().accounts['1'].email).toBe('work@company.com')
    expect(state().activeAccountNumber).toBe(2)

    expect((await d.mapDirectory('2', '/tmp/proj')).ok).toBe(true)
    expect(state().mappings['/tmp/proj']).toBeTruthy()
    const m = await d.listMappingsText()
    expect(m.ok && parseMappings(m.value.stdout).some((x) => x.path === '/tmp/proj')).toBe(true)
    expect((await d.unmapDirectory('/tmp/proj')).ok).toBe(true)

    const c = await d.config()
    expect(c.ok && c.value.settings.find((s) => s.key === 'autoswitch.threshold')?.value).toBe(90)
    expect((await d.setConfig('autoswitch.threshold', '80')).ok).toBe(true)
    const c2 = await d.config()
    expect(c2.ok && c2.value.settings.find((s) => s.key === 'autoswitch.threshold')).toMatchObject({ value: 80, isSet: true })
    const badCfg = await d.setConfig('autoswitch.threshold', '10')
    expect(badCfg.ok).toBe(false)
    expect((await d.setConfig('autoswitch.threshold', null)).ok).toBe(true)
    expect(await d.configPath()).toBe(join(dir, 'settings.json'))

    const u = await d.unclaimedText()
    expect(u.ok && parseUnclaimed(u.value.stdout)).toEqual([])
  })

  it('export writes a file and import --force overwrites', async () => {
    const d = driver()
    const file = join(dir, 'backup.cswap')
    expect((await d.exportAccounts(file, '2')).ok).toBe(true)
    const env = JSON.parse(readFileSync(file, 'utf8'))
    expect(env.accounts).toHaveLength(1)
    expect(env.accounts[0].email).toBe('work@company.com')
    const skip = await d.importAccounts(file)
    expect(skip.ok && skip.value.stdout).toContain('Skipped')
    const force = await d.importAccounts(file, true)
    expect(force.ok && force.value.stdout).toContain('Imported 1')
    expect(d.getLog().at(-1)?.args).toEqual(['import', file, '--force'])
  })

  it('importEnvelope sends the envelope on stdin, and --force only when asked', async () => {
    const d = driver()
    const env = JSON.stringify({ version: 1, accounts: [{ number: 9, email: 'fresh@example.com', credentials: { claudeAiOauth: { refreshToken: 'SECRET' } }, config: {} }] })
    const r = await d.importEnvelope(env, false)
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.stderr).toContain('Imported fresh@example.com')
    expect(d.getLog().at(-1)?.args).toEqual(['import', '-'])
    expect(JSON.stringify(d.getLog())).not.toContain('SECRET')
    const again = await d.importEnvelope(env, false)
    expect(again.ok && again.value.stderr).toContain('Skipped')
    const forced = await d.importEnvelope(env, true)
    expect(forced.ok && forced.value.stderr).toContain('Overwrote')
    expect(d.getLog().at(-1)?.args).toEqual(['import', '-', '--force'])
    const bad = await d.importEnvelope('not json', false)
    expect(bad.ok).toBe(false)
  })

  it('warmUp runs the ping in session mode and reports the reason the CLI gives when it is refused', async () => {
    const d = driver()
    const ok = await d.warmUp('2', 'haiku', dir)
    expect(ok.ok && ok.value.reply).toBe('ok')
    const logged = d.getLog().at(-1)!
    expect(logged.args.slice(0, 3)).toEqual(['run', '2', '--'])
    expect(logged.args).toContain('--no-session-persistence')
    process.env.FAKE_CSWAP_RUN_FAIL = '5-hour limit reached'
    const refused = await d.warmUp('2', 'haiku', dir)
    delete process.env.FAKE_CSWAP_RUN_FAIL
    expect(!refused.ok && refused.error).toEqual({ type: 'WarmError', message: '5-hour limit reached' })
    const missing = await d.warmUp('99', 'haiku', dir)
    expect(!missing.ok && missing.error.message).toMatch(/No account found/)
  })

  it('serializes mutations so two concurrent switches never interleave', async () => {
    const d = driver()
    process.env.FAKE_CSWAP_DELAY = '150'
    const [a, b] = await Promise.all([d.switchTo('2'), d.switchTo('3')])
    delete process.env.FAKE_CSWAP_DELAY
    expect(a.ok && b.ok).toBe(true)
    expect(a.ok && a.value.from?.number).toBe(1)
    expect(b.ok && b.value.from?.number).toBe(2) // ran after a, not concurrently
    expect(state().activeAccountNumber).toBe(3)
  })

  it('a missing binary is a SpawnError, not a crash', async () => {
    const d = new CswapDriver()
    d.setBinary(join(dir, 'does-not-exist'))
    const r = await d.list()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.type).toBe('SpawnError')
    const d2 = new CswapDriver()
    const r2 = await d2.list()
    expect(!r2.ok && r2.error.message).toMatch(/not configured/)
  })

  it('a hung command times out instead of blocking forever', async () => {
    const d = driver()
    process.env.FAKE_CSWAP_DELAY = '3000'
    const started = Date.now()
    const out = await d.run(['list', '--json'], { timeoutMs: 400 })
    delete process.env.FAKE_CSWAP_DELAY
    expect(Date.now() - started).toBeLessThan(2500)
    expect(out.exitCode).not.toBe(0)
    expect(out.stderr).toMatch(/timed out/)
  })

  it('a forced CLI failure lands in the log as not ok', async () => {
    process.env.FAKE_CSWAP_FAIL = 'disable'
    const d = driver()
    const r = await d.setDisabled('1', true)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.message).toMatch(/forced failure/)
    expect(state().accounts['1'].disabled).toBeUndefined()
  })
})

describe('parsers', () => {
  it('parseMappings reads cswap map output with and without a resolved slot', () => {
    const text = ['Directory mappings:', '  /home/me/work → 2: me@example.com [personal]', '  D:\\proj → gone@example.com (account removed)', ''].join('\n')
    expect(parseMappings(text)).toEqual([
      { path: '/home/me/work', email: 'me@example.com', number: 2 },
      { path: 'D:\\proj', email: 'gone@example.com', number: null }
    ])
    expect(parseMappings('No directory mappings yet.\nMap one with: cswap map <NUM|EMAIL> [PATH]\n')).toEqual([])
  })
  it('parseUnclaimed reads id / slot / reason rows', () => {
    expect(parseUnclaimed('abc123  slot 2  keychain locked\n')).toEqual([{ id: 'abc123', slot: '2', reason: 'keychain locked' }])
    expect(parseUnclaimed('No unclaimed credential entries')).toEqual([])
  })
})

describe('resolve', () => {
  it('runVersion reads the version line', async () => {
    expect((await runVersion(FAKE)).version).toBe('0.25.0')
    const bad = await runVersion(join(dir, 'nope'))
    expect(bad.version).toBeNull()
    expect(bad.error).toBeTruthy()
  })
})

describe('AutoSwitchRunner', () => {
  it('streams JSON events, refuses a second start, and stops cleanly', async () => {
    const d = driver()
    await d.list() // seeds the fake state
    const auto = new AutoSwitchRunner()
    const events: AutoEvent[] = []
    auto.on('event', (e: AutoEvent) => events.push(e))
    process.env.FAKE_CSWAP_AUTO_INTERVAL = '0.2'
    const st = auto.start(FAKE, { dryRun: true })
    expect(st.running).toBe(true)
    expect(auto.start(FAKE).pid).toBe(st.pid)
    await new Promise((r) => setTimeout(r, 900))
    delete process.env.FAKE_CSWAP_AUTO_INTERVAL
    const kinds = events.map((e) => e.event)
    expect(kinds).toContain('poll')
    expect(kinds).toContain('sleep')
    const stopped = await auto.stop()
    expect(stopped.running).toBe(false)
    expect(auto.getEvents().length).toBe(events.length)
  })
  it('without a binary it reports lastError instead of spawning', () => {
    const auto = new AutoSwitchRunner()
    const st = auto.start(null)
    expect(st.running).toBe(false)
    expect(st.lastError).toMatch(/not configured/)
  })
})
