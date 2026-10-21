import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import { prepareChatBody } from '../src/upstream.ts'

/**
 * Issue #118, revision-2 evidence (phase 1): a `workbuddy` tool call surfaces
 * as plain DSML text, the turn ends `completed`, and no tool is ever
 * dispatched.
 *
 * SCOPE. This suite stubs the global `fetch` that *pi-ai itself* calls, so it
 * runs the real adapter, the real dsh-llm-pi-ai conversion and the real pi-ai
 * pipeline, but it does NOT run the plugin's shim or its upstream client. What
 * it can therefore establish:
 *
 *  1. pi-ai, given tools, emits an OpenAI-style request whose `tools` array
 *     still holds them. (Not: "tools reach the WorkBuddy upstream" — nothing
 *     here talks to `createWorkBuddyShim` or `WorkBuddyUpstreamClient`. The
 *     companion suite `issue-118-shim-wire.spec.ts` carries that through the
 *     real shim and stops one hop short of the network.)
 *  2. On this seam the request carries no `tool_choice` at all. That is a fact
 *     about *this* path — pi-ai is handed no such option here. It is not a
 *     claim about every caller of the shim, which can and does receive one.
 *  3. When an upstream stream is *constructed* to contain DSML text, pi-ai
 *     consumes it as an assistant text block with finish reason `stop` and
 *     emits no tool call. That is the reported symptom's mechanism reproduced
 *     offline — with a synthesized payload, not a reported one.
 *
 * What this does NOT establish: why any real upstream would emit DSML, whether
 * the reporter's actual bytes match the sample below, or that the DSML
 * envelope in the field has this shape. Those need a real (sanitized) capture.
 */

const MODEL = 'deepseek-v4.1-flash'

/**
 * One tool in the *host* shape pi-ai expects: flat `{name, description,
 * parameters}`. pi-ai's `convertTools()` rewrites it to the OpenAI-nested
 * `{type:'function', function:{...}}` form on the wire.
 */
const SHELL_TOOL = {
  name: 'shell',
  description: 'Run a shell command',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}

/** The OpenAI-nested shape the same tool takes on the wire. */
const SHELL_TOOL_WIRE = {
  type: 'function',
  function: {
    name: 'shell',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
}

/**
 * A SYNTHESIZED DSML sample — representative, not reported.
 *
 * #118 spells exactly one marker, `<｜｜DSML｜｜ calls>`, and elides every
 * payload with `…`; it contains no `invoke`/`parameter` lines at all. So the
 * envelope below is our construction, built only on the delimiter the issue
 * does show (U+FF5C FULLWIDTH VERTICAL LINE, `｜`). Which fields a real DSML
 * call uses, and their exact ordering, is unverified.
 */
const SYNTHETIC_DSML_TEXT = [
  '<｜｜DSML｜｜tool_calls>',
  '<｜｜DSML｜｜invoke name="shell">',
  '<｜｜DSML｜｜parameter name="command">echo hi</｜｜DSML｜｜parameter>',
  '</｜｜DSML｜｜invoke>',
  '</｜｜DSML｜｜tool_calls>',
].join('\n')

function adapter() {
  const catalog = new WorkBuddyCatalog([{
    id: MODEL, name: 'DeepSeek V4.1 Flash', contextWindow: 128_000, maxTokens: 128_000,
    supportsImages: false, billing: { free: false },
  }])
  return createWorkBuddyAdapter({
    catalog,
    store: {} as WorkBuddyCredentialStore,
    shim: {
      ready: Promise.resolve(),
      baseUrl: () => 'http://127.0.0.1:1',
      token: () => 'test-token',
      close: async () => {},
    } as WorkBuddyShim,
  }).adapter
}

/**
 * Drive one turn through the real adapter + real dsh-llm-pi-ai + real pi-ai
 * pipeline, capturing the request pi-ai builds and the chunks the host would
 * consume. The shim object below is a stub that is never contacted: the global
 * `fetch` is replaced before pi-ai can reach it. See the file header for what
 * this does and does not establish.
 */
async function runTurn(options: {
  tools?: unknown[]
  sse: string
}): Promise<{ body: Record<string, unknown>, chunks: unknown[] }> {
  let body: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(options.sse, { headers: { 'content-type': 'text/event-stream' } })
  }))
  const call = await adapter().prepareCall(WORKBUDDY_PROVIDER, MODEL)
  const chunks: unknown[] = []
  for await (const chunk of call.stream({
    provider: WORKBUDDY_PROVIDER,
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'run echo hi' }], source: { kind: 'user' } }],
    tools: options.tools,
  } as never)) {
    chunks.push(chunk)
  }
  return { body: body ?? {}, chunks }
}

