#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'strategy-table-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)
const finish = (): never => {
  rmSync(HOME, { recursive: true, force: true })
  if (failures > 0) {
    console.error(`\nprove-strategy-mutation-table: ${failures} FAILURE(S)`)
    process.exit(1)
  }
  console.log('\nprove-strategy-mutation-table: all green')
  process.exit(0)
}

console.log('============================================================')
console.log(' The mutating-command predicate — its table, judged segment by segment')
console.log('============================================================')

section('§0 the predicate exists')
const PREDICATE = join(import.meta.dir, '../../src/tools/BashTool/strategyMutation.ts')
check('src/tools/BashTool/strategyMutation.ts exists — strategy mode has a mutating-command predicate', existsSync(PREDICATE), 'absent: nothing enforces the mode for the shell (the mode is words only)')
if (!existsSync(PREDICATE)) finish()

const { MUTATING_COMMAND_TABLE, findMutatingSegment, judgeShellSegment, isUnderTempRoot } = await import('../../src/tools/BashTool/strategyMutation.ts')
const ROOTS = ['/tmp', '/private/tmp', '/var/tmp']
const judge = (command: string) => findMutatingSegment(command, ROOTS)

type Example = { command: string; segment?: string; reason?: RegExp }
const BLOCKED: Record<string, Example[]> = {
  rm: [{ command: 'rm -rf build', reason: /removes files/ }, { command: 'rm /tmp/scratch.txt', reason: /removes files/ }],
  rmdir: [{ command: 'rmdir empty' }],
  unlink: [{ command: 'unlink link' }],
  shred: [{ command: 'shred -u secret.txt' }],
  mv: [{ command: 'mv a.ts b.ts', reason: /moves or renames/ }, { command: 'mv a /tmp/a' }],
  rename: [{ command: "rename 's/a/b/' *.txt" }],
  touch: [{ command: 'touch marker', reason: /creates files/ }, { command: 'touch /tmp/marker' }],
  mkdir: [{ command: 'mkdir -p src/new', reason: /creates directories/ }, { command: 'mkdir /tmp/scratch' }],
  ln: [{ command: 'ln -s a b' }],
  truncate: [{ command: 'truncate -s 0 log.txt' }],
  chmod: [{ command: 'chmod +x script.sh', reason: /permissions/ }],
  chown: [{ command: 'chown me file' }],
  chgrp: [{ command: 'chgrp staff file' }],
  patch: [{ command: 'patch -p1 < fix.diff', reason: /rewrites the files/ }],
  'cp / install / rsync': [
    { command: 'cp a.txt b.txt', reason: /writes its destination/ },
    { command: 'cp -r /tmp/src ./vendor' },
    { command: 'cp -t ./dst a b' },
    { command: 'install -m 755 bin/tool /usr/local/bin/tool' },
    { command: 'install -d build/out' },
    { command: 'rsync -a src/ dst/', reason: /rsync writes its destination/ },
  ],
  'prettier / biome / eslint / gofmt / black / rustfmt / ruff': [
    { command: 'prettier --write src', reason: /prettier rewrites/ },
    { command: 'prettier -w src/a.ts' },
    { command: 'eslint --fix src' },
    { command: 'biome check --write .' },
    { command: 'biome format --write .' },
    { command: 'gofmt -w main.go' },
    { command: 'black .' },
    { command: 'rustfmt src/main.rs' },
    { command: 'ruff format .' },
    { command: 'ruff check --fix .' },
  ],
  'curl / wget': [
    { command: 'curl -o out.bin http://127.0.0.1:1/x', reason: /curl writes its download/ },
    { command: 'curl -O http://127.0.0.1:1/x' },
    { command: 'curl --output=out.bin http://127.0.0.1:1/x' },
    { command: 'wget http://127.0.0.1:1/x', reason: /wget writes its download/ },
    { command: 'wget -O out.bin http://127.0.0.1:1/x' },
    { command: 'wget -P ./downloads http://127.0.0.1:1/x' },
  ],
  tee: [{ command: 'tee out.log', reason: /writes its file operands/ }, { command: 'tee -a /var/log/app.log' }],
  dd: [{ command: 'dd if=/dev/zero of=disk.img bs=1m count=1', reason: /of= target/ }],
  sed: [
    { command: 'sed -i s/a/b/ file.txt', reason: /in place/ },
    { command: 'sed -i.bak -e s/a/b/ f' },
    { command: 'sed -Ei "s/a/b/" f' },
    { command: 'sed --in-place=.orig s/a/b/ f' },
    { command: 'sed -ni /x/p f' },
  ],
  perl: [{ command: 'perl -pi -e s/a/b/ f.txt', reason: /in place/ }, { command: 'perl -i.bak -pe s/a/b/ f' }],
  tar: [
    { command: 'tar -xzf a.tgz', reason: /unpacks files/ },
    { command: 'tar xzf a.tgz -C ./vendor' },
    { command: 'tar --extract -f a.tar' },
    { command: 'tar -czf out.tgz src', reason: /archive file/ },
  ],
  unzip: [{ command: 'unzip a.zip', reason: /unpacks files/ }, { command: 'unzip a.zip -d ./vendor' }],
  'git <subcommand>': [
    { command: 'git commit -m x', reason: /git commit writes/ },
    { command: 'git checkout -- .', reason: /git checkout writes/ },
    { command: 'git reset --hard HEAD~1' },
    { command: 'git rebase main' },
    { command: 'git -C sub commit -m x' },
    { command: 'git -c user.name=x commit -m x' },
    { command: 'git --no-pager add -A' },
    { command: 'git stash' },
    { command: 'git stash pop' },
    { command: 'git switch -c feature' },
    { command: 'git restore src/a.ts' },
    { command: 'git merge feature' },
    { command: 'git cherry-pick abc123' },
    { command: 'git clean -fd' },
    { command: 'git rm -r old' },
    { command: 'git mv a b' },
    { command: 'git apply fix.diff' },
    { command: 'git pull' },
    { command: 'git init' },
    { command: 'git clone https://example.invalid/repo.git' },
    { command: 'git tag v1.0.0', reason: /creates or deletes a tag/ },
    { command: 'git tag -d v1.0.0' },
    { command: 'git branch feature', reason: /branch/ },
    { command: 'git branch -D feature' },
    { command: 'git config user.name "x y"', reason: /config file/ },
    { command: 'git config --global --add safe.directory /x' },
    { command: 'git config --unset core.hooksPath' },
    { command: 'git config --file .gitconfig user.name x' },
    { command: 'git commit -n -m x' },
    { command: 'git remote add origin https://example.invalid/r.git' },
    { command: 'git worktree add ../wt feature' },
    { command: 'git submodule update --init' },
    { command: 'git gc' },
    { command: 'git update-ref refs/heads/x abc' },
    { command: 'git symbolic-ref HEAD refs/heads/x' },
  ],
  'npm / pnpm / yarn / bun <subcommand>': [
    { command: 'npm install', reason: /node_modules/ },
    { command: 'npm i --save-dev x' },
    { command: 'npm ci' },
    { command: 'bun install' },
    { command: 'bun add zod' },
    { command: 'bun remove zod' },
    { command: 'pnpm install' },
    { command: 'pnpm add -D x' },
    { command: 'yarn', reason: /yarn installs/ },
    { command: 'yarn add x' },
    { command: 'yarn install --frozen-lockfile' },
    { command: 'npm init -y' },
    { command: 'bun link' },
  ],
  find: [
    { command: "find . -name '*.tmp' -delete", reason: /find -delete/ },
    { command: "find . -name '*.o' -exec rm {} \\;", reason: /find -exec: rm removes files/ },
    { command: 'find . -type f -execdir chmod +x {} +', reason: /find -execdir: chmod/ },
    { command: 'find . -fprint listing.txt', reason: /writes a file/ },
  ],
  'xargs <command>': [
    { command: 'xargs rm', reason: /rm removes files/ },
    { command: 'xargs -I{} -n1 mv {} old/', reason: /mv moves/ },
    { command: 'xargs -0 sed -i s/a/b/', reason: /sed -i/ },
  ],
  'sudo / doas / env / nice / nohup / time / timeout / stdbuf / command / builtin / exec <command>': [
    { command: 'sudo rm -rf /var/lib/x', reason: /rm removes files/ },
    { command: 'sudo -u root chmod 600 f' },
    { command: 'env -i PATH=/bin rm x' },
    { command: 'env FOO=1 touch x' },
    { command: 'nice -n 5 rm x' },
    { command: 'nohup mkdir out' },
    { command: 'time rm x' },
    { command: 'timeout 5 rm x' },
    { command: 'timeout -s KILL 10s git commit -m x' },
    { command: 'stdbuf -oL tee out.log' },
    { command: 'command rm x' },
    { command: 'builtin rm x' },
    { command: 'exec rm x' },
    { command: 'FOO=1 BAR=2 rm x' },
    { command: '/bin/rm -rf x' },
    { command: '/usr/bin/git commit -m x' },
  ],
  'bash -c / sh -c / zsh -c / dash -c / ksh -c / eval': [
    { command: 'bash -c "rm -rf x"', reason: /rm removes files/ },
    { command: "sh -c 'git commit -m x'" },
    { command: 'zsh -lc "touch x"' },
    { command: "eval 'rm x'" },
    { command: 'eval rm x' },
  ],
  '`...`': [{ command: 'cat `rm x`', reason: /rm removes files/ }, { command: 'echo `touch marker`' }],
  '> / >> / >| / &> redirection': [
    { command: 'echo hi > out.txt', segment: '> out.txt', reason: /creates or truncates/ },
    { command: 'echo hi >> notes.md', segment: '>> notes.md' },
    { command: 'printf x >| clobber.txt', segment: '> clobber.txt' },
    { command: 'echo x &> both.log', segment: '> both.log' },
    { command: 'cmd 2> err.log', segment: '> err.log' },
    { command: 'echo x > /tmp/../etc/hosts', segment: '> /tmp/../etc/hosts' },
    { command: 'echo x >> .git/config', segment: '>> .git/config' },
    { command: 'echo hi > $OUT', reason: /cannot be resolved/ },
    { command: 'echo x > ~/notes', reason: /cannot be resolved/ },
    { command: 'cat > out.txt <<EOF\nhello\nEOF', segment: '> out.txt' },
    { command: 'cd /tmp && echo x > y', segment: '> y' },
  ],
}

