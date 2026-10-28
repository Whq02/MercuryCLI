#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/BashTool.tsx src/tools/BashTool/utils.ts src/utils/redactSecrets.ts src/state/AppStateStore.ts
import { plugin } from 'bun'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'shell-result-redaction-')))
const PROJECT = join(SCRATCH, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_SHELL_ENGINE
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

const PLANTED_OPENAI = 'sk-proj-planted7f167008fixturevalue00000000'
const PLANTED_PASSWORD = 'hunter2-planted-7f167008-not-real'
const PLANTED_TOKEN = 'ghp_planted7f167008fixturevalue000000'
const PLAIN_VALUE = 'visible-plain-7f167008'
process.env.OPENAI_API_KEY = PLANTED_OPENAI
process.env.PLANTED_DB_PASSWORD = PLANTED_PASSWORD
process.env.PLANTED_PLAIN = PLAIN_VALUE
writeFileSync(join(PROJECT, '.env'), `DB_PASSWORD=${PLANTED_PASSWORD}\nexport API_TOKEN="${PLANTED_TOKEN}"\nPLAIN=${PLAIN_VALUE}\n`)
writeFileSync(join(PROJECT, 'auth.ts'), "const token = form.password\nconst apiKey = process.env.OPENAI_API_KEY\n")

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)
const MARKER = '[redacted]'

const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createShellResultRedactor } = await import('../../src/utils/redactSecrets.ts')

