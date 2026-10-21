import { describe, expect, it, vi } from 'vitest'
import {
  PROBE_EFFORT_CANDIDATES,
  PROBE_RETRY_DELAYS_MS,
  probeModel,
  randomSentinel,
  type ProbeAttempt,
  type ProbeSender,
} from '../src/probe.ts'

/**
 * Offline tests for the probe protocol (`docs/reasoning-effort-probe-plan.md`
 * §4). The point of these is the *gating*, not the sweep: a model that answers
 * 200 to a value that cannot exist must never produce a per-level result, and
 * anything non-decisive must degrade to `unknown` rather than to a negative
 * capability claim.
 */

const ACCEPTED: ProbeAttempt = { status: 200, streamed: true }
const REJECTED: ProbeAttempt = { status: 400, streamed: false, errorCode: 'invalid_reasoning_effort' }
/** The global endpoint's rejection, measured 2026-10-01: same 11133 envelope, generic code. */
const GLOBAL_REJECTED: ProbeAttempt = { status: 400, streamed: false, errorCode: 'model_param_invalid' }
/**
 * The global endpoint's respelled rejection, measured 2026-10-16 (issue #143):
 * byte-identical `11133` envelope, only `extError.code` renamed.
 */
const GLOBAL_REJECTED_RESPELT: ProbeAttempt = {
  status: 400,
  streamed: false,
  errorCode: 'invalid_parameter_value',
}

/** A sender that answers from a table keyed by effort, with `undefined` = baseline. */
function tableSender(table: Map<string | undefined, ProbeAttempt>): ProbeSender {
  return async effort => table.get(effort) ?? REJECTED
}

/** Count how many requests a sender saw, to assert the sweep stops early. */
function counting(inner: ProbeSender): { send: ProbeSender; count: () => number } {
  let count = 0
  return {
    count: () => count,
    send: async (effort, signal) => {
      count += 1
      return inner(effort, signal)
    },
  }
}

const SENTINEL = 'probe_sentinel_test'

/**
 * Production waits tens of seconds between attempts. Every test that can reach a
 * retry swaps in these zeroed timings so the suite stays instant; the delays
 * themselves are asserted separately rather than slept through.
 */
const NO_WAIT = {
  retryDelaysMs: [0, 0, 0],
  attemptGapMs: 0,
  totalBudgetMs: Number.MAX_SAFE_INTEGER,
  wait: async () => {},
}

/** A clock the test advances by hand, so a stubbed request can still take time. */
function virtualClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0
  return { now: () => t, advance: ms => { t += ms } }
}

/** A 429 as the upstream frames it: application quota, complete JSON body. */
const BUSY: ProbeAttempt = { status: 429, streamed: false, errorCode: '14003' }

