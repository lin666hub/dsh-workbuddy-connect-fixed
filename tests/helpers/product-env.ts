/**
 * Test isolation for the two product env variables that steer Electron
 * discovery.
 *
 * `WorkBuddyAtRestKeyProvider` branches on the *presence* of its product's
 * variable (`envVar in process.env`), not on its value: an explicit path
 * short-circuits discovery entirely, and a present-but-blank value still
 * suppresses the Windows user-environment fallback. A developer machine or a
 * CI runner that legitimately carries `WORKBUDDY_AI_ELECTRON_BIN` therefore
 * changes what these tests exercise — the suite fails on the maintainer's own
 * box while passing on a clean runner, which is the worst possible signal.
 *
 * `vi.stubEnv` cannot express "absent" (it can only set a value), so this
 * helper deletes the variables around each test and restores exactly what was
 * there afterwards.
 */
import { afterEach, beforeEach } from 'vitest'

/** The variables `electronProfileFor` puts on each variant. */
export const PRODUCT_ENV_VARS = ['WORKBUDDY_ELECTRON_BIN', 'WORKBUDDY_AI_ELECTRON_BIN'] as const

/**
 * Delete both product variables for every test in the calling file, restoring
 * the inherited values afterwards. Call once at file scope, beside the
 * existing `beforeEach`/`afterEach`.
 */
export function isolateProductEnv(): void {
  let saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    saved = Object.fromEntries(PRODUCT_ENV_VARS.map(name => [name, process.env[name]]))
    for (const name of PRODUCT_ENV_VARS) delete process.env[name]
  })
  afterEach(() => {
    for (const name of PRODUCT_ENV_VARS) {
      const value = saved[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    saved = {}
  })
}
