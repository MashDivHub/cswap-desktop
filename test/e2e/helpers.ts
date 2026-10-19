import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
export const FAKE = process.platform === 'win32' ? join(ROOT, 'test', 'fake-cswap', 'fake-cswap.cmd') : join(ROOT, 'test', 'fake-cswap', 'fake-cswap.mjs')
export const SHOTS = join(ROOT, 'test-results', 'shots')

// Mirrors the fake CLI's own seed; a test that needs one field different can spread it.
export const FAKE_SEED = {
  version: '0.25.0',
  activeAccountNumber: 1,
  accounts: {
    1: { email: 'you@example.com', organizationName: "you@example.com's Organization", organizationUuid: 'org-1111', alias: 'main', usage: { five_hour: 45, seven_day: 12, scoped: [{ name: 'Fable', pct: 17 }] } },
    2: { email: 'work@company.com', organizationName: 'Company Inc', organizationUuid: 'org-2222', usage: { five_hour: 100, seven_day: 61, scoped: [{ name: 'Fable', pct: 100 }] }, resetsIn5h: 1800 },
    3: { email: 'spare@example.com', organizationName: '', organizationUuid: '', disabled: true, usage: { five_hour: 3, seven_day: 40 } },
    4: { email: 'api-key-4@token.local', organizationName: '', organizationUuid: '', usageStatus: 'api_key' }
  },
  sequence: [1, 2, 3, 4],
  mappings: { '/home/you/work/client-app': { email: 'work@company.com', organizationUuid: 'org-2222' } },
  settings: {},
  unclaimed: {},
  liveIdentity: 'you@example.com',
  log: [] as string[][]
}

export interface FakeState {
  activeAccountNumber: number
  accounts: Record<string, Record<string, unknown>>
  mappings: Record<string, { email: string; organizationUuid?: string }>
  settings: Record<string, unknown>
  log: string[][]
  /** What the last `import -` carried (never the credentials themselves). */
  lastImport?: { force: boolean; accounts: string[] }
}

export interface Launched {
  app: ElectronApplication
  page: Page
  statePath: string
  userData: string
  state(): FakeState
}

// Launches the built app against the fake cswap with a fresh vault + userData.
export async function launch(opts: { seedState?: object; settings?: object; env?: Record<string, string>; bin?: string } = {}): Promise<Launched> {
  const dir = mkdtempSync(join(tmpdir(), 'cswap-desktop-e2e-'))
  const statePath = join(dir, 'vault', 'state.json')
  mkdirSync(join(dir, 'vault'), { recursive: true })
  if (opts.seedState) writeFileSync(statePath, JSON.stringify(opts.seedState, null, 2))
  const userData = join(dir, 'userData')
  mkdirSync(userData, { recursive: true })
  // Point Claude's config dir at scratch: the app reads the subscription fields from
  // .credentials.json, and a test must never read the machine's real one.
  const claudeHome = join(dir, 'claude')
  mkdirSync(claudeHome, { recursive: true })
  writeFileSync(
    join(claudeHome, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'test-not-a-token', refreshToken: 'test-not-a-token', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } })
  )
  if (opts.settings) writeFileSync(join(userData, 'settings.json'), JSON.stringify(opts.settings))
  mkdirSync(SHOTS, { recursive: true })
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CSWAP_DESKTOP_USERDATA: userData,
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CSWAP_STATE: statePath,
    ELECTRON_ENABLE_LOGGING: '0',
    CSWAP_DESKTOP_TEST_NO_SPAWN: '1', // a test must never open a terminal on the machine running it
    ...opts.env
  }
  if (opts.bin === '') delete env.CSWAP_DESKTOP_BIN
  else env.CSWAP_DESKTOP_BIN = opts.bin ?? FAKE
  const app = await electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js'), '--no-sandbox'],
    env
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Wide enough that the three window columns are above their minimum and the list is not
  // scrolling sideways — a squeezed table is a case with its own test, not the default.
  await page.setViewportSize({ width: 1400, height: 800 })
  return {
    app,
    page,
    statePath,
    userData,
    state: (): FakeState => (existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as FakeState) : { activeAccountNumber: 0, accounts: {}, mappings: {}, settings: {}, log: [] })
  }
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' })
}
