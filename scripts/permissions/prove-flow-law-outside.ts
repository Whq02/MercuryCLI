#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { ROADS, allowedByFlow, asksWith, check, finish, j, openKit, refusedWith, section, sentence } from './flowLawKit.ts'

const kit = await openKit('flow-law-outside')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getProjectTempDir, getScratchpadDir } = await import('../../src/utils/permissions/filesystem.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')

const HOME = homedir()
const ledger = join(getProjectTempDir(), String(getSessionId()), 'created-paths.txt')
mkdirSync(join(getProjectTempDir(), String(getSessionId())), { recursive: true })
appendFileSync(ledger, '/usr/local/lib/mercury-made-this-run\n')
const tilde = (path: string): string => (path.startsWith(`${HOME}/`) || path.startsWith(`${HOME}\\`) ? `~${path.slice(HOME.length)}` : path)
const OUTSIDE_FILE = `Flow asks before writing ${tilde(normalize(`${HOME}/.zshrc`))}: it is outside the project.`
const outside = (shown: string, verb: string, path: string): string => `Flow asks before ${shown}: ${verb} ${tilde(path)}, outside the project.`
const tempRoot = process.platform === 'win32' ? tmpdir() : '/tmp'

try {
  section('§1 item 4 asks: a delete or an overwrite outside the project and this run\'s scratch, on every road')
  const asks: Array<[string, string, string?]> = [
    ['rm -rf ~/other', outside('rm -rf ~/other', 'it deletes', `${HOME}/other`)],
    ['rm -rf /usr/local/lib/node_modules', outside('rm -rf /usr/local/lib/node_modules', 'it deletes', '/usr/local/lib/node_modules')],
    ['rm -f /etc/hosts', outside('rm -f /etc/hosts', 'it deletes', '/etc/hosts')],
    ['rm -rf ~/Developer/other-project/dist', outside('rm -rf ~/Developer/other-project/dist', 'it deletes', `${HOME}/Developer/other-project/dist`)],
    ['mv src/x.ts ~/Desktop/', outside('mv src/x.ts ~/Desktop/', 'it moves', `${HOME}/Desktop/`)],
    ['cp -r dist ~/Sites/', outside('cp -r dist ~/Sites/', 'it overwrites', `${HOME}/Sites/`)],
    ['echo "export X=1" >> ~/.zshrc', outside('echo "export X=1" >> ~/.zshrc', 'it writes', `${HOME}/.zshrc`)],
    ['echo "export X=1" >> "$HOME/.zshrc"', outside('echo "export X=1" >> "$HOME/.zshrc"', 'it writes', `${HOME}/.zshrc`)],
    ['cat config > /etc/nginx/nginx.conf', outside('cat config > /etc/nginx/nginx.conf', 'it writes', '/etc/nginx/nginx.conf')],
    ['sed -i "s/a/b/" /etc/hosts', outside('sed -i s/a/b/ /etc/hosts', 'it edits', '/etc/hosts')],
    ['tee -a /etc/hosts < extra', outside('tee -a /etc/hosts', 'it writes', '/etc/hosts')],
    ['truncate -s 0 ~/.bash_history', outside('truncate -s 0 ~/.bash_history', 'it truncates', `${HOME}/.bash_history`)],
    ['find ~/Library/Caches -name "*.tmp" -delete', outside('find ~/Library/Caches -name *.tmp -delete', 'it deletes under', `${HOME}/Library/Caches`)],
    ['curl -o /usr/local/bin/tool https://example.invalid/tool', outside('curl -o /usr/local/bin/tool https://example.invalid/tool', 'it writes', '/usr/local/bin/tool')],
    ['dd if=/dev/zero of=/dev/disk2 bs=1m', outside('dd if=/dev/zero of=/dev/disk2 bs=1m', 'it overwrites', '/dev/disk2')],
    ['cd /usr/local/lib && rm -rf node_modules', outside('rm -rf node_modules', 'it deletes', resolve('/usr/local/lib', 'node_modules'))],
    ['cd ~ && echo x > notes.txt', outside('echo x > notes.txt', 'it writes', resolve(HOME, 'notes.txt'))],
    ['rm -rf ../sibling', outside('rm -rf ../sibling', 'it deletes', resolve('/usr/local/lib', '../sibling')), '/usr/local/lib'],
    ['rm -rf dist', outside('rm -rf dist', 'it deletes', resolve('/usr/local/lib', 'dist')), '/usr/local/lib'],
    ['rm -rf /etc/$name', outside('rm -rf /etc/$name', 'it deletes', '/etc/')],
    ['bash -c "rm -rf ~/other"', outside('rm -rf ~/other', 'it deletes', `${HOME}/other`)],
    ['ls && { rm -rf ~/other; }', outside('rm -rf ~/other', 'it deletes', `${HOME}/other`)],
  ]
  for (const [command, words, cwd] of asks) {
    for (const road of ROADS) {
      const outcome = await kit.decide(command, { road, ...(cwd === undefined ? {} : { cwd }) })
      const ok = road === 'prompt-less' ? refusedWith(outcome, words) : asksWith(outcome, words) && outcome.wrapper.decidedBy === 'flowLaw'
      check(`${road}: ${command}${cwd ? ` (cwd ${cwd})` : ''} → ${road === 'prompt-less' ? 'refused with' : 'asks'} "${words}"`, ok, j(outcome.decision))
    }
  }

  section('§2 the neighbour that is not the item runs: the project, the temp roots, this run\'s own paths, reads anywhere, cd anywhere, chmod, creation')
  mkdirSync(join(kit.project, 'dist'), { recursive: true })
  const scratch = getScratchpadDir()
  for (const command of [
    'rm -rf dist', 'rm -rf build dist node_modules .next', `rm -rf ${kit.project}/dist`, 'rm -rf .git', 'rm -rf *.log', 'git checkout -- . && rm -rf coverage',
    'sed -i "s/a/b/" src/x.ts', 'perl -pi -e "s/a/b/" src/x.ts', 'echo hi > out.txt', 'cat a > b 2>/dev/null', 'npm test > test.log 2>&1', 'tee notes.txt',
    'cp src/x.ts src/y.ts', 'mv src/x.ts src/z.ts', 'truncate -s 0 app.log', 'ln -sf ../x bin/x',
    'rm -rf /tmp/scratch-123', 'rm -rf /tmp/handbook-out /tmp/blog-out', 'echo x > /tmp/notes.txt', 'mkdir -p /tmp/w && cd /tmp/w && rm -rf old', 'cat > /tmp/nav.test.mjs <<EOF\nconsole.log(1)\nEOF',
    `rm -rf ${process.env.TMPDIR ?? '/tmp'}/x`, `rm -rf ${scratch}/anything`, `echo x > ${scratch}/note.txt`,
    'rm -rf /usr/local/lib/mercury-made-this-run', 'rm -rf /usr/local/lib/mercury-made-this-run/inner', 'echo x > /usr/local/lib/mercury-made-this-run/a.txt',
    'cat /etc/hosts', 'ls ~/Desktop', 'grep -r TODO ~/Developer/other-project', 'head -n 5 ~/.zshrc', 'find /usr/local -name "*.pc" | wc -l', 'stat /etc/passwd', 'tail -f /var/log/system.log', 'diff /etc/hosts hosts.bak',
    'cd /etc && ls', 'cd ~/Developer/other-project && git status', 'cd /usr/local/lib && ls node_modules', 'pushd /etc && cat hosts && popd', 'cd .. && ls',
    'chmod +x scripts/run.sh', 'chown -R me:staff /usr/local/lib/x',
    'mkdir -p ~/Developer/new-project', 'touch /etc/nothing', 'mkdir -p /opt/tools',
    'echo "rm -rf ~/other" >> README.md', 'grep -rn "rm -rf /" docs/', 'rm -rf "$DIR"', 'rm -rf $OUT/x', 'rm -rf $(mktemp -d)', 'for f in sites/*.md; do rm -rf "$f"; done',
    'scp src/x.ts host.invalid:/tmp/x', 'cp src/x.ts user@host.invalid:/tmp/x', 'rsync -a dist/ host.invalid:/srv/site/',
    'cat < /etc/hosts', 'python3 -c "print(open(\'/etc/hosts\').read())"', 'node -e "require(\'fs\').readFileSync(\'/etc/hosts\')"', '2>/dev/null ls', 'ls 2>&1 | tee /dev/stderr',
  ]) {
    for (const road of ROADS) {
      const outcome = await kit.decide(command, { road })
      check(`${road}: ${command.replace(/\n/g, '\\n')} runs`, allowedByFlow(outcome), j(outcome.decision))
    }
  }
  for (const road of ROADS) {
    const outcome = await kit.decide('chmod 600 ~/.ssh/config', { road })
    check(`${road}: chmod 600 ~/.ssh/config is refused in Flow as in every mode: the file stands in a credential store`, outcome.decision.behavior === 'deny' && /is refused: .+ is a protected system or credential path\.$/.test(outcome.decision.message ?? ''), j(outcome.decision))
  }

  section('§3 the file tools: a write outside asks in one sentence; inside, the scratch, the temp roots and reads anywhere run')
  for (const road of ROADS) {
    const zshrc = await kit.decideTool(FileWriteTool, { file_path: `${HOME}/.zshrc`, content: 'export X=1\n' }, { road })
    check(`${road}: Write ~/.zshrc → ${road === 'prompt-less' ? 'refused with' : 'asks'} "${OUTSIDE_FILE}"`, road === 'prompt-less' ? refusedWith(zshrc, OUTSIDE_FILE) : asksWith(zshrc, OUTSIDE_FILE) && zshrc.wrapper.decidedBy === 'flowLaw', j(zshrc.decision))
    const other = await kit.decideTool(FileEditTool, { file_path: `${HOME}/Developer/other-project/src/index.ts`, old_string: 'a', new_string: 'b' }, { road })
    check(`${road}: Edit in another project asks as item 4`, road === 'prompt-less' ? other.decision.behavior === 'deny' : asksWith(other, `Flow asks before writing ${tilde(normalize(`${HOME}/Developer/other-project/src/index.ts`))}: it is outside the project.`), j(other.decision))
    const etc = await kit.decideTool(FileWriteTool, { file_path: '/etc/hosts', content: '' }, { road })
    check(`${road}: Write /etc/hosts asks as item 4`, road === 'prompt-less' ? etc.decision.behavior === 'deny' : asksWith(etc, `Flow asks before writing ${normalize('/etc/hosts')}: it is outside the project.`), j(etc.decision))
    for (const [tool, input, label] of [
      [FileWriteTool, { file_path: join(kit.project, 'src', 'new.ts'), content: 'export {}\n' }, 'Write inside the project'],
      [FileEditTool, { file_path: join(kit.project, 'src', 'x.ts'), old_string: 'a', new_string: 'b' }, 'Edit inside the project'],
      [FileWriteTool, { file_path: join(kit.project, '.vscode', 'settings.json'), content: '{}\n' }, 'Write a project .vscode file'],
      [FileWriteTool, { file_path: join(kit.project, '.git', 'info', 'exclude'), content: 'dist\n' }, 'Write under the project .git'],
      [FileWriteTool, { file_path: '/tmp/flow-law-note.txt', content: 'x\n' }, 'Write under /tmp'],
      [FileWriteTool, { file_path: join(scratch, 'report.md'), content: 'x\n' }, 'Write in the scratchpad'],
      [FileWriteTool, { file_path: '/usr/local/lib/mercury-made-this-run/a.txt', content: 'x\n' }, 'Write under a path this run created'],
      [FileReadTool, { file_path: `${HOME}/.zshrc` }, 'Read ~/.zshrc'],
      [FileReadTool, { file_path: '/etc/hosts' }, 'Read /etc/hosts'],
      [FileReadTool, { file_path: `${HOME}/Developer/other-project/src/index.ts` }, 'Read another project'],
    ] as const) {
      const outcome = await kit.decideTool(tool, input as never, { road })
      check(`${road}: ${label} runs`, allowedByFlow(outcome), j(outcome.decision))
    }
  }

  section('§4 the operator\'s own rules outrank the item; the item is Flow\'s alone')
  const allowed = await kit.decide('rm -rf ~/other', { rules: { allow: ['Edit(~/other/**)'] } })
  check('an Edit allow rule over the folder runs the outside delete without a question', allowed.decision.behavior === 'allow', j(allowed.decision))
  const ruleEdit = await kit.decideTool(FileWriteTool, { file_path: `${HOME}/.zshrc`, content: '' }, { rules: { allow: ['Edit(~/.zshrc)'] } })
  check('an Edit allow rule runs the outside write without a question', ruleEdit.decision.behavior === 'allow', j(ruleEdit.decision))
  for (const command of ['rm -rf ~', 'rm -rf /']) {
    const refused = await kit.decide(command)
    check(`${command} is refused before Flow is consulted (the runtime protects itself; a refusal is not a card)`, refused.decision.behavior === 'deny' && !sentence(refused).startsWith('Flow asks'), j(refused.decision))
  }
  const denied = await kit.decide('rm -rf ~/other', { rules: { deny: ['Bash(rm *)'] } })
  check('a deny rule refuses outright', denied.decision.behavior === 'deny' && denied.decision.decisionReason?.type === 'rule', j(denied.decision))
  const sovereign = await kit.decide('rm -rf ~/other', { mode: 'sovereign' })
  check('sovereign runs the outside delete', sovereign.decision.behavior === 'allow', j(sovereign.decision))
  const byDefault = await kit.decide('rm -rf ~/other', { mode: 'default' })
  check('default asks in its own words', byDefault.decision.behavior === 'ask' && !sentence(byDefault).startsWith('Flow asks'), j(byDefault.decision))
  check('own ground: the project, a temp child, the scratchpad and a ledger path are free; the temp root itself, home and a dotfile are not', kit.isOwnGround(kit.project) && kit.isOwnGround(join(tempRoot, 'x')) && kit.isOwnGround(scratch) && kit.isOwnGround('/usr/local/lib/mercury-made-this-run/x') && !kit.isOwnGround(tempRoot) && !kit.isOwnGround(HOME) && !kit.isOwnGround(`${HOME}/.zshrc`) && !kit.isOwnGround('/usr/local/lib/other'), [kit.isOwnGround(kit.project), kit.isOwnGround(join(tempRoot, 'x')), kit.isOwnGround(scratch), kit.isOwnGround('/usr/local/lib/mercury-made-this-run/x'), !kit.isOwnGround(tempRoot), !kit.isOwnGround(HOME), !kit.isOwnGround(`${HOME}/.zshrc`), !kit.isOwnGround('/usr/local/lib/other')].join(','))
} finally {
  kit.close()
}
finish('prove-flow-law-outside')
