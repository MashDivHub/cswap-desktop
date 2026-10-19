import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OAuthStage } from '@shared/types'
import { labelFor } from './plan'

// The same OAuth (authorization code + PKCE) flow Claude Code runs for `/login`, so a
// login made here is indistinguishable from one made in the terminal — except that it
// never touches ~/.claude. The endpoints, client id and scopes are Claude Code's own;
// the result is handed to `cswap import` (see login.ts), which owns the vault.

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const SCOPES = ['org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload', 'user:plugins']
const USER_AGENT = 'cswap-desktop'

export interface OAuthEndpoints {
  authorize: string
  token: string
  profile: string
  manualRedirect: string
}

// Overridable so the whole flow can be exercised against a local stand-in.
export function endpoints(): OAuthEndpoints {
  return {
    authorize: process.env.CSWAP_DESKTOP_OAUTH_AUTHORIZE || 'https://claude.com/cai/oauth/authorize',
    token: process.env.CSWAP_DESKTOP_OAUTH_TOKEN || 'https://platform.claude.com/v1/oauth/token',
    profile: process.env.CSWAP_DESKTOP_OAUTH_PROFILE || 'https://api.anthropic.com/api/oauth/profile',
    manualRedirect: 'https://platform.claude.com/oauth/code/callback'
  }
}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

// ---- PKCE ---------------------------------------------------------------------------

export function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString('base64url')
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url')
  }
}

export function buildAuthorizeUrl(p: { challenge: string; state: string; redirectUri: string; loginHint?: string }): string {
  const u = new URL(endpoints().authorize)
  u.searchParams.append('code', 'true')
  u.searchParams.append('client_id', CLIENT_ID)
  u.searchParams.append('response_type', 'code')
  u.searchParams.append('redirect_uri', p.redirectUri)
  u.searchParams.append('scope', SCOPES.join(' '))
  u.searchParams.append('code_challenge', p.challenge)
  u.searchParams.append('code_challenge_method', 'S256')
  u.searchParams.append('state', p.state)
  if (p.loginHint) u.searchParams.append('login_hint', p.loginHint)
  return u.toString()
}

// What a person can paste back: the callback URL their browser ended up on, a query
// string, the `code#state` the hosted code page shows, or the bare code.
export function parseCodeInput(raw: string): { code: string; state?: string } | null {
  const text = raw.trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) {
    try {
      const u = new URL(text)
      const code = u.searchParams.get('code')
      return code ? { code, state: u.searchParams.get('state') ?? undefined } : null
    } catch {
      return null
    }
  }
  if (/(^|[?&])code=/.test(text)) {
    const q = new URLSearchParams(text.replace(/^\?/, ''))
    const code = q.get('code')
    return code ? { code, state: q.get('state') ?? undefined } : null
  }
  const [code, state] = text.split('#')
  return code.trim() ? { code: code.trim(), state: state?.trim() || undefined } : null
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// ---- token + profile ----------------------------------------------------------------

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  refresh_token_expires_in?: number
  account?: { uuid?: string; email_address?: string }
  organization?: { uuid?: string; name?: string }
}

export interface Profile {
  account?: { uuid?: string; email?: string; full_name?: string; display_name?: string; created_at?: string }
  organization?: {
    uuid?: string
    name?: string
    organization_type?: string
    rate_limit_tier?: string
    billing_type?: string
    has_extra_usage_enabled?: boolean
    subscription_created_at?: string
    cc_onboarding_flags?: Record<string, unknown>
    seat_tier?: string | null
    claude_code_trial_ends_at?: string | null
    claude_code_trial_duration_days?: number | null
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function exchangeCode(f: Fetch, p: { code: string; state?: string; verifier: string; redirectUri: string }): Promise<TokenResponse> {
  let res: Awaited<ReturnType<Fetch>>
  try {
    res = await f(endpoints().token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, client_id: CLIENT_ID, code_verifier: p.verifier, ...(p.state ? { state: p.state } : {}) })
    })
  } catch (e) {
    throw new OAuthError(`Could not reach Anthropic to finish the sign-in: ${(e as Error).message}`, 'network')
  }
  const text = await res.text()
  const body = parseJson(text)
  if (!res.ok) {
    const code = typeof body?.error === 'string' ? body.error : undefined
    if (code === 'invalid_grant' || res.status === 401) throw new OAuthError('Anthropic rejected the code — it is wrong, expired or was already used. Start the sign-in again.', code ?? 'invalid_grant')
    throw new OAuthError(`Anthropic refused the sign-in (HTTP ${res.status}${code ? `, ${code}` : ''}).`, code)
  }
  if (!body || typeof body.access_token !== 'string' || !body.access_token) throw new OAuthError('Anthropic answered without an access token.', 'bad-response')
  if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw new OAuthError('Anthropic issued no refresh token, so this login would expire within hours. Try again.', 'no-refresh-token')
  return body as unknown as TokenResponse
}

