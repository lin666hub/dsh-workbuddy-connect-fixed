import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime, { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.ts'
import { LegacySettingsService } from './helpers/legacy-settings.ts'

/**
 * Plugin-to-runtime wiring for `retryPolicy`.
 *
 * The schema test only proves the config parses and the adapter test only
 * proves a handed-in policy is served. What a user actually gets depends on the
 * middle: `apply()` must resolve the plugin config once and hand the result to
 * BOTH registered routes. So this boots the real plugin and reads the policy
 * back off the LLM runtime, which is where the retry plugin will look for it.
 */

/** In-memory legacy settings: the 0.1.5/0.1.6 section API this plugin drives. */
class MemorySettings extends LegacySettingsService {
  constructor() {
    super({
      read: () => ({}),
      persist: () => Promise.resolve(),
    })
  }
}

/** The only `webServer` surface the plugin needs at load: route registration. */
class FakeWebServer extends Service {
  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(): () => void {
    return () => {}
  }
}

const CLEANUP: (() => Promise<void>)[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dispose of CLEANUP.splice(0)) await dispose()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-retry-'))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** Boot the plugin exactly as the host does, with no credentials present. */
async function boot(config: WorkBuddy.Config): Promise<Context> {
  const root = await tempDir()
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
  vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent-ai.info'))
  // Nothing here is signed in, so no catalog request is due; a stub keeps a
  // stray sweep from reaching the real network.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline test') }))

  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  ctx.provide('settings', new MemorySettings())
  await ctx.plugin(FakeWebServer)
  await ctx.plugin(WorkBuddy, config)
  await vi.waitFor(() => {
    expect(ctx.llm.listProviders().map(provider => provider.id))
      .toEqual(expect.arrayContaining([WorkBuddy.CN_VARIANT.id, WorkBuddy.AI_VARIANT.id]))
  })
  return ctx
}

describe('retryPolicy reaches both registered routes', () => {
  it('serves the configured policy from both providers', async () => {
    const retryPolicy = {
      mode: 'normal' as const,
      maxRetries: 15,
      backoff: { initialDelayMs: 2_000, maxDelayMs: 30_000 },
    }
    const ctx = await boot({ retryPolicy })
    const expected = resolveRetryPolicy(retryPolicy, 'dsh-workbuddy-connect retryPolicy')

    for (const id of [WorkBuddy.CN_VARIANT.id, WorkBuddy.AI_VARIANT.id]) {
      // Read through the runtime, not the adapter: this is the value the
      // dsh-llm-retry plugin would execute for a failed step.
      expect(ctx.llm.providerRetryPolicy(id)).toEqual(expected)
    }
  })

  it('keeps the dsh-llm normal defaults when the config omits the policy', async () => {
    const ctx = await boot({})
    const defaults = resolveRetryPolicy(undefined, 'dsh-workbuddy-connect retryPolicy')

    for (const id of [WorkBuddy.CN_VARIANT.id, WorkBuddy.AI_VARIANT.id]) {
      expect(ctx.llm.providerRetryPolicy(id)).toEqual(defaults)
    }
    // The defaults are a bounded, transient-only policy — the unbounded
    // `always` mode must never be what an unconfigured install silently picks.
    expect(defaults.mode).toBe('normal')
  })
})
