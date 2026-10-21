import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.ts'

/**
 * `sessionProjections` is a host service (dsh-session-projection), not part of
 * the cordis core types this package depends on. Declaring it here keeps the
 * test type-honest instead of scattering `as never` casts: the only shape this
 * suite relies on is a `register()` the consumer calls.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjections: { register(unit: { key: string }): void }
  }
}

/**
 * Issue #116, phase-1 evidence — *scoped negatively*, with real fiber identity.
 *
 * The reporter's error string,
 *
 *   cannot get required service "sessionProjections" in inactive context
 *
 * is thrown by cordis (`lib/index.js`, the `internal/get` waterfall) when a
 * context whose `inject` declared that service is resolved after its owning
 * fiber is no longer active.
 *
 * FIBER IDENTITY — the trap this file previously fell into. In cordis:
 *
 *   - `ctx.extend({})` does NOT create a fiber. It is `Object.create` over the
 *     parent context (cordis `extend()`), so the returned context's `.fiber` IS
 *     the parent's fiber. Disposing `extended.fiber` disposes the *root*, and
 *     reading `extended.sessionProjections` afterwards proves nothing about a
 *     child fiber.
 *   - `ctx.inject(deps, cb)` DOES create a real child fiber: it delegates to
 *     `plugin()`, which returns `new Fiber(...)`. Its prototype carries the
 *     genuine `Fiber` (with `parent`, `uid`, `state`, `dispose`), and the
 *     scoped context handed to `cb` has `.fiber` equal to that same fiber.
 *
 * Every assertion below therefore captures the scoped context from inside the
 * inject callback AND the true fiber from the inject return value, and asserts
 * they are the same fiber before using it. Anything that only reads a service
 * off the root would be vacuous.
 *
 * ROOT LIVENESS — what does NOT work. Measuring it: after disposing the root
 * fiber, a previously captured root-fiber handle still reports `uid === 0` and
 * `state === 2`, and `assertActive()` still passes; `ctx.sessionProjections`,
 * `ctx.emit(...)` and a fresh `ctx.inject(...)` all still appear to work. So
 * none of those can show "the root survived". The discriminator used below is
 * an independent sibling fiber's registered `effect` disposer: disposing the
 * root tears it down (`true`), disposing only the consumer's child fiber
 * leaves it intact (`false`).
 *
 * What this suite establishes (and nothing more):
 *
 *   1. The failure mode is reachable: disposing the consumer's *own* child
 *      fiber makes its captured scoped context throw the reporter's exact
 *      string, while the root fiber stays alive and still able to run plugins.
 *   2. Registered adapters plus repeated model-list reads — and a controlled
 *      `llm/adapters-updated` emission — do not deactivate the consumer fiber.
 *
 * What it does NOT establish: any reproduction of a provider/session switch
 * (no session controller, no `model/selection`, no session projection, no tool
 * dispatch), any root-cause attribution for #116, or anything about the
 * reporter's 0.2.0-rc.2 desktop profile.
 */

let context: Context | undefined
let root: string | undefined

function credentialDocument(domain: string): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain },
    account: { uid: 'uid-1', nickname: 'nick' },
  })
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** A minimal stand-in for the host's projection registry service. */
function projectionsDouble() {
  const registered: string[] = []
  return {
    service: { register: (unit: { key: string }) => { registered.push(unit.key) } },
    registered,
  }
}

/** Live tally of `llm/adapters-updated`, read through a getter (not a snapshot). */
interface EventTally {
  readonly count: number
}

/**
 * One injected consumer: the scoped context the callback received, and the
 * genuine fiber that `inject()` created to own it.
 */
interface Consumer {
  /** The context handed to the inject callback — what a real consumer holds. */
  scoped: Context
  /** The real child fiber (`inject()` → `plugin()` → `new Fiber`). */
  fiber: Fiber
  /** How many times the inject callback ran; proves it actually ran. */
  registrations: number
}

/**
 * Load one consumer plugin through `inject()`, capturing both the scoped
 * context and the true fiber, and asserting the two agree. Shared by the
 * control and the negative cases so they exercise the same shape.
 */
