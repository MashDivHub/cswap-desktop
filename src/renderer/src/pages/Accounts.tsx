import { useEffect, useMemo, useState } from 'react'
import { AlignLeft, ArrowRightLeft, Flame, Gauge, GaugeCircle, ChevronDown, CircleDashed, Download, Ellipsis, Eye, EyeOff, FolderOpen, Globe, KeyRound, LogIn, MoveVertical, Pencil, Plus, Settings as SettingsIcon, Shuffle, Sparkles, Stethoscope, Tag, TerminalSquare, Trash2, Upload, UserPlus, Zap } from 'lucide-react'
import type { Account, Mapping, PlanInfo, UsageWindow, WarmEntry } from '@shared/types'
import { useStore } from '../lib/store'
import { useElementWidth } from '../lib/use-width'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'
import { Bar, Button, Chip, Dialog, Empty, Field, Input, Menu, Select, Switch, cx } from '../components/ui'
import { UsageRing } from '../components/UsageRing'
import { Tooltip } from '../components/Tooltip'
import { PageHeader } from '../components/PageHeader'
import { OAuthDialog } from '../components/OAuthDialog'
import { ageSeconds, clockOf, maskEmail, orgTag, pct, resetText, statusLabel, statusTone, tone } from '../lib/format'

const T = { num: 28, account: 160, win: 132, ring: 116, status: 148, actions: 104 }

// Cards below this list width, table above. Deliberately NOT derived from the template
// (Purwa's call, 10 Sep): three window columns want ~956px, and deriving it turned a
// usable window into cards — a table that scrolls sideways is the better trade here.
const CARD_BELOW = 780

// Columns are generated, not spelled out: a per-model window is a column of its own, and
// which models exist comes from the accounts.
function gridTemplate(models: number, rings: boolean): string {
  const win = rings ? T.ring : T.win
  return [`${T.num}px`, `minmax(${T.account}px,2fr)`, ...Array<string>(2 + models).fill(`minmax(${win}px,1fr)`), `${T.status}px`, `${T.actions}px`].join(' ')
}

type DialogKind = { kind: 'add' } | { kind: 'oauth'; a?: Account } | { kind: 'token' } | { kind: 'diag' } | { kind: 'run'; a: Account } | { kind: 'alias'; a: Account } | { kind: 'move'; a: Account } | { kind: 'remove'; a: Account } | { kind: 'export'; a?: Account } | { kind: 'import' } | null

