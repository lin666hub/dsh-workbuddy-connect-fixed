import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/**
 * Issue #118, revision-2 evidence: where exactly do `tools` survive on the way
 * to the upstream, and where does the DSML text come out?
 *
 * Revision 1 stubbed the global `fetch` that pi-ai itself calls, so it never
 * exercised the plugin's own shim — it could only show what pi-ai *would* send.
 * This suite closes that gap by chaining the real pieces over real loopback
 * HTTP:
 *
 *   adapter → pi-ai → (real HTTP to) createWorkBuddyShim → chatStream(client)
 *
 * Only the upstream client is a double: the harness replaces the
 * `client.chatStream` method itself. That method is where the real
 * `WorkBuddyUpstreamClient` would build and POST the HTTP request — its
 * internal `fetch`, `prepareCnChatBody` / `prepareInternationalChatBody`,
 * endpoints and headers never run here. So the bodies captured below are the
 * bodies **handed to `client.chatStream`'s `bodyJson` parameter, after the
 * shim's own `prepareChatBody()`**, which is exactly what the shim is
 * responsible for producing. They are *not* proof of the bytes a real
 * WorkBuddy POST would carry, because that last transformation is stubbed out.
 *
 * What this proves: `tools` survive pi-ai → shim → the `client.chatStream`
 * input verbatim, and a DSML-shaped upstream stream is relayed byte-for-byte
 * and consumed by pi-ai as assistant text with `stop`.
 * What it does NOT prove: that a real WorkBuddy POST body carries the same
 * bytes, why a real upstream would emit DSML, or that any real upstream
 * response has this shape. See the analysis doc.
 */

const MODEL = 'deepseek-v4.1-flash'

/** Host-shaped tool (flat), as the Harness LLM seam defines it. */
const SHELL_TOOL = {
  name: 'shell',
  description: 'Run a shell command',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}

/** The OpenAI-nested form the same tool takes once pi-ai serializes it. */
const SHELL_TOOL_WIRE = {
  type: 'function',
  function: {
    name: 'shell',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
}

/**
 * A *synthesized* DSML sample. The issue body elides the payload with `…` and
 * spells only `<｜｜DSML｜｜ calls>`; there is no verbatim sample in #118, so
 * this is representative, not reported. The delimiter is U+FF5C FULLWIDTH
 * VERTICAL LINE, matching the marker the issue does spell out.
 */
const SYNTHETIC_DSML = [
  '<｜｜DSML｜｜tool_calls>',
  '<｜｜DSML｜｜invoke name="shell">',
  '<｜｜DSML｜｜parameter name="command">echo hi</｜｜DSML｜｜parameter>',
  '</｜｜DSML｜｜invoke>',
  '</｜｜DSML｜｜tool_calls>',
].join('\n')

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

interface Harness {
  shim: WorkBuddyShim
  catalog: WorkBuddyCatalog
  /** Bodies the real shim handed to the upstream client, after preparation. */
  upstreamBodies: string[]
  credentials: WorkBuddyCredential[]
}

/** Start the real shim with a fake upstream client that captures bodies. */
async function startHarness(upstream: () => WorkBuddyChatResult): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-118-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const desktop = join(dir, 'workbuddy-desktop.info')
  await writeFile(desktop, JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1' },
  }))
  const store = new WorkBuddyCredentialStore({
    desktopPath: desktop,
    ownPath: join(dir, 'own.json'),
    refresh: async () => ({ accessToken: 'unused' }),
  })
  const catalog = new WorkBuddyCatalog([{
    id: MODEL, name: 'DeepSeek V4.1 Flash', contextWindow: 128_000, maxTokens: 128_000,
    supportsImages: false, billing: { free: false },
  }])
  const harness: Harness = {
    shim: undefined as unknown as WorkBuddyShim,
    catalog,
    upstreamBodies: [],
    credentials: [],
  }
  harness.shim = createWorkBuddyShim({
    store,
    catalog,
    client: {
      async chatStream(credential: WorkBuddyCredential, bodyJson: string): Promise<WorkBuddyChatResult> {
        harness.credentials.push(credential)
        harness.upstreamBodies.push(bodyJson)
        return upstream()
      },
    },
  })
  await harness.shim.ready
  CLEANUP.push(() => harness.shim.close())
  return harness
}