const ALLOWED: Record<string, string[]> = {
  'cp / install / rsync': ['cp a.txt /tmp/a.txt', 'cp -r src /tmp/snapshot', 'cp -t /tmp/dst a b', 'cp --target-directory=/tmp/dst a', 'install -d /tmp/out', 'rsync -a src/ /tmp/snapshot/', 'rsync -a src/ host:/backup/'],
  'prettier / biome / eslint / gofmt / black / rustfmt / ruff': ['prettier --check src', 'prettier -l src', 'eslint src', 'eslint --max-warnings 0 src', 'biome check .', 'biome format .', 'gofmt -l .', 'gofmt -d main.go', 'black --check .', 'black --diff .', 'rustfmt --check src/main.rs', 'ruff format --check .', 'ruff check .'],
  'curl / wget': ['curl -s http://127.0.0.1:1/health', 'curl -o /tmp/x http://127.0.0.1:1/x', 'curl -o - http://127.0.0.1:1/x', 'curl -sS --output /tmp/x http://127.0.0.1:1/x', 'wget -O - http://127.0.0.1:1/x', 'wget -O /tmp/x http://127.0.0.1:1/x', 'wget -P /tmp http://127.0.0.1:1/x', 'wget --spider http://127.0.0.1:1/x', 'wget -q -O /tmp/x http://127.0.0.1:1/x'],
  tee: ['tee /tmp/log.txt', 'tee -a /tmp/log.txt', 'tee /dev/null', 'tee /dev/stderr', 'tee'],
  dd: ['dd if=a of=/tmp/b', 'dd if=a of=/dev/null'],
  sed: ['sed -n 1p f.txt', 'sed -e s/a/b/ f.txt', "sed -e 'i\\foo' f", 'sed -es/i/b/ f', 'sed --expression=s/a/b/ f', 'sed -n -f script.sed f'],
  perl: ['perl -ne print f', "perl -pe 's/a/b/' f", 'perl -Ilib -e 1', 'perl -MFoo -e 1'],
  tar: ['tar -tzf a.tgz', 'tar --list -f a.tar', 'tar -xzf a.tgz -C /tmp/x', 'tar xzf a.tgz -C /tmp/x', 'tar -czf /tmp/out.tgz src', 'tar -cf - src'],
  unzip: ['unzip -l a.zip', 'unzip -t a.zip', 'unzip -p a.zip file', 'unzip a.zip -d /tmp/x'],
  'git <subcommand>': [
    'git status',
    'git log --oneline -5',
    'git diff HEAD~1',
    'git show HEAD',
    'git blame src/a.ts',
    'git branch',
    'git branch -a',
    'git branch --list "f*"',
    'git branch --show-current',
    'git branch --contains abc',
    'git tag',
    'git tag -l "v*"',
    'git tag --contains abc',
    'git stash list',
    'git stash show -p',
    'git config user.name',
    'git config --get user.name',
    'git config --list',
    'git config -l',
    'git config get user.name',
    'git config --file .gitconfig user.name',
    'git config -f /tmp/cfg --get user.name',
    'git clean -n',
    'git clean --dry-run -d',
    'git add -n .',
    'git add --dry-run .',
    'git rm -n old',
    'git commit --dry-run',
    'git remote -v',
    'git remote show origin',
    'git worktree list',
    'git submodule status',
    'git reflog',
    'git notes list',
    'git ls-files',
    'git rev-parse HEAD',
    'git --no-pager log -1',
    'git -C sub status',
    'git describe --tags',
    'git fetch origin',
    'git grep -n strategy',
  ],
  'npm / pnpm / yarn / bun <subcommand>': ['npm run typecheck', 'npm ls', 'npm view zod version', 'npm test', 'bun run typecheck', 'bun test', 'bun x tsc --noEmit', 'bun pm ls', 'pnpm list', 'pnpm run build', 'yarn run test', 'yarn why zod', 'npx tsc --noEmit'],
  find: ["find . -name '*.ts'", 'find . -type f -exec grep -l foo {} +', 'find . -newer a -print', 'find . -fprint /tmp/listing.txt'],
  'xargs <command>': ['xargs grep -l foo', 'xargs -n1 echo', 'xargs -0 cat'],
  'sudo / doas / env / nice / nohup / time / timeout / stdbuf / command / builtin / exec <command>': ['sudo ls /root', 'env', 'env FOO=1 cat x', 'nice -n 5 cat x', 'timeout 5 cat x', 'command -v rm', 'command -V git', 'time ls'],
  'bash -c / sh -c / zsh -c / dash -c / ksh -c / eval': ['bash -c "ls -la"', 'bash script.sh', "eval 'ls'"],
  '`...`': ['echo `ls`', "echo '`rm x`'"],
  '> / >> / >| / &> redirection': ['ls > /dev/null', 'ls 2>&1', 'ls >&2', 'echo hi > /tmp/out.txt', 'echo hi >> /private/tmp/out.txt', 'cat > /tmp/x <<EOF\nhello\nEOF', 'echo x > "/tmp/my file.txt"', 'echo "a > b"', 'ls 2> /dev/null', 'ls > /dev/stderr'],
}

