import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Wire pin for issue #123: the CN gateway answers `/v3/config` with the roster
 * that matches the caller's account identity, so an enterprise account must
 * present `X-User-Id` + `X-Enterprise-Id` on the catalog requests or it is
 * silently served the personal roster (18 vs 19 models, `glm-5.3-flashx`
 * missing). The pair is all-or-nothing on that endpoint — `X-Enterprise-Id`
 * alone measured as rejected, `X-User-Id` alone as selecting nothing — so the
 * assertions pin three edges: enterprise presence, personal absence, and the
 * half-credential guard. The international gateway's split was never measured
 * against account headers, so its catalog keeps the documented shape.
 */

const PERSONAL: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
}
const ENTERPRISE: WorkBuddyCredential = { ...PERSONAL, enterpriseId: 'ent-1' }
const GLOBAL_ENTERPRISE: WorkBuddyCredential = { ...ENTERPRISE, domain: 'www.workbuddy.ai' }

const CONFIG_ENVELOPE = JSON.stringify({
  code: 0, msg: 'ok',
  data: {
    models: [{ id: 'm-1', name: 'Model One', maxInputTokens: 100_000, maxOutputTokens: 32_000 }],
    agents: [{ name: 'cli', models: ['m-1'] }],
  },
})
const CONSOLE_ENVELOPE = JSON.stringify({
  code: 0, msg: 'ok',
  data: { models: [{ id: 'm-1', tags: [] }] },
})

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Stub fetch and capture every outbound `(url, headers)` pair. `/v3/config`
 * answers first and the console badge read second, per `fetchModels`'s CN
 * pipeline; the international path makes only the one `/v3/config` call.
 */
function captureCatalogWire() {
  const calls: { url: string; headers: Record<string, string> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url instanceof Request ? url.url : url)
    calls.push({ url: urlText, headers: (init?.headers ?? {}) as Record<string, string> })
    return fakeResponse(urlText.includes('/v3/config') ? CONFIG_ENVELOPE : CONSOLE_ENVELOPE)
  }))
  return { calls }
}

describe('issue #123: catalog identity headers', () => {
  it('an enterprise account presents the pair on both catalog requests', async () => {
    const { calls } = captureCatalogWire()
    await new WorkBuddyUpstreamClient().fetchModels(ENTERPRISE)
    expect(calls.map(call => call.url)).toEqual([
      'https://copilot.tencent.com/v3/config',
      'https://copilot.tencent.com/console/enterprises/personal/models',
    ])
    for (const { headers } of calls) {
      expect(headers['X-User-Id']).toBe('uid-1')
      expect(headers['X-Enterprise-Id']).toBe('ent-1')
      expect(headers['X-Tenant-Id']).toBe('ent-1')
      expect(headers['X-Domain']).toBe('www.codebuddy.cn')
    }
  })

  it('a personal account keeps the bare catalog headers of 0.7.5', async () => {
    const { calls } = captureCatalogWire()
    await new WorkBuddyUpstreamClient().fetchModels(PERSONAL)
    expect(calls).toHaveLength(2)
    for (const { headers } of calls) {
      expect(headers['X-User-Id']).toBeUndefined()
      expect(headers['X-Enterprise-Id']).toBeUndefined()
      expect(headers['X-Tenant-Id']).toBeUndefined()
      expect(headers['X-Domain']).toBeUndefined()
    }
  })

  it('a credential with enterpriseId but no uid sends no identity header at all', async () => {
    // All-or-nothing guard: `X-Enterprise-Id` alone is rejected by the
    // gateway (0 models), so a half credential must emit nothing.
    const { calls } = captureCatalogWire()
    await new WorkBuddyUpstreamClient().fetchModels({ ...ENTERPRISE, uid: '' })
    for (const { headers } of calls) {
      expect(headers['X-User-Id']).toBeUndefined()
      expect(headers['X-Enterprise-Id']).toBeUndefined()
      expect(headers['X-Tenant-Id']).toBeUndefined()
    }
  })

  it('the international catalog keeps its documented shape for enterprise accounts', async () => {
    const { calls } = captureCatalogWire()
    const client = new WorkBuddyUpstreamClient({
      resolveAppVersion: async () => ({ version: '5.7.7', source: 'installed', bundle: '/x' }),
    })
    await client.fetchModels(GLOBAL_ENTERPRISE)
    expect(calls).toHaveLength(1)
    const { url, headers } = calls[0]!
    expect(url).toBe('https://www.workbuddy.ai/v3/config')
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest')
    expect(headers['X-Product']).toBe('SaaS')
    expect(headers['X-User-Id']).toBeUndefined()
    expect(headers['X-Enterprise-Id']).toBeUndefined()
    expect(headers['X-Tenant-Id']).toBeUndefined()
  })
})
