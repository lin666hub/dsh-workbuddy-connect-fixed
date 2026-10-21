import { Component, createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyProbeControl, type WorkBuddyProbeControlProps } from '../src/client/WorkBuddyProbeControl.tsx'
import { en } from '../src/client/locales.ts'

/**
 * Regression spec for #125 / #132: the Composer balance badge and the ↻
 * disappearing together when a session is switched to or created.
 *
 * ROOT CAUSE this file pins (verified against the host package
 * `@deepseek-ai/dsh-client-ui-model-selection` 0.2.0-rc.2): the per-session
 * `ModelDirectory.store` a composer entry mounts with starts at
 * `current: null` — `null`, never `undefined` — until the session's model
 * selection projection and the shared catalog have landed. The shipped
 * component guarded only `selection === undefined`, so on every not-ready
 * mount it dereferenced `selection.provider` off `null` and THREW; the slot
 * runtime's per-entry error boundary then dropped the whole entry
 * (`data-slot-error`, no retry) until a full UI reload — which is exactly
 * "the badge and the ↻ disappear together, intermittently, on session switch
 * or new session" across Windows (#125) and macOS (#132).
 *
 * REV 2 SAFETY CONTRACT (supersedes the rejected "remembered seat" design):
 *
 * - a NOT-READY selection (`current` null/undefined) renders NOTHING for that
 *   composer — no badge, no ↻, and above all no status GET — while the
 *   component stays mounted and subscribed, so the seat reappears by itself
 *   when the store publishes the landed projection (the host's `syncInputs`
 *   replaces the snapshot; `useSyncExternalStore` re-renders). Which account's
 *   balance may show is a property of THIS session's selection; while it is
 *   unknown, showing any previously seen WorkBuddy variant would present —
 *   and bill-query — the wrong provider's account (another composer may be
 *   switching to a non-WorkBuddy provider at the same time). Two composers
 *   rendered side by side therefore also never share state.
 * - a selection that explicitly names a NON-WorkBuddy provider hides the seat.
 * - once a session's selection resolves to a WorkBuddy provider, the seat
 *   mounts normally: one status read on mount, the ↻ as the only re-read.
 */

/** One session's directory store: its own listener set and mutable snapshot. */
function sessionStore() {
  const listeners = new Set<() => void>()
  // `useSyncExternalStore` re-renders only when getSnapshot() returns a NEW
  // object reference — the host's real store replaces the state on every
  // syncInputs, so the stand-in must too (mutating in place would freeze the
  // component at the first snapshot).
  let state: {
    current: { provider: string, model: string } | null | undefined
    status: string
    routable: boolean | null
  } = { current: null, status: 'loading', routable: null }
  return {
    directory: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    } as WorkBuddyProbeControlProps['directory'],
    /** Land the session's projection, the way the host's syncInputs does. */
    arrive(current: { provider: string, model: string } | null | undefined): void {
      state = {
        current,
        status: current === null || current === undefined ? 'loading' : 'ready',
        routable: current == null ? null : true,
      }
      listeners.forEach(listener => listener())
    },
  }
}

/**
 * Minimal replica of the host renderer's per-entry `SlotErrorBoundary`
 * (`dsh-client-ui-renderer`): catch a render error once, then render the
 * crash placeholder INSTEAD of the entry, with no retry — the mechanism that
 * turned the old crash into a permanently missing badge. Replicated here so
 * the suite can prove a component that only ever experiences a not-ready
 * store never trips it.
 */
class SlotErrorBoundaryReplica extends Component<{ children: ReactElement }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) { SlotErrorBoundaryReplica.lastCaught = error }
  static lastCaught: unknown = undefined
  render() {
    return this.state.failed
      ? createElement('div', { 'data-slot-error': 'conversation.input.right' })
      : this.props.children
  }
}

