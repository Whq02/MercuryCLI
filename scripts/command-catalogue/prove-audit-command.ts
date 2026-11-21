import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FIXTURE_MODEL } from '../lib/builtProduct.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { answerOf, isCompleted, isOutcome, runTurns } from '../lib/rows.ts'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error(`prove-audit-command: ${DIST} is absent — run \`bun run build.ts\` first`)
  process.exit(1)
}

type RequestBody = { messages?: Array<{ content?: unknown }> }

function requestTexts(body: RequestBody): string[] {
  const texts: string[] = []
  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') texts.push(message.content)
    else if (Array.isArray(message.content)) {
      for (const block of message.content as Array<{ type?: string; text?: string }>) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      }
    }
  }
  return texts
}

function sectionBetween(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  if (from < 0) return ''
  const after = from + start.length
  const to = text.indexOf(end, after)
  return to < 0 ? text.slice(after) : text.slice(after, to)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'audit-command-')))
const home = join(scratch, 'home')
const origin = join(scratch, 'origin.git')
const work = join(scratch, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(origin, { recursive: true })

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture Author',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] })
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const fixture = await startFixtureApi([{ kind: 'text', text: 'No findings in this benign fixture.' }])
try {
  git(origin, 'init', '--bare', '-b', 'main')
  git(scratch, 'clone', origin, work)
  writeFileSync(join(work, 'base.txt'), 'initial fixture content\n')
  git(work, 'add', 'base.txt')
  git(work, 'commit', '-m', 'Initial base commit')
  git(work, 'push', '-u', 'origin', 'main')
  git(work, 'remote', 'set-head', 'origin', 'main')
  git(work, 'checkout', '-b', 'feature/audit-fixture')
  writeFileSync(join(work, 'greeting.ts'), "export const fixtureGreeting = 'audit-branch-marker-742'\n")
  git(work, 'add', 'greeting.ts')
  git(work, 'commit', '-m', 'Add benign fixture greeting')
  writeFileSync(join(work, 'untracked-note.txt'), 'working tree marker\n')

  seedFirstRun(home, [work])

  const run = await runTurns({
    node: nodeBinPath(),
    dist: DIST,
    args: ['--model', FIXTURE_MODEL],
    cwd: work,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR ?? scratch,
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_TERMINAL_TITLE: '0',
    },
    turns: ['/audit'],
    timeoutMs: 120_000,
  })

  const texts = fixture.messageRequests().flatMap(request => requestTexts(request.body as RequestBody))
  const expanded = texts.find(text => text.includes('Current state of the branch:')) ?? ''
  const statusSection = sectionBetween(expanded, 'Status:', 'Files changed vs. the default branch:')
  const filesSection = sectionBetween(expanded, 'Files changed vs. the default branch:', 'Commits on this branch:')
  const logSection = sectionBetween(expanded, 'Commits on this branch:', 'Full diff vs. the default branch:')
  const diffSection = sectionBetween(expanded, 'Full diff vs. the default branch:', '## Objective')

  check('/audit expands and reaches the model in default permission mode', expanded.length > 0, `requests=${fixture.messageRequests().length} stderr=${run.stderr.slice(-300)}`)
  check('git status section reports branch and working tree file', statusSection.includes('feature/audit-fixture') && statusSection.includes('untracked-note.txt'), statusSection.slice(0, 200))
  check('git diff --name-only section lists changed file and omits base file', filesSection.includes('greeting.ts') && !filesSection.includes('base.txt'), filesSection.slice(0, 200))
  check('git log section lists branch commit and omits base commit', logSection.includes('Add benign fixture greeting') && !logSection.includes('Initial base commit'), logSection.slice(0, 200))
  check('git diff section carries the branch diff hunk', diffSection.includes("+export const fixtureGreeting = 'audit-branch-marker-742'"), diffSection.slice(0, 200))
  check('no raw inline shell markers remain unexpanded', !expanded.includes('!`git '))
  check('/audit turn completes with the model answer', run.exit === 0 && run.frames.filter(isOutcome).some(frame => isCompleted(frame) && answerOf(frame).includes('No findings in this benign fixture.')), `exit=${run.exit}`)
} finally {
  await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? 'AUDIT COMMAND GREEN' : `AUDIT COMMAND RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
