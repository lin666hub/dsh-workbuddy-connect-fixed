import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { ReactTestRendererJSON } from 'react-test-renderer'
import { WorkBuddyUpdateOverlay } from '../src/client/WorkBuddyUpdateNotice.tsx'
import { en } from '../src/client/locales.ts'
import type { WorkBuddySettingsKey } from '../src/client/locales.ts'
import { WorkBuddyUpdateStore } from '../src/client/update-store.ts'
import { parseWorkBuddyUpdateResult, releasePageUrl } from '../src/update.ts'
import type { WorkBuddyUpdateSnapshot } from '../src/client/update-store.ts'

/**
 * What the floating seat renders — pinned at the style level, because the
 * host contract it must honour (click-through overlay, bottom-anchored
 * panel) is exactly what a DOM-less render can still prove.
 */

const t = (key: WorkBuddySettingsKey, params?: Record<string, unknown>): string => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function baseSnapshot(): WorkBuddyUpdateSnapshot {
  return {
    status: 'update-available',
    currentVersion: '0.6.1',
    latestVersion: '0.6.4',
    releaseUrl: 'https://github.com/corrinehu/dsh-workbuddy-connect/releases/tag/v0.6.4',
    versionsBehind: 1,
    releases: [{ version: 'v0.6.4', name: 'v0.6.4 summary' }],
  }
}

function render(snapshot: WorkBuddyUpdateSnapshot): ReactTestRendererJSON | null {
  const updater = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    refresh: async () => {},
    dismiss: () => {},
  }
  const json = TestRenderer.create(createElement(WorkBuddyUpdateOverlay, { t, updater: updater as unknown as WorkBuddyUpdateStore })).toJSON()
  return Array.isArray(json) ? (json[0] ?? null) : json
}

describe('the floating update seat', () => {
  it('opts into pointer events and caps its height at the viewport', () => {
    const root = render(baseSnapshot())
    expect(root).not.toBeNull()
    const style = (root as ReactTestRendererJSON).props['style'] as Record<string, unknown>
    // The shell.overlay seat is click-through by contract; without this the
    // buttons cannot be clicked at all.
    expect(style['pointerEvents']).toBe('auto')
    // Bottom-anchored with an unbounded list: the panel must stay on screen.
    expect(style['maxHeight']).toBe('calc(100vh - 32px)')
    expect(style['overflowY']).toBe('auto')
    expect(style['bottom']).toBe(16)
    expect(style['right']).toBe(20)
  })

  it('renders nothing without an update, when dismissed, or on failure', () => {
    expect(render({ ...baseSnapshot(), status: 'up-to-date', latestVersion: '0.6.1' })).toBeNull()
    expect(render({ ...baseSnapshot(), status: 'unavailable' })).toBeNull()
    expect(render({ ...baseSnapshot(), dismissedNotice: '0.6.1:0.6.4' })).toBeNull()
  })

  it('keeps the dismissal target alive across a recheck (review P2)', async () => {
    // The reported flow: update-available -> click re-check -> checking ->
    // click "don't remind me again" -> request completes. The checking
    // snapshot must still carry latestVersion, or the dismiss button writes
    // nothing and the same version pair comes right back.
    let snapshot: WorkBuddyUpdateSnapshot = baseSnapshot()
    const listeners = new Set<() => void>()
    const dismiss = vi.fn()
    const refresh = vi.fn(async () => {
      const currentVersion = snapshot.currentVersion
      const latestVersion = snapshot.latestVersion
      snapshot = latestVersion === undefined
        ? { status: 'checking', currentVersion }
        : { status: 'checking', currentVersion, latestVersion }
      for (const listener of listeners) listener()
    })
    const updater = {
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => snapshot,
      refresh,
      dismiss,
    }
    const renderer = TestRenderer.create(createElement(WorkBuddyUpdateOverlay, { t, updater: updater as unknown as WorkBuddyUpdateStore }))
    const root = renderer.root
    // Click "re-check after upgrading".
    const recheck = root.findAll(node => Array.isArray(node.children) && node.children.includes(en.recheckAfterUpgrade))[0]
    if (recheck === undefined) throw new Error('recheck button not found')
    await recheck.props.onClick()
    expect(refresh).toHaveBeenCalledWith(true)
    // The panel stays for the pending recheck, and the dismiss button must
    // still name the previous version pair.
    const dismissButton = root.findByProps({ 'aria-label': en.dismissUpdate })
    dismissButton.props.onClick()
    expect(dismiss).toHaveBeenCalledWith('0.6.1:0.6.4')
  })

  it('shows one collapsed row per in-range release, not the notes', () => {
    const html = JSON.stringify(render({
      ...baseSnapshot(),
      versionsBehind: 2,
      releases: [
        { version: 'v0.6.4', name: 'v0.6.4 summary' },
        { version: 'v0.6.3', name: 'v0.6.3 summary', notes: 'hidden until opened' },
      ],
    }))
    expect(html).toContain('v0.6.4 summary')
    expect(html).toContain('v0.6.3 summary')
    expect(html).not.toContain('hidden until opened')
  })
})