const READ_ONLY_CONTROL = [
  'ls -la',
  'ls src/*.ts',
  'cat README.md',
  'head -n 20 src/a.ts',
  'tail -f /var/log/system.log',
  'wc -l src/a.ts',
  'grep -rn strategy src/',
  'rg -n "strategy" src/',
  'find src -name "*.ts"',
  'fd strategy src',
  'tree -L 2',
  'pwd',
  'echo hello',
  'printf "%s\\n" x',
  'cd src',
  'cd /tmp && ls',
  'git status',
  'git log --oneline -10',
  'git diff --stat',
  'git show HEAD:src/a.ts',
  'git blame src/a.ts',
  'git branch -a',
  'git remote -v',
  'git stash list',
  'git rev-parse --short HEAD',
  'git ls-files | wc -l',
  'diff a.txt b.txt',
  'diff <(sort a) <(sort b)',
  'sort a.txt | uniq -c',
  'sed -n 1,5p src/a.ts',
  'awk "{print $1}" data.txt',
  'jq .name package.json',
  'file src/a.ts',
  'stat src/a.ts',
  'du -sh node_modules',
  'df -h',
  'ps aux | grep bun',
  'which bun',
  'bun --version',
  'node --version',
  'bun run typecheck',
  'bun test',
  'npm run lint',
  'npx tsc --noEmit',
  'make -n',
  'curl -s http://127.0.0.1:1/health',
  'curl -sS http://127.0.0.1:1/api | jq .',
  'prettier --check src',
  'eslint src',
  'git clean -n',
  'rsync -an src/ dst/ | head',
  'python3 --version',
  'python3 -c "print(1)"',
  'uname -a',
  'date',
  'env | sort',
  'echo $HOME',
  'echo $(git rev-parse HEAD)',
  'test -f a.txt && echo yes',
  'true',
  'sleep 1',
  'xargs -n1 echo < list.txt',
  'for f in src/*.ts; do wc -l "$f"; done',
  'if [ -f a ]; then cat a; fi',
  'ls 2>&1 | head',
  'ls > /dev/null 2>&1',
  'echo hi > /tmp/scratch.txt',
  'cp src/a.ts /tmp/a.ts',
  'tee /tmp/capture.log',
  'tar -tzf a.tgz',
  'unzip -l a.zip',
]

