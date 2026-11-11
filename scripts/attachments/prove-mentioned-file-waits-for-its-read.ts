import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { handoffTurn, isHandoffRequest, startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const DIST = join(root, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(!existsSync(DIST) ? 'FAIL dist/mercury.mjs absent — build first (the pooled gate prebuilds it)' : 'FAIL no node binary on PATH')
  process.exit(1)
}
const scratch = mkdtempSync(join(tmpdir(), 'mention-waits-'))
const cwd = join(scratch, 'work')
mkdirSync(cwd, { recursive: true })
mkdirSync(join(scratch, 'home'), { recursive: true })
const priorCwd = process.cwd()
process.chdir(cwd)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_PROJECT_INTEL = '0'
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
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const strip = (text: string): string => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const guard = setTimeout(() => {
  console.log('\nFAIL the proof exceeded 300 s')
  process.exit(1)
}, 300_000)
guard.unref?.()

const READ_ADVICE = ' Read it with Read when you need it.'
const UNREAD = 'was mentioned, but it could not be read and was dropped from this turn: '
const IMAGE_DROPPED = 'was mentioned, but its image could not be attached and was dropped from this turn: '
const CEILING = 'Reading it took longer than 10 seconds.'
const BINARY = 'Reading it failed: This tool cannot read binary files, and .bin looks binary — reach for a tool built for that format instead.'

const SLOW_DISK = [
  "const fs = require('node:fs')",
  "const { basename } = require('node:path')",
  "const { syncBuiltinESMExports } = require('node:module')",
  'const note = words => fs.appendFileSync(process.env.SLOW_DISK_LOG, `${Date.now()} ${words}\\n`)',
  "const nameOf = path => (typeof path === 'string' ? basename(path) : '')",
  'const readFile = fs.promises.readFile',
  'fs.promises.readFile = function (path, options) {',
  '  const name = nameOf(path)',
  "  if (name.startsWith('dead-')) {",
  '    note(`begins ${name}`)',
  '    return new Promise((_, refuse) => {',
  "      const signal = options && typeof options === 'object' ? options.signal : undefined",
  '      const stop = () => {',
  '        note(`cancelled ${name}`)',
  "        refuse(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))",
  '      }',
  '      if (signal && signal.aborted) stop()',
  "      else if (signal) signal.addEventListener('abort', stop, { once: true })",
  '    })',
  '  }',
  "  if (name.startsWith('slow-')) {",
  '    note(`begins ${name}`)',
  '    return new Promise(done => setTimeout(done, 2600)).then(() => {',
  '      note(`answers ${name}`)',
  '      return readFile.call(this, path, options)',
  '    })',
  '  }',
  '  return readFile.call(this, path, options)',
  '}',
  'const stat = fs.promises.stat',
  'fs.promises.stat = function (path, options) {',
  "  if (nameOf(path).startsWith('stuck-')) return new Promise(() => {})",
  '  return stat.call(this, path, options)',
  '}',
  'syncBuiltinESMExports()',
  '',
].join('\n')

type Ran = { exit: number | null; stdout: string; stderr: string; rows: Array<{ at: number; type: string }> }
function run(args: string[], at: string, env: Record<string, string>): Promise<Ran> {
  return new Promise(done => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: at, env })
    let stdout = ''
    let stderr = ''
    let pending = ''
    const rows: Ran['rows'] = []
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      pending += String(chunk)
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (line.startsWith('{')) rows.push({ at: Date.now(), type: String((JSON.parse(line) as { type?: unknown }).type) })
      }
    })
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', exit => {
      clearTimeout(killer)
      done({ exit, stdout, stderr, rows })
    })
  })
}
function arena(name: string, url: string): { project: string; env: Record<string, string> } {
  const home = join(scratch, name, 'home')
  const project = join(scratch, name, 'cwd')
  mkdirSync(join(home, '.mercury'), { recursive: true })
  mkdirSync(project, { recursive: true })
  seedFirstRun(join(home, '.mercury'), [project])
  return {
    project,
    env: {
      HOME: home,
      PATH: [process.platform === 'win32' ? (process.env.PATH ?? '') : '/usr/bin:/bin', dirname(nodeBin!)].filter(part => part !== '').join(delimiter),
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_TMPDIR: join(scratch, name, 'tmp'),
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_VERIFY_EVIDENCE: '0',
      MERCURY_TRUST_DIALOG_ACCEPTED: '1',
    },
  }
}
const wireOf = (request: { body: unknown } | undefined): string => j((request?.body as { messages?: unknown } | undefined)?.messages ?? [])