describe('manifest drift delivery', () => {
  const renderers: TestRenderer.ReactTestRenderer[] = []
  afterEach(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount()
    vi.unstubAllGlobals()
  })

  function storage(): Storage {
    const values = new Map<string, string>()
    return {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: key => { values.delete(key) },
      clear: () => { values.clear() },
      key: index => [...values.keys()][index] ?? null,
      get length() { return values.size },
    }
  }
  function response(status: string, manifestVersion = '0.7.11') {
    return {
      status, currentVersion: '0.7.9', manifestVersion,
      ...(status === 'unavailable' ? { reason: 'registry-unavailable' }
        : { latestVersion: status === 'up-to-date' ? '0.7.9' : '0.7.10' }),
      ...(status === 'update-available' ? { releaseUrl: releasePageUrl('0.7.10'), releases: [] } : {}),
    }
  }
  function render(store: WorkBuddyUpdateStore) {
    const t = (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => {
      let text: string = en[key]
      for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
      return text
    }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(createElement(WorkBuddyUpdateOverlay, { updater: store, t })) })
    renderers.push(renderer)
    return renderer
  }

  it.each(['up-to-date', 'update-available', 'unavailable'])('renders both versions after a %s route response', async status => {
    vi.stubGlobal('localStorage', storage())
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response(status))))
    vi.stubGlobal('fetch', fetchMock)
    const store = new WorkBuddyUpdateStore('0.7.9')
    try {
      await store.refresh(true)
      const renderer = render(store)
      expect(store.getSnapshot().manifestVersion).toBe('0.7.11')
      expect(JSON.stringify(renderer.toJSON())).toContain('0.7.11')
      expect(JSON.stringify(renderer.toJSON())).toContain('0.7.9')
      expect(renderer.root.findByProps({ children: en.recheckAfterUpgrade }).props.disabled).toBe(false)
      if (status !== 'unavailable') {
        const cached = new WorkBuddyUpdateStore('0.7.9')
        try {
          await cached.refresh()
          expect(cached.getSnapshot().manifestVersion).toBe('0.7.11')
          expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally { cached.dispose() }
      }
    } finally { store.dispose() }
  })

  it('dismisses the same split but shows a changed manifest despite the same latest release', async () => {
    vi.stubGlobal('localStorage', storage())
    let manifest = '0.7.11'
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(response('update-available', manifest))))
    const store = new WorkBuddyUpdateStore('0.7.9')
    try {
      // A pre-existing update dismissal must not suppress the new diagnostic.
      store.dismiss('0.7.9:0.7.10')
      await store.refresh(true)
      const renderer = render(store)
      expect(renderer.toJSON()).not.toBeNull()
      act(() => { renderer.root.findByProps({ 'aria-label': en.dismissUpdate }).props.onClick() })
      expect(renderer.toJSON()).toBeNull()
      await act(async () => { await store.refresh(true) })
      expect(renderer.toJSON()).toBeNull()
      manifest = '0.7.12'
      await act(async () => { await store.refresh(true) })
      expect(JSON.stringify(renderer.toJSON())).toContain('0.7.12')
    } finally { store.dispose() }
  })

  it('ignores malformed optional manifest versions without losing a valid update result', () => {
    expect(parseWorkBuddyUpdateResult({ ...response('up-to-date'), manifestVersion: { bad: true } }))
      .toEqual({ status: 'up-to-date', currentVersion: '0.7.9', latestVersion: '0.7.9' })
  })
})