section('§1 the table: every entry has blocked examples, and each is judged mutating with its reason')
{
  const names = new Set(MUTATING_COMMAND_TABLE.map(rule => rule.command))
  check('the table carries the brief\'s rows (rm, mv, cp, sed, redirection, git, npm/bun, chmod, touch, mkdir)', ['rm', 'mv', 'cp / install / rsync', 'sed', '> / >> / >| / &> redirection', 'git <subcommand>', 'npm / pnpm / yarn / bun <subcommand>', 'chmod', 'touch', 'mkdir'].every(n => names.has(n)), j([...names]))
  for (const rule of MUTATING_COMMAND_TABLE) {
    check(`${rule.command}: carries a reason and a condition`, rule.reason.length > 0 && rule.when.length > 0, j(rule))
    const examples = BLOCKED[rule.command]
    check(`${rule.command}: the proof carries blocked examples`, examples !== undefined && examples.length > 0)
    for (const example of examples ?? []) {
      const finding = judge(example.command)
      const segmentOk = example.segment === undefined || finding?.segment === example.segment
      const reasonOk = example.reason === undefined || example.reason.test(finding?.reason ?? '')
      check(`  blocked: ${j(example.command)}`, finding !== null && segmentOk && reasonOk, j(finding))
    }
    if (rule.when !== 'always') {
      const allowed = ALLOWED[rule.command]
      check(`${rule.command}: the proof carries allowed forms (the condition is real)`, allowed !== undefined && allowed.length > 0)
      for (const command of allowed ?? []) {
        const finding = judge(command)
        check(`  allowed: ${j(command)}`, finding === null, j(finding))
      }
    }
  }
  for (const name of Object.keys(BLOCKED)) check(`proof row ${j(name)} names a table entry`, names.has(name))
}

