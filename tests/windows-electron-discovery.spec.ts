import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultWorkBuddyElectronPath,
  electronDiscoveryFor,
  WorkBuddyAtRestKeyProvider,
  WORKBUDDY_ELECTRON_BIN_ENV,
  deriveProtectorKey,
  expandWindowsEnv,
  readWindowsRegistryUserEnv,
} from '../src/desktop-credential-protection.ts'
import type { WorkBuddyWindowsDiscoveryTools } from '../src/desktop-credential-protection.ts'
import { CN_VARIANT, AI_VARIANT , electronProfileFor} from '../src/variants.ts'
import { isolateProductEnv } from './helpers/product-env.ts'

const SECRET = Buffer.alloc(32, 9).toString('base64')
const PAYLOAD_TEXT = JSON.stringify({ version: 1, atRestSecretKey: SECRET })
const KEY = deriveProtectorKey(SECRET)
const KEY_ID = createHash('sha256').update(KEY).digest('hex').slice(0, 16)

let root: string

/**
 * A real machine may carry these variables (a developer box certainly can), and
 * the provider branches on *presence* (`varName in process.env`), so they must
 * be absent or blank for these tests to exercise the fallback.
 */
isolateProductEnv()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-windows-electron-discovery-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function windowsCandidate(name = 'WorkBuddy.exe', options: {
  version?: string
  appAsar?: boolean | 'directory'
  installRoot?: string
} = {}): Promise<string> {
  const installRoot = options.installRoot ?? join(root, name.replace(/\.exe$/iu, ''))
  const electronPath = join(installRoot, name)
  await mkdir(join(installRoot, 'resources'), { recursive: true })
  await writeFile(electronPath, '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(installRoot, 'version'), options.version ?? '37.10.3-24')
  if (options.appAsar === 'directory') await mkdir(join(installRoot, 'resources', 'app.asar'))
  else if (options.appAsar !== false) await writeFile(join(installRoot, 'resources', 'app.asar'), '')
  return electronPath
}

function registryOutput(entries: readonly { name: string, icon: string, installLocation?: string }[]): string {
  return entries.map((entry, index) => [
    `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{TEST-${String(index)}}`,
    `    DisplayName    REG_SZ    ${entry.name}`,
    `    DisplayIcon    REG_SZ    ${entry.icon}`,
    `    InstallLocation REG_SZ    ${entry.installLocation ?? ''}`,
    '    UninstallString REG_SZ    "C:\\Program Files\\WorkBuddy\\Uninstall WorkBuddy.exe" /currentuser',
  ].join('\r\n')).join('\r\n')
}

function fakeWindowsTools(
  output: string,
  options: { fail?: boolean, calls?: string[] } = {},
): WorkBuddyWindowsDiscoveryTools {
  return {
    queryUninstallRoot: async rootName => {
      options.calls?.push(rootName)
      if (options.fail === true) throw new Error('registry unavailable')
      return output
    },
  }
}

function provider(tools: WorkBuddyWindowsDiscoveryTools, defaultElectronPath = join(root, 'missing', 'WorkBuddy.exe')): WorkBuddyAtRestKeyProvider {
  return new WorkBuddyAtRestKeyProvider({
    product: electronProfileFor(CN_VARIANT),
    discovery: 'windows-workbuddy',
    platform: 'win32',
    defaultElectronPath,
    windowsTools: tools,
    spawnHelper: async () => PAYLOAD_TEXT,
  })
}

describe('issue #59/#60 discovery routing', () => {
  it('routes by platform for both products, and only to none where no layout is verified', () => {
    expect(electronDiscoveryFor('darwin')).toBe('macos-workbuddy')
    expect(electronDiscoveryFor('win32')).toBe('windows-workbuddy')
    expect(electronDiscoveryFor('linux')).toBe('none')
    expect(electronDiscoveryFor('freebsd')).toBe('none')
  })

  it('routes Linux to the existing unavailable path without discovery', async () => {
    const calls: string[] = []
    const keyProvider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: electronDiscoveryFor('linux'),
      platform: 'linux',
      windowsTools: fakeWindowsTools('', { calls }),
    })
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-unavailable' })
    expect(calls).toEqual([])
  })
})

