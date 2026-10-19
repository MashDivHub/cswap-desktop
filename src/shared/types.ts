// Contract shared by main, preload and renderer. Everything cswap-shaped here
// mirrors claude-swap's `--json` schema v1 (additive: unknown fields are kept).

export type UsageStatus =
  | 'ok'
  | 'token_expired'
  | 'api_key'
  | 'keychain_unavailable'
  | 'relogin_required'
  | 'foreign_credential'
  | 'no_credentials'
  | 'unavailable'
  | (string & {})

export interface UsageWindow {
  pct: number
  resetsAt?: string
  countdown?: string
  clock?: string
  // weekly windows only, present once the week is ~a day old
  expectedPct?: number
  aheadOfPace?: boolean
  projectedExhaustionAt?: string
  willLastToReset?: boolean
}

export interface ScopedWindow extends UsageWindow {
  name: string
}

export interface Usage {
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  scoped?: ScopedWindow[]
}

export interface Account {
  number: number
  email: string
  organizationName: string
  organizationUuid: string
  isOrganization: boolean
  active: boolean
  usageStatus: UsageStatus
  usage: Usage | null
  alias?: string
  disabled?: boolean
  usageFetchedAt?: string
  usageAgeSeconds?: number
  lastGoodUsage?: Usage
  lastGoodFetchedAt?: string
  lastGoodAgeSeconds?: number
}

export interface ListPayload {
  schemaVersion: number
  activeAccountNumber: number | null
  accounts: Account[]
}

export interface AccountRef {
  number: number | null
  email: string
}

export interface SwitchPayload {
  schemaVersion: number
  switched: boolean
  from: AccountRef | null
  to: AccountRef | null
  strategy: string
  reason: string
  message: string
  warnings: string[]
  models?: string[]
  modelSource?: string
}

export interface StatusActive extends Partial<Account> {
  email: string
  managed: boolean
}

export interface StatusPayload {
  schemaVersion: number
  active: StatusActive | null
  totalManagedAccounts?: number
}

export interface ConfigSetting {
  key: string
  value: unknown
  isSet: boolean
}

export interface ConfigPayload {
  schemaVersion: number
  path: string
  settings: ConfigSetting[]
}

export interface CswapError {
  type: string
  message: string
}

// One line of `cswap auto --json`. Kinds are additive upstream; keep the union open.
export interface AutoEvent {
  schemaVersion: number
  event:
    | 'poll'
    | 'switch'
    | 'no-switch'
    | 'account-quarantined'
    | 'account-unquarantined'
    | 'all-exhausted'
    | 'sleep'
    | 'error'
    | 'config-warning'
    | (string & {})
  ts: string
  [k: string]: unknown
}

export interface AutoStatus {
  running: boolean
  pid?: number
  startedAt?: string
  dryRun?: boolean
  exitCode?: number | null
  lastError?: string
}

export interface Mapping {
  path: string
  email: string
  organizationUuid?: string
  account?: Account
}

export interface UnclaimedEntry {
  id: string
  slot: string
  reason: string
}

// A single CLI invocation as the app saw it — the LOG page shows these.
export interface CommandLogEntry {
  id: number
  at: string
  args: string[]
  exitCode: number | null
  durationMs: number
  ok: boolean
  stdout?: string
  stderr?: string
  error?: string
}

export interface AutoOnceResult {
  exitCode: number | null
  outcome: 'switched' | 'error' | 'no-action' | 'blocked' | 'unknown'
  events: AutoEvent[]
}

export interface UpdateInfo {
  current: string
  latest: string | null
  url: string | null
  updateAvailable: boolean
  error?: string
}

export interface UpdaterState {
  status: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  current: string
  version?: string
  percent?: number
  error?: string
  checkedAt?: string
  releaseUrl?: string
  logPath?: string
}

export interface CswapBinaryInfo {
  path: string | null
  source: 'settings' | 'uv' | 'pipx' | 'path' | 'none'
  version: string | null
  error?: string
  candidates: string[]
}

export type ThemeSetting = 'light' | 'dark' | 'system'

