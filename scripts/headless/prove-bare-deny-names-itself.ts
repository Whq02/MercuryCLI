#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ignore from 'ignore'
import { DIST, MODEL, NODE, SCRATCH_ROOT, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { parseFrame, type Frame } from '../lib/rows.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-bare-deny-names-itself')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'bare-deny-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const project = join(scratch, 'proj')
const runHome = join(scratch, 'run-home')
seedScratchHome(runHome, project)
mkdirSync(join(project, '.mercury'), { recursive: true })
writeFileSync(join(project, '.mercury', 'settings.json'), JSON.stringify({ guardrails: { deny: ['Write'], reasons: { Write: 'runs leave no files' } } }, null, 2))
const target = join(project, 'made-by-run.txt')
const ASK = 'write the file once'
const RULE_LINE = 'Write withheld by the deny rule `Write` in the shared project settings'
const REFUSAL = 'Using Write is denied by the rule Write in the shared project settings: runs leave no files.'
let toolNamesSeen: string[] = []
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0) {
    toolNamesSeen = req.toolNames
    return [{ type: 'tool_use', name: 'Write', input: { file_path: target, content: 'x\n' } }]
  }
  const last = req.results[req.results.length - 1]
  return [{ type: 'text', text: `the result read: ${last?.text ?? '(nothing)'}` }]
})

type Turn = { rows: Frame[]; stderr: string; exitCode: number | null }
const runOnce = (): Promise<Turn> =>
  new Promise(resolve => {
    const port = Number(new URL(fixture.base).port)
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--model', MODEL, '--', ASK], { cwd: project, env: childEnv(runHome, port), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const rows: Frame[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        const frame = parseFrame(line)
        if (frame !== null) rows.push(frame)
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ rows, stderr, exitCode: code })
    })
  })

let turn: Turn
try {
  turn = await runOnce()
} finally {
  await fixture.close()
}
const session = turn.rows.find(row => row.type === 'session') as { tools?: string[]; tools_withheld?: Array<{ tool: string; rule: string; source: string }> } | undefined
const notices = turn.rows.filter(row => row.type === 'notice') as Array<{ text?: string; code?: string }>
const results = turn.rows.filter(row => row.type === 'tool_result') as Array<{ status?: string; output?: unknown; content?: unknown }>
const outcome = turn.rows.find(row => row.type === 'outcome') as { status?: string } | undefined
const resultText = (row: { output?: unknown; content?: unknown } | undefined): string => {
  const body = row?.output ?? row?.content
  return typeof body === 'string' ? body : JSON.stringify(body ?? '')
}
console.log(`── rows: ${turn.rows.map(row => String(row.type)).join(' ')} (exit ${turn.exitCode ?? '?'}) ──`)
console.log(`── stderr ──\n${turn.stderr.trim().split('\n').map(line => `│ ${line}`).join('\n')}`)

tally.section('§1 a tool denied by its bare name is named to the operator: the session row, a notice row and the stderr line say which rule withheld it')
tally.check('the run reached an outcome', outcome !== undefined, JSON.stringify({ exit: turn.exitCode, stderr: turn.stderr.slice(-300) }))
tally.check('the session row lists no Write tool (the deny stands)', session !== undefined && Array.isArray(session.tools) && !session.tools.includes('Write'), JSON.stringify(session?.tools?.slice(0, 8)))
tally.check('the model was shown no Write tool', toolNamesSeen.length > 0 && !toolNamesSeen.includes('Write'), JSON.stringify(toolNamesSeen.slice(0, 8)))
tally.check('the session row names the withheld tool, the rule and its source', JSON.stringify(session?.tools_withheld) === JSON.stringify([{ tool: 'Write', rule: 'Write', source: 'in the shared project settings' }]), JSON.stringify(session?.tools_withheld))
tally.check('one notice row says the rule, once', notices.filter(notice => notice.text === RULE_LINE).length === 1 && notices.filter(notice => notice.text === RULE_LINE).every(notice => notice.code === 'tool_withheld'), JSON.stringify(notices))
tally.check('stderr carries the same line once', turn.stderr.split('\n').filter(line => line.includes(RULE_LINE)).length === 1, turn.stderr.slice(-400))

tally.section("§2 a model that reaches for the withheld tool gets the deny rule's own refusal, with the operator's reason — never a 'no such tool' guess")
const first = results[0]
tally.check('the Write call came back as an error result', first !== undefined && first.status !== 'ok', JSON.stringify(first).slice(0, 300))
tally.check('its text is the refusal that names the rule, its source and the reason', first !== undefined && resultText(first).includes(REFUSAL), resultText(first).slice(0, 300))
tally.check("the text never says 'No such tool available'", first !== undefined && !resultText(first).includes('No such tool available'), resultText(first).slice(0, 300))
tally.check('no file was written', !existsSync(target))

tally.section('§3 a rule spelled with an absolute Windows path reads, on a win32 reading, as the file it names (separators and case folded as the OS does)')
{
  const { rootForPattern, relativePath } = await import('../../src/utils/permissions/filesystem.ts')
  const spelled = 'C:\\src\\proj\\made-by-run.txt'
  const anchored = rootForPattern(spelled, 'projectSettings', 'windows')
  tally.check('the backslash spelling anchors at the drive root with a forward-slash relative pattern', /^C:[\\/]$/.test(anchored.root ?? '') && anchored.relative === 'src/proj/made-by-run.txt', JSON.stringify(anchored))
  const rel = relativePath('C:\\', 'C:\\src\\proj\\made-by-run.txt', 'windows')
  tally.check('the relative path from the drive root to the backslash file is the forward-slash form', rel === 'src/proj/made-by-run.txt', rel)
  const matches = (() => {
    try {
      return ignore().add(anchored.relative).test(rel).ignored
    } catch {
      return false
    }
  })()
  tally.check('the rule pattern matches that relative path', matches, `${anchored.relative} vs ${rel}`)
  const folded = relativePath('c:\\SRC\\Proj', 'C:\\src\\proj\\Made-By-Run.txt', 'windows')
  tally.check('case differs between the rule and the path: the win32 reading folds it', folded === 'Made-By-Run.txt', folded)
  const posix = relativePath('/a/B', '/a/b/c.txt', 'macos')
  tally.check('the POSIX reading does not fold case', posix === '../b/c.txt', posix)
  if (process.platform === 'win32') {
    const { enableConfigs } = await import('../../src/utils/config.ts')
    enableConfigs()
    const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
    const { matchingRuleForInput } = await import('../../src/utils/permissions/filesystem.ts')
    const context = { ...getEmptyToolPermissionContext(), alwaysDenyRules: { projectSettings: [`Write(${spelled})`] } }
    const found = matchingRuleForInput(spelled, context as never, 'edit', 'deny')
    tally.check('on this Windows host the absolute rule alone is the matching deny rule for the file it names', found !== null && found.ruleValue.ruleContent === spelled, JSON.stringify(found))
  } else {
    console.log(`[SKIP] the whole matcher on a drive-letter path needs a Windows host (this is ${process.platform}); the two readings above hold the law here`)
  }
}

rmSync(scratch, { recursive: true, force: true })
tally.finish()