export function AccountsPage(): React.JSX.Element {
  const { accounts, now, settings, updateSettings, warm, setPage } = useStore()
  const { notify } = useToast()
  const [dlg, setDlg] = useState<DialogKind>(null)
  const mask = settings.maskEmails
  const rings = settings.usageView === 'rings'
  const pace = settings.showPace
  const [busy, setBusy] = useState<string | null>(null)
  const list = accounts.payload?.accounts ?? []
  // Every per-model window in the list, first-seen order. The columns belong to the table
  // and not to a row: an account without Fable needs an empty cell, or its status and
  // actions slide one column left of everyone else's.
  const models = useMemo(() => {
    const seen: string[] = []
    for (const a of list) for (const s of (a.usage ?? a.lastGoodUsage)?.scoped ?? []) if (!seen.includes(s.name)) seen.push(s.name)
    return seen
  }, [list])
  const active = list.find((a) => a.active)
  const plans = accounts.plans ?? {}
  // A table needs a table's worth of room. Below that the same account reads better as a
  // card, which is also the only way to stop the page scrolling sideways.
  const template = gridTemplate(models.length, rings)
  const [listRef, listWidth] = useElementWidth()
  const compact = listWidth > 0 && listWidth < CARD_BELOW

  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: { message: string }; value?: unknown }>, okMsg?: (v: unknown) => string): Promise<boolean> => {
    setBusy(key)
    try {
      const r = await fn()
      if (r.ok) {
        if (okMsg) notify('ok', okMsg(r.value))
        return true
      }
      notify('error', 'cswap refused', r.error?.message)
      return false
    } finally {
      setBusy(null)
    }
  }

  const switchTo = (a: Account): Promise<boolean> =>
    act(`switch-${a.number}`, () => api.switchTo(String(a.number)), (v) => {
      const p = v as { message: string; warnings: string[] }
      if (p.warnings?.length) notify('info', 'Switch warnings', p.warnings.join('\n'))
      return p.message
    })
  const rotate = (strategy?: 'best' | 'next-available'): Promise<boolean> => act(`rotate`, () => api.rotate(strategy), (v) => (v as { message: string }).message)

  // Warm-ups: one named account (whatever its window says), or every idle one.
  const warmUp = async (a?: Account): Promise<void> => {
    setBusy(a ? `warm-${a.number}` : 'warm')
    const r = await api.warmNow(a ? String(a.number) : undefined)
    setBusy(null)
    if (!r.ok) return notify('error', 'Could not warm up', r.error.message)
    const { attempted, ok, failed } = r.value
    if (!attempted) notify('info', 'Nothing to warm up', 'Every account is either in use, already running a window, out of weekly quota, or needs a login.')
    else if (failed) notify('error', `Warmed ${ok} of ${attempted}`, 'See the status under each account, or the Log page, for the reason.')
    else notify('ok', attempted === 1 ? 'Window started' : `Started ${ok} windows`)
  }
  const toggleExcluded = (a: Account): void => {
    const has = settings.keepWarmExclude.some((e) => e.toLowerCase() === a.email.toLowerCase())
    void updateSettings({ keepWarmExclude: has ? settings.keepWarmExclude.filter((e) => e.toLowerCase() !== a.email.toLowerCase()) : [...settings.keepWarmExclude, a.email] })
    notify('ok', has ? `${a.alias || a.email} is back in keep-warm` : `${a.alias || a.email} is left out of keep-warm`)
  }

  return (
    <div className="anim-fade pb-8" data-testid="page-accounts">
      <PageHeader
        title="Accounts"
        subtitle={
          active ? (
            <>
              Active: <span className="font-medium text-fg">{active.alias || maskEmail(active.email, mask)}</span>
              {active.isOrganization && <span className="text-fg-3"> · {orgTag(active, mask)}</span>}
            </>
          ) : list.length ? (
            'No active managed account'
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="ghost"
              className="!px-2"
              aria-label={rings ? 'Show usage as bars' : 'Show usage as rings'}
              aria-pressed={rings}
              title={rings ? 'Show usage as bars' : 'Show usage as rings'}
              data-testid="view-toggle"
              icon={rings ? <AlignLeft size={15} /> : <CircleDashed size={15} />}
              onClick={() => void updateSettings({ usageView: rings ? 'bars' : 'rings' })}
            />
            <Button
              variant="ghost"
              className="!px-2"
              aria-label={pace ? 'Hide the pace marker' : 'Show the pace marker'}
              aria-pressed={pace}
              title={pace ? 'Hide the pace marker' : 'Show where an evenly-spread week would be'}
              data-testid="pace-toggle"
              icon={pace ? <Gauge size={15} /> : <GaugeCircle size={15} />}
              onClick={() => void updateSettings({ showPace: !pace })}
            />
            <Button
              variant="ghost"
              className="!px-2"
              aria-label={mask ? 'Show email addresses' : 'Hide email addresses'}
              aria-pressed={mask}
              title={mask ? 'Show email addresses' : 'Hide email addresses (keeps the first three characters)'}
              data-testid="mask-toggle"
              icon={mask ? <EyeOff size={15} /> : <Eye size={15} />}
              onClick={() => void updateSettings({ maskEmails: !mask })}
            />
            <Menu
              width={270}
              trigger={() => (
                <Button
                  variant="ghost"
                  className={cx('!px-2', settings.keepWarm && '!text-accent')}
                  aria-label="Keep warm"
                  title={warm.running ? `Warming ${warm.running}…` : settings.keepWarm ? 'Keep warm is on' : 'Keep idle accounts warm'}
                  data-testid="warm-menu"
                  icon={<Flame size={15} className={cx((warm.running || busy === 'warm') && 'animate-pulse')} />}
                />
              )}
              items={[
                { label: 'Keep idle accounts warm', hint: settings.keepWarm ? 'on' : 'off', checked: settings.keepWarm, icon: <Flame size={14} />, onSelect: () => void updateSettings({ keepWarm: !settings.keepWarm }) },
                { label: 'Warm idle accounts now', icon: <Zap size={14} />, disabled: !!warm.running || busy === 'warm', onSelect: () => void warmUp() },
                { separator: true, label: '' },
                { label: 'Keep-warm settings', icon: <SettingsIcon size={14} />, onSelect: () => setPage('settings') }
              ]}
            />
            <Menu
              width={260}
              trigger={(open) => (
                <Button variant="default" icon={<Shuffle size={14} />} loading={busy === 'rotate'} data-testid="rotate-menu" aria-expanded={open}>
                  Rotate <ChevronDown size={13} className="text-fg-3" />
                </Button>
              )}
              items={[
                { label: 'Next account', hint: 'rotation', icon: <ArrowRightLeft size={14} />, onSelect: () => void rotate() },
                { label: 'Best (most quota left)', hint: 'best', icon: <Sparkles size={14} />, onSelect: () => void rotate('best') },
                { label: 'Next available (skip limited)', icon: <Shuffle size={14} />, onSelect: () => void rotate('next-available') }
              ]}
            />
            <Menu
              width={260}
              trigger={() => (
                <Button variant="primary" icon={<Plus size={14} />} data-testid="add-menu">
                  Add account <ChevronDown size={13} className="opacity-70" />
                </Button>
              )}
              items={[
                { label: 'Sign in with the browser', hint: 'no CLI login', icon: <Globe size={14} />, onSelect: () => setDlg({ kind: 'oauth' }) },
                { label: 'From current Claude login', icon: <UserPlus size={14} />, onSelect: () => setDlg({ kind: 'add' }) },
                { label: 'From setup-token or API key', icon: <KeyRound size={14} />, onSelect: () => setDlg({ kind: 'token' }) }
              ]}
            />
            <Menu
              width={260}
              trigger={() => <Button variant="ghost" className="!px-2" aria-label="More" data-testid="more-menu" icon={<Ellipsis size={16} />} />}
              items={[
                { label: 'Export all accounts', icon: <Download size={14} />, onSelect: () => setDlg({ kind: 'export' }) },
                { label: 'Import accounts', icon: <Upload size={14} />, onSelect: () => setDlg({ kind: 'import' }) },
                { separator: true, label: '' },
                { label: 'Token diagnostics', hint: '--token-status', icon: <Stethoscope size={14} />, onSelect: () => setDlg({ kind: 'diag' }) }
              ]}
            />
          </>
        }
      />

      <div className="px-6">
        {accounts.error && !accounts.payload && (
          <div className="mb-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger" data-testid="accounts-error">
            {accounts.error.message}
          </div>
        )}
        {accounts.error && accounts.payload && (
          <div className="mb-3 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px] text-warn" data-testid="accounts-stale">
            Showing the last successful list — refresh failed: {accounts.error.message}
          </div>
        )}
        {!accounts.payload && !accounts.error && (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[62px] animate-pulse rounded-lg border border-border bg-surface" />
            ))}
          </div>
        )}
        {accounts.payload && list.length === 0 && (
          <Empty
            icon={<UserPlus size={28} />}
            title="No managed accounts yet"
            body={
              <>
                Log into Claude Code with the account you want to keep, then add it here. cswap backs up its login so you can switch back to it any time.
              </>
            }
            action={
              <div className="flex items-center justify-center gap-2">
                <Button variant="primary" icon={<Globe size={14} />} onClick={() => setDlg({ kind: 'oauth' })}>
                  Sign in with the browser
                </Button>
                <Button icon={<Plus size={14} />} onClick={() => setDlg({ kind: 'add' })}>
                  Add current login
                </Button>
              </div>
            }
          />
        )}
        {list.length > 0 && (
          <div ref={listRef} className={cx('rounded-lg border border-border bg-surface shadow-card', !compact && 'overflow-x-auto')} data-testid="accounts-scroller">
            <div className={cx(!compact && 'min-w-min')} data-testid="accounts-table" data-compact={compact || undefined}>
            <div className={cx('grid items-center gap-4 border-b border-border bg-bg/50 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-3', compact && 'hidden')} style={{ gridTemplateColumns: template }}>
              <span className="pl-[13px]">#</span>
              <span>Account</span>
              <span>5-hour window</span>
              <span>7-day window</span>
              {models.map((m) => (
                <span key={m} className="truncate" title={`${m} window`}>
                  {m}
                </span>
              ))}
              <span>Status</span>
              <span />
            </div>
            {list.map((a) => (
              <AccountRow key={a.number} a={a} now={now} template={template} models={models} compact={compact} mask={mask} rings={rings} pace={pace} plan={plans[a.email]} busy={busy} warmEntry={warm.entries[a.email]} warming={warm.running === a.email} excluded={settings.keepWarmExclude.some((e) => e.toLowerCase() === a.email.toLowerCase())} onWarm={() => void warmUp(a)} onToggleExcluded={() => toggleExcluded(a)} onSwitch={() => void switchTo(a)} onAction={(k) => setDlg(k)} onToggleDisabled={() => void act(`dis-${a.number}`, () => api.setDisabled(String(a.number), !a.disabled), () => (a.disabled ? `Account-${a.number} back in rotation` : `Account-${a.number} held out of rotation`))} />
              ))}
            </div>
          </div>
        )}
        {accounts.fetchedAt && list.length > 0 && (
          <div className="mt-2 flex items-center justify-between text-[11.5px] text-fg-3">
            <span>
              {list.length} account{list.length === 1 ? '' : 's'} · usage refreshed {ageSeconds((now - new Date(accounts.fetchedAt).getTime()) / 1000)}
            </span>
            <span>Every write goes through the cswap CLI — nothing here edits the vault directly.</span>
          </div>
        )}
      </div>

      {dlg?.kind === 'oauth' && <OAuthDialog account={dlg.a} onClose={() => setDlg(null)} />}
      <AddAccountDialog open={dlg?.kind === 'add'} onClose={() => setDlg(null)} taken={list.map((a) => a.number)} />
      <AddTokenDialog open={dlg?.kind === 'token'} onClose={() => setDlg(null)} taken={list.map((a) => a.number)} />
      {dlg?.kind === 'alias' && <AliasDialog a={dlg.a} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'move' && <MoveDialog a={dlg.a} list={list} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'remove' && <RemoveDialog a={dlg.a} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'export' && <ExportDialog a={dlg.a} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'import' && <ImportDialog onClose={() => setDlg(null)} />}
      {dlg?.kind === 'diag' && <DiagDialog onClose={() => setDlg(null)} />}
      {dlg?.kind === 'run' && <RunDialog a={dlg.a} onClose={() => setDlg(null)} />}
    </div>
  )
}

