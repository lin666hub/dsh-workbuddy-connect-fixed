const { test } = require('node:test')
const assert = require('node:assert/strict')
const { needsLog, run, marker } = require('./install-issue-reply.cjs')
const issue = {
  title: '[dsh-plugin.org | dsh-plugin-hub] plugin install failed: corrinehu/dsh-workbuddy-connect',
  body: '本错误信息由 dsh-plugin-hub 插件市场的安装程序自动生成。\n\n## Error (core)\n\n```\ndsh: plugin command failed; diagnostics: C:\\Users\\test\\pnpm.log\n```',
}
test('recognizes known generic reports, including CRLF and distribution reports', () => {
  assert.equal(needsLog(issue), true)
  assert.equal(needsLog({ ...issue, body: issue.body.replaceAll('\n', '\r\n') }), true)
  assert.equal(needsLog({ ...issue, title: issue.title.replace('install failed', 'distribution incomplete') }), true)
})
test('leaves actual errors, unknown formats, normal issues and PRs for manual review', () => {
  for (const candidate of [
    { ...issue, title: 'Installation failed' },
    { ...issue, body: 'No log' },
    { ...issue, pull_request: {} },
    { ...issue, body: issue.body.replace('dsh: plugin command failed;', 'ERR_PNPM_FETCH_404\ndsh: plugin command failed;') },
    { ...issue, body: issue.body.replace('Error (core)', 'Other error') },
  ]) assert.equal(needsLog(candidate), false)
})
test('posts approved text once; bot marker prevents duplicates', async () => {
  const posts = []
  const comments = []
  const github = {
    rest: { issues: { listComments: {}, createComment: async data => posts.push(data) } },
    paginate: async () => comments,
  }
  const context = { repo: { owner: 'owner', repo: 'repo' }, issue: { number: 175 }, payload: { issue } }
  await run({ github, context })
  assert.equal(posts.length, 1)
  assert.equal(posts[0].issue_number, 175)
  assert.match(posts[0].body, /请先隐藏令牌、密码/)
  comments.push({ user: { type: 'Bot' }, body: posts[0].body })
  await run({ github, context })
  assert.equal(posts.length, 1)
  comments[0].user.type = 'User'
  await run({ github, context })
  assert.equal(posts.length, 2)
  assert.ok(posts[0].body.includes(marker))
})
test('does not access GitHub for unrelated reports', async () => {
  await run({ github: {}, context: { payload: { issue: { title: 'Bug' } } } })
})
