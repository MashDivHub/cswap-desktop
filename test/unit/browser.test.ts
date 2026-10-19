import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { chromeCandidates, findChrome, openInBrowser } from '../../src/main/browser'

afterEach(() => {
  delete process.env.CSWAP_DESKTOP_TEST_NO_SPAWN
})

describe('finding Chrome', () => {
  const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }

  it('looks in the three places Windows installs it, system-wide first', () => {
    expect(chromeCandidates('win32', env)).toEqual([
      join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join('C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join('C:\\Users\\me\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ])
  })

  it('takes the first one that exists — a per-user install counts', () => {
    const perUser = join('C:\\Users\\me\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
    expect(findChrome((p) => p === perUser, 'win32', env)).toBe(perUser)
    expect(findChrome(() => false, 'win32', env)).toBeNull()
  })

  it('skips variables that are not set', () => {
    expect(chromeCandidates('win32', { LOCALAPPDATA: 'C:\\L' })).toHaveLength(1)
  })

  it('on Linux it searches PATH for the usual names', () => {
    const found = findChrome((p) => p === join('/usr/bin', 'chromium'), 'linux', { PATH: ['/bin', '/usr/bin'].join(process.platform === 'win32' ? ';' : ':') })
    expect(found).toBe(join('/usr/bin', 'chromium'))
  })
})

describe('openInBrowser', () => {
  it('in a test it opens nothing and says which browser it would have used', () => {
    process.env.CSWAP_DESKTOP_TEST_NO_SPAWN = '1'
    const opened: string[] = []
    expect(openInBrowser('https://example.com/x', { browser: 'chrome', privateWindow: true }, (u) => opened.push(u))).toBe('chrome')
    expect(openInBrowser('https://example.com/x', { browser: 'default', privateWindow: false }, (u) => opened.push(u))).toBe('default')
    expect(opened).toEqual([])
  })
})
