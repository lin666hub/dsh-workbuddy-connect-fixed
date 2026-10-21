import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

/**
 * The retry policy is a plugin-config field, so its schema is the only thing
 * standing between a hand-edited `cordis.yml` and a route that retries nothing.
 * The values here mirror the shape `dsh-llm`'s own provider configs accept.
 */
describe('retryPolicy plugin config', () => {
  it('leaves the policy unset when the config omits it', () => {
    // Undefined is meaningful: `resolveRetryPolicy(undefined)` selects the
    // dsh-llm defaults, so an existing user's config keeps its old behavior.
    expect(Config({}).retryPolicy).toBeUndefined()
  })

  it('accepts the shape a cordis.yml carries', () => {
    const config = Config({
      retryPolicy: {
        mode: 'normal',
        maxRetries: 15,
        backoff: { initialDelayMs: 2_000, maxDelayMs: 30_000 },
      },
    })
    expect(config.retryPolicy).toMatchObject({
      mode: 'normal',
      maxRetries: 15,
      backoff: { initialDelayMs: 2_000, maxDelayMs: 30_000 },
    })
  })

  it('rejects an unknown retry mode', () => {
    // `mode` is a closed set (`normal` | `always`): a typo must fail at load
    // rather than silently selecting a policy the runtime cannot execute.
    expect(() => Config({
      // @ts-expect-error 'sometimes' is not in the closed set; the runtime
      // schema, not the type checker, is what has to reject a hand-edited YAML.
      retryPolicy: { mode: 'sometimes' },
    })).toThrow()
  })
})
