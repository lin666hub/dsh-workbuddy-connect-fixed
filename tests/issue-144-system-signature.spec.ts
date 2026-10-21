import { describe, expect, it } from 'vitest'

import {
  hasRejectedSystemSignature,
  neutralizeRejectedSystemSignature,
  prepareChatBody,
  prepareCnChatBody,
} from '../src/upstream.ts'

/**
 * The WorkBuddy gateway runs a channel check on the opening of the system
 * message and refuses a request whose system prompt opens with a rival
 * client's identity line: HTTP 400 / code 11128, `displayMsg.zh`
 * 「请求被拦截，请重新发送」.
 *
 * These tests pin the neutralization that keeps a DeepSeek Harness session
 * usable against WorkBuddy: the harness' own system prompt opens with
 * "You are an AI agent powered by DeepSeek Harness.", which the gateway
 * refuses.
 */
const HARNESS_OPENING = 'You are an AI agent powered by DeepSeek Harness.'
const HARNESS_PROMPT = `${HARNESS_OPENING} You are a coding agent powered by the deepseek-flash model.`

describe('rejected system signature', () => {
  it('recognises the harness opening in a string body', () => {
    expect(hasRejectedSystemSignature(HARNESS_OPENING)).toBe(true)
    expect(hasRejectedSystemSignature(HARNESS_PROMPT)).toBe(true)
    expect(hasRejectedSystemSignature(`  ${HARNESS_OPENING}`)).toBe(true)
  })

  it('recognises the harness opening in a text-block body', () => {
    expect(hasRejectedSystemSignature([{ type: 'text', text: HARNESS_OPENING }])).toBe(true)
  })

  it('does not flag ordinary system prompts', () => {
    expect(hasRejectedSystemSignature('You are a helpful assistant.')).toBe(false)
    expect(hasRejectedSystemSignature('DeepSeek Harness')).toBe(false)
    expect(hasRejectedSystemSignature('You are an AI agent powered by DeepSeek.')).toBe(false)
    expect(hasRejectedSystemSignature(undefined)).toBe(false)
    expect(hasRejectedSystemSignature([{ type: 'image_url', image_url: {} }])).toBe(false)
  })
})

describe('neutralizeRejectedSystemSignature', () => {
  it('keeps the prompt body and only prepends a harmless opening', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'system', content: HARNESS_PROMPT },
        { role: 'user', content: 'hi' },
      ],
    }
    neutralizeRejectedSystemSignature(body)
    const messages = body['messages'] as Array<Record<string, unknown>>
    const content = String(messages[0]!['content'])
    expect(content.startsWith('You are a helpful assistant.\n\n')).toBe(true)
    expect(content.endsWith(HARNESS_PROMPT)).toBe(true)
    expect(messages[1]!['content']).toBe('hi')
  })

  it('handles a text-block system message', () => {
    const body: Record<string, unknown> = {
      messages: [{ role: 'system', content: [{ type: 'text', text: HARNESS_PROMPT }] }],
    }
    neutralizeRejectedSystemSignature(body)
    const messages = body['messages'] as Array<Record<string, unknown>>
    const blocks = messages[0]!['content'] as Array<Record<string, unknown>>
    expect(String(blocks[0]!['text']).startsWith('You are a helpful assistant.\n\n')).toBe(true)
    expect(String(blocks[0]!['text']).endsWith(HARNESS_PROMPT)).toBe(true)
  })

  it('leaves an ordinary system prompt untouched', () => {
    const body: Record<string, unknown> = {
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
    }
    neutralizeRejectedSystemSignature(body)
    const messages = body['messages'] as Array<Record<string, unknown>>
    expect(messages[0]!['content']).toBe('You are a helpful assistant.')
  })

  it('only touches the first system message', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'system', content: HARNESS_PROMPT },
      ],
    }
    neutralizeRejectedSystemSignature(body)
    const messages = body['messages'] as Array<Record<string, unknown>>
    expect(messages[2]!['content']).toBe(HARNESS_PROMPT)
  })
})

describe('prepareChatBody', () => {
  it('neutralizes a rejected system signature', () => {
    const wire = JSON.parse(
      prepareChatBody(JSON.stringify({ messages: [{ role: 'system', content: HARNESS_PROMPT }] })),
    ) as { messages: Array<{ content: string }> }
    expect(wire.messages[0]!.content.startsWith('You are a helpful assistant.\n\n')).toBe(true)
  })
})

describe('prepareCnChatBody', () => {
  it('applies the same channel-check defences as the international wire', () => {
    const wire = JSON.parse(
      prepareCnChatBody(
        JSON.stringify({
          messages: [
            { role: 'developer', content: HARNESS_PROMPT },
            { role: 'user', content: 'hi' },
          ],
        }),
      ),
    ) as { messages: Array<{ role: string; content: string }> }
    expect(wire.messages[0]!.role).toBe('system')
    expect(wire.messages[0]!.content.startsWith('You are a helpful assistant.\n\n')).toBe(true)
  })
})