section('§2 a compound is judged segment by segment')
{
  const cases: Array<[string, string]> = [
    ['git status && rm -rf build', 'rm -rf build'],
    ['ls -la; touch marker', 'touch marker'],
    ['cd src || mkdir src', 'mkdir src'],
    ["find . -name '*.o' | xargs rm", 'xargs rm'],
    ['echo $(rm -rf x)', 'rm -rf x'],
    ['diff <(rm x) <(ls)', 'rm x'],
    ['if true; then rm x; fi', 'then rm x'],
    ['for f in *.o; do rm "$f"; done', 'do rm "$f"'],
    ['{ rm x; }', '{ rm x'],
    ['f() { rm x; }; f', '{ rm x'],
    ['function f { rm x; }; f', 'function f { rm x'],
    ['ls -la\nrm -rf build', 'rm -rf build'],
    ['git status && echo x > out.txt', '> out.txt'],
  ]
  for (const [command, segment] of cases) {
    const finding = judge(command)
    check(`${j(command)} → ${j(segment)}`, finding?.segment === segment, j(finding))
  }
  check('a compound of read-only segments is not judged mutating', judge('git status && ls -la | head -5; pwd') === null)
  check('the reported segment is the mutating one, never the whole compound', judge('git status && rm -rf build')?.segment !== 'git status && rm -rf build')
}

