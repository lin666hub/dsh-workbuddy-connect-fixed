/**
 * WINDOWS-ONLY real-process integration for the PowerShell 5.1 registry
 * fallback (issues #105/#106/#107).
 *
 * The whole suite skips on every platform except `win32`. Nothing here mocks
 * the environment: `reg.exe`, `powershell.exe`, `SystemRoot`, and the
 * registry are the runner's real ones, and the fallback is exercised through
 * the plugin's own exported `workBuddyWindowsDiscoveryTools()` so the argv
 * and the JSON handling under test are the production artifacts — no
 * hand-written stand-in script is claimed as end-to-end.
 *
 * The suite owns exactly one registry key, created in `beforeAll` and deleted
 * in `afterAll`:
 *
 *   HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSH_CI_REGRESSION_HOTFIX073
 *
 * It lives in the current user's hive (no admin rights) and nothing outside
 * that namespace is ever written. Assertions about registry *content* are
 * booleans on purpose: a failed `toContain` would print the whole document —
 * other software's uninstall rows included — into the CI log. The
 * DisplayName mixes simplified Chinese, traditional Chinese, and `é`, so the
 * raw `reg.exe` bytes keep at least one byte ≥ 0x80 on every realistic
 * runner locale (GBK/Big5 keep the CJK characters; CP437/850/1252 keep the
 * `é`); that byte is the precondition for the fallback to trigger at all. A
 * runner whose code page maps the entire name to `?` fails the precondition
 * test explicitly rather than skipping, so CI can never pass silently
 * without having exercised the fallback.
 *
 * "Root unreadable" (exit 3) and timeout classification stay covered by the
 * mocked `tests/windows-registry-tool.spec.ts`: constructing an unreadable
 * key on a shared runner would require ACL changes this suite must not make.
 *
 * Manual smoke for 0.7.3-rc acceptance on a real Windows machine, read-only
 * apart from the one test key above (no credentials involved): in this
 * checkout run
 *
 *   pnpm vitest run tests/windows-powershell-registry-integration.spec.ts
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WINDOWS_POWERSHELL_QUERY_COMMAND, workBuddyWindowsDiscoveryTools } from '../src/desktop-credential-protection.ts'

const IS_WINDOWS = process.platform === 'win32'
const SYSTEM_ROOT = IS_WINDOWS ? (process.env.SystemRoot?.trim() ?? '') : ''
const REG_EXE = join(SYSTEM_ROOT, 'System32', 'reg.exe')
/** The exact 5.1 interpreter path the production code resolves — never pwsh 7. */
const POWERSHELL_51_EXE = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const HKCU_UNINSTALL_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const TEST_SUBKEY_NAME = 'DSH_CI_REGRESSION_HOTFIX073'
const TEST_KEY = `${HKCU_UNINSTALL_ROOT}\\${TEST_SUBKEY_NAME}`
const ABSENT_KEY = `${HKCU_UNINSTALL_ROOT}\\${TEST_SUBKEY_NAME}_ABSENT`
/** Simplified + traditional Chinese plus `é`, so a non-ASCII byte survives any plausible runner code page. */
const TEST_DISPLAY_NAME = 'DSH CI 0.7.3 中文回歸測試 é'
const TEST_DISPLAY_ICON = 'C:\\中文測試路徑\\WorkBuddy.exe,0'
/** The three roots production queries; mirrors the module-private WINDOWS_REGISTRY_ROOTS. */
const PRODUCTION_ROOTS = [
  HKCU_UNINSTALL_ROOT,
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const
/** Fixed log labels for {@link PRODUCTION_ROOTS}: identifiers only, never registry content. */
const ROOT_LABELS = ['hkcu', 'hklm', 'wow6432node'] as const

/** One real subprocess run, captured without throwing; stdout/stderr stay bytes. */
interface RunResult {
  code: number
  killed: boolean
  stdout: Buffer
  stderr: Buffer
}

/**
 * Run one child to completion. A non-zero exit code is a result, not an
 * error; only spawn-level failures (missing binary, kill without a code,
 * maxBuffer exceeded) reject, so the test fails loudly instead of reading a
 * half-answer as data. Every call names its own timeout and maxBuffer.
 */
function run(bin: string, args: readonly string[], timeoutMs: number, maxBytes: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    execFile(bin, [...args], {
      timeout: timeoutMs,
      maxBuffer: maxBytes,
      windowsHide: true,
      encoding: 'buffer',
    }, (error, stdout, stderr) => {
      if (error === null || error === undefined) {
        resolve({ code: 0, killed: false, stdout, stderr })
        return
      }
      const raw = error.code
      if (raw === null || raw === undefined) {
        reject(error)
        return
      }
      const code = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(code)) {
        reject(error)
        return
      }
      resolve({ code, killed: error.killed === true, stdout: stdout ?? Buffer.alloc(0), stderr: stderr ?? Buffer.alloc(0) })
    })
  })
}