export interface AppSettings {
  cswapPath: string | null
  theme: ThemeSetting
  refreshSeconds: number
  closeToTray: boolean
  startMinimized: boolean
  launchAtLogin: boolean
  notifyOnAutoSwitch: boolean
  autoStartAutoSwitch: boolean
  autoDryRun: boolean
  autoUpdate: boolean
  maskEmails: boolean
  refreshOnFocus: boolean
  usageView: 'bars' | 'rings'
  showPace: boolean
  sidebarCollapsed: boolean
  /** Ping idle accounts so their 5-hour window is already running when you get to them. */
  keepWarm: boolean
  /** Minimum minutes between two warm-ups, so the resets spread out instead of landing together. */
  keepWarmStaggerMin: number
  keepWarmModel: string
  /** Emails kept out of keep-warm (the account list is keyed by email in this app's own files). */
  keepWarmExclude: string[]
  /** Which browser the sign-in page opens in. */
  loginBrowser: 'chrome' | 'default'
  /** Open the sign-in page in a private window, so a different account can be picked. */
  loginPrivate: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  cswapPath: null,
  theme: 'light',
  refreshSeconds: 60,
  closeToTray: true,
  startMinimized: false,
  launchAtLogin: false,
  notifyOnAutoSwitch: true,
  autoStartAutoSwitch: false,
  autoDryRun: false,
  autoUpdate: true,
  maskEmails: false,
  refreshOnFocus: true,
  usageView: 'bars',
  showPace: true,
  sidebarCollapsed: false,
  keepWarm: false,
  keepWarmStaggerMin: 30,
  keepWarmModel: 'haiku',
  keepWarmExclude: [],
  loginBrowser: 'chrome',
  loginPrivate: true
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: CswapError }

export interface PlanInfo {
  label: string
  tier?: string
  subscription?: string
  seenAt: string
}

export interface AccountsState {
  payload: ListPayload | null
  fetchedAt: string | null
  refreshing: boolean
  error: CswapError | null
  /** Subscription label per account email — read from the live credential file while
   *  that account was active, so a switched-away account keeps its last known plan. */
  plans?: Record<string, PlanInfo>
}

export interface ExportOptions {
  account?: string
  full?: boolean
}

export interface ImportOptions {
  force?: boolean
}

export interface AddAccountOptions {
  slot?: number
  alias?: string
  overwrite?: boolean
}

export interface AddTokenOptions {
  token: string
  email?: string
  slot?: number
  overwrite?: boolean
}

export interface PlainOutput {
  stdout: string
  stderr: string
  exitCode: number | null
}

// ---- browser sign-in ----------------------------------------------------------------
// Signing in from a browser instead of the terminal: the app runs the same OAuth (PKCE)
// flow Claude Code does, then hands the result to `cswap import` over stdin. The live
// Claude Code login — and every CLI session using it — is never touched.

export interface OAuthStartOptions {
  /** Re-login for this slot: the email becomes the sign-in hint and the result must match it. */
  slot?: number
  email?: string
  /** Show the code on claude.com for pasting, instead of redirecting back to this machine. */
  manual?: boolean
}

export type OAuthStage = 'waiting' | 'exchanging' | 'ready' | 'committing' | 'done' | 'error' | 'cancelled'

export interface OAuthIdentity {
  email: string
  organizationName: string
  organizationUuid: string
  plan: string | null
  /** The managed slot that already holds this identity, if any. */
  existingSlot: number | null
}

export interface OAuthState {
  id: string
  stage: OAuthStage
  /** The sign-in page, for copying into a different browser. */
  url: string
  manual: boolean
  /** What actually opened it; null when nothing could be launched. */
  browser: 'chrome' | 'default' | null
  slot?: number
  identity?: OAuthIdentity
  /** Re-login only: the person who signed in is not the account in the slot. */
  mismatch?: boolean
  error?: string
  result?: { slot: number | null; output: string; note?: string }
}

export interface OAuthCommitOptions {
  alias?: string
  /** Re-login that landed on another identity: keep it, as a new (or its own existing) account. */
  asNew?: boolean
}

