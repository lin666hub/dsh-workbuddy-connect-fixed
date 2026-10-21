import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePackageVersion, versionDrift, versionDriftWarning } from '../src/version-resolve.ts'
import { WORKBUDDY_CONNECT_VERSION } from '../src/version.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Build `<root>/<...dirs>/lib/index.js` with an optional manifest above it. */
function fakePackage(manifest: unknown | undefined, dirs: string[] = ['lib']): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-version-'))
  roots.push(root)
  mkdirSync(join(root, ...dirs), { recursive: true })
  if (manifest !== undefined) {
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest), 'utf8')
  }
  const entry = join(root, ...dirs, 'index.js')
  writeFileSync(entry, '', 'utf8')
  return pathToFileURL(entry).href
}

describe('resolvePackageVersion', () => {
  it('reads the manifest of the copy the module was loaded from', () => {
    const url = fakePackage({ name: 'dsh-workbuddy-connect', version: '9.9.9' })
    expect(resolvePackageVersion(url)).toBe('9.9.9')
  })

  it('ignores a manifest for another package', () => {
    const url = fakePackage({ name: 'something-else', version: '1.2.3' })
    expect(resolvePackageVersion(url)).toBeUndefined()
  })

  it('returns undefined when no manifest is reachable', () => {
    const url = fakePackage(undefined)
    expect(resolvePackageVersion(url)).toBeUndefined()
  })

  it('returns undefined for a malformed module URL instead of throwing', () => {
    expect(resolvePackageVersion('not a url')).toBeUndefined()
  })
})

describe('versionDrift', () => {
  it('reports nothing when the manifest matches the loaded build', () => {
    expect(versionDrift(WORKBUDDY_CONNECT_VERSION)).toBeUndefined()
  })

  it('reports nothing when the manifest could not be read', () => {
    expect(versionDrift(undefined)).toBeUndefined()
  })

  it('reports both versions when the manifest moved ahead of the build', () => {
    expect(versionDrift('9.9.9')).toEqual({ build: WORKBUDDY_CONNECT_VERSION, manifest: '9.9.9' })
  })

  it('keeps the build as the reported side, never the manifest', () => {
    const drift = versionDrift('9.9.9')
    expect(drift?.build).toBe(WORKBUDDY_CONNECT_VERSION)
  })
})

describe('versionDriftWarning', () => {
  it('stays quiet without a split', () => {
    expect(versionDriftWarning(undefined)).toBeUndefined()
  })

  it('names both versions and the recovery step', () => {
    const message = versionDriftWarning({ build: '1.2.3', manifest: '9.9.9' })
    expect(message).toContain('1.2.3')
    expect(message).toContain('9.9.9')
    expect(message).toContain('restart DSH')
  })
})