/** An SSE stream whose assistant text is the DSML envelope, then a normal stop. */
function dsmlSse(): string {
  const frames = [
    { choices: [{ index: 0, delta: { content: SYNTHETIC_DSML_TEXT } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
  return frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
}

afterEach(() => vi.unstubAllGlobals())

describe('#118 evidence: pi-ai emits caller tools', () => {
  it('puts the caller tools in the request it builds', async () => {
    const { body } = await runTurn({ tools: [SHELL_TOOL], sse: dsmlSse() })
    // pi-ai's convertTools() rewrote the host shape into the OpenAI-nested one.
    // Scope: this is the request pi-ai hands to `fetch` on this seam. Whether a
    // real upstream receives it is covered by issue-118-shim-wire.spec.ts.
    expect(body['tools']).toEqual([SHELL_TOOL_WIRE])
  })

  it('emits no tool_choice when the seam gives it none', async () => {
    // On this path pi-ai is handed no tool_choice: dsh-llm-pi-ai's piContext()
    // builds only {systemPrompt, messages, tools}. So one report hypothesis
    // ("tool_choice 正规化坏了导致 tools 被丢") has no input to act on *here*.
    // The shim does receive tool_choice from other callers, and normalization
    // for those is exercised by prepare.spec.ts / shim.spec.ts.
    const { body } = await runTurn({ tools: [SHELL_TOOL], sse: dsmlSse() })
    expect('tool_choice' in body).toBe(false)
    expect(body['tools']).toEqual([SHELL_TOOL_WIRE])
  })

  it('normalizes the tool_choice spellings it is given without dropping tools', () => {
    // Unit-level: covers the shim's own normalizer directly, independent of
    // whether the host seam ever produces these inputs.
    const cases: [unknown, string | undefined][] = [
      [{ type: 'auto' }, 'auto'],
      [{ type: 'required' }, 'required'],
      [{ type: 'function', function: { name: 'grep' } }, 'grep'],
      [{ type: 'weird' }, undefined],
    ]
    const wireTools = [SHELL_TOOL_WIRE]
    for (const [input, expected] of cases) {
      const body = JSON.parse(prepareChatBody(JSON.stringify({ tools: wireTools, tool_choice: input }))) as Record<string, unknown>
      expect(body['tool_choice']).toBe(expected)
      // Whatever tool_choice normalizes to, the tool definitions survive.
      expect(body['tools']).toEqual(wireTools)
    }
  })
})

describe('#118 evidence: a synthesized DSML response is consumed as text', () => {
  it('yields text and a stop finish reason instead of a tool call', async () => {
    const { chunks } = await runTurn({ tools: [SHELL_TOOL], sse: dsmlSse() })

    const types = chunks.map(chunk => (chunk as { type?: string }).type)
    const text = chunks
      .filter(chunk => (chunk as { type?: string }).type === 'text-delta')
      .map(chunk => (chunk as { text?: string }).text)
      .join('')

    // Given a stream constructed to carry DSML text, pi-ai delivers it as
    // assistant text and nothing else — no tool-call block, no dispatch. This
    // is the reported symptom's mechanism, demonstrated with a sample we built.
    expect(text).toBe(SYNTHETIC_DSML_TEXT)
    expect(types).not.toContain('tool-call')
    expect(types).not.toContain('tool-input-start')

    // A `stop` finish is what the host turns into `turn/end {kind:"completed"}`,
    // the "fake success" the reporter described.
    const finish = chunks.at(-1) as { type?: string, reason?: { kind?: string } }
    expect(finish.type).toBe('finish')
    expect(finish.reason?.kind).toBe('stop')
  })

  it('replays DSML as a text block, consistent with the reported session log', async () => {
    // The reporter logged replayState.blocks = [reasoning, text]. With no
    // reasoning in this constructed stream, the text block alone is the tell.
    // Consistency with the report — not confirmation of its exact bytes.
    const { chunks } = await runTurn({ tools: [SHELL_TOOL], sse: dsmlSse() })
    const finish = chunks.at(-1) as { replayState?: { blocks?: { type?: string }[], response?: { stopReason?: string } } }
    expect(finish.replayState?.response?.stopReason).toBe('stop')
    expect(finish.replayState?.blocks).toEqual([{ type: 'text' }])
  })

  it('carries the synthetic DSML text through unmodified', async () => {
    // No DSML handling exists in the plugin, so the sample must arrive exactly
    // as authored — no normalization, no stripping. (Byte fidelity through the
    // real shim is asserted in issue-118-shim-wire.spec.ts.)
    const { chunks } = await runTurn({ tools: [SHELL_TOOL], sse: dsmlSse() })
    const text = chunks
      .filter(chunk => (chunk as { type?: string }).type === 'text-delta')
      .map(chunk => (chunk as { text?: string }).text)
      .join('')
    expect(text).toContain('<｜｜DSML｜｜tool_calls>')
    expect(text).toContain('invoke name="shell"')
    expect(text).toContain('echo hi')
  })
})