function windowTooltip(w: UsageWindow, name: string, now: number): string {
  const lines = [`${name} · ${pct(w.pct)} used`]
  if (w.resetsAt) lines.push(`resets ${clockOf(w.resetsAt)} · ${resetText(w.resetsAt, now)}`)
  if (w.expectedPct !== undefined) lines.push(`${w.aheadOfPace ? 'ahead of pace' : 'on pace'} — spread evenly you'd be at ~${pct(w.expectedPct)} by now`)
  if (w.willLastToReset === false) lines.push('at this rate it runs out before the reset')
  return lines.join('\n')
}

function WindowCell({ w, now, label, name, showName = true, showChip = true, ring = false, pace = true }: { w: UsageWindow | undefined; now: number; label: string; name?: string; showName?: boolean; showChip?: boolean; ring?: boolean; pace?: boolean }): React.JSX.Element {
  // Carries the same testid as a filled cell: an account with no such window still owns
  // the column, and a test has to be able to point at the cell that stays empty. Stretched
  // and centred because the row is `items-start` and a bar is twice a dash's height.
  if (!w)
    return (
      <span className="flex h-full min-h-[19px] items-center self-stretch text-[12px] text-fg-3" data-testid={`window-${label}`}>
        -
      </span>
    )
  const t = tone(w.pct)
  // The tooltip always names its window; the label inside the cell is redundant wherever
  // a column header says the same word, so `showName` and `name` are separate answers.
  const full = name ?? (label === '5h' ? '5-hour window' : label === '7d' ? '7-day window' : label)
  const tip = windowTooltip(w, full, now)
  if (ring) {
    return (
      <div className="min-w-0" data-testid={`window-${label}`}>
        <UsageRing pct={w.pct} label={showName ? name : undefined} tooltip={tip} sub={w.resetsAt ? resetText(w.resetsAt, now) : undefined} pace={pace ? w.expectedPct : undefined} />
      </div>
    )
  }
  return (
    <Tooltip label={tip} focusable={false} className="w-full min-w-0 flex-col">
      <div className="w-full min-w-0" data-testid={`window-${label}`}>
        <div className="mb-1 flex items-baseline justify-between gap-2 text-[12px]">
          <span className="truncate">
            {name && showName && <span className="text-fg-3">{name} </span>}
            <span className={cx('font-medium tabular-nums', t === 'danger' ? 'text-danger' : t === 'warn' ? 'text-warn' : 'text-fg')}>{pct(w.pct)}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1 text-fg-3">
            {showChip && w.aheadOfPace && <Chip tone="warn">ahead</Chip>}
            {w.resetsAt && <span className="truncate tabular-nums">{resetText(w.resetsAt, now)}</span>}
          </span>
        </div>
        <Bar pct={w.pct} tone={t} pace={pace ? w.expectedPct : undefined} />
      </div>
    </Tooltip>
  )
}

