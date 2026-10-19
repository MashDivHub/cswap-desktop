import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FAKE_SEED, launch, shot } from './helpers'

// ---- a stand-in for Anthropic's OAuth endpoints ---------------------------------------
// The app talks to these over its real network stack; the "browser" is this test following
// the redirect back to the app's loopback listener.

interface FakeAnthropic {
  server: Server
  env: Record<string, string>
  who: { email: string; org: string }
  close(): Promise<void>
}
async function fakeAnthropic(who: { email: string; org: string }): Promise<FakeAnthropic> {
  const f: FakeAnthropic = {
    who,
    server: createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/token') {
        req.resume()
        res.end(JSON.stringify({ access_token: 'e2e-access-token', refresh_token: 'e2e-refresh-token', expires_in: 28800, scope: 'user:inference user:profile' }))
      } else if (req.url === '/profile') {
        res.end(JSON.stringify({ account: { uuid: `uuid-${f.who.email}`, email: f.who.email }, organization: { uuid: f.who.org, name: f.who.email, organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } }))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
    }),
    env: {},
    close: () => new Promise<void>((r) => f.server.close(() => r()))
  }
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`
  f.env = { CSWAP_DESKTOP_OAUTH_TOKEN: `${base}/token`, CSWAP_DESKTOP_OAUTH_PROFILE: `${base}/profile`, CSWAP_DESKTOP_OAUTH_AUTHORIZE: `${base}/authorize` }
  return f
}

// What the browser does after the person signs in: follow the redirect to the app.
async function browserComesBack(page: Page): Promise<URL> {
  const link = await page.locator('[data-testid="oauth-waiting"] span[title^="http"]').getAttribute('title')
  const url = new URL(link!)
  const back = `${url.searchParams.get('redirect_uri')}?code=E2E-CODE&state=${url.searchParams.get('state')}`
  expect((await fetch(back)).status).toBe(200)
  return url
}

const idle = (email: string, org: string, weekly: number): Record<string, unknown> => ({ email, organizationName: '', organizationUuid: org, idle: true, usage: { five_hour: 0, seven_day: weekly } })

test.describe('browser sign-in', () => {
  test('adds an account from the browser without any CLI login, and never touches the live one', async () => {
    const anthropic = await fakeAnthropic({ email: 'new.person@example.com', org: 'org-new' })
    const { app, page, state } = await launch({ env: anthropic.env })
    try {
      await page.getByTestId('add-menu').click()
      await page.getByRole('menuitem', { name: /Sign in with the browser/ }).click()
      await shot(page, 'dialog-oauth-setup')
      await page.getByTestId('oauth-alias').fill('fresh')
      await page.getByTestId('oauth-open').click()
      await expect(page.getByTestId('oauth-waiting')).toBeVisible()
      await shot(page, 'dialog-oauth-waiting')

      const url = await browserComesBack(page)
      expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')

      await expect(page.getByTestId('oauth-done')).toBeVisible()
      await expect(page.getByTestId('oauth-done')).toContainText('new.person@example.com')
      await expect(page.getByTestId('oauth-done')).toContainText('Max 20x')
      await shot(page, 'dialog-oauth-done')

      const verbs = state().log.map((a) => a[0])
      expect(verbs).toContain('import')
      expect(verbs).not.toContain('add')
      expect(verbs).not.toContain('switch')
      expect(state().log).toContainEqual(['import', '-'])
      expect(JSON.stringify(state().log)).not.toContain('e2e-access-token')
      expect(state().accounts['5']).toMatchObject({ email: 'new.person@example.com', alias: 'fresh', loginArrived: true })
      expect(state().activeAccountNumber).toBe(1) // still on the account the terminals use

      await page.getByTestId('oauth-close').click()
      await expect(page.getByTestId('account-row-5')).toBeVisible()
      await expect(page.getByTestId('account-row-1')).toHaveAttribute('data-active', 'true')
    } finally {
      await app.close()
      await anthropic.close()
    }
  })

  test('"Fix login" on a dead account signs in again as that account and repairs it in place', async () => {
    const anthropic = await fakeAnthropic({ email: 'work@company.com', org: 'org-2222' })
    const seed = { ...FAKE_SEED, accounts: { ...FAKE_SEED.accounts, 2: { ...FAKE_SEED.accounts[2], alias: 'work', usageStatus: 'relogin_required', usage: undefined } } }
    const { app, page, state } = await launch({ env: anthropic.env, seedState: seed })
    try {
      await expect(page.getByTestId('account-row-2')).toContainText('Re-login required')
      await page.getByTestId('fix-login-2').click()
      await expect(page.getByRole('dialog')).toContainText('Sign in again — Account-2')
      await page.getByTestId('oauth-open').click()
      await expect(page.getByTestId('oauth-waiting')).toContainText('work@company.com')
      const url = await browserComesBack(page)
      expect(url.searchParams.get('login_hint')).toBe('work@company.com')

      await expect(page.getByTestId('oauth-done')).toContainText('Login replaced')
      expect(state().lastImport).toEqual({ force: true, accounts: ['work@company.com'] })
      expect(state().accounts['2']).toMatchObject({ alias: 'work', loginArrived: true })
      await page.getByTestId('oauth-close').click()
      await expect(page.getByTestId('account-row-2')).not.toContainText('Re-login required')
      await expect(page.getByTestId('fix-login-2')).toHaveCount(0)
    } finally {
      await app.close()
      await anthropic.close()
    }
  })

  test('signing in as someone else during a re-login is caught before anything is written', async () => {
    const anthropic = await fakeAnthropic({ email: 'someone.else@example.com', org: 'org-x' })
    const seed = { ...FAKE_SEED, accounts: { ...FAKE_SEED.accounts, 2: { ...FAKE_SEED.accounts[2], usageStatus: 'relogin_required', usage: undefined } } }
    const { app, page, state } = await launch({ env: anthropic.env, seedState: seed })
    try {
      await page.getByTestId('fix-login-2').click()
      await page.getByTestId('oauth-open').click()
      await expect(page.getByTestId('oauth-waiting')).toBeVisible()
      await browserComesBack(page)
      await expect(page.getByTestId('oauth-mismatch')).toContainText('someone.else@example.com')
      await shot(page, 'dialog-oauth-mismatch')
      expect(state().log.map((a) => a[0])).not.toContain('import')
      // keeping it as a new account is the person's call
      await page.getByTestId('oauth-asnew').click()
      await expect(page.getByTestId('oauth-done')).toBeVisible()
      expect(state().accounts['2'].email).toBe('work@company.com')
      expect(state().accounts['5'].email).toBe('someone.else@example.com')
    } finally {
      await app.close()
      await anthropic.close()
    }
  })

  test('closing the dialog cancels the sign-in and stops listening', async () => {
    const anthropic = await fakeAnthropic({ email: 'x@example.com', org: 'o' })
    const { app, page, state } = await launch({ env: anthropic.env })
    try {
      await page.getByTestId('add-menu').click()
      await page.getByRole('menuitem', { name: /Sign in with the browser/ }).click()
      await page.getByTestId('oauth-open').click()
      await expect(page.getByTestId('oauth-waiting')).toBeVisible()
      const link = await page.locator('[data-testid="oauth-waiting"] span[title^="http"]').getAttribute('title')
      const redirect = new URL(new URL(link!).searchParams.get('redirect_uri')!)
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(fetch(`${redirect.origin}/callback?code=late&state=x`)).rejects.toThrow()
      expect(state().log.map((a) => a[0])).not.toContain('import')
    } finally {
      await app.close()
      await anthropic.close()
    }
  })
})

test.describe('keep warm', () => {
  // 1 is in use · 2, 3 idle · 4 idle but out of weekly quota · 5 needs a login
  const seed = {
    ...FAKE_SEED,
    accounts: {
      1: FAKE_SEED.accounts[1],
      2: idle('b@example.com', 'o2', 30),
      3: idle('c@example.com', 'o3', 10),
      4: idle('d@example.com', 'o4', 100),
      5: { email: 'e@example.com', organizationName: '', organizationUuid: 'o5', usageStatus: 'relogin_required' }
    },
    sequence: [1, 2, 3, 4, 5]
  }
  const pings = (log: string[][]): string[] => log.filter((a) => a[0] === 'run').map((a) => a[1])

  test('off by default; the header menu turns it on and the setting is kept', async () => {
    const { app, page, userData } = await launch({ seedState: seed })
    try {
      await page.getByTestId('warm-menu').click()
      await expect(page.getByRole('menuitem', { name: /Keep idle accounts warm/ })).toContainText('off')
      await page.getByRole('menuitem', { name: /Keep idle accounts warm/ }).click()
      await expect(page.getByTestId('warm-menu')).toHaveAttribute('title', 'Keep warm is on')
      await expect.poll(() => JSON.parse(readFileSync(`${userData}/settings.json`, 'utf8')).keepWarm).toBe(true)
    } finally {
      await app.close()
    }
  })

  test('"Warm idle accounts now" starts a window on every idle account and nothing else', async () => {
    const { app, page, state } = await launch({ seedState: seed })
    try {
      await page.getByTestId('nav-settings').click()
      await expect(page.getByTestId('warm-card')).toBeVisible()
      await shot(page, 'settings-keep-warm')
      await page.getByTestId('warm-now').click()
      await expect(page.getByRole('status').last()).toContainText('Warmed 2 of 2')
      expect(pings(state().log)).toEqual(['3', '2']) // most weekly quota left first
      await expect(page.getByTestId('warm-recent')).toContainText('window started')

      await page.getByTestId('nav-accounts').click()
      await expect(page.getByTestId('warm-status-3')).toContainText('warmed')
      await expect(page.getByTestId('warm-status-2')).toContainText('warmed')
      await expect(page.getByTestId('warm-status-1')).toHaveCount(0) // in use
      await expect(page.getByTestId('warm-status-4')).toHaveCount(0) // no weekly quota
      await expect(page.getByTestId('fix-login-5')).toBeVisible()
      await shot(page, 'accounts-warmed')
      const verbs = state().log.map((a) => a[0])
      expect(verbs).not.toContain('switch')
    } finally {
      await app.close()
    }
  })

  test('with keep-warm on it pings idle accounts by itself, spaced out, never the active one', async () => {
    const { app, page, state } = await launch({
      seedState: seed,
      settings: { keepWarm: true, keepWarmStaggerMin: 0 },
      env: { CSWAP_DESKTOP_WARM_TICK_MS: '400' }
    })
    try {
      await expect.poll(() => pings(state().log), { timeout: 30_000 }).toEqual(['3', '2'])
      await page.waitForTimeout(1500)
      expect(pings(state().log)).toEqual(['3', '2']) // warm now; 4 and 5 are not eligible
      await expect(page.getByTestId('warm-status-3')).toContainText('warmed')
    } finally {
      await app.close()
    }
  })

  test('a single account can be warmed from its row menu, and left out of keep-warm', async () => {
    const { app, page, state, userData } = await launch({ seedState: seed })
    try {
      await page.getByTestId('row-menu-2').click()
      await page.getByRole('menuitem', { name: /Warm up now/ }).click()
      await expect(page.getByRole('status').last()).toContainText('Window started')
      expect(pings(state().log)).toEqual(['2'])

      await page.getByTestId('row-menu-3').click()
      await page.getByRole('menuitem', { name: /Leave out of keep-warm/ }).click()
      await expect.poll(() => JSON.parse(readFileSync(`${userData}/settings.json`, 'utf8')).keepWarmExclude).toEqual(['c@example.com'])
      await page.getByTestId('row-menu-3').click()
      await expect(page.getByRole('menuitem', { name: /Include in keep-warm/ })).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test('a refused ping is shown on the account with the reason', async () => {
    const { app, page } = await launch({ seedState: seed, env: { FAKE_CSWAP_RUN_FAIL: '5-hour limit reached' } })
    try {
      await page.getByTestId('row-menu-2').click()
      await page.getByRole('menuitem', { name: /Warm up now/ }).click()
      await expect(page.getByTestId('warm-status-2')).toContainText('warm-up failed')
      await expect(page.getByTestId('warm-status-2')).toHaveAttribute('title', '5-hour limit reached')
    } finally {
      await app.close()
    }
  })
})