describe('probeModel', () => {
  it('verifies the levels a validating model accepts', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', REJECTED],
      ['high', ACCEPTED],
      ['xhigh', REJECTED],
      ['max', ACCEPTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL , ...NO_WAIT })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'high', 'max'])
    // Baseline + sentinel + one per candidate.
    expect(outcome.requests).toBe(2 + PROBE_EFFORT_CANDIDATES.length)
  })

  it('marks a model that accepts the sentinel as non-validating and stops early', async () => {
    // This is the measured `glm-5.2` shape: everything answers 200, including a
    // value that cannot exist. Any per-level answer would be a false positive.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, ACCEPTED],
    ])
    const sent = counting(tableSender(table))
    const outcome = await probeModel({ send: sent.send, sentinel: () => SENTINEL , ...NO_WAIT })
    expect(outcome.validation).toBe('non-validating')
    expect(outcome.efforts).toEqual([])
    // Baseline + sentinel only: no candidate was ever tried.
    expect(outcome.requests).toBe(2)
    expect(sent.count()).toBe(2)
  })

  it('reports unknown when the baseline fails', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, { status: 401, streamed: false, errorCode: 'unauthorized' }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL , ...NO_WAIT })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.efforts).toEqual([])
    // The sentinel was never sent: a broken baseline explains nothing otherwise.
    expect(outcome.requests).toBe(1)
  })

  it('reports unknown when the sentinel fails non-attributably', async () => {
    // A 500 is not a statement about the effort value, so it must not be read as
    // "validating" and must not be read as a capability answer either. Retries
    // are off: this case is about the verdict on a non-retryable status.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, { status: 500, streamed: false }],
    ])
    const outcome = await probeModel({
      send: tableSender(table),
      sentinel: () => SENTINEL,
      ...NO_WAIT,
      retryDelaysMs: [],
    })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.requests).toBe(2)
  })

  it('retries a 429 rather than reporting it as the answer', async () => {
    // Issue #182: probing a busy model failed with "detection incomplete" on the
    // very first 429. The status is retryable, so the sweep has to wait out the
    // short window and ask again instead of recording a non-answer.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', ACCEPTED],
      ['high', ACCEPTED],
      ['xhigh', ACCEPTED],
      ['max', ACCEPTED],
    ])
    let budget = 2
    const inner = tableSender(table)
    const flaky: ProbeSender = async (effort, signal) => {
      // The first two attempts of any stage answer 429, then the table decides.
      if (budget > 0) {
        budget -= 1
        return BUSY
      }
      return inner(effort, signal)
    }
    const outcome = await probeModel({
      send: flaky,
      sentinel: () => SENTINEL,
      ...NO_WAIT,
    })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // Two wasted requests on the baseline, then the normal sweep.
    expect(outcome.requests).toBe(2 + 2 + PROBE_EFFORT_CANDIDATES.length)
  })

  it('gives up on a 429 that never clears and still reports unknown', async () => {
    // The retry budget must not turn a persistent quota into a capability claim,
    // and must not spin: one attempt plus exactly three retries.
    const busy: ProbeSender = async () => BUSY
    const outcome = await probeModel({
      send: busy,
      sentinel: () => SENTINEL,
      ...NO_WAIT,
    })
    expect(outcome.validation).toBe('unknown')
    if (outcome.validation !== 'unknown') throw new Error('expected unknown')
    expect(outcome.reason).toContain('status 429')
    expect(outcome.requests).toBe(1 + PROBE_RETRY_DELAYS_MS.length)
  })

  it('stops retrying once the total budget is spent', async () => {
    // A sweep that would exceed the budget keeps the answer it already has
    // instead of running for minutes on a card that says "detecting". The delays
    // are real here and the wait is stubbed, so nothing is actually slept.
    const busy: ProbeSender = async effort =>
      effort === undefined ? ACCEPTED : BUSY
    let slept = 0
    const outcome = await probeModel({
      send: busy,
      sentinel: () => SENTINEL,
      retryDelaysMs: [1_000],
      attemptGapMs: 0,
      totalBudgetMs: 500,
      wait: async ms => { slept += ms },
    })
    expect(outcome.validation).toBe('unknown')
    // Baseline once, sentinel answered 429 once: the retry never fit the budget.
    expect(outcome.requests).toBe(2)
    expect(slept).toBe(0)
  })

  it('counts a slow response against the budget, not just the waits', async () => {
    // The budget is wall clock. A request that eats the whole thing leaves no
    // room for the next stage, so the sweep stops instead of overrunning it.
    const clock = virtualClock()
    const busy: ProbeSender = async effort => {
      clock.advance(200)
      return effort === undefined ? ACCEPTED : BUSY
    }
    const outcome = await probeModel({
      send: busy,
      sentinel: () => SENTINEL,
      retryDelaysMs: [200],
      attemptGapMs: 0,
      totalBudgetMs: 500,
      wait: async ms => { clock.advance(ms) },
      now: clock.now,
    })
    expect(outcome.validation).toBe('unknown')
    // Baseline (0–200) and the sentinel (200–400) both ran. Only 100ms is left,
    // so the 200ms retry never starts and the 429 stands.
    expect(outcome.requests).toBe(2)
    expect(clock.now()).toBe(400)
  })

  it('skips an attempt whose gap no longer fits instead of running it anyway', async () => {
    // The overrun this replaces: the gap was skipped, the request still fired.
    const clock = virtualClock()
    const busy: ProbeSender = async effort => {
      clock.advance(400)
      return effort === undefined ? ACCEPTED : BUSY
    }
    const outcome = await probeModel({
      send: busy,
      sentinel: () => SENTINEL,
      retryDelaysMs: [],
      attemptGapMs: 300,
      totalBudgetMs: 500,
      wait: async ms => { clock.advance(ms) },
      now: clock.now,
    })
    expect(outcome.validation).toBe('unknown')
    // Baseline ran (0–400). The sentinel's 300ms gap does not fit in the 100ms
    // left, so no second request is made at all.
    expect(outcome.requests).toBe(1)
    expect(clock.now()).toBe(400)
  })

  it('clamps a request to the time the budget still allows', async () => {
    // A hung request must not outlive the budget by its own 30s timeout.
    vi.useFakeTimers()
    try {
      const start = Date.now()
      let abortedAfter: number | undefined
      const hangOnSentinel: ProbeSender = (effort, signal) =>
        effort === undefined
          ? Promise.resolve(ACCEPTED)
          : new Promise<ProbeAttempt>(resolve => {
              signal.addEventListener('abort', () => {
                abortedAfter = Date.now() - start
                resolve({ status: 0, streamed: false })
              })
            })
      const pending = probeModel({
        send: hangOnSentinel,
        sentinel: () => SENTINEL,
        timeoutMs: 30_000,
        retryDelaysMs: [],
        attemptGapMs: 0,
        totalBudgetMs: 500,
        wait: async () => {},
      })
      await vi.advanceTimersByTimeAsync(500)
      expect((await pending).validation).toBe('unknown')
      expect(abortedAfter).toBe(500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat a bare 400 as an effort rejection', async () => {
    // Same status, no attributable code: the plan requires degrading to unknown
    // rather than guessing that the effort caused it.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, { status: 400, streamed: false, errorCode: 'something_else' }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL , ...NO_WAIT })
    expect(outcome.validation).toBe('unknown')
  })

  it('reads the global endpoint\'s generic parameter rejection as an effort rejection', async () => {
    // Measured 2026-10-01 on www.workbuddy.ai: a value that cannot exist is
    // answered 400/11133 with `extError.code: model_param_invalid`, while the
    // identical request without the field — and every canonical spelling —
    // answers 200 and streams.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, GLOBAL_REJECTED],
      ['low', ACCEPTED],
      ['medium', ACCEPTED],
      ['high', ACCEPTED],
      ['xhigh', ACCEPTED],
      ['max', ACCEPTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'global' , ...NO_WAIT })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('reads the global endpoint\'s respelled parameter rejection as an effort rejection', async () => {
    // Measured 2026-10-16 on www.workbuddy.ai (issue #143): the same
    // 400/11133 envelope as the 2026-10-01 measurement, with `extError.code`
    // respelled to `invalid_parameter_value` and the `msg` unchanged. The old
    // spelling is kept alongside it, so both must complete the sweep.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, GLOBAL_REJECTED_RESPELT],
      ['low', ACCEPTED],
      ['medium', ACCEPTED],
      ['high', ACCEPTED],
      ['xhigh', ACCEPTED],
      ['max', ACCEPTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'global' , ...NO_WAIT })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(outcome.requests).toBe(7)
  })

  it('reads the respelled parameter rejection on the China endpoint too', async () => {
    // Observed on www.workbuddy.cn 2026-10-16 (`deepseek-v4-pro`, PR #145
    // discussion) and reproduced 2026-10-17 on WorkBuddy CN 5.8.2, so the
    // respelled spelling is attributed on both regions.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, GLOBAL_REJECTED_RESPELT],
      ['low', ACCEPTED],
      ['medium', ACCEPTED],
      ['high', ACCEPTED],
      ['xhigh', ACCEPTED],
      ['max', ACCEPTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'cn' , ...NO_WAIT })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('applies the global rejection code to the level sweep as well', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, GLOBAL_REJECTED],
      ['low', ACCEPTED],
      ['medium', GLOBAL_REJECTED],
      ['high', ACCEPTED],
      ['xhigh', GLOBAL_REJECTED],
      ['max', ACCEPTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'global' , ...NO_WAIT })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'high', 'max'])
  })

  it('keeps the China endpoint degrading the global-only generic code to unknown', async () => {
    // `model_param_invalid` was measured only on the global endpoint. The China
    // endpoint was measured answering the specific `invalid_reasoning_effort`,
    // so a generic code there must not be read as an effort rejection — the
    // region split is what keeps each endpoint to its own vocabulary.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, GLOBAL_REJECTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'cn' , ...NO_WAIT })
    expect(outcome.validation).toBe('unknown')
  })

  it('keeps the China endpoint degrading the global-only generic code mid-sweep too', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', GLOBAL_REJECTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'cn' , ...NO_WAIT })
    // A non-decisive answer mid-sweep: no partial set may leak out.
    expect(outcome.validation).toBe('unknown')
    expect(outcome.efforts).toEqual([])
  })

  it('still degrades a sibling code from the same envelope to unknown', async () => {
    // `integer_below_min_value` arrives in the same 11133 envelope but names
    // the `max_tokens` floor, so it says nothing about the effort value. Run on
    // the global region explicitly: that is where the envelope was measured
    // and where the widened code set could otherwise mistake a sibling for an
    // effort rejection.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, { status: 400, streamed: false, errorCode: 'integer_below_min_value' }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'global' , ...NO_WAIT })
    expect(outcome.validation).toBe('unknown')
  })

  it('does not count a 200 without a stream as acceptance', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, { status: 200, streamed: false }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL , ...NO_WAIT })
    expect(outcome.validation).toBe('unknown')
  })

  it('abandons a mid-sweep failure rather than reporting a partial set', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', { status: 500, streamed: false }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL , ...NO_WAIT })
    expect(outcome.validation).toBe('unknown')
    // The accepted `low` must not leak out as a finding.
    expect(outcome.efforts).toEqual([])
  })

  it('never probes `off` or `minimal`', () => {
    expect(PROBE_EFFORT_CANDIDATES).not.toContain('off')
    expect(PROBE_EFFORT_CANDIDATES).not.toContain('minimal')
  })

  it('survives a throwing sender by reporting unknown', async () => {
    const outcome = await probeModel({
      send: async () => { throw new Error('socket hang up') },
      sentinel: () => SENTINEL,
    })
    expect(outcome.validation).toBe('unknown')
  })
})

describe('randomSentinel', () => {
  it('is not a canonical effort spelling and varies per call', () => {
    const first = randomSentinel()
    const second = randomSentinel()
    expect(first).not.toBe(second)
    expect(first.startsWith('probe_sentinel_')).toBe(true)
    for (const effort of PROBE_EFFORT_CANDIDATES) expect(first).not.toBe(effort)
    expect(first).not.toBe('off')
  })
})
