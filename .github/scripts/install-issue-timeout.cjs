const { needsLog, marker } = require('./install-issue-reply.cjs')

const WAIT_MS = 72 * 60 * 60 * 1000
const closeMarker = '<!-- install-log-timeout:v1 -->'
const closeReply = `此前已请求补充具体错误日志，超过 3 天仍未收到回复，暂时无法继续定位，先关闭整理。

若问题仍存在，欢迎补充脱敏后的错误文本并留言，我们会重新评估。本次关闭不代表问题已确认解决。

${closeMarker}`

function isActionsBot(comment) {
  return comment.user?.type === 'Bot' && comment.user.login === 'github-actions[bot]'
}

function shouldClose(issue, comments, now = Date.now()) {
  if (issue.state !== 'open' || issue.locked || !needsLog(issue)) return false
  const request = comments.find(comment => isActionsBot(comment) && comment.body?.includes(marker))
  if (!request) return false
  const requestedAt = Date.parse(request.created_at)
  if (!Number.isFinite(requestedAt) || now - requestedAt < WAIT_MS) return false
  // Any human response is enough to leave the issue for manual review.
  if (comments.some(comment => comment.user?.type !== 'Bot'
    && Date.parse(comment.updated_at ?? comment.created_at) >= requestedAt)) return false
  // Body edits and other changes without a matching comment are also manual.
  const lastCommentAt = Math.max(...comments.map(comment => Date.parse(comment.updated_at ?? comment.created_at)))
  if (!Number.isFinite(lastCommentAt) || !Number.isFinite(Date.parse(issue.updated_at))
    || Date.parse(issue.updated_at) > lastCommentAt) return false
  return true
}

async function run({ github, context, dryRun = true, now = Date.now(), log = console.log }) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: 'open', per_page: 100,
  })
  for (const candidate of issues) {
    if (!needsLog(candidate)) continue
    const params = { ...context.repo, issue_number: candidate.number }
    // Re-read rather than trusting the listing: someone may have replied or edited.
    const { data: issue } = await github.rest.issues.get(params)
    const comments = await github.paginate(github.rest.issues.listComments, { ...params, per_page: 100 })
    if (!shouldClose(issue, comments, now)) continue
    log(`${dryRun ? 'Would close' : 'Closing'} #${candidate.number}`)
    if (dryRun) continue
    if (!comments.some(comment => isActionsBot(comment) && comment.body?.includes(closeMarker))) {
      await github.rest.issues.createComment({ ...params, body: closeReply })
    }
    // A reply arriving while the closing comment was posted must also win.
    const { data: latest } = await github.rest.issues.get(params)
    const latestComments = await github.paginate(github.rest.issues.listComments, { ...params, per_page: 100 })
    if (!shouldClose(latest, latestComments, now)) continue
    await github.rest.issues.update({ ...params, state: 'closed', state_reason: 'not_planned' })
  }
}

module.exports = { shouldClose, run, WAIT_MS, closeMarker }