const NEEDS_LOGIN = ['relogin_required', 'token_expired', 'no_credentials']

function AccountRow({ a, now, template, models, compact, mask, rings, pace, plan, busy, warmEntry, warming, excluded, onWarm, onToggleExcluded, onSwitch, onAction, onToggleDisabled }: { a: Account; now: number; template: string; models: string[]; compact: boolean; mask: boolean; rings: boolean; pace: boolean; plan?: PlanInfo; busy: string | null; warmEntry?: WarmEntry; warming: boolean; excluded: boolean; onWarm: () => void; onToggleExcluded: () => void; onSwitch: () => void; onAction: (k: DialogKind) => void; onToggleDisabled: () => void }): React.JSX.Element {
  const usage = a.usage ?? a.lastGoodUsage ?? null
  const stale = !a.usage && !!a.lastGoodUsage
  const sTone = statusTone(a.usageStatus)

  const name = (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="truncate text-[13px] font-medium text-fg" title={mask ? undefined : a.email} data-testid={a.alias ? `alias-${a.number}` : undefined}>
          {a.alias || maskEmail(a.email, mask)}
        </span>
        {plan && (
          <Chip tone="muted" title={a.active ? `Subscription: ${plan.label}${plan.tier ? ` (${plan.tier})` : ''}` : `Subscription when this account was last active, ${clockOf(plan.seenAt)}`}>
            {plan.label}
          </Chip>
        )}
        {a.active && <Chip tone="accent">active</Chip>}
        {a.disabled && (
          <Chip tone="muted" title="Held out of rotation">
            disabled
          </Chip>
        )}
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-fg-3">
        {a.alias && (
          <span className="truncate" title={mask ? undefined : a.email}>
            {maskEmail(a.email, mask)}
          </span>
        )}
        {a.alias && <span>·</span>}
        <span className="truncate">{orgTag(a, mask)}</span>
      </div>
    </div>
  )

  const five = <WindowCell w={usage?.fiveHour} now={now} label="5h" ring={rings} pace={pace} name={compact ? '5-hour' : undefined} />
  const weekly = <WindowCell w={usage?.sevenDay} now={now} label="7d" ring={rings} pace={pace} name={compact ? '7-day' : undefined} />
  // One cell per model the TABLE knows about, not per model this account has: a missing
  // one has to render as an empty cell so the columns after it stay put. A card has no
  // columns to hold and no header naming them, so there it is simply absent instead.
  const perModel = (compact ? models.filter((m) => usage?.scoped?.some((s) => s.name === m)) : models).map((m) => {
    const w = usage?.scoped?.find((s) => s.name === m)
    return <WindowCell key={m} w={w} now={now} label={`model-${m}`} name={m} showName={compact} showChip={false} ring={rings} pace={pace} />
  })

  const status = (
    <>
      <Chip tone={sTone} title={a.usageStatus} className="max-w-full">
        <span className="truncate">{statusLabel(a.usageStatus)}</span>
      </Chip>
      {stale && (
        <span className="text-[11px] text-fg-3" title="Last successful usage measurement">
          last good {ageSeconds(a.lastGoodAgeSeconds)}
        </span>
      )}
      {!stale && a.usageAgeSeconds !== undefined && a.usageAgeSeconds >= 60 && <span className="text-[11px] text-fg-3">{ageSeconds(a.usageAgeSeconds)}</span>}
      {NEEDS_LOGIN.includes(a.usageStatus) && (
        <Button size="sm" icon={<LogIn size={13} />} onClick={() => onAction({ kind: 'oauth', a })} data-testid={`fix-login-${a.number}`} title="Sign in again in the browser — the login your terminals use is not touched">
          Fix login
        </Button>
      )}
      {warming ? (
        <span className="flex items-center gap-1 text-[11px] text-accent" data-testid={`warm-status-${a.number}`}>
          <Flame size={11} className="animate-pulse" /> warming…
        </span>
      ) : warmEntry && now - Date.parse(warmEntry.at) < 6 * 3600_000 ? (
        warmEntry.ok ? (
          <span className="flex items-center gap-1 text-[11px] text-fg-3" title={`A one-word message was sent at ${clockOf(warmEntry.at)} to start the 5-hour window`} data-testid={`warm-status-${a.number}`}>
            <Flame size={11} /> warmed {ageSeconds((now - Date.parse(warmEntry.at)) / 1000)}
          </span>
        ) : (
          <span className="text-[11px] text-danger" title={warmEntry.message} data-testid={`warm-status-${a.number}`}>
            warm-up failed
          </span>
        )
      ) : null}
    </>
  )

  const actions = (
    <>
      <Button size="sm" variant={a.active ? 'ghost' : 'default'} disabled={a.active} loading={busy === `switch-${a.number}`} onClick={onSwitch} data-testid={`switch-${a.number}`} className={a.active ? 'invisible' : ''}>
        Switch
      </Button>
      <Menu
        width={280}
        trigger={() => <Button size="sm" variant="ghost" className="!px-1.5" aria-label={`Actions for account ${a.number}`} data-testid={`row-menu-${a.number}`} icon={<Ellipsis size={15} />} />}
        items={[
          { label: a.alias ? 'Change alias' : 'Set alias', icon: <Tag size={14} />, onSelect: () => onAction({ kind: 'alias', a }) },
          { label: 'Move to slot', icon: <MoveVertical size={14} />, onSelect: () => onAction({ kind: 'move', a }) },
          { label: a.disabled ? 'Enable (back in rotation)' : 'Disable (hold out of rotation)', icon: a.disabled ? <Eye size={14} /> : <EyeOff size={14} />, onSelect: onToggleDisabled },
          { separator: true, label: '' },
          { label: 'Open terminal as this account', hint: `cswap run ${a.number}`, icon: <TerminalSquare size={14} />, onSelect: () => onAction({ kind: 'run', a }) },
          { label: 'Sign in again with the browser', icon: <LogIn size={14} />, disabled: a.usageStatus === 'api_key', onSelect: () => onAction({ kind: 'oauth', a }) },
          { label: 'Warm up now', hint: 'start the 5-hour window', icon: <Flame size={14} />, disabled: a.active || a.usageStatus === 'api_key' || busy === `warm-${a.number}`, onSelect: onWarm },
          { label: excluded ? 'Include in keep-warm' : 'Leave out of keep-warm', icon: <Flame size={14} />, onSelect: onToggleExcluded },
          { label: 'Export this account', icon: <Download size={14} />, onSelect: () => onAction({ kind: 'export', a }) },
          { label: 'Re-add from the current login', hint: `slot ${a.number}`, icon: <Pencil size={14} />, onSelect: () => onAction({ kind: 'add' }) },
          { separator: true, label: '' },
          { label: 'Remove account', icon: <Trash2 size={14} />, danger: true, onSelect: () => onAction({ kind: 'remove', a }) }
        ]}
      />
    </>
  )

  if (compact) {
    return (
      <div
        className={cx('flex flex-col gap-3 border-b border-border p-3 last:border-b-0', a.active && 'bg-accent-soft/40', a.disabled && 'opacity-70')}
        data-testid={`account-row-${a.number}`}
        data-active={a.active || undefined}
      >
        <div className="flex items-start gap-2.5">
          <span className="mono mt-[2px] flex h-[18px] shrink-0 items-center gap-1.5 text-fg-3">
            <span className={cx('h-[6px] w-[6px] rounded-full', a.active ? 'bg-accent' : 'bg-transparent')} aria-label={a.active ? 'active' : undefined} />
            {a.number}
          </span>
          {name}
          <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
        </div>
        <div className={cx('flex flex-col gap-2.5', rings && 'flex-row flex-wrap items-center gap-x-4 gap-y-2')}>
          {five}
          {weekly}
          {perModel}
        </div>
        <div className="flex flex-wrap items-center gap-2">{status}</div>
      </div>
    )
  }

  return (
    <div
      className={cx('group grid items-start gap-4 border-b border-border px-3 py-2.5 last:border-b-0 transition-colors duration-150 hover:bg-surface-2/50', a.active && 'bg-accent-soft/40 hover:bg-accent-soft/50', a.disabled && 'opacity-70')}
      style={{ gridTemplateColumns: template }}
      data-testid={`account-row-${a.number}`}
      data-active={a.active || undefined}
    >
      <div className="flex h-full min-w-0 min-h-[19px] items-center gap-1.5 self-stretch">
        <span className={cx('h-[6px] w-[6px] rounded-full', a.active ? 'bg-accent' : 'bg-transparent')} aria-label={a.active ? 'active' : undefined} />
        <span className="mono text-fg-3">{a.number}</span>
      </div>
      {name}
      {five}
      {weekly}
      {perModel}
      <div className="flex min-w-0 min-h-[19px] flex-col items-start justify-center gap-1 self-stretch">{status}</div>
      <div className="flex min-w-0 min-h-[19px] items-center justify-end gap-1 self-stretch">{actions}</div>
    </div>
  )
}

