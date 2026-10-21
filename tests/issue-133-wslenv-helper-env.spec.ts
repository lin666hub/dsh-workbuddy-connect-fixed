import { execFile } from 'node:child_process'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  helperChildEnv,
  WorkBuddyAtRestKeyProvider,
  wslenvForwardRunAsNode,
} from '../src/desktop-credential-protection.ts'
import { CN_VARIANT, electronProfileFor } from '../src/variants.ts'

/**
 * Issue #133: from WSL, the at-rest key helper spawns the Windows WorkBuddy
 * exe through interop. A child env of `{ ...process.env,
 * ELECTRON_RUN_AS_NODE: '1' }` is NOT enough there: WSL forwards a variable
 * to the Windows side only when `WSLENV` lists it with the `/w` direction
 * flag. Without it the exe starts in GUI mode and its stdout is app log, so
 * the plugin reported `encrypted-credential-unreadable` ("unusable at-rest
 * payload") for a signed-in account — a key problem that was really a
 * process-mode problem.
 *
 * REV 4 SAFETY CONTRACT (review fixes over the first cut):
 *
 * - WHICH spawns get the merge: any WSL host spawning a helper that is itself
 *   a Windows executable (`.exe` suffix, case-insensitive). The automount
 *   root is configurable (`/windir/`, `/`, …), so `/mnt` must not be the
 *   discriminator; a native Linux helper — even one installed under `/mnt` —
 *   never consults WSLENV and stays untouched, as does every non-WSL host.
 * - WHAT the merge produces: exactly ONE `ELECTRON_RUN_AS_NODE` entry with a
 *   path-free flag set — always `w`, plus `u` only when an existing entry
 *   asked for it. Duplicate same-name entries (bare, `/u`, `/w`, `/l`, `/p`,
 *   combinations) would leave the forwarding direction indeterminate, and
 *   the path flags `p`/`l` would translate the value — here the numeric
 *   switch `1` — as a path and break it. Other variables keep their order
 *   and bytes; the function is idempotent.
 *
 * Everything here is offline: `node:child_process` is mocked so no Windows
 * binary is ever launched and no real credential is read, and the WSL cases
 * are driven through the provider's injectable `wsl` detection.
 */

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

const execFileMock = execFile as unknown as Mock

/** One captured helper spawn: the binary, args, options (with `env`), and callback. */
interface CapturedSpawn {
  path: string
  options: { env: Record<string, string | undefined>, timeout: number, maxBuffer: number }
  callback: (error: { killed?: boolean, code?: number | string } | null, stdout: string) => void
}