describe('Composer seat across session lifecycle (#125 / #132, rev 2 safety)', () => {
  let views: ReactTestRenderer[] = []
  /** The status document the stubbed fetch serves; mutated per scenario. */
  let statusBody: Record<string, unknown>
  const request = vi.fn()
  let intervalHandlers: (() => void)[] = []
  let focusHandlers: (() => void)[] = []

  const t: WorkBuddyProbeControlProps['t'] = (key, params = {}) =>
    Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key] as string)

  async function mount(directory: WorkBuddyProbeControlProps['directory']): Promise<ReactTestRenderer> {
    let view: ReactTestRenderer | undefined
    await act(async () => { view = create(createElement(WorkBuddyProbeControl, { directory, t })) })
    views.push(view!)
    return view!
  }

  /** Every string child a tree carries, flattened per node. */
  const spanTexts = (view: ReactTestRenderer) => view.root.findAllByType('span')
    .flatMap(node => node.children.filter(child => typeof child === 'string') as string[])
  const statusGets = () => request.mock.calls.filter(([, init]) => init?.method !== 'POST')
  const refreshButton = (view: ReactTestRenderer) => view.root.findAllByType('button')
    .find(node => node.props['aria-label'] === en.composerCreditRefresh)!
  const number = (value: number) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)

  /** Give the stubbed status document a signed-in balance. */
  function withCredits(total: number): void {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-key',
      probe: { consent: true, running: false, candidates: ['glm-5.2', 'auto'], results: [] },
      credits: { total },
    }
  }

  beforeEach(() => {
    withCredits(3401)
    request.mockReset().mockImplementation(async () => ({ ok: true, json: async () => statusBody }))
    vi.stubGlobal('fetch', request)
    intervalHandlers = []
    focusHandlers = []
    vi.stubGlobal('window', {
      setInterval: (fn: () => void) => { intervalHandlers.push(fn); return 1 },
      clearInterval: () => {},
      addEventListener: (name: string, handler: () => void) => { if (name === 'focus') focusHandlers.push(handler) },
      removeEventListener: () => {},
    })
    SlotErrorBoundaryReplica.lastCaught = undefined
  })
  afterEach(() => {
    for (const view of views) act(() => { view.unmount() })
    views = []
    vi.unstubAllGlobals()
  })

  it('renders nothing — without throwing — while the projection is still loading', async () => {
    // THE falsification pin: the host store's initial `current` is null. The
    // shipped code threw `TypeError: Cannot read properties of null (reading
    // 'provider')` right here, which the slot error boundary turns into the
    // badge and ↻ vanishing together.
    const session = sessionStore()
    const view = await mount(session.directory)
    expect(view.toJSON()).toBeNull()
    // Nothing is shown, so nothing may be read either: no seat, no request.
    expect(statusGets()).toHaveLength(0)
  })

  it('treats an undefined current as not-ready too, not as a foreign provider', async () => {
    // Defensive breadth: this store contract says null, but a future host
    // generation must not reintroduce the crash by using undefined — both
    // mean "no answer yet", and neither may be read as provider information.
    const session = sessionStore()
    session.arrive(undefined)
    const view = await mount(session.directory)
    expect(view.toJSON()).toBeNull()
    expect(statusGets()).toHaveLength(0)
  })

  it('shows the badge once the projection lands on a WorkBuddy session', async () => {
    const session = sessionStore()
    const view = await mount(session.directory)
    expect(view.toJSON()).toBeNull()
    await act(async () => { session.arrive({ provider: 'workbuddy', model: 'glm-5.2' }) })
    expect(spanTexts(view)).toContain(`WB.${number(3401)} credits`)
    expect(statusGets()).toHaveLength(1)
    expect(statusGets()[0]![0]).toBe('/plugins/dsh-workbuddy-connect/status')
  })

  it('a not-ready window after another session showed WorkBuddy shows and reads nothing', async () => {
    // THE rev-2 safety discriminator: session A resolved to WorkBuddy and
    // showed its balance; switching to session B remounts the entry (the host
    // keys it per session scope) with B's store still at current: null. B may
    // be about to resolve to ANY provider — so during the window it must show
    // no A balance and hit no A endpoint. The rejected "remembered seat"
    // design fails exactly here.
    const sessionA = sessionStore()
    sessionA.arrive({ provider: 'workbuddy', model: 'glm-5.2' })
    const viewA = await mount(sessionA.directory)
    expect(spanTexts(viewA)).toContain(`WB.${number(3401)} credits`)
    const readsAfterA = statusGets().length
    const endpointCallsAfterA = statusGets().filter(([url]) => url === '/plugins/dsh-workbuddy-connect/status').length

    const sessionB = sessionStore() // current: null — B's projection not landed
    const viewB = await mount(sessionB.directory)
    expect(viewB.toJSON()).toBeNull()
    expect(spanTexts(viewB).join(' ')).not.toContain('credits')
    // No seat means no read: the count and the CN endpoint are untouched.
    expect(statusGets()).toHaveLength(readsAfterA)
    expect(statusGets().filter(([url]) => url === '/plugins/dsh-workbuddy-connect/status').length)
      .toBe(endpointCallsAfterA)

    // B actually resolves to a non-WorkBuddy provider: still hidden, still
    // no new reads.
    await act(async () => { sessionB.arrive({ provider: 'deepseek-account', model: 'deepseek-chat' }) })
    expect(viewB.toJSON()).toBeNull()
    expect(statusGets()).toHaveLength(readsAfterA)
  })

  it('recovers the seat when the not-ready session resolves to WorkBuddy', async () => {
    // The trade the safety design makes: the window is blank, never stuck.
    // The store's notification is what brings the seat back — no reload, no
    // crash, no lingering error state.
    const session = sessionStore()
    const view = await mount(session.directory)
    expect(view.toJSON()).toBeNull()
    await act(async () => { session.arrive({ provider: 'workbuddy', model: 'glm-5.2' }) })
    expect(spanTexts(view)).toContain(`WB.${number(3401)} credits`)
    expect(statusGets()).toHaveLength(1)
  })

  it('resolves to the AI variant with its own endpoint, without crossing accounts', async () => {
    const session = sessionStore()
    const view = await mount(session.directory)
    withCredits(95)
    await act(async () => { session.arrive({ provider: 'workbuddy-ai', model: 'auto' }) })
    expect(spanTexts(view)).toContain(`WB AI.${number(95)} credits`)
    expect(spanTexts(view).some(text => text.startsWith('WB.'))).toBe(false)
    expect(statusGets()).toHaveLength(1)
    expect(statusGets()[0]![0]).toBe('/plugins/dsh-workbuddy-connect/ai/status')
  })

  it('keeps two side-by-side composers independent', async () => {
    // Split views can render two composers at once; with no shared state the
    // seats must not influence each other through the loading of the other.
    const sessionA = sessionStore()
    sessionA.arrive({ provider: 'workbuddy', model: 'glm-5.2' })
    const viewA = await mount(sessionA.directory)
    const sessionB = sessionStore()
    const viewB = await mount(sessionB.directory)

    // A shows its own balance; B, still loading, shows and reads nothing.
    expect(spanTexts(viewA)).toContain(`WB.${number(3401)} credits`)
    expect(viewB.toJSON()).toBeNull()
    expect(statusGets()).toHaveLength(1)
    expect(statusGets()[0]![0]).toBe('/plugins/dsh-workbuddy-connect/status')

    // B resolves to the OTHER WorkBuddy variant: each composer now reads its
    // own account's route, and A's display is unchanged.
    withCredits(95)
    await act(async () => { sessionB.arrive({ provider: 'workbuddy-ai', model: 'auto' }) })
    expect(spanTexts(viewB)).toContain(`WB AI.${number(95)} credits`)
    expect(spanTexts(viewA)).toContain(`WB.${number(3401)} credits`)
    expect(spanTexts(viewA).some(text => text.startsWith('WB AI.'))).toBe(false)
    expect(statusGets().map(([url]) => url).sort()).toEqual([
      '/plugins/dsh-workbuddy-connect/ai/status',
      '/plugins/dsh-workbuddy-connect/status',
    ])
  })

  it('stays hidden for an explicit non-WorkBuddy provider from the first render', async () => {
    const session = sessionStore()
    session.arrive({ provider: 'deepseek-account', model: 'deepseek-chat' })
    const view = await mount(session.directory)
    expect(view.toJSON()).toBeNull()
    expect(statusGets()).toHaveLength(0)
  })

  it('keeps the ↻ as the only manual re-read and registers no timers or listeners', async () => {
    const session = sessionStore()
    session.arrive({ provider: 'workbuddy', model: 'glm-5.2' })
    const view = await mount(session.directory)
    expect(refreshButton(view)).toBeDefined()
    const before = statusGets().length
    await act(async () => { refreshButton(view).props.onClick() })
    expect(statusGets()).toHaveLength(before + 1)
    expect(statusGets()[statusGets().length - 1]![1]!.cache).toBe('no-store')
    // #99's contract holds through the fix: no polling, no focus reads.
    expect(intervalHandlers).toHaveLength(0)
    expect(focusHandlers).toHaveLength(0)
  })

  describe('slot error boundary (replica of the host renderer)', () => {
    async function mountBehindBoundary(directory: WorkBuddyProbeControlProps['directory']): Promise<ReactTestRenderer> {
      let view: ReactTestRenderer | undefined
      await act(async () => {
        view = create(createElement(SlotErrorBoundaryReplica, null,
          createElement(WorkBuddyProbeControl, { directory, t })))
      })
      views.push(view!)
      return view!
    }

    it('a composer that only ever experiences loading never trips the boundary', async () => {
      const session = sessionStore()
      const view = await mountBehindBoundary(session.directory)
      // Loading window: no crash placeholder, no caught error…
      expect(view.root.findAllByProps({ 'data-slot-error': 'conversation.input.right' })).toHaveLength(0)
      expect(SlotErrorBoundaryReplica.lastCaught).toBeUndefined()
      // …and the entry is still alive when the projection lands.
      await act(async () => { session.arrive({ provider: 'workbuddy', model: 'glm-5.2' }) })
      expect(spanTexts(view)).toContain(`WB.${number(3401)} credits`)
      expect(view.root.findAllByProps({ 'data-slot-error': 'conversation.input.right' })).toHaveLength(0)
      expect(SlotErrorBoundaryReplica.lastCaught).toBeUndefined()
    })

    it('harness validity: the replica does catch a crashing child', async () => {
      const Boom = (): never => { throw new Error('boom') }
      let view: ReactTestRenderer | undefined
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await act(async () => {
          view = create(createElement(SlotErrorBoundaryReplica, null, createElement(Boom)))
        })
        views.push(view!)
      } finally {
        errorSpy.mockRestore()
      }
      // If this ever fails, the previous test's "never trips" assertion is
      // vacuous — the boundary replica would be catching nothing at all.
      expect(view!.root.findAllByProps({ 'data-slot-error': 'conversation.input.right' })).toHaveLength(1)
      expect(SlotErrorBoundaryReplica.lastCaught).toBeInstanceOf(Error)
    })
  })
})