section('§3 the read-only control set is never judged mutating')
{
  for (const command of READ_ONLY_CONTROL) {
    const finding = judge(command)
    check(`read-only: ${j(command)}`, finding === null, j(finding))
  }
}

section('§4 the temp-dir test and the segment judge')
{
  check('/tmp/x is under the temp roots', isUnderTempRoot('/tmp/x', ROOTS))
  check('/private/tmp/x is under the temp roots', isUnderTempRoot('/private/tmp/x', ROOTS))
  check('/tmp itself counts', isUnderTempRoot('/tmp', ROOTS))
  check('/tmpfoo is not (a prefix is not a directory)', !isUnderTempRoot('/tmpfoo', ROOTS))
  check('/tmp/../etc/hosts normalises out of the temp dir', !isUnderTempRoot('/tmp/../etc/hosts', ROOTS))
  check('a relative target is never in the temp dir', !isUnderTempRoot('tmp/x', ROOTS))
  check('the default roots include the system temp dir and /tmp', isUnderTempRoot(join(tmpdir(), 'x')) && isUnderTempRoot('/tmp/x'))
  check('judgeShellSegment judges one segment', judgeShellSegment('rm x', ROOTS)?.reason === 'rm removes files' && judgeShellSegment('ls', ROOTS) === null)
  check('a segment with no command word is not judged (no evidence, the ordinary road decides)', judgeShellSegment('(', ROOTS) === null && judgeShellSegment("''", ROOTS) === null)
  check('a tolerant tokenise still names the command word', judgeShellSegment("rm 'unterminated", ROOTS)?.reason === 'rm removes files')
}