describe('#133 WSLENV merge (wslenvForwardRunAsNode)', () => {
  it('appends the flagged entry when WSLENV is unset or empty', () => {
    expect(wslenvForwardRunAsNode(undefined)).toBe('ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('')).toBe('ELECTRON_RUN_AS_NODE/w')
  })

  it('keeps other entries and drops the trailing empty segment Windows Terminal leaves', () => {
    expect(wslenvForwardRunAsNode('WT_SESSION:WT_PROFILE_ID:'))
      .toBe('WT_SESSION:WT_PROFILE_ID:ELECTRON_RUN_AS_NODE/w')
  })

  it('drops inner empty segments', () => {
    expect(wslenvForwardRunAsNode('A::B')).toBe('A:B:ELECTRON_RUN_AS_NODE/w')
  })

  it('treats a bare entry as carrying no direction and consolidates to /w', () => {
    // A bare name has no direction, so it can be trusted to forward neither
    // way — the reporter's suggested check would have accepted it.
    expect(wslenvForwardRunAsNode('FOO:ELECTRON_RUN_AS_NODE')).toBe('FOO:ELECTRON_RUN_AS_NODE/w')
  })

  it('keeps the user’s /u direction by consolidating to /uw', () => {
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/u')).toBe('ELECTRON_RUN_AS_NODE/uw')
  })

  it('normalizes path flags away — the value is the numeric switch 1, never a path', () => {
    // `/p` (path translation) and `/l` (path list) would mangle `1`; the
    // target entry is consolidated to a path-free flag set instead of having
    // `w` appended to the inherited flags.
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/p')).toBe('ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/l')).toBe('ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/pu')).toBe('ELECTRON_RUN_AS_NODE/uw')
    // …even when `w` is already present, the path flags still go.
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/pw')).toBe('ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/lw')).toBe('ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/plw')).toBe('ELECTRON_RUN_AS_NODE/w')
  })

  it('leaves an already-safe entry byte-identical (idempotence)', () => {
    expect(wslenvForwardRunAsNode('FOO:ELECTRON_RUN_AS_NODE/w')).toBe('FOO:ELECTRON_RUN_AS_NODE/w')
    expect(wslenvForwardRunAsNode('FOO:ELECTRON_RUN_AS_NODE/uw')).toBe('FOO:ELECTRON_RUN_AS_NODE/uw')
  })

  it('collapses duplicate same-name entries into one effective entry', () => {
    // Two same-name entries with different flags leave the forwarding
    // direction indeterminate; whichever order they appear in, the child sees
    // exactly one entry that carries `w` (and `u` when either asked for it).
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/u:ELECTRON_RUN_AS_NODE/w'))
      .toBe('ELECTRON_RUN_AS_NODE/uw')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE/w:ELECTRON_RUN_AS_NODE/u'))
      .toBe('ELECTRON_RUN_AS_NODE/uw')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE:ELECTRON_RUN_AS_NODE/l:ELECTRON_RUN_AS_NODE/pu'))
      .toBe('ELECTRON_RUN_AS_NODE/uw')
    expect(wslenvForwardRunAsNode('FOO:ELECTRON_RUN_AS_NODE:ELECTRON_RUN_AS_NODE'))
      .toBe('FOO:ELECTRON_RUN_AS_NODE/w')
  })

  it('consolidates at the FIRST same-name position; other entries keep their places', () => {
    expect(wslenvForwardRunAsNode('A:ELECTRON_RUN_AS_NODE/l:B:ELECTRON_RUN_AS_NODE/u:C'))
      .toBe('A:ELECTRON_RUN_AS_NODE/uw:B:C')
  })

  it('is idempotent as a whole: merging twice changes nothing more', () => {
    for (const input of [
      'WT_SESSION:WT_PROFILE_ID:',
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_RUN_AS_NODE/u',
      'ELECTRON_RUN_AS_NODE/pw',
      'ELECTRON_RUN_AS_NODE/u:ELECTRON_RUN_AS_NODE/w',
      'A:ELECTRON_RUN_AS_NODE/l:B:ELECTRON_RUN_AS_NODE/u:C',
      undefined,
    ]) {
      const once = wslenvForwardRunAsNode(input)
      expect(wslenvForwardRunAsNode(once)).toBe(once)
    }
  })

  it('never rewrites or reorders the user’s own entries', () => {
    expect(wslenvForwardRunAsNode('WT_SESSION:PATH/p:WT_PROFILE_ID'))
      .toBe('WT_SESSION:PATH/p:WT_PROFILE_ID:ELECTRON_RUN_AS_NODE/w')
  })
})

describe('#133 helper child env (helperChildEnv)', () => {
  it('non-WSL keeps the previous behaviour byte-for-byte and copies the parent', () => {
    const parent = { HOME: '/home/u', PATH: '/usr/bin' }
    const child = helperChildEnv(parent, '/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', false)
    expect(child).toEqual({ HOME: '/home/u', PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' })
    // The parent env is never mutated.
    expect(parent).toEqual({ HOME: '/home/u', PATH: '/usr/bin' })
  })

  it('non-WSL leaves an inherited WSLENV untouched', () => {
    const child = helperChildEnv({ WSLENV: 'WT_SESSION:' }, '/Applications/WorkBuddy.app/Contents/MacOS/Electron', false)
    expect(child['WSLENV']).toBe('WT_SESSION:')
  })

  it('WSL to a Windows exe under the default mount merges WSLENV around the other entries', () => {
    const parent = { HOME: '/home/u', WSLENV: 'WT_SESSION:WT_PROFILE_ID:' }
    const child = helperChildEnv(parent, '/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', true)
    expect(child['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(child['WSLENV']).toBe('WT_SESSION:WT_PROFILE_ID:ELECTRON_RUN_AS_NODE/w')
    expect(parent['WSLENV']).toBe('WT_SESSION:WT_PROFILE_ID:')
  })

  it('WSL to a Windows exe under a custom automount root (wsl.conf [automount] root=…) merges too', () => {
    // The mount root is configurable; `/mnt` must not be the discriminator.
    for (const path of [
      '/windir/c/Program Files/WorkBuddy/WorkBuddy.exe',
      '/c/Program Files/WorkBuddy/WorkBuddy.exe',
    ]) {
      const child = helperChildEnv({ WSLENV: 'WT_SESSION:' }, path, true)
      expect(child['WSLENV']).toBe('WT_SESSION:ELECTRON_RUN_AS_NODE/w')
    }
  })

  it('matches the .exe suffix case-insensitively', () => {
    const child = helperChildEnv({ WSLENV: 'WT_SESSION:' }, '/windir/c/Program Files/WorkBuddy/WorkBuddy.EXE', true)
    expect(child['WSLENV']).toBe('WT_SESSION:ELECTRON_RUN_AS_NODE/w')
  })

  it('WSL to a native Linux helper leaves WSLENV alone — even under /mnt', () => {
    // A native binary never crosses interop, wherever it is installed; the
    // discriminator is the Windows-executable file, not the mount point.
    for (const path of ['/opt/wb-electron', '/mnt/tools/wb-electron']) {
      const child = helperChildEnv({ HOME: '/home/u' }, path, true)
      expect(child['WSLENV']).toBeUndefined()
      expect(child['ELECTRON_RUN_AS_NODE']).toBe('1')
    }
  })
})

describe('#133 helper spawn wiring (spawnAt via the provider)', () => {
  let spawns: CapturedSpawn[] = []
  /** What the mocked execFile answers for the next spawn. */
  let answer: (spawn: CapturedSpawn) => void = () => {}

  beforeEach(() => {
    spawns = []
    answer = () => {}
    execFileMock.mockReset().mockImplementation((path: string, _args: unknown[], options: CapturedSpawn['options'], callback: CapturedSpawn['callback']) => {
      const spawn = { path, options, callback }
      spawns.push(spawn)
      answer(spawn)
    })
  })
  afterEach(() => { vi.unstubAllEnvs() })

  /** A provider whose private spawnAt is reachable without spawning anything real. */
  function spawnAt(path: string, wsl: () => boolean): Promise<string> {
    const provider = new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(CN_VARIANT), wsl })
    return (provider as unknown as { spawnAt(electronPath: string): Promise<string> }).spawnAt(path)
  }

  it('passes the previous env through on a non-WSL host, even for a /mnt-style exe path', async () => {
    answer = spawn => spawn.callback(null, '')
    await expect(spawnAt('/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', () => false))
      .rejects.toThrow(/produced no payload/)
    expect(spawns).toHaveLength(1)
    const env = spawns[0]!.options.env
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(env['WSLENV']).toBe(process.env['WSLENV'])
  })

  it('forwards ELECTRON_RUN_AS_NODE through WSLENV for a WSL → Windows exe spawn', async () => {
    answer = spawn => spawn.callback(null, '')
    await expect(spawnAt('/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', () => true))
      .rejects.toThrow(/produced no payload/)
    const env = spawns[0]!.options.env
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(env['WSLENV']).toBe(wslenvForwardRunAsNode(process.env['WSLENV']))
    expect(env['WSLENV']).toContain('ELECTRON_RUN_AS_NODE/w')
    // The plugin's own process env stays clean.
    expect(process.env['WSLENV']).toBeUndefined()
  })

  it('forwards through WSLENV for a Windows exe under a custom automount root too', async () => {
    answer = spawn => spawn.callback(null, '')
    await expect(spawnAt('/windir/c/Program Files/WorkBuddy/WorkBuddy.exe', () => true))
      .rejects.toThrow(/produced no payload/)
    expect(spawns[0]!.options.env['WSLENV']).toContain('ELECTRON_RUN_AS_NODE/w')
  })

  it('leaves WSLENV alone for a native Linux helper path under WSL', async () => {
    vi.stubEnv('WSLENV', 'WT_SESSION:')
    answer = spawn => spawn.callback(null, '')
    await expect(spawnAt('/mnt/tools/wb-electron', () => true)).rejects.toThrow(/produced no payload/)
    expect(spawns[0]!.options.env['WSLENV']).toBe('WT_SESSION:')
  })

  it('normalizes an inherited WSLENV with a trailing colon, without touching the parent', async () => {
    vi.stubEnv('WSLENV', 'WT_SESSION:WT_PROFILE_ID:')
    answer = spawn => spawn.callback(null, '')
    await expect(spawnAt('/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', () => true))
      .rejects.toThrow(/produced no payload/)
    expect(spawns[0]!.options.env['WSLENV']).toBe('WT_SESSION:WT_PROFILE_ID:ELECTRON_RUN_AS_NODE/w')
    expect(process.env['WSLENV']).toBe('WT_SESSION:WT_PROFILE_ID:')
  })

  it('consolidates duplicate same-name entries the user may carry', async () => {
    vi.stubEnv('WSLENV', 'ELECTRON_RUN_AS_NODE/u:ELECTRON_RUN_AS_NODE/w')
    answer = spawn => spawn.callback(null, '')
    await expect(spawnAt('/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', () => true))
      .rejects.toThrow(/produced no payload/)
    // One effective entry, carrying both directions, no path flags.
    expect(spawns[0]!.options.env['WSLENV']).toBe('ELECTRON_RUN_AS_NODE/uw')
    expect(process.env['WSLENV']).toBe('ELECTRON_RUN_AS_NODE/u:ELECTRON_RUN_AS_NODE/w')
  })

  it('still attributes a non-zero exit to the helper, code only', async () => {
    answer = spawn => spawn.callback(Object.assign(new Error('failed'), { code: 3 }), '')
    await expect(spawnAt('/mnt/c/Program Files/WorkBuddy/WorkBuddy.exe', () => true))
      .rejects.toThrow(/WorkBuddy key helper \(.+\) exited with code 3/)
  })

  it('still attributes GUI-mode log output to the payload-format branch, not the empty branch', async () => {
    // The reporter's failing shape: the exe DID print — app log, not JSON.
    // That must keep landing in "unusable at-rest payload", never be
    // mistaken for a key problem, and never echo the log text.
    answer = spawn => spawn.callback(null, '[AccountService] HTTP interceptor registered')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      electronPath: process.execPath,
      wsl: () => false,
    })
    await expect(provider.protectorKeyFor(['aaaaaaaaaaaaaaaa']))
      .rejects.toThrow(/unusable at-rest payload/)
    await expect(provider.protectorKeyFor(['aaaaaaaaaaaaaaaa']))
      .rejects.not.toThrow(/AccountService/)
  })
})