async function injectConsumer(parent: Context): Promise<Consumer> {
  let scoped: Context | undefined
  let registrations = 0
  const returned = parent.inject(['sessionProjections'], (scopedCtx) => {
    scopedCtx.sessionProjections.register({ key: 'modelSelection' })
    registrations += 1
    scoped = scopedCtx
  })

  // `inject()` returns a fiber-shaped promise wrapper; the actual Fiber is its
  // prototype (cordis `plugin()` does `Object.create(fiber)` before attaching
  // `then`, so the bare fiber is one hop away and is NOT the root's).
  const fiber = Object.getPrototypeOf(returned) as Fiber
  await (returned as unknown as Promise<unknown>)

  expect(scoped).toBeDefined()
  expect(registrations).toBe(1)
  // The identity that matters: the scoped context belongs to THIS fiber.
  expect((scoped as unknown as { fiber: Fiber }).fiber).toBe(fiber)
  expect(typeof fiber.dispose).toBe('function')
  return { scoped: scoped as Context, fiber, registrations }
}

interface Harness {
  ctx: Context
  consumer: Consumer
  /** Read by getter: a captured number would make later assertions tautological. */
  updates: EventTally
}

/**
 * Boot a real host: real cordis Context, real dsh-llm runtime, real plugin,
 * plus one consumer fiber shaped like the session controller.
 */
async function boot(): Promise<Harness> {
  root = await mkdtemp(join(tmpdir(), 'workbuddy-116-'))
  const cnFile = join(root, 'cn.info')
  await writeFile(cnFile, credentialDocument('copilot.tencent.com'))
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))

  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)

  ctx.provide('sessionProjections', projectionsDouble().service)

  const tally = { count: 0 }
  ctx.on('llm/adapters-updated', () => { tally.count += 1 })

  // Created before the plugin loads, mirroring a session controller that was
  // already running when a WorkBuddy adapter appeared.
  const consumer = await injectConsumer(ctx)

  await ctx.plugin(WorkBuddy, {})
  await vi.waitFor(async () => {
    expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
  })

  return { ctx, consumer, updates: tally }
}

