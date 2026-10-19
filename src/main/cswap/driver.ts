import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type {
  AutoEvent,
  AutoOnceResult,
  CommandLogEntry,
  ConfigPayload,
  CswapError,
  ListPayload,
  PlainOutput,
  Result,
  StatusPayload,
  SwitchPayload
} from '@shared/types'

export interface RunOptions {
  stdin?: string
  timeoutMs?: number
  cwd?: string
}

export interface RunOutcome extends PlainOutput {
  durationMs: number
  spawnError?: string
}

const isWin = process.platform === 'win32'

// child.kill() only reaches the shell when a .cmd shim is involved; the node/python
// grandchild would keep stdout open and the timeout would never resolve.
function killTree(pid: number | undefined, fallback: () => void): void {
  if (isWin && pid) spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }).on('error', fallback)
  else fallback()
}

function quoteWin(a: string): string {
  // An empty argument has to be quoted too, or the shell drops it and the next one shifts left.
  return a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
}

export class CswapDriver extends EventEmitter {
  private bin: string | null = null
  private log: CommandLogEntry[] = []
  private seq = 0
  private queue: Promise<unknown> = Promise.resolve()

  setBinary(bin: string | null): void {
    this.bin = bin
  }
  getBinary(): string | null {
    return this.bin
  }
  getLog(): CommandLogEntry[] {
    return this.log
  }
  clearLog(): void {
    this.log = []
  }

