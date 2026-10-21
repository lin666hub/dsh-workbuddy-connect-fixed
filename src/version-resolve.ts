/**
 * Detect when the loaded build and the installed manifest disagree.
 *
 * `version.ts` carries a build-time constant injected by tsdown's `define`
 * from package.json. Every reported version — the update check, status,
 * the host heartbeat, doctor — keeps using that constant: it names the code
 * that is actually loaded.
 *
 * The manifest is read only to detect a split, which source checkouts produce
 * when package.json is bumped without rebuilding lib/. Issue #149 shows the
 * symptom: a 0.7.6 install rendering "当前 0.7.5". Reporting the manifest
 * version instead would hide exactly that situation — the update reminder
 * would call a stale build current — so the split is surfaced, not resolved
 * by preferring one side.
 *
 * @module dsh-workbuddy-connect/version-resolve
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'

/** The package name to look for while walking up from the module. */
const PACKAGE_NAME = 'dsh-workbuddy-connect'

/**
 * Read `package.json` walking up from one module URL.
 *
 * The package's exports map does not open `./package.json`, so the manifest
 * cannot be imported; the loaded file is walked up instead. That reads the
 * copy actually in use rather than a guess from the install tree, and shares
 * the approach `pi-ai-guard.ts` uses for the pi-ai copy.
 *
 * @param entryUrl - URL of a module inside the package (`import.meta.url` by default).
 * @returns The declared version, or undefined when no matching manifest is readable.
 */
export function resolvePackageVersion(entryUrl: string): string | undefined {
  let dir: string
  try {
    dir = dirname(fileURLToPath(entryUrl))
  } catch {
    return undefined
  }
  for (let step = 0; step < 5; step += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      if (manifest.name === PACKAGE_NAME && typeof manifest.version === 'string' && manifest.version !== '') {
        return manifest.version
      }
    } catch {
      // No manifest here, or not readable: keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Manifest version of the copy this module was loaded from, when readable. */
export const MANIFEST_VERSION: string | undefined = resolvePackageVersion(import.meta.url)

/** A loaded build whose manifest declares a different version. */
export interface VersionDrift {
  /** The build-time constant: the code that is actually running. */
  build: string
  /** The version its package.json declares. */
  manifest: string
}

/**
 * The split between the loaded build and its manifest, or undefined when
 * they agree (or the manifest cannot be read).
 *
 * @param manifest - Manifest version to compare; defaults to the loaded copy's.
 */
export function versionDrift(manifest: string | undefined = MANIFEST_VERSION): VersionDrift | undefined {
  if (manifest === undefined || manifest === WORKBUDDY_CONNECT_VERSION) return undefined
  return { build: WORKBUDDY_CONNECT_VERSION, manifest }
}

/**
 * One line describing a split build, or undefined when there is none.
 *
 * The build stays authoritative; this message only tells the operator that
 * the install's manifest moved ahead of the code, and what to do about it.
 *
 * @param drift - Split to describe; read from the loaded copy when omitted.
 */
export function versionDriftWarning(drift: VersionDrift | undefined = versionDrift()): string | undefined {
  if (drift === undefined) return undefined
  return `loaded build reports ${drift.build}, but its package.json says ${drift.manifest}. `
    + 'The build is behind the manifest — reinstall or rebuild the package, then fully quit and restart DSH.'
}
