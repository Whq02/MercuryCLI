import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { handoffTurn, isHandoffRequest, startFixtureApi } from '../lib/fixtureApi.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const DIST = join(root, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(!existsSync(DIST) ? 'FAIL dist/mercury.mjs absent — build first (the pooled gate prebuilds it)' : 'FAIL no node binary on PATH')
  process.exit(1)
}
const scratch = mkdtempSync(join(tmpdir(), 'dense-mention-'))
const cwd = join(scratch, 'work')
mkdirSync(cwd, { recursive: true })
const priorCwd = process.cwd()
process.chdir(cwd)
const counter = await startFixtureApi([])
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.ANTHROPIC_BASE_URL = counter.url
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
delete process.env.NODE_ENV

let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail.slice(0, 700)}`}`)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''
const dense = Array.from({ length: 2_500 }, (_, i) => `const line${String(i + 1).padStart(4, '0')} = '${'x'.repeat(58)}'`).join('\n') + '\n'
const wide = Array.from({ length: 1_500 }, (_, i) => `${String(i + 1).padStart(4, '0')} ${'word '.repeat(31)}`).join('\n') + '\n'
const NOTE = /only its first (\d+) lines are shown above/

try {
  const bootstrap = await import(`${root}/src/bootstrap/state.ts`)
  bootstrap.setOriginalCwd(cwd)
  bootstrap.setProjectRoot(cwd)
  const { processAtMentionedFiles } = await import(`${root}/src/utils/attachments/mentionResolvers.ts`)
  const { normalizeAttachmentForAPI } = await import(`${root}/src/utils/messages/attachmentText.ts`)

  type Row = { type: string; truncated?: boolean; content?: { file?: { numLines?: number; totalLines?: number; startLine?: number } } }
  const context = (): unknown => ({
    getAppState: () => ({ toolPermissionContext: { mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, additionalWorkingDirectories: new Map() } }),
    options: {},
    readFileState: new Map(),
    abortController: new AbortController(),
    nestedMemoryAttachmentTriggers: new Set(),
  })
  const modelReads = (row: Row): string => normalizeAttachmentForAPI(row as never).map((message: { message: { content: unknown } }) => (typeof message.message.content === 'string' ? message.message.content : j(message.message.content))).join('\n')
  const file = (name: string, content: string): string => {
    const path = join(cwd, name)
    writeFileSync(path, content)
    return path
  }
  const mention = async (words: string): Promise<Row[]> => (await processAtMentionedFiles(words, context() as never)) as Row[]
  const shape = (rows: Row[]): string => j(rows.map(row => ({ type: row.type, truncated: row.truncated, from: row.content?.file?.startLine, lines: row.content?.file?.numLines, of: row.content?.file?.totalLines })))

  console.log('\nA — in process: a mentioned text file under the byte limit whose lines are over the read\'s token maximum')
  {
    const fits = file('fits.ts', Array.from({ length: 400 }, (_, i) => `const fit${String(i + 1).padStart(4, '0')} = '${'z'.repeat(59)}'`).join('\n') + '\n')
    const whole = await mention(`look at @${fits}`)
    check('A control: a 32 KB file is carried whole, with no note', whole.length === 1 && whole[0]!.type === 'file' && whole[0]!.truncated !== true && whole[0]!.content?.file?.numLines === 400 && !NOTE.test(modelReads(whole[0]!)), shape(whole))

    const densePath = file('dense.ts', dense)
    const clipped = await mention(`look at @${densePath}`)
    const shown = clipped[0]?.content?.file?.numLines ?? 0
    check('A: a 200 KB file of 2,500 lines is carried, clipped to the lines that fit, from its first line', clipped.length === 1 && clipped[0]!.type === 'file' && clipped[0]!.truncated === true && clipped[0]!.content?.file?.startLine === 1 && shown >= 1 && shown < 2_000, shape(clipped))
    const told = clipped[0] ? modelReads(clipped[0]) : ''
    check('A: …the model reads its first line, the last line that fits and no line past it, and the note that says how many', told.includes('const line0001 ') && told.includes(`const line${String(shown).padStart(4, '0')} `) && !told.includes(`const line${String(shown + 1).padStart(4, '0')} `) && NOTE.exec(told)?.[1] === String(shown), `shown ${shown}; note ${NOTE.exec(told)?.[0]}`)

    const widePath = file('wide.log', wide)
    const widened = await mention(`look at @${widePath}`)
    const wideShown = widened[0]?.content?.file?.numLines ?? 0
    check('A: a 240 KB log of 1,500 lines of 160 characters is carried the same way', widened.length === 1 && widened[0]!.truncated === true && wideShown >= 1 && wideShown < 1_500 && NOTE.exec(modelReads(widened[0]!))?.[1] === String(wideShown), shape(widened))

    const ranged = await mention(`look at @${densePath}#L1000-2400`)
    const from = ranged[0]?.content?.file?.startLine
    const rangedShown = ranged[0]?.content?.file?.numLines ?? 0
    const rangedTold = ranged[0] ? modelReads(ranged[0]) : ''
    check('A: a mention of lines 1000–2400 of it is clipped from line 1000, not from the file\'s head', ranged.length === 1 && ranged[0]!.truncated === true && from === 1000 && rangedShown >= 1 && rangedShown < 1_401 && rangedTold.includes('const line1000 ') && !rangedTold.includes('const line0999 '), shape(ranged))
    check('A: …and the model is told the lines that are shown, not that they are the file\'s first', rangedShown >= 1 && rangedTold.includes(`dense.ts was too large — only lines 1000-${999 + rangedShown} are shown above.`) && !NOTE.test(rangedTold), /[^"\n]*too large[^"\n]*/.exec(rangedTold)?.[0]?.slice(-140) ?? '(no note)')

    const longPath = file('long.txt', Array.from({ length: 3_000 }, (_, i) => `${String(i + 1).padStart(4, '0')} ${'y'.repeat(34)}`).join('\n') + '\n')
    const windowed = await mention(`look at @${longPath}`)
    check('A control: a 120 KB file of 3,000 short lines reads as before — the read\'s own first 2,000 lines', windowed.length === 1 && windowed[0]!.type === 'file' && windowed[0]!.truncated !== true && windowed[0]!.content?.file?.numLines === 2_000, shape(windowed))
  }

  console.log('\nB — the built bundle through mercury run: the read counts its tokens with the provider')
  {
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'DENSE-REPLY.' }])
    const home = join(scratch, 'arena', 'home')
    const project = join(scratch, 'arena', 'cwd')
    mkdirSync(join(home, '.mercury'), { recursive: true })
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'dense.ts'), dense)
    writeFileSync(join(project, 'wide.log'), wide)
    try {
      const env = {
        HOME: home,
        PATH: [process.platform === 'win32' ? (process.env.PATH ?? '') : '/usr/bin:/bin', dirname(nodeBin)].filter(part => part !== '').join(delimiter),
        TERM: 'dumb',
        MERCURY_CONFIG_DIR: join(home, '.mercury'),
        MERCURY_TMPDIR: join(scratch, 'arena', 'tmp'),
        ANTHROPIC_BASE_URL: fixture.url,
        ANTHROPIC_API_KEY: 'fixture-key-000',
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        MERCURY_VERIFY_EVIDENCE: '0',
        MERCURY_TRUST_DIALOG_ACCEPTED: '1',
      }
      const ran = await new Promise<{ exit: number | null; stdout: string; stderr: string }>(done => {
        const child = spawn(nodeBin, [DIST, 'run', 'look at @dense.ts @wide.log please', '--model', 'claude-opus-4-8', '--format', 'rows'], { cwd: project, env })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => (stdout += String(chunk)))
        child.stderr.on('data', chunk => (stderr += String(chunk)))
        const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
        child.on('close', exit => {
          clearTimeout(killer)
          done({ exit, stdout, stderr })
        })
      })
      const request = fixture.messageRequests().filter(sent => !sent.path.includes('count_tokens') && !isHandoffRequest(sent)).at(-1)
      const wire = j((request?.body as { messages?: unknown } | undefined)?.messages ?? [])
      const counted = fixture.requests.filter(sent => sent.path.includes('count_tokens')).length
      check('B: the run answered, and the read counted its tokens with the provider', ran.exit === 0 && ran.stdout.includes('DENSE-REPLY.') && counted >= 2, `exit=${ran.exit} counted=${counted} ${ran.stderr.slice(-200)}`)
      const notes = [...wire.matchAll(/(dense\.ts|wide\.log) was too large — only its first (\d+) lines are shown above/g)].map(found => [found[1], Number(found[2])] as const)
      const lines = Object.fromEntries(notes)
      check('B: the request carries both files clipped, each with the note of how many lines it shows', notes.length === 2 && lines['dense.ts']! >= 1 && lines['dense.ts']! < 2_000 && lines['wide.log']! >= 1 && lines['wide.log']! < 1_500, j(notes))
      check('B: …their first lines, and neither file\'s last line', wire.includes('const line0001 ') && wire.includes('0001 word') && !wire.includes('const line2500 ') && !wire.includes('1500 word'), `${wire.length} chars`)
    } finally {
      await fixture.close()
    }
  }
} finally {
  process.chdir(priorCwd)
  await counter.close()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} a dense mentioned file is carried clipped: ${failures} of ${checks} failed`)
process.exit(failures ? 1 : 0)
