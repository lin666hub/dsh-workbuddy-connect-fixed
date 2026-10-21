/**
 * The reasoning-effort probe: decide whether a model's `reasoning_effort`
 * parameter is actually validated, and if so which canonical values it accepts.
 *
 * Implements `docs/reasoning-effort-probe-plan.md` §4. The order matters and is
 * not an optimization:
 *
 * 1. **Baseline** (no `reasoning_effort`) proves the model, credential, and
 *    request shape work at all, so a later rejection can be attributed.
 * 2. **Sentinel** (a fresh random, impossible-to-collide value) answers the one
 *    question a per-level sweep cannot: does the upstream validate the field?
 *    A model that accepts the sentinel answers 200 to *everything*, so its
 *    per-level results would be uniformly false positives.
 * 3. **Levels**, only after the sentinel was refused.
 *
 * The result is an observation, never a capability claim. Even a fully
 * successful sweep means "the upstream accepted these spellings", not "these
 * spellings change how the model thinks".
 *
 * @module dsh-workbuddy-connect/probe
 */

import { randomBytes } from 'node:crypto'
import type { WorkBuddyEffort } from './upstream.ts'

/**
 * The canonical values a probe tests, in a fixed order.
 *
 * `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
 * by policy — disabling thinking is a separate capability the upstream must
 * declare through `canDisableThinking`, never something probing may infer.
 */
export const PROBE_EFFORT_CANDIDATES: readonly WorkBuddyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Prompt body used by every probe request; carries nothing user-specific. */
export const PROBE_PROMPT = 'ping'

/** Output ceiling for a probe request; the answer itself is never read. */
export const PROBE_MAX_TOKENS = 1

/** Per-request ceiling so one hung probe cannot stall the queue. */
export const PROBE_REQUEST_TIMEOUT_MS = 30_000

/**
 * Backoff before each retry of the *same* attempt. The length is the retry
 * budget: an answer that is still retryable after the last delay is reported as
 * it stands, so a busy upstream degrades to `unknown` exactly as before.
 *
 * 429 is the one status worth retrying. The upstream answers it in 0.3–3s with
 * a complete JSON body (`14003`, `too many requests`) — an application-level
 * quota, not a network fault — and the quota is per model over a short window,
 * so waiting it out is the only way to observe the sweep (issue #182).
 */
export const PROBE_RETRY_DELAYS_MS: readonly number[] = [4_000, 8_000, 16_000]

/**
 * Gap between two *different* attempts. A validating model needs the longest
 * sweep (baseline + sentinel + one per candidate), and firing it back to back is
 * what fills the short window in the first place: the measured failure drifted
 * between baseline, sentinel and the levels rather than pinning one stage, which
 * is a throttling signature and not a per-parameter rejection.
 */
export const PROBE_ATTEMPT_GAP_MS = 1_500

/**
 * Ceiling for a whole sweep, retries and request time included, as elapsed wall
 * clock. Without it the worst case is seven attempts each burning the full retry
 * budget plus their own 30s timeout, which is far longer than a user will wait on
 * a card that says "detecting".
 */
export const PROBE_TOTAL_BUDGET_MS = 180_000

/** Sentinel generator; injectable so tests get deterministic values. */
export type SentinelFactory = () => string

/** Default sentinel: unmistakably non-canonical, different on every call. */
export function randomSentinel(): string {
  return `probe_sentinel_${randomBytes(12).toString('hex')}`
}

/**
 * One response as the probe sees it, split into the only distinctions the
 * attribution rule needs.
 */
export interface ProbeAttempt {
  /** HTTP status, or 0 for a transport failure. */
  status: number
  /** True when a parseable SSE event arrived. */
  streamed: boolean
  /** `extError.code` from a JSON error body, when present. */
  errorCode?: string
  /** Free-form detail for logs; never shown as a capability claim. */
  detail?: string
}

/** How one attempt is performed; the caller owns credentials and HTTP. */
export type ProbeSender = (effort: string | undefined, signal: AbortSignal) => Promise<ProbeAttempt>

/** The outcome of probing one model. */
export type ProbeOutcome =
  | { validation: 'validating'; efforts: readonly WorkBuddyEffort[]; requests: number }
  | { validation: 'non-validating'; efforts: readonly []; requests: number }
  | { validation: 'unknown'; efforts: readonly []; requests: number; reason: string }