section('§5 the PowerShell twin judges the parsed segments')
{
  const twinPath = join(import.meta.dir, '../../src/tools/PowerShellTool/modeValidation.ts')
  const twin = await import('../../src/tools/PowerShellTool/modeValidation.ts')
  const findMutatingPowerShellCommand = (twin as Record<string, unknown>).findMutatingPowerShellCommand as ((parsed: unknown) => { segment: string; reason: string } | null) | undefined
  check('PowerShell/modeValidation.ts exports findMutatingPowerShellCommand', typeof findMutatingPowerShellCommand === 'function', readFileSync(twinPath, 'utf8').includes('findMutatingPowerShellCommand') ? 'present but not a function' : 'absent')
  if (typeof findMutatingPowerShellCommand === 'function') {
    const command = (name: string, args: string[], redirections: Array<{ target: string; isMerging: boolean }> = []) => ({
      name,
      text: [name, ...args].join(' '),
      nameType: 'cmdlet',
      args,
      elementType: 'Command',
      redirections,
    })
    const parsed = (commands: ReturnType<typeof command>[], nested: ReturnType<typeof command>[] = [], redirections: Array<{ operator: string; target: string; isMerging: boolean }> = []) => ({
      valid: true,
      statements: [{ statementType: 'PipelineAst', text: commands.map(c => c.text).join(' | '), commands, nestedCommands: nested, redirections }],
      variables: [],
      errors: [],
      hasStopParsing: false,
      originalCommand: commands.map(c => c.text).join(' | '),
    })
    const rows: Array<[string, ReturnType<typeof parsed>, string | null]> = [
      ['Remove-Item -Recurse build', parsed([command('Remove-Item', ['-Recurse', 'build'])]), 'Remove-Item -Recurse build'],
      ['rm (alias) -r build', parsed([command('rm', ['-r', 'build'])]), 'rm -r build'],
      ['del x', parsed([command('del', ['x'])]), 'del x'],
      ['Set-Content a.txt hi', parsed([command('Set-Content', ['a.txt', 'hi'])]), 'Set-Content a.txt hi'],
      ['New-Item -ItemType Directory out', parsed([command('New-Item', ['-ItemType', 'Directory', 'out'])]), 'New-Item -ItemType Directory out'],
      ['mkdir out', parsed([command('mkdir', ['out'])]), 'mkdir out'],
      ['Copy-Item a b', parsed([command('Copy-Item', ['a', 'b'])]), 'Copy-Item a b'],
      ['Move-Item a b', parsed([command('Move-Item', ['a', 'b'])]), 'Move-Item a b'],
      ['Out-File x.txt', parsed([command('Get-Date', []), command('Out-File', ['x.txt'])]), 'Out-File x.txt'],
      ['Tee-Object -FilePath x', parsed([command('Get-Date', []), command('Tee-Object', ['-FilePath', 'x'])]), 'Tee-Object -FilePath x'],
      ['Invoke-WebRequest -OutFile x', parsed([command('Invoke-WebRequest', ['-Uri', 'http://127.0.0.1:1/', '-OutFile', 'x'])]), 'Invoke-WebRequest -Uri http://127.0.0.1:1/ -OutFile x'],
      ['git commit', parsed([command('git', ['commit', '-m', 'x'])]), 'git commit -m x'],
      ['npm install', parsed([command('npm', ['install'])]), 'npm install'],
      ['bun add', parsed([command('bun', ['add', 'zod'])]), 'bun add zod'],
      ['a nested Remove-Item', parsed([command('Write-Output', ['x'])], [command('Remove-Item', ['y'])]), 'Remove-Item y'],
      ['a file redirection on the statement', parsed([command('Get-Content', ['a.txt'])], [], [{ operator: '>', target: 'b.txt', isMerging: false }]), 'Get-Content a.txt'],
      ['a file redirection on a nested command', parsed([command('Write-Output', ['x'])], [command('Get-Content', ['a.txt'], [{ target: 'b.txt', isMerging: false }])]), 'Write-Output x'],
      ['Get-ChildItem', parsed([command('Get-ChildItem', ['-Recurse'])]), null],
      ['ls (alias)', parsed([command('ls', [])]), null],
      ['Get-Content', parsed([command('Get-Content', ['a.txt'])]), null],
      ['Select-String', parsed([command('Select-String', ['-Pattern', 'x', 'a.txt'])]), null],
      ['git status', parsed([command('git', ['status'])]), null],
      ['git log', parsed([command('git', ['log', '--oneline'])]), null],
      ['bun run typecheck', parsed([command('bun', ['run', 'typecheck'])]), null],
      ['Tee-Object -Variable', parsed([command('Get-Date', []), command('Tee-Object', ['-Variable', 'v'])]), null],
      ['Invoke-WebRequest (no -OutFile)', parsed([command('Invoke-WebRequest', ['-Uri', 'http://127.0.0.1:1/'])]), null],
      ['a merging redirection 2>&1', parsed([command('Get-Content', ['a.txt'])], [], [{ operator: '2>&1', target: '1', isMerging: true }]), null],
      ['a $null redirection', parsed([command('Get-Content', ['a.txt'])], [], [{ operator: '>', target: '$null', isMerging: false }]), null],
    ]
    for (const [label, tree, segment] of rows) {
      const finding = findMutatingPowerShellCommand(tree)
      check(`powershell ${label} → ${segment === null ? 'not mutating' : j(segment)}`, segment === null ? finding === null : finding?.segment === segment, j(finding))
    }
    const invalid = { valid: false, statements: [], variables: [], errors: [{ message: 'x', errorId: 'x' }], hasStopParsing: false, originalCommand: 'rm x' }
    check('a failed parse exposes no segments — the twin does not judge it', findMutatingPowerShellCommand(invalid) === null)
  }
}