  // Raw invocation. Redacts nothing on purpose: tokens are never passed as args
  // (add-token reads them from stdin), and stdin is never logged.
  run(args: string[], opts: RunOptions = {}): Promise<RunOutcome> {
    const bin = this.bin
    const started = Date.now()
    return new Promise((resolve) => {
      if (!bin) {
        return resolve(this.record(args, { stdout: '', stderr: '', exitCode: null, durationMs: 0, spawnError: 'cswap binary not configured' }))
      }
      const useShell = isWin && /\.(cmd|bat)$/i.test(bin)
      const child = useShell
        ? spawn([quoteWin(bin), ...args.map(quoteWin)].join(' '), { shell: true, windowsHide: true, cwd: opts.cwd, env: this.env() })
        : spawn(bin, args, { windowsHide: true, cwd: opts.cwd, env: this.env() })
      let stdout = ''
      let stderr = ''
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        killTree(child.pid, () => child.kill())
        stderr += `\n[cswap-desktop] timed out after ${opts.timeoutMs ?? 60000} ms`
      }, opts.timeoutMs ?? 60000)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d: string) => (stdout += d))
      child.stderr.on('data', (d: string) => (stderr += d))
      child.on('error', (err) => {
        done = true
        clearTimeout(timer)
        resolve(this.record(args, { stdout, stderr, exitCode: null, durationMs: Date.now() - started, spawnError: err.message }))
      })
      child.on('close', (code) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(this.record(args, { stdout, stderr, exitCode: code, durationMs: Date.now() - started }))
      })
      if (opts.stdin !== undefined) {
        child.stdin.on('error', () => {})
        child.stdin.write(opts.stdin)
      }
      child.stdin.end()
    })
  }

  // Mutations are serialized so two clicks never race inside cswap's own locks.
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', CLAUDE_SWAP_NO_UPDATE_CHECK: '1' }
  }

  private record(args: string[], out: RunOutcome): RunOutcome {
    const entry: CommandLogEntry = {
      id: ++this.seq,
      at: new Date().toISOString(),
      args,
      exitCode: out.exitCode,
      durationMs: out.durationMs,
      ok: !out.spawnError && out.exitCode === 0,
      stdout: out.stdout.slice(0, 20000),
      stderr: out.stderr.slice(0, 20000),
      error: out.spawnError
    }
    this.log.push(entry)
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300)
    this.emit('log', entry)
    return out
  }

  // ---- typed commands ----------------------------------------------------

  private parseJson<T>(out: RunOutcome): Result<T> {
    if (out.spawnError) return { ok: false, error: { type: 'SpawnError', message: out.spawnError } }
    const text = out.stdout
    const start = text.indexOf('{')
    if (start >= 0) {
      try {
        const obj = JSON.parse(text.slice(start)) as { error?: CswapError } & T
        if (obj && typeof obj === 'object' && 'error' in obj && obj.error) {
          return { ok: false, error: obj.error }
        }
        if (out.exitCode === 0) return { ok: true, value: obj }
      } catch {
        /* fall through to plain error */
      }
    }
    return { ok: false, error: { type: 'CliError', message: (out.stderr || out.stdout || `exit ${out.exitCode}`).trim() } }
  }

  private plain(out: RunOutcome): Result<PlainOutput> {
    if (out.spawnError) return { ok: false, error: { type: 'SpawnError', message: out.spawnError } }
    if (out.exitCode === 0) return { ok: true, value: { stdout: out.stdout, stderr: out.stderr, exitCode: 0 } }
    const msg = (out.stderr || out.stdout || `exit ${out.exitCode}`).trim().replace(/^Error:\s*/i, '')
    return { ok: false, error: { type: 'CliError', message: msg } }
  }

  async list(): Promise<Result<ListPayload>> {
    return this.parseJson<ListPayload>(await this.run(['list', '--json'], { timeoutMs: 120000 }))
  }
  async status(): Promise<Result<StatusPayload>> {
    return this.parseJson<StatusPayload>(await this.run(['status', '--json'], { timeoutMs: 60000 }))
  }
  switchTo(target: string, force = false): Promise<Result<SwitchPayload>> {
    const args = ['switch', target, '--json']
    if (force) args.push('--force')
    return this.serial(async () => this.parseJson<SwitchPayload>(await this.run(args, { timeoutMs: 120000 })))
  }
  rotate(strategy?: 'best' | 'next-available'): Promise<Result<SwitchPayload>> {
    const args = ['switch', '--json']
    if (strategy) args.push('--strategy', strategy)
    return this.serial(async () => this.parseJson<SwitchPayload>(await this.run(args, { timeoutMs: 120000 })))
  }
  addAccount(slot?: number, alias?: string, overwrite = false): Promise<Result<PlainOutput>> {
    const args = ['add']
    if (slot !== undefined) args.push('--slot', String(slot))
    if (alias) args.push('--alias', alias)
    // `add --slot N` asks "Overwrite slot N? [y/N]" when N is taken; answer from stdin.
    return this.serial(async () => this.plain(await this.run(args, { stdin: overwrite ? 'y\n' : 'n\n', timeoutMs: 60000 })))
  }
  addToken(token: string, email?: string, slot?: number, overwrite = false): Promise<Result<PlainOutput>> {
    const args = ['add-token', '-']
    if (email) args.push('--email', email)
    if (slot !== undefined) args.push('--slot', String(slot))
    // Token goes on stdin (never argv), followed by the overwrite answer if prompted.
    return this.serial(async () =>
      this.plain(await this.run(args, { stdin: `${token.trim()}\n${overwrite ? 'y' : 'n'}\n`, timeoutMs: 60000 }))
    )
  }
  // `cswap import -`: the envelope arrives on stdin, so credentials never touch disk or argv.
  // A plain import leaves a healthy slot alone; --force replaces it (a re-login must).
  importEnvelope(json: string, force: boolean): Promise<Result<PlainOutput>> {
    const args = ['import', '-']
    if (force) args.push('--force')
    return this.serial(async () => this.plain(await this.run(args, { stdin: json, timeoutMs: 120000 })))
  }
  // Session mode (`cswap run`): Claude Code runs against a per-account profile, so the live
  // login — and every terminal using it — is never touched. One tiny prompt starts the
  // account's 5-hour window; --output-format json says whether it actually went through.
  // Goes through the mutation queue because it can bootstrap a profile and rotate a token.
  warmUp(target: string, model: string, cwd: string): Promise<Result<{ reply: string }>> {
    const args = ['run', target, '--', ...warmArgs(model)]
    return this.serial(async () => {
      const out = await this.run(args, { cwd, timeoutMs: 180000 })
      if (out.spawnError) return { ok: false, error: { type: 'SpawnError', message: out.spawnError } }
      const reply = parseWarmReply(out.stdout)
      if (reply && !reply.isError && out.exitCode === 0) return { ok: true, value: { reply: reply.text } }
      const message = reply?.text || (out.stderr || out.stdout || `exit ${out.exitCode}`).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)
      return { ok: false, error: { type: 'WarmError', message } }
    })
  }
  removeAccount(target: string): Promise<Result<PlainOutput>> {
    // The UI confirms first; cswap's own "[y/N]" prompt is answered on stdin.
    return this.serial(async () => this.plain(await this.run(['remove', target], { stdin: 'y\n', timeoutMs: 60000 })))
  }
  setDisabled(target: string, disabled: boolean): Promise<Result<PlainOutput>> {
    return this.serial(async () => this.plain(await this.run([disabled ? 'disable' : 'enable', target])))
  }
  setAlias(target: string, alias: string | null): Promise<Result<PlainOutput>> {
    const args = alias ? ['alias', target, alias] : ['alias', target, '--unset']
    return this.serial(async () => this.plain(await this.run(args)))
  }
  moveAccount(target: string, slot: number): Promise<Result<PlainOutput>> {
    return this.serial(async () => this.plain(await this.run(['move', target, String(slot)])))
  }
  swapAccounts(a: string, b: string): Promise<Result<PlainOutput>> {
    return this.serial(async () => this.plain(await this.run(['swap', a, b])))
  }
  mapDirectory(target: string, path: string): Promise<Result<PlainOutput>> {
    return this.serial(async () => this.plain(await this.run(['map', target, path])))
  }
  unmapDirectory(path: string): Promise<Result<PlainOutput>> {
    return this.serial(async () => this.plain(await this.run(['unmap', path])))
  }
  async listMappingsText(): Promise<Result<PlainOutput>> {
    return this.plain(await this.run(['map']))
  }
  async config(): Promise<Result<ConfigPayload>> {
    return this.parseJson<ConfigPayload>(await this.run(['config', 'list', '--json']))
  }
  async configPath(): Promise<string | null> {
    const out = await this.run(['config', 'path'])
    return out.exitCode === 0 ? out.stdout.trim() || null : null
  }
  setConfig(key: string, value: string | null): Promise<Result<PlainOutput>> {
    const args = value === null ? ['config', 'unset', key] : ['config', 'set', key, value]
    return this.serial(async () => this.plain(await this.run(args)))
  }
  exportAccounts(path: string, account?: string, full?: boolean): Promise<Result<PlainOutput>> {
    const args = ['export', path]
    if (account) args.push('--account', account)
    if (full) args.push('--full')
    return this.serial(async () => this.plain(await this.run(args, { timeoutMs: 60000 })))
  }
  importAccounts(path: string, force?: boolean): Promise<Result<PlainOutput>> {
    const args = ['import', path]
    if (force) args.push('--force')
    return this.serial(async () => this.plain(await this.run(args, { timeoutMs: 120000 })))
  }
  async unclaimedText(): Promise<Result<PlainOutput>> {
    return this.plain(await this.run(['unclaimed']))
  }
  purgeUnclaimed(id: string): Promise<Result<PlainOutput>> {
    return this.serial(async () => this.plain(await this.run(['unclaimed', '--purge', id])))
  }
  async tokenStatus(): Promise<Result<PlainOutput>> {
    return this.plain(await this.run(['list', '--token-status'], { timeoutMs: 120000 }))
  }
  // `cswap auto --once`: exit 0 switched · 1 error · 2 nothing to do · 3 blocked.
  autoOnce(dryRun = false): Promise<Result<AutoOnceResult>> {
    const args = ['auto', '--once', '--json']
    if (dryRun) args.push('--dry-run')
    return this.serial(async () => {
      const out = await this.run(args, { timeoutMs: 180000 })
      if (out.spawnError) return { ok: false, error: { type: 'SpawnError', message: out.spawnError } }
      const events: AutoEvent[] = []
      for (const line of out.stdout.split(/\r?\n/)) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        try {
          const obj = JSON.parse(t) as AutoEvent & { error?: CswapError }
          if (obj.error) return { ok: false, error: obj.error }
          events.push(obj)
        } catch {
          /* ignore noise */
        }
      }
      const outcome = out.exitCode === 0 ? 'switched' : out.exitCode === 2 ? 'no-action' : out.exitCode === 3 ? 'blocked' : out.exitCode === 1 ? 'error' : 'unknown'
      if (outcome === 'error' && !events.length) return { ok: false, error: { type: 'CliError', message: (out.stderr || out.stdout || 'exit 1').trim() } }
      return { ok: true, value: { exitCode: out.exitCode, outcome, events } }
    })
  }
  upgrade(): Promise<Result<PlainOutput>> {
    return this.serial(async () => this.plain(await this.run(['upgrade'], { timeoutMs: 300000 })))
  }
}

