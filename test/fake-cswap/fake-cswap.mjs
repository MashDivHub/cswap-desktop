#!/usr/bin/env node
// A stand-in for the real `cswap` CLI. Same verbs, same --json schema v1, same
// stdin prompts — backed by a JSON state file so tests can seed and inspect it.
//   FAKE_CSWAP_STATE  path to the state file (default: ./fake-cswap-state.json)
//   FAKE_CSWAP_DELAY  ms to sleep before answering (default 0)
//   FAKE_CSWAP_FAIL   verb name that should fail with an error envelope
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const STATE = process.env.FAKE_CSWAP_STATE || 'fake-cswap-state.json'
const argv = process.argv.slice(2)
const out = (s) => process.stdout.write(s + '\n')
const err = (s) => process.stderr.write(s + '\n')

const seed = () => ({
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
  log: []
})

function load() {
  if (!existsSync(STATE)) {
    const s = seed()
    save(s)
    return s
  }
  return JSON.parse(readFileSync(STATE, 'utf8'))
}
function save(s) {
  mkdirSync(dirname(STATE) || '.', { recursive: true })
  writeFileSync(STATE, JSON.stringify(s, null, 2))
}
// The real cswap serialises itself with file locks. Two fake processes reading and writing
// one state file at the same moment would lose each other's updates, so every call but the
// long-running `auto` takes this lock until it exits.
function lock() {
  const path = `${STATE}.lock`
  mkdirSync(dirname(path) || '.', { recursive: true })
  for (let i = 0; i < 600; i++) {
    try {
      closeSync(openSync(path, 'wx'))
      return () => {
        try {
          unlinkSync(path)
        } catch {
          /* already gone */
        }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  return () => {} // a stale lock from a killed process: carry on rather than hang the test
}
const iso = (secs) => new Date(Date.now() + secs * 1000).toISOString()
function window(pct, secs, weekly) {
  const w = { pct, resetsAt: iso(secs), countdown: `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`, clock: '09:00' }
  if (weekly) Object.assign(w, { expectedPct: 50.0, aheadOfPace: pct > 55, projectedExhaustionAt: iso(secs * 3), willLastToReset: pct < 90 })
  return w
}
function row(num, a, active) {
  const r = {
    number: Number(num),
    email: a.email,
    organizationName: a.organizationName || '',
    organizationUuid: a.organizationUuid || '',
    isOrganization: !!a.organizationUuid,
    active,
    usageStatus: a.usageStatus || 'ok',
    usage: null
  }
  if (a.alias) r.alias = a.alias
  if (a.disabled) r.disabled = true
  if (!a.usageStatus && a.usage) {
    r.usage = {
      fiveHour: a.idle ? { pct: 0 } : window(a.usage.five_hour, a.resetsIn5h ?? 3.5 * 3600),
      sevenDay: window(a.usage.seven_day, 2 * 86400 + 3600, true)
    }
    if (a.usage.scoped) r.usage.scoped = a.usage.scoped.map((s) => ({ ...window(s.pct, 2 * 86400, true), name: s.name }))
    r.usageFetchedAt = new Date().toISOString()
    r.usageAgeSeconds = 12.5
  }
  return r
}
const ref = (s, num) => (num == null ? null : { number: Number(num), email: s.accounts[num]?.email ?? '' })
function resolve(s, ident) {
  if (ident == null) return null
  if (/^\d+$/.test(ident)) return s.accounts[ident] ? ident : null
  for (const [n, a] of Object.entries(s.accounts)) if (a.email === ident || a.alias === ident) return n
  return null
}
function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}
const fail = (type, message, json) => {
  if (json) out(JSON.stringify({ schemaVersion: 1, error: { type, message } }, null, 2))
  else err(`Error: ${message}`)
  process.exit(1)
}

// `cswap import -`: the version-1 envelope on stdin, answered the way the real CLI does
// (progress on stderr). Credentials are never stored here — only whether they arrived.
function importFromStdin(s) {
  let env
  try {
    env = JSON.parse(readStdin())
  } catch {
    fail('TransferError', 'export file is not valid JSON', false)
  }
  if (env.version !== 1) fail('TransferError', `unsupported export version: ${env.version}`, false)
  const force = argv.includes('--force')
  let imported = 0
  let overwrote = 0
  let skipped = 0
  for (const a of env.accounts ?? []) {
    const found = Object.entries(s.accounts).find(([, x]) => x.email === a.email && (x.organizationUuid || '') === (a.organizationUuid || ''))
    const arrived = !!a.credentials?.claudeAiOauth?.refreshToken
    if (found) {
      if (!force) {
        err(`Skipped ${a.email} (already exists, use --force)`)
        skipped++
        continue
      }
      const [n, x] = found
      // The real import rewrites the whole record: alias comes from the envelope, a hold is dropped.
      const next = { ...x, organizationName: a.organizationName ?? x.organizationName, loginArrived: arrived, idle: true, usage: x.usage ?? { five_hour: 0, seven_day: 0 } }
      delete next.disabled
      delete next.usageStatus
      if (a.alias) next.alias = a.alias
      else delete next.alias
      s.accounts[n] = next
      err(`Overwrote ${a.email} (slot ${n})`)
      overwrote++
    } else {
      let n = String(a.number)
      if (s.accounts[n]) n = String(Math.max(0, ...s.sequence) + 1)
      s.accounts[n] = { email: a.email, organizationName: a.organizationName || '', organizationUuid: a.organizationUuid || '', loginArrived: arrived, idle: true, usage: { five_hour: 0, seven_day: 0 }, ...(a.alias ? { alias: a.alias } : {}) }
      if (!s.sequence.includes(Number(n))) s.sequence.push(Number(n))
      s.sequence.sort((x, y) => x - y)
      err(`Imported ${a.email} → slot ${n}`)
      imported++
    }
  }
  s.lastImport = { force, accounts: (env.accounts ?? []).map((a) => a.email) }
  save(s)
  err(`Done: ${imported} imported, ${overwrote} overwritten, ${skipped} skipped`)
}

async function main() {
  const delay = Number(process.env.FAKE_CSWAP_DELAY || 0)
  if (delay) await new Promise((r) => setTimeout(r, delay))
  if (argv[0] !== 'auto') process.on('exit', lock())
  const s = load()
  const json = argv.includes('--json')
  const verb = argv[0]
  const VALUE_OPTS = new Set(['--strategy', '--slot', '--email', '--account', '--purge', '--model', '--interval', '--threshold', '--cooldown', '--alias'])
  const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(argv[i - 1]))
  const opt = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  s.log.push(argv)
  save(s) // every call is recorded, reads included
  if (process.env.FAKE_CSWAP_FAIL && process.env.FAKE_CSWAP_FAIL === verb) {
    save(s)
    fail('ConfigError', `forced failure for ${verb}`, json)
  }

  switch (verb) {
    case '--version':
      out(`cswap ${s.version}`)
      return
    case 'list': {
      if (argv.includes('--token-status')) {
        for (const n of s.sequence) out(`Account-${n}: ${s.accounts[n].email}\n  token: ${s.accounts[n].usageStatus === 'api_key' ? 'api key' : 'valid'} (expires in 6h) source=file`)
        return
      }
      const accounts = s.sequence.map((n) => row(n, s.accounts[n], s.activeAccountNumber === n))
      if (json) out(JSON.stringify({ schemaVersion: 1, activeAccountNumber: s.activeAccountNumber, accounts }, null, 2))
      else for (const r of accounts) out(`${r.active ? '*' : ' '} Account-${r.number}: ${r.email}`)
      return
    }
    case 'status': {
      const n = s.activeAccountNumber
      const a = s.accounts[n]
      const active = a ? { ...row(n, a, true), managed: true } : null
      if (json) out(JSON.stringify({ schemaVersion: 1, active, totalManagedAccounts: s.sequence.length }, null, 2))
      else out(a ? `Current: Account-${n} (${a.email})` : 'No active account')
      return
    }
    case 'switch': {
      const target = pos[1]
      const strategy = opt('--strategy') || 'rotation'
      let to
      if (target) {
        to = resolve(s, target)
        if (!to) fail('AccountNotFoundError', `No account found with identifier: ${target}`, json)
        if (s.accounts[to].disabled && false) fail('ConfigError', 'disabled', json)
      } else {
        const enabled = s.sequence.filter((n) => !s.accounts[n].disabled)
        if (strategy === 'best') {
          to = enabled.slice().sort((a, b) => (s.accounts[a].usage?.five_hour ?? 100) - (s.accounts[b].usage?.five_hour ?? 100))[0]
        } else {
          const i = enabled.indexOf(s.activeAccountNumber)
          to = enabled[(i + 1) % enabled.length]
          if (strategy === 'next-available') while (s.accounts[to].usage?.five_hour >= 100) to = enabled[(enabled.indexOf(to) + 1) % enabled.length]
        }
      }
      const from = s.activeAccountNumber
      const switched = Number(from) !== Number(to)
      s.activeAccountNumber = Number(to)
      s.liveIdentity = s.accounts[to].email
      save(s)
      const payload = {
        schemaVersion: 1,
        switched,
        from: ref(s, from),
        to: ref(s, to),
        strategy,
        reason: switched ? 'switched' : 'already-active',
        message: switched ? `Switched to Account-${to} (${s.accounts[to].email})` : `Already on Account-${to} (${s.accounts[to].email})`,
        warnings: argv.includes('--force') ? ['Activated stored credentials without backing up the current login'] : []
      }
      if (json) out(JSON.stringify(payload, null, 2))
      else out(payload.message)
      return
    }
    case 'add': {
      const slot = opt('--slot')
      const alias = opt('--alias')
      let n = slot
      if (slot && s.accounts[slot] && s.accounts[slot].email !== s.liveIdentity) {
        process.stdout.write(`Overwrite slot ${slot}? [y/N] `)
        const ans = readStdin().trim().split('\n')[0]?.trim().toLowerCase()
        if (ans !== 'y') {
          out('Cancelled')
          save(s)
          return
        }
      }
      const existing = Object.entries(s.accounts).find(([, a]) => a.email === s.liveIdentity)?.[0]
      if (!n) n = existing ?? String(Math.max(0, ...s.sequence) + 1)
      s.accounts[n] = { ...(s.accounts[n] ?? {}), email: s.liveIdentity, organizationName: 'Live Org', organizationUuid: 'org-live', usage: { five_hour: 0, seven_day: 0 } }
      if (alias) s.accounts[n].alias = alias
      if (!s.sequence.includes(Number(n))) s.sequence.push(Number(n))
      s.sequence.sort((a, b) => a - b)
      s.activeAccountNumber = Number(n)
      save(s)
      out(`Added Account ${n}: ${s.liveIdentity} [personal] (from live login)`)
      return
    }
    case 'add-token': {
      let token = pos[1]
      let stdin = ''
      if (token === '-' || token === undefined) {
        stdin = readStdin()
        token = stdin.split('\n')[0].trim()
      }
      if (!token) fail('ValidationError', 'No token provided', json)
      const isApi = token.startsWith('sk-ant-api')
      const slot = opt('--slot')
      if (slot && s.accounts[slot]) {
        process.stdout.write(`Overwrite slot ${slot}? [y/N] `)
        const ans = (stdin.split('\n')[1] ?? readStdin()).trim().toLowerCase()
        if (ans !== 'y') {
          out('Cancelled')
          save(s)
          return
        }
      }
      const n = slot ?? String(Math.max(0, ...s.sequence) + 1)
      const email = opt('--email') ?? (isApi ? `api-key-${n}@token.local` : `setup-token-${n}@token.local`)
      s.accounts[n] = { email, organizationName: '', organizationUuid: '', ...(isApi ? { usageStatus: 'api_key' } : { usage: { five_hour: 0, seven_day: 0 } }) }
      if (!s.sequence.includes(Number(n))) s.sequence.push(Number(n))
      s.sequence.sort((a, b) => a - b)
      save(s)
      out(`Added Account ${n}: ${email} (from ${isApi ? 'API key' : 'setup-token'})`)
      return
    }
    case 'remove': {
      const n = resolve(s, pos[1])
      if (!n) fail('AccountNotFoundError', `No account found with identifier: ${pos[1]}`, json)
      process.stdout.write(`Are you sure you want to permanently remove Account-${n} (${s.accounts[n].email})? [y/N] `)
      const ans = readStdin().trim().toLowerCase()
      if (ans !== 'y') {
        out('Cancelled')
        save(s)
        return
      }
      delete s.accounts[n]
      s.sequence = s.sequence.filter((x) => x !== Number(n))
      if (s.activeAccountNumber === Number(n)) s.activeAccountNumber = s.sequence[0] ?? null
      save(s)
      out(`Removed Account-${n}`)
      return
    }
    case 'disable':
    case 'enable': {
      const n = resolve(s, pos[1])
      if (!n) fail('AccountNotFoundError', `No account found with identifier: ${pos[1]}`, json)
      s.accounts[n].disabled = verb === 'disable'
      if (!s.accounts[n].disabled) delete s.accounts[n].disabled
      save(s)
      out(`${verb === 'disable' ? 'Disabled' : 'Enabled'} Account-${n}`)
      return
    }
    case 'alias': {
      if (!pos[1]) {
        const rows = s.sequence.filter((n) => s.accounts[n].alias)
        if (!rows.length) out('No aliases set')
        else {
          out('Aliases:')
          for (const n of rows) out(`  ${n}: ${s.accounts[n].alias} (${s.accounts[n].email})`)
        }
        return
      }
      const n = resolve(s, pos[1])
      if (!n) fail('AccountNotFoundError', `No account found with identifier: ${pos[1]}`, json)
      if (argv.includes('--unset')) {
        delete s.accounts[n].alias
        save(s)
        out(`Removed alias for Account ${n}`)
        return
      }
      const name = pos[2]
      if (!name || /^\d+$/.test(name) || !/^[A-Za-z0-9._-]+$/.test(name)) fail('ValidationError', `Invalid alias: ${name}`, json)
      if (Object.values(s.accounts).some((a) => a.alias === name)) fail('ValidationError', `Alias '${name}' is already used`, json)
      s.accounts[n].alias = name
      save(s)
      out(`Set alias '${name}' for Account ${n}`)
      return
    }
    case 'swap':
    case 'move': {
      const a = resolve(s, pos[1])
      if (!a) fail('AccountNotFoundError', `No account found with identifier: ${pos[1]}`, json)
      let b
      if (verb === 'swap') {
        b = resolve(s, pos[2])
        if (!b) fail('AccountNotFoundError', `No account found with identifier: ${pos[2]}`, json)
      } else {
        b = pos[2]
        if (!/^\d+$/.test(b || '') || Number(b) < 1) fail('ValidationError', `Invalid slot: ${pos[2]}`, json)
      }
      if (a === b) {
        out(`Already in slot ${b}: ${s.accounts[a].email}`)
        return
      }
      const A = s.accounts[a]
      const B = s.accounts[b]
      s.accounts[b] = A
      if (B) s.accounts[a] = B
      else delete s.accounts[a]
      s.sequence = Object.keys(s.accounts).map(Number).sort((x, y) => x - y)
      if (s.activeAccountNumber === Number(a)) s.activeAccountNumber = Number(b)
      else if (s.activeAccountNumber === Number(b)) s.activeAccountNumber = Number(a)
      save(s)
      out(B ? `Swapped Account ${a} and Account ${b}:` : `Moved ${A.email} to slot ${b}`)
      return
    }
    case 'map': {
      if (!pos[1]) {
        const keys = Object.keys(s.mappings)
        if (!keys.length) {
          out('No directory mappings yet.')
          out('Map one with: cswap map <NUM|EMAIL> [PATH]')
          return
        }
        out('Directory mappings:')
        for (const p of keys.sort()) {
          const m = s.mappings[p]
          const n = Object.entries(s.accounts).find(([, a]) => a.email === m.email)?.[0]
          out(n ? `  ${p} → ${n}: ${m.email} [personal]` : `  ${p} → ${m.email} (account removed)`)
        }
        return
      }
      const n = resolve(s, pos[1])
      if (!n) fail('AccountNotFoundError', `No account found with identifier: ${pos[1]}`, json)
      const p = pos[2] || process.cwd()
      s.mappings[p] = { email: s.accounts[n].email, organizationUuid: s.accounts[n].organizationUuid }
      save(s)
      out(`Mapped ${p} → Account-${n} (${s.accounts[n].email})`)
      return
    }
    case 'unmap': {
      const p = pos[1] || process.cwd()
      if (s.mappings[p]) {
        delete s.mappings[p]
        save(s)
        out(`Unmapped ${p}`)
      } else out(`No mapping for ${p}`)
      return
    }
    case 'config': {
      const specs = [
        ['autoswitch.threshold', 90.0],
        ['autoswitch.intervalSeconds', 60.0],
        ['autoswitch.cooldownSeconds', 300.0],
        ['autoswitch.hysteresisPct', 10.0],
        ['autoswitch.strategy', 'best'],
        ['autoswitch.includeApiKeyAccounts', false],
        ['autoswitch.unhealthyTicks', 3],
        ['autoswitch.model', ''],
        ['ui.theme', 'auto']
      ]
      const action = pos[1] || 'list'
      const path = join(dirname(STATE), 'settings.json')
      if (action === 'path') return out(path)
      if (action === 'list') {
        const settings = specs.map(([key, def]) => ({ key, value: key in s.settings ? s.settings[key] : def, isSet: key in s.settings }))
        if (json) out(JSON.stringify({ schemaVersion: 1, path, settings }, null, 2))
        else for (const r of settings) out(`${r.key}  ${r.value}${r.isSet ? '' : '  (default)'}`)
        return
      }
      const key = pos[2]
      const spec = specs.find(([k]) => k === key)
      if (!spec) fail('ValidationError', `Unknown setting: ${key}`, json)
      if (action === 'get') {
        const value = key in s.settings ? s.settings[key] : spec[1]
        return out(json ? JSON.stringify({ schemaVersion: 1, key, value, isSet: key in s.settings }, null, 2) : String(value))
      }
      if (action === 'set') {
        let v = pos[3]
        if (typeof spec[1] === 'number') {
          v = Number(v)
          if (Number.isNaN(v)) fail('ValidationError', `${key} must be a number`, json)
          if (key === 'autoswitch.threshold' && (v < 50 || v > 99.9)) fail('ValidationError', `${key} must be between 50 and 99.9`, json)
        } else if (typeof spec[1] === 'boolean') v = /^(1|true|yes|on)$/i.test(v)
        s.settings[key] = v
        save(s)
        return out(`${key} = ${v}`)
      }
      if (action === 'unset') {
        const was = key in s.settings
        delete s.settings[key]
        save(s)
        return was ? out(`${key} unset (default: ${spec[1]})`) : err(`${key} is not set; nothing to do`)
      }
      fail('ValidationError', `Unknown config action ${action}`, json)
    }
    // eslint-disable-next-line no-fallthrough
    case 'export': {
      const path = pos[1]
      if (!path) fail('ValidationError', 'export needs a path', json)
      const only = opt('--account')
      const nums = only ? [resolve(s, only)] : s.sequence.map(String)
      if (nums.includes(null)) fail('AccountNotFoundError', `No account found with identifier: ${only}`, json)
      const envelope = { version: 2, exportedAt: new Date().toISOString(), full: argv.includes('--full'), accounts: nums.map((n) => ({ slot: Number(n), ...s.accounts[n], credentials: 'REDACTED-FAKE' })) }
      writeFileSync(path, JSON.stringify(envelope, null, 2))
      out(`Exported ${nums.length} account(s) to ${path}`)
      return
    }
    case 'import': {
      const path = pos[1]
      if (path === '-') return importFromStdin(s)
      if (!path || !existsSync(path)) fail('ConfigError', `File not found: ${path}`, json)
      const envelope = JSON.parse(readFileSync(path, 'utf8'))
      let imported = 0
      let skipped = 0
      for (const a of envelope.accounts ?? []) {
        const exists = Object.values(s.accounts).some((x) => x.email === a.email)
        if (exists && !argv.includes('--force')) {
          out(`Skipped ${a.email} (already exists, use --force)`)
          skipped++
          continue
        }
        const n = String(a.slot ?? Math.max(0, ...s.sequence) + 1)
        const { slot: _s, credentials: _c, ...rest } = a
        s.accounts[n] = rest
        if (!s.sequence.includes(Number(n))) s.sequence.push(Number(n))
        imported++
      }
      s.sequence.sort((x, y) => x - y)
      save(s)
      out(`Imported ${imported} account(s), skipped ${skipped}`)
      return
    }
    // Session mode. `run N -- -p …` is the keep-warm ping: it answers like `claude -p
    // --output-format json` and leaves the account with a running 5-hour window.
    case 'run': {
      const n = resolve(s, pos[1])
      if (!n) fail('AccountNotFoundError', `No account found with identifier: ${pos[1]}`, json)
      out(`Launching Account-${n} (${s.accounts[n].email}) [session mode]`)
      if (!argv.includes('-p')) return out('(interactive session)')
      if (process.env.FAKE_CSWAP_RUN_FAIL) {
        out(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: process.env.FAKE_CSWAP_RUN_FAIL }))
        process.exit(1)
      }
      s.accounts[n].idle = false
      s.accounts[n].resetsIn5h = 5 * 3600
      s.accounts[n].pings = (s.accounts[n].pings ?? 0) + 1
      save(s)
      out(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.001 }))
      return
    }
    case 'unclaimed': {
      const purge = opt('--purge')
      if (purge) {
        if (!s.unclaimed[purge]) fail('ConfigError', `no unclaimed entry ${purge}`, json)
        delete s.unclaimed[purge]
        save(s)
        return out(`Purged ${purge}`)
      }
      const ids = Object.keys(s.unclaimed)
      if (!ids.length) return out('No unclaimed credential entries')
      for (const id of ids.sort()) out(`${id}  slot ${s.unclaimed[id].slot ?? '?'}  ${s.unclaimed[id].reason ?? 'orphaned (no manifest row)'}`)
      return
    }
    case 'upgrade':
      out('claude-swap is already at the latest version (fake)')
      return
    case 'auto': {
      const once = argv.includes('--once')
      const dry = argv.includes('--dry-run')
      const interval = Number(process.env.FAKE_CSWAP_AUTO_INTERVAL || opt('--interval') || 1) * 1000
      const emit = (o) => out(JSON.stringify({ schemaVersion: 1, ts: new Date().toISOString(), ...o }))
      let ticks = 0
      const tick = () => {
        const st = load()
        const active = st.activeAccountNumber
        const headroom = {}
        const windows = {}
        for (const n of st.sequence) {
          const u = st.accounts[n].usage
          headroom[n] = u ? 100 - Math.max(u.five_hour, u.seven_day) : null
          if (u) windows[n] = { '5h': u.five_hour, '7d': u.seven_day }
        }
        emit({ event: 'poll', active: ref(st, active), headroomPct: headroom, threshold: 90, windowsPct: windows })
        const a = st.accounts[active]
        if (a?.usage && Math.max(a.usage.five_hour, a.usage.seven_day) >= 90) {
          const best = st.sequence.filter((n) => n !== active && !st.accounts[n].disabled && st.accounts[n].usage).sort((x, y) => headroom[y] - headroom[x])[0]
          if (best) {
            emit({ event: 'switch', trigger: 'at-limit', from: ref(st, active), to: ref(st, best), warnings: [], dryRun: dry })
            if (!dry) {
              st.activeAccountNumber = Number(best)
              save(st)
            }
            return 0
          }
          emit({ event: 'all-exhausted', earliestResetAt: iso(1800) })
          return 3
        }
        emit({ event: 'no-switch', reason: 'below-threshold', detail: `active headroom ${headroom[active]}%` })
        return 2
      }
      if (once) process.exit(tick())
      const loop = () => {
        tick()
        ticks++
        emit({ event: 'sleep', seconds: interval / 1000, until: iso(interval / 1000) })
        setTimeout(loop, interval)
      }
      process.on('SIGTERM', () => process.exit(0))
      process.on('SIGINT', () => process.exit(130))
      loop()
      return new Promise(() => {})
    }
    case 'help':
    case '--help':
    case undefined:
      out('usage: cswap <command> [args] [options]  (fake)')
      return
    default:
      err(`Error: unknown command ${verb}`)
      process.exit(2)
  }
}
main()
