#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

const { getDestructiveCommandWarning, isDestructiveCommandVerb } = await import('../../src/permissions/rules/shell-commands/destructiveCommandWarning.ts')

const HINT = "check getDestructiveCommandWarning in src/permissions/rules/shell-commands/destructiveCommandWarning.ts — POSIX, Git, database and cloud tests read a copy with each quoted commit message's content taken out"
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${[detail, HINT].filter(Boolean).join('; ')}`}`)
  if (!ok) failures++
}

const HARD = 'Note: a hard reset may discard uncommitted changes.'
const KUBE = 'Note: this may delete Kubernetes resources.'
const CLEAN = 'Note: a forced git clean may permanently delete untracked files.'
const AMEND = 'Note: amending may rewrite the last commit.'
const VERIFY = 'Note: skipping verification may bypass safety hooks.'
const PUSH = 'Note: a force push may overwrite remote history.'

const said = (command: string): string | null => getDestructiveCommandWarning(command)
const cases = (heading: string, rows: Array<[string, string | null]>): void => {
  console.log(heading)
  for (const [command, want] of rows) check(`${JSON.stringify(command)} → ${want ?? 'no note'}`, said(command) === want, String(said(command)))
}

cases('§1 no false note: the find stood inside a quoted commit message', [
  ['git commit -m "stop using git reset --hard in the script"', null],
  ["git commit -m 'stop using git reset --hard in the script'", null],
  ['git commit --message "note: git stash drop loses work"', null],
  ['git commit --message="note: git stash drop loses work"', null],
  ['git commit -m"note: git stash drop loses work"', null],
  ['git commit -am "drop table when done"', null],
  ['git -C /repo commit -m "kubectl delete is banned here"', null],
  ['git -c user.name=x -C /repo commit -m "kubectl delete is banned here"', null],
  ['git commit -m "title" -m "body: terraform destroy is next week"', null],
  ['git commit -m "explain --amend"', null],
  ['git commit -m "we never use --no-verify"', null],
  ['git commit -m "delete from users"', null],
  ['git reset && git commit -m "not --hard"', null],
  ['cd x\ngit commit -m "git reset --hard"', null],
  ['cd x\n   git commit -m "git reset --hard"', null],
  ['git add . ; git commit -m "git stash clear"', null],
  ['git commit -m "git clean -f" && git clean -n', null],
])
cases('§2 the true note stands', [
  ['git commit -m "git clean -f" && git clean -f', CLEAN],
  ['git commit --amend -m "git reset --hard"', AMEND],
  ['git commit -m "wip" && git reset --hard', HARD],
  ['git commit --no-verify -m "kubectl delete"', VERIFY],
  ['git commit -m "x" ; kubectl delete pod y', KUBE],
  ['git push --force', PUSH],
  ['git reset --hard', HARD],
])
cases('§3 not taken out: the note stays', [
  ['git commit -m "x $(git reset --hard)"', HARD],
  ['git commit -m "x `git reset --hard`"', HARD],
  ['git commit -m "a; git reset --hard"', HARD],
  ['git commit -m "a & git reset --hard"', HARD],
  ['git commit -m "a | git reset --hard"', HARD],
  ['git commit -m "first line\ngit reset --hard on the second"', HARD],
  ['git commit -m "first line\r git reset --hard"', HARD],
  ['echo \'git commit -m "git reset --hard"\'', HARD],
  ['git commit -m "say \\"git reset --hard\\" twice"', HARD],
  ['git status commit -m "git reset --hard"', HARD],
  ['git --no-pager commit -m "git reset --hard"', HARD],
  ['mygit commit -m "git reset --hard"', HARD],
  ['git commits -m "git reset --hard"', HARD],
  ['git commit --message"git reset --hard"', HARD],
  ['git commit -F "git reset --hard"', HARD],
  ['git commit --m "git reset --hard"', HARD],
  ['git commit -m x "git reset --hard"', HARD],
  ['git commit -m "unclosed git reset --hard', HARD],
  ['git log -m "git reset --hard"', HARD],
])
cases('§4 no note in either case', [
  ['git commit -m "git push --force is banned"', null],
  ['git commit -m "rm -rf is dangerous"', null],
  ['git clean -n && git clean -f', null],
  ['git reset "--hard"', null],
  ['git commit -m "plain words"', null],
])
console.log('§5 what stays: the Windows and PowerShell notes and the verb test')
check('rm -r -fo is still noted', said('rm -r -fo') === 'Note: this may recursively force-remove files.', String(said('rm -r -fo')))
check('a commit message does not hide a Windows note beside it', said('git commit -m "x" ; rm -r -fo') === 'Note: this may recursively force-remove files.', String(said('git commit -m "x" ; rm -r -fo')))
check('a Windows note is read from the text as it was given, a commit message too', said('git commit -m "rm -r -fo"') === null && said('git commit -m "x; rm -r -fo"') === said('git commit -m "x; rm -r -fo"'))
check('the verb test follows: a commit whose message names a hard reset is no destructive verb', isDestructiveCommandVerb('git commit -m "git reset --hard"') === false)
check('the verb test keeps its list', isDestructiveCommandVerb('git reset') === true && isDestructiveCommandVerb('rm x') === true)

console.log(failures === 0 ? '\nPASS prove-commit-message-no-false-note' : `\nFAIL ${failures}`)
process.exit(failures === 0 ? 0 : 1)
export {}