// The ping itself. A one-word question, one turn, no tools, no saved transcript: it costs a
// few tokens and exists only so the account has a running 5-hour window.
export const WARM_PROMPT = 'Reply with the single word: ok'
export function warmArgs(model: string): string[] {
  return ['-p', WARM_PROMPT, '--model', model, '--max-turns', '1', '--output-format', 'json', '--no-session-persistence', '--tools', '']
}

// `claude -p --output-format json` prints one object; cswap adds a "Launching …" line before it.
export function parseWarmReply(stdout: string): { isError: boolean; text: string } | null {
  for (const raw of stdout.split(/\r?\n/).reverse()) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    try {
      const o = JSON.parse(line) as { is_error?: boolean; result?: unknown; subtype?: string }
      if (typeof o !== 'object' || o === null) continue
      return { isError: o.is_error === true, text: typeof o.result === 'string' ? o.result.trim() : String(o.subtype ?? '') }
    } catch {
      /* not the JSON line */
    }
  }
  return null
}

// `cswap map` has no --json; its lines look like:
//   <path> → 2: me@example.com [tag]
//   <path> → me@example.com (account removed)
export function parseMappings(text: string): { path: string; email: string; number: number | null }[] {
  const rows: { path: string; email: string; number: number | null }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (!line || /^no directory mappings/i.test(line) || /^map one with/i.test(line) || /^directory mappings:?$/i.test(line)) continue
    const m = line.match(/^(.*?)\s+(?:→|->)\s+(?:(\d+):\s+)?(\S+@\S+)/)
    if (m) rows.push({ path: m[1].trim(), email: m[3], number: m[2] ? Number(m[2]) : null })
  }
  return rows
}

export function parseUnclaimed(text: string): { id: string; slot: string; reason: string }[] {
  const rows: { id: string; slot: string; reason: string }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (!line || /^no unclaimed/i.test(line)) continue
    const m = line.match(/^(\S+)\s+slot\s+(\S+)\s+(.*)$/)
    if (m) rows.push({ id: m[1], slot: m[2], reason: m[3] })
  }
  return rows
}
