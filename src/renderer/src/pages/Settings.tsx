import { useEffect, useState } from 'react'
import { ExternalLink, Flame, FolderOpen, Monitor, Moon, RefreshCw, Sun, Trash2, ArrowUpCircle } from 'lucide-react'
import type { UnclaimedEntry, UpdateInfo } from '@shared/types'
import { useStore } from '../lib/store'
import { api, isElectron, platform } from '../lib/api'
import { useToast } from '../lib/toast'
import { Button, Card, Chip, Field, Input, Segmented, Select, Switch } from '../components/ui'
import { ageSeconds, maskEmail } from '../lib/format'
import { PageHeader } from '../components/PageHeader'

export function SettingsPage(): React.JSX.Element {
  const { settings, updateSettings, binary, redetect, updater, warm, accounts, now } = useStore()
  const { notify } = useToast()
  const [pathDraft, setPathDraft] = useState(settings.cswapPath ?? '')
  const [vault, setVault] = useState<string | null>(null)
  const [unclaimed, setUnclaimed] = useState<UnclaimedEntry[] | null>(null)
  const [info, setInfo] = useState<{ version: string; electron: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)

  useEffect(() => setPathDraft(settings.cswapPath ?? ''), [settings.cswapPath])
  useEffect(() => {
    void api.getVaultPath().then(setVault)
    void api.getAppInfo().then(setInfo)
    void api.listUnclaimed().then((r) => setUnclaimed(r.ok ? r.value : []))
  }, [binary?.path])

  const savePath = async (p: string | null): Promise<void> => {
    setBusy('path')
    await updateSettings({ cswapPath: p })
    setBusy(null)
  }

  return (
    <div className="anim-fade pb-8" data-testid="page-settings">
      <PageHeader title="Settings" />
      <div className="grid gap-4 px-6 lg:grid-cols-2">
        <Card title="cswap binary" actions={binary?.version ? <Chip tone="ok">v{binary.version}</Chip> : <Chip tone="danger">not found</Chip>}>
          <div className="space-y-3 px-4 py-3">
            <div className="text-[12.5px] text-fg-2">
              {binary?.path ? (
                <>
                  Using <span className="mono selectable text-fg">{binary.path}</span> <span className="text-fg-3">({binary.source === 'settings' ? 'set here' : binary.source === 'path' ? 'found on PATH' : `found in ${binary.source} install dir`})</span>
                  {binary.error && <div className="mt-1 text-danger">{binary.error}</div>}
                </>
              ) : (
                'No cswap executable was found in the usual places or on PATH.'
              )}
            </div>
            <Field label="Custom path" hint="Leave empty to auto-detect (uv / pipx / PATH).">
              <div className="flex gap-2">
                <Input value={pathDraft} onChange={(e) => setPathDraft(e.target.value)} placeholder={platform === 'win32' ? 'C:\\Users\\you\\.local\\bin\\cswap.exe' : '~/.local/bin/cswap'} className="mono" data-testid="cswap-path" />
                <Button
                  onClick={async () => {
                    const p = await api.pickBinary()
                    if (p) {
                      setPathDraft(p)
                      await savePath(p)
                    }
                  }}
                  icon={<FolderOpen size={14} />}
                >
                  Browse
                </Button>
                <Button variant="primary" loading={busy === 'path'} disabled={(pathDraft || null) === settings.cswapPath} onClick={() => void savePath(pathDraft.trim() || null)} data-testid="cswap-path-save">
                  Save
                </Button>
              </div>
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => void redetect()} data-testid="detect">
                Detect again
              </Button>
              <Button
                size="sm"
                loading={busy === 'upgrade'}
                disabled={!binary?.version}
                onClick={async () => {
                  setBusy('upgrade')
                  const r = await api.upgradeCswap()
                  setBusy(null)
                  if (r.ok) notify('ok', 'cswap upgrade finished', r.value.stdout.trim().split('\n').slice(-1)[0])
                  else notify('error', 'Upgrade failed', r.error.message)
                }}
              >
                Upgrade cswap
              </Button>
              {!binary?.version && (
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy === 'install'}
                  onClick={async () => {
                    setBusy('install')
                    const r = await api.installCswap()
                    setBusy(null)
                    if (r.ok) notify('ok', 'claude-swap installed with uv')
                    else notify('error', 'Install failed', r.error.message)
                  }}
                >
                  Install with uv
                </Button>
              )}
            </div>
            {binary && binary.candidates.length > 0 && (
              <details className="text-[11.5px] text-fg-3">
                <summary className="cursor-pointer">Locations checked</summary>
                <ul className="mono mt-1 space-y-0.5">
                  {binary.candidates.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                  <li>PATH</li>
                </ul>
              </details>
            )}
          </div>
        </Card>

        <Card title="Appearance & behaviour">
          <div className="space-y-4 px-4 py-3">
            <Field label="Theme" inline>
              <Segmented
                ariaLabel="Theme"
                value={settings.theme}
                onChange={(v) => void updateSettings({ theme: v })}
                options={[
                  { value: 'light', label: <><Sun size={13} /> Light</> },
                  { value: 'dark', label: <><Moon size={13} /> Dark</> },
                  { value: 'system', label: <><Monitor size={13} /> System</> }
                ]}
              />
            </Field>
            <Field label="Refresh usage every" hint="cswap itself throttles calls to Anthropic; this only decides how often the list is re-read." inline>
              <Select value={String(settings.refreshSeconds)} onChange={(e) => void updateSettings({ refreshSeconds: Number(e.target.value) })} className="w-[120px]" aria-label="Refresh interval">
                {[30, 60, 120, 300, 600, 0].map((s) => (
                  <option key={s} value={s}>
                    {s === 0 ? 'Never' : s < 60 ? `${s}s` : `${s / 60} min`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Refresh when the window opens or gets focus" hint="At most once every 10 seconds." inline>
              <Switch checked={settings.refreshOnFocus} onChange={(v) => void updateSettings({ refreshOnFocus: v })} label="Refresh on focus" />
            </Field>
            <Field label="Hide email addresses" hint="Keeps the first three characters — for screenshots and streams." inline>
              <Switch checked={settings.maskEmails} onChange={(v) => void updateSettings({ maskEmails: v })} label="Hide email addresses" />
            </Field>
            <Field label="Close to tray" hint="Closing the window keeps the app running in the tray." inline>
              <Switch checked={settings.closeToTray} onChange={(v) => void updateSettings({ closeToTray: v })} label="Close to tray" />
            </Field>
            <Field label="Start minimized" hint="Start hidden in the tray." inline>
              <Switch checked={settings.startMinimized} onChange={(v) => void updateSettings({ startMinimized: v })} label="Start minimized" />
            </Field>
            <Field label="Launch at login" hint={isElectron ? undefined : 'Only in the packaged app.'} inline>
              <Switch checked={settings.launchAtLogin} onChange={(v) => void updateSettings({ launchAtLogin: v })} label="Launch at login" />
            </Field>
            <Field label="Notify on auto-switch" hint="Desktop notification whenever the auto-switcher changes account." inline>
              <Switch checked={settings.notifyOnAutoSwitch} onChange={(v) => void updateSettings({ notifyOnAutoSwitch: v })} label="Notify on auto-switch" />
            </Field>
            <Field label="Start auto-switch with the app" inline>
              <Switch checked={settings.autoStartAutoSwitch} onChange={(v) => void updateSettings({ autoStartAutoSwitch: v })} label="Start auto-switch with the app" />
            </Field>
          </div>
        </Card>

        <Card title="Keep warm" actions={warm.running ? <Chip tone="accent">warming…</Chip> : settings.keepWarm ? <Chip tone="ok">on</Chip> : <Chip tone="muted">off</Chip>}>
          <div className="space-y-4 px-4 py-3" data-testid="warm-card">
            <p className="text-[12.5px] text-fg-2">
              A 5-hour window only starts with the first message, so an account nobody has used has the full five hours still to wait the day you need it. Keep warm sends one one-word message to each idle account, so its window is already running — and spaces them out, so the resets land at different times instead of together.
            </p>
            <p className="text-[11.5px] text-fg-3">
              Each message goes through <span className="mono">cswap run</span> in its own profile, so the login your terminals use is never touched. The account you are using, disabled accounts, accounts that need a login and accounts with no weekly quota left are skipped. Each ping costs a few thousand tokens on the small model.
            </p>
            <Field label="Keep idle accounts warm" hint="Checks every minute while the app is running — keep it in the tray." inline>
              <Switch checked={settings.keepWarm} onChange={(v) => void updateSettings({ keepWarm: v })} label="Keep idle accounts warm" />
            </Field>
            <Field label="Space warm-ups at least" hint="So the windows do not all end at the same minute." inline>
              <Select value={String(settings.keepWarmStaggerMin)} onChange={(e) => void updateSettings({ keepWarmStaggerMin: Number(e.target.value) })} className="w-[120px]" aria-label="Warm-up spacing" data-testid="warm-stagger">
                {[0, 10, 20, 30, 45, 60, 90].map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? 'No spacing' : `${m} min`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Model for the message" hint="The smallest one is enough to start a window." inline>
              <Select value={settings.keepWarmModel} onChange={(e) => void updateSettings({ keepWarmModel: e.target.value })} className="w-[120px]" aria-label="Warm-up model">
                <option value="haiku">Haiku</option>
                <option value="sonnet">Sonnet</option>
              </Select>
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                icon={<Flame size={13} />}
                loading={busy === 'warm' || !!warm.running}
                data-testid="warm-now"
                onClick={async () => {
                  setBusy('warm')
                  const r = await api.warmNow()
                  setBusy(null)
                  if (!r.ok) notify('error', 'Could not warm up', r.error.message)
                  else if (!r.value.attempted) notify('info', 'Nothing to warm up', 'Every account is in use, already running a window, out of weekly quota, or needs a login.')
                  else notify(r.value.failed ? 'error' : 'ok', `Warmed ${r.value.ok} of ${r.value.attempted}`)
                }}
              >
                Warm idle accounts now
              </Button>
              {settings.keepWarmExclude.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => void updateSettings({ keepWarmExclude: [] })}>
                  Include all {settings.keepWarmExclude.length} left-out account{settings.keepWarmExclude.length === 1 ? '' : 's'}
                </Button>
              )}
            </div>
            {Object.keys(warm.entries).length > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-fg-3">Recent</div>
                <ul className="space-y-1" data-testid="warm-recent">
                  {Object.entries(warm.entries)
                    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
                    .slice(0, 8)
                    .map(([email, e]) => (
                      <li key={email} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[12px]">
                        <span className="min-w-0 flex-1 truncate text-fg" title={settings.maskEmails ? undefined : email}>
                          {maskEmail(email, settings.maskEmails)}
                          {accounts.payload?.accounts.find((a) => a.email === email) ? '' : ' (removed)'}
                        </span>
                        {e.ok ? <Chip tone="ok">window started</Chip> : <Chip tone="danger">failed</Chip>}
                        <span className="shrink-0 text-fg-3">{ageSeconds((now - Date.parse(e.at)) / 1000)}</span>
                        {!e.ok && e.message && (
                          <span className="max-w-[40%] truncate text-danger" title={e.message}>
                            {e.message}
                          </span>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </div>
        </Card>

        <Card title="Data">
          <div className="space-y-3 px-4 py-3 text-[12.5px] text-fg-2">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-fg-3">cswap vault (backup root)</div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className="mono selectable truncate text-fg" title={vault ?? ''}>
                  {vault ?? 'unknown'}
                </span>
                {vault && (
                  <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void api.openPath(vault)}>
                    Open
                  </Button>
                )}
              </div>
              <p className="mt-1 text-[11.5px] text-fg-3">Read for mappings and change detection only. Every write goes through the cswap CLI so the vault stays consistent with the terminal and the TUI.</p>
            </div>
            <div>
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-fg-3">
                Unclaimed credential entries
                {unclaimed && unclaimed.length > 0 && <Chip tone="warn">{unclaimed.length}</Chip>}
              </div>
              {unclaimed === null && <div className="mt-1 text-fg-3">Loading…</div>}
              {unclaimed && unclaimed.length === 0 && <div className="mt-1 text-fg-3">None — nothing stashed that cswap could not attribute to a slot.</div>}
              {unclaimed && unclaimed.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {unclaimed.map((u) => (
                    <li key={u.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
                      <span className="mono text-fg">{u.id}</span>
                      <span className="text-fg-3">slot {u.slot}</span>
                      <span className="min-w-0 flex-1 truncate text-fg-3">{u.reason}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 size={13} />}
                        onClick={async () => {
                          const r = await api.purgeUnclaimed(u.id)
                          if (r.ok) notify('ok', `Purged ${u.id}`)
                          else notify('error', 'Purge failed', r.error.message)
                          const l = await api.listUnclaimed()
                          setUnclaimed(l.ok ? l.value : [])
                        }}
                      >
                        Purge
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>

        <Card title="About">
          <div className="space-y-2 px-4 py-3 text-[12.5px] text-fg-2">
            <div>
              <span className="font-medium text-fg">Claude Swap</span> {info?.version}
              {info?.electron && <span className="text-fg-3"> · Electron {info.electron}</span>}
            </div>
            <p>A desktop front-end for claude-swap. It drives the CLI you already have installed; the only thing it sends to Anthropic itself is the browser sign-in, and that login goes straight into the vault through cswap.</p>
            <div className="rounded-md border border-border bg-bg/50 px-3 py-2" data-testid="updater">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-fg">
                    {updater.status === 'disabled' && (platform === 'darwin' ? 'Automatic updates are off on macOS' : 'Automatic updates need the installed app')}
                    {updater.status === 'idle' && 'Automatic updates on'}
                    {updater.status === 'checking' && 'Checking for updates…'}
                    {updater.status === 'not-available' && 'You are on the latest version'}
                    {updater.status === 'available' && `Version ${updater.version} found — downloading`}
                    {updater.status === 'downloading' && `Downloading ${updater.version}… ${updater.percent ?? 0}%`}
                    {updater.status === 'downloaded' && `Version ${updater.version} is ready to install`}
                    {updater.status === 'error' && 'Update check failed'}
                  </div>
                  <div className="text-[11.5px] text-fg-3">
                    {updater.status === 'error' ? updater.error : updater.status === 'disabled' ? (platform === 'darwin' ? 'macOS builds are unsigned, so updates there are manual.' : 'Running from source or a dev build — use the release page.') : updater.checkedAt ? `Checked ${new Date(updater.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · installs on quit or on request` : 'Checks at start and every 6 hours; installs on quit or on request.'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {updater.status === 'downloaded' ? (
                    <Button size="sm" variant="primary" icon={<ArrowUpCircle size={13} />} onClick={() => void api.updaterInstall()} data-testid="update-install">
                      Restart & install
                    </Button>
                  ) : updater.status !== 'disabled' ? (
                    <Button size="sm" loading={updater.status === 'checking' || updater.status === 'downloading' || updater.status === 'available'} icon={<RefreshCw size={13} />} onClick={() => void api.updaterCheck()} data-testid="update-check">
                      Check now
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      icon={<ArrowUpCircle size={13} />}
                      loading={busy === 'update'}
                      data-testid="check-update"
                      onClick={async () => {
                        setBusy('update')
                        const u = await api.checkForUpdate()
                        setBusy(null)
                        setUpdate(u)
                        if (u.error) notify('error', 'Could not check for updates', u.error)
                        else if (u.updateAvailable) notify('info', `Version ${u.latest} is available`, 'Open the releases page to download it.')
                        else notify('ok', 'You are on the latest version')
                      }}
                    >
                      Check for updates
                    </Button>
                  )}
                  {update?.updateAvailable && update.url && (
                    <Button size="sm" variant="primary" icon={<ExternalLink size={13} />} onClick={() => void api.openExternal(update.url!)}>
                      Get {update.latest}
                    </Button>
                  )}
                </div>
              </div>
              {(updater.status === 'downloading' || updater.status === 'available') && (
                <div className="mt-2 h-[4px] w-full overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${updater.percent ?? 0}%` }} />
                </div>
              )}
              <label className="mt-2 flex items-center justify-between gap-3 text-[12px] text-fg-2">
                Download updates automatically
                <Switch checked={settings.autoUpdate} onChange={(v) => void updateSettings({ autoUpdate: v })} label="Download updates automatically" disabled={updater.status === 'disabled'} />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void api.openExternal('https://github.com/TheSkinnyRat/cswap-desktop')}>
                Claude Swap on GitHub
              </Button>
              <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void api.openExternal('https://github.com/realiti4/claude-swap')}>
                claude-swap (upstream)
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