let appState = getDefaultAppState()
const toolContext = {
  options: { engineModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(),
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => {
    appState = update(appState)
  },
  abortController: new AbortController(),
  toolUseId: 'shell-result-redaction',
} as never
type Out = { stdout: string; stderr: string; persistedOutputPath?: string }
type Caller = { call: (input: never, context: never) => Promise<{ data: unknown }> }
type Mapper = { mapToolResultToToolResultBlockParam: (output: never, id: string) => { content: unknown } }
const run = async (command: string): Promise<{ out: Out | null; thrown: string | null; block: string }> => {
  const input = { command }
  await BashTool.prepare?.(input as never)
  try {
    const result = await (BashTool as unknown as Caller).call(input as never, toolContext)
    const block = (BashTool as unknown as Mapper).mapToolResultToToolResultBlockParam(result.data as never, 'shell-result-redaction')
    return { out: result.data as Out, thrown: null, block: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string; message?: string }
    return { out: null, thrown: [shell.message ?? String(error), shell.stdout ?? '', shell.stderr ?? ''].filter(Boolean).join('\n'), block: '' }
  }
}
const carries = (text: string, value: string): boolean => text.includes(value)

try {
  section('§1 the planted values reach the tool shell (the control, read through a non-credential name)')
  {
    const plain = await run('echo "$PLANTED_PLAIN"')
    check('a plain variable is printed as it is', plain.out !== null && plain.out.stdout.trim() === PLAIN_VALUE, JSON.stringify(plain.out?.stdout ?? plain.thrown))
  }

  section('§2 env, printenv, set and export -p: credential-named variables carry the marker, the plain one is untouched')
  for (const command of ['env', 'printenv', 'set', 'export -p', 'declare -p OPENAI_API_KEY PLANTED_DB_PASSWORD PLANTED_PLAIN']) {
    const { out, thrown, block } = await run(command)
    check(`${command}: the result carries none of the planted values`, out !== null && !carries(out.stdout, PLANTED_OPENAI) && !carries(out.stdout, PLANTED_PASSWORD), thrown ?? out?.stdout.split('\n').filter(line => /PLANTED|OPENAI/.test(line)).join(' | '))
    check(`${command}: the result carries the marker for both`, out !== null && /OPENAI_API_KEY=.?\[redacted\]/.test(out.stdout) && /PLANTED_DB_PASSWORD=.?\[redacted\]/.test(out.stdout), out?.stdout.split('\n').filter(line => /PLANTED|OPENAI/.test(line)).join(' | '))
    check(`${command}: the plain variable keeps its value`, out !== null && carries(out.stdout, `PLANTED_PLAIN=${PLAIN_VALUE}`) || (out !== null && carries(out.stdout, `PLANTED_PLAIN="${PLAIN_VALUE}"`)), out?.stdout.split('\n').filter(line => /PLANTED_PLAIN/.test(line)).join(' | '))
    check(`${command}: the model-facing block carries the marker and no planted value`, carries(block, MARKER) && !carries(block, PLANTED_OPENAI) && !carries(block, PLANTED_PASSWORD))
  }

  section('§3 printenv NAME and echo $NAME print the bare value: credential-shaped or credential-named values carry the marker')
  for (const command of ['printenv OPENAI_API_KEY', 'echo "$OPENAI_API_KEY"', 'echo "$PLANTED_DB_PASSWORD"', 'printenv PLANTED_DB_PASSWORD']) {
    const { out, thrown } = await run(command)
    check(`${command} → ${MARKER}`, out !== null && out.stdout.trim() === MARKER, thrown ?? JSON.stringify(out?.stdout))
  }

  section('§4 a .env file read with cat: the credential lines carry the marker in their quoting, the plain line is untouched')
  {
    const { out, thrown, block } = await run('cat .env')
    check('DB_PASSWORD=… → DB_PASSWORD=[redacted]', out !== null && carries(out.stdout, `DB_PASSWORD=${MARKER}`), thrown ?? out?.stdout)
    check('export API_TOKEN="…" → export API_TOKEN="[redacted]"', out !== null && carries(out.stdout, `export API_TOKEN="${MARKER}"`), out?.stdout)
    check('PLAIN=… keeps its value', out !== null && carries(out.stdout, `PLAIN=${PLAIN_VALUE}`), out?.stdout)
    check('none of the planted values reach the model', !carries(block, PLANTED_PASSWORD) && !carries(block, PLANTED_TOKEN))
  }

  section('§5 code read through cat is not rewritten: only credential-shaped values and NAME=value lines change')
  {
    const { out, thrown } = await run('cat auth.ts')
    check('const token = form.password stays as written', out !== null && carries(out.stdout, 'const token = form.password'), thrown ?? out?.stdout)
    check('const apiKey = process.env.OPENAI_API_KEY stays as written', out !== null && carries(out.stdout, 'const apiKey = process.env.OPENAI_API_KEY'), out?.stdout)
  }

  section('§6 the error road: a failing command whose output carries a key is thrown with the marker')
  {
    const { out, thrown } = await run('env | grep OPENAI_API_KEY; exit 3')
    check('the command failed and threw', out === null && thrown !== null, JSON.stringify(out?.stdout))
    check('the thrown text carries the marker and not the key', thrown !== null && carries(thrown, MARKER) && !carries(thrown, PLANTED_OPENAI), thrown?.slice(0, 200))
  }

  section('§7 the command line the user typed is not rewritten; only the result is')
  {
    const input = { command: `echo ${PLANTED_TOKEN}` }
    await BashTool.prepare?.(input as never)
    const result = await (BashTool as unknown as Caller).call(input as never, toolContext)
    check('the input still carries the typed value', input.command === `echo ${PLANTED_TOKEN}`)
    check('the result carries the marker', (result.data as Out).stdout.trim() === MARKER, JSON.stringify((result.data as Out).stdout))
  }

  section('§8 the redactor itself: the shapes it replaces and the ones it leaves')
  if (typeof createShellResultRedactor !== 'function') {
    check('createShellResultRedactor is exported', false, 'absent')
  } else {
    const redact = createShellResultRedactor()
    const rows: Array<[string, string]> = [
      ['AWS_SECRET_ACCESS_KEY=abcdefghijklmnop', `AWS_SECRET_ACCESS_KEY=${MARKER}`],
      ["GITHUB_TOKEN='abc def'", `GITHUB_TOKEN='${MARKER}'`],
      ['declare -x NPM_TOKEN="abc"', `declare -x NPM_TOKEN="${MARKER}"`],
      ['export MY_CREDENTIAL=value', `export MY_CREDENTIAL=${MARKER}`],
      ['PASSWD=x', `PASSWD=${MARKER}`],
      ['PATH=/usr/bin:/bin', 'PATH=/usr/bin:/bin'],
      ['HOME=/Users/someone', 'HOME=/Users/someone'],
      ['const token = form.password', 'const token = form.password'],
      ['token: abc', 'token: abc'],
      [`Authorization: Bearer ${PLANTED_TOKEN}`, `Authorization: Bearer ${MARKER}`],
      [`${'-----BEGIN'} PRIVATE KEY-----\nabc\n${'-----END'} PRIVATE KEY-----`, MARKER],
      [`x${PLANTED_TOKEN}`, `x${PLANTED_TOKEN}`],
    ]
    for (const [text, want] of rows) check(`${JSON.stringify(text)} → ${JSON.stringify(want)}`, redact(text) === want, JSON.stringify(redact(text)))
    check('the user\'s own exported provider value is replaced wherever it appears, even without a known prefix', (() => {
      process.env.MOONSHOT_API_KEY = 'planted-moonshot-value-7f167008'
      const result = createShellResultRedactor()('key planted-moonshot-value-7f167008 here')
      delete process.env.MOONSHOT_API_KEY
      return result === `key ${MARKER} here`
    })())
  }

  section('§9 a spilled result: the persisted copy carries the marker and not the key')
  {
    const { out, thrown } = await run('i=0; while [ $i -lt 1200 ]; do echo "line $i of padding text to spill the result past the inline budget"; i=$((i+1)); done; env | grep -E "OPENAI_API_KEY|PLANTED_DB_PASSWORD"')
    if (out?.persistedOutputPath === undefined) {
      console.log(`  [SKIP] the output did not spill (${thrown ?? `${out?.stdout.length ?? 0} chars inline`}); the inline result carries the marker: ${out !== null && carries(out.stdout, MARKER) && !carries(out.stdout, PLANTED_OPENAI)}`)
      check('the inline result carries the marker and not the key', out !== null && carries(out.stdout, MARKER) && !carries(out.stdout, PLANTED_OPENAI))
    } else {
      const persisted = readFileSync(out.persistedOutputPath, 'utf8')
      check('the persisted copy carries the marker', carries(persisted, `OPENAI_API_KEY=${MARKER}`) && carries(persisted, `PLANTED_DB_PASSWORD=${MARKER}`), persisted.slice(-300))
      check('…and none of the planted values', !carries(persisted, PLANTED_OPENAI) && !carries(persisted, PLANTED_PASSWORD))
      check('the inline preview carries none either', !carries(out.stdout, PLANTED_OPENAI) && !carries(out.stdout, PLANTED_PASSWORD))
    }
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nprove-shell-result-redaction: ALL LAWS HOLD' : `\nprove-shell-result-redaction: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
