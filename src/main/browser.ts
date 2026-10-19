import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// Opens the sign-in page in Chrome when it can be found — optionally in a private window,
// which is how you pick a different account than the one Chrome is already signed into —
// and otherwise in whatever the system default is.

export function chromeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((b): b is string => !!b).map((b) => join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
}

export function findChrome(exists: (p: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = chromeCandidates(platform, env)
  if (platform === 'linux') {
    // Bare command names: look them up on PATH.
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) for (const name of candidates) if (exists(join(dir, name))) return join(dir, name)
    return null
  }
  return candidates.find((c) => exists(c)) ?? null
}

export type OpenedIn = 'chrome' | 'default'

export function openInBrowser(url: string, opts: { browser: 'chrome' | 'default'; privateWindow: boolean }, fallback: (url: string) => void): OpenedIn {
  // e2e seam: nothing may open on the machine running the tests.
  if (process.env.CSWAP_DESKTOP_TEST_NO_SPAWN) return opts.browser
  if (opts.browser === 'chrome') {
    const chrome = findChrome()
    if (chrome) {
      const flags = opts.privateWindow ? ['--incognito'] : []
      try {
        // macOS: go through `open` so a running Chrome takes the request instead of a second instance starting.
        const child =
          process.platform === 'darwin'
            ? spawn('open', ['-na', 'Google Chrome', '--args', ...flags, url], { detached: true, stdio: 'ignore' })
            : spawn(chrome, [...flags, url], { detached: true, stdio: 'ignore' })
        child.on('error', () => fallback(url))
        child.unref()
        return 'chrome'
      } catch {
        /* fall through to the default browser */
      }
    }
  }
  fallback(url)
  return 'default'
}
