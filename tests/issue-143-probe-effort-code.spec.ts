import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { ChatIdentity } from '../src/client-identity.ts'
import { probeModel } from '../src/probe.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Wire pin for issue #143: on 2026-10-16 the international gateway respelled the
 * effort-rejection code it had been measured returning on 2026-10-01
 * (`model_param_invalid`) as `invalid_parameter_value`. The envelope is
 * otherwise byte-identical — `code: 11133`, `extError.param` empty, the same
 * `msg` — so only the code set in `src/probe.ts` needed to widen.
 *
 * These run the *real* path end to end (`probeEffort` → `errorCodeOf` →
 * `probeModel`) rather than handing `probeModel` a hand-built `ProbeAttempt`,
 * because the part that broke was the reading of an upstream envelope: a table
 * test that spells `invalid_parameter_value` itself cannot fail when the
 * envelope parsing drifts away from what the probe reads.
 *
 * Scope note: `invalid_parameter_value` is a generic spelling, so the widening
 * is only defensible together with the negative pins below — a sibling code
 * naming another parameter must still degrade to `unknown`, and a model that
 * accepts the sentinel must stay `non-validating`. The respelled code was
 * later observed on the China endpoint too (2026-10-16, `deepseek-v4-pro`;
 * reproduced 2026-10-17 on WorkBuddy CN 5.8.2), so both regions attribute it.
 */

const GLOBAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
  domain: 'www.workbuddy.ai',
  uid: 'uid-143',
  source: 'desktop',
}

/** The China endpoint, for the region attribution pin. */
const CN: WorkBuddyCredential = { ...GLOBAL, domain: 'www.codebuddy.cn' }

/** Deterministic identity so the request never depends on the machine's Apps. */
const IDENTITY: ChatIdentity = { clientVersion: '5.8.4', cliVersion: '2.137.1' }

const MODEL = 'deepseek-v4.1-flash'

/**
 * The sentinel rejection exactly as the issue captured it, minus `requestId`:
 * the gateway's verbatim 400 body for a non-canonical `reasoning_effort`.
 */
const SENTINEL_REJECTION_BODY = JSON.stringify({
  code: 11133,
  msg: 'the request parameters were rejected by the model provider',
  extError: {
    code: 'invalid_parameter_value',
    message: 'the request parameters were rejected by the model provider',
    param: '',
    type: 'invalid_request_error',
    StatusCode: 400,
  },
  actions: ['SWITCH_MODEL', 'SUBMIT_FEEDBACK', 'NEW_CONVERSATION'],
})

/** The pre-rename spelling of the same envelope, which must keep working. */
const OLD_SPELLING_BODY = SENTINEL_REJECTION_BODY.replace(
  '"invalid_parameter_value"',
  '"model_param_invalid"',
)

/**
 * A sibling `11133` code that names a *different* parameter: the `max_tokens`
 * floor. Same envelope, so anything that reads the envelope instead of the code
 * would mistake it for an effort rejection.
 */
const SIBLING_PARAM_BODY = SENTINEL_REJECTION_BODY.replace(
  '"invalid_parameter_value"',
  '"integer_below_min_value"',
)

/** A 200 that really streams: one SSE event, then the body ends. */
function streamingResponse(): Response {
  const chunk = new TextEncoder().encode('data: {"choices":[]}\n\n')
  let sent = false
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: chunk })),
        cancel: async () => {},
      }),
    },
  } as unknown as Response
}

function rejectResponse(body: string): Response {
  return {
    ok: false,
    status: 400,
    body: null,
    text: () => Promise.resolve(body),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Stub fetch so a probe sweep runs against a scripted upstream.
 *
 * The decision is made from the request body's `reasoning_effort`, which is
 * what the real upstream keys on; `rejectBody` is what a non-canonical value
 * is answered with, and every canonical spelling plus the baseline streams.
 * `seen` exposes the parsed bodies so a test can assert what actually went out.
 */
function scriptedUpstream(rejectBody: string, opts: { acceptSentinel?: boolean } = {}) {
  const seen: Record<string, unknown>[] = []
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    seen.push(body)
    const effort = body['reasoning_effort']
    // The baseline sends no field at all. `acceptSentinel` models a model that
    // takes any value whatsoever — the `kimi-k3` shape the #75 work pinned.
    if (effort === undefined || opts.acceptSentinel === true) return streamingResponse()
    const canonical = effort === 'low' || effort === 'medium' || effort === 'high'
      || effort === 'xhigh' || effort === 'max'
    if (canonical) return streamingResponse()
    return rejectResponse(rejectBody)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { seen, fetchMock }
}

function client(): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => IDENTITY })
}

/** Run one full sweep through the real sender, exactly as the service does. */
function sweep(credential: WorkBuddyCredential, region: 'cn' | 'global') {
  const upstream = client()
  return probeModel({
    region,
    sentinel: () => 'probe_sentinel_test',
    send: (effort, signal) => upstream.probeEffort(credential, MODEL, effort, signal),
    // The production gap spares the upstream's quota; these assertions do not
    // depend on it, and sleeping through it would only slow the suite.
    attemptGapMs: 0,
  })
}

describe('issue #143: the respelled effort-rejection code', () => {
  it('reads the respelled 11133 envelope as an effort rejection and completes the sweep', async () => {
    const upstream = scriptedUpstream(SENTINEL_REJECTION_BODY)
    const outcome = await sweep(GLOBAL, 'global')

    // Baseline + sentinel + one per candidate: the sweep ran to the end instead
    // of stopping at step 2.
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(outcome.requests).toBe(7)
    expect(upstream.seen).toHaveLength(7)
  })

  it('still reads the pre-rename spelling, so the widening is additive', async () => {
    scriptedUpstream(OLD_SPELLING_BODY)
    const outcome = await sweep(GLOBAL, 'global')
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('still degrades a sibling code from the same envelope to unknown', async () => {
    // `integer_below_min_value` names the `max_tokens` floor, not the effort.
    // The baseline proves the request shape itself is fine, so this must not be
    // read as "the effort value was refused".
    scriptedUpstream(SIBLING_PARAM_BODY)
    const outcome = await sweep(GLOBAL, 'global')
    expect(outcome.validation).toBe('unknown')
    expect(outcome.efforts).toEqual([])
  })

  it('attributes the respelled code on the China endpoint as well', async () => {
    // Observed on www.workbuddy.cn 2026-10-16 (`deepseek-v4-pro`, PR #145
    // discussion) and reproduced 2026-10-17 on WorkBuddy CN 5.8.2; the same
    // baseline-isolation argument carries the attribution on either endpoint.
    scriptedUpstream(SENTINEL_REJECTION_BODY)
    const outcome = await sweep(CN, 'cn')
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(outcome.requests).toBe(7)
  })

  it('reports non-validating when the upstream accepts the sentinel', async () => {
    // The guard the widening must not weaken: a model that answers 200 to a
    // value that cannot exist validates nothing, whatever the code set holds.
    scriptedUpstream(SENTINEL_REJECTION_BODY, { acceptSentinel: true })
    const outcome = await sweep(GLOBAL, 'global')
    expect(outcome.validation).toBe('non-validating')
    expect(outcome.efforts).toEqual([])
  })
})
