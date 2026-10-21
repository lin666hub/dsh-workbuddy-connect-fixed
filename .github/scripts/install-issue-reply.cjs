const marker = '<!-- install-log-request:v1 -->'
const reply = `感谢反馈。这份自动报告目前只有安装失败提示和本机日志路径，还看不到具体原因。

请打开报告中 \`diagnostics:\` 指向的 \`pnpm.log\`，贴出第一处具体错误及前后几行；如果方便，也可以上传脱敏后的日志。请先隐藏令牌、密码等敏感信息。

暂时不需要反复重装，也请不要绕过版本兼容检查。补充日志后我们再继续排查。若 3 天内没有回复，本报告会先自动关闭；之后仍可补充信息留言。

${marker}`

function needsLog(issue) {
  if (issue.pull_request || !/^\[dsh-plugin\.org \| dsh-plugin-hub\] plugin (?:install failed|distribution incomplete):/i.test(issue.title ?? '')) return false
  const body = issue.body ?? ''
  if (!body.includes('本错误信息由') || !body.includes('安装程序自动生成')) return false
  // Only recognize the known generic error block. Unknown formats stay manual.
  const error = body.match(/^## Error \(core\)\s*\r?\n\s*```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/m)?.[1].trim()
  return !!error && /^dsh: plugin command failed; diagnostics: [^\r\n]*pnpm\.log$/i.test(error)
}

async function run({ github, context }) {
  if (!needsLog(context.payload.issue)) return
  const params = { ...context.repo, issue_number: context.issue.number }
  const comments = await github.paginate(github.rest.issues.listComments, { ...params, per_page: 100 })
  if (comments.some(comment => comment.user?.type === 'Bot' && comment.body?.includes(marker))) return
  await github.rest.issues.createComment({ ...params, body: reply })
}

module.exports = { needsLog, run, marker }
