import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, Copy, ExternalLink, Globe, Loader2 } from 'lucide-react'
import type { Account, OAuthState } from '@shared/types'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { useToast } from '../lib/toast'
import { Button, Chip, Dialog, Field, Input, Segmented, Switch } from './ui'

// Sign in from a browser instead of the terminal. Used to add an account and to fix one
// whose login has died: the same dialog, the second one with the account's email as the
// sign-in hint and a check that the right person signed in.

const LIVE = ['waiting', 'exchanging', 'ready']

export function OAuthDialog({ account, onClose }: { account?: Account; onClose: () => void }): React.JSX.Element {
  const { settings, updateSettings } = useStore()
  const { notify } = useToast()
  const [st, setSt] = useState<OAuthState | null>(null)
  const [starting, setStarting] = useState(false)
  const [alias, setAlias] = useState('')
  const [manual, setManual] = useState(false)
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)
  const idRef = useRef<string | null>(null)
  const committed = useRef<string | null>(null)
  const relogin = !!account
  const chrome = settings.loginBrowser === 'chrome'
  const hint = account && !account.email.endsWith('@token.local') ? account.email : undefined

  useEffect(() => api.onOAuth((s) => s.id === idRef.current && setSt(s)), [])

  const start = async (): Promise<void> => {
    setStarting(true)
    const r = await api.oauthStart({ slot: account?.number, email: hint, manual })
    setStarting(false)
    if (!r.ok) return notify('error', 'Could not start the sign-in', r.error.message)
    idRef.current = r.value.id
    committed.current = null
    setCode('')
    setSt(r.value)
  }

  const commit = async (asNew?: boolean): Promise<void> => {
    if (!st) return
    const r = await api.oauthCommit(st.id, { alias: alias.trim() || undefined, asNew })
    if (r.ok) setSt(r.value)
    else if (r.error.type !== 'IdentityMismatch') notify('error', 'Could not store the login', r.error.message)
  }

  // Once the person is known and it is who we expected, store it — no extra click.
  useEffect(() => {
    if (!st || st.stage !== 'ready' || st.mismatch || committed.current === st.id) return
    committed.current = st.id
    void commit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st])

  const close = (): void => {
    if (st && LIVE.includes(st.stage)) void api.oauthCancel(st.id)
    onClose()
  }
  const again = (): void => {
    if (st) void api.oauthCancel(st.id)
    idRef.current = null
    setSt(null)
  }

  const who = st?.identity
  const where = st?.browser === 'chrome' ? 'Chrome' : 'your browser'
  const phase = !st ? 'setup' : st.stage === 'ready' && st.mismatch ? 'mismatch' : st.stage === 'ready' && st.error ? 'retry' : st.stage

  const paste = (
    <div className="mt-3">
      <Field label={st?.manual ? 'Paste the code' : 'Browser did not come back? Paste what it shows'} hint={st?.manual ? 'The page shows a code after you sign in — copy it whole.' : 'Either the code, or the address the browser ended up on.'}>
        <div className="flex gap-2">
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code#state  or  http://localhost:…/callback?code=…" className="mono text-[12px]" spellCheck={false} autoComplete="off" data-testid="oauth-paste" />
          <Button
            variant="primary"
            disabled={!code.trim()}
            loading={submitting}
            data-testid="oauth-paste-submit"
            onClick={async () => {
              if (!st) return
              setSubmitting(true)
              await api.oauthSubmitCode(st.id, code)
              setSubmitting(false)
            }}
          >
            Continue
          </Button>
        </div>
      </Field>
    </div>
  )

  const footer =
    phase === 'setup' ? (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" icon={<Globe size={14} />} loading={starting} onClick={() => void start()} data-testid="oauth-open">
          Open {chrome ? 'Chrome' : 'browser'} to sign in
        </Button>
      </>
    ) : phase === 'done' ? (
      <Button variant="primary" onClick={onClose} data-testid="oauth-close">
        Done
      </Button>
    ) : phase === 'error' || phase === 'cancelled' ? (
      <>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" onClick={again} data-testid="oauth-again">
          Try again
        </Button>
      </>
    ) : phase === 'mismatch' ? (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button onClick={again} data-testid="oauth-again">
          Sign in again
        </Button>
        <Button variant="primary" onClick={() => void commit(true)} data-testid="oauth-asnew">
          {who?.existingSlot ? `Refresh Account-${who.existingSlot} instead` : 'Add it as a new account'}
        </Button>
      </>
    ) : phase === 'retry' ? (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void commit()} data-testid="oauth-retry">
          Try saving again
        </Button>
      </>
    ) : (
      <Button variant="ghost" onClick={close}>
        Cancel
      </Button>
    )

  return (
    <Dialog open onClose={close} width={520} title={relogin ? `Sign in again — Account-${account!.number}` : 'Sign in with the browser'} footer={footer}>
      {phase === 'setup' && (
        <>
          <p className="mb-4 text-[12.5px] text-fg-2">
            {relogin ? (
              <>
                Account-{account!.number} (<span className="font-medium text-fg">{account!.email}</span>) can no longer refresh its login. Sign in to it once more and the stored login is replaced.
              </>
            ) : (
              <>Sign in to Claude in your browser. Claude Swap picks the login up itself and stores it.</>
            )}{' '}
            Nothing runs in a terminal, and the Claude Code login your terminals are using is not touched — work in progress carries on.
          </p>
          <div className="space-y-3">
            <Field label="Browser" inline>
              <Segmented ariaLabel="Browser" value={settings.loginBrowser} onChange={(v) => void updateSettings({ loginBrowser: v })} options={[{ value: 'chrome', label: 'Chrome' }, { value: 'default', label: 'System default' }]} />
            </Field>
            <Field label="Private window" hint={relogin ? 'Lets you type this account in, whichever one the browser is signed into.' : 'Recommended — otherwise the browser signs you in as the account it already knows.'} inline>
              <Switch checked={settings.loginPrivate} onChange={(v) => void updateSettings({ loginPrivate: v })} label="Private window" disabled={!chrome} />
            </Field>
            {!relogin && (
              <Field label="Alias" hint="Optional short name." >
                <Input placeholder="e.g. work" value={alias} onChange={(e) => setAlias(e.target.value)} data-testid="oauth-alias" />
              </Field>
            )}
            <details className="text-[12px] text-fg-3">
              <summary className="cursor-pointer select-none">Advanced</summary>
              <label className="mt-2 flex items-center justify-between gap-3 text-fg-2">
                <span>Show a code to paste back instead of redirecting automatically</span>
                <Switch checked={manual} onChange={setManual} label="Paste a code" />
              </label>
            </details>
          </div>
        </>
      )}

      {phase === 'waiting' && st && (
        <div data-testid="oauth-waiting">
          <div className="flex items-start gap-3">
            <Loader2 size={18} className="spin mt-[1px] shrink-0 text-accent" />
            <div className="text-[12.5px] text-fg-2">
              <div className="text-[13px] font-medium text-fg">Waiting for you to sign in…</div>
              Finish signing in{relogin ? <> as <span className="font-medium text-fg">{account!.email}</span></> : ''} in {where}. This window continues by itself once you are done.
              {settings.loginBrowser === 'chrome' && st.browser === 'default' && <div className="mt-1 text-warn">Chrome was not found, so the page opened in your default browser.</div>}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5">
            <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-fg-3" title={st.url}>
              {st.url}
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon={copied ? <Check size={13} /> : <Copy size={13} />}
              onClick={() => {
                void navigator.clipboard?.writeText(st.url)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              Copy link
            </Button>
            <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void api.oauthReopen(st.id)} data-testid="oauth-reopen">
              Reopen
            </Button>
          </div>
          {st.manual ? paste : <details className="mt-2 text-[12px] text-fg-3"><summary className="cursor-pointer select-none">Paste a code instead</summary>{paste}</details>}
        </div>
      )}

      {(phase === 'exchanging' || phase === 'committing' || (phase === 'ready' && !st?.error)) && (
        <div className="flex items-start gap-3" data-testid="oauth-working">
          <Loader2 size={18} className="spin mt-[1px] shrink-0 text-accent" />
          <div className="text-[12.5px] text-fg-2">
            <div className="text-[13px] font-medium text-fg">{phase === 'exchanging' ? 'Getting the login from Anthropic…' : 'Storing the login…'}</div>
            {who ? (
              <>
                Signed in as <span className="font-medium text-fg">{who.email}</span>
                {who.plan && <> · {who.plan}</>}
              </>
            ) : (
              'One moment.'
            )}
          </div>
        </div>
      )}

      {phase === 'retry' && st && (
        <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger" data-testid="oauth-error">
          Signed in as {who?.email}, but cswap could not store it: {st.error}
          <div className="mt-1 text-fg-2">The login is still held here — you do not have to sign in again.</div>
        </div>
      )}

      {phase === 'mismatch' && who && (
        <div className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px] text-fg-2" data-testid="oauth-mismatch">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-warn">
            <CircleAlert size={14} /> That is a different account
          </div>
          You signed in as <span className="font-medium text-fg">{who.email}</span>, but Account-{st?.slot} is <span className="font-medium text-fg">{account?.email}</span>. Nothing has been changed. Sign in again with the right account, or keep what you signed in with.
        </div>
      )}

      {phase === 'done' && st && (
        <div className="flex items-start gap-3" data-testid="oauth-done">
          <span className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
            <Check size={12} />
          </span>
          <div className="text-[12.5px] text-fg-2">
            <div className="text-[13px] font-medium text-fg">
              {relogin ? 'Login replaced' : 'Account added'}
              {st.result?.slot ? ` — Account-${st.result.slot}` : ''}
            </div>
            <span className="font-medium text-fg">{who?.email}</span>
            {who?.plan && <Chip tone="muted" className="ml-1.5">{who.plan}</Chip>}
            <div className="mt-1.5 text-fg-3">The Claude Code login in your terminals was not touched.</div>
            {st.result?.note && <div className="mt-1.5 text-fg-3">{st.result.note.replace(/^Note:\s*/, '')}</div>}
          </div>
        </div>
      )}

      {(phase === 'error' || phase === 'cancelled') && (
        <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger" data-testid="oauth-error">
          {st?.error || 'The sign-in was cancelled.'}
        </div>
      )}
    </Dialog>
  )
}
