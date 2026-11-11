#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { check, decide, fill, finish, note, said, section, shown, type Rules } from './floorsKit.ts'

const PROJECT = fill('<PROJECT>')
const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
const BIN = join(dirname(PROJECT), 'git-stand-in')
const ASKED = join(BIN, 'asked.log')
const SILENT = join(BIN, 'silent')
mkdirSync(BIN, { recursive: true })
writeFileSync(join(BIN, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ASKED}'\nif [ -e '${SILENT}' ]; then kill -KILL $$; fi\nexec '${REAL_GIT}' "$@"\n`)
chmodSync(join(BIN, 'git'), 0o755)
writeFileSync(ASKED, '')

const git = (...args: string[]): string =>
  execFileSync(REAL_GIT, ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: PROJECT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const put = (path: string, text: string, append = false): void => {
  mkdirSync(dirname(join(PROJECT, path)), { recursive: true })
  if (append) appendFileSync(join(PROJECT, path), text)
  else writeFileSync(join(PROJECT, path), text)
}
const commit = (message: string, ...paths: string[]): void => {
  git('add', ...paths)
  git('commit', '-q', '-m', message)
}
git('init', '-q', '-b', 'main', '.')
put('src/a.txt', 'a\n')
put('README', 'r\n')
put('sub/s.txt', 's\n')
commit('first: the secret arrives', 'README', 'src/a.txt', 'secrets/k.txt', 'sub/s.txt')
put('src/a.txt', 'a2\n', true)
commit('second: plain', 'src/a.txt')
put('secrets/k.txt', 'K2\n', true)
commit('third: touches the secret', 'secrets/k.txt')
put('src/a.txt', 'a3\n', true)
commit('fourth: plain again', 'src/a.txt')
put('secrets/k.txt', 'held\n', true)
git('stash', 'push', '-q', '-m', 'holds the secret')
put('sub/s.txt', 'held\n', true)
git('stash', 'push', '-q', '-m', 'plain')
put('README', 'staged\n', true)
git('add', 'README')
put('src/a.txt', 'unstaged\n', true)

process.env.PATH = `${BIN}:${process.env.PATH ?? ''}`
const PATCH = `-${'p'}`
const READ: Rules = { deny: ['Read(secrets/**)'] }
const SECRET = join(PROJECT, 'secrets', 'k.txt')
const EVERY_MODE = ['default', 'implement', 'apollo', 'dontAsk', 'flow', 'sovereign'] as const
const asked = (): number => readFileSync(ASKED, 'utf8').split('\n').filter(line => /--name-only/.test(line)).length
const bash = (command: string, mode: string, rules: Rules = READ) => decide('Bash', { command }, mode, rules)

section('§0 the stand-in git is the one the product asks')
{
  const before = asked()
  const answer = await bash('git diff', 'default')
  check('a bare git diff under a Read deny rule asks git for the names it would print', asked() > before, `asked ${asked() - before} time(s); ${said(answer)}`)
}

section('§1 a patch reader that would print a denied file is refused by the rule in every mode, and the refusal says how to leave the file out')
const PRINTS: Array<[string, string]> = [
  ['the commit that touches it', 'git show HEAD~1'],
  ['the commit that added it', 'git show HEAD~3'],
  ['two commits, one of them touching it', 'git show HEAD HEAD~1'],
  ['a commit found by its message', 'git show :/secret'],
  ['a range that crosses it', 'git diff HEAD~2'],
  ['two commits around it', 'git diff HEAD~2 HEAD'],
  ['a dotted range', 'git diff HEAD~3..HEAD~1'],
  ['the stash that holds it', `git stash show ${PATCH} 'stash@{1}'`],
  ['the same by the long flag', "git stash show --patch 'stash@{1}'"],
  ['the same by its number', `git stash show ${PATCH} 1`],
  ['a pathspec that is the folder itself', 'git show HEAD~1 -- .'],
  ['an exclude that leaves it in', "git diff HEAD~2 -- . ':(exclude)src'"],
  ['the plumbing reader with a patch', `git diff-tree ${PATCH} HEAD~1`],
  ['from a folder below', 'cd sub && git show HEAD~1'],
  ['by a folder flag', 'git -C sub show HEAD~1'],
  ['with the pager turned off', 'git --no-pager show HEAD~1'],
  ['through a pipe', 'git show HEAD~1 | head -3'],
  ['after a read-only command', 'git status && git show HEAD~1'],
  ['handed to a shell', "sh -c 'git show HEAD~1'"],
  ['with a unified context', 'git show -U5 HEAD~1'],
  ['the stash that holds it, given a word that only paints, which makes git print the patch', "git stash show --no-color 'stash@{1}'"],
  ['the same given a word that selects', "git stash show -w 'stash@{1}'"],
  ['the plumbing reader given the dense format for merges, which brings the patch', 'git diff-tree --cc HEAD~1'],
  ['the index reader given the combined format', 'git diff-index -c HEAD~2'],
  ['beside a relative date', 'git show --relative-date HEAD~1'],
  ['beside the notes', 'git show --notes HEAD~1'],
  ['in the order a file gives', 'git diff -OREADME HEAD~2'],
  ['the same with the file as the next word', 'git diff -O README HEAD~2'],
  ['under a setting that only paints', 'git -c diff.noprefix=true show HEAD~1'],
]
for (const [label, command] of PRINTS) {
  const wrong: string[] = []
  let advice = ''
  for (const mode of EVERY_MODE) {
    const decision = await bash(command, mode)
    const words = decision.message ?? ''
    const names = decision.behavior === 'deny' && words.includes(SECRET) && words.includes('denied by the rule Read(secrets/**)') && words.includes('To leave it out, name what to print: ') && words.includes(':(exclude,top)secrets/k.txt')
    if (!names) wrong.push(`${mode}: ${said(decision)}`)
    else advice = words.slice(words.indexOf('name what to print: ') + 'name what to print: '.length).trim()
  }
  check(`${label} · ${shown(command)} · refused in all six modes, naming the file, the rule and the way to leave it out`, wrong.length === 0, wrong.join(' ‖ '))
  if (advice === '') continue
  const followed = await bash(advice, 'sovereign')
  const inDefault = await bash(advice, 'default')
  check(`…and the command it names runs: ${shown(advice).slice(0, 110)}`, followed.behavior === 'allow' && inDefault.behavior !== 'deny', `sovereign: ${said(followed)} · default: ${said(inDefault)}`)
}

section('§2 no false refusal: a reader that prints no denied file is answered exactly as it is with no rule in force')
const PRINTS_NONE = [
  'git diff', 'git diff --cached', 'git diff --staged', 'git diff HEAD', 'git diff HEAD~1', 'git show', 'git show HEAD', 'git show HEAD~2', 'git show HEAD HEAD~2',
  `git stash show ${PATCH}`, "git stash show 'stash@{1}'", 'git show --stat HEAD~1', 'git show --name-only HEAD~1', 'git diff --stat HEAD~2', 'git diff --name-status HEAD~2', 'git show -s HEAD~1',
  'git diff HEAD~2 -- src', 'git show HEAD~1 -- src', "git diff HEAD~2 -- :/ ':(exclude,top)secrets/k.txt'", "git show HEAD~1 -- . ':(exclude)secrets'", "git diff HEAD~2 -- . ':!secrets'",
  'git status && git diff', 'cd sub && git diff', 'git diff | head -5', 'git --no-pager diff', 'GIT_PAGER=cat git diff', 'git -c core.pager=cat show HEAD', 'git -c color.ui=never diff --color=never',
  'git show nosuchref', 'git diff nosuchref', 'git log --oneline -3', 'git status',
  'git show --relative-date HEAD', 'git show --notes HEAD', 'git show --show-notes=commits HEAD', 'git show --no-standard-notes HEAD', 'git diff -OREADME HEAD~1', 'git diff -O README HEAD~1', 'git -c diff.noprefix=true diff', 'git -c diff.algorithm=histogram show HEAD', 'git diff -l50 HEAD~1', 'cd sub && git diff --relative HEAD~2',
  'git stash show --no-color', "git stash show --stat --no-color 'stash@{1}'", "git stash show -u 'stash@{1}'", 'git diff-tree --cc --name-only HEAD~1', 'git diff-tree --no-commit-id --name-only -r HEAD~1', 'git diff-tree --cc HEAD', 'git diff-index --quiet HEAD', 'git diff --stat-width=5 HEAD~2', 'git diff --stat --no-color HEAD~2', 'cd sub && git diff --no-relative --relative HEAD~2',
  'git diff --name-only --relative=src HEAD~2', 'git diff --stat --relative=secrets HEAD~2',
]
for (const command of PRINTS_NONE) {
  const wrong: string[] = []
  for (const mode of EVERY_MODE) {
    const ruled = await bash(command, mode)
    const bare = await bash(command, mode, {})
    if (ruled.behavior !== bare.behavior || ruled.behavior === 'deny' !== (mode === 'dontAsk' && bare.behavior === 'deny')) wrong.push(`${mode}: with the rule ${said(ruled)} · without ${said(bare)}`)
  }
  check(`${shown(command)} · answered in all six modes as with no rule in force`, wrong.length === 0, wrong.join(' ‖ '))
}
{
  const plain = await bash('git diff', 'default')
  const shownHead = await bash('git show HEAD', 'default')
  check('default · git diff and git show HEAD run with no card, as before', plain.behavior === 'allow' && shownHead.behavior === 'allow', `${said(plain)} ‖ ${said(shownHead)}`)
}

{
  const anchored: Rules = { deny: [`Read(/${PROJECT}/secrets/**)`] }
  const wrong: string[] = []
  for (const command of ['cd sub && git diff --relative --no-relative HEAD~2', 'git -C sub diff --relative --no-relative HEAD~2']) {
    for (const mode of ['sovereign', 'flow', 'default'] as const) {
      const decision = await bash(command, mode, anchored)
      if (decision.behavior !== 'deny' || !(decision.message ?? '').includes(SECRET)) wrong.push(`${mode} · ${command}: ${said(decision)}`)
    }
  }
  check('the relative flag taken back, from a folder below, under a rule that spells the folder by its full path: the names are read from the top, as git prints them, and both forms are refused naming the file (sovereign, flow and default)', wrong.length === 0, wrong.join(' ‖ '))
  const again = await bash('cd sub && git diff --relative --no-relative --relative HEAD~2', 'sovereign', anchored)
  check('…and with the flag given once more after it, which prints the files of that folder alone, the command runs', again.behavior === 'allow', said(again))
}

{
  const wrong: string[] = []
  for (const mode of EVERY_MODE) {
    const below = await decide('Bash', { command: 'git show HEAD~1', cwd: 'sub' }, mode, READ)
    if (below.behavior !== 'deny' || !(below.message ?? '').includes(SECRET)) wrong.push(`${mode}: ${said(below)}`)
    const plain = await decide('Bash', { command: 'git diff', cwd: 'sub' }, mode, READ)
    const bare = await decide('Bash', { command: 'git diff', cwd: 'sub' }, mode, {})
    if (plain.behavior !== bare.behavior) wrong.push(`${mode}: git diff with the rule ${said(plain)} · without ${said(bare)}`)
  }
  check('a call that names the folder to run in is judged in that folder: git show HEAD~1 there is refused in all six modes, git diff there is answered as with no rule', wrong.length === 0, wrong.join(' ‖ '))
  const named = await decide('Bash', { command: 'cat k.txt', cwd: 'secrets' }, 'default', READ)
  check('control · the kit hands the folder a call names to the decision: cat k.txt run in secrets is refused by the rule', named.behavior === 'deny' && (named.message ?? '').includes(SECRET), said(named))
}

section('§3 the working tree and the index are read as they stand')
{
  for (const command of ['git status', 'git status -v', 'git status -vv', 'git status --verbose --verbose', 'git status -sb']) {
    const wrong: string[] = []
    for (const mode of EVERY_MODE) {
      const ruled = await bash(command, mode)
      const bare = await bash(command, mode, {})
      if (ruled.behavior !== bare.behavior) wrong.push(`${mode}: with the rule ${said(ruled)} · without ${said(bare)}`)
    }
    check(`with the denied file untouched, ${shown(command)} is answered in all six modes as with no rule in force`, wrong.length === 0, wrong.join(' ‖ '))
  }
  put('secrets/k.txt', 'changed\n', true)
  const wrong: string[] = []
  for (const mode of EVERY_MODE) {
    const decision = await bash('git diff', mode)
    if (decision.behavior !== 'deny' || !(decision.message ?? '').includes(SECRET)) wrong.push(`${mode}: ${said(decision)}`)
  }
  check('with the denied file changed in the working tree, a bare git diff is refused in all six modes', wrong.length === 0, wrong.join(' ‖ '))
  const judged = async (command: string, printed: boolean): Promise<string[]> => {
    const wrong: string[] = []
    for (const mode of ['sovereign', 'default'] as const) {
      const ruled = await bash(command, mode)
      const bare = await bash(command, mode, {})
      if (printed ? ruled.behavior !== 'deny' || !(ruled.message ?? '').includes(SECRET) : ruled.behavior !== bare.behavior) wrong.push(`${mode}: with the rule ${said(ruled)} · without ${said(bare)}`)
    }
    return wrong
  }
  for (const [command, printed] of [['git status -vv', true], ['git status --verbose --verbose', true], ['git status -v -v', true], ['git status --verb --v', true], ['git status -vv -- src', true], ['git status -v', false], ['git status', false], ['git status -svv', false], ['git status --porcelain -vv', false], ['git status -vv --no-verbose', false]] as const) {
    const wrong = await judged(command, printed)
    check(`…and ${shown(command)}, which ${printed ? 'prints the unstaged change whatever paths it names, is refused by the rule' : 'does not print it, is answered as with no rule in force'} (sovereign and default)`, wrong.length === 0, wrong.join(' ‖ '))
  }
  for (const [command, printed] of [['git status -s --no-short -vv', true], ['git status --short --no-shor -vv', true], ['git status --porcelain --no-porcelain -vv', true], ['git status --porcelain=v2 --no-porc -vv', true], ['git status -z --no-null -vv', true], ['git status -vvz --no-nul', true], ['git status -s --no-long -vv', true], ['git status -s --lo -vv', true], ['git status --short --long -vv', true], ['git status -s -z --no-null -vv', false], ['git status --short --branch -vv', false], ['git status --porcelain --untracked-files=no -vv', false], ['git status --long --short -vv', false], ['git status --null -vv', false]] as const) {
    const wrong = await judged(command, printed)
    check(`…and ${shown(command)}, where ${printed ? 'a short form is taken back, so git prints the long form and its diff, is refused by the rule' : 'git prints a short form and no diff, is answered as with no rule in force'} (sovereign and default)`, wrong.length === 0, wrong.join(' ‖ '))
  }
  {
    const refused = await bash('git status -vv', 'default')
    const words = refused.message ?? ''
    const advice = words.includes('name what to print: ') ? words.slice(words.indexOf('name what to print: ') + 'name what to print: '.length).trim() : ''
    const followed = advice === '' ? null : await bash(advice, 'default')
    check(`…and its refusal names a diff that leaves the file out, which runs: ${shown(advice).slice(0, 90)}`, advice.startsWith('git diff HEAD -- ') && followed !== null && followed.behavior === 'allow', followed === null ? words : said(followed))
  }
  git('reset', '-q', '--', 'README')
  for (const command of ['git status -vv', 'cd sub && git status -vv', 'git -C sub status -vv', 'git -C sub status -v -v -- .']) {
    const wrong = await judged(command, true)
    check(`with nothing staged, ${shown(command)} is refused by the rule from the folder it runs in (sovereign and default)`, wrong.length === 0, wrong.join(' ‖ '))
  }
  {
    const below = await decide('Bash', { command: 'git status -vv', cwd: 'sub' }, 'sovereign', READ)
    check('with nothing staged, a call that names the folder below to run git status -vv in is refused by the rule', below.behavior === 'deny' && (below.message ?? '').includes(SECRET), said(below))
    const anchored = await bash('cd sub && git status -vv', 'sovereign', { deny: [`Read(/${PROJECT}/secrets/**)`] })
    check('with nothing staged, under a rule that spells the folder by its full path, cd sub && git status -vv is refused under sovereign', anchored.behavior === 'deny' && (anchored.message ?? '').includes(SECRET), said(anchored))
  }
  git('add', 'README')
  const cached = await bash('git diff --cached', 'sovereign')
  check('…and git diff --cached, which would not print it, still runs', cached.behavior === 'allow', said(cached))
  git('add', 'secrets/k.txt')
  for (const [command, printed] of [['git status -v', true], ['git status --verbose', true], ['git status --v -- src', true], ['git -C sub status -v', true], ['git status -sv', false], ['git status -v -z', false]] as const) {
    const wrong = await judged(command, printed)
    check(`with the change staged, ${shown(command)}, which ${printed ? 'prints the staged change, is refused by the rule' : 'prints no diff, is answered as with no rule in force'} (sovereign and default)`, wrong.length === 0, wrong.join(' ‖ '))
  }
  for (const [command, printed] of [['git status --short --no-short -v', true], ['git status -sv --no-short', true], ['git status -sv --no-short --short', false]] as const) {
    const wrong = await judged(command, printed)
    check(`with the change staged, ${shown(command)}, where the short form is ${printed ? 'taken back, is refused by the rule' : 'given again, is answered as with no rule in force'} (sovereign and default)`, wrong.length === 0, wrong.join(' ‖ '))
  }
  {
    const refused = await bash('git status -v', 'sovereign')
    const words = refused.message ?? ''
    const advice = words.includes('name what to print: ') ? words.slice(words.indexOf('name what to print: ') + 'name what to print: '.length).trim() : ''
    const followed = advice === '' ? null : await bash(advice, 'sovereign')
    check(`…and its refusal names the staged diff with the file left out, which runs: ${shown(advice).slice(0, 90)}`, advice.startsWith('git diff --cached -- ') && followed !== null && followed.behavior === 'allow', followed === null ? words : said(followed))
  }
  const staged: string[] = []
  for (const mode of EVERY_MODE) {
    const decision = await bash('git diff --cached', mode)
    if (decision.behavior !== 'deny' || !(decision.message ?? '').includes(SECRET)) staged.push(`${mode}: ${said(decision)}`)
  }
  check('with the change staged, git diff --cached is refused in all six modes', staged.length === 0, staged.join(' ‖ '))
  const unstaged = await bash('git diff', 'sovereign')
  check('…and the bare git diff, which no longer prints it, runs again', unstaged.behavior === 'allow', said(unstaged))
  git('reset', '-q', '--', 'secrets/k.txt')
  git('checkout', '-q', '--', 'secrets/k.txt')
}

section('§4 what cannot be established: asked about where a person answers, refused under Sovereign mode and Flow, never allowed unread')
const UNREAD: Array<[string, string, RegExp]> = [
  ['an earlier command on the line can change the index', `git ${'add'} . && git diff --cached`, /an earlier command on the line can change what git diff would print/],
  ['an earlier write can change the working tree', 'npm run build && git diff', /an earlier command on the line can change what git diff would print/],
  ['an earlier stash', `git stash push -q && git stash show ${PATCH}`, /an earlier command on the line can change what git stash show would print/],
  ['a later command sent to the background, which can run first', `sleep 1 && git diff --cached & git ${'add'} .`, /an earlier command on the line can change what git diff would print/],
  ['a script that changes the index before it reads it', `sh -c 'git ${'add'} . && git diff --cached'`, /an earlier command on the line can change what git diff would print/],
  ['the repository is named on the command line', 'git --git-dir=.git show HEAD', /git is given --git-dir=\.git on its command line/],
  ['a setting moves the working tree', 'git -c core.worktree=/tmp diff', /git is given the setting core\.worktree=\/tmp on its command line/],
  ['a variable moves the repository', 'GIT_DIR=.git git show HEAD', /GIT_DIR is set on the line/],
  ['an option this reading has no name for', 'git diff --output=patch.txt HEAD~2', /an option Mercury does not read for what it prints/],
  ['a stat number given as the next word, which git takes as the number', `git diff --stat-width 5 ${PATCH} HEAD~2`, /git diff is given --stat-width, an option Mercury does not read for what it prints/],
  ['a silent word taken back', 'git diff --quiet --no-quiet HEAD~2', /git diff is given --no-quiet, an option Mercury does not read for what it prints/],
  ['the same on a commit', 'git show -s --no-no-patch HEAD~1', /git show is given --no-no-patch, an option Mercury does not read for what it prints/],
  ['two short options in one word on the plumbing reader', `git diff-tree -s${'p'} HEAD~1`, /git diff-tree is given -sp, an option Mercury does not read for what it prints/],
  ['a file of a commit beside a word that names more commits', 'git show HEAD:README --reflog', /git show is given --reflog, an option Mercury does not read for what it prints/],
  ['the stash named after a double dash', "git stash show -- 'stash@{1}'", /git stash show is given --, an option Mercury does not read for what it prints/],
  ['the names made relative to a named folder, which this reading does not follow', 'git diff --relative=src HEAD~2', /git diff is given --relative=src, an option Mercury does not read for what it prints/],
]
for (const [label, command, why] of UNREAD) {
  for (const mode of ['sovereign', 'flow'] as const) {
    const decision = await bash(command, mode)
    const words = decision.message ?? ''
    check(`${label} · ${shown(command)} · ${mode} refuses: the effect could not be established, the rule is named`, decision.behavior === 'deny' && words.startsWith('This command is refused: its effect could not be established (') && why.test(words) && words.includes('the rule Read(secrets/**)'), said(decision))
  }
  const inDefault = await bash(command, 'default')
  check(`${label} · default asks, the person sees the card`, inDefault.behavior === 'ask', said(inDefault))
  const bare = await bash(command, 'sovereign', {})
  check(`${label} · with no rule in force sovereign allows it as before`, bare.behavior === 'allow', said(bare))
}
{
  writeFileSync(SILENT, '')
  const expected: Array<[string, string]> = [['default', 'ask'], ['implement', 'ask'], ['apollo', 'ask'], ['dontAsk', 'deny'], ['flow', 'deny'], ['sovereign', 'deny']]
  for (const command of ['git diff', 'git show HEAD']) {
    for (const [mode, behavior] of expected) {
      const decision = await bash(command, mode)
      const words = decision.message ?? ''
      const told = mode === 'flow' || mode === 'sovereign' ? words.startsWith('This command is refused: its effect could not be established (git did not say in time which files git') : mode === 'dontAsk' ? true : /git did not say in time which files git (?:diff|show) would print, and the rule Read\(secrets\/\*\*\) .* denies what it may print; name the paths it should print, or approve/.test(words)
      check(`git gives no answer · ${shown(command)} · ${mode}: ${behavior}${behavior === 'ask' ? ', with the sentence that says why' : ''}`, decision.behavior === behavior && told, said(decision))
    }
    const bare = await bash(command, 'default', {})
    check(`git gives no answer · ${shown(command)} · with no rule in force it runs with no card, and git was not asked`, bare.behavior === 'allow', said(bare))
  }
  rmSync(SILENT)
}

section('§5 with no Read deny rule in force git is asked nothing')
for (const [label, rules] of [['no rule at all', {}], ['a Bash deny rule alone', { deny: ['Bash(rm *)'] }], ['an Edit deny rule alone', { deny: ['Edit(secrets/**)'] }], ['an allow rule alone', { allow: ['Read(secrets/**)'] }]] as Array<[string, Rules]>) {
  const before = asked()
  const answers: string[] = []
  for (const command of ['git diff', 'git show HEAD~1', 'git diff HEAD~2', `git stash show ${PATCH} 'stash@{1}'`]) {
    for (const mode of ['default', 'sovereign'] as const) answers.push((await bash(command, mode, rules)).behavior)
  }
  check(`${label} · four patch readers in default and sovereign: git is not asked what they would print, and each runs`, asked() === before && answers.every(answer => answer === 'allow'), `asked ${asked() - before} time(s); ${answers.join(',')}`)
}

section('§6 Sovereign mode: a run or a refusal, never a card')
{
  const cards: string[] = []
  for (const command of [...PRINTS.map(([, command]) => command), ...PRINTS_NONE, ...UNREAD.map(([, command]) => command)]) {
    const decision = await bash(command, 'sovereign')
    if (decision.behavior !== 'allow' && decision.behavior !== 'deny') cards.push(`${command}: ${said(decision)}`)
  }
  check(`sovereign · the ${PRINTS.length + PRINTS_NONE.length + UNREAD.length} commands above are each allowed or refused`, cards.length === 0, cards.join(' ‖ '))
}
check('the stand-in was asked through the product\'s own spawn: no helper of the repository is on any of its command lines', existsSync(ASKED) && readFileSync(ASKED, 'utf8').split('\n').filter(line => /--name-only/.test(line)).every(line => line.includes('core.fsmonitor=false') && line.includes('--no-ext-diff') && line.includes('--no-textconv')), readFileSync(ASKED, 'utf8').split('\n').filter(line => /--name-only/.test(line) && !line.includes('--no-textconv')).slice(0, 3).join(' ‖ '))
note('nothing a model asked for is executed: command strings are handed to the decision function. The decision asks git, through a stand-in that records each question and hands it to the real git, for the names a command would print; the repository is this proof\'s own scratch folder')
finish('prove-git-patch-readers-deny')