/** A 200 SSE result carrying the synthetic DSML text, then a normal stop. */
function dsmlResult(): WorkBuddyChatResult {
  const frames = [
    { choices: [{ index: 0, delta: { content: SYNTHETIC_DSML } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
  const sse = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
  return {
    ok: true,
    response: new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  }
}

function adapterFor(harness: Harness) {
  return createWorkBuddyAdapter({
    catalog: harness.catalog,
    store: {} as WorkBuddyCredentialStore,
    shim: harness.shim,
  }).adapter
}

/**
 * Drive one turn through adapter → pi-ai → real shim → upstream client.
 * Nothing but the upstream client's HTTP hop and the credential store are
 * doubled; the loopback request is real.
 */
async function runThroughShim(harness: Harness, options: { tools?: unknown[] }): Promise<unknown[]> {
  const call = await adapterFor(harness).prepareCall(WORKBUDDY_PROVIDER, MODEL)
  const chunks: unknown[] = []
  for await (const chunk of call.stream({
    provider: WORKBUDDY_PROVIDER,
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'run echo hi' }], source: { kind: 'user' } }],
    tools: options.tools,
  } as never)) {
    chunks.push(chunk)
  }
  return chunks
}

describe('#118 rev2: tools survive pi-ai → shim → client.chatStream input', () => {
  it('arrives at the client.chatStream input intact through the real shim', async () => {
    const harness = await startHarness(dsmlResult)
    await runThroughShim(harness, { tools: [SHELL_TOOL] })

    expect(harness.upstreamBodies).toHaveLength(1)
    const body = JSON.parse(harness.upstreamBodies[0] as string) as Record<string, unknown>

    // The `bodyJson` handed to the (doubled) client.chatStream, after the real
    // shim ran prepareChatBody() over it. The client's own HTTP step — its
    // fetch, per-region body prep, endpoints and headers — is stubbed out, so
    // this is the shim's output, not a verified WorkBuddy POST body.
    expect(body['tools']).toEqual([SHELL_TOOL_WIRE])
    expect(body['stream']).toBe(true)
    expect(body['model']).toBe(MODEL)
  })

  it('carries the shim-side body preparation, not a raw passthrough', async () => {
    const harness = await startHarness(dsmlResult)
    await runThroughShim(harness, { tools: [SHELL_TOOL] })

    const body = JSON.parse(harness.upstreamBodies[0] as string) as Record<string, unknown>
    // prepareChatBody() forces streaming; proof the real shim ran, not a stub.
    expect(body['stream']).toBe(true)
    // The host LLM seam has no tool_choice field, so pi-ai never emits one and
    // the shim's normalization has nothing to rewrite on this path. Stated as
    // a fact about this path only — not about every caller of the shim.
    expect('tool_choice' in body).toBe(false)
    // The credential the shim resolved came from the store, not from pi-ai.
    expect(harness.credentials[0]?.accessToken).toBe('at')
  })

  it('keeps tools byte-stable across two rounds', async () => {
    const harness = await startHarness(dsmlResult)
    await runThroughShim(harness, { tools: [SHELL_TOOL] })
    await runThroughShim(harness, { tools: [SHELL_TOOL] })

    expect(harness.upstreamBodies).toHaveLength(2)
    for (const raw of harness.upstreamBodies) {
      const body = JSON.parse(raw) as Record<string, unknown>
      expect(body['tools']).toEqual([SHELL_TOOL_WIRE])
    }
  })
})

describe('#118 rev2: the shim relays a DSML stream faithfully', () => {
  it('delivers the synthetic DSML text as assistant text with stop', async () => {
    const harness = await startHarness(dsmlResult)
    const chunks = await runThroughShim(harness, { tools: [SHELL_TOOL] })

    const types = chunks.map(chunk => (chunk as { type?: string }).type)
    const text = chunks
      .filter(chunk => (chunk as { type?: string }).type === 'text-delta')
      .map(chunk => (chunk as { text?: string }).text)
      .join('')

    // The shim does not interpret the payload: what the (doubled) upstream
    // sent is what pi-ai consumed.
    expect(text).toBe(SYNTHETIC_DSML)
    expect(types).not.toContain('tool-call')
    expect(types).not.toContain('tool-input-start')

    const finish = chunks.at(-1) as { type?: string, reason?: { kind?: string } }
    expect(finish.type).toBe('finish')
    expect(finish.reason?.kind).toBe('stop')
  })

  it('does not inject or rewrite DSML markers anywhere in the text', async () => {
    const harness = await startHarness(dsmlResult)
    const chunks = await runThroughShim(harness, { tools: [SHELL_TOOL] })
    const text = chunks
      .filter(chunk => (chunk as { type?: string }).type === 'text-delta')
      .map(chunk => (chunk as { text?: string }).text)
      .join('')

    // Guard: the plugin contains no DSML handling at all, so the surrogate
    // pair must arrive exactly as authored — no normalization, no stripping.
    expect(text).toContain('<｜｜DSML｜｜tool_calls>')
    expect(text).toContain('invoke name="shell"')
    expect(text.split('｜｜DSML｜｜').length - 1).toBe(3 + 3)
  })
})