/** Which endpoint's rejection vocabulary a probe interprets. */
export type ProbeRegion = 'cn' | 'global'

/**
 * The upstream's "this effort value is not supported" codes, per region, as
 * measured on each live endpoint. The sets are kept separate so a code only
 * ever widens detection for the endpoint it was measured on.
 *
 * - `invalid_reasoning_effort` — the China endpoint, measured 2026-09-11
 *   (plan §4.2). Also kept for `global` as a fallback spelling.
 * - `model_param_invalid` — the global endpoint, measured 2026-10-01. A
 *   non-canonical value is answered `400` / `11133` with this code, which names
 *   no field (`extError.param` is empty), instead of one that names the effort.
 * - `invalid_parameter_value` — both endpoints. Measured on the global
 *   endpoint 2026-10-16 (issue #143); observed on the China endpoint the same
 *   day (`deepseek-v4-pro`, PR #145 discussion) and reproduced there
 *   2026-10-17 on WorkBuddy CN 5.8.2. The *same* `400` / `11133` envelope as
 *   `model_param_invalid`, with `extError.code` respelled and the `msg`
 *   unchanged; a non-canonical value is again what triggers it and the
 *   baseline still answers 200. Kept alongside the old spellings rather than
 *   replacing them: the rename was observed on the gateways, not promised for
 *   every model behind them.
 *
 * The generic codes name no effort field. They are readable here only
 * because the baseline step has already proved the *same* request without
 * `reasoning_effort` succeeds, leaving the sentinel as the only difference
 * between the two attempts — an isolation that holds per endpoint, which is
 * why both regions read the respelled spelling once each was observed on it.
 * A sibling code in the same `11133` envelope that names another parameter
 * (`integer_below_min_value`, the `max_tokens` floor) and a body carrying no
 * `extError` at all (`11102`, unknown model) are therefore not mistaken for
 * them, and neither is a level-sweep answer.
 *
 * None of these is treated as a permanent protocol promise: anything
 * unrecognized still degrades to `unknown` rather than to a capability
 * conclusion.
 */
const INVALID_EFFORT_CODES: Record<ProbeRegion, ReadonlySet<string>> = {
  cn: new Set(['invalid_reasoning_effort', 'invalid_parameter_value']),
  global: new Set(['invalid_reasoning_effort', 'model_param_invalid', 'invalid_parameter_value']),
}

/**
 * Whether an attempt may be repeated unchanged: the upstream is busy, not
 * answering the question. Only 429 qualifies — every other status is either a
 * verdict about the effort value or a failure retrying cannot fix.
 */
function isRetryable(attempt: ProbeAttempt): boolean {
  return attempt.status === 429
}

/** Whether an attempt is an attributable rejection of the effort value. */
function isEffortRejection(attempt: ProbeAttempt, region: ProbeRegion): boolean {
  const codes = INVALID_EFFORT_CODES[region]
  return attempt.status === 400 && attempt.errorCode !== undefined && codes.has(attempt.errorCode)
}

/** Whether an attempt shows the upstream accepted the request and streamed. */
function isAcceptance(attempt: ProbeAttempt): boolean {
  return attempt.status === 200 && attempt.streamed
}

/** Why an attempt ended in `unknown`, phrased for a log line. */
function unknownReason(stage: string, attempt: ProbeAttempt): string {
  const code = attempt.errorCode === undefined ? '' : ` (${attempt.errorCode})`
  const detail = attempt.detail === undefined ? '' : `: ${attempt.detail}`
  return `${stage} status ${attempt.status}${code}${detail}`
}

/**
 * Probe one model.
 *
 * `options.candidates` exists so tests can shorten the sweep; production always
 * uses {@link PROBE_EFFORT_CANDIDATES}. `options.region` selects which
 * endpoint's rejection vocabulary is read; it defaults to `cn`, which is also
 * the production default for the China app.
 */
