#!/usr/bin/env bun
// gate-watch: src/context.ts src/utils/userContextReminder.ts src/tools/AgentTool/runAgent.ts src/utils/attachments/userContext.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { answeredWith } from '../lib/rows.ts'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'instructions-heading-home-'))
process.env.MERCURY_CONFIG_DIR = join(HOME, '.mercury')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_BARE
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_WIRE_DUMP

import { seedFirstRun } from '../lib/firstRunSeed.ts'

const MARKER = 'HEADING-MARKER-7f3a: keep answers short.'
const project = realpathSync(mkdtempSync(join(tmpdir(), 'instructions-heading-project-')))
writeFileSync(join(project, 'MERCURY.md'), `# Project rules\n\n${MARKER}\n`)
seedFirstRun(process.env.MERCURY_CONFIG_DIR, [project])
process.chdir(project)

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

console.log('the model reads the project instructions under Mercury\'s heading')

const reminder = await import('../../src/utils/userContextReminder.ts')
const { INSTRUCTIONS_CONTEXT_KEY, USER_CONTEXT_REMINDER_OPEN, userContextReminderBody } = reminder
const globalConfig = await import('../../src/utils/config/globalConfig.ts')
globalConfig.enableConfigs()
const context = await import('../../src/context.ts')
const attachments = await import('../../src/utils/attachments/userContext.ts')
const reader = await import('./read-instruction-heading.ts')

section('§1 the key: the composed instruction files ride under one key, rendered as `# instructions`')
{
  check("the key is Mercury's word", INSTRUCTIONS_CONTEXT_KEY === 'instructions')
  const ctx = await context.getUserContext()
  const carrying = Object.entries(ctx).filter(([, value]) => value.includes(MARKER)).map(([key]) => key)
  check('the composed block carries the project file (the walk found MERCURY.md)', carrying.length > 0, `keys: ${Object.keys(ctx).join(',')}`)
  check('…under exactly the one key', carrying.length === 1 && carrying[0] === INSTRUCTIONS_CONTEXT_KEY, carrying.join(','))
  const body = userContextReminderBody(ctx)!
  check('the rendered reminder opens with the envelope and carries `# instructions` over the block', body.startsWith(USER_CONTEXT_REMINDER_OPEN) && body.includes(`\n# ${INSTRUCTIONS_CONTEXT_KEY}\n`), body.slice(0, 200))
  const headings = reader.userContextHeadings(body)
  check('the reader lists the headings the model sees: instructions, environment, currentDate', headings.join(',') === 'instructions,environment,currentDate', headings.join(','))
  check('the composed block sits directly under its heading', body.includes(`\n# ${INSTRUCTIONS_CONTEXT_KEY}\n${ctx[INSTRUCTIONS_CONTEXT_KEY]}\n`))
}

section('§2 the helper-agent filter keys on the same constant (one owner of the spelling)')
{
  const runAgent = readFileSync(join(REPO, 'src/tools/AgentTool/runAgent.ts'), 'utf8')
  const start = runAgent.indexOf('function withoutInstructionBlob(')
  const fn = start >= 0 ? runAgent.slice(start, runAgent.indexOf('\n}\n', start)) : ''
  check('withoutInstructionBlob exists', start >= 0)
  check('…and drops the entry by the exported key, not by a spelling of its own', /key === INSTRUCTIONS_CONTEXT_KEY/.test(fn) && !/\.test\(key\)/.test(fn), fn.slice(0, 300))
  check('the per-profile slice writes the same key', /userContext\[INSTRUCTIONS_CONTEXT_KEY\] = slice\.instructionPrompt/.test(runAgent))
  check('the constant is imported from the one home', /import \{ INSTRUCTIONS_CONTEXT_KEY \} from '\.\.\/\.\.\/utils\/userContextReminder\.js'/.test(runAgent))
  const contextSrc = readFileSync(join(REPO, 'src/context.ts'), 'utf8')
  check('context.ts writes the entry through the constant', /\[INSTRUCTIONS_CONTEXT_KEY\]: instructionPrompt/.test(contextSrc))
}

