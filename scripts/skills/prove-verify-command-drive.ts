import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { runTurns, answerOf, isOutcome } from '../lib/rows.ts'

const root = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'verify-drive-')))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
seedFirstRun(home, [cwd])
const { default: command, verifierPrompt } = await import('../../src/commands/verify.ts')
const focus = 'the parser boundary'
const brief = verifierPrompt(`Focus the verification on: ${focus}`)
const expansion = (await command.getPromptForCommand(focus)).map(block => block.text).join('\n')
const verdict = 'The parser boundary fixture was checked.\nVERDICT: PASS'
const fixture = await startFixtureApi([
  { kind: 'tool_use', name: 'Crewmate', input: { description: 'Check the parser boundary', prompt: brief, crewmate_type: 'mercury-crew' }, whenBody: '## Verification brief for the crewmate' },
  { kind: 'text', text: verdict, whenSaid: brief },
  { kind: 'text', text: `The independent check returned:\n${verdict}`, whenBody: 'The parser boundary fixture was checked.' },
])
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
try {
  const node = Bun.which('node')
  if (!node) throw new Error('Node is required for the built command drive')
  const run = await runTurns({
    node,
    dist: join(root, 'dist/mercury.mjs'),
    args: ['--mode', 'sovereign', '--model', 'claude-opus-5'],
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR ?? scratch,
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      MERCURY_THINKING_BINDING: 'drop_block',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_TERMINAL_TITLE: '0',
    },
    turns: [`/verify ${focus}`],
    timeoutMs: 120_000,
  })
  const bodies = fixture.messageRequests().map(request => request.body as { messages?: Array<{ content?: unknown }>; system?: unknown })
  const blocks = (body: typeof bodies[number]) => (body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content as Array<{ type?: string; name?: string; text?: string; content?: unknown }> : [])
  check('/verify expands into the real main request', bodies.some(body => blocks(body).some(block => block.type === 'text' && block.text === expansion)))
  const crew = bodies.find(body => blocks(body).some(block => block.type === 'text' && block.text === brief))
  check('the Agent road dispatches the complete brief as the crewmate user turn', crew !== undefined)
  check('the launched seat carries the crewmate doctrine', crew !== undefined && JSON.stringify(crew.system).includes('a crewmate, spawned for one assignment'))
  const tools = bodies.flatMap(blocks).filter(block => block.type === 'tool_use').map(block => block.name)
  check('the command uses Agent, never a Skill invocation', tools.includes('Crewmate') && !tools.includes('Skill'), tools.join(' '))
  check('the independent verdict returns to the main seat', run.exit === 0 && run.frames.filter(isOutcome).some(frame => answerOf(frame).includes(verdict)), `${run.exit}: ${run.stderr.slice(-500)}`)
} finally {
  await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? 'VERIFY COMMAND DRIVE GREEN' : `VERIFY COMMAND DRIVE RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