// ---- dialogs -------------------------------------------------------------------------

function useRun(): { run: <T>(p: Promise<{ ok: boolean; error?: { message: string }; value?: T }>, okTitle: (v: T) => string) => Promise<boolean>; busy: boolean } {
  const { notify } = useToast()
  const [busy, setBusy] = useState(false)
  return {
    busy,
    run: async (p, okTitle) => {
      setBusy(true)
      try {
        const r = await p
        if (r.ok) {
          notify('ok', okTitle(r.value as never))
          return true
        }
        notify('error', 'cswap refused', r.error?.message)
        return false
      } finally {
        setBusy(false)
      }
    }
  }
}

function outText(v: { stdout: string; stderr: string } | undefined): string {
  return (v?.stdout || v?.stderr || 'Done').trim().split('\n').slice(-1)[0]
}

function AddAccountDialog({ open, onClose, taken }: { open: boolean; onClose: () => void; taken: number[] }): React.JSX.Element {
  const [slot, setSlot] = useState('')
  const [alias, setAlias] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const { run, busy } = useRun()
  const slotNum = slot ? Number(slot) : undefined
  const slotTaken = slotNum !== undefined && taken.includes(slotNum)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add the current Claude login"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={slotTaken && !overwrite}
            data-testid="add-submit"
            onClick={async () => {
              if (await run(api.addAccount({ slot: slotNum, alias: alias || undefined, overwrite }), outText)) onClose()
            }}
          >
            Add account
          </Button>
        </>
      }
    >
      <ol className="mb-4 space-y-2.5 text-[12.5px] text-fg-2">
        <li className="flex gap-2.5">
          <span className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-medium text-fg-2">1</span>
          <span>
            Open a terminal anywhere and start Claude Code: <span className="mono selectable rounded bg-surface-2 px-1 py-[1px] text-fg">claude</span>
          </span>
        </li>
        <li className="flex gap-2.5">
          <span className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-medium text-fg-2">2</span>
          <span>
            Run <span className="mono selectable rounded bg-surface-2 px-1 py-[1px] text-fg">/login</span> and finish the sign-in in the browser. Do <strong className="font-medium text-fg">not</strong> run <span className="mono">/logout</span> on the account you are leaving — Claude Code may revoke the token cswap stored for it.
          </span>
        </li>
        <li className="flex gap-2.5">
          <span className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-medium text-fg-2">3</span>
          <span>Come back here and add it. cswap stores that login so you can switch back to it later.</span>
        </li>
      </ol>
      <p className="mb-4 text-[12.5px] text-fg-3">
        Adding an account that is already managed refreshes its stored credentials instead of creating a duplicate.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Slot" hint="Optional. Empty = next free.">
          <Input inputMode="numeric" placeholder="auto" value={slot} onChange={(e) => setSlot(e.target.value.replace(/\D/g, ''))} data-testid="add-slot" />
        </Field>
        <Field label="Alias" hint="Optional short name.">
          <Input placeholder="e.g. work" value={alias} onChange={(e) => setAlias(e.target.value)} data-testid="add-alias" />
        </Field>
      </div>
      {slotTaken && (
        <label className="mt-3 flex items-center justify-between gap-3 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          <span>Slot {slotNum} is taken. Overwrite it with the current login?</span>
          <Switch checked={overwrite} onChange={setOverwrite} label="Overwrite slot" />
        </label>
      )}
    </Dialog>
  )
}