describe('#116 phase 1: observed plugin behaviour toward an injected projection consumer', () => {
  it('control: the consumer owns its own fiber, distinct from the root', async () => {
    const ctx = new Context()
    context = ctx // tracked so afterEach disposes this control's root too
    await ctx.plugin(LlmRuntime)
    ctx.provide('sessionProjections', { register: () => {} })

    const { scoped, fiber, registrations } = await injectConsumer(ctx)

    // The identity claims every other assertion rests on.
    expect(fiber).not.toBe(ctx.fiber)
    expect(fiber.parent).toBe(ctx)
    expect(fiber.uid).not.toBe(0) // 0 is the root fiber's uid
    expect(registrations).toBe(1)

    // Contrast, so the trap stays documented and would fail loudly if a future
    // edit swapped `inject()` back for `extend()`: `extend()` carries the
    // PARENT's fiber, not a new one.
    const extended = ctx.extend({})
    expect((extended as unknown as { fiber: Fiber }).fiber).toBe(ctx.fiber)

    expect(() => scoped.sessionProjections).not.toThrow()
  })

  it('control: disposing that fiber breaks its scoped context while the root lives on', async () => {
    const ctx = new Context()
    context = ctx // tracked so afterEach disposes this control's root too
    await ctx.plugin(LlmRuntime)
    ctx.provide('sessionProjections', { register: () => {} })
    const { scoped, fiber } = await injectConsumer(ctx)

    // An INDEPENDENT sibling fiber with a live effect. This is the root-health
    // probe that actually discriminates: disposing a child fiber leaves the
    // sibling's effect registered, while disposing the ROOT tears it down
    // (measured — see the file header's note on root liveness). Reading
    // `ctx.sessionProjections`, or `ctx.fiber.assertActive()`/`uid`/`state`,
    // does NOT discriminate: after a root dispose the root fiber handle still
    // reports uid 0 and state 2 and assertActive() passes.
    let independentEffectTornDown = false
    await ctx.inject([], (siblingCtx) => {
      siblingCtx.effect(() => () => { independentEffectTornDown = true })
    })

    expect(() => scoped.sessionProjections).not.toThrow()
    await fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))

    // The reported failure, now reachable for the right reason.
    expect(() => scoped.sessionProjections).toThrow(
      /cannot get required service "sessionProjections" in inactive context/,
    )
    // The child fiber really is the one that died.
    expect(fiber).not.toBe(ctx.fiber)
    expect(fiber.uid).toBeNull()

    // Root health, via the independent sibling: its effect survived, so the
    // root was NOT disposed. Under the previous revision's `extend()`-based
    // mistake (`extended.fiber` IS the root fiber), this flag flips to true
    // and the assertion below fails.
    expect(independentEffectTornDown).toBe(false)

    // ...and the root can still run new plugin code afterwards.
    let afterRan = false
    await ctx.inject([], () => { afterRan = true })
    expect(afterRan).toBe(true)
  })

  it('leaves the injected consumer resolvable after the plugin boots', async () => {
    const { consumer } = await boot()

    // The inject callback really ran (guards against a vacuous suite).
    expect(consumer.registrations).toBe(1)
    expect(() => consumer.fiber.assertActive()).not.toThrow()
    expect(() => consumer.scoped.sessionProjections).not.toThrow()
  })

  it('keeps the consumer fiber active while re-reading model lists', async () => {
    const { ctx, consumer } = await boot()

    // Scope note: `listModels()` is a read path. It does NOT emit
    // `llm/adapters-updated` (asserted below), so this is not an
    // "adapters-updated cycle" — it only exercises repeated adapter reads.
    for (let i = 0; i < 5; i += 1) {
      await ctx.llm.listModels('workbuddy')
    }
    expect(() => consumer.fiber.assertActive()).not.toThrow()
    expect(() => consumer.scoped.sessionProjections).not.toThrow()
  })

  it('counts real llm/adapters-updated emissions and keeps the fiber active', async () => {
    const { ctx, consumer, updates } = await boot()

    // The plugin's own topology signal, emitted under test control so the
    // count is verifiable rather than assumed. `runtime.invalidate()` — the
    // plugin's single emission site — is wired to credential sweeps, account
    // switches, visibility toggles, settings changes and manual refresh; those
    // drivers are host UI concerns, so the event itself is emitted here.
    const before = updates.count
    for (let i = 0; i < 5; i += 1) ctx.emit('llm/adapters-updated')

    // The counter really moved (not a tautological snapshot comparison).
    expect(updates.count).toBe(before + 5)

    // ...and the consumer fiber is still active afterwards.
    expect(() => consumer.fiber.assertActive()).not.toThrow()
    expect(() => consumer.scoped.sessionProjections).not.toThrow()
  })

  it('emits no adapters-updated on plain model-list reads', async () => {
    const { ctx, updates } = await boot()
    const before = updates.count
    for (let i = 0; i < 3; i += 1) await ctx.llm.listModels('workbuddy')
    // Pins the premise of the previous case: listModels is not such a cycle.
    expect(updates.count).toBe(before)
  })

  it('keeps the consumer active across adapter list reads in switch order', async () => {
    const { ctx, consumer } = await boot()

    // Register a second, non-workbuddy adapter to stand in for the official
    // provider. `registerAdapter` validates `providerInfo()`, so the double
    // carries that metadata.
    const release = ctx.llm.registerAdapter(['deepseek-official'], {
      providerInfo: (provider: string) => ({ id: provider, name: 'DeepSeek Official' }),
      providerRetryPolicy: () => undefined,
      async listModels(provider: string) {
        return [{ provider, id: 'deepseek-flash', name: 'DeepSeek Flash' }] as never
      },
      async resolveModel(_provider: string, model: string) {
        return { id: model, name: model } as never
      },
      async *stream() { /* not exercised */ },
    } as never)

    // LIMITATION: this walks adapter *list resolution* in the order the
    // reporter switches providers. It does not perform a session selection,
    // does not touch a session projection, and does not dispatch a tool — none
    // of which exist in this harness. It is not a simulation of a provider
    // session switch.
    for (const provider of ['deepseek-official', 'workbuddy', 'deepseek-official']) {
      const models = await ctx.llm.listModels(provider)
      expect(models.length).toBeGreaterThan(0)
      expect(() => consumer.fiber.assertActive()).not.toThrow()
      expect(() => consumer.scoped.sessionProjections).not.toThrow()
    }

    // The consumer's registration was never re-run or lost.
    expect(consumer.registrations).toBe(1)
    release()
    expect(() => consumer.fiber.assertActive()).not.toThrow()
  })
})
