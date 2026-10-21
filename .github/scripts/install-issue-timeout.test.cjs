const { test } = require('node:test')
const assert = require('node:assert/strict')
const { shouldClose, run, WAIT_MS, closeMarker } = require('./install-issue-timeout.cjs')
const { marker } = require('./install-issue-reply.cjs')
const start = Date.parse('2026-10-20T00:00:00Z')
const stamp = offset => new Date(start + offset).toISOString()
const issue = {
  number: 1, state: 'open', updated_at: stamp(0),
  title: '[dsh-plugin.org | dsh-plugin-hub] plugin install failed: corrinehu/plugin',
  body: '本错误信息由安装程序自动生成。\n## Error (core)\n\n```\ndsh: plugin command failed; diagnostics: C:\\test\\pnpm.log\n```',
}
const request = { user: { type: 'Bot', login: 'github-actions[bot]' }, body: marker, created_at: stamp(0) }
test('waits a full 72 hours from the CI request, including exact boundary', () => {
  assert.equal(shouldClose(issue, [request], start + WAIT_MS - 1), false)
  assert.equal(shouldClose(issue, [request], start + WAIT_MS), true)
})
test('requires the trusted CI request, not a human or another bot marker', () => {
  for (const user of [{ type: 'User', login: 'owner' }, { type: 'Bot', login: 'other[bot]' }]) {
    assert.equal(shouldClose(issue, [{ ...request, user }], start + WAIT_MS), false)
  }
  assert.equal(shouldClose(issue, [], start + WAIT_MS), false)
})
test('any human response or edited human comment prevents closure', () => {
  for (const extra of [
    { user: { type: 'User' }, created_at: stamp(1), body: 'Still checking' },
    { user: { type: 'User' }, created_at: stamp(-1), updated_at: stamp(1), body: 'Logs' },
  ]) assert.equal(shouldClose(issue, [request, extra], start + WAIT_MS), false)
})
test('changed body or other newer issue activity stays manual', () => {
  assert.equal(shouldClose({ ...issue, updated_at: stamp(1) }, [request], start + WAIT_MS), false)
  assert.equal(shouldClose({ ...issue, body: issue.body.replace('dsh: plugin command failed;', 'ERR_PNPM_FETCH_404\ndsh: plugin command failed;') }, [request], start + WAIT_MS), false)
})
test('normal issues, PRs, known compatibility errors, closed or locked reports are excluded', () => {
  for (const changed of [
    { title: 'Installation failed' }, { pull_request: {} }, { state: 'closed' }, { locked: true },
    { title: '[dsh-plugin.org | dsh-plugin-hub] plugin does not support the DSH version in use: corrinehu/plugin' },
    { body: 'A detailed error' },
  ]) assert.equal(shouldClose({ ...issue, ...changed }, [request], start + WAIT_MS), false)
})
test('missing or invalid timestamps fail closed', () => {
  assert.equal(shouldClose(issue, [{ ...request, created_at: 'bad' }], start + WAIT_MS), false)
  assert.equal(shouldClose({ ...issue, updated_at: undefined }, [request], start + WAIT_MS), false)
})
function harness({ current = issue, comments = [request] } = {}) {
  const calls = []
  const listForRepo = {}, listComments = {}
  const github = {
    paginate: async method => method === listForRepo ? [issue] : comments,
    rest: { issues: {
      listForRepo, listComments, get: async () => ({ data: current }),
      createComment: async args => calls.push(['comment', args]),
      update: async args => calls.push(['update', args]),
    } },
  }
  return { github, calls }
}
const context = { repo: { owner: 'owner', repo: 'repo' } }
test('defaults to dry run with zero mutations', async () => {
  const { github, calls } = harness()
  const logs = []
  await run({ github, context, now: start + WAIT_MS, log: line => logs.push(line) })
  assert.equal(logs.length, 1)
  assert.deepEqual(calls, [])
})
test('live run comments then closes as not planned', async () => {
  const { github, calls } = harness()
  await run({ github, context, dryRun: false, now: start + WAIT_MS, log: () => {} })
  assert.equal(calls[0][0], 'comment')
  assert.match(calls[0][1].body, /不代表问题已确认解决/)
  assert.equal(calls[1][1].state_reason, 'not_planned')
})
test('rechecks current state instead of closing a stale listing', async () => {
  const { github, calls } = harness({ current: { ...issue, state: 'closed' } })
  await run({ github, context, dryRun: false, now: start + WAIT_MS, log: () => {} })
  assert.deepEqual(calls, [])
})
test('does not duplicate the closure comment if the close API previously failed', async () => {
  const { github, calls } = harness({ comments: [request, { ...request, body: closeMarker, created_at: stamp(1) }] })
  await run({ github, context, dryRun: false, now: start + WAIT_MS, log: () => {} })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'update')
})

test('a human reply arriving during the closing comment prevents closure', async () => {
  const { github, calls } = harness()
  github.rest.issues.createComment = async args => {
    calls.push(['comment', args])
    github.paginate = async method => method === github.rest.issues.listForRepo ? [issue]
      : [request, { user: { type: 'User' }, created_at: stamp(1), body: 'Here are the logs' }]
  }
  await run({ github, context, dryRun: false, now: start + WAIT_MS, log: () => {} })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'comment')
})