function AddTokenDialog({ open, onClose, taken }: { open: boolean; onClose: () => void; taken: number[] }): React.JSX.Element {
  const [token, setToken] = useState('')
  const [email, setEmail] = useState('')
  const [slot, setSlot] = useState('')
  const [show, setShow] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const { run, busy } = useRun()
  const slotNum = slot ? Number(slot) : undefined
  const slotTaken = slotNum !== undefined && taken.includes(slotNum)
  const kind = token.startsWith('sk-ant-api') ? 'API key' : token.startsWith('sk-ant-oat') ? 'setup-token' : null
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add from a token"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!token.trim() || (slotTaken && !overwrite)}
            data-testid="token-submit"
            onClick={async () => {
              if (await run(api.addToken({ token, email: email || undefined, slot: slotNum, overwrite }), outText)) {
                setToken('')
                onClose()
              }
            }}
          >
            Register token
          </Button>
        </>
      }
    >
      <p className="mb-4 text-[12.5px] text-fg-2">
        A long-lived setup-token (<span className="mono">claude setup-token</span>) or a managed API key. The token is handed to cswap over stdin, never as a command-line argument, and is not kept by this app.
      </p>
      <Field label="Token" hint={kind ? `Detected: ${kind}` : 'sk-ant-oat01-… or sk-ant-api03-…'}>
        <div className="relative">
          <Input type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} className="pr-9 font-mono text-[12px]" data-testid="token-input" />
          <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide token' : 'Show token'} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg">
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </Field>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Label (email)" hint="Optional.">
          <Input placeholder="setup-token-N@token.local" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Slot" hint="Optional.">
          <Input inputMode="numeric" placeholder="auto" value={slot} onChange={(e) => setSlot(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
      {slotTaken && (
        <label className="mt-3 flex items-center justify-between gap-3 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          <span>Slot {slotNum} is taken. Overwrite it?</span>
          <Switch checked={overwrite} onChange={setOverwrite} label="Overwrite slot" />
        </label>
      )}
    </Dialog>
  )
}

