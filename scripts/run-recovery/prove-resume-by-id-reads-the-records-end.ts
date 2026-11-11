#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'resume-by-id-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const project = join(scratch, 'project')
mkdirSync(project, { recursive: true })
bootstrap.setOriginalCwd(project)
bootstrap.setProjectRoot(project)
const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''

const MODEL = 'claude-opus-4-8'
const store = getProjectDir(project)
mkdirSync(store, { recursive: true })
const T0 = Date.parse('2026-11-10T09:00:00.000Z')

type Row = Record<string, unknown> & { uuid: string }
let serial = 0
function session(): { sid: string; file: string; row: (name: string, parent: string | null, atMs: number, body: Record<string, unknown>) => Row } {
  const n = ++serial
  const sid = `facef00d-0000-4000-8000-0000000b1d${String(n).padStart(2, '0')}`
  const file = join(store, `${sid}.jsonl`)
  return {
    sid,
    file,
    row: (name, parent, atMs, body) => ({ uuid: `00000000-0000-4000-8000-00b1d0${String(n).padStart(2, '0')}${name.padStart(4, '0')}`, parentUuid: parent, isSidechain: false, cwd: project, sessionId: sid, version: '1.0.9', gitBranch: 'main', timestamp: new Date(T0 + atMs).toISOString(), ...body }),
  }
}
const prompt = (text: string): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content: text } })
const reply = (id: string, text: string, stop: string): Record<string, unknown> => ({ type: 'assistant', requestId: `req_${id}`, message: { id, type: 'message', role: 'assistant', model: MODEL, stop_reason: stop, stop_sequence: null, content: [{ type: 'text', text }] } })
const notice = (words: string): Record<string, unknown> => ({ type: 'system', subtype: 'informational', level: 'warning', content: words })
const errorRow = (id: string): Record<string, unknown> => ({ type: 'assistant', isApiErrorMessage: true, apiError: 'max_output_tokens', error: 'max_output_tokens', message: { id, type: 'message', role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', stop_sequence: '', content: [{ type: 'text', text: 'API Error: the response exceeded the output token maximum.' }] } })
const write = (file: string, rows: Row[]): void => writeFileSync(file, rows.map(row => encodeTranscriptLine(file, row).line).join(''))
async function chains(sid: string, file: string): Promise<{ byId: string[]; byFile: string[] }> {
  const byId = await loadConversationForResume(sid, undefined)
  const byFile = await loadConversationForResume(sid, file)
  const recorded = (loaded: Awaited<ReturnType<typeof loadConversationForResume>>): string[] => ((loaded?.messages ?? []) as Array<{ uuid: string }>).map(row => row.uuid)
  return { byId: recorded(byId), byFile: recorded(byFile) }
}
const holds = (chain: string[], rows: Row[]): boolean[] => rows.map(row => chain.includes(row.uuid))

console.log('============================================================')
console.log(' a resume by id reads the record to its end')
console.log('============================================================')

try {
  section('S1 — the record\'s last row carries an earlier stamp than the row before it (the output ceiling\'s error row: minted when the stream ended, recorded behind the notice of the run\'s decision)')
  {
    const s = session()
    const asked = s.row('1', null, 0, prompt('S1 first prompt.'))
    const capped = s.row('2', asked.uuid, 1000, reply('msg_s1_capped', 'S1-CAPPED-REPLY that ran into the output ceiling', 'max_tokens'))
    const decided = s.row('3', capped.uuid, 1005, notice('the reply hit the output ceiling and the continuation repeated what already stood; the turn ends here'))
    const failed = s.row('4', decided.uuid, 1003, errorRow('msg_s1_error'))
    write(s.file, [asked, capped, decided, failed])
    const { byId, byFile } = await chains(s.sid, s.file)
    check('S1: by id the conversation holds every row of the record, the last one included', j(holds(byId, [asked, capped, decided, failed])) === j([true, true, true, true]), j({ holds: holds(byId, [asked, capped, decided, failed]), rows: byId.length }))
    check('S1: by id and by file it is the same conversation, row for row', byId.length > 0 && j(byId) === j(byFile), j({ byId: byId.length, byFile: byFile.length }))
  }

  section('S2 control — the same record with its stamps in the order it was written')
  {
    const s = session()
    const asked = s.row('1', null, 0, prompt('S2 first prompt.'))
    const capped = s.row('2', asked.uuid, 1000, reply('msg_s2_capped', 'S2-CAPPED-REPLY that ran into the output ceiling', 'max_tokens'))
    const decided = s.row('3', capped.uuid, 1005, notice('the reply hit the output ceiling and the continuation repeated what already stood; the turn ends here'))
    const failed = s.row('4', decided.uuid, 1007, errorRow('msg_s2_error'))
    write(s.file, [asked, capped, decided, failed])
    const { byId, byFile } = await chains(s.sid, s.file)
    check('S2: by id and by file the same conversation, every row held', j(holds(byId, [asked, capped, decided, failed])) === j([true, true, true, true]) && j(byId) === j(byFile), j({ holds: holds(byId, [asked, capped, decided, failed]), byId: byId.length, byFile: byFile.length }))
  }

  section('S3 control — a record that branches: a prompt abandoned for a later one written from the same reply')
  {
    const s = session()
    const asked = s.row('1', null, 0, prompt('S3 first prompt.'))
    const answered = s.row('2', asked.uuid, 1000, reply('msg_s3_1', 'S3-FIRST-REPLY.', 'end_turn'))
    const abandoned = s.row('3', answered.uuid, 2000, prompt('S3 a prompt later abandoned.'))
    const abandonedReply = s.row('4', abandoned.uuid, 3000, reply('msg_s3_2', 'S3-ABANDONED-REPLY.', 'end_turn'))
    const kept = s.row('5', answered.uuid, 4000, prompt('S3 the prompt that was kept.'))
    const keptReply = s.row('6', kept.uuid, 5000, reply('msg_s3_3', 'S3-KEPT-REPLY.', 'end_turn'))
    write(s.file, [asked, answered, abandoned, abandonedReply, kept, keptReply])
    const { byId, byFile } = await chains(s.sid, s.file)
    check('S3: by id the conversation is the newer line — the kept prompt and its reply, not the abandoned pair', j(holds(byId, [asked, answered, abandoned, abandonedReply, kept, keptReply])) === j([true, true, false, false, true, true]) && j(byId) === j(byFile), j({ holds: holds(byId, [asked, answered, abandoned, abandonedReply, kept, keptReply]) }))
  }

  section('S4 — the record\'s last row has only a crewmate\'s row behind it')
  {
    const s = session()
    const asked = s.row('1', null, 0, prompt('S4 first prompt.'))
    const answered = s.row('2', asked.uuid, 1000, reply('msg_s4_1', 'S4-FIRST-REPLY.', 'end_turn'))
    const crewmate = { ...s.row('3', answered.uuid, 500, prompt('S4 a crewmate\'s row.')), isSidechain: true, agentId: 'a1b2c3d4e5f60718' }
    write(s.file, [asked, answered, crewmate])
    const { byId, byFile } = await chains(s.sid, s.file)
    check('S4: by id and by file the conversation still ends on that row — a crewmate\'s row is not a row behind it', j(holds(byId, [asked, answered, crewmate])) === j([true, true, false]) && j(byId) === j(byFile), j({ byId: holds(byId, [asked, answered, crewmate]), byFile: holds(byFile, [asked, answered, crewmate]) }))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ RESUME BY ID READS THE RECORD'S END (${checks} checks)` : ` ❌ ${failures} of ${checks} RESUME-BY-ID CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
