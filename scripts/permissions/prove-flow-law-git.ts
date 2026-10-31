#!/usr/bin/env bun
import { ROADS, allowedByFlow, asksWith, check, finish, j, openKit, refusedWith, section, sentence } from './flowLawKit.ts'

const kit = await openKit('flow-law-git')
const PUSH = 'Flow asks before git push: it publishes history.'

try {
  section('§1 item 2 asks: a push in any form, a hard reset, a forced clean, a forced branch delete, a history rewrite, and their gh equivalents')
  const asks: Array<[string, string]> = [
    ['git push', PUSH],
    ['git push origin main', PUSH],
    ['git push --force origin topic', PUSH],
    ['git push --force-with-lease', PUSH],
    ['git push --dry-run', PUSH],
    ['git push -u origin HEAD', PUSH],
    ['git -C /tmp/repo push origin topic', PUSH],
    ['git --git-dir=.git push origin topic', PUSH],
    ['env CI=1 git push origin topic', PUSH],
    ['git status && git push origin topic', PUSH],
    ['git add . && git commit -m wip && git push', PUSH],
    ['git push -q 2>&1 | tail -1; git status -sb | head -1', PUSH],
    ['bash -c "git push origin topic"', PUSH],
    ['f() { git push; }; f', PUSH],
    ['for r in origin backup; do git push $r main; done', PUSH],
    ['git reset --hard', 'Flow asks before git reset --hard: it rewrites history.'],
    ['git reset --hard HEAD~1', 'Flow asks before git reset --hard: it rewrites history.'],
    ['git clean -fdx', 'Flow asks before git clean -f: it deletes untracked files for good.'],
    ['git clean -f', 'Flow asks before git clean -f: it deletes untracked files for good.'],
    ['git clean -xdf', 'Flow asks before git clean -f: it deletes untracked files for good.'],
    ['git clean --force -d', 'Flow asks before git clean -f: it deletes untracked files for good.'],
    ['git branch -D topic', 'Flow asks before git branch -D: it deletes a branch for good.'],
    ['git branch --delete --force topic', 'Flow asks before git branch -D: it deletes a branch for good.'],
    ['git filter-branch --tree-filter "rm -f secret" HEAD', 'Flow asks before git filter-branch: it rewrites history.'],
    ['git filter-repo --path secret --invert-paths', 'Flow asks before git filter-repo: it rewrites history.'],
    ['gh pr merge 12 --squash', 'Flow asks before gh pr merge: it merges on GitHub.'],
    ['gh release create v1.0.2 --notes x', 'Flow asks before gh release create: it publishes a release.'],
    ['gh release upload v1.0.2 dist/a.tgz', 'Flow asks before gh release upload: it publishes a release.'],
    ['gh repo delete owner/name --yes', 'Flow asks before gh repo delete: it deletes a repository on GitHub.'],
  ]
  for (const [command, words] of asks) {
    for (const road of ROADS) {
      const outcome = await kit.decide(command, { road })
      const ok = road === 'prompt-less' ? refusedWith(outcome, words) : asksWith(outcome, words) && outcome.wrapper.decidedBy === 'flowLaw'
      check(`${road}: ${command} → ${road === 'prompt-less' ? 'refused with' : 'asks'} "${words}"`, ok, j(outcome.decision))
    }
  }

  section('§2 the neighbour that is not the item runs without a question')
  for (const command of [
    'git status', 'git status --short && git diff --stat', 'git log --oneline -5', 'git diff', 'git add .', 'git add src/x.ts',
    'git commit -m "wip"', 'git commit --amend --no-edit', 'git commit --allow-empty -q -m probe && git rev-parse --short HEAD',
    'git fetch origin', 'git pull --rebase', 'git merge main', 'git rebase main', 'git checkout -b topic', 'git checkout -- .', 'git switch main',
    'git reset --soft HEAD~1', 'git reset HEAD src/x.ts', 'git clean -n', 'git clean --dry-run -d', 'git branch -d topic', 'git branch topic',
    'git stash', 'git stash pop', 'git stash drop', 'git tag v1.0.2', 'git remote -v', 'git worktree add ../wt topic', 'git cherry-pick abc123',
    'git revert HEAD', 'git bisect start', 'git blame src/x.ts', 'git show HEAD', 'git rev-parse HEAD', 'git describe --tags',
    'gh pr view 12', 'gh pr list', 'gh pr checks 12', 'gh pr create --fill', 'gh release list', 'gh release view v1.0.1', 'gh run list', 'gh issue create --title x --body y', 'gh api repos/owner/name',
    'echo "git push" >> notes.md', 'grep -rn "git push" docs/', 'cat scripts/push.sh',
  ]) {
    for (const road of ROADS) {
      const outcome = await kit.decide(command, { road })
      check(`${road}: ${command} runs`, allowedByFlow(outcome), j(outcome.decision))
    }
  }

  section('§3 the operator\'s own rules outrank the item')
  const prefixAllowed = await kit.decide('git push origin topic', { rules: { allow: ['Bash(git push *)'] } })
  check('Bash(git push *) in the allow list runs the push without a question', prefixAllowed.decision.behavior === 'allow' && prefixAllowed.wrapper.decidedBy === 'engine', j(prefixAllowed.decision))
  const exactAllowed = await kit.decide('git push origin topic', { rules: { allow: ['Bash(git push origin topic)'] } })
  check('a remembered exact yes runs the same push without a question', exactAllowed.decision.behavior === 'allow', j(exactAllowed.decision))
  const otherPush = await kit.decide('git push origin other', { rules: { allow: ['Bash(git push origin topic)'] } })
  check('…and a different push still asks', asksWith(otherPush, PUSH), j(otherPush.decision))
  const denied = await kit.decide('git push origin topic', { rules: { deny: ['Bash(git push *)'] } })
  check('a deny rule refuses the push outright', denied.decision.behavior === 'deny' && denied.decision.decisionReason?.type === 'rule', j(denied.decision))
  const askRule = await kit.decide('git commit -m x', { rules: { ask: ['Bash(git commit *)'] } })
  check('an ask rule on a free git verb still asks, in the rule\'s words', askRule.decision.behavior === 'ask' && askRule.decision.decisionReason?.type === 'rule' && askRule.wrapper.decidedBy === 'flowFloors', j(askRule.decision))

  section('§4 the item is Flow\'s alone')
  const sovereign = await kit.decide('git push origin topic', { mode: 'sovereign' })
  check('sovereign runs the push', sovereign.decision.behavior === 'allow', j(sovereign.decision))
  const byDefault = await kit.decide('git push origin topic', { mode: 'default' })
  check('default asks in its own words', byDefault.decision.behavior === 'ask' && !sentence(byDefault).startsWith('Flow asks'), j(byDefault.decision))

  section('§5 the shipped table')
  const table = kit.FLOW_LAW[2] as { git: readonly string[]; forges: readonly string[] }
  check('item 2 lists push, reset --hard, clean -f, branch -D, filter-branch, filter-repo', ['push', 'reset --hard', 'clean -f', 'branch -D', 'filter-branch', 'filter-repo'].every(form => table.git.includes(form)), j(table.git))
  check('item 2 lists the gh roads that publish', ['gh pr merge', 'gh release create', 'gh release upload', 'gh repo delete'].every(form => table.forges.includes(form)), j(table.forges))
} finally {
  kit.close()
}
finish('prove-flow-law-git')
