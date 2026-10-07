import { getAttributionTexts } from './attribution.js'
import { shouldIncludeGitInstructions } from './gitSettings.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'

export function gitRulesText(): string {
  if (!shouldIncludeGitInstructions()) return ''
  const attribution = getAttributionTexts()
  const lines: string[] = []
  lines.push(
    'For git commands: prefer creating a new commit over amending; consider a safer alternative before any destructive operation (`git reset --hard`, `git push --force`, `git checkout --`); never skip hooks (`--no-verify`) or bypass signing (`--no-gpg-sign`, or an inline config disabling gpg signing) unless explicitly asked, and investigate a hook failure rather than working around it.',
  )
  lines.push('# Committing changes with git')
  lines.push('Only create a commit when the user asks for one; if it is unclear, ask first.')
  lines.push(
    'You may issue several tool calls in one response; batch independent commands that are likely to succeed in parallel.',
  )
  lines.push(
    'Git safety protocol: never update git config; never run a destructive git command (`push --force`, `reset --hard`, `checkout .`, `restore .`, `clean -f`, `branch -D`) unless explicitly asked; never bypass hooks (`--no-verify`, `--no-gpg-sign`); never force-push to `main`/`master`, and warn when asked to; amend only on an explicit request — otherwise every commit is a NEW one (after a failed pre-commit hook there IS no new commit, so an amend would rewrite the previous one and can destroy work); stage named files rather than the sweep-everything forms `git add -A`/`git add .`, which drag in secrets and large binaries; commit only when asked.',
  )
  lines.push(
    `Commit workflow: (1) in parallel, run \`git status\` (never with \`-uall\`, which can exhaust memory on large repos), a diff of staged and unstaged changes, and a log to learn the repository's message style, each through the ${BASH_TOOL_NAME} tool; (2) read every staged change and compose the message, choosing the verb correctly (add = wholly new, update = an enhancement, fix = a bug fix), avoiding likely-secret files (\`.env\`, \`credentials.json\`) and warning if the user asks for them, keeping the message to one or two sentences focused on WHY; (3) in parallel, stage the relevant untracked files and create the commit${attribution.commit ? ' with the attribution trailer appended' : ''}, then run \`git status\` sequentially after the commit to verify; (4) on a pre-commit hook failure, fix the problem and create a NEW commit.`,
  )
  lines.push(
    `Never run additional exploration commands beyond the git ones; never create tasks or launch agents from here; do not push unless asked; never use git's interactive \`-i\` flag (rebase/add), since interactive input is unsupported; do not pass \`--no-edit\` to \`git rebase\`; nothing staged means no commit at all (never an empty one); the commit message always travels in a quoted heredoc.`,
  )
  if (attribution.commit) {
    lines.push('Worked example (heredoc form with the attribution trailer):\n```\ngit commit -m "$(cat <<\'EOF\'\nfix: correct the off-by-one in the parser\n\n' + attribution.commit + '\nEOF\n)"\n```')
  }
  lines.push('# Creating pull requests')
  lines.push(
    `Every GitHub task — issues, pull requests, checks, releases, resolving a GitHub URL — goes through \`gh\` run by the ${BASH_TOOL_NAME} tool.`,
  )
  lines.push(
    'PR workflow: (1) in parallel, run status (again never `-uall`), a diff, a check of whether the branch tracks a remote and is up to date, and both a log and a three-dot diff against the base branch to see the whole branch history; (2) read every commit the PR will carry, not only the newest, and draft a title under 70 characters with the detail in the body; (3) in parallel, create the branch if needed, push with `-u` if needed, and create the PR with `gh pr create` using a heredoc body.',
  )
  lines.push(
    'Worked example (PR body):\n```\ngh pr create --title "Fix the parser off-by-one" --body "$(cat <<\'EOF\'\n## Summary\n- corrects the boundary in the token walk\n- adds a regression test\n\n## Test plan\n- [ ] unit tests pass\n- [ ] manual check on the sample corpus' + (attribution.pr ? '\n\n' + attribution.pr : '') + '\nEOF\n)"\n```',
  )
  lines.push(
    `Task items and agent launches stay out of this flow; finish by handing the user the PR URL to open.`,
  )
  lines.push(
    'Other common operations: view PR comments through `gh api repos/<owner>/<repo>/pulls/<number>/comments`.',
  )
  return lines.join('\n\n')
}
