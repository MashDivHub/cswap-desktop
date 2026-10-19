import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAccount,
  buildAuthorizeUrl,
  buildEnvelope,
  createPkce,
  endpoints,
  exchangeCode,
  fetchProfile,
  LoginSession,
  OAuthError,
  parseCodeInput,
  SCOPES,
  type Fetch,
  type Profile,
  type TokenResponse
} from '../../src/main/oauth'

const TOKENS: TokenResponse = {
  access_token: 'sk-ant-oat01-ACCESS',
  refresh_token: 'sk-ant-ort01-REFRESH',
  expires_in: 28800,
  scope: 'user:inference user:profile user:sessions:claude_code',
  account: { uuid: 'acc-1', email_address: 'person@example.com' },
  organization: { uuid: 'org-1', name: "person@example.com's Organization" }
}
const PROFILE: Profile = {
  account: { uuid: 'acc-1', email: 'person@example.com', full_name: 'Pat Person', display_name: 'Pat', created_at: '2025-01-02T03:04:05Z' },
  organization: { uuid: 'org-1', name: "person@example.com's Organization", organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', billing_type: 'stripe_subscription', has_extra_usage_enabled: false, cc_onboarding_flags: {}, subscription_created_at: '2025-02-03T00:00:00Z' }
}

function res(status: number, body: unknown): Awaited<ReturnType<Fetch>> {
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
}

// Stands in for platform.claude.com and api.anthropic.com; remembers what it was asked.
function fakeFetch(over: { token?: Awaited<ReturnType<Fetch>>; profile?: Awaited<ReturnType<Fetch>> } = {}): { fetch: Fetch; calls: { url: string; body?: unknown; headers?: Record<string, string> }[] } {
  const calls: { url: string; body?: unknown; headers?: Record<string, string> }[] = []
  const f: Fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers })
    if (url === endpoints().token) return over.token ?? res(200, TOKENS)
    if (url === endpoints().profile) return over.profile ?? res(200, PROFILE)
    return res(404, {})
  }
  return { fetch: f, calls }
}

const stateOf = (url: string): string => new URL(url).searchParams.get('state')!
const redirectOf = (url: string): string => new URL(url).searchParams.get('redirect_uri')!

afterEach(() => {
  delete process.env.CSWAP_DESKTOP_OAUTH_TOKEN
  delete process.env.CSWAP_DESKTOP_OAUTH_PROFILE
  delete process.env.CSWAP_DESKTOP_OAUTH_AUTHORIZE
})

describe('PKCE and the authorize URL', () => {
  it('the challenge is the S256 of the verifier, and every sign-in gets its own values', () => {
    const a = createPkce()
    expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'))
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const b = createPkce()
    expect(b.verifier).not.toBe(a.verifier)
    expect(b.state).not.toBe(a.state)
  })

  it('asks for what Claude Code asks for, at the claude.com authorize page', () => {
    const u = new URL(buildAuthorizeUrl({ challenge: 'CHAL', state: 'ST', redirectUri: 'http://localhost:5555/callback', loginHint: 'me@example.com' }))
    expect(`${u.origin}${u.pathname}`).toBe('https://claude.com/cai/oauth/authorize')
    const q = u.searchParams
    expect(q.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    expect(q.get('response_type')).toBe('code')
    expect(q.get('code')).toBe('true')
    expect(q.get('code_challenge')).toBe('CHAL')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('state')).toBe('ST')
    expect(q.get('redirect_uri')).toBe('http://localhost:5555/callback')
    expect(q.get('login_hint')).toBe('me@example.com')
    expect(q.get('scope')!.split(' ')).toEqual(SCOPES)
    expect(q.get('scope')).toContain('user:inference')
  })

  it('omits the hint when there is none', () => {
    expect(new URL(buildAuthorizeUrl({ challenge: 'c', state: 's', redirectUri: 'http://localhost:1/callback' })).searchParams.has('login_hint')).toBe(false)
  })
})

