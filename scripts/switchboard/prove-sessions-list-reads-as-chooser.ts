#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0-probe' }
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-list-reads-as-chooser-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

const HINT = 'check listedSessionsOf, listedSessionName and readListedSessions in src/sessions/transcripts/listedSessions.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${[detail, HINT].filter(Boolean).join('; ')}` : ''}`)
}

try {
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  const { setCwdState, setOriginalCwd } = await import('../../src/boot/process-state/processState.ts')
  const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
  const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')

  const T0 = Date.parse('2026-06-19T12:00:00.000Z')
  const sid = (n: number): string => `00000000-cccc-4000-8000-${String(n).padStart(12, '0')}`
  const projects = ['alpha', 'beta'].map(name => {
    const dir = join(SCRATCH, name)
    mkdirSync(dir, { recursive: true })
    return dir
  })
  setOriginalCwd(projects[0]!)
  setCwdState(projects[0]!)
  const turn = (sessionId: string, cwd: string, i: number, prompt: string, reply = `reply ${i}`): Record<string, unknown>[] => {
    const u = `00000000-0000-4000-8000-${sessionId.slice(-8)}${String(i * 2).padStart(4, '0')}`
    const a = `00000000-0000-4000-8000-${sessionId.slice(-8)}${String(i * 2 + 1).padStart(4, '0')}`
    const base = { isSidechain: false, entrypoint: 'cli', cwd, sessionId, version: '1.0.0', gitBranch: 'main', timestamp: new Date(T0 + i * 1000).toISOString() }
    return [
      { ...base, parentUuid: null, uuid: u, type: 'user', message: { role: 'user', content: prompt } },
      { ...base, parentUuid: u, uuid: a, type: 'assistant', message: { id: `msg_${i}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
  }
  const notes: string[] = []
  const seed = (n: number, project: number, minutesOld: number, rows: Record<string, unknown>[]): void => {
    const file = join(getProjectDir(projects[project]!), `${sid(n)}.jsonl`)
    mkdirSync(dirname(file), { recursive: true })
    try {
      writeFileSync(file, encodeSeedTranscript(rows as never, sid(n)))
    } catch (error) {
      notes.push(`seed ${n} could not be written: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const at = new Date(T0 - minutesOld * 60_000)
    utimesSync(file, at, at)
  }
  const P = (i: number): string => projects[i]!
  const long = 'x'.repeat(5000)
  const typedCommand = (name: string): string => `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>`
  seed(1, 0, 10, turn(sid(1), P(0), 0, 'the first prompt of one'))
  seed(2, 0, 9, [...turn(sid(2), P(0), 0, 'a prompt under a rename'), { type: 'custom-title', customTitle: 'renamed two', sessionId: sid(2) }])
  seed(3, 1, 8, [...turn(sid(3), P(1), 0, typedCommand('model')), ...turn(sid(3), P(1), 1, 'the first real prompt of three')])
  seed(4, 1, 7, [...turn(sid(4), P(1), 0, 'a prompt with a summary'), { type: 'summary', summary: 'the summary of four', leafUuid: `00000000-0000-4000-8000-${sid(4).slice(-8)}0001` }])
  seed(5, 0, 6, [{ type: 'last-prompt', lastPrompt: 'only a last prompt', sessionId: sid(5) }])
  seed(6, 0, 5, turn(sid(6), P(0), 0, typedCommand('model')))
  seed(7, 1, 4, turn(sid(7), P(1), 0, typedCommand('model'), long))
  seed(8, 0, 3, [turn(sid(8), P(0), 0, 'x')[1]!])
  seed(9, 1, 2, [...turn(sid(9), P(1), 0, 'a prompt under an ai title'), { type: 'ai-title', aiTitle: 'ai named nine', sessionId: sid(9) }])
  seed(10, 0, 1, turn(sid(10), P(0), 0, typedCommand('deploy'), long))
  const { tellSessionStorageTheBuiltInCommands } = await import('../../src/sessions/transcripts/builtInCommands.ts')
  tellSessionStorageTheBuiltInCommands(() => new Set(['model']))

  const storage = await import('../../src/sessions/transcripts/sessionListings.ts')
  const picker = await import('../../src/screen/widgets/faces/sessionPickerModel.ts')
  const page = await storage.listSessionsAcrossProjectsProgressive(undefined, 0)
  const { logs } = await storage.enrichSessionListings(page.allStatLogs, 0, page.allStatLogs.length)
  const chooser: Array<[string, string]> = picker.resumableNewestFirst(logs, '').map((log: { sessionId?: string }) => [String(log.sessionId).slice(-2), picker.rowLabel(log)])

  const handlers = new Map<string, (ctx: { params?: Record<string, unknown> }) => Promise<{ sessions: Array<{ sessionId: string; title?: string; cwd: string }>; nextCursor?: string }>>()
  const app = { onRequest(name: string, fn: never) { handlers.set(name, fn); return app }, onNotification() { return app } }
  const { sessionRequests } = await import('../../src/integrations/acp/server/sessionRequests.ts')
  sessionRequests(app as never, { sessions: new Map(), pendingLoads: new Map(), authFacts: {} } as never, {} as never)
  const listed = await handlers.get('session/list')!({ params: {} })
  const editor: Array<[string, string]> = listed.sessions.map(row => [row.sessionId.slice(-2), row.title ?? ''])

  const printed: string[] = []
  const { sessionsListCli } = await import('../../src/commands/verbs/sessionsVerb.ts')
  await sessionsListCli({ all: true }, { out: (line: string) => printed.push(line), err: (line: string) => printed.push(line) } as never)
  const command: Array<[string, string]> = printed.filter(line => /^00000000-cccc/.test(line)).map(line => {
    const id = line.slice(0, 36).slice(-2)
    const rest = line.split('  ').slice(3).join('  ')
    return [id, rest.replace(/ · \/.*$/, '').replace(/^live\s+/, '')]
  })

  const show = (rows: Array<[string, string]>): string => rows.map(([id, name]) => `${id}=${name}`).join(' | ')
  console.log(`chooser: ${show(chooser)}`)
  console.log(`editor : ${show(editor)}`)
  console.log(`command: ${show(command)}`)
  for (const note of notes) console.log(`note: ${note}`)
  const ids = (rows: Array<[string, string]>): string => rows.map(([id]) => id).join(',')
  console.log('one rule for which sessions are listed and under what name')
  check('the editor lists the sessions the chooser lists, in its order', ids(editor) === ids(chooser), `${ids(editor)} against ${ids(chooser)}`)
  check('the command lists the sessions the chooser lists, in its order', ids(command) === ids(chooser), `${ids(command)} against ${ids(chooser)}`)
  check('the editor names each as the chooser does', show(editor) === show(chooser))
  check('the command names each as the chooser does', show(command) === show(chooser))
  const nameOf = (rows: Array<[string, string]>, id: string): string | undefined => rows.find(([row]) => row === id)?.[1]
  check('a session whose first act is /model is named by its first real prompt in all three', [chooser, editor, command].every(rows => nameOf(rows, '03') === 'the first real prompt of three'), [chooser, editor, command].map(rows => nameOf(rows, '03')).join(' / '))
  check('the prompt comes before the summary in all three', [chooser, editor, command].every(rows => nameOf(rows, '04') === 'a prompt with a summary'), [chooser, editor, command].map(rows => nameOf(rows, '04')).join(' / '))
  check('a small session with nothing but a command and an assistant row alone are listed by none', [chooser, editor, command].every(rows => ['06', '08'].every(id => nameOf(rows, id) === undefined)), [chooser, editor, command].map(rows => ['06', '08'].filter(id => nameOf(rows, id) !== undefined).join('+') || 'none').join(' / '))
  check('a last prompt alone names its session in all three', [chooser, editor, command].every(rows => nameOf(rows, '05') === 'only a last prompt'))
  check('a rename and an AI title name their sessions in all three', [chooser, editor, command].every(rows => nameOf(rows, '02') === 'renamed two' && nameOf(rows, '09') === 'ai named nine'))
  check('a session of some size whose only act is a built-in command is never named by it, in all three', [chooser, editor, command].every(rows => nameOf(rows, '07') !== undefined && nameOf(rows, '07') !== '/model'), [chooser, editor, command].map(rows => nameOf(rows, '07')).join(' / '))
  check('a command that is no built-in still names a session that holds nothing else, in all three', [chooser, editor, command].every(rows => nameOf(rows, '10') === '/deploy'), [chooser, editor, command].map(rows => nameOf(rows, '10')).join(' / '))
  const board = await import('../../src/screen/concourse-model/concourseSnapshot.ts')
  const brief = (n: number, project: number): string | null => board.headBriefLabel({ sessionId: sid(n), workspaceId: P(project) }, 48)
  check('the board: a built-in command alone gives no brief; with a prompt after it, the prompt', brief(6, 0) === null && brief(7, 1) === null && brief(3, 1) === 'the first real prompt of three', `${brief(6, 0)} / ${brief(7, 1)} / ${brief(3, 1)}`)
  check('the board: a command that is no built-in still gives its name', brief(10, 0) === '/deploy', String(brief(10, 0)))
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nprove-sessions-list-reads-as-chooser: green' : `\nprove-sessions-list-reads-as-chooser: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