// Best effort: the profile adds the plan and a few labels, but the token response already
// names the account, so a profile that fails once is retried and then simply left out.
export async function fetchProfile(f: Fetch, accessToken: string): Promise<Profile | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await f(endpoints().profile, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT } })
      if (res.ok) return (parseJson(await res.text()) as Profile | null) ?? null
      if (res.status === 401 || res.status === 403) return null
    } catch {
      /* one more try */
    }
  }
  return null
}

// ---- the account that came out of it ------------------------------------------------

const SUBSCRIPTION: Record<string, string> = { claude_max: 'max', claude_pro: 'pro', claude_enterprise: 'enterprise', claude_team: 'team' }

export interface BuiltAccount {
  email: string
  uuid: string
  organizationUuid: string
  organizationName: string
  plan: string | null
  /** Claude Code's own credential file shape. Held in memory only, until it is imported. */
  credentials: { claudeAiOauth: Record<string, unknown> }
  /** The slice of ~/.claude.json that cswap keeps per account. */
  config: { oauthAccount: Record<string, unknown> }
}

export function buildAccount(tokens: TokenResponse, profile: Profile | null, now: number): BuiltAccount {
  const email = profile?.account?.email || tokens.account?.email_address
  if (!email) throw new OAuthError('Signed in, but Anthropic did not say which account this is.', 'no-identity')
  const uuid = profile?.account?.uuid || tokens.account?.uuid || ''
  const org = profile?.organization
  const organizationUuid = org?.uuid || tokens.organization?.uuid || ''
  const organizationName = org?.name || tokens.organization?.name || ''
  const subscriptionType = (org?.organization_type && SUBSCRIPTION[org.organization_type]) || null
  const rateLimitTier = org?.rate_limit_tier ?? null

  const oauth: Record<string, unknown> = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: now + tokens.expires_in * 1000
  }
  if (typeof tokens.refresh_token_expires_in === 'number') oauth.refreshTokenExpiresAt = now + tokens.refresh_token_expires_in * 1000
  oauth.scopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : SCOPES
  oauth.subscriptionType = subscriptionType
  oauth.rateLimitTier = rateLimitTier

  const account: Record<string, unknown> = { accountUuid: uuid, emailAddress: email, organizationUuid, organizationName }
  const optional: Record<string, unknown> = {
    hasExtraUsageEnabled: org?.has_extra_usage_enabled,
    billingType: org?.billing_type,
    accountCreatedAt: profile?.account?.created_at,
    subscriptionCreatedAt: org?.subscription_created_at,
    ccOnboardingFlags: org?.cc_onboarding_flags,
    claudeCodeTrialEndsAt: org?.claude_code_trial_ends_at,
    claudeCodeTrialDurationDays: org?.claude_code_trial_duration_days,
    seatTier: org?.seat_tier,
    displayName: profile?.account?.display_name,
    fullName: profile?.account?.full_name,
    organizationType: org?.organization_type,
    organizationRateLimitTier: rateLimitTier ?? undefined
  }
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) account[k] = v
  if (profile) account.profileFetchedAt = now

  return {
    email,
    uuid,
    organizationUuid,
    organizationName,
    plan: labelFor(rateLimitTier ?? undefined, subscriptionType ?? undefined),
    credentials: { claudeAiOauth: oauth },
    config: { oauthAccount: account }
  }
}

// `cswap import` envelope, format version 1 (see claude_swap/transfer.py).
export function buildEnvelope(a: BuiltAccount, number: number, alias: string | undefined, now: number): Record<string, unknown> {
  const iso = new Date(now).toISOString()
  return {
    version: 1,
    exportedAt: iso,
    exportedFrom: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    swapVersion: 'cswap-desktop',
    encrypted: false,
    activeAccountNumber: null,
    accounts: [
      {
        number,
        email: a.email,
        uuid: a.uuid,
        organizationUuid: a.organizationUuid,
        organizationName: a.organizationName,
        added: iso,
        credentials: a.credentials,
        config: a.config,
        ...(alias ? { alias } : {})
      }
    ]
  }
}

// ---- one sign-in --------------------------------------------------------------------

const PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{font:15px system-ui,sans-serif;background:#f4f4f6;color:#1c1c20}body{max-width:420px;margin:18vh auto;padding:0 24px;text-align:center}h1{font-size:19px;margin:0 0 8px}p{color:#5b5b66;margin:0}@media(prefers-color-scheme:dark){html{background:#151517;color:#ececf0}p{color:#9a9aa6}}</style><h1>${title}</h1><p>${body}</p>`

export interface SessionSnapshot {
  stage: OAuthStage
  url: string
  manual: boolean
  error?: string
  account?: BuiltAccount
}

export interface LoginSessionOptions {
  fetch: Fetch
  manual?: boolean
  loginHint?: string
  timeoutMs?: number
  now?: () => number
}

// Waits for the browser to come back with a code, trades it for tokens and works out who
// signed in. Emits 'change' on every stage. Tokens live on this object and nowhere else.
export class LoginSession extends EventEmitter {
  readonly id = randomBytes(8).toString('hex')
  readonly manual: boolean
  stage: OAuthStage = 'waiting'
  url = ''
  error?: string
  account?: BuiltAccount
  private pkce = createPkce()
  private redirectUri = ''
  private servers: Server[] = []
  private timer: NodeJS.Timeout | null = null
  private now: () => number

  constructor(private opts: LoginSessionOptions) {
    super()
    this.manual = !!opts.manual
    this.now = opts.now ?? Date.now
  }

  async start(): Promise<void> {
    if (this.manual) this.redirectUri = endpoints().manualRedirect
    else this.redirectUri = `http://localhost:${await this.listen()}/callback`
    this.url = buildAuthorizeUrl({ challenge: this.pkce.challenge, state: this.pkce.state, redirectUri: this.redirectUri, loginHint: this.opts.loginHint })
    this.timer = setTimeout(() => this.fail('Timed out after 10 minutes without a sign-in. Start again when you are ready.'), this.opts.timeoutMs ?? 600_000)
    this.timer.unref?.()
  }

  snapshot(): SessionSnapshot {
    return { stage: this.stage, url: this.url, manual: this.manual, error: this.error, account: this.account }
  }

  // Loopback only, on a port the OS picks. `localhost` can resolve to either family, so
  // both are served when the machine has both.
  private async listen(): Promise<number> {
    const first = createServer((req, res) => this.onRequest(req, res))
    await new Promise<void>((resolve, reject) => {
      first.once('error', reject)
      first.listen(0, '127.0.0.1', resolve)
    })
    this.servers.push(first)
    const port = (first.address() as AddressInfo).port
    const second = createServer((req, res) => this.onRequest(req, res))
    await new Promise<void>((resolve) => {
      second.once('error', () => resolve())
      second.listen(port, '::1', () => {
        this.servers.push(second)
        resolve()
      })
    })
    return port
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const send = (status: number, title: string, body: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(PAGE(title, body))
    }
    const u = new URL(req.url ?? '/', 'http://localhost')
    if (req.method !== 'GET' || u.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const denied = u.searchParams.get('error')
    if (denied) {
      send(400, 'Sign-in was not completed', 'You can close this tab and try again from Claude Swap.')
      this.fail(denied === 'access_denied' ? 'The sign-in was cancelled in the browser.' : `The browser reported: ${u.searchParams.get('error_description') || denied}`)
      return
    }
    const code = u.searchParams.get('code')
    const state = u.searchParams.get('state')
    if (!code || !state || !sameSecret(state, this.pkce.state)) {
      send(400, 'This sign-in link is not valid', 'Start the sign-in again from Claude Swap.')
      return
    }
    if (this.stage !== 'waiting') {
      send(200, 'Already handled', 'You can close this tab.')
      return
    }
    send(200, 'You are signed in', 'You can close this tab and go back to Claude Swap.')
    void this.finish(code, state)
  }

  // From a pasted code or URL. A state that is present must be ours; one that is missing
  // is fine, because the code is bound to the PKCE verifier anyway.
  async submit(text: string): Promise<void> {
    if (this.stage !== 'waiting') return
    const parsed = parseCodeInput(text)
    if (!parsed) return this.fail('That does not look like a code. Paste the whole line the page showed, or the address your browser ended up on.')
    if (parsed.state && !sameSecret(parsed.state, this.pkce.state)) return this.fail('That code belongs to a different sign-in. Use the page this window opened most recently.')
    await this.finish(parsed.code, parsed.state ?? this.pkce.state)
  }

  private async finish(code: string, state: string): Promise<void> {
    this.closeServers()
    this.setStage('exchanging')
    try {
      const tokens = await exchangeCode(this.opts.fetch, { code, state, verifier: this.pkce.verifier, redirectUri: this.redirectUri })
      const profile = await fetchProfile(this.opts.fetch, tokens.access_token)
      this.account = buildAccount(tokens, profile, this.now())
      this.setStage('ready')
    } catch (e) {
      this.fail((e as Error).message)
    }
  }

  setStage(stage: OAuthStage): void {
    this.stage = stage
    this.emit('change', this.snapshot())
  }

  fail(message: string): void {
    if (this.stage === 'done' || this.stage === 'cancelled') return
    this.error = message
    this.release()
    this.closeServers()
    this.setStage('error')
  }

  cancel(): void {
    if (this.stage === 'done') return
    this.release()
    this.closeServers()
    this.setStage('cancelled')
  }

  // The tokens are only ever needed until they are imported.
  release(): void {
    this.account = this.account ? { ...this.account, credentials: { claudeAiOauth: {} } } : undefined
  }

  private closeServers(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const s of this.servers) s.close()
    this.servers = []
  }

  dispose(): void {
    this.closeServers()
    this.release()
    this.removeAllListeners()
  }
}
