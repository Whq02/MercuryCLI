import { getAttributionTexts } from './attribution.js'
import { shouldIncludeGitInstructions } from './gitSettings.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'

export function gitRulesText(): string {
  if (!shouldIncludeGitInstructions()) return ''
  const attribution = getAttributionTexts()
  const lines: string[] = []
  lines.push(
    `Git in this repository: commit only when the user asks for one, and never push unless asked. Never change the git config. A failing hook is investigated and fixed, never skipped (no \`--no-verify\`, no \`--no-gpg-sign\`); after a failed pre-commit hook there is no new commit, so the fix lands in a fresh commit, never an amend. Amend, force-push, \`reset --hard\`, \`checkout .\`, \`restore .\`, \`clean -f\` and \`branch -D\` only on an explicit ask. Stage named files, never \`git add -A\` or \`git add .\`; \`git status\` never with \`-uall\`; nothing staged means no commit. Git's interactive \`-i\` flag and \`rebase --no-edit\` do not work here, and a commit message travels in a quoted heredoc${attribution.commit ? ' with the attribution trailer' : ''}:`,
  )
  lines.push(`\`\`\`\ngit commit -m "$(cat <<'EOF'\n<the subject line>\n${attribution.commit ? `\n${attribution.commit}\n` : ''}EOF\n)"\n\`\`\``)
  lines.push(
    `GitHub work — issues, pull requests, checks, releases, a GitHub URL — goes through \`gh\` run by the ${BASH_TOOL_NAME} tool; a pull request's body is a heredoc too${attribution.pr ? `, ending with \`${attribution.pr}\`` : ''}, and the user gets the PR URL to open.`,
  )
  return lines.join('\n\n')
}
