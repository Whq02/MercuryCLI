#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { volumeClones } from '../lib/cloneRoad.ts'
import { checker, contentsOf, count, guideBattery, openWorld, rulesBattery } from './instructionWorld.ts'

const world = openWorld('format-claude')
const { check, section, close } = checker()
const always = (body: string): string => body
const scoped = (patterns: string[], body: string): string => `---\npaths:\n${patterns.map(pattern => `  - "${pattern}"`).join('\n')}\n---\n${body}`
const personalLayer = (path: string, body: string): string => `Contents of ${path} (user's private project instructions, not checked in):\n\n${body}`

try {
  guideBattery({ world, check, section, file: 'CLAUDE.md', convention: 'claude' })
  guideBattery({ world, check, section, file: '.claude/CLAUDE.md', convention: 'claude' })
  rulesBattery({ world, check, section, convention: 'claude', folder: '.claude/rules', ext: '.md', always, scoped })

  section('both guide forms, an import, the local file, beside AGENTS.md')
  const p1 = world.project({
    'AGENTS.md': 'agents-needle\n',
    'CLAUDE.md': 'root-guide-needle\n@docs/style.md\n',
    'docs/style.md': 'imported-style-needle\n',
    '.claude/CLAUDE.md': 'folder-guide-needle\n',
    'CLAUDE.local.md': 'local-layer-needle\n',
    '.cursor/rules/general.mdc': '---\nalwaysApply: true\n---\nother-tool-rule-needle\n',
    'sub/CLAUDE.local.md': 'nested-local-needle\n',
    'sub/a.ts': '\n',
  })
  const d1 = world.drive(p1, { classify: [join(p1, 'CLAUDE.local.md')], touch: [join(p1, 'sub/a.ts')] })
  check("every file composes in a fixed order: AGENTS.md, the root guide and its import, the folder guide, another tool's rule, the local file last", JSON.stringify(d1.paths) === JSON.stringify([join(p1, 'AGENTS.md'), join(p1, 'CLAUDE.md'), join(p1, 'docs/style.md'), join(p1, '.claude/CLAUDE.md'), join(p1, '.cursor/rules/general.mdc'), join(p1, 'CLAUDE.local.md')]), d1.paths.join(', '))
  check('the local file reaches the request as the personal layer of the project', d1.first.endsWith(personalLayer(join(p1, 'CLAUDE.local.md'), 'local-layer-needle')), d1.first)
  const local = d1.entries.find(e => e.path === join(p1, 'CLAUDE.local.md'))
  check('its entry is a local one and names its format', local?.type === 'Local' && local.convention === 'claude', JSON.stringify(local))
  check('it classifies as an instruction file', d1.classified[join(p1, 'CLAUDE.local.md')] === true)
  check('a local file in a nested folder attaches with its folder', d1.touched[0]!.attached.map(a => a.path).includes(join(p1, 'sub/CLAUDE.local.md')), JSON.stringify(d1.touched[0]))
  const p1b = world.project({ 'CLAUDE.local.md': 'local-layer-needle\n', 'src/a.ts': '\n' })
  const d1b = world.drive(p1b)
  check('alone, the local file composes and is not the guide of its folder', d1b.first === personalLayer(join(p1b, 'CLAUDE.local.md'), 'local-layer-needle') && d1b.guides.length === 0, `${d1b.first} ${JSON.stringify(d1b.guides)}`)
  const p1c = world.project({ 'MERCURY.md': 'native-needle\n', 'CLAUDE.md': 'root-guide-needle\n', '.claude/CLAUDE.md': 'folder-guide-needle\n', 'CLAUDE.local.md': 'local-layer-needle\n', '.claude/rules/x.md': 'rule-needle\n' })
  check('MERCURY.md decides over all of them', world.drive(p1c).first === contentsOf(join(p1c, 'MERCURY.md'), 'native-needle'))

  section("that tool's own folder in the home folder is never read")
  const p2 = world.project({
    '.claude/CLAUDE.md': 'personal-guide-needle\n',
    '.claude/rules/always.md': 'personal-rule-needle\n',
    '.claude/rules/scoped.md': scoped(['*.ts'], 'personal-scoped-needle\n'),
    'CLAUDE.md': 'home-root-needle\n',
    'a.ts': '\n',
    'work/proj/CLAUDE.md': 'project-guide-needle\n',
    'work/proj/a.ts': '\n',
  })
  const d2 = world.drive(join(p2, 'work/proj'), { home: p2, trust: p2, touch: [join(p2, 'work/proj/a.ts')] })
  check('from a project under home the project guide alone composes and nothing attaches', d2.first === contentsOf(join(p2, 'work/proj/CLAUDE.md'), 'project-guide-needle') && d2.touched[0]!.attached.length === 0, `${d2.first} ${JSON.stringify(d2.touched[0])}`)
  const d2b = world.drive(p2, { home: p2, touch: [join(p2, 'a.ts')] })
  check('started in the home folder itself, its root guide is read and that folder is not', d2b.first === contentsOf(join(p2, 'CLAUDE.md'), 'home-root-needle') && d2b.touched[0]!.attached.length === 0, `${d2b.first} ${JSON.stringify(d2b.touched[0])}`)
  check('the guide list there names the root guide alone', JSON.stringify(d2b.guides) === JSON.stringify([join(p2, 'CLAUDE.md')]), JSON.stringify(d2b.guides))
  const d2c = world.drive(join(p2, 'work/proj'), { trust: p2 })
  check('with the home elsewhere the same folders are plain parents and their files compose', ['personal-guide-needle', 'personal-rule-needle', 'home-root-needle', 'project-guide-needle'].every(needle => d2c.first.includes(needle)), d2c.paths.join(', '))
  const d2d = world.drive(join(p2, 'work/proj'), { home: p2, trust: p2, personal: '@~/.claude/CLAUDE.md\nmy-own-needle\n' })
  check("an @~/ line in the user's own MERCURY.md brings the personal guide in, once, beside the project's", count(d2d.first, 'personal-guide-needle') === 1 && d2d.first.includes('project-guide-needle') && !d2d.first.includes('personal-rule-needle'), d2d.paths.join(', '))

  section('where the loaded instructions are listed, its files carry its name')
  const d3 = world.drive(p1, { screens: true })
  check('a loaded guide reads by its tool in /memory files', d3.rows.includes('Claude Code · ./CLAUDE.md') && d3.rows.includes('Claude Code · ./.claude/CLAUDE.md') && d3.rows.includes('Claude Code · ./CLAUDE.local.md'), JSON.stringify(d3.rows))
  check('the health note counts its sources under its name', d3.words.health === '6 source(s) from other tools (AGENTS.md 1 · Claude Code 4 · Cursor 1): no MERCURY.md in or above the working directory', d3.words.health)
  const d3b = world.drive(p1c, { screens: true })
  check('under a MERCURY.md each of its files says which import brings it back', JSON.stringify(d3b.listed) === JSON.stringify([
    'Claude Code · ./CLAUDE.md · not loaded: MERCURY.md decides; import it with @CLAUDE.md',
    'Claude Code · ./.claude/CLAUDE.md · not loaded: MERCURY.md decides; import it with @.claude/CLAUDE.md',
    'Claude Code · ./CLAUDE.local.md · not loaded: MERCURY.md decides; import it with @CLAUDE.local.md',
    'Claude Code · ./.claude/rules/x.md · not loaded: MERCURY.md decides; import it with @.claude/rules/x.md',
  ]), JSON.stringify(d3b.listed))

  section('/orient keeps what loads: the guides as lines of MERCURY.md, the local file as a line of MERCURY.local.md')
  const p4 = world.project({ 'CLAUDE.md': 'root-guide-needle\n', '.claude/CLAUDE.md': 'folder-guide-needle\n', '.claude/rules/x.md': 'rule-needle\n', 'CLAUDE.local.md': 'local-layer-needle\n' })
  const d4 = world.drive(p4, { orient: true })
  check('its guides and its rules folder are the first lines of MERCURY.md and its local file belongs in MERCURY.local.md', d4.orient.endsWith("\n\nOther tools' files that load here today — the first lines of MERCURY.md:\n@CLAUDE.md\n@.claude/CLAUDE.md\n@.claude/rules\n\nA file that is personal or stands outside this project loads here today — its line belongs in MERCURY.local.md, never in MERCURY.md:\n@CLAUDE.local.md\n"), d4.orient.slice(-500))

  section("a crewmate's isolated copy of the project: its ignored files stay behind whatever the process that makes the copy has loaded")
  if (process.platform === 'win32' || !volumeClones(world.scratch)) {
    console.log('[SKIP] this volume cannot clone a file: a copy is carried nothing git ignores here')
  } else {
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const ignored = ['CLAUDE.local.md', 'src/CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/rules/style.md']
    const beside = ['.claude/settings.local.json', 'dist/app.js', '.env']
    const quietHome = join(world.scratch, 'no-home')
    mkdirSync(quietHome)
    const copyOf = (guided: boolean, loads: boolean): { result: Record<string, string> | null; copy: string } => {
      const dir = world.project({
        '.gitignore': 'CLAUDE.local.md\n.claude/\ndist/\n.env\n.mercury/\n',
        'CLAUDE.md': 'tracked-guide-needle\n',
        'src/a.ts': '\n',
        ...(guided ? { 'MERCURY.md': 'native-needle\n' } : {}),
        ...Object.fromEntries([...ignored, ...beside].map(rel => [rel, `${rel}\n`])),
      })
      git(dir, 'init', '-q', '-b', 'main')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'first')
      const child = spawnSync(process.execPath, [join(import.meta.dir, '../agents/prove-worktree-carry.ts'), 'claude-files', dir, ...ignored, ...beside], { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', env: { ...process.env, HOME: quietHome, USERPROFILE: quietHome, CARRY_SCENARIO_HOME: join(world.scratch, 'no-config'), ...(loads ? { CARRY_SCENARIO_LOADS: '1' } : {}) } })
      const line = (child.stdout ?? '').split('\n').find(row => row.startsWith('RESULT '))
      return { result: line === undefined ? null : (JSON.parse(line.slice('RESULT '.length)) as Record<string, string>), copy: join(dir, '.mercury', 'worktrees', 'agent-ad900001') }
    }
    type Copied = ReturnType<typeof copyOf>
    const came = (made: Copied): string[] => (made.result === null ? ['no answer'] : ignored.filter(rel => made.result![rel] !== 'absent'))
    const restCame = (made: Copied): boolean => made.result !== null && beside.every(rel => made.result![rel] === 'file')
    const asGitPutsIt = (made: Copied): boolean => existsSync(join(made.copy, 'CLAUDE.md')) && readFileSync(join(made.copy, 'CLAUDE.md'), 'utf8') === 'tracked-guide-needle\n' && git(made.copy, 'ls-files', '--', 'CLAUDE.md') === 'CLAUDE.md' && git(made.copy, 'status', '--porcelain') === ''
    const unloaded = copyOf(false, false)
    const composed = copyOf(false, true)
    const decided = copyOf(true, true)
    check('a process that has loaded no instruction file leaves its ignored local file, folder guide and rule file behind', came(unloaded).length === 0, came(unloaded).join(', '))
    check('a session that composed its files leaves them behind', composed.result?.['other tools composed'] === 'true' && came(composed).length === 0, `${composed.result?.['other tools composed']} | ${came(composed).join(', ')}`)
    check('a session whose MERCURY.md decides, which composed none of them, leaves them behind all the same', decided.result?.['other tools composed'] === 'false' && came(decided).length === 0, `${decided.result?.['other tools composed']} | ${came(decided).join(', ')}`)
    check("in all three the rest git ignores comes, with the settings file that lies in that tool's ignored folder", restCame(unloaded) && restCame(composed) && restCame(decided), `${JSON.stringify(unloaded.result)} ${JSON.stringify(composed.result)} ${JSON.stringify(decided.result)}`)
    check('the guide kept in git is in each copy exactly as git puts it there', asGitPutsIt(unloaded) && asGitPutsIt(composed) && asGitPutsIt(decided))
  }
} finally {
  world.close()
}
close('format-claude')