describe('parseCodeInput', () => {
  it('reads the code#state the hosted page shows, a callback URL, a query string and a bare code', () => {
    expect(parseCodeInput('abc123#st4te')).toEqual({ code: 'abc123', state: 'st4te' })
    expect(parseCodeInput('  abc123#st4te \n')).toEqual({ code: 'abc123', state: 'st4te' })
    expect(parseCodeInput('http://localhost:5555/callback?code=abc123&state=st4te')).toEqual({ code: 'abc123', state: 'st4te' })
    expect(parseCodeInput('?code=abc123&state=st4te')).toEqual({ code: 'abc123', state: 'st4te' })
    expect(parseCodeInput('abc123')).toEqual({ code: 'abc123', state: undefined })
  })
  it('rejects empty input and URLs without a code', () => {
    expect(parseCodeInput('')).toBeNull()
    expect(parseCodeInput('   ')).toBeNull()
    expect(parseCodeInput('http://localhost:5555/callback?state=x')).toBeNull()
  })
})

describe('token exchange', () => {
  it('posts the PKCE verifier and redirect, and returns the tokens', async () => {
    const { fetch, calls } = fakeFetch()
    const t = await exchangeCode(fetch, { code: 'CODE', state: 'ST', verifier: 'VERIFIER', redirectUri: 'http://localhost:5555/callback' })
    expect(t.access_token).toBe(TOKENS.access_token)
    expect(calls[0].url).toBe('https://platform.claude.com/v1/oauth/token')
    expect(calls[0].body).toEqual({ grant_type: 'authorization_code', code: 'CODE', redirect_uri: 'http://localhost:5555/callback', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', code_verifier: 'VERIFIER', state: 'ST' })
    expect(calls[0].headers?.['Content-Type']).toBe('application/json')
  })

  it('turns a rejected code into a plain instruction', async () => {
    const { fetch } = fakeFetch({ token: res(400, { error: 'invalid_grant', error_description: "Invalid 'code' in request." }) })
    await expect(exchangeCode(fetch, { code: 'x', verifier: 'v', redirectUri: 'r' })).rejects.toThrow(/wrong, expired or was already used/)
    await expect(exchangeCode(fetch, { code: 'x', verifier: 'v', redirectUri: 'r' })).rejects.toBeInstanceOf(OAuthError)
  })

  it('refuses a login that carries no refresh token — it would die within hours', async () => {
    const { fetch } = fakeFetch({ token: res(200, { access_token: 'a', expires_in: 1 }) })
    await expect(exchangeCode(fetch, { code: 'x', verifier: 'v', redirectUri: 'r' })).rejects.toThrow(/no refresh token/)
  })

  it('reports a network failure as such', async () => {
    const f: Fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    await expect(exchangeCode(f, { code: 'x', verifier: 'v', redirectUri: 'r' })).rejects.toThrow(/Could not reach Anthropic/)
  })

  it('endpoints can be redirected for tests', () => {
    process.env.CSWAP_DESKTOP_OAUTH_TOKEN = 'http://127.0.0.1:1/token'
    expect(endpoints().token).toBe('http://127.0.0.1:1/token')
  })
})

describe('profile', () => {
  it('sends the bearer token and returns the profile; a refusal is simply "no profile"', async () => {
    const ok = fakeFetch()
    expect((await fetchProfile(ok.fetch, 'TOK'))?.account?.email).toBe('person@example.com')
    expect(ok.calls[0].headers?.Authorization).toBe('Bearer TOK')
    expect(await fetchProfile(fakeFetch({ profile: res(401, {}) }).fetch, 'TOK')).toBeNull()
  })
  it('retries once when the first attempt fails to connect', async () => {
    let n = 0
    const f: Fetch = async () => {
      if (n++ === 0) throw new Error('reset')
      return res(200, PROFILE)
    }
    expect((await fetchProfile(f, 'TOK'))?.organization?.uuid).toBe('org-1')
    expect(n).toBe(2)
  })
})

describe('the account that comes out of a sign-in', () => {
  it('writes Claude Code\'s credential shape, with the plan from the profile', () => {
    const now = Date.UTC(2026, 9, 19, 12)
    const a = buildAccount({ ...TOKENS, refresh_token_expires_in: 86400 }, PROFILE, now)
    expect(a.email).toBe('person@example.com')
    expect(a.organizationUuid).toBe('org-1')
    expect(a.plan).toBe('Max 20x')
    expect(a.credentials.claudeAiOauth).toEqual({
      accessToken: 'sk-ant-oat01-ACCESS',
      refreshToken: 'sk-ant-ort01-REFRESH',
      expiresAt: now + 28800 * 1000,
      refreshTokenExpiresAt: now + 86400 * 1000,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x'
    })
    expect(a.config.oauthAccount).toMatchObject({ accountUuid: 'acc-1', emailAddress: 'person@example.com', organizationUuid: 'org-1', displayName: 'Pat', organizationRateLimitTier: 'default_claude_max_20x', profileFetchedAt: now })
  })

  it('still names the account from the token response when the profile is unavailable', () => {
    const a = buildAccount(TOKENS, null, 0)
    expect(a.email).toBe('person@example.com')
    expect(a.plan).toBeNull()
    expect(a.credentials.claudeAiOauth.subscriptionType).toBeNull()
    expect(a.config.oauthAccount).not.toHaveProperty('profileFetchedAt')
  })

  it('refuses to guess who signed in', () => {
    expect(() => buildAccount({ access_token: 'a', refresh_token: 'r', expires_in: 1 }, null, 0)).toThrow(/did not say which account/)
  })

  it('maps the other subscription kinds', () => {
    const pro = buildAccount(TOKENS, { ...PROFILE, organization: { ...PROFILE.organization, organization_type: 'claude_pro', rate_limit_tier: 'default_claude_pro' } }, 0)
    expect(pro.plan).toBe('Pro')
    expect(pro.credentials.claudeAiOauth.subscriptionType).toBe('pro')
  })

  it('builds a version-1 import envelope with the credentials inside it', () => {
    const a = buildAccount(TOKENS, PROFILE, 1_800_000_000_000)
    const env = buildEnvelope(a, 4, 'work', 1_800_000_000_000) as { version: number; encrypted: boolean; accounts: Record<string, unknown>[] }
    expect(env.version).toBe(1)
    expect(env.encrypted).toBe(false)
    expect(env.accounts).toHaveLength(1)
    expect(env.accounts[0]).toMatchObject({ number: 4, email: 'person@example.com', uuid: 'acc-1', organizationUuid: 'org-1', alias: 'work' })
    expect((env.accounts[0].credentials as { claudeAiOauth: { refreshToken: string } }).claudeAiOauth.refreshToken).toBe('sk-ant-ort01-REFRESH')
    expect(env.accounts[0].config).toHaveProperty('oauthAccount.emailAddress', 'person@example.com')
    expect(buildEnvelope(a, 4, undefined, 0).accounts).not.toHaveProperty('0.alias')
  })
})

describe('LoginSession (loopback)', () => {
  async function started(f: Fetch, extra: { manual?: boolean; loginHint?: string } = {}): Promise<LoginSession> {
    const s = new LoginSession({ fetch: f, ...extra })
    await s.start()
    return s
  }

  it('catches the code the browser is redirected back with and finishes the sign-in', async () => {
    const { fetch, calls } = fakeFetch()
    const s = await started(fetch, { loginHint: 'person@example.com' })
    try {
      expect(s.stage).toBe('waiting')
      expect(new URL(s.url).searchParams.get('login_hint')).toBe('person@example.com')
      const redirect = redirectOf(s.url)
      expect(redirect).toMatch(/^http:\/\/localhost:\d+\/callback$/)
      const done = new Promise<void>((r) => s.on('change', () => s.stage === 'ready' && r()))
      const page = await globalThis.fetch(`${redirect}?code=THECODE&state=${stateOf(s.url)}`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('You are signed in')
      await done
      expect(s.account?.email).toBe('person@example.com')
      // the verifier that went to the token endpoint is the one whose challenge is in the URL
      const body = calls[0].body as { code: string; code_verifier: string; redirect_uri: string }
      expect(body.code).toBe('THECODE')
      expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(new URL(s.url).searchParams.get('code_challenge'))
      expect(body.redirect_uri).toBe(redirect)
    } finally {
      s.dispose()
    }
  })

  it('ignores a callback with the wrong state and keeps waiting', async () => {
    const { fetch, calls } = fakeFetch()
    const s = await started(fetch)
    try {
      const bad = await globalThis.fetch(`${redirectOf(s.url)}?code=EVIL&state=not-the-state`)
      expect(bad.status).toBe(400)
      expect(s.stage).toBe('waiting')
      expect(calls).toHaveLength(0)
      const other = await globalThis.fetch(`http://localhost:${new URL(redirectOf(s.url)).port}/elsewhere`)
      expect(other.status).toBe(404)
    } finally {
      s.dispose()
    }
  })

  it('reports a sign-in the person declined in the browser', async () => {
    const s = await started(fakeFetch().fetch)
    try {
      const failed = new Promise<void>((r) => s.on('change', () => s.stage === 'error' && r()))
      await globalThis.fetch(`${redirectOf(s.url)}?error=access_denied&state=${stateOf(s.url)}`)
      await failed
      expect(s.error).toMatch(/cancelled in the browser/)
    } finally {
      s.dispose()
    }
  })

  it('stops listening once the code has arrived', async () => {
    const s = await started(fakeFetch().fetch)
    const redirect = redirectOf(s.url)
    const done = new Promise<void>((r) => s.on('change', () => s.stage === 'ready' && r()))
    await globalThis.fetch(`${redirect}?code=C&state=${stateOf(s.url)}`)
    await done
    await expect(globalThis.fetch(`${redirect}?code=C&state=${stateOf(s.url)}`)).rejects.toThrow()
    s.dispose()
  })

  it('surfaces a token-exchange failure and releases nothing it should keep', async () => {
    const s = await started(fakeFetch({ token: res(400, { error: 'invalid_grant' }) }).fetch)
    try {
      const failed = new Promise<void>((r) => s.on('change', () => s.stage === 'error' && r()))
      await globalThis.fetch(`${redirectOf(s.url)}?code=C&state=${stateOf(s.url)}`)
      await failed
      expect(s.error).toMatch(/Start the sign-in again/)
      expect(s.account).toBeUndefined()
    } finally {
      s.dispose()
    }
  })

  it('manual mode uses the hosted code page and accepts a pasted code#state', async () => {
    const { fetch, calls } = fakeFetch()
    const s = await started(fetch, { manual: true })
    try {
      expect(redirectOf(s.url)).toBe('https://platform.claude.com/oauth/code/callback')
      await s.submit(`PASTED#${stateOf(s.url)}`)
      expect(s.stage).toBe('ready')
      expect((calls[0].body as { redirect_uri: string }).redirect_uri).toBe('https://platform.claude.com/oauth/code/callback')
    } finally {
      s.dispose()
    }
  })

  it('rejects a pasted code that belongs to another sign-in, and junk', async () => {
    const s = await started(fakeFetch().fetch, { manual: true })
    try {
      await s.submit('CODE#some-other-state')
      expect(s.stage).toBe('error')
      expect(s.error).toMatch(/different sign-in/)
    } finally {
      s.dispose()
    }
    const t = await started(fakeFetch().fetch, { manual: true })
    try {
      await t.submit('   ')
      expect(t.error).toMatch(/does not look like a code/)
    } finally {
      t.dispose()
    }
  })

  it('cancel() ends it and drops the tokens', async () => {
    const s = await started(fakeFetch().fetch, { manual: true })
    await s.submit(`C#${stateOf(s.url)}`)
    expect(s.account?.credentials.claudeAiOauth.accessToken).toBe(TOKENS.access_token)
    s.cancel()
    expect(s.stage).toBe('cancelled')
    expect(s.account?.credentials.claudeAiOauth).toEqual({})
    s.dispose()
  })

  it('gives up after its timeout', async () => {
    const s = new LoginSession({ fetch: fakeFetch().fetch, manual: true, timeoutMs: 30 })
    await s.start()
    await new Promise((r) => setTimeout(r, 120))
    expect(s.stage).toBe('error')
    expect(s.error).toMatch(/Timed out/)
    s.dispose()
  })
})