try {
  const bootstrap = await import(`${root}/src/bootstrap/state.ts`)
  bootstrap.setOriginalCwd(cwd)
  bootstrap.setProjectRoot(cwd)
  bootstrap.setCwdState(cwd)
  bootstrap.setSessionTrustAccepted(true)
  const { enableConfigs } = await import(`${root}/src/utils/config/globalConfig.ts`)
  enableConfigs()
  const { getDefaultAppState } = await import(`${root}/src/state/AppStateStore.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${root}/src/utils/fileStateCache.ts`)
  const { getEngineModel } = await import(`${root}/src/utils/model/model.ts`)
  const { getAttachments } = await import(`${root}/src/utils/attachments/orchestrator.ts`)
  const { processAtMentionedFiles } = await import(`${root}/src/utils/attachments/mentionResolvers.ts`)
  const { normalizeAttachmentForAPI } = await import(`${root}/src/utils/messages/attachmentText.ts`)
  const { FileReadTool } = await import(`${root}/src/tools/FileReadTool/FileReadTool.ts`)

  type ReadCall = (input: { file_path: string }, context: { abortController: AbortController }, ...rest: unknown[]) => Promise<unknown>
  const realRead = (FileReadTool.call as ReadCall).bind(FileReadTool)
  let cancelled = 0
  ;(FileReadTool as { call: ReadCall }).call = async (input, context, ...rest) => {
    const name = basename(input.file_path)
    if (name.startsWith('dead-')) {
      return new Promise((_, refuse) => {
        const stop = (): void => {
          cancelled++
          refuse(new Error('the read was cancelled'))
        }
        if (context.abortController.signal.aborted) stop()
        else context.abortController.signal.addEventListener('abort', stop, { once: true })
      })
    }
    if (name.startsWith('deaf-')) return new Promise(() => {})
    if (name.startsWith('slow-')) {
      await sleep(2600)
      if (context.abortController.signal.aborted) throw new Error('the read was cancelled')
    }
    return realRead(input, context, ...rest)
  }

  type Row = { type: string; filename?: string; displayPath?: string; reason?: string; unread?: string; capsuleReceipt?: unknown }
  const permissions = (deny: string[] = []): unknown => ({ mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: deny.length > 0 ? { userSettings: deny } : {}, alwaysAskRules: {}, additionalWorkingDirectories: new Map() })
  const mentionContext = (deny: string[] = [], controller = new AbortController()): unknown => ({
    getAppState: () => ({ toolPermissionContext: permissions(deny) }),
    options: {},
    readFileState: new Map(),
    abortController: controller,
    nestedMemoryAttachmentTriggers: new Set(),
  })
  const modelReads = (row: Row): string => normalizeAttachmentForAPI(row as never).map((message: { message: { content: unknown } }) => (typeof message.message.content === 'string' ? message.message.content : j(message.message.content))).join('\n')
  const file = (name: string, content: string | Buffer = `${name} content\n`): string => {
    const path = join(cwd, name)
    writeFileSync(path, content)
    return path
  }
  const onScreen: Array<{ kind: string; row: Row | undefined }> = []
  const STILL_READING = 20_000
  const mentioned = async (words: string, context: unknown): Promise<Row[] | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([processAtMentionedFiles(words, context as never) as Promise<Row[]>, new Promise<null>(done => (timer = setTimeout(() => done(null), STILL_READING)))])
    } finally {
      clearTimeout(timer)
    }
  }

  console.log('\nA — the turn\'s collector: a mentioned file whose read takes 2.6 s')
  {
    let state = getDefaultAppState()
    const turnContext = (): unknown => ({
      abortController: new AbortController(),
      options: { commands: [], tools: [], engineModel: getEngineModel(), mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
      getAppState: () => state,
      setAppState: (f: (prev: typeof state) => typeof state) => {
        state = f(state)
      },
      messages: [],
      readFileState: createFileStateCacheWithSizeLimit(100),
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: new Set<string>(),
      setInProgressToolUseIDs() {},
      setResponseLength() {},
      updateFileHistoryState() {},
      updateAttributionState() {},
    })
    const quick = file('quick-note.txt', 'QUICK-NOTE-CONTENT\n')
    const slow = file('slow-note.txt', 'SLOW-NOTE-CONTENT\n')
    const carried = (rows: Row[]): string => rows.map(row => modelReads(row)).join('\n')
    const control = (await getAttachments(`Read @${quick}`, turnContext() as never, [], [])) as Row[]
    const started = performance.now()
    const waited = (await getAttachments(`Read @${slow}`, turnContext() as never, [], [])) as Row[]
    const elapsed = performance.now() - started
    check('A control: a mentioned file that reads at once is carried to the model', carried(control).includes('QUICK-NOTE-CONTENT'), j(control.map(row => row.type)))
    check('A: the turn waited for the slow read and carries the file to the model — it is what the user asked for', elapsed >= 2500 && carried(waited).includes('SLOW-NOTE-CONTENT'), j({ ms: Math.round(elapsed), types: waited.map(row => row.type) }))
    check('A: …and nothing else of the turn was given up for it: the same kinds of rows as the turn whose mention read at once', j(waited.map(row => row.type).sort()) === j(control.map(row => row.type).sort()), j({ waited: waited.map(row => row.type).sort(), control: control.map(row => row.type).sort() }))
  }

  console.log('\nB — the ceiling: five mentioned files whose reads never end, read side by side')
  {
    const names = ['dead-shot.png', 'dead-1.txt', 'dead-2.txt', 'dead-3.txt', 'dead-4.txt']
    const paths = names.map(name => file(name))
    cancelled = 0
    const started = performance.now()
    const answer = await mentioned(`look at ${paths.map(path => `@${path}`).join(' ')}`, mentionContext())
    const rows = answer ?? []
    const elapsed = performance.now() - started
    check('B: the prompt is held ten seconds, not fifty — the five were read side by side and each given up at its own ceiling', answer !== null && elapsed >= 9_500 && elapsed < 14_000, answer === null ? `still reading after ${STILL_READING / 1000} s` : `${Math.round(elapsed)} ms`)
    check('B: each of the five leaves its row with the ceiling\'s reason', rows.length === 5 && rows.every(row => row.type === 'dropped_image_file' && row.reason === CEILING) && j(rows.map(row => row.filename)) === j(paths), j(rows.map(row => [row.type, row.reason])))
    check('B: the reads were cancelled at the ceiling, not left running', cancelled === 5, `${cancelled} cancelled`)
    const image = rows[0]
    check('B: for the image the model reads today\'s dropped-image sentence with that reason', image !== undefined && image.unread === undefined && modelReads(image).includes(`${paths[0]} ${IMAGE_DROPPED}${CEILING} Attach a smaller copy, or Read it with a crop.`), image ? modelReads(image) : 'no row')
    const text = rows[1]
    check('B: for a file that is no image the model reads that it could not be read, and to Read it when needed', text !== undefined && text.unread === 'retry' && modelReads(text).includes(`${paths[1]} ${UNREAD}${CEILING}${READ_ADVICE}`) && !modelReads(text).includes('image'), text ? modelReads(text) : 'no row')
    onScreen.push({ kind: 'an image past the ceiling', row: image }, { kind: 'a file past the ceiling', row: text })
  }

  console.log('\nC — a mentioned file that is left out leaves its row')
  {
    const big = file('big.log', 'a line of a big log file\n'.repeat(48_000))
    const [overCap] = (await processAtMentionedFiles(`look at @${big}`, mentionContext() as never)) as Row[]
    check('C: a file over the mention\'s byte limit that is no image — the limit\'s own reason with the true noun, and Read named as the way in', overCap?.type === 'dropped_image_file' && /^The file is [\d.]+MB, over the 256KB limit for a mentioned file\.$/.test(overCap.reason ?? '') && overCap.unread === 'retry' && modelReads(overCap).includes(`${big} ${UNREAD}${overCap.reason}${READ_ADVICE}`), j(overCap))

    const blob = file('blob.bin', Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)))
    const [binary] = (await processAtMentionedFiles(`look at @${blob}`, mentionContext() as never)) as Row[]
    check('C: a binary file — the read\'s own refusal as the reason, and no advice to Read what Read refuses', binary?.type === 'dropped_image_file' && binary.reason === BINARY && binary.unread === 'refused' && modelReads(binary).includes(`${blob} ${UNREAD}${BINARY}`) && !modelReads(binary).includes(READ_ADVICE.trim()), j(binary))
    onScreen.push({ kind: 'a file over the byte limit', row: overCap }, { kind: 'a binary file', row: binary })

    if (process.platform !== 'win32') {
      const locked = file('locked.txt', 'not for this process\n')
      chmodSync(locked, 0o000)
      try {
        const [unreadable] = (await processAtMentionedFiles(`look at @${locked}`, mentionContext() as never)) as Row[]
        check('C: a file this process may not read — the system\'s own error line as the reason', unreadable?.type === 'dropped_image_file' && unreadable.reason === `Reading it failed: EACCES: permission denied, open '${locked}'.` && unreadable.unread === 'refused' && !modelReads(unreadable).includes(READ_ADVICE.trim()), j(unreadable))
        onScreen.push({ kind: 'a file this process may not read', row: unreadable })
      } finally {
        chmodSync(locked, 0o600)
      }
    }

    const secret = file('secret.env', 'DENIED-FILE-CONTENT\n')
    const rule = `Read(/${secret})`
    const [denied] = (await processAtMentionedFiles(`look at @${secret}`, mentionContext([rule]) as never)) as Row[]
    const sentence = `Reading ${secret} is denied by the rule ${rule} in your user settings.`
    check('C: a path a rule denies — the sentence a Read of it answers, and nothing of the file', denied?.type === 'dropped_image_file' && denied.reason === sentence && denied.unread === 'refused' && modelReads(denied).includes(`${secret} ${UNREAD}${sentence}`) && !modelReads(denied).includes('DENIED-FILE-CONTENT') && !modelReads(denied).includes(READ_ADVICE.trim()), j(denied))
    onScreen.push({ kind: 'a path a rule denies', row: denied })
  }

  console.log('\nD — what stays as it was')
  {
    const nobody = (await processAtMentionedFiles(`thanks @nobody and @${join(cwd, 'not-here.txt')}`, mentionContext() as never)) as Row[]
    check('D: a name after @ that is no file leaves no row', nobody.length === 0, j(nobody))
    const deniedNobody = (await processAtMentionedFiles(`look at @${join(cwd, 'not-here.env')}`, mentionContext([`Read(/${join(cwd, 'not-here.env')})`]) as never)) as Row[]
    check('D: …nor does one a rule would deny', deniedNobody.length === 0, j(deniedNobody))
    const small = file('small.txt', 'SMALL-FILE-CONTENT\n')
    const started = performance.now()
    const [read] = (await processAtMentionedFiles(`look at @${small}`, mentionContext() as never)) as Row[]
    check('D: a small file is read at once and carried whole', read?.type === 'file' && modelReads(read).includes('SMALL-FILE-CONTENT') && performance.now() - started < 3_000, j({ type: read?.type, ms: Math.round(performance.now() - started) }))
    onScreen.push({ kind: 'a file that was read', row: read })
    for (const name of ['dead-interrupted.txt', 'deaf-interrupted.txt']) {
      const interrupted = new AbortController()
      const hung = file(name)
      setTimeout(() => interrupted.abort(), 300)
      const stopped = performance.now()
      const rows = await mentioned(`look at @${hung}`, mentionContext([], interrupted))
      check(`D: an interrupt of the turn ends the wait at once and leaves no row — a read that ${name.startsWith('dead-') ? 'stops when told' : 'does not hear the interrupt'}`, rows !== null && performance.now() - stopped < 3_000 && rows.length === 0, rows === null ? `still reading after ${STILL_READING / 1000} s` : j({ ms: Math.round(performance.now() - stopped), rows }))
    }
  }

  console.log('\nE — the row on the screen, painted from the rows above')
  {
    const React = (await import('react')).default
    const { render } = await import(`${root}/src/ink.ts`)
    const { AppStateProvider } = await import(`${root}/src/state/AppState.tsx`)
    const { AttachmentMessage } = await import(`${root}/src/components/messages/AttachmentMessage.tsx`)
    const { MessageMetaProvider } = await import(`${root}/src/components/messages/TranscriptNameplate.tsx`)
    const h = React.createElement as (...parts: unknown[]) => unknown
    const painted = async (row: Row): Promise<string> => {
      const stdout = Object.assign(new Writable({ write: (_chunk, _encoding, done) => done() }), { columns: 400, rows: 30, isTTY: false })
      const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
      const body = h(AttachmentMessage, { attachment: row, addMargin: false, verbose: false })
      const instance = await render(h(AppStateProvider, { initialState: getDefaultAppState() }, h(MessageMetaProvider, { message: { type: 'attachment', timestamp: '2026-06-19T12:00:07.000Z', attachment: row } }, body)) as never, { stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false })
      await sleep(200)
      const text = strip(instance.lastFrame()).replace(/\s+/g, ' ').trim()
      instance.unmount?.()
      await sleep(50)
      return text
    }
    for (const { kind, row } of onScreen) {
      const line = row === undefined ? '(no row to paint)' : await painted(row)
      const wanted = row?.type === 'file' ? `Read ${row.displayPath} (1 line)` : `Dropped ${row?.displayPath} — ${row?.reason}`
      check(`E: ${kind} — the row reads \`${row?.type === 'file' ? 'Read <path> (N lines)' : 'Dropped <path> — <the reason>'}\``, row !== undefined && line.includes(wanted), `painted: ${line}`)
    }
  }

  console.log('\nF — the wire, through the built bundle (mercury run on a loopback provider): each kind in one prompt')
  {
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'KINDS-REPLY.' }])
    const { project, env } = arena('kinds', fixture.url)
    const at = (name: string): string => join(project, name)
    writeFileSync(at('big.log'), 'a line of a big log file\n'.repeat(48_000))
    writeFileSync(at('blob.bin'), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)))
    writeFileSync(at('secret.env'), 'DENIED-FILE-CONTENT\n')
    writeFileSync(at('small.txt'), 'SMALL-FILE-CONTENT\n')
    writeFileSync(at('locked.txt'), 'not for this process\n')
    if (process.platform !== 'win32') chmodSync(at('locked.txt'), 0o000)
    mkdirSync(join(project, '.mercury'), { recursive: true })
    writeFileSync(join(project, '.mercury', 'settings.json'), j({ guardrails: { deny: ['Read(secret.env)'] } }))
    try {
      const prompt = 'look at @big.log @blob.bin @secret.env @locked.txt @small.txt @nobody.txt please'
      const ran = await run(['run', prompt, '--model', 'claude-opus-4-8', '--format', 'rows'], project, env)
      const wire = wireOf(fixture.messageRequests().filter(sent => !sent.path.includes('count_tokens') && !isHandoffRequest(sent)).at(-1))
      check('F: the run answered', ran.exit === 0 && ran.stdout.includes('KINDS-REPLY.'), `exit=${ran.exit} ${ran.stderr.slice(-300)}`)
      check('F: over the byte limit — the request says so, with Read as the way in', /big\.log was mentioned, but it could not be read and was dropped from this turn: The file is [\d.]+MB, over the 256KB limit for a mentioned file\. Read it with Read when you need it\./.test(wire), `${wire.length} chars`)
      check('F: a binary file — the request carries the read\'s refusal and no advice to Read it', wire.includes(`blob.bin ${UNREAD}${BINARY}`) && !wire.includes(`${BINARY}${READ_ADVICE}`), `${wire.length} chars`)
      if (process.platform !== 'win32') check('F: a file the process may not read — the request carries the system\'s error line', /locked\.txt was mentioned, but it could not be read and was dropped from this turn: Reading it failed: EACCES: permission denied, open '[^']*locked\.txt'\./.test(wire), `${wire.length} chars`)
      check('F: a path the project\'s settings deny — the request names the rule and where it stands, and holds nothing of the file', /secret\.env was mentioned, but it could not be read and was dropped from this turn: Reading [^ ]*secret\.env is denied by the rule Read\(secret\.env\) in the shared project settings\./.test(wire) && !wire.includes('DENIED-FILE-CONTENT'), `${wire.length} chars`)
      check('F: the small file rides whole beside them', wire.includes('SMALL-FILE-CONTENT'))
      check('F: a name that is no file adds nothing — it stands in the prompt\'s own words and nowhere else', wire.split('nobody.txt').length - 1 === wire.split(prompt).length - 1 && wire.includes(prompt), `${wire.split('nobody.txt').length - 1} mentions of the name, ${wire.split(prompt).length - 1} of the prompt`)
    } finally {
      if (process.platform !== 'win32') chmodSync(at('locked.txt'), 0o600)
      await fixture.close()
    }
  }

  console.log('\nG — the wire with a slow disk under the bundle: one read answers after 2.6 s, two never answer')
  {
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'SLOW-DISK-REPLY.' }])
    const { project, env } = arena('slow', fixture.url)
    const stub = join(scratch, 'slow', 'slow-disk.cjs')
    const log = join(scratch, 'slow', 'slow-disk.log')
    writeFileSync(stub, SLOW_DISK)
    writeFileSync(log, '')
    writeFileSync(join(project, 'slow-note.txt'), 'SLOW-NOTE-CONTENT\n')
    writeFileSync(join(project, 'quick-note.txt'), 'QUICK-NOTE-CONTENT\n')
    writeFileSync(join(project, 'dead-note.txt'), 'DEAD-NOTE-CONTENT\n')
    writeFileSync(join(project, 'stuck-shot.png'), 'not read\n')
    try {
      const ran = await run(['run', 'look at @slow-note.txt @dead-note.txt @stuck-shot.png @quick-note.txt please', '--model', 'claude-opus-4-8', '--format', 'rows'], project, { ...env, NODE_OPTIONS: `--require=${stub.replaceAll('\\', '/')}`, SLOW_DISK_LOG: log })
      const wire = wireOf(fixture.messageRequests().filter(sent => !sent.path.includes('count_tokens') && !isHandoffRequest(sent)).at(-1))
      const disk = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => ({ at: Number(line.slice(0, line.indexOf(' '))), words: line.slice(line.indexOf(' ') + 1) }))
      const when = (words: string): number => disk.find(entry => entry.words === words)?.at ?? Number.NaN
      const turnStarted = ran.rows.find(row => row.type === 'turn')?.at ?? Number.NaN
      const firstWait = ran.rows.find(row => row.type === 'wait')?.at ?? Number.NaN
      check('G: the run answered', ran.exit === 0 && ran.stdout.includes('SLOW-DISK-REPLY.'), `exit=${ran.exit} ${ran.stderr.slice(-300)}`)
      check('G: the request carries the file whose read took 2.6 s, and the one that read at once', wire.includes('SLOW-NOTE-CONTENT') && wire.includes('QUICK-NOTE-CONTENT'), `${wire.length} chars`)
      check('G: the read that never answered was given up at ten seconds and cancelled', when('cancelled dead-note.txt') - when('begins dead-note.txt') >= 9_500 && when('cancelled dead-note.txt') - when('begins dead-note.txt') < 13_000, j(disk.map(entry => `${entry.at - (disk[0]?.at ?? 0)} ${entry.words}`)))
      check('G: …the request says so for the file, with Read as the way in, and holds nothing of it', wire.includes(`dead-note.txt ${UNREAD}${CEILING}${READ_ADVICE}`) && !wire.includes('DEAD-NOTE-CONTENT'), `${wire.length} chars`)
      check('G: …and for the image, in today\'s dropped-image sentence', wire.includes(`stuck-shot.png ${IMAGE_DROPPED}${CEILING} Attach a smaller copy, or Read it with a crop.`), `${wire.length} chars`)
      check('G: the turn is in flight for the whole wait — its row reaches the reader before the slow read answers, and no request leaves before the last read is given up', turnStarted < when('answers slow-note.txt') && firstWait >= when('cancelled dead-note.txt') - 100, j({ turnStarted: turnStarted - (disk[0]?.at ?? 0), slowAnswers: when('answers slow-note.txt') - (disk[0]?.at ?? 0), givenUp: when('cancelled dead-note.txt') - (disk[0]?.at ?? 0), firstWait: firstWait - (disk[0]?.at ?? 0) }))
    } finally {
      await fixture.close()
    }
  }

  console.log('\nH — the wire with a provider that takes its time to count: each token count is held back 900 ms')
  {
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'SLOW-COUNT-REPLY.' }])
    const target = new URL(fixture.url)
    let counts = 0
    const standIn = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        const counting = (req.url ?? '').includes('count_tokens')
        if (counting) counts++
        const forward = (): void => {
          const upstream = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, answer => {
            res.writeHead(answer.statusCode ?? 502, answer.headers)
            answer.pipe(res)
          })
          upstream.on('error', () => {
            res.writeHead(502)
            res.end()
          })
          upstream.end(Buffer.concat(chunks))
        }
        if (counting) setTimeout(forward, 900)
        else forward()
      })
    })
    await new Promise<void>(done => standIn.listen(0, '127.0.0.1', () => done()))
    const { project, env } = arena('slow-count', `http://127.0.0.1:${(standIn.address() as { port: number }).port}`)
    writeFileSync(join(project, 'dense.ts'), Array.from({ length: 2_500 }, (_, i) => `const line${String(i + 1).padStart(4, '0')} = '${'x'.repeat(58)}'`).join('\n') + '\n')
    try {
      const started = Date.now()
      const ran = await run(['run', 'look at @dense.ts please', '--model', 'claude-opus-4-8', '--format', 'rows'], project, env)
      const wire = wireOf(fixture.messageRequests().filter(sent => !sent.path.includes('count_tokens') && !isHandoffRequest(sent)).at(-1))
      const shown = Number(/dense\.ts was too large — only its first (\d+) lines are shown above/.exec(wire)?.[1] ?? 0)
      check('H: the run answered, and the read counted its tokens with the provider more than once, each count 900 ms', ran.exit === 0 && ran.stdout.includes('SLOW-COUNT-REPLY.') && counts >= 2 && Date.now() - started >= 1_800, `exit=${ran.exit} counts=${counts} ${Date.now() - started} ms ${ran.stderr.slice(-300)}`)
      check('H: the request carries the dense file clipped, its first line and the note of how many lines it shows', shown >= 1 && shown < 2_000 && wire.includes('const line0001 ') && !wire.includes('const line2500 '), `shown ${shown}; counts ${counts}; ${wire.length} chars`)
      check('H: …and no row says the file was dropped', !wire.includes(`dense.ts ${UNREAD}`), `${wire.length} chars`)
    } finally {
      await new Promise<void>(done => standIn.close(() => done()))
      await fixture.close()
    }
  }
} finally {
  process.chdir(priorCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} a mentioned file waits for its read: ${failures} of ${checks} failed`)
process.exit(failures ? 1 : 0)