export async function probeModel(options: {
  send: ProbeSender
  sentinel?: SentinelFactory
  candidates?: readonly WorkBuddyEffort[]
  timeoutMs?: number
  region?: ProbeRegion
  /** Zeroed by tests; production uses {@link PROBE_RETRY_DELAYS_MS}. */
  retryDelaysMs?: readonly number[]
  /** Zeroed by tests; production uses {@link PROBE_ATTEMPT_GAP_MS}. */
  attemptGapMs?: number
  /** Zeroed by tests; production uses {@link PROBE_TOTAL_BUDGET_MS}. */
  totalBudgetMs?: number
  /** Injected by tests to keep the suite instant; defaults to `setTimeout`. */
  wait?: (ms: number) => Promise<void>
  /** Injected by tests to advance a virtual clock; defaults to `Date.now`. */
  now?: () => number
}): Promise<ProbeOutcome> {
  const sentinel = options.sentinel ?? randomSentinel
  const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES
  const timeoutMs = options.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS
  const region = options.region ?? 'cn'
  const retryDelays = options.retryDelaysMs ?? PROBE_RETRY_DELAYS_MS
  const attemptGapMs = options.attemptGapMs ?? PROBE_ATTEMPT_GAP_MS
  const totalBudgetMs = options.totalBudgetMs ?? PROBE_TOTAL_BUDGET_MS
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  let requests = 0

  // The budget is wall clock, not sleep time: a sweep that spends its 180s in
  // seven 30s timeouts is over just as much as one that spends it waiting.
  const deadline = now() + totalBudgetMs
  const remaining = (): number => deadline - now()
  const exhausted: ProbeAttempt = { status: 0, streamed: false, detail: 'probe budget exhausted' }

  const once = async (effort: string | undefined): Promise<ProbeAttempt> => {
    const budget = remaining()
    // No request may start past the deadline, and none may outlive it either.
    if (budget <= 0) return exhausted
    requests += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, budget))
    try {
      return await options.send(effort, controller.signal)
    } catch (error: unknown) {
      return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * One attempt, retried while the upstream reports it is busy. Throttling and
   * retrying are what make the sweep observable at all: a model that needs the
   * longest scan is usually the one whose quota a back-to-back scan exhausts
   * (issue #182). A budget that runs out keeps the answer it already has, so
   * this can only ever add time — never turn a rejection into an acceptance.
   */
  const attempt = async (effort: string | undefined): Promise<ProbeAttempt> => {
    if (attemptGapMs > 0 && requests > 0) {
      // A gap that no longer fits means the sweep is over, not that the gap is
      // free: firing the request anyway is what let the budget be overrun.
      if (attemptGapMs > remaining()) return exhausted
      await wait(attemptGapMs)
    }
    let result = await once(effort)
    for (const delay of retryDelays) {
      // Out of budget: keep the answer already collected rather than replacing
      // a real upstream reply with a clock reading.
      if (!isRetryable(result) || delay > remaining()) return result
      await wait(delay)
      if (remaining() <= 0) return result
      result = await once(effort)
    }
    return result
  }

  // 1. Baseline: proves the request path itself is sound. Without this a 400
  //    on the sentinel could just as well be an unrelated request problem.
  const baseline = await attempt(undefined)
  if (!isAcceptance(baseline)) {
    return { validation: 'unknown', efforts: [], requests, reason: unknownReason('baseline', baseline) }
  }

  // 2. Sentinel: the only step that can distinguish "validates the field" from
  //    "accepts anything".
  const probe = sentinel()
  const sentinelAttempt = await attempt(probe)
  if (isAcceptance(sentinelAttempt)) {
    // The upstream took a value that cannot exist. Any per-level acceptance
    // would be equally meaningless, so stop here rather than spend more
    // requests producing false positives.
    return { validation: 'non-validating', efforts: [], requests }
  }
  if (!isEffortRejection(sentinelAttempt, region)) {
    return { validation: 'unknown', efforts: [], requests, reason: unknownReason('sentinel', sentinelAttempt) }
  }

  // 3. Levels: meaningful only because the sentinel was refused.
  const accepted: WorkBuddyEffort[] = []
  for (const effort of candidates) {
    const levelAttempt = await attempt(effort)
    if (isAcceptance(levelAttempt)) {
      accepted.push(effort)
      continue
    }
    if (isEffortRejection(levelAttempt, region)) continue
    // A non-decisive answer mid-sweep: the partial list is not a finding, so
    // report the whole run as unknown rather than under-claiming a model.
    return {
      validation: 'unknown',
      efforts: [],
      requests,
      reason: unknownReason(`level ${effort}`, levelAttempt),
    }
  }

  return { validation: 'validating', efforts: accepted, requests }
}