section('§6 wiring — the verdict entries consult the refusal before any ask, rule or auto-allow')
{
  const bash = readFileSync(join(import.meta.dir, '../../src/tools/BashTool/bashPermissions.ts'), 'utf8')
  const entryAt = bash.indexOf('export async function bashToolHasPermission(')
  const body = bash.slice(entryAt)
  const refusalAt = body.indexOf('checkStrategyShellRefusal(')
  const parseAt = body.indexOf('parseForSecurity(command)')
  check('bashToolHasPermission calls checkStrategyShellRefusal', entryAt !== -1 && refusalAt !== -1)
  check('the refusal precedes the security parse (so it precedes every ask, the sandbox auto-allow and every rule match)', refusalAt !== -1 && parseAt !== -1 && refusalAt < parseAt, `refusal@${refusalAt} parse@${parseAt}`)
  const ps = readFileSync(join(import.meta.dir, '../../src/tools/PowerShellTool/powershellPermissions.ts'), 'utf8')
  const psEntryAt = ps.indexOf('export async function powershellToolHasPermission(')
  const psBody = ps.slice(psEntryAt)
  const psRefusalAt = psBody.indexOf('checkStrategyShellRefusal(')
  const psParseAt = psBody.indexOf('parsePowerShellCommand(command)')
  const psRulesAt = psBody.indexOf('powershellToolCheckExactMatchPermission({ command }')
  check('powershellToolHasPermission calls checkStrategyShellRefusal', psEntryAt !== -1 && psRefusalAt !== -1)
  check('the twin runs right after the parse and before the pre-parse rule checks', psRefusalAt !== -1 && psParseAt !== -1 && psRulesAt !== -1 && psParseAt < psRefusalAt && psRefusalAt < psRulesAt, `parse@${psParseAt} refusal@${psRefusalAt} rules@${psRulesAt}`)
  const mode = readFileSync(join(import.meta.dir, '../../src/tools/BashTool/modeValidation.ts'), 'utf8')
  check("the refusal's words are owned once, beside the mode's other checks (modeValidation.ts)", mode.includes('export function strategyShellRefusal(') && mode.includes("permissionModeTitle('strategy')"))
  const twinSource = readFileSync(join(import.meta.dir, '../../src/tools/PowerShellTool/modeValidation.ts'), 'utf8')
  check('the PowerShell twin speaks the same words (imports strategyShellRefusal, never a second sentence)', twinSource.includes('strategyShellRefusal') && !twinSource.includes('refused running'))
}

finish()