// ---- keep warm ----------------------------------------------------------------------

export interface WarmEntry {
  at: string
  ok: boolean
  message?: string
}

export interface WarmState {
  /** Email of the account being pinged right now. */
  running: string | null
  lastPingAt: string | null
  entries: Record<string, WarmEntry>
}

export interface WarmSummary {
  attempted: number
  ok: number
  failed: number
}

// What the renderer can call. Implemented in preload over ipcRenderer.invoke.
export interface CswapApi {
  // state
  getAccounts(): Promise<AccountsState>
  refresh(): Promise<AccountsState>
  getStatus(): Promise<Result<StatusPayload>>
  // mutations (all go through the cswap CLI)
  switchTo(target: string, force?: boolean): Promise<Result<SwitchPayload>>
  rotate(strategy?: 'best' | 'next-available'): Promise<Result<SwitchPayload>>
  addAccount(opts: AddAccountOptions): Promise<Result<PlainOutput>>
  addToken(opts: AddTokenOptions): Promise<Result<PlainOutput>>
  removeAccount(target: string): Promise<Result<PlainOutput>>
  setDisabled(target: string, disabled: boolean): Promise<Result<PlainOutput>>
  setAlias(target: string, alias: string | null): Promise<Result<PlainOutput>>
  moveAccount(target: string, slot: number): Promise<Result<PlainOutput>>
  swapAccounts(a: string, b: string): Promise<Result<PlainOutput>>
  // mappings
  listMappings(): Promise<Result<Mapping[]>>
  mapDirectory(target: string, path: string): Promise<Result<PlainOutput>>
  unmapDirectory(path: string): Promise<Result<PlainOutput>>
  pickDirectory(): Promise<string | null>
  // config (cswap settings.json)
  getConfig(): Promise<Result<ConfigPayload>>
  setConfig(key: string, value: string | null): Promise<Result<PlainOutput>>
  // transfer
  exportAccounts(opts: ExportOptions): Promise<Result<{ path: string; output: PlainOutput } | null>>
  importAccounts(opts: ImportOptions): Promise<Result<{ path: string; output: PlainOutput } | null>>
  // maintenance
  listUnclaimed(): Promise<Result<UnclaimedEntry[]>>
  purgeUnclaimed(id: string): Promise<Result<PlainOutput>>
  upgradeCswap(): Promise<Result<PlainOutput>>
  tokenStatus(): Promise<Result<PlainOutput>>
  launchSession(target: string, cwd?: string): Promise<Result<{ command: string; cwd: string }>>
  // browser sign-in (add an account, or fix a dead login) without touching the live CLI login
  oauthStart(opts: OAuthStartOptions): Promise<Result<OAuthState>>
  oauthReopen(id: string): Promise<Result<OAuthState>>
  oauthSubmitCode(id: string, text: string): Promise<Result<OAuthState>>
  oauthCommit(id: string, opts: OAuthCommitOptions): Promise<Result<OAuthState>>
  oauthCancel(id: string): Promise<void>
  // keep warm
  warmState(): Promise<WarmState>
  /** One account (slot / email) regardless of its window, or every idle one when omitted. */
  warmNow(target?: string): Promise<Result<WarmSummary>>
  checkForUpdate(): Promise<UpdateInfo>
  updaterState(): Promise<UpdaterState>
  updaterCheck(): Promise<UpdaterState>
  updaterInstall(): Promise<void>
  // auto-switch process
  autoStart(opts?: { dryRun?: boolean }): Promise<AutoStatus>
  autoStop(): Promise<AutoStatus>
  autoStatus(): Promise<AutoStatus>
  autoEvents(): Promise<AutoEvent[]>
  autoOnce(opts?: { dryRun?: boolean }): Promise<Result<AutoOnceResult>>
  // app
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  // null until the first detection has finished
  getBinaryInfo(): Promise<CswapBinaryInfo | null>
  detectBinary(): Promise<CswapBinaryInfo>
  pickBinary(): Promise<string | null>
  installCswap(): Promise<Result<PlainOutput>>
  getCommandLog(): Promise<CommandLogEntry[]>
  clearCommandLog(): Promise<void>
  getVaultPath(): Promise<string | null>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  getAppInfo(): Promise<{ version: string; platform: NodeJS.Platform; electron: string }>
  windowControl(action: 'minimize' | 'maximize' | 'close' | 'hide'): Promise<void>
  // push events
  onAccounts(cb: (state: AccountsState) => void): () => void
  onAutoEvent(cb: (ev: AutoEvent) => void): () => void
  onAutoStatus(cb: (st: AutoStatus) => void): () => void
  onCommandLog(cb: (entry: CommandLogEntry) => void): () => void
  onSettings(cb: (s: AppSettings) => void): () => void
  onNavigate(cb: (page: string) => void): () => void
  onUpdater(cb: (st: UpdaterState) => void): () => void
  onBinary(cb: (info: CswapBinaryInfo) => void): () => void
  onOAuth(cb: (st: OAuthState) => void): () => void
  onWarm(cb: (st: WarmState) => void): () => void
}