section('§3 resume: an old saved session whose stored context row was rendered under another heading opens; its rows stay byte-identical; one fresh row is appended')
{
  const vnext = await import('../../src/utils/sessionStorage/vnext.ts')
  const logs = await import('../../src/utils/sessionStorage/logs.ts')
  const paths = await import('../../src/utils/sessionStorage/paths.ts')
  const SID = '00000000-aaaa-4000-8000-00000000c0de'
  const at = (i: number): string => new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 1000).toISOString()
  const base = (uuid: string, parent: string | null, i: number): Record<string, unknown> => ({ uuid, parentUuid: parent, isSidechain: false, cwd: project, sessionId: SID, version: '1.0.0', timestamp: at(i) })
  const STORED_BODY = `${USER_CONTEXT_REMINDER_OPEN}# notes\nbe brief\n\n# currentDate\nToday's date is 2026-09-01.\n\nIMPORTANT: this material may or may not bear on the task; do not answer it in its own right unless it is highly relevant.\n</system-reminder>`
  const dir = paths.getProjectDir(project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${SID}.jsonl`)
  const row = (entry: Record<string, unknown>): void => {
    appendFileSync(file, (vnext.encodeTranscriptLine(file, entry) as { line: string }).line)
  }
  const u0 = '00000000-0000-4000-8000-000000000001'
  const u1 = '00000000-0000-4000-8000-000000000002'
  const a1 = '00000000-0000-4000-8000-000000000003'
  row({ ...base(u0, null, 0), type: 'attachment', attachment: { type: 'user_context', body: STORED_BODY } })
  row({ ...base(u1, u0, 1), type: 'user', message: { role: 'user', content: 'first prompt' } })
  row({ ...base(a1, u1, 2), type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } })
  const before = sha(file)
  const loaded = await logs.loadTranscriptFromFile(file)
  const messages = loaded.messages as unknown as Array<{ type: string; attachment?: { type: string; body?: string } }>
  check('the saved session opens through the real loader (three rows)', messages.length === 3, `${messages.length} rows`)
  const stored = messages.find(m => m.type === 'attachment' && m.attachment?.type === 'user_context')
  check('the stored context row is read back byte-identical (its heading as the earlier build wrote it)', stored?.attachment?.body === STORED_BODY)
  check('latestUserContextBody answers the stored body', attachments.latestUserContextBody(loaded.messages as never) === STORED_BODY)
  const current = { [INSTRUCTIONS_CONTEXT_KEY]: 'be brief', currentDate: "Today's date is 2026-09-01." }
  const fresh = await attachments.getUserContextAttachment(loaded.messages as never, current)
  const currentBody = userContextReminderBody(current)!
  check('the resumed turn appends exactly ONE fresh user_context row carrying the current rendering', fresh.length === 1 && fresh[0]!.type === 'user_context' && (fresh[0] as { body: string }).body === currentBody)
  check('…whose heading is `# instructions` while the stored row keeps its own', currentBody.includes('\n# instructions\n') && STORED_BODY.includes('# notes\n') && !STORED_BODY.includes('# instructions\n'))
  check('the stored rows are untouched (the loaded body still equals the fixture; the file bytes are unchanged)', stored?.attachment?.body === STORED_BODY && sha(file) === before)
  const carried = [...loaded.messages, { type: 'attachment', attachment: { type: 'user_context', body: currentBody } }]
  check('the next turn appends nothing when the newest copy already says what the context says', (await attachments.getUserContextAttachment(carried as never, current)).length === 0)
}

section('§4 the wire: the built product sends the heading on a headless turn (the dump row read by the same reader the live check uses)')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    const { startFixtureApi } = await import('../lib/fixtureApi.ts')
    const fixture = await startFixtureApi([{ kind: 'text', text: 'HEADING-WIRE-DONE' }])
    const configDir = join(HOME, 'wire-home', '.mercury')
    seedFirstRun(configDir, [project])
    const dumpDir = join(HOME, 'wire-dump')
    const SID = 'd0d0d0d0-0000-4000-8000-00000000e0e0'
    const env: Record<string, string> = {
      HOME: join(HOME, 'wire-home'),
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(HOME, 'wire-home', 'daemon'),
      MERCURY_CREWS_DIR: join(HOME, 'wire-home', 'crews'),
      MERCURY_THINKING_BINDING: 'drop_block',
      MERCURY_WIRE_DUMP: dumpDir,
    }
    const result = await new Promise<{ exit: number | null; stdout: string; stderr: string }>(resolvePromise => {
      const child = spawn(nodeBin, [DIST, 'run', 'heading probe', '--model', 'claude-opus-4-8', '--format', 'rows', '--session-id', SID], { cwd: project, env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', d => (stdout += d))
      child.stderr.on('data', d => (stderr += d))
      const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
      child.on('close', exit => {
        clearTimeout(killer)
        resolvePromise({ exit, stdout, stderr })
      })
    })
    check('the headless turn exits 0 and answers — a completed outcome row carrying the answer', result.exit === 0 && answeredWith(result.stdout, 'HEADING-WIRE-DONE'), `exit=${result.exit} stderr=${result.stderr.slice(0, 300)}`)
    const file = join(dumpDir, `${SID}.jsonl`)
    let rows = existsSync(file) ? reader.readRows(file) : []
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      await new Promise(r => setTimeout(r, 50))
      rows = existsSync(file) ? reader.readRows(file) : []
    }
    const main = rows.map(r => ({ row: r, report: reader.reportRow(r) })).find(({ row }) => JSON.stringify(row.body).includes('heading probe'))
    check('the dump holds the request that carried the prompt', main !== undefined, `${rows.length} rows at ${file}`)
    check('the request carries `# instructions` in its user-context reminder', main?.report.headings.includes('instructions') === true, main ? main.report.headings.join(',') : 'no row')
    check('…and the project file rides under it', main !== undefined && JSON.stringify(main.row.body).includes(MARKER))
    check('the reader prints the heading set the model saw', main?.report.headings.join(',') === 'instructions,environment,currentDate', main?.report.headings.join(','))
    await fixture.close()
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ INSTRUCTIONS HEADING GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ INSTRUCTIONS HEADING RED (${failures} of ${checks} checks failed)`)
process.exit(1)