/** The missing-key diagnostic `reg.exe` itself emits, in either spelling; nothing else may count. */
const REG_KEY_MISSING = /unable to find the specified registry key|系统找不到指定的注册表项|系統找不到指定的登錄機碼/u

describe.skipIf(!IS_WINDOWS)('WINDOWS-ONLY real-process integration: PowerShell 5.1 -Command root binding (#105/#106/#107)', () => {
  beforeAll(async () => {
    // Real `reg add` through the real SystemRoot path: the current user's own
    // hive, one test key, force-overwrite so a leftover from an aborted run
    // cannot confuse this one. No admin rights, nothing else touched.
    const name = await run(REG_EXE, ['add', TEST_KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', TEST_DISPLAY_NAME, '/f'], 15_000, 64 * 1024)
    expect(name.code, 'creating the test DisplayName value must succeed').toBe(0)
    const icon = await run(REG_EXE, ['add', TEST_KEY, '/v', 'DisplayIcon', '/t', 'REG_SZ', '/d', TEST_DISPLAY_ICON, '/f'], 15_000, 64 * 1024)
    expect(icon.code, 'creating the test DisplayIcon value must succeed').toBe(0)
  }, 60_000)

  afterAll(async () => {
    // The one key this suite owns is removed no matter how the tests ended;
    // "already absent" also passes, anything else fails the suite.
    const deleted = await run(REG_EXE, ['delete', TEST_KEY, '/f'], 15_000, 64 * 1024)
    const alreadyAbsent = deleted.code === 1 && REG_KEY_MISSING.test(deleted.stderr.toString('utf8'))
    expect(deleted.code === 0 || alreadyAbsent, 'the test registry key must be deleted').toBe(true)
  }, 60_000)

  it('runs real Windows PowerShell 5.1 from the exact WindowsPowerShell\\v1.0 path', async () => {
    expect(POWERSHELL_51_EXE.endsWith('System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(true)
    const version = await run(POWERSHELL_51_EXE, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], 20_000, 64 * 1024)
    expect(version.code).toBe(0)
    expect(version.stdout.toString('utf8').trim().startsWith('5.'), 'the interpreter at the production path must be Windows PowerShell 5.x, not pwsh 7').toBe(true)
  }, 60_000)

  it('precondition: the raw reg.exe bytes for the root are non-ASCII, so the fallback must engage', async () => {
    const probe = await run(REG_EXE, ['query', HKCU_UNINSTALL_ROOT, '/s'], 20_000, 1024 * 1024)
    expect(probe.code, 'reg.exe must be able to read the HKCU uninstall root').toBe(0)
    // Byte presence only; the document itself (other software's rows) is
    // never printed. If every non-ASCII character came back as '?', the
    // code-page trap this suite exists for cannot be exercised — fail
    // loudly, never silently skip.
    expect(probe.stdout.some(byte => byte >= 0x80), 'the runner code page mapped the test entry to pure ASCII ("?"); the fallback path cannot be exercised on this runner').toBe(true)
  }, 60_000)

  it('queryUninstallRoot returns the Unicode entry through the real 5.1 fallback (GREEN)', async () => {
    const startedAt = Date.now()
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot(HKCU_UNINSTALL_ROOT, new AbortController().signal)
    // Wall time only (reg.exe + PowerShell fallback); no registry content.
    console.log(`windows registry hkcu fallback wall time: ${Date.now() - startedAt}ms`)
    // Boolean assertions: a failed toContain would print the whole document
    // into the log, other software's uninstall rows included.
    expect(output.includes(TEST_DISPLAY_NAME), 'the Unicode DisplayName must round-trip through the fallback JSON').toBe(true)
    expect(output.includes(TEST_DISPLAY_ICON), 'the Unicode DisplayIcon must round-trip through the fallback JSON').toBe(true)
    expect(output.includes('{PS-'), 'the document must be the fallback re-encoding, not raw reg.exe text').toBe(true)
    expect(output.includes(TEST_SUBKEY_NAME), 'raw reg.exe text names the real subkey in its headers; the fallback document must not').toBe(false)
    expect(output.includes('\uFFFD'), 'no replacement character may survive the fallback').toBe(false)
  }, 60_000)

  it('classifies the three production roots: readable resolves, absent resolves empty', async () => {
    // Each root's wall time is logged from a finally, so a mid-loop failure
    // (a step-budget timeout, say) still names the root that was in flight.
    // Fixed labels and milliseconds only, never registry content.
    for (const [index, root] of PRODUCTION_ROOTS.entries()) {
      const startedAt = Date.now()
      try {
        const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot(root, new AbortController().signal)
        expect(typeof output, `${root} must read as a document, not a failure`).toBe('string')
        if (root === HKCU_UNINSTALL_ROOT) {
          expect(output.includes(TEST_DISPLAY_NAME), 'the HKCU root carries the test entry').toBe(true)
        }
      } finally {
        console.log(`windows registry root ${ROOT_LABELS[index]} wall time: ${Date.now() - startedAt}ms`)
      }
    }
    const absentStartedAt = Date.now()
    try {
      const absent = await workBuddyWindowsDiscoveryTools().queryUninstallRoot(ABSENT_KEY, new AbortController().signal)
      expect(absent, 'a root that does not exist is an empty document, never a failure').toBe('')
    } finally {
      console.log(`windows registry root absent wall time: ${Date.now() - absentStartedAt}ms`)
    }
  }, 120_000)

  it('the production -Command argv returns the entry on real 5.1 (new argv GREEN)', async () => {
    // The exact argv production hands to execFile, replayed against the real
    // interpreter: same flags, same command text, same -Root position.
    const green = await run(POWERSHELL_51_EXE, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_POWERSHELL_QUERY_COMMAND, '-Root', HKCU_UNINSTALL_ROOT], 30_000, 1024 * 1024)
    expect(green.code, 'the wrapped command must exit 0 with -Root bound').toBe(0)
    let parsed: unknown
    try {
      parsed = JSON.parse(green.stdout.toString('utf8'))
    } catch {
      parsed = undefined
    }
    // `ConvertTo-Json` collapses a one-element array to a bare object.
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const found = rows.some(row => typeof row === 'object' && row !== null
      && (row as Record<string, unknown>)['displayName'] === TEST_DISPLAY_NAME
      && (row as Record<string, unknown>)['displayIcon'] === TEST_DISPLAY_ICON)
    expect(found, 'the exact Unicode DisplayName/DisplayIcon pair must come back from the real registry').toBe(true)
  }, 60_000)

  it('the 0.7.2 bare argv cannot return the entry on real 5.1 (old argv RED)', async () => {
    // The hotfix's only argv change is the `& { … }` wrapper, so removing it
    // from the production value reproduces exactly what 0.7.2 handed to
    // powershell.exe — derived from the real artifact, never re-typed by
    // hand. On 5.1 the trailing `-Root <path>` tokens then land inside the
    // script text, `$Root` stays empty, and no registry data comes back.
    expect(WINDOWS_POWERSHELL_QUERY_COMMAND.startsWith('& { ')).toBe(true)
    expect(WINDOWS_POWERSHELL_QUERY_COMMAND.endsWith(' }')).toBe(true)
    const bareCommand = WINDOWS_POWERSHELL_QUERY_COMMAND.slice(4, -2)
    const red = await run(POWERSHELL_51_EXE, ['-NoProfile', '-NonInteractive', '-Command', bareCommand, '-Root', HKCU_UNINSTALL_ROOT], 30_000, 1024 * 1024)
    const returnedEntry = red.code === 0 && red.stdout.toString('utf8').includes(TEST_DISPLAY_NAME)
    expect(returnedEntry, 'the pre-fix argv shape must fail to return the entry on real 5.1').toBe(false)
  }, 60_000)

  it('classifies an absent root as exit 2 with no stdout (production argv)', async () => {
    const absent = await run(POWERSHELL_51_EXE, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_POWERSHELL_QUERY_COMMAND, '-Root', ABSENT_KEY], 30_000, 64 * 1024)
    expect(absent.code, 'the script must report a missing root as exit 2, the code the caller reads as "absent"').toBe(2)
    expect(absent.stdout.length).toBe(0)
  }, 60_000)
})