export const IPC = {
  getAccounts: 'cswap:getAccounts',
  refresh: 'cswap:refresh',
  getStatus: 'cswap:getStatus',
  switchTo: 'cswap:switchTo',
  rotate: 'cswap:rotate',
  addAccount: 'cswap:addAccount',
  addToken: 'cswap:addToken',
  removeAccount: 'cswap:removeAccount',
  setDisabled: 'cswap:setDisabled',
  setAlias: 'cswap:setAlias',
  moveAccount: 'cswap:moveAccount',
  swapAccounts: 'cswap:swapAccounts',
  listMappings: 'cswap:listMappings',
  mapDirectory: 'cswap:mapDirectory',
  unmapDirectory: 'cswap:unmapDirectory',
  pickDirectory: 'app:pickDirectory',
  getConfig: 'cswap:getConfig',
  setConfig: 'cswap:setConfig',
  exportAccounts: 'cswap:export',
  importAccounts: 'cswap:import',
  listUnclaimed: 'cswap:listUnclaimed',
  purgeUnclaimed: 'cswap:purgeUnclaimed',
  upgradeCswap: 'cswap:upgrade',
  tokenStatus: 'cswap:tokenStatus',
  launchSession: 'cswap:launchSession',
  oauthStart: 'oauth:start',
  oauthReopen: 'oauth:reopen',
  oauthSubmitCode: 'oauth:submitCode',
  oauthCommit: 'oauth:commit',
  oauthCancel: 'oauth:cancel',
  warmState: 'warm:state',
  warmNow: 'warm:now',
  checkForUpdate: 'app:checkForUpdate',
  updaterState: 'update:state',
  updaterCheck: 'update:check',
  updaterInstall: 'update:install',
  evUpdater: 'ev:updater',
  autoOnce: 'auto:once',
  autoStart: 'auto:start',
  autoStop: 'auto:stop',
  autoStatus: 'auto:status',
  autoEvents: 'auto:events',
  getSettings: 'app:getSettings',
  setSettings: 'app:setSettings',
  getBinaryInfo: 'app:getBinaryInfo',
  detectBinary: 'app:detectBinary',
  pickBinary: 'app:pickBinary',
  installCswap: 'app:installCswap',
  getCommandLog: 'app:getCommandLog',
  clearCommandLog: 'app:clearCommandLog',
  getVaultPath: 'app:getVaultPath',
  openPath: 'app:openPath',
  openExternal: 'app:openExternal',
  getAppInfo: 'app:getAppInfo',
  windowControl: 'app:windowControl',
  // push
  evAccounts: 'ev:accounts',
  evAutoEvent: 'ev:autoEvent',
  evAutoStatus: 'ev:autoStatus',
  evCommandLog: 'ev:commandLog',
  evSettings: 'ev:settings',
  evNavigate: 'ev:navigate',
  evBinary: 'ev:binary',
  evOAuth: 'ev:oauth',
  evWarm: 'ev:warm'
} as const