function AliasDialog({ a, onClose }: { a: Account; onClose: () => void }): React.JSX.Element {
  const [alias, setAlias] = useState(a.alias ?? '')
  const { run, busy } = useRun()
  const valid = alias === '' || (/^[A-Za-z0-9._-]+$/.test(alias) && !/^\d+$/.test(alias))
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Alias for Account-${a.number}`}
      footer={
        <>
          {a.alias && (
            <Button variant="ghost" loading={busy} onClick={async () => (await run(api.setAlias(String(a.number), null), () => `Alias removed from Account-${a.number}`)) && onClose()} className="mr-auto text-danger">
              Remove alias
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!alias || !valid || alias === a.alias} data-testid="alias-submit" onClick={async () => (await run(api.setAlias(String(a.number), alias), () => `Account-${a.number} is now “${alias}”`)) && onClose()}>
            Save
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] text-fg-2">
        {a.email}. An alias works anywhere a slot number or email does: <span className="mono">cswap switch {alias || 'dev'}</span>.
      </p>
      <Field label="Alias" hint="Letters, digits, . - _ — not purely numeric.">
        <Input autoFocus value={alias} onChange={(e) => setAlias(e.target.value.trim())} data-testid="alias-input" onKeyDown={(e) => e.key === 'Enter' && alias && valid && void run(api.setAlias(String(a.number), alias), () => `Account-${a.number} is now “${alias}”`).then((ok) => ok && onClose())} />
      </Field>
      {!valid && <div className="mt-2 text-[12px] text-danger">Invalid alias.</div>}
    </Dialog>
  )
}

function MoveDialog({ a, list, onClose }: { a: Account; list: Account[]; onClose: () => void }): React.JSX.Element {
  const [slot, setSlot] = useState('')
  const { run, busy } = useRun()
  const n = Number(slot)
  const occupant = list.find((x) => x.number === n && x.number !== a.number)
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move Account-${a.number} to a slot`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!slot || n < 1 || n === a.number} data-testid="move-submit" onClick={async () => (await run(api.moveAccount(String(a.number), n), () => (occupant ? `Swapped slots ${a.number} and ${n}` : `Moved to slot ${n}`))) && onClose()}>
            {occupant ? 'Swap' : 'Move'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] text-fg-2">Slot numbers are the shortcuts you type (<span className="mono">cswap switch 1</span>) and the list order. Aliases, backups and session history move with the account.</p>
      <Field label="Destination slot">
        <Input autoFocus inputMode="numeric" value={slot} onChange={(e) => setSlot(e.target.value.replace(/\D/g, ''))} data-testid="move-input" />
      </Field>
      {occupant && (
        <div className="mt-2 text-[12px] text-fg-2">
          Slot {n} holds <span className="font-medium text-fg">{occupant.alias || occupant.email}</span> — the two will trade places.
        </div>
      )}
    </Dialog>
  )
}

function RemoveDialog({ a, onClose }: { a: Account; onClose: () => void }): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const { run, busy } = useRun()
  const ok = typed.trim() === String(a.number) || typed.trim().toLowerCase() === a.email.toLowerCase()
  return (
    <Dialog
      open
      onClose={onClose}
      title="Remove account"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={!ok} data-testid="remove-submit" onClick={async () => (await run(api.removeAccount(String(a.number)), () => `Removed Account-${a.number}`)) && onClose()}>
            Remove permanently
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] text-fg-2">
        This deletes the stored login for <span className="font-medium text-fg">{a.email}</span> (slot {a.number}) from cswap. Claude Code itself is not logged out{a.active ? ', but this is the active account — the live login stays until you switch or /logout' : ''}. Recovery means logging in with that account again and re-adding it.
      </p>
      <Field label={`Type ${a.number} or the email to confirm`}>
        <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="remove-confirm" />
      </Field>
    </Dialog>
  )
}