describe('issue #59/#60 the international app on Windows', () => {
  function aiProvider(tools: WorkBuddyWindowsDiscoveryTools): WorkBuddyAtRestKeyProvider {
    return new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      windowsTools: tools,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
  }

  it('never inherits the CN default path, even when LOCALAPPDATA is set', async () => {
    // The AI default install location has never been measured, so the provider
    // must not fall for the one Windows default it does know — the CN one.
    vi.stubEnv('LOCALAPPDATA', root)
    const cnDefault = join(root, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')
    await mkdir(dirname(cnDefault), { recursive: true })
    await writeFile(cnDefault, '#!/bin/sh\n', { mode: 0o755 })
    expect(defaultWorkBuddyElectronPath(electronProfileFor(AI_VARIANT), 'win32')).toBeUndefined()
    const ai = await windowsCandidate('WorkBuddyAI.exe')
    const keyProvider = aiProvider(fakeWindowsTools(registryOutput([
      { name: 'WorkBuddy AI 5.6.2', icon: `"${ai},0"` },
      { name: 'WorkBuddy 5.6.2', icon: `"${cnDefault},0"` },
    ])))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(keyProvider.helperPath()).toBe(ai)
  })

  it('runs its own binary beside an installed CN app, with different keys per app', async () => {
    // Different payloads per binary: had the AI provider quietly spawned the
    // CN binary, its key would not answer the AI envelope's id. The identical
    // at-rest key both apps currently share would otherwise mask the mix-up.
    const aiSecret = Buffer.alloc(32, 3).toString('base64')
    const cnSecret = Buffer.alloc(32, 9).toString('base64')
    const aiKey = deriveProtectorKey(aiSecret)
    const aiKeyId = createHash('sha256').update(aiKey).digest('hex').slice(0, 16)
    const cn = await windowsCandidate('WorkBuddy.exe')
    const ai = await windowsCandidate('WorkBuddyAI.exe')
    const spawn = async (path: string): Promise<string> =>
      JSON.stringify({ version: 1, atRestSecretKey: path === ai ? aiSecret : cnSecret })
    const aiProviderWithSpawn = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      windowsTools: fakeWindowsTools(registryOutput([
        { name: 'WorkBuddy AI 5.6.2', icon: `"${ai},0"` },
        { name: 'WorkBuddy 5.6.2', icon: `"${cn},0"` },
      ])),
      spawnHelper: spawn,
    })
    await expect(aiProviderWithSpawn.protectorKeyFor([aiKeyId])).resolves.toEqual(aiKey)
    expect(aiProviderWithSpawn.helperPath()).toBe(ai)
    const cnProviderWithSpawn = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: join(root, 'missing', 'WorkBuddy.exe'),
      windowsTools: fakeWindowsTools(registryOutput([
        { name: 'WorkBuddy AI 5.6.2', icon: `"${ai},0"` },
        { name: 'WorkBuddy 5.6.2', icon: `"${cn},0"` },
      ])),
      spawnHelper: spawn,
    })
    const cnKey = deriveProtectorKey(cnSecret)
    const cnKeyId = createHash('sha256').update(cnKey).digest('hex').slice(0, 16)
    await expect(cnProviderWithSpawn.protectorKeyFor([cnKeyId])).resolves.toEqual(cnKey)
    expect(cnProviderWithSpawn.helperPath()).toBe(cn)
  })

  it('reads WORKBUDDY_AI_ELECTRON_BIN, never the CN variable', async () => {
    const ai = await windowsCandidate('WorkBuddyAI.exe')
    vi.stubEnv(WORKBUDDY_ELECTRON_BIN_ENV, ai)
    const viaDiscovery = aiProvider(fakeWindowsTools(registryOutput([
      { name: 'WorkBuddy AI 5.6.2', icon: `"${ai},0"` },
    ])))
    // The CN variable is not the AI product's configuration: without its own
    // variable the AI provider still resolves through discovery, never through
    // a value meant for the other product.
    await expect(viaDiscovery.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    // The env var is read at construction, so the provider is built after the
    // stub lands.
    vi.stubEnv(electronProfileFor(AI_VARIANT).envVar, ai)
    const direct = aiProvider(fakeWindowsTools('', { fail: true }))
    expect(direct.helperPath()).toBe(ai)
  })

  it('a broken CN record must not sink the AI search', async () => {
    const ai = await windowsCandidate('WorkBuddyAI.exe')
    // A CN entry whose DisplayIcon is malformed is the CN product's problem:
    // it is excluded by the AI pattern before the incompleteness judgement.
    const brokenCn = registryOutput([{ name: 'WorkBuddy', icon: '"unterminated/WorkBuddy.exe,0' }])
      .replace('{TEST-0}', '{TEST-CN}')
    const goodAi = registryOutput([{ name: 'WorkBuddy AI 5.6.2', icon: `"${ai},0"` }])
      .replace('{TEST-0}', '{TEST-AI}')
    const keyProvider = aiProvider(fakeWindowsTools(`${goodAi}\r\n${brokenCn}`))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
  })

  it('a broken AI record must not sink the CN search', async () => {
    const cn = await windowsCandidate('WorkBuddy.exe')
    // Mirror of the case above: the malformed entry matches the AI pattern
    // this time, and the CN discovery must exclude it as decisively not-ours.
    const brokenAi = registryOutput([{ name: 'WorkBuddy AI 5.6.2', icon: '"unterminated/WorkBuddyAI.exe,0' }])
      .replace('{TEST-0}', '{TEST-AI}')
    const goodCn = registryOutput([{ name: 'WorkBuddy 5.6.2', icon: `"${cn},0"` }])
      .replace('{TEST-0}', '{TEST-CN}')
    const keyProvider = provider(fakeWindowsTools(`${goodCn}\r\n${brokenAi}`))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
  })

  it('reports ambiguous for two AI installs, and not-found when only CN is installed', async () => {
    const first = await windowsCandidate('WorkBuddyAI.exe', { installRoot: join(root, 'AI-First') })
    const second = await windowsCandidate('WorkBuddyAI.exe', { installRoot: join(root, 'AI-Second') })
    const cn = await windowsCandidate('WorkBuddy.exe')
    const ambiguous = aiProvider(fakeWindowsTools(registryOutput([
      { name: 'WorkBuddy AI 5.6.2', icon: `"${first},0"` },
      { name: 'WorkBuddy AI', icon: `"${second},0"` },
    ])))
    await expect(ambiguous.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-ambiguous' })
    const onlyCn = aiProvider(fakeWindowsTools(registryOutput([
      { name: 'WorkBuddy 5.6.2', icon: `"${cn},0"` },
    ])))
    await expect(onlyCn.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
  })

  it('points its diagnostics at the AI variable', async () => {
    const keyProvider = aiProvider(fakeWindowsTools(''))
    const error = await keyProvider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect((error as Error).message).toContain('WorkBuddy AI')
    expect((error as Error).message).toContain('WORKBUDDY_AI_ELECTRON_BIN')
    expect((error as Error).message).not.toContain('WORKBUDDY_ELECTRON_BIN')
  })
})

describe('Windows default and registry discovery', () => {
  it('uses the LOCALAPPDATA default without querying the registry', async () => {
    vi.stubEnv('LOCALAPPDATA', root)
    const defaultPath = join(root, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')
    await mkdir(dirname(defaultPath), { recursive: true })
    await writeFile(defaultPath, '#!/bin/sh\n', { mode: 0o755 })
    const calls: string[] = []
    const keyProvider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      windowsTools: fakeWindowsTools('', { calls, fail: true }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(keyProvider.helperPath()).toBe(defaultPath)
    expect(calls).toEqual([])
  })

  it('does not guess a path when LOCALAPPDATA is missing', async () => {
    vi.stubEnv('LOCALAPPDATA', '')
    const calls: string[] = []
    const keyProvider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      windowsTools: fakeWindowsTools('', { calls }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
    expect(keyProvider.helperPath()).toBeUndefined()
    expect(calls).toHaveLength(3)
    expect((keyProvider.helperPath() ?? '')).not.toMatch(/Users|AppData/iu)
  })

  it('falls back to registry DisplayIcon after the default path fails', async () => {
    const candidate = await windowsCandidate()
    const tools = fakeWindowsTools(registryOutput([{ name: 'WorkBuddy 5.6.2', icon: `"${candidate},0"` }]))
    const keyProvider = provider(tools)
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(keyProvider.helperPath()).toBe(candidate)
  })

  it('accepts an app.asar that stats as a directory — the shape an Electron host reports (#66)', async () => {
    // Electron's asar interception makes fs.stat report app.asar as a
    // directory (isFile() false, size 0); the old isFile() layout check
    // excluded every registry candidate when the plugin itself ran inside
    // the DSH Desktop Electron host.
    const candidate = await windowsCandidate('WorkBuddy.exe', { appAsar: 'directory' })
    const keyProvider = provider(fakeWindowsTools(registryOutput([{ name: 'WorkBuddy', icon: `"${candidate},0"` }])))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(keyProvider.helperPath()).toBe(candidate)
  })

  it('ignores empty InstallLocation and uses a quoted DisplayIcon with an icon index', async () => {
    const candidate = await windowsCandidate()
    const keyProvider = provider(fakeWindowsTools(registryOutput([
      { name: 'WorkBuddy', icon: `"${candidate},12"`, installLocation: '' },
    ])))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(keyProvider.helperPath()).toBe(candidate)
  })

  it('accepts an unquoted DisplayIcon path containing spaces', async () => {
    const candidate = await windowsCandidate('WorkBuddy.exe', {
      installRoot: join(root, 'Program Files', 'WorkBuddy'),
    })
    const keyProvider = provider(fakeWindowsTools(registryOutput([
      { name: 'WorkBuddy', icon: `${candidate},0` },
    ])))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(keyProvider.helperPath()).toBe(candidate)
  })

  it('excludes WorkBuddy AI and non-primary RepairApp/Uninstall candidates', async () => {
    const ai = await windowsCandidate('WorkBuddy AI.exe')
    const repair = await windowsCandidate('RepairApp.exe')
    const uninstall = await windowsCandidate('Uninstall WorkBuddy.exe')
    const output = registryOutput([
      { name: 'WorkBuddy AI', icon: `"${ai},0"` },
      { name: 'WorkBuddy', icon: `"${repair},0"` },
      { name: 'WorkBuddy', icon: `"${uninstall},0"` },
    ])
    const keyProvider = provider(fakeWindowsTools(output))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
  })
})

describe('Windows candidate identity and failure semantics', () => {
  const invalidCandidates: readonly [string, { version?: string, appAsar?: boolean }, boolean][] = [
    ['missing version', {}, true],
    ['invalid version', { version: 'not-an-electron-version' }, false],
    ['missing resources/app.asar', { appAsar: false }, false],
  ]

  it.each(invalidCandidates)('rejects a candidate with %s', async (_label, options, removeVersion) => {
    const candidate = await windowsCandidate('WorkBuddy.exe', options)
    if (removeVersion) await rm(join(dirname(candidate), 'version'))
    const keyProvider = provider(fakeWindowsTools(registryOutput([{ name: 'WorkBuddy', icon: `"${candidate},0"` }])))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
  })

  it('reports rejected candidates by count, without echoing their local paths (#66)', async () => {
    const candidate = await windowsCandidate('WorkBuddy.exe', { installRoot: join(root, 'deep', 'secret-user-dir') , appAsar: false })
    const keyProvider = provider(fakeWindowsTools(registryOutput([{ name: 'WorkBuddy', icon: `"${candidate},0"` }])))
    const error = await keyProvider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ reasonCode: 'electron-binary-not-found' })
    expect((error as Error).message).toContain('found 1 WorkBuddy candidate')
    expect((error as Error).message).toContain('did not match the expected app layout')
    expect((error as Error).message).toContain('WORKBUDDY_ELECTRON_BIN')
    // The reason reaches /status and doctor; local install paths must not.
    expect((error as Error).message).not.toContain(candidate)
    expect((error as Error).message).not.toContain('secret-user-dir')
  })

  it('keeps the plain not-found wording when the registry held no candidates at all', async () => {
    const keyProvider = provider(fakeWindowsTools(''))
    const error = await keyProvider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect((error as Error).message).toContain('no usable WorkBuddy Electron binary was found in the default location or Windows uninstall records')
    expect((error as Error).message).not.toContain('did not match the expected app layout')
  })

  it('folds duplicate and realpath aliases into one candidate', async () => {
    const candidate = await windowsCandidate()
    const aliasRoot = join(root, 'Alias')
    await symlink(dirname(candidate), aliasRoot, 'junction')
    const alias = join(aliasRoot, 'WorkBuddy.exe')
    const output = registryOutput([
      { name: 'WorkBuddy', icon: `"${candidate},0"` },
      { name: 'WorkBuddy', icon: `"${alias},0"` },
    ])
    const keyProvider = provider(fakeWindowsTools(output))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
  })

  it('reports incomplete when a good candidate sits beside an unresolved registry candidate', async () => {
    const candidate = await windowsCandidate()
    const output = registryOutput([
      { name: 'WorkBuddy', icon: `"${candidate},0"` },
      { name: 'WorkBuddy', icon: '"\u0000uninspectable/WorkBuddy.exe,0"' },
    ])
    const keyProvider = provider(fakeWindowsTools(output))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-discovery-incomplete' })
  })

  it.each(['missing', 'malformed'])('reports incomplete when a matching registry entry has a %s DisplayIcon', async kind => {
    const good = await windowsCandidate()
    const goodEntry = registryOutput([{ name: 'WorkBuddy', icon: `"${good},0"` }])
    const brokenEntry = kind === 'missing'
      ? registryOutput([{ name: 'WorkBuddy', icon: '' }]).replace(/^    DisplayIcon.*\r?\n/gmu, '')
      : registryOutput([{ name: 'WorkBuddy', icon: '"unterminated/WorkBuddy.exe,0' }])
    const keyProvider = provider(fakeWindowsTools(`${goodEntry}\r\n${brokenEntry.replace('{TEST-0}', '{TEST-1}')}`))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-discovery-incomplete' })
  })

  it('reports incomplete for registry failures instead of not-found', async () => {
    const keyProvider = provider(fakeWindowsTools('', { fail: true }))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-discovery-incomplete' })
  })

  it('reports incomplete when a registry query times out', async () => {
    let first = true
    const tools: WorkBuddyWindowsDiscoveryTools = {
      queryUninstallRoot: async (_rootName, signal) => {
        if (!first) return ''
        first = false
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('timed out')) }, { once: true })
        })
        return ''
      },
    }
    const keyProvider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: join(root, 'missing', 'WorkBuddy.exe'),
      windowsTools: tools,
      discoveryBudgetMs: 10,
    })
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-discovery-incomplete' })
  })

  it('reports not-found after all registry roots complete with no legal candidate', async () => {
    const keyProvider = provider(fakeWindowsTools(''))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
  })

  it('reports ambiguous when two legal candidates remain', async () => {
    // Build two legal roots with the exact basename required by the candidate
    // validator; the registry strings exercise independent install roots.
    const firstRoot = join(root, 'First')
    const secondRoot = join(root, 'Second')
    await mkdir(join(firstRoot, 'resources'), { recursive: true })
    await mkdir(join(secondRoot, 'resources'), { recursive: true })
    await writeFile(join(firstRoot, 'WorkBuddy.exe'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(join(secondRoot, 'WorkBuddy.exe'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(join(firstRoot, 'version'), '37.10.3-24')
    await writeFile(join(secondRoot, 'version'), '37.10.3-24')
    await writeFile(join(firstRoot, 'resources', 'app.asar'), '')
    await writeFile(join(secondRoot, 'resources', 'app.asar'), '')
    const legalOutput = registryOutput([
      { name: 'WorkBuddy', icon: `"${join(firstRoot, 'WorkBuddy.exe')},0"` },
      { name: 'WorkBuddy', icon: `"${join(secondRoot, 'WorkBuddy.exe')},0"` },
    ])
    const keyProvider = provider(fakeWindowsTools(legalOutput))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-ambiguous' })
  })
})

describe('Windows priority, cache, and explicit paths', () => {
  it('does not fall back after an explicit option or env path fails', async () => {
    const candidate = await windowsCandidate()
    const calls: string[] = []
    const tools = fakeWindowsTools(registryOutput([{ name: 'WorkBuddy', icon: `"${candidate},0"` }]), { calls })
    const optionProvider = new WorkBuddyAtRestKeyProvider({
      electronPath: join(root, 'missing-option.exe'),
      product: electronProfileFor(CN_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: candidate,
      windowsTools: tools,
    })
    await expect(optionProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-path-invalid' })

    vi.stubEnv(WORKBUDDY_ELECTRON_BIN_ENV, join(root, 'missing-env.exe'))
    const envProvider = provider(tools, candidate)
    await expect(envProvider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-path-invalid' })
    expect(calls).toEqual([])
  })

  it('caches a successful discovery and re-discovers after the path disappears', async () => {
    const candidate = await windowsCandidate()
    const calls: string[] = []
    const keyProvider = provider(fakeWindowsTools(registryOutput([{ name: 'WorkBuddy', icon: `"${candidate},0"` }]), { calls }))
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(calls).toHaveLength(3)
    await rm(candidate)
    await expect(keyProvider.protectorKeyFor(['ffffffffffffffff'])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
    expect(calls).toHaveLength(6)
  })
})

describe('Windows user registry environment fallback', () => {

  it.each(['', '  \t  '])('treats process.env value %j as unset and reads the registry', async value => {
    const candidate = await windowsCandidate('WorkBuddyAI.exe')
    vi.stubEnv(electronProfileFor(AI_VARIANT).envVar, value)
    const reader = vi.fn(() => candidate)
    const keyProvider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT), platform: 'win32', discovery: 'windows-workbuddy',
      defaultElectronPath: undefined, readWindowsUserEnv: reader, spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(reader).toHaveBeenCalledTimes(1)
    expect(keyProvider.helperPath()).toBe(candidate)
  })

  it('uses the default path when the registry has no configuration', async () => {
    const defaultPath = await windowsCandidate('DefaultWorkBuddy.exe')
    const reader = vi.fn(() => undefined)
    const keyProvider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT), platform: 'win32', discovery: 'windows-workbuddy',
      defaultElectronPath: defaultPath, readWindowsUserEnv: reader, spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(keyProvider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(reader).toHaveBeenCalledTimes(1)
    expect(keyProvider.helperPath()).toBe(defaultPath)
  })

  it('reads the explicit variable from readWindowsUserEnv when process.env lacks it', async () => {
    const candidate = await windowsCandidate('WorkBuddyAI.exe')
    const calls: string[] = []
    const tools = fakeWindowsTools(registryOutput([{ name: 'WorkBuddy AI', icon: `"${candidate},0"` }]), { calls })
    const userEnvReader = vi.fn((varName: string) => varName === 'WORKBUDDY_AI_ELECTRON_BIN' ? candidate : undefined)
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: undefined,
      windowsTools: tools,
      readWindowsUserEnv: userEnvReader,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    expect(provider.helperPath()).toBeUndefined()
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(provider.helperPath()).toBe(candidate)
    expect(userEnvReader).toHaveBeenCalledWith('WORKBUDDY_AI_ELECTRON_BIN')
    expect(calls).toEqual([])
  })

  it('rejects with electron-path-invalid when readWindowsUserEnv points to a missing binary', async () => {
    const userEnvReader = vi.fn((varName: string) => varName === 'WORKBUDDY_AI_ELECTRON_BIN' ? join(root, 'non-existent.exe') : undefined)
    const defaultPath = await windowsCandidate('Default.exe')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: defaultPath,
      readWindowsUserEnv: userEnvReader,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-path-invalid' })
  })

  it('prefers process.env over readWindowsUserEnv when process.env is set', async () => {
    const fromEnv = await windowsCandidate('FromEnv.exe')
    const fromReg = await windowsCandidate('FromReg.exe')
    vi.stubEnv(electronProfileFor(AI_VARIANT).envVar, fromEnv)
    const userEnvReader = vi.fn(() => fromReg)
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      readWindowsUserEnv: userEnvReader,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    expect(provider.helperPath()).toBe(fromEnv)
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(userEnvReader).not.toHaveBeenCalled()
  })

  it('prefers the registry configuration over a usable default path', async () => {
    const defaultPath = await windowsCandidate('DefaultWorkBuddy.exe')
    const registryPath = await windowsCandidate('RegistryWorkBuddy.exe')
    const userEnvReader = vi.fn(() => registryPath)
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: defaultPath,
      readWindowsUserEnv: userEnvReader,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(provider.helperPath()).toBe(registryPath)
    expect(userEnvReader).toHaveBeenCalledTimes(1)
  })

  it('caches the registry user env lookup across resolutions', async () => {
    const candidate = await windowsCandidate('WorkBuddyAI.exe')
    const userEnvReader = vi.fn(async () => candidate)
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: undefined,
      readWindowsUserEnv: userEnvReader,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    // A second, *different* key id forces a full re-resolution: the key cache
    // cannot answer it, so the only way this call can avoid a second registry
    // read is the user-env cache itself. Repeating the same key id would have
    // returned from the key cache and proved nothing about this cache.
    await expect(provider.protectorKeyFor(['ffffffffffffffff']))
      .rejects.toMatchObject({ reasonCode: 'encrypted-credential-unreadable' })
    expect(userEnvReader).toHaveBeenCalledTimes(1)
  })

  it('re-reads the user env after a miss, so setting the variable is picked up without a restart', async () => {
    // The case the whole fallback exists for: the first attempt finds nothing
    // (the user has not configured the variable yet), the card shows the
    // diagnostic, the user adds it in System Properties, and the retry must
    // succeed. A cached `undefined` would pin the failure until DSH restarts.
    const candidate = await windowsCandidate('WorkBuddyAI.exe')
    let configured: string | undefined
    const userEnvReader = vi.fn(() => configured)
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: undefined,
      // No uninstall record either, so the first attempt has nothing to find.
      windowsTools: fakeWindowsTools(''),
      readWindowsUserEnv: userEnvReader,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    // First attempt: the variable does not exist yet, and the uninstall sweep
    // finds nothing either — a diagnosable failure, not a crash.
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
    expect(userEnvReader).toHaveBeenCalledTimes(1)
    expect(provider.helperPath()).toBeUndefined()

    // The user configures the variable; the retry must consult the registry
    // again and use the new value instead of the remembered miss.
    configured = candidate
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(userEnvReader).toHaveBeenCalledTimes(2)
    expect(provider.helperPath()).toBe(candidate)
  })

  it('keeps consulting the registry while the variable stays unset', async () => {
    const userEnvReader = vi.fn(() => undefined)
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: undefined,
      windowsTools: fakeWindowsTools(''),
      readWindowsUserEnv: userEnvReader,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toMatchObject({ reasonCode: 'electron-binary-not-found' })
    expect(userEnvReader).toHaveBeenCalledTimes(2)
  })

  it('treats a blank user env value as unset rather than as an empty path', async () => {
    const candidate = await windowsCandidate('WorkBuddyAI.exe')
    const userEnvReader = vi.fn(() => '   ')
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: undefined,
      windowsTools: fakeWindowsTools(registryOutput([{ name: 'WorkBuddy AI', icon: `"${candidate},0"` }])),
      readWindowsUserEnv: userEnvReader,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    // Blank means "not configured", so the uninstall sweep still runs and wins
    // — it must not be reported as an invalid configured path.
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(provider.helperPath()).toBe(candidate)
  })

  it('falls through to discovery when the registry reader itself fails', async () => {
    const candidate = await windowsCandidate('WorkBuddyAI.exe')
    const userEnvReader = vi.fn(() => { throw new Error('reg.exe is unavailable') })
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: undefined,
      windowsTools: fakeWindowsTools(registryOutput([{ name: 'WorkBuddy AI', icon: `"${candidate},0"` }])),
      readWindowsUserEnv: userEnvReader,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(provider.helperPath()).toBe(candidate)
  })

  it('lets the user env override a path discovery settled on earlier', async () => {
    // The support boundary the review asked about: an explicit choice must
    // not be silently outranked by this plugin's own earlier guess.
    const discovered = await windowsCandidate('WorkBuddyAI.exe')
    const explicit = await windowsCandidate('WorkBuddyAIMoved.exe', { installRoot: join(root, 'Moved') })
    let configured: string | undefined
    const userEnvReader = vi.fn(() => configured)
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: undefined,
      windowsTools: fakeWindowsTools(registryOutput([{ name: 'WorkBuddy AI', icon: `"${discovered},0"` }])),
      readWindowsUserEnv: userEnvReader,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    // Nothing configured yet: the uninstall sweep settles on the discovered app.
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    expect(provider.helperPath()).toBe(discovered)

    // The user then names a different binary; the next resolution must honour
    // it rather than keep serving the remembered discovery result.
    configured = explicit
    await expect(provider.protectorKeyFor(['ffffffffffffffff']))
      .rejects.toMatchObject({ reasonCode: 'encrypted-credential-unreadable' })
    expect(provider.helperPath()).toBe(explicit)
  })

  it('forgets a cached user env value whose binary has since disappeared', async () => {
    const candidate = await windowsCandidate('WorkBuddyAI.exe')
    const replacement = await windowsCandidate('WorkBuddyAI.exe', { installRoot: join(root, 'Replacement') })
    let current = candidate
    const userEnvReader = vi.fn(() => current)
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(AI_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'win32',
      defaultElectronPath: undefined,
      windowsTools: fakeWindowsTools(''),
      readWindowsUserEnv: userEnvReader,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toEqual(KEY)
    await rm(candidate)
    current = replacement
    // The stale cached value is re-checked before it is believed: it is gone,
    // so the reader runs again and the new value is adopted.
    await expect(provider.protectorKeyFor(['ffffffffffffffff']))
      .rejects.toMatchObject({ reasonCode: 'encrypted-credential-unreadable' })
    expect(userEnvReader).toHaveBeenCalledTimes(2)
    expect(provider.helperPath()).toBe(replacement)
  })
})

describe('readWindowsRegistryUserEnv and expandWindowsEnv', () => {
  it('expands Windows environment variables case-insensitively', () => {
    expect(expandWindowsEnv('%USERPROFILE%\\Programs\\app.exe', { USERPROFILE: 'C:\\Users\\Alice' }))
      .toBe('C:\\Users\\Alice\\Programs\\app.exe')
    expect(expandWindowsEnv('%localappdata%\\Programs\\app.exe', { LOCALAPPDATA: 'D:\\AppData' }))
      .toBe('D:\\AppData\\Programs\\app.exe')
    expect(expandWindowsEnv('%UNKNOWN%\\app.exe', {})).toBe('%UNKNOWN%\\app.exe')
  })

  it('reads UTF-8 REG_SZ values from HKCU\\Environment', async () => {
    const output = Buffer.from('\r\nHKEY_CURRENT_USER\\Environment\r\n    TEST_BIN    REG_SZ    C:\\WorkBuddy\\WorkBuddy.exe\r\n', 'utf8')
    const exec = vi.fn(async () => output)
    const res = await readWindowsRegistryUserEnv('TEST_BIN', {
      systemRoot: 'C:\\Windows',
      exec,
    })
    expect(res).toBe('C:\\WorkBuddy\\WorkBuddy.exe')
    expect(exec).toHaveBeenCalledWith(
      // Backslashes on every host: this is a Windows path handed to execFile,
      // not a filesystem path the test host would resolve.
      'C:\\Windows\\System32\\reg.exe',
      ['query', 'HKCU\\Environment', '/v', 'TEST_BIN'],
      expect.objectContaining({ timeout: 1500 }),
    )
  })

  it('decodes GBK-encoded non-ASCII registry output (Chinese path)', async () => {
    // GBK-encoded bytes for "C:\Users\张三\WorkBuddy.exe"
    // "张" in GBK: 0xD5 0xC5; "三" in GBK: 0xC8 0xFD
    const header = Buffer.from('\r\nHKEY_CURRENT_USER\\Environment\r\n    WORKBUDDY_AI_BIN    REG_SZ    C:\\Users\\', 'ascii')
    const gbkChars = Buffer.from([0xd5, 0xc5, 0xc8, 0xfd])
    const tail = Buffer.from('\\WorkBuddy.exe\r\n', 'ascii')
    const gbkOutput = Buffer.concat([header, gbkChars, tail])

    const res = await readWindowsRegistryUserEnv('WORKBUDDY_AI_BIN', {
      systemRoot: 'C:\\Windows',
      exec: async () => gbkOutput,
    })
    expect(res).toBe('C:\\Users\\张三\\WorkBuddy.exe')
  })

  it('expands REG_EXPAND_SZ values using environment variables', async () => {
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\Bob\\AppData\\Local')
    const output = Buffer.from('\r\nHKEY_CURRENT_USER\\Environment\r\n    EXPAND_BIN    REG_EXPAND_SZ    %LOCALAPPDATA%\\Programs\\WorkBuddy.exe\r\n', 'utf8')
    const res = await readWindowsRegistryUserEnv('EXPAND_BIN', {
      systemRoot: 'C:\\Windows',
      exec: async () => output,
    })
    expect(res).toBe('C:\\Users\\Bob\\AppData\\Local\\Programs\\WorkBuddy.exe')
  })

  it('falls back to HKLM when HKCU does not contain the variable', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args[1] === 'HKCU\\Environment') {
        throw new Error('ERROR: The system was unable to find the specified registry key or value.')
      }
      return Buffer.from('\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    SYSTEM_BIN    REG_SZ    C:\\System\\WorkBuddy.exe\r\n')
    })
    const res = await readWindowsRegistryUserEnv('SYSTEM_BIN', {
      systemRoot: 'C:\\Windows',
      exec,
    })
    expect(res).toBe('C:\\System\\WorkBuddy.exe')
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('returns undefined when reg.exe query fails or times out', async () => {
    const res = await readWindowsRegistryUserEnv('MISSING_BIN', {
      systemRoot: 'C:\\Windows',
      exec: async () => { throw new Error('reg command timed out') },
    })
    expect(res).toBeUndefined()
  })

  it('returns undefined when SystemRoot is missing', async () => {
    const exec = vi.fn()
    const res = await readWindowsRegistryUserEnv('ANY_BIN', {
      systemRoot: '',
      exec,
    })
    expect(res).toBeUndefined()
    expect(exec).not.toHaveBeenCalled()
  })
})