function ExportDialog({ a, onClose }: { a?: Account; onClose: () => void }): React.JSX.Element {
  const [full, setFull] = useState(false)
  const { notify } = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open
      onClose={onClose}
      title={a ? `Export Account-${a.number}` : 'Export all accounts'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            data-testid="export-submit"
            onClick={async () => {
              setBusy(true)
              const r = await api.exportAccounts({ account: a ? String(a.number) : undefined, full })
              setBusy(false)
              if (!r.ok) return notify('error', 'Export failed', r.error.message)
              if (r.value) {
                notify('ok', 'Exported', r.value.path)
                onClose()
              }
            }}
          >
            Choose file & export
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] text-fg-2">
        The export is <span className="font-medium text-fg">plaintext JSON containing login credentials</span>. Keep it somewhere private, or encrypt it. By default only each account's own login is included — machine-shared MCP/plugin OAuth tokens stay on this machine.
      </p>
      <label className="mt-4 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
        <span>
          <span className="block text-[13px] font-medium text-fg">Full export (same-PC backup)</span>
          <span className="block text-[12px] text-fg-3">Include the whole ~/.claude.json and credential object.</span>
        </span>
        <Switch checked={full} onChange={setFull} label="Full export" />
      </label>
    </Dialog>
  )
}

function ImportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [force, setForce] = useState(false)
  const { notify } = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open
      onClose={onClose}
      title="Import accounts"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            data-testid="import-submit"
            onClick={async () => {
              setBusy(true)
              const r = await api.importAccounts({ force })
              setBusy(false)
              if (!r.ok) return notify('error', 'Import failed', r.error.message)
              if (r.value) {
                notify('ok', 'Import finished', r.value.output.stdout.trim() || r.value.path)
                onClose()
              }
            }}
          >
            Choose file & import
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] text-fg-2">
        Accounts that already exist are skipped, except slots whose refresh token has died — those are replaced automatically. If the imported account is the one you are logged in as, activate it afterwards with <span className="mono">Switch</span> (use <span className="mono">--force</span> from the CLI to bypass the backup of the current login).
      </p>
      <label className="mt-4 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
        <span>
          <span className="block text-[13px] font-medium text-fg">Overwrite existing accounts</span>
          <span className="block text-[12px] text-fg-3">Passes --force. A stale export can carry an already-superseded token.</span>
        </span>
        <Switch checked={force} onChange={setForce} label="Overwrite existing" />
      </label>
    </Dialog>
  )
}

function DiagDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    void api.tokenStatus().then((r) => (r.ok ? setText(r.value.stdout.replace(/\x1b\[[0-9;]*m/g, '')) : setErr(r.error.message)))
  }, [])
  return (
    <Dialog open onClose={onClose} title="Token diagnostics" width={640} footer={<Button onClick={onClose}>Close</Button>}>
      <p className="mb-3 text-[12.5px] text-fg-2">
        Output of <span className="mono">cswap list --token-status</span>: where each account's OAuth token comes from and whether it is still valid.
      </p>
      {err && <div className="text-[12px] text-danger">{err}</div>}
      {!text && !err && <div className="text-[12px] text-fg-3">Running…</div>}
      {text && <pre className="selectable mono max-h-[46vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg px-3 py-2 text-fg-2" data-testid="diag-output">{text.trim()}</pre>}
    </Dialog>
  )
}

function RunDialog({ a, onClose }: { a: Account; onClose: () => void }): React.JSX.Element {
  const { notify } = useToast()
  const [dir, setDir] = useState('')
  const [mappings, setMappings] = useState<Mapping[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void api.listMappings().then((r) => {
      if (!r.ok) return
      setMappings(r.value)
      // A directory already mapped to this account is the one you almost always mean.
      const mine = r.value.find((m) => m.account?.number === a.number)
      if (mine) setDir(mine.path)
    })
  }, [a.number])
  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      title={`Open a terminal as Account-${a.number}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            icon={<TerminalSquare size={14} />}
            data-testid="run-submit"
            onClick={async () => {
              setBusy(true)
              const r = await api.launchSession(String(a.number), dir.trim() || undefined)
              setBusy(false)
              if (!r.ok) return notify('error', 'Could not open a terminal', r.error.message)
              notify('ok', `Opened ${r.value.command}`, r.value.cwd)
              onClose()
            }}
          >
            Open terminal
          </Button>
        </>
      }
    >
      <p className="mb-4 text-[12.5px] text-fg-2">
        Session mode: Claude Code runs as <span className="font-medium text-fg">{a.alias || a.email}</span> in that terminal only. Your default login and every other terminal are untouched.
      </p>
      <Field label="Start in" hint="Leave empty for your home directory.">
        <div className="flex gap-2">
          <Input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~" className="mono" data-testid="run-dir" />
          <Button
            onClick={async () => {
              const p = await api.pickDirectory()
              if (p) setDir(p)
            }}
            icon={<FolderOpen size={14} />}
          >
            Browse
          </Button>
        </div>
      </Field>
      {mappings.length > 0 && (
        <div className="mt-3">
          <Field label="Or pick a mapped directory" hint="Directories you have mapped with cswap map.">
            <Select
              value={mappings.some((m) => m.path === dir) ? dir : ''}
              onChange={(e) => setDir(e.target.value)}
              aria-label="Mapped directory"
              data-testid="run-mapped"
            >
              <option value="">—</option>
              {mappings.map((m) => (
                <option key={m.path} value={m.path}>
                  {m.path}
                  {m.account ? ` — ${m.account.alias || m.account.email}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      <div className="mono mt-4 rounded-md border border-border bg-bg px-3 py-2 text-[12px] text-fg-2">
        <span className="text-fg-3">{dir.trim() || '~'}$ </span>
        cswap run {a.number}
      </div>
    </Dialog>
  )
}
