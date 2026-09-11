import { execSync, spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmdirSync, rmSync, utimesSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { REJECT_MESSAGE } from '../../src/utils/messages/rejectionText.ts'
import {
  STREAM_FAULT_RECOVERY_NUDGE,
  streamFaultAfterPartialText,
} from '../../src/services/api/errors.ts'
import { getProjectDir } from '../../src/utils/sessionStoragePortable.ts'
import { entryToRecord } from '../../src/fabric/entryCodec.ts'
import { ordinalOf } from '../../src/fabric/ordinal.ts'
import { saveBootDefaultsProfile } from '../../src/substrate/startupMenu.ts'
import { referenceFixtureSnapshot } from '../notifications/concourseReferenceSeed.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { resolveProofHome } from '../lib/proofHome.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')

function applyRenderTheme(scratch: string): void {
  const renderTheme = process.env.MERCURY_RENDER_THEME
  if (!renderTheme) return
  const cfgPath = join(scratch, '.mercury.json')
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    cfg['theme'] = renderTheme
    writeFileSync(cfgPath, JSON.stringify(cfg))
  } catch {
    writeFileSync(cfgPath, JSON.stringify({ theme: renderTheme }))
  }
  process.env.MERCURY_THEME_PIN = renderTheme
}

export const RUNTIME_CWD = (process.env.MERCURY_RENDER_CWD ?? REPO).normalize('NFC')
export const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = getProjectDir(RUNTIME_CWD)
export const SID = `00000000-aaaa-bbbb-cccc-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`
export const SID_ERRORED = `00000000-aaaa-bbbb-dddd-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`

const WF_SUFFIX = (process.pid % 0xffffff).toString(16).padStart(6, '0')
const WF_RUN_COMPLETED = `wf_fixture_completed_${WF_SUFFIX}`
const WF_RUN_STALE = `wf_fixture_stale_${WF_SUFFIX}`
const WF_RUN_PAUSED = `wf_fixture_paused_${WF_SUFFIX}`
const WF_RUN_EXT_LIVE = `wf_fixture_extlive_${WF_SUFFIX}`
const WF_RUN_EXT_WEDGED = `wf_fixture_extwedged_${WF_SUFFIX}`
const { workflowRunsRoot } = await import('../../src/tools/WorkflowTool/runManifest.js')
const WF_RUNS_ROOT = workflowRunsRoot(RUNTIME_CWD)
const WF_FIXTURE_AGENT_ID = 'fxagentA'

const LONG_PROSE =
  'as coming you gave up something you could not name and the vast indifferent sea at his back ' +
  'was only the shape of every harbor he had ever left behind with no instruction and no mercy ' +
  'and the bones of broken ships carried no warning to the man who had once worn the far country ' +
  'like a second skin and now he had neither port to keep him warm nor any pretense left to sell.'

const LONG_URL =
  'see https://commoncultureintl.example.com/very/long/unbreakable/path/segment/that/cannot/wrap/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?q=1 for the spec'
const CODE_BLOCK =
  'here:\n```ts\nexport function aVeryLongFunctionNameThatRunsToTheEdge(argumentOne: string, argumentTwo: number): Promise<void> { return doTheThing() }\n```\ndone'
const TABLE_ROW =
  '| column-one-header | column-two-header | column-three-header | column-four-header | column-five-header |'

const TOOL_USE_BASH = {
  type: 'tool_use', id: 'toolu_bash1', name: 'Bash',
  input: { command: 'echo hi', description: 'Echo greeting' },
}
const TOOL_RESULT_BASH = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', content: [{ type: 'text', text: 'hi' }] }],
  toolUseResult: { stdout: 'hi', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
}
const TOOL_USE_BASH2 = {
  type: 'tool_use', id: 'toolu_bash2', name: 'Bash',
  input: { command: 'echo again', description: 'Echo again' },
}
const TOOL_RESULT_BASH2 = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_bash2', content: [{ type: 'text', text: 'again' }] }],
  toolUseResult: { stdout: 'again', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
}
const TOOL_USE_TODO = {
  type: 'tool_use', id: 'toolu_todo1', name: 'TodoWrite',
  input: { todos: [
    { content: 'run the greeting', status: 'completed', activeForm: 'running the greeting' },
    { content: 'run it again', status: 'in_progress', activeForm: 'running it again' },
  ] },
}
const TOOL_RESULT_TODO = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_todo1', content: [{ type: 'text', text: 'Todos have been modified successfully.' }] }],
  toolUseResult: {
    oldTodos: [],
    newTodos: [
      { content: 'run the greeting', status: 'completed', activeForm: 'running the greeting' },
      { content: 'run it again', status: 'in_progress', activeForm: 'running it again' },
    ],
  },
}
const TOOL_USE_READ = {
  type: 'tool_use', id: 'toolu_read1', name: 'Read',
  input: { file_path: join(RUNTIME_CWD, 'package.json') },
}
const TOOL_USE_STRUCTURE = {
  type: 'tool_use', id: 'toolu_struct1', name: 'Structure',
  input: { op: 'preview', action: 'replace', replacement: 'return greetOperator(name)' },
}
const STRUCTURE_CHANGE_VIEW = {
  state: 'proposed', action: 'replace', matchCount: 2,
  files: [
    {
      file: 'src/greet.ts', changedLines: 1,
      hunks: [{ oldStart: 4, oldLines: 3, newStart: 4, newLines: 3, lines: [
        ' export function greet(name: string) {',
        '-  return greetUser(name)',
        '+  return greetOperator(name)',
        ' }',
      ] }],
    },
    {
      file: 'src/cli.ts', changedLines: 1,
      hunks: [{ oldStart: 11, oldLines: 3, newStart: 11, newLines: 3, lines: [
        ' const out =',
        '-  greetUser(args.name)',
        '+  greetOperator(args.name)',
        ' console.log(out)',
      ] }],
    },
  ],
  diagnostics: { planned: 2 },
  refs: ['mercury://structure/preview/sp-fixture01'],
}
const TOOL_RESULT_STRUCTURE = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_struct1', content: [{ type: 'text', text: 'sp-fixture01 [proposed] replace — 2 match(es) · 2 file(s)' }] }],
  toolUseResult: {
    op: 'preview',
    result: 'sp-fixture01 [proposed] replace — 2 match(es) · 2 file(s) · ~2 changed line(s)',
    outcome: 'succeeded',
    previewId: 'sp-fixture01',
    changeView: STRUCTURE_CHANGE_VIEW,
  },
}
const CHANGESET_PLAN_META = {
  id: 'cs-fixture0001', digest12: 'abc123def456', ageMs: 120_000, expiresInMs: 1_680_000,
}
const CHANGESET_VIEW_APPLIED = {
  state: 'applied', action: 'changeset', hunkCount: 3,
  noChangePaths: ['src/util.ts'],
  planMeta: CHANGESET_PLAN_META,
  files: [
    {
      file: 'src/api.ts', changedLines: 4,
      hunks: [{ oldStart: 7, oldLines: 3, newStart: 7, newLines: 3, lines: [
        ' export async function fetchRates() {',
        '-  return client.get("/v1/rates")',
        '+  return client.get("/v2/rates")',
        ' }',
      ] }],
    },
    {
      file: 'src/model.ts', changedLines: 4, omittedHunks: 2,
      hunks: [{ oldStart: 21, oldLines: 3, newStart: 21, newLines: 3, lines: [
        ' const RATE_SOURCE =',
        '-  "v1"',
        '+  "v2"',
        ' export { RATE_SOURCE }',
      ] }],
    },
  ],
  refs: [],
}
const TOOL_USE_CHANGESET = {
  type: 'tool_use', id: 'toolu_cs1', name: 'ChangeSet',
  input: { op: 'apply', changes: [
    { file_path: 'src/api.ts', expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '8', replace: '  return client.get("/v2/rates")' }] },
    { file_path: 'src/model.ts', expected_anchor: 'fa:0123456789ac', hunks: [{ lines: '22', replace: '  "v2"' }] },
    { file_path: 'src/util.ts', expected_anchor: 'fa:0123456789ad', hunks: [{ lines: '3', replace: 'already-satisfied' }] },
  ] },
}
const TOOL_RESULT_CHANGESET = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_cs1', content: [{ type: 'text', text: 'Applied plan cs-fixture0001 — 2 file(s), 3 hunk(s), verified by reread' }] }],
  toolUseResult: {
    op: 'apply',
    result: 'Applied plan cs-fixture0001 — 2 file(s), 3 hunk(s), verified by reread:\n  src/api.ts\n  src/model.ts\nalready satisfied (not written): src/util.ts',
    outcome: 'succeeded', planId: 'cs-fixture0001', changeView: CHANGESET_VIEW_APPLIED,
  },
}
const TOOL_USE_CHANGESET_NC = {
  type: 'tool_use', id: 'toolu_cs2', name: 'ChangeSet',
  input: { op: 'apply', plan_id: 'cs-fixture0002' },
}
const TOOL_RESULT_CHANGESET_NC = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_cs2', content: [{ type: 'text', text: 'No changes needed — every member already satisfied' }] }],
  toolUseResult: {
    op: 'apply',
    result: 'No changes needed — every member of plan cs-fixture0002 is already satisfied (src/api.ts, src/model.ts). Nothing was written.',
    outcome: 'no-change', planId: 'cs-fixture0002',
    changeView: {
      state: 'no-change', action: 'changeset', hunkCount: 2, files: [],
      noChangePaths: ['src/api.ts', 'src/model.ts'],
      planMeta: { id: 'cs-fixture0002', digest12: 'beefcafe0123', ageMs: 30_000, expiresInMs: 1_770_000 },
      refs: [],
    },
  },
}
const TOOL_USE_CHANGESET_STALE = {
  type: 'tool_use', id: 'toolu_cs3', name: 'ChangeSet',
  input: { op: 'apply', plan_id: 'cs-fixture0003' },
}
const TOOL_RESULT_CHANGESET_STALE = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_cs3', content: [{ type: 'text', text: 'Stale plan cs-fixture0003 — 1 file(s) changed since the plan was made. Nothing was written.' }] }],
  toolUseResult: {
    op: 'apply',
    result: 'Stale plan cs-fixture0003 — 1 file(s) changed since the plan was made. Nothing was written.\n  src/api.ts: current anchor fa:aaaabbbbcccc — re-read this file',
    outcome: 'failed', planId: 'cs-fixture0003',
    changeView: {
      state: 'stale', action: 'changeset', hunkCount: 2,
      planMeta: { id: 'cs-fixture0003', digest12: 'dddd0000eeee', ageMs: 900_000, expiresInMs: 900_000 },
      files: [{
        file: 'src/api.ts', changedLines: 2,
        hunks: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: ['-old-line', '+new-line'] }],
      }],
      refs: [],
      nextAction: 're-read src/api.ts, then op:"preview" again',
    },
  },
}
const TOOL_USE_EDIT_OK = {
  type: 'tool_use', id: 'toolu_lc_edit1', name: 'Edit',
  input: {
    file_path: RUNTIME_CWD + '/lifecycle-demo.txt',
    old_string: 'alpha', new_string: 'omega',
  },
}
const TOOL_RESULT_EDIT_OK = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_lc_edit1', content: 'ok' }],
  toolUseResult: {
    filePath: RUNTIME_CWD + '/lifecycle-demo.txt',
    oldString: 'alpha', newString: 'omega',
    originalFile: 'alpha\n',
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-alpha', '+omega'] }],
    userModified: false,
    replaceAll: false,
  },
}
const SP_DEMO_PATH = join(process.cwd(), 'stillpoint-demo.txt')
const TOOL_USE_EDIT_NOCHANGE = {
  type: 'tool_use', id: 'toolu_sp_edit1', name: 'Edit',
  input: {
    file_path: SP_DEMO_PATH,
    expected_anchor: 'fa:000000000000',
    hunks: [{ lines: '1', replace: 'alpha' }],
  },
}
const TOOL_RESULT_EDIT_NOCHANGE = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_sp_edit1', content: `No changes made to ${SP_DEMO_PATH} — the computed edit result is byte-identical to the current file content. Nothing was written.` }],
  toolUseResult: {
    filePath: SP_DEMO_PATH,
    oldString: 'alpha', newString: 'alpha',
    originalFile: 'alpha\n',
    structuredPatch: [],
    userModified: false,
    replaceAll: false,
    noChange: { streak: 1, stop: false, guidance: 'The file already matches this edit.' },
  },
}
const TOOL_USE_WRITE_NOCHANGE = {
  type: 'tool_use', id: 'toolu_sp_write1', name: 'Write',
  input: { file_path: SP_DEMO_PATH, content: 'alpha\n' },
}
const TOOL_RESULT_WRITE_NOCHANGE = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_sp_write1', content: `No changes made to ${SP_DEMO_PATH} — the file content already matches what you provided. Nothing was written.` }],
  toolUseResult: {
    type: 'no-change',
    filePath: SP_DEMO_PATH,
    content: 'alpha\n',
    structuredPatch: [],
    originalFile: 'alpha\n',
    noChange: { streak: 1, stop: false, guidance: 'The file already matches this write.' },
  },
}
const TOOL_USE_BASH_PENDING = {
  type: 'tool_use', id: 'toolu_lc_bash1', name: 'Bash',
  input: { command: 'sleep 999', description: 'Long-running fixture command' },
}
const TOOL_RESULT_READ = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_read1', content: [{ type: 'text', text: '{\n  "name": "orchard"\n}' }] }],
  toolUseResult: {
    type: 'text',
    file: { filePath: RUNTIME_CWD + '/package.json', content: '{\n  "name": "orchard"\n}', numLines: 3, startLine: 1, totalLines: 3 },
  },
}
const AGENT_REPORT_LINE = 'REPORT-LINE the manifest pins bun 1.2 and the build is green.'
const TOOL_USE_AGENT = {
  type: 'tool_use', id: 'toolu_agent1', name: 'Agent',
  input: { description: 'Scout the manifest', prompt: 'Read package.json and report.', subagent_type: 'Explore' },
}
const TOOL_RESULT_AGENT = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_agent1', content: [{ type: 'text', text: AGENT_REPORT_LINE }] }],
  toolUseResult: {
    status: 'completed', agentId: 'synthagent1', agentType: 'Explore',
    content: [{ type: 'text', text: AGENT_REPORT_LINE }],
    totalDurationMs: 12_345, totalToolUseCount: 3, totalTokens: 4567,
    usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, server_tool_use: null, service_tier: null, cache_creation: null },
    prompt: 'Read package.json and report.',
  },
}
const TOOL_USE_GLOB = {
  type: 'tool_use', id: 'toolu_glob1', name: 'Glob',
  input: { pattern: 'src/tools/GlobTool/*.ts' },
}
const TOOL_RESULT_GLOB = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_glob1', content: [{ type: 'text', text: 'GlobTool.ts\nprompt.ts' }] }],
  toolUseResult: { durationMs: 12, numFiles: 2, filenames: ['src/tools/GlobTool/GlobTool.ts', 'src/tools/GlobTool/prompt.ts'], truncated: false },
}
const WORKFLOW_SCRIPT =
  'export const meta = { name: "greet-and-read", description: "greet then read the manifest" }\nphase("Scan")\nawait agent("say hi")'
const TOOL_USE_WORKFLOW = {
  type: 'tool_use', id: 'toolu_wf1', name: 'Workflow',
  input: { script: WORKFLOW_SCRIPT },
}
const TOOL_RESULT_WORKFLOW = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_wf1', content: [{ type: 'text', text: 'Workflow launched in background. Task ID: synthWfTask' }] }],
  toolUseResult: {
    status: 'async_launched', taskId: 'synthWfTask', taskType: 'local_workflow',
    workflowName: 'greet-and-read', runId: 'wf_synth0001',
    summary: 'greet then read the manifest',
  },
}

const TOOL_USE_EDIT_ERR = {
  type: 'tool_use', id: 'toolu_editerr1', name: 'Edit',
  input: {
    file_path: join(RUNTIME_CWD, 'src', 'utils', 'cockpit', 'missing-manifest.ts'),
    old_string: 'export const manifest', new_string: 'export const manifestV2',
  },
}
const TOOL_USE_EDIT_DENIED = {
  type: 'tool_use', id: 'toolu_editdeny1', name: 'Edit',
  input: {
    file_path: join(RUNTIME_CWD, 'src', 'prod-rollout.ts'),
    old_string: 'const rollout = false', new_string: 'const rollout = true',
  },
}
const EDIT_ERROR_TEXT = [
  `Error: ENOENT: no such file or directory, open '${join(RUNTIME_CWD, 'src', 'utils', 'cockpit', 'missing-manifest.ts')}'`,
  'The target file could not be read before editing.',
  '    at Object.openSync (node:fs:601:3)',
  '    at readFileSync (node:fs:469:35)',
  '    at applyEdit (src/tools/FileEditTool/applyEdit.ts:42:19)',
].join('\n')
const API_ERROR_TEXT =
  'API Error: 529 overloaded. The upstream service is shedding load — wait a moment before retrying. ' +
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_fixture_529"}'

const STREAM_FAULT_TEXT = streamFaultAfterPartialText(
  'OpenAI',
  'server_error',
  'stream closed unexpectedly mid-response',
)

function purgeFixtureDraft(sid: string): void {
  try {
    const draftsDir = join(CONFIG_HOME, 'drafts')
    if (!existsSync(draftsDir)) return
    for (const f of readdirSync(draftsDir)) {
      if (!f.endsWith('.json')) continue
      const fp = join(draftsDir, f)
      try {
        const parsed = JSON.parse(require('node:fs').readFileSync(fp, 'utf8')) as Record<string, unknown>
        if (sid in parsed) {
          delete parsed[sid]
          writeFileSync(fp, JSON.stringify(parsed, null, 2) + '\n')
        }
      } catch {
      }
    }
  } catch {
  }
}

export function encodeFixtureTranscript(
  lines: Record<string, unknown>[],
  sessionId: string,
): string {
  let n = 0
  const ctx = {
    sessionId: sessionId as never,
    nextOrdinal: () => ordinalOf(++n) as never,
    observedAt: '2026-06-19T12:00:00.000Z',
    source: { channel: 'sdk' } as const,
  }
  return lines.map(l => JSON.stringify(entryToRecord(l, ctx as never))).join('\n') + '\n'
}

export function writeSyntheticSession(
  variant: 'short' | 'long' | 'tall' | 'content' | 'link' | 'tools' | 'expand' | 'workflow' | 'errors' | 'denials' | 'model-noise' | 'channel' | 'fork' | 'thinking' | 'gpt-thinking' | 'gpt-record' | 'lifecycle' | 'structure' | 'changeset' | 'stream-fault' | 'stillpoint' | 'shell-interleave' | 'markdown-blocks' = 'short',
  sid: string = SID,
): void {
  purgeFixtureDraft(sid)
  const base = (extra: Record<string, unknown>) => ({
    isSidechain: false, entrypoint: 'cli',
    cwd: RUNTIME_CWD, sessionId: sid,
    version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
  })
  const lines = variant === 'errors'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'apply the manifest edit' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_e1',
          message: { id: 'msg_synth_e1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_EDIT_ERR], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_editerr1', content: EDIT_ERROR_TEXT, is_error: true }] },
          toolUseResult: EDIT_ERROR_TEXT,
          timestamp: '2026-06-19T12:00:03.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000003', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000004', requestId: 'req_synth_e2',
          isApiErrorMessage: true,
          message: { id: 'msg_synth_e2', type: 'message', role: 'assistant', model: '<synthetic>',
            content: [{ type: 'text', text: API_ERROR_TEXT }], stop_reason: 'stop_sequence', stop_sequence: '',
            usage: { input_tokens: 0, output_tokens: 0 } },
          timestamp: '2026-06-19T12:00:04.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000004', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000005', requestId: 'req_synth_e3',
          isApiErrorMessage: true,
          message: { id: 'msg_synth_e3', type: 'message', role: 'assistant', model: '<synthetic>',
            content: [{ type: 'text', text: 'Request timed out' }], stop_reason: 'stop_sequence', stop_sequence: '',
            usage: { input_tokens: 0, output_tokens: 0 } },
          timestamp: '2026-06-19T12:00:05.000Z' }),
      ]
    : variant === 'denials'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'flip the rollout flag, then fix the manifest edit' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_d1',
          message: { id: 'msg_synth_d1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_EDIT_DENIED], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_editdeny1', content: REJECT_MESSAGE, is_error: true }] },
          toolUseResult: REJECT_MESSAGE,
          timestamp: '2026-06-19T12:00:03.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000003', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000004', requestId: 'req_synth_d2',
          message: { id: 'msg_synth_d2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_EDIT_ERR], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:04.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000004', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000005',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_editerr1', content: EDIT_ERROR_TEXT, is_error: true }] },
          toolUseResult: EDIT_ERROR_TEXT,
          timestamp: '2026-06-19T12:00:05.000Z' }),
      ]
    : variant === 'stream-fault'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'summarize the migration plan' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_sf1',
          message: { id: 'msg_synth_sf1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'The migration lands in two phases — first the schema swap,' }],
            stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000003', requestId: 'req_synth_sf2',
          isApiErrorMessage: true,
          message: { id: 'msg_synth_sf2', type: 'message', role: 'assistant', model: '<synthetic>',
            content: [{ type: 'text', text: STREAM_FAULT_TEXT }], stop_reason: 'stop_sequence', stop_sequence: '',
            usage: { input_tokens: 0, output_tokens: 0 } },
          timestamp: '2026-06-19T12:00:03.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000003', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000004', isMeta: true,
          message: { role: 'user', content: STREAM_FAULT_RECOVERY_NUDGE },
          timestamp: '2026-06-19T12:00:04.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000004', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000005', requestId: 'req_synth_sf3',
          message: { id: 'msg_synth_sf3', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'then the traffic cutover — completing the summary.' }],
            stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:05.000Z' }),
      ]
    : variant === 'workflow'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'run the greet-and-read workflow' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_wf',
          message: { id: 'msg_synth_wf', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_WORKFLOW], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: TOOL_RESULT_WORKFLOW.content },
          toolUseResult: TOOL_RESULT_WORKFLOW.toolUseResult,
          timestamp: '2026-06-19T12:00:03.000Z' }),
      ]
    : variant === 'structure'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'rename greetUser to greetOperator' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_st1',
          message: { id: 'msg_synth_st1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_STRUCTURE], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: TOOL_RESULT_STRUCTURE.content },
          toolUseResult: TOOL_RESULT_STRUCTURE.toolUseResult,
          timestamp: '2026-06-19T12:00:03.000Z' }),
      ]
    : variant === 'changeset'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'migrate the rate client to v2 across the tree' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_cs1',
          message: { id: 'msg_synth_cs1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_CHANGESET], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: TOOL_RESULT_CHANGESET.content },
          toolUseResult: TOOL_RESULT_CHANGESET.toolUseResult,
          timestamp: '2026-06-19T12:00:03.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000003', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000004', requestId: 'req_synth_cs2',
          message: { id: 'msg_synth_cs2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_CHANGESET_NC], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:04.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000004', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000005',
          message: { role: 'user', content: TOOL_RESULT_CHANGESET_NC.content },
          toolUseResult: TOOL_RESULT_CHANGESET_NC.toolUseResult,
          timestamp: '2026-06-19T12:00:05.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000005', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000006', requestId: 'req_synth_cs3',
          message: { id: 'msg_synth_cs3', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_CHANGESET_STALE], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:06.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000006', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000007',
          message: { role: 'user', content: TOOL_RESULT_CHANGESET_STALE.content },
          toolUseResult: TOOL_RESULT_CHANGESET_STALE.toolUseResult,
          timestamp: '2026-06-19T12:00:07.000Z' }),
      ]
    : variant === 'markdown-blocks'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'summarize the plan as a checklist' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_md1',
          message: { id: 'msg_synth_md1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'Three steps, in order:\n\n- prepare the tree\n  - fetch main\n  - rebase the lane\n- run the focused provers\n- publish\n\n---\n\nNotes after the rule:\n\n1. the first note has a\n   continuation line\n2. the second note' }],
            stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
      ]
    : variant === 'shell-interleave'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'run the greeting twice and keep the checklist current' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_si1',
          message: { id: 'msg_synth_si1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_BASH], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: TOOL_RESULT_BASH.content },
          toolUseResult: TOOL_RESULT_BASH.toolUseResult,
          timestamp: '2026-06-19T12:00:03.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000003', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000004', requestId: 'req_synth_si2',
          message: { id: 'msg_synth_si2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_TODO], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:04.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000004', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000005',
          message: { role: 'user', content: TOOL_RESULT_TODO.content },
          toolUseResult: TOOL_RESULT_TODO.toolUseResult,
          timestamp: '2026-06-19T12:00:05.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000005', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000006', requestId: 'req_synth_si3',
          message: { id: 'msg_synth_si3', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_BASH2], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:06.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000006', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000007',
          message: { role: 'user', content: TOOL_RESULT_BASH2.content },
          toolUseResult: TOOL_RESULT_BASH2.toolUseResult,
          timestamp: '2026-06-19T12:00:07.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000007', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000008', requestId: 'req_synth_si4',
          message: { id: 'msg_synth_si4', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'Both greetings ran; the checklist is current.' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:08.000Z' }),
      ]
    : variant === 'stillpoint'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'reapply the demo edit and rewrite the file' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_sp1',
          message: { id: 'msg_synth_sp1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_EDIT_NOCHANGE], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: TOOL_RESULT_EDIT_NOCHANGE.content },
          toolUseResult: TOOL_RESULT_EDIT_NOCHANGE.toolUseResult,
          timestamp: '2026-06-19T12:00:03.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000003', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000004', requestId: 'req_synth_sp2',
          message: { id: 'msg_synth_sp2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_WRITE_NOCHANGE], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:04.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000004', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000005',
          message: { role: 'user', content: TOOL_RESULT_WRITE_NOCHANGE.content },
          toolUseResult: TOOL_RESULT_WRITE_NOCHANGE.toolUseResult,
          timestamp: '2026-06-19T12:00:05.000Z' }),
      ]
    : variant === 'tools'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'run the greeting and read the manifest' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_1',
          message: { id: 'msg_synth_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_BASH], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: TOOL_RESULT_BASH.content },
          toolUseResult: TOOL_RESULT_BASH.toolUseResult,
          timestamp: '2026-06-19T12:00:03.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000003', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000004', requestId: 'req_synth_2',
          message: { id: 'msg_synth_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_READ], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:04.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000004', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000005',
          message: { role: 'user', content: TOOL_RESULT_READ.content },
          toolUseResult: TOOL_RESULT_READ.toolUseResult,
          timestamp: '2026-06-19T12:00:05.000Z' }),
      ]
    : variant === 'lifecycle'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'swap alpha for omega, then run the long job' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_lc_1',
          message: { id: 'msg_lc_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_EDIT_OK], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: TOOL_RESULT_EDIT_OK.content },
          toolUseResult: TOOL_RESULT_EDIT_OK.toolUseResult,
          timestamp: '2026-06-19T12:00:03.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000003', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000004', requestId: 'req_lc_2',
          message: { id: 'msg_lc_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_BASH_PENDING], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:04.000Z' }),
      ]
    : variant === 'gpt-record'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'summarize the release plan' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_gptrec_1',
          message: { id: 'msg_gptrec_1', type: 'message', role: 'assistant', model: 'gpt-5.1',
            content: [{ type: 'text', text: 'The plan ships in three coherent slices.' }],
            stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          apexProviderTurn: {
            provider: 'openai', responseId: 'resp_gptrec_1',
            items: [
              { type: 'reasoning', id: 'rs_gptrec_1', encrypted_content: 'opaque-gptrec', summary: [] },
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The plan ships in three coherent slices.' }] },
            ],
          },
          timestamp: '2026-06-19T12:00:02.000Z' }),
      ]
    : variant === 'gpt-thinking'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'plan the rollout' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_gptthink_1',
          message: { id: 'msg_gptthink_1', type: 'message', role: 'assistant', model: 'gpt-5.6-sol',
            content: [
              { type: 'thinking', thinking: 'Weighing the three slices against the freeze window.', signature: '' },
              { type: 'text', text: 'Ship slice one behind the gate, then widen.' },
            ],
            stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
      ]
    : variant === 'thinking'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'why does the manifest pin zod?' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_t1',
          message: { id: 'msg_synth_t1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [
              { type: 'thinking', thinking: 'The manifest pins zod because the build folds its version at bundle time.\nA floating range would drift the folded constant away from the runtime dependency.', signature: 'sig_fixture_t1' },
              { type: 'text', text: 'The pin keeps the bundled zod version in lock-step with the build-time fold.' },
            ], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
      ]
    : variant === 'expand'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'scout the manifest, list glob tool files, then fail an edit' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_expand_1',
          message: { id: 'msg_expand_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_AGENT], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: TOOL_RESULT_AGENT.content },
          toolUseResult: TOOL_RESULT_AGENT.toolUseResult,
          timestamp: '2026-06-19T12:00:03.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000003', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000004', requestId: 'req_expand_2',
          message: { id: 'msg_expand_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'The scout is back.' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:04.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000004', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000005', requestId: 'req_expand_3',
          message: { id: 'msg_expand_3', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_GLOB], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:05.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000005', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000006',
          message: { role: 'user', content: TOOL_RESULT_GLOB.content },
          toolUseResult: TOOL_RESULT_GLOB.toolUseResult,
          timestamp: '2026-06-19T12:00:06.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000006', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000007', requestId: 'req_expand_4',
          message: { id: 'msg_expand_4', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'Two files found. Now the failing edit.' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:07.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000007', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000008', requestId: 'req_expand_5',
          message: { id: 'msg_expand_5', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_EDIT_ERR], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:08.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000008', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000009',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_editerr1', content: EDIT_ERROR_TEXT, is_error: true }] },
          toolUseResult: EDIT_ERROR_TEXT,
          timestamp: '2026-06-19T12:00:09.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000009', type: 'assistant',
          uuid: '00000000-0000-4000-8000-00000000000a', requestId: 'req_expand_6',
          message: { id: 'msg_expand_6', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'That failed as expected — coverage complete.' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:10.000Z' }),
      ]
    : variant === 'two-bash'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000000b1',
          message: { role: 'user', content: 'run two checks' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-0000000000c59', type: 'assistant',
          uuid: '00000000-0000-4000-8000-0000000000b2', requestId: 'req_tb_1',
          message: { id: 'msg_tb_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_BASH], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:02:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-0000000000b2', type: 'user',
          uuid: '00000000-0000-4000-8000-0000000000b3',
          message: { role: 'user', content: TOOL_RESULT_BASH.content },
          toolUseResult: TOOL_RESULT_BASH.toolUseResult,
          timestamp: '2026-06-19T12:02:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-0000000000b3', type: 'assistant',
          uuid: '00000000-0000-4000-8000-0000000000b4', requestId: 'req_tb_2',
          message: { id: 'msg_tb_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'First check done — running the second.' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:02:03.000Z' }),
        ...Array.from({ length: 60 }, (_, fi) =>
          base({ parentUuid: fi === 0 ? '00000000-0000-4000-8000-0000000000b1' : `00000000-0000-4000-8000-0000000000c${fi - 1}`, type: 'assistant' as const,
            uuid: `00000000-0000-4000-8000-0000000000c${fi}`, requestId: `req_tb_f${fi}`,
            message: { id: `msg_tb_f${fi}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8',
              content: [{ type: 'text', text: `Interim note ${fi + 1}: the checks are progressing and this filler paragraph pads the transcript so the scrollbox has real overflow to manage while the tail stays followed.` }],
              stop_reason: 'end_turn', stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 } },
            timestamp: `2026-06-19T12:${String(Math.floor((2 + fi) / 60)).padStart(2, '0')}:${String((2 + fi) % 60).padStart(2, '0')}.000Z` })),
        base({ parentUuid: '00000000-0000-4000-8000-0000000000b4', type: 'assistant',
          uuid: '00000000-0000-4000-8000-0000000000b5', requestId: 'req_tb_3',
          message: { id: 'msg_tb_3', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'tool_use', id: 'toolu_bash2', name: 'Bash',
              input: { command: 'shasum -a 256 report.md', description: 'Checksum the report' } }],
            stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:02:04.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-0000000000b5', type: 'user',
          uuid: '00000000-0000-4000-8000-0000000000b6',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash2',
            content: [{ type: 'text', text: 'cafe1234  report.md' }] }] },
          toolUseResult: { stdout: 'cafe1234  report.md', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
          timestamp: '2026-06-19T12:02:05.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-0000000000b6', type: 'assistant',
          uuid: '00000000-0000-4000-8000-0000000000b7', requestId: 'req_tb_4',
          message: { id: 'msg_tb_4', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'Both checks ran clean.' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:02:06.000Z' }),
      ]
    : variant === 'fork'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: '<fork-boilerplate>\nSTOP. READ THIS FIRST.\n\nYou are a forked worker process. You are NOT the main agent.\n\nRULES (non-negotiable):\n1. Do NOT spawn sub-agents; execute directly.\n2. Do NOT converse, ask questions, or suggest next steps\n3. USE your tools directly: Bash, Read, Write, etc.\n</fork-boilerplate>\n\nYour directive: audit the walker resolver and report the gaps' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_fk1',
          message: { id: 'msg_synth_fk1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'Scope: the walker resolver.\nResult: two gaps found and reported.' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
      ]
    : variant === 'channel'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'hold the room open while I test the bus' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_ch1',
          message: { id: 'msg_synth_ch1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'Standing by — the room is open.' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: '<channel source="local" user="kim">\nship the panel fix once the gate is green\n</channel>' },
          timestamp: '2026-06-19T12:00:03.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000003', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000004',
          message: { role: 'user', content: '<channel source="ext:slack-channel:slack">\ndeploy window opens at 15:00 UTC\n</channel>' },
          timestamp: '2026-06-19T12:00:04.000Z' }),
      ]
    : variant === 'model-noise'
    ? [
        base({ parentUuid: null, type: 'user', isMeta: true,
          uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000002',
          message: { role: 'user', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>' },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: '<local-command-stdout>Set model to Sonnet 5</local-command-stdout>' },
          timestamp: '2026-06-19T12:00:03.000Z' }),
      ]
    : variant === 'link'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'where is the frame contract documented?' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_l1',
          message: { id: 'msg_synth_l1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'the writer contract lives in [the build notes](https://example.com/mercury/frame-writer#contract) — hold every law there.' }],
            stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
      ]
    : variant === 'content'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: LONG_URL }, timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000002',
          message: { role: 'user', content: CODE_BLOCK }, timestamp: '2026-06-19T12:00:02.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000003',
          message: { role: 'user', content: TABLE_ROW }, timestamp: '2026-06-19T12:00:03.000Z' }),
      ]
    : variant === 'long'
    ? [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: LONG_PROSE }, timestamp: '2026-06-19T12:00:01.000Z' }),
      ]
    : variant === 'tall'
    ?
      Array.from({ length: 18 }, (_, t) => {
        const i = t + 1
        const uUuid = `00000000-0000-4000-8000-${String(i * 2 - 1).padStart(12, '0')}`
        const aUuid = `00000000-0000-4000-8000-${String(i * 2).padStart(12, '0')}`
        const prev = i === 1 ? null : `00000000-0000-4000-8000-${String(i * 2 - 2).padStart(12, '0')}`
        return [
          base({ parentUuid: prev, type: 'user', uuid: uUuid,
            message: { role: 'user', content: `turn ${i}: say something long please` },
            timestamp: `2026-06-19T12:${String(i).padStart(2, '0')}:01.000Z` }),
          base({ parentUuid: uUuid, type: 'assistant', uuid: aUuid, requestId: `req_tall_${i}`,
            message: { id: `msg_tall_${i}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8',
              content: [{ type: 'text', text: `Reply ${i}: ` + 'the quick brown fox jumps over the lazy dog and keeps going across the dunes. '.repeat(6) }],
              stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
            timestamp: `2026-06-19T12:${String(i).padStart(2, '0')}:02.000Z` }),
        ]
      }).flat()
    : [
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'first task' }, timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'user',
          uuid: '00000000-0000-4000-8000-000000000002',
          message: { role: 'user', content: 'second task — 日本語の確認' }, timestamp: '2026-06-19T12:00:02.000Z' }),
      ]
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  writeFileSync(join(PROJECTS, `${sid}.jsonl`), encodeFixtureTranscript(lines, sid))
}

function writeWorkflowFixtures(opts?: {
  longOut?: boolean
  settledChildren?: boolean
}): void {
  const runDirCompleted = join(WF_RUNS_ROOT, WF_RUN_COMPLETED)
  const runDirStale = join(WF_RUNS_ROOT, WF_RUN_STALE)
  const transcriptDir = join(runDirCompleted, 'transcripts')
  mkdirSync(transcriptDir, { recursive: true })
  mkdirSync(runDirStale, { recursive: true })

  const now = Date.now()
  const transcriptLines = [
    {
      type: 'user',
      message: {
        role: 'user',
        content:
          'Design the /substrate gate panel — schema, honest planned/gated states, the component contract.',
      },
      timestamp: new Date(now - 90_000).toISOString(),
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_fixture_1', model: 'claude-opus-4-8',
        content: [{
          type: 'tool_use', id: 'toolu_fixture_1', name: 'Read',
          input: { file_path: RUNTIME_CWD + '/src/components/SubstratePanel.tsx' },
        }],
        usage: { input_tokens: 120, output_tokens: 40 },
      },
      timestamp: new Date(now - 80_000).toISOString(),
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'toolu_fixture_1',
          content: [{ type: 'text', text: 'export function SubstratePanel() { /* … */ }' }],
        }],
      },
      timestamp: new Date(now - 79_000).toISOString(),
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_fixture_2', model: 'claude-opus-4-8',
        content: [{
          type: 'text',
          text:
            'Design complete — contract shipped, honest planned/gated states covered.' +
            (opts?.longOut
              ? '\n' +
                Array.from({ length: 14 }, (_, i) => `finding ${i + 1}: the gate panel row for state ${i + 1} verified against the schema contract`).join('\n')
              : ''),
        }],
        usage: { input_tokens: 140, output_tokens: 60 },
      },
      timestamp: new Date(now - 60_000).toISOString(),
    },
  ]
  writeFileSync(
    join(transcriptDir, `agent-${WF_FIXTURE_AGENT_ID}.jsonl`),
    encodeFixtureTranscript(transcriptLines as Record<string, unknown>[], SID),
  )

  const scriptPath = join(runDirCompleted, 'workflow.js')
  writeFileSync(
    scriptPath,
 "export const meta = { name: 'substrate-carried', description: 'fixture' }\nreturn 'ok'\n",
  )

  const completedManifest = {
    version: 1,
    runId: WF_RUN_COMPLETED,
 workflowName: 'substrate-carried',
    phases: [{ title: 'design' }, { title: 'build' }],
    scriptPath,
    transcriptDir,
    runDir: runDirCompleted,
    startTime: now - 120_000,
    endTime: now - 60_000,
    status: 'completed',
    ownerPid: process.pid,
    agentCount: 2,
    totalTokens: 29_700,
    usage: {
      inputTokens: 7_500, outputTokens: 4_700, cacheReadTokens: 89_000, cacheCreationTokens: 4_200,
      apiTurns: 20, unsettledTurns: 1, agentsReporting: 2, agentsUnreported: 0,
    },
    totalToolCalls: 19,
    agents: [
      {
        agentId: WF_FIXTURE_AGENT_ID, index: 0, label: 'design', state: 'done',
        phaseIndex: 1, phaseTitle: 'design', model: 'claude-opus-4-8', effort: 'high',
        tokens: 12_400, toolCalls: 9, durationMs: 45_000, attempt: 1,
        usage: { inputTokens: 3_400, outputTokens: 2_100, cacheReadTokens: 38_000, cacheCreationTokens: 1_900, apiTurns: 9, unsettledTurns: 0 },
        startedAt: now - 115_000, queuedAt: now - 120_000,
        promptPreview: 'Design the /substrate gate panel — schema, honest planned/gated states.',
        lastToolName: 'Read', lastToolSummary: 'src/components/SubstratePanel.tsx',
        resultPreview: 'Design complete — contract shipped, honest planned/gated states covered.',
      },
      {
        agentId: 'fxagentB', index: 1, label: 'build', state: 'done',
        phaseIndex: 2, phaseTitle: 'build', model: 'claude-opus-4-8',
        tokens: 17_300, toolCalls: 10, durationMs: 60_000, attempt: 1,
        usage: { inputTokens: 4_100, outputTokens: 2_600, cacheReadTokens: 51_000, cacheCreationTokens: 2_300, apiTurns: 11, unsettledTurns: 1 },
        startedAt: now - 110_000, queuedAt: now - 120_000,
        promptPreview: 'Build the panel per the shipped contract.',
        resultPreview: 'Panel built and render-verified at 80/120.',
      },
    ],
  }
  writeFileSync(join(runDirCompleted, 'run.json'), JSON.stringify(completedManifest))

  const staleManifest = {
    version: 1,
    runId: WF_RUN_STALE,
    workflowName: 'stale-drifter',
    phases: [{ title: 'scan' }],
    transcriptDir: join(runDirStale, 'transcripts'),
    runDir: runDirStale,
    startTime: now - 200_000,
    status: 'running',
    ownerPid: 999999,
    agentCount: 1,
    totalTokens: 4_200,
    totalToolCalls: 3,
    agents: [
      {
        agentId: 'fxagentC', index: 0, label: 'scan', state: 'progress',
        phaseIndex: 0, phaseTitle: 'scan', model: 'claude-opus-4-8',
        tokens: 4_200, toolCalls: 3, attempt: 1,
        waiting: 'provider-backoff', retryInMs: 45_000, retryAttempt: 2,
        lastProgressAt: now + 3_600_000,
      },
    ],
  }
  const staleManifestPath = join(runDirStale, 'run.json')
  writeFileSync(staleManifestPath, JSON.stringify(staleManifest))
  const old = new Date(now - 120_000)
  utimesSync(staleManifestPath, old, old)

  if (opts?.settledChildren) {
    const runDirPaused = join(WF_RUNS_ROOT, WF_RUN_PAUSED)
    mkdirSync(runDirPaused, { recursive: true })
    const pausedManifest = {
      version: 1,
      runId: WF_RUN_PAUSED,
      workflowName: 'harbor-sweep',
      phases: [{ title: 'sweep' }, { title: 'mend' }],
      transcriptDir: join(runDirPaused, 'transcripts'),
      runDir: runDirPaused,
      startTime: now - 300_000,
      endTime: now - 240_000,
      status: 'paused',
      ownerPid: process.pid,
      agentCount: 3,
      totalTokens: 8_100,
      totalToolCalls: 6,
      agents: [
        {
          agentId: 'fxagentD', index: 0, label: 'sweep-north', state: 'done',
          phaseIndex: 0, phaseTitle: 'sweep', model: 'claude-opus-4-8',
          tokens: 5_000, toolCalls: 4, durationMs: 30_000, attempt: 1,
          startedAt: now - 295_000, queuedAt: now - 300_000,
          promptPreview: 'Sweep the north shore.',
          resultPreview: 'North shore swept.',
        },
        {
          agentId: 'fxagentE', index: 1, label: 'sweep-south', state: 'stopped',
          phaseIndex: 0, phaseTitle: 'sweep', model: 'claude-opus-4-8',
          tokens: 2_100, toolCalls: 2, attempt: 1,
          startedAt: now - 290_000, queuedAt: now - 300_000,
          promptPreview: 'Sweep the south shore.',
        },
        {
          agentId: 'fxagentF', index: 2, label: 'mend-nets', state: 'skipped',
          phaseIndex: 1, phaseTitle: 'mend', model: 'claude-opus-4-8',
          tokens: 1_000, toolCalls: 0, durationMs: 5_000, attempt: 1,
          startedAt: now - 285_000, queuedAt: now - 300_000,
          promptPreview: 'Mend the nets.',
          error: 'skipped by user',
        },
      ],
    }
    writeFileSync(join(runDirPaused, 'run.json'), JSON.stringify(pausedManifest))
  }
}

function cleanupWorkflowFixtures(): void {
  for (const dir of [
    join(WF_RUNS_ROOT, WF_RUN_COMPLETED),
    join(WF_RUNS_ROOT, WF_RUN_STALE),
    join(WF_RUNS_ROOT, WF_RUN_PAUSED),
  ]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
    }
  }
}

function writeExternalWorkflowFixtures(): void {
  const now = Date.now()
  const seats: Array<{ runId: string; name: string; backdateMs: number }> = [
    { runId: WF_RUN_EXT_LIVE, name: 'external-drifter', backdateMs: 0 },
    { runId: WF_RUN_EXT_WEDGED, name: 'wedged-drifter', backdateMs: 120_000 },
  ]
  for (const { runId, name, backdateMs } of seats) {
    const runDir = join(WF_RUNS_ROOT, runId)
    mkdirSync(runDir, { recursive: true })
    const manifest = {
      version: 1,
      runId,
      workflowName: name,
      phases: [{ title: 'scan' }],
      transcriptDir: join(runDir, 'transcripts'),
      runDir,
      startTime: now - 300_000,
      status: 'running',
      ownerPid: process.pid,
      agentCount: 1,
      totalTokens: 5_100,
      totalToolCalls: 4,
      agents: [
        {
          agentId: `fxagent_${runId.slice(-4)}`, index: 0, label: 'scan', state: 'progress',
          phaseIndex: 0, phaseTitle: 'scan', model: 'claude-opus-4-8',
          tokens: 5_100, toolCalls: 4, attempt: 1,
        },
      ],
    }
    const manifestPath = join(runDir, 'run.json')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    if (backdateMs > 0) {
      const old = new Date(now - backdateMs)
      utimesSync(manifestPath, old, old)
    }
  }
}

function cleanupExternalWorkflowFixtures(): void {
  for (const dir of [join(WF_RUNS_ROOT, WF_RUN_EXT_LIVE), join(WF_RUNS_ROOT, WF_RUN_EXT_WEDGED)]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
    }
  }
}

let distFreshnessChecked = false
function assertFreshDist(): void {
  if (distFreshnessChecked) return
  distFreshnessChecked = true
  if (process.env.MERCURY_GATE_PREBUILT === '1' || process.env.MERCURY_STALE_DIST_OK === '1') return
  let declared: string | undefined
  try {
    declared = (JSON.parse(readFileSync(join(REPO, 'dist', 'manifest.json'), 'utf8')) as { buildTree?: string })
      .buildTree
  } catch {
    return
  }
  if (!declared) return
  let now = ''
  const idxDir = mkdtempSync(join(tmpdir(), 'dist-fresh-'))
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(idxDir, 'index') }
    execSync('git read-tree HEAD', { cwd: REPO, env, stdio: 'pipe' })
    execSync('git add -A', { cwd: REPO, env, stdio: 'pipe' })
    now = execSync('git write-tree', { cwd: REPO, env, stdio: 'pipe' }).toString().trim()
  } catch {
    return
  } finally {
    rmSync(idxDir, { recursive: true, force: true })
  }
  if (now && declared !== now) {
    const SAFE_DELTA = /^(docs\/|scripts\/|field\/|\.claude\/|\.mercury\/|\.github\/|[^/]+\.md$)/
    let changed: string[] | null = null
    try {
      changed = execSync(`git diff-tree -r --name-only ${declared} ${now}`, { cwd: REPO, stdio: 'pipe' })
        .toString()
        .split('\n')
        .filter(Boolean)
    } catch {
      changed = null
    }
    if (changed !== null && changed.length > 0 && changed.every(p => SAFE_DELTA.test(p))) return
    throw new Error(
      `STALE DIST: dist/mercury.mjs was built from tree ${declared.slice(0, 12)} but the working tree is now ${now.slice(0, 12)}` +
        (changed !== null && changed.length > 0
          ? ` (build-input delta: ${changed.filter(p => !SAFE_DELTA.test(p)).slice(0, 5).join(', ')})`
          : '') +
        '. A capture of this binary observes a different build than the source under verification. ' +
        'Rebuild (`bun run build.ts`), or set MERCURY_STALE_DIST_OK=1 to bind a historical dist deliberately.',
    )
  }
}

const accountsBoardStash = new Map<string, string | null>()
let accountsBoardEnvStash: {
  prevHome: string | undefined
  prevStore: string | undefined
  scratchHome: string | null
} | null = null

function stageAccountsBoardFile(name: string, contents: string | null): void {
  const path = join(CONFIG_HOME, name)
  if (!accountsBoardStash.has(path)) {
    let prior: string | null = null
    try {
      prior = readFileSync(path, 'utf8')
    } catch {
      prior = null
    }
    accountsBoardStash.set(path, prior)
  }
  if (contents === null) rmSync(path, { force: true })
  else writeFileSync(path, contents)
}

export function scenario(name: string, cols: number, rows: number) {
  assertFreshDist()
  return { cwd: RUNTIME_CWD, ...scenarioInner(name, cols, rows) }
}

function scenarioInner(name: string, cols: number, rows: number) {
  process.env.MERCURY_BOOT_PREFLIGHT = '0'
  process.env.TERM = 'xterm-256color'
  process.env.USER = 'sam'
  if (!process.env.MERCURY_OPERATOR && !process.env.MERCURY_OPERATOR) {
    process.env.MERCURY_OPERATOR = 'sam'
  }
  delete process.env.ANTHROPIC_API_KEY
  process.env.MERCURY_CREDENTIAL_STORE = process.env.MERCURY_CREDENTIAL_STORE ?? 'file'
  delete process.env.CI
  process.env.MERCURY_LIVE_GLYPHS = process.env.MERCURY_LIVE_GLYPHS ?? '0'
  process.env.MERCURY_CRITTER_GAZE = process.env.MERCURY_CRITTER_GAZE ?? '0'
  process.env.MERCURY_CRITTER_IDLE = process.env.MERCURY_CRITTER_IDLE ?? '0'
  process.env.MERCURY_CRITTER_SLEEP = process.env.MERCURY_CRITTER_SLEEP ?? '0'
  process.env.MERCURY_LIVE_CLOCK = process.env.MERCURY_LIVE_CLOCK ?? '0'
  process.env.MERCURY_DECK_COMPANION = process.env.MERCURY_DECK_COMPANION ?? '0'
  process.env.MERCURY_CC_COMPAT_INSTRUCTIONS = process.env.MERCURY_CC_COMPAT_INSTRUCTIONS ?? 'off'
  process.env.MERCURY_DOCTOR_STATE_DIR = join(tmpdir(), `mercury-render-doctor-${process.pid}`)
  process.env.MERCURY_DAEMON_DIR = join(tmpdir(), `mercury-render-daemon-${process.pid}`)
  process.env.MERCURY_TEAMS_DIR = join(tmpdir(), `mercury-render-teams-${process.pid}`)
  process.env.MERCURY_CREW_DIR = join(tmpdir(), `mercury-render-crew-${process.pid}`)
  process.env.MERCURY_TABULA_DIR = join(tmpdir(), `mercury-render-tabula-${process.pid}`)
  process.env.MERCURY_TABULA_MINERVA = '0'
  process.env.MERCURY_TURN_RECEIPT = '0'
  process.env.MERCURY_VERIFY_EVIDENCE = process.env.MERCURY_VERIFY_EVIDENCE ?? '0'
  process.env.MERCURY_HOME = join(tmpdir(), `mercury-render-home-${process.pid}`)
  process.env.MERCURY_CONFIG_DIR = process.env.MERCURY_CONFIG_DIR ?? CONFIG_HOME
  if (name === 'resume-2turn' || name === 'frame' || name === 'cockpit-wide' || name === 'cockpit-content') {
    writeSyntheticSession(name === 'cockpit-wide' ? 'long' : name === 'cockpit-content' ? 'content' : 'short')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'cockpit-wide-gpt') {
    writeSyntheticSession('long')
    writeFileSync(join(CONFIG_HOME, '.openai-auth.json'), JSON.stringify({
      version: 1,
      tokens: {
        idToken: '',
        accessToken: 'fixture-access',
        refreshToken: 'fixture-refresh',
        accountId: 'acct_fixture',
        planType: 'plus',
      },
    }))
    process.env.MERCURY_MODEL = 'gpt-5.6-sol'
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'usage-truth-signedout' || name === 'usage-truth-gpt-signedin') {
    writeSyntheticSession('short')
    if (name === 'usage-truth-gpt-signedin') {
      writeFileSync(join(CONFIG_HOME, '.openai-auth.json'), JSON.stringify({
        version: 1,
        tokens: {
          idToken: '',
          accessToken: 'fixture-access',
          refreshToken: 'fixture-refresh',
          accountId: 'acct_fixture',
          planType: 'plus',
        },
      }))
      process.env.MERCURY_MODEL = 'gpt-5.6-sol'
    }
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, awaitText: '❯', minTick: 5, data: '/usage' },
        { afterPrevTicks: 3, data: '\r' },
        { atTick: 80, awaitText: 'Anthropic usage', minTick: 10, awaitSettleTicks: 2, data: '' },
      ],
      total: 100,
      cols,
      rows,
    }
  }
  if (name === 'cockpit-band-98' || name === 'cockpit-band-96') {
    writeSyntheticSession('short')
    const resizes =
      name === 'cockpit-band-98'
        ? [{ atTick: 45, cols: 98, rows }]
        : [{ atTick: 45, cols: 98, rows }, { atTick: 60, cols: 96, rows }]
    return { argv: ['node', BIN, '--resume', SID], sends: [], resizes, total: name === 'cockpit-band-98' ? 70 : 85, cols, rows }
  }
  if (name === 'resize-return') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [],
      resizes: [
        { atTick: 45, cols: 80, rows: 30 },
        { atTick: 60, cols: 45, rows: 20 },
        { atTick: 75, cols: 150, rows: 50 },
        { atTick: 90, cols: cols, rows: rows },
      ],
      total: 120,
      cols, rows,
    }
  }
  if (name === 'cockpit-link' || name === 'cockpit-link-resize') {
    process.env.TERM_PROGRAM = 'iTerm.app'
    writeSyntheticSession('link')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [],
      ...(name === 'cockpit-link-resize'
        ? {
            resizes: [
              { atTick: 50, cols: 100, rows: 40 },
              { atTick: 65, cols: cols, rows: rows },
            ],
            total: 90,
          }
        : { total: 45 }),
      cols, rows,
    }
  }
  if (name === 'bang-dialog-survives' || name === 'bang-dialog-closed') {
    const closed = name === 'bang-dialog-closed'
    return {
      argv: ['node', BIN],
      sends: [
        { atTick: 30, data: '!sleep 4\r' },
        { atTick: 36, data: '/model\r' },
        ...(closed ? [{ atTick: 70, data: '\u001b' }] : []),
      ],
      total: closed ? 85 : 75,
      cols,
      rows,
    }
  }
  if (name === 'markdown-blocks') {
    writeSyntheticSession('markdown-blocks')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'shell-interleave') {
    writeSyntheticSession('shell-interleave')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'turn-receipt') {
    process.env.MERCURY_TURN_RECEIPT = '1'
    writeSyntheticSession('tools')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'stream-fault-recovered') {
    writeSyntheticSession('stream-fault')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'thinking-row') {
    writeSyntheticSession('thinking')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'fork-boilerplate') {
    writeSyntheticSession('fork')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'channel-message') {
    writeSyntheticSession('channel')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'harness-chip' || name === 'harness-view') {
    process.env.MERCURY_HARNESS_PROFILE = 'on'
    writeSyntheticSession('short')
    return name === 'harness-chip'
      ? { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
      : {
          argv: ['node', BIN, '--resume', SID],
          sends: [{ atTick: 30, data: '/harness\r' }],
          total: 60,
          cols,
          rows,
        }
  }
  if (name === 'model-switch-home') {
    writeSyntheticSession('model-noise')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'submodels-home') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/submodels\r' }],
      total: 62,
      cols,
      rows,
    }
  }
  if (name === 'submodels-journey') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/submodels\r' },
        { afterPrevTicks: 8, data: '\t', mark: 'opened' },
        { afterPrevTicks: 4, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B', mark: 'walked' },
        { afterPrevTicks: 4, data: '\r', mark: 'pre-route' },
        { afterPrevTicks: 22, data: '\u001b', mark: 'at-logins' },
      ],
      total: 130,
      cols,
      rows,
    }
  }
  if (name === 'model-picker-home') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/model\r' }],
      total: 60,
      cols,
      rows,
    }
  }
  if (
    name === 'model-picker-gpt' ||
    name === 'model-picker-gpt-signin' ||
    name === 'model-picker-gpt-toggle' ||
    name === 'submodels-gpt' ||
    name === 'submodels-signedout'
  ) {
    delete process.env.OPENAI_API_KEY
    if (name === 'model-picker-gpt-signin' || name === 'submodels-signedout') {
      const scratch = mkdtempSync(join(tmpdir(), 'mercury-render-gpt-signin-'))
      seedFirstRun(scratch, [RUNTIME_CWD])
      applyRenderTheme(scratch)
      process.env.MERCURY_CONFIG_DIR = scratch
      process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
      return {
        argv: ['node', BIN],
        sends: [{ atTick: 30, data: name === 'submodels-signedout' ? '/submodels\r' : '/model\r' }],
        total: 60,
        cols,
        rows,
      }
    }
    writeSyntheticSession('short')
    {
      const port = 47716
      try {
        const stale = Number(readFileSync(join(tmpdir(), 'mercury-render-gpt-fixture.pid'), 'utf8').trim())
        if (Number.isFinite(stale) && stale > 1) process.kill(stale)
      } catch {
      }
      const fixtureBody = JSON.stringify({
        data: [
          { id: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high'] },
          { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'], context_window: 272000, max_context_window: 872000 },
          { id: 'gpt-5.2-orbit', display_name: 'GPT-5.2 Orbit', visibility: 'list', priority: 3, supported_reasoning_levels: ['low'] },
          { id: 'gpt-5.7-ghost', display_name: 'hidden', visibility: 'hide', priority: 0, supported_reasoning_levels: ['low'] },
        ],
      })
      const serverJs = `const http=require('http');const body=${JSON.stringify(fixtureBody)};http.createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end(body)}).listen(${port},'127.0.0.1')`
      const child = spawn('node', ['-e', serverJs], { detached: true, stdio: 'ignore' })
      child.unref()
      writeFileSync(join(tmpdir(), 'mercury-render-gpt-fixture.pid'), String(child.pid ?? ''))
      execSync(
        `sh -c 'i=0; while [ $i -lt 40 ]; do curl -s -m 1 http://127.0.0.1:${port}/models > /dev/null && exit 0; i=$((i+1)); sleep 0.25; done; echo "gpt fixture server never became ready" >&2; exit 7'`,
      )
      process.env.OPENAI_API_KEY = 'render-fixture-key'
      process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${port}`
      process.env.MERCURY_OPENAI_CHATGPT_BASE = `http://127.0.0.1:${port}`
      process.env.MERCURY_OPENAI_AUTH_BASE = `http://127.0.0.1:${port}`
    }
    if (name === 'model-picker-gpt-toggle') {
      return {
        argv: ['node', BIN, '--resume', SID],
        sends: [
          { atTick: 30, data: '/model\r' },
          { atTick: 40, awaitText: 'CHOOSE A MODEL', requireAwait: true, awaitSettleTicks: 3, data: '\u001b[H' },
          { atTick: 64, data: 'c' },
        ],
        total: 78,
        cols,
        rows,
      }
    }
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: name === 'submodels-gpt' ? '/submodels\r' : '/model\r' }],
      total: 60,
      cols,
      rows,
    }
  }
  if (name === 'effort-slider-sonnet46') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--model', 'claude-sonnet-4-6', '--resume', SID],
      sends: [{ atTick: 30, data: '/effort\r' }],
      total: 60,
      cols,
      rows,
    }
  }
  if (name === 'model-picker-sonnet46') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--model', 'claude-sonnet-4-6', '--resume', SID],
      sends: [{ atTick: 30, data: '/model\r' }],
      total: 60,
      cols,
      rows,
    }
  }
  if (name === 'transition-queued-journey' || name === 'transition-queued-settled') {
    writeSyntheticSession('gpt-record')
    return {
      requiresEnv: { MERCURY_SCRIPTED_STREAM: 'slow-text' },
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: 'work through the release notes\r' },
        { atTick: 45, data: '\u001b[112;3u' },
        { atTick: 50, data: '\u001b[B' },
        { atTick: 52, data: '\r' },
        { atTick: 60, data: '\r' },
      ],
      total: name === 'transition-queued-settled' ? 110 : 66,
      cols,
      rows,
    }
  }
  if (name === 'timeline-actions') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/rewind\r' },
        { atTick: 40, data: '\u001b[A' },
        { atTick: 44, data: '\r' },
      ],
      total: 64,
      cols,
      rows,
    }
  }
  if (name === 'transition-preview-card') {
    writeSyntheticSession('gpt-record')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/model sonnet\r' }],
      total: 60,
      cols,
      rows,
    }
  }
  if (name === 'cap-journey-live') {
    return {
      argv: ['node', BIN],
      sends: [
        { atTick: 40, awaitText: 'for commands', minTick: 10, awaitSettleTicks: 2, data: '/mock-limits warning-7d\r', mark: 'seam' },
        { atTick: 90, awaitText: 'Anthropic usage window', minTick: 4, awaitSettleTicks: 2, data: '\r', mark: 'offer-accept' },
        { atTick: 140, awaitText: 'Model set to gpt-5.6', minTick: 4, awaitSettleTicks: 2, data: 'Reply with exactly: OK-GPT-JOURNEY\r', mark: 'gpt-turn' },
        { atTick: 260, awaitText: 'OK-GPT-JOURNEY', minTick: 10, awaitSettleTicks: 3, data: '/mock-limits clear\r', mark: 'reset' },
        { atTick: 300, awaitText: 'window reset', minTick: 4, awaitSettleTicks: 2, data: '\r', mark: 'home-accept' },
        { atTick: 340, awaitText: 'Model switch preview', minTick: 4, awaitSettleTicks: 2, data: '\r', mark: 'preview-confirm' },
        { atTick: 380, awaitText: 'Model switched', minTick: 4, awaitSettleTicks: 2, data: 'Reply with exactly: OK-HOME\r', mark: 'claude-turn' },
        { atTick: 560, awaitText: 'OK-HOME', minTick: 10, awaitSettleTicks: 3, data: '', mark: 'done' },
      ],
      total: 580,
      cols,
      rows,
    }
  }
  if (name === 'trim-chip-armed' || name === 'trim-chip-calm' || name === 'init-signpost') {
    const scratch =
      process.env.MERCURY_RENDER_INSTRESTATE_DIR ||
      join(tmpdir(), `mercury-render-instrestate-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    const project = join(scratch, 'project')
    mkdirSync(project, { recursive: true })
    execSync('git init -q', { cwd: project })
    if (name === 'trim-chip-armed') {
      writeFileSync(
        join(project, 'MERCURY.md'),
        '@AGENTS.md\nThe guide is AGENTS.md; this file only points at it.\nSee the guide.\n',
      )
      writeFileSync(
        join(project, 'AGENTS.md'),
        Array.from({ length: 600 }, (_, i) => `guide line ${i}`).join('\n') + '\n',
      )
    } else if (name === 'trim-chip-calm') {
      writeFileSync(
        join(project, 'MERCURY.md'),
        Array.from({ length: 399 }, (_, i) => `entry line ${i}`).join('\n') + '\n',
      )
    } else {
      process.env.MERCURY_BOOT_PREFLIGHT = '1'
    }
    writeFileSync(join(project, 'README.md'), 'fixture project\n')
    execSync('git add -A && git -c user.email=fix@x -c user.name=fix commit -qm seed', { cwd: project })
    seedFirstRun(scratch, [project])
    applyRenderTheme(scratch)
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    return { argv: ['node', BIN], sends: [], total: 45, cols, rows, cwd: project }
  }
  if (name === 'entry-provider') {
    return { argv: ['node', BIN], sends: [{ atTick: 30, data: '\r' }], total: 55, cols, rows }
  }
  if (name === 'concourse') {
    const scratch = join(tmpdir(), `mercury-render-concourse-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    const fixture = referenceFixtureSnapshot()
    for (const g of fixture.groups) {
      for (const r of g.rows) r.workspaceDir = scratch
    }
    const fixturePath = join(scratch, 'concourse-fixture.json')
    writeFileSync(fixturePath, JSON.stringify(fixture))
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_CONCOURSE = 'always'
    process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
    return {
      argv: ['node', BIN],
      sends: [],
      total: 60,
      cols,
      rows,
      chromeMarkers: ['❯', '╭', '│', '╰', 'terminal too small'],
    }
  }
  if (name === 'surface-chord-retired' || name === 'surface-chord-retired-back') {
    const scratch = join(tmpdir(), `mercury-render-surface-chord-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    const fixture = referenceFixtureSnapshot()
    for (const g of fixture.groups) {
      for (const r of g.rows) r.workspaceDir = scratch
    }
    fixture.groups.push({
      id: 'stopped',
      label: 'STOPPED',
      rows: [
        {
          sessionId: 'sess-retired-empty',
          title: 'scratch session',
          state: 'stopped',
          projectLabel: 'orchard',
          ownerLabel: 'Mercury',
          ageLabel: '41m',
          seats: null,
          nowLabel: 'retired — empty and idle for 31m',
          workspaceDir: scratch,
        } as never,
      ],
    } as never)
    const fixturePath = join(scratch, 'concourse-fixture.json')
    writeFileSync(fixturePath, JSON.stringify(fixture))
    process.env.MERCURY_CONFIG_DIR = scratch
    delete process.env.MERCURY_CONCOURSE
    process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
    const back = name === 'surface-chord-retired-back'
    return {
      argv: ['node', BIN],
      sends: [
        { atTick: 32, data: '\u001b[1;2C' },
        { atTick: 42, data: 'n' },
        ...(back ? [{ atTick: 62, data: '\u001b[1;2D' }] : []),
      ],
      total: back ? 88 : 64,
      cols,
      rows,
      chromeMarkers: ['❯', '╭', '│', '╰', 'terminal too small', '↵ start'],
    }
  }
  if (name === 'concourse-burst-arrows' || name === 'concourse-burst-arrows-discrete' || name === 'concourse-burst-type' || name === 'concourse-tab-probe') {
    const scratch = join(tmpdir(), `mercury-render-${name}-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    const fixture = referenceFixtureSnapshot()
    const fixturePath = join(scratch, 'concourse-fixture.json')
    writeFileSync(fixturePath, JSON.stringify(fixture))
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_CONCOURSE = 'always'
    process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
    const settle = { atTick: 999, awaitText: 'Fix OAuth callback', minTick: 5, awaitSettleTicks: 2 }
    const DOWN = '\u001b[B'
    const sends =
      name === 'concourse-burst-arrows'
        ? [{ ...settle, data: DOWN.repeat(5) }]
        : name === 'concourse-burst-arrows-discrete'
          ? [
              { ...settle, data: DOWN },
              { afterPrevTicks: 4, data: DOWN },
              { afterPrevTicks: 4, data: DOWN },
              { afterPrevTicks: 4, data: DOWN },
              { afterPrevTicks: 4, data: DOWN },
            ]
          : name === 'concourse-burst-type'
            ? [
                { ...settle, data: 'n' },
                { afterPrevTicks: 6, data: 'burst sixteen ch' },
              ]
            : [{ ...settle, data: '\t' }]
    return {
      argv: ['node', BIN],
      sends,
      total: 90,
      cols,
      rows,
      chromeMarkers: ['❯', '╭', '│', '╰', 'terminal too small'],
    }
  }
  if (name === 'coordinator-truth') {
    const scratch = join(tmpdir(), `mercury-render-coordinator-truth-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    {
      const cfgPath = join(scratch, '.mercury.json')
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
      cfg['concourseCoordinator'] = { mode: 'agent-assisted', assistModel: 'claude-opus-5' }
      writeFileSync(cfgPath, JSON.stringify(cfg))
    }
    const fixture = referenceFixtureSnapshot()
    for (const g of fixture.groups) {
      for (const r of g.rows) r.workspaceDir = scratch
    }
    fixture.coordinator = { mode: 'agent-assisted', assistModelLabel: 'Opus 5' }
    const fixturePath = join(scratch, 'concourse-fixture.json')
    writeFileSync(fixturePath, JSON.stringify(fixture))
    const ts = 1754000000000
    writeFileSync(
      join(scratch, 'coordinator-conversation.json'),
      JSON.stringify(
        {
          entries: [
            { id: 'op:1', role: 'operator', text: 'what model are you running on?', ts },
            {
              id: 'co:1',
              role: 'coordinator',
              text: 'Mercury, running on `claude-opus-5` (Opus 5) — that is the engine this seat dispatches on.',
              ts: ts + 1000,
            },
            { id: 'op:2', role: 'operator', text: 'start one on the parser', ts: ts + 2000 },
            {
              id: 'co:2',
              role: 'coordinator',
              text: 'Started it.',
              ts: ts + 3000,
              receipts: [{ verb: 'session.launch', outcome: 'applied', label: 'launch session 3f2a1b2c: applied — "parser rewrite" · on Opus 5 · starting' }],
            },
            { id: 'op:3', role: 'operator', text: 'and the docs half?', ts: ts + 4000 },
            {
              id: 'co:3',
              role: 'coordinator',
              text: 'The turn did not run: coordinator turn failed — Not logged in · Please run /logins.',
              ts: ts + 5000,
              harness: true,
            },
          ],
          _v: 1,
        },
        null,
        2,
      ) + '\n',
    )
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_CONCOURSE = 'always'
    process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
    return {
      argv: ['node', BIN],
      sends: [],
      total: 60,
      cols,
      rows,
      chromeMarkers: ['❯', '╭', '│', '╰', 'terminal too small'],
    }
  }
  if (name === 'concourse-picker') {
    const scratch = join(tmpdir(), `mercury-render-concourse-picker-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    {
      const cfgPath = join(scratch, '.mercury.json')
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
      writeFileSync(cfgPath, JSON.stringify(cfg))
    }
    const fixture = referenceFixtureSnapshot()
    const fixturePath = join(scratch, 'concourse-fixture.json')
    writeFileSync(fixturePath, JSON.stringify(fixture))
    writeFileSync(
      join(scratch, '.apex-qualification.json'),
      JSON.stringify(
        {
          version: 1,
          receipts: [
            {
              modelId: 'gpt-5.6-sol',
              role: 'coordinator',
              sourceKind: 'subscription',
              adapterDigest: 'seed',
              architectureEpoch: 'seed',
              roleCapabilityDigest: 'seed',
              qualifiedAtMs: 1754000000000,
            },
          ],
        },
        null,
        2,
      ) + '\n',
    )
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_CONCOURSE = 'always'
    process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
    return {
      argv: ['node', BIN],
      sends: [
        { data: '\x13', requireAwait: true, awaitText: 'seats', awaitSettleTicks: 2, awaitStableTicks: 2 },
      ],
      total: 72,
      cols,
      rows,
    }
  }
  if (name === 'concourse-picker-operator' || name === 'concourse-picker-operator-pick') {
    const scratch = join(tmpdir(), `mercury-render-concourse-picker-operator-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    {
      const cfgPath = join(scratch, '.mercury.json')
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
      if (name === 'concourse-picker-operator-pick') {
        cfg['concourseCoordinator'] = { mode: 'agent-assisted', assistModel: 'claude-opus-5' }
      }
      writeFileSync(cfgPath, JSON.stringify(cfg))
    }
    const fixture = referenceFixtureSnapshot()
    if (name === 'concourse-picker-operator-pick') {
      fixture.coordinator = {
        mode: 'agent-assisted',
        assistModelLabel: 'Opus 5',
        assistModelAvailability: 'not-signed-in',
        assistModelStatus: 'not signed in — /logins anthropic',
      }
    }
    const fixturePath = join(scratch, 'concourse-fixture.json')
    writeFileSync(fixturePath, JSON.stringify(fixture))
    writeFileSync(
      join(scratch, '.openai-auth.json'),
      JSON.stringify({
        version: 1,
        tokens: {
          idToken: '',
          accessToken: 'fixture-access',
          refreshToken: 'fixture-refresh',
          accountId: 'acct_fixture',
          planType: 'plus',
        },
      }),
    )
    writeFileSync(
      join(scratch, '.apex-qualification.json'),
      JSON.stringify(
        {
          version: 1,
          receipts: [
            {
              modelId: 'gpt-5.6-sol',
              role: 'primary',
              sourceKind: 'chatgpt-subscription',
              adapterDigest: 'seed',
              architectureEpoch: 'seed',
              roleCapabilityDigest: 'seed',
              qualifiedAtMs: 1754000000000,
            },
          ],
        },
        null,
        2,
      ) + '\n',
    )
    const osHome = join(scratch, 'os-home')
    mkdirSync(osHome, { recursive: true })
    process.env.HOME = osHome
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY']) {
      delete process.env[key]
    }
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
    process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
    process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9'
    process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:9'
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_CONCOURSE = 'always'
    process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
    const open = { data: '\x13', requireAwait: true, awaitText: 'seats', awaitSettleTicks: 2, awaitStableTicks: 2 }
    return {
      argv: ['node', BIN],
      sends:
        name === 'concourse-picker-operator'
          ? [open]
          : [
              open,
              { data: 'sol', requireAwait: true, awaitText: '↵ selects', awaitSettleTicks: 2 },
              { afterPrevTicks: 4, data: '\x1b[B' },
              { afterPrevTicks: 3, data: '\r' },
            ],
      total: name === 'concourse-picker-operator' ? 72 : 110,
      cols,
      rows,
    }
  }
  if (name === 'concourse-coordinator-conversation') {
    const scratch = join(tmpdir(), `mercury-render-concourse-coordinator-conversation-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    {
      const cfgPath = join(scratch, '.mercury.json')
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
      cfg['concourseCoordinator'] = { mode: 'agent-assisted', assistModel: 'gpt-5.6-sol' }
      writeFileSync(cfgPath, JSON.stringify(cfg))
    }
    const fixture = referenceFixtureSnapshot()
    fixture.coordinator = { mode: 'agent-assisted', assistModelLabel: 'GPT-5.6 Sol' }
    const fixturePath = join(scratch, 'concourse-fixture.json')
    writeFileSync(fixturePath, JSON.stringify(fixture))
    const t0 = 1754000000000
    const longReply = [
      'Three sessions are working and one waits on you.',
      '',
      '- **Fix OAuth callback** is mid-turn on Moodle, editing src/auth/callback.ts.',
      '- **Refactor parser** runs the parser tests on orchard-src; no failures so far.',
      '- **Update terminal resize** is rebuilding its fixture after the resize fix.',
      '- **Audit billing receipts** finished its last turn and is idle — ready for your review.',
      '',
      'Migration plan is the one waiting: it asks which schema migration order to use.',
      'Answer it from the needs-you band, or tell me the order and I will pass it on.',
      '',
      'Nothing else needs you right now.',
    ].join('\n')
    writeFileSync(
      join(scratch, 'coordinator-conversation.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'op-1', role: 'operator', text: 'pause the parser session and launch one more on Moodle', ts: t0 },
          {
            id: 'co-1',
            role: 'coordinator',
            text: 'Paused Refactor parser. The Moodle launch did not land — every seat is taken; it queues until one frees.',
            ts: t0 + 4000,
            receipts: [
              { verb: 'session.pause', outcome: 'applied', label: 'pause Refactor parser · applied · 3f2a9c1e…' },
              {
                verb: 'session.launch',
                outcome: 'refused',
                label:
                  'launch "Moodle follow-up" refused — every seat is taken (5/5); the ask queues and starts when a seat frees · 7b0d44e2…',
              },
            ],
          },
          { id: 'op-2', role: 'operator', text: 'what needs me right now?', ts: t0 + 60000 },
          { id: 'co-2', role: 'coordinator', text: longReply, ts: t0 + 64000 },
        ],
      }),
    )
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_CONCOURSE = 'always'
    process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
    return {
      argv: ['node', BIN],
      sends: [],
      total: 60,
      cols,
      rows,
      chromeMarkers: ['❯', '╭', '│', '╰', 'terminal too small'],
    }
  }
  if (name === 'console-open' || name === 'console-ask-dead-wire') {
    writeSyntheticSession('short')
    writeFileSync(join(CONFIG_HOME, '.openai-auth.json'), JSON.stringify({
      version: 1,
      tokens: {
        idToken: '',
        accessToken: 'fixture-access',
        refreshToken: 'fixture-refresh',
        accountId: 'acct_fixture',
        planType: 'plus',
      },
    }))
    process.env.MERCURY_MODEL = 'gpt-5.6-sol'
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
    process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
    process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9'
    process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:9'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: name === 'console-open' ? '/console' : '/console what does this repository do, in two sentences?' },
        { atTick: 36, data: '\r' },
      ],
      total: name === 'console-open' ? 80 : 140,
      cols,
      rows,
    }
  }
  if (name === 'concourse-hostile') {
    const scratch = join(tmpdir(), `mercury-render-concourse-hostile-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    const fixture = referenceFixtureSnapshot() as {
      groups: Array<{ rows: Array<Record<string, unknown>> }>
      peek: Record<string, unknown>
    }
    const working = fixture.groups[1]!
    working.rows[0]!['title'] = 'Fix \u001b[31mOAuth\u0007 callback'
    working.rows[1]!['title'] = 'Refactor the parser across every module boundary the workspace has ever declared including the deep vendored trees'
    working.rows[2]!['title'] = '端末リサイズの試験を更新する — wide glyphs'
    fixture.peek['title'] = 'Fix \u001b[31mOAuth\u0007 callback'
    const fixturePath = join(scratch, 'concourse-fixture.json')
    writeFileSync(fixturePath, JSON.stringify(fixture))
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_CONCOURSE = 'always'
    process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
    return { argv: ['node', BIN], sends: [], total: 60, cols, rows }
  }
  if (name === 'boot-settings') {
    const scratch = join(tmpdir(), `mercury-render-bootmenu-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    const bootEnv = join(scratch, 'boot-env.json')
    saveBootDefaultsProfile({ MERCURY_HELM_HOME: '0' }, bootEnv)
    saveBootDefaultsProfile({ MERCURY_HELM_HOME: '0', MERCURY_CACHE_TTL: '1h' }, bootEnv)
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    return {
      argv: ['node', BIN],
      sends: [
        { atTick: 40, awaitText: 'Doctor / Health Check', minTick: 20, awaitSettleTicks: 2, data: 'm', mark: 'open' },
        { atTick: 60, awaitText: 'boot menu', minTick: 30, awaitSettleTicks: 2, data: '' },
      ],
      total: 85,
      cols,
      rows,
    }
  }
  if (name === 'boot-face') {
    const scratch = join(tmpdir(), `mercury-render-bootface-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    return {
      argv: ['node', BIN],
      sends: [
        { atTick: 40, awaitText: 'Doctor / Health Check', minTick: 20, awaitSettleTicks: 2, mark: 'face', data: '' },
      ],
      total: 60,
      cols,
      rows,
    }
  }
  if (name === 'boot-kit-menu') {
    const scratch = join(tmpdir(), `mercury-render-bootkit-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    return {
      argv: ['node', BIN],
      sends: [
        { atTick: 40, awaitText: 'MCPs & Skills', minTick: 20, awaitSettleTicks: 2, mark: 'face', data: '\u001b[B\u001b[B' },
        { afterPrevTicks: 4, data: '\r' },
        { atTick: 80, awaitText: 'mcps & skills', minTick: 50, awaitSettleTicks: 2, mark: 'kit', data: '' },
      ],
      total: 100,
      cols,
      rows,
    }
  }
  if (name === 'cap-offer-card' || name === 'cap-offer-rejected') {
    const trigger =
      name === 'cap-offer-rejected' ? '/mock-limits weekly-limit-reached\r' : '/mock-limits warning-7d\r'
    return {
      argv: ['node', BIN],
      sends: [{ atTick: 30, data: trigger }],
      total: 60,
      cols,
      rows,
    }
  }
  if (name === 'workflow-inline' || name === 'workflow-inline-detail') {
    writeSyntheticSession('workflow')
    const sends =
      name === 'workflow-inline-detail' ? [{ atTick: 38, data: String.fromCharCode(15) }] : []
    return {
      argv: ['node', BIN, '--resume', SID],
      sends,
      total: name === 'workflow-inline-detail' ? 60 : 48,
      cols, rows,
    }
  }
  if (name === 'tool-cards' || name === 'tool-cards-detail') {
    writeSyntheticSession('tools')
    const sends =
      name === 'tool-cards-detail' ? [{ atTick: 38, data: String.fromCharCode(15) }] : []
    return { argv: ['node', BIN, '--resume', SID], sends, total: name === 'tool-cards-detail' ? 60 : 45, cols, rows }
  }
  if (name === 'changeset-card' || name === 'changeset-card-detail') {
    writeSyntheticSession('changeset')
    const sends =
      name === 'changeset-card-detail' ? [{ atTick: 38, data: String.fromCharCode(15) }] : []
    return { argv: ['node', BIN, '--resume', SID], sends, total: name === 'changeset-card-detail' ? 60 : 45, cols, rows }
  }
  if (name === 'nochange-cards') {
    writeSyntheticSession('stillpoint')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'structure-card' || name === 'structure-card-detail') {
    writeSyntheticSession('structure')
    const sends =
      name === 'structure-card-detail' ? [{ atTick: 38, data: String.fromCharCode(15) }] : []
    return { argv: ['node', BIN, '--resume', SID], sends, total: name === 'structure-card-detail' ? 60 : 45, cols, rows }
  }
  if (name === 'errors-transcript') {
    writeSyntheticSession('errors')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 48, cols, rows }
  }
  if (name === 'denied-transcript') {
    writeSyntheticSession('denials')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 48, cols, rows }
  }
  if (name === 'cockpit-mission') {
    writeSyntheticSession('short')
    const LONG_MISSION =
      'Run a targeted, system-wide bug audit and a full UI/UX refinement and hardening pass across every cockpit surface using the dynamic workflow engine'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 40, data: `/mission ${LONG_MISSION}` },
        { atTick: 62, data: '\r' },
      ],
      total: 96,
      cols,
      rows,
    }
  }
  if (name === 'run-inspector') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 40, data: '/run' },
        { atTick: 56, data: '\r' },
      ],
      total: 84,
      cols,
      rows,
    }
  }
  if (name === 'context-plan') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 40, data: '/context' },
        { atTick: 56, data: '\r' },
      ],
      total: 96,
      cols,
      rows,
    }
  }
  if (name === 'substrate-board' || name === 'deck-board' || name === 'trace-board') {
    writeSyntheticSession('short')
    const cmd =
      name === 'substrate-board' ? '/substrate' : name === 'deck-board' ? '/deck' : '/trace'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 40, data: cmd },
        { atTick: 56, data: '\r' },
      ],
      total: 96,
      cols,
      rows,
    }
  }
  if (name === 'context-gpt') {
    writeSyntheticSession('short')
    writeFileSync(join(CONFIG_HOME, '.openai-auth.json'), JSON.stringify({
      version: 1,
      tokens: {
        idToken: '',
        accessToken: 'fixture-access',
        refreshToken: 'fixture-refresh',
        accountId: 'acct_fixture',
        planType: 'plus',
      },
    }))
    process.env.MERCURY_MODEL = 'gpt-5.6-sol'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 40, data: '/context' },
        { atTick: 56, data: '\r' },
      ],
      total: 96,
      cols,
      rows,
    }
  }
  if (name === 'context-claude') {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
    writeSyntheticSession('short')
    stageAccountsBoardFile(
      '.credentials.json',
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fixture-claude-access',
          refreshToken: 'fixture-claude-refresh',
          expiresAt: Date.now() + 86_400_000,
          scopes: ['user:inference'],
          subscriptionType: 'max',
          rateLimitTier: null,
        },
      }),
    )
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 40, data: '/context' },
        { atTick: 56, data: '\r' },
      ],
      total: 96,
      cols,
      rows,
    }
  }
  if (name === 'context-loggedout') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 40, data: '/context' },
        { atTick: 56, data: '\r' },
      ],
      total: 96,
      cols,
      rows,
    }
  }
  if (name === 'resume-picker') {
    writeSyntheticSession('tools')
    writeSyntheticSession('errors', SID_ERRORED)
    return { argv: ['node', BIN, '--resume'], sends: [], total: 60, cols, rows }
  }
  if (name === 'cockpit-focus' || name === 'cockpit-drill') {
    writeSyntheticSession('short')
    const TAB = String.fromCharCode(9)
    const DOWN = String.fromCharCode(27) + '[B'
    const sends =
      name === 'cockpit-focus'
        ? [{ atTick: 30, data: TAB }]
        : [
            { atTick: 30, data: TAB },
            { atTick: 34, data: TAB },
            { atTick: 38, data: DOWN },
            { atTick: 41, data: DOWN },
            { atTick: 44, data: '\r' },
          ]
    return {
      argv: ['node', BIN, '--resume', SID],
      sends,
      total: name === 'cockpit-focus' ? 48 : 62,
      cols,
      rows,
    }
  }
  if (name === 'cockpit-runs') {
    writeSyntheticSession('short')
    const CTRL_B = String.fromCharCode(2)
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 40, data: '!sleep 300' },
        { atTick: 46, data: '\r' },
        { atTick: 68, data: CTRL_B },
      ],
      total: 92,
      cols,
      rows,
    }
  }
  if (name === 'cockpit-runs-drill' || name === 'cockpit-runs-drill-esc') {
    writeSyntheticSession('short')
    const CTRL_B = String.fromCharCode(2)
    const TAB = String.fromCharCode(9)
    const DOWN = String.fromCharCode(27) + '[B'
    const ESC = String.fromCharCode(27)
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 40, data: '!sleep 300' },
        { atTick: 46, data: '\r' },
        { atTick: 68, data: CTRL_B },
        { atTick: 78, data: TAB },
        { atTick: 82, data: DOWN },
        { atTick: 86, data: '\r' },
        ...(name === 'cockpit-runs-drill-esc' ? [{ atTick: 100, data: ESC }] : []),
      ],
      total: name === 'cockpit-runs-drill-esc' ? 116 : 104,
      cols,
      rows,
    }
  }
  if (name === 'cockpit-console') {
    writeSyntheticSession('short')
    writeMissionLedgerFixture()
    process.env.MERCURY_TASK_LIST_ID = MISSION_FIXTURE_LIST
    const TAB = String.fromCharCode(9)
    const DOWN = String.fromCharCode(27) + '[B'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: TAB },
        { atTick: 34, data: TAB },
        { atTick: 38, data: DOWN.repeat(30) },
        { atTick: 44, data: 'what changed here' },
      ],
      total: 62,
      cols,
      rows,
    }
  }
  if (name === 'transcript-overlay') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: String.fromCharCode(15) }],
      total: 46, cols, rows,
    }
  }
  if (name === 'help') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '?' }],
      total: 46, cols, rows,
    }
  }
  if (name === 'help-commands') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 44, data: '/help' },
        { atTick: 54, data: '\r' },
        { atTick: 76, data: '\t' },
      ],
      total: 108, cols, rows,
      chromeMarkers: ['Browse default commands', '▔'],
    }
  }
  if (name === 'queue-view') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 44, data: '/queue' },
        { atTick: 54, data: '\r' },
      ],
      total: 100, cols, rows,
      chromeMarkers: ['background queue', 'Run targets'],
    }
  }
  if (name === 'clipband-probe') {
    writeSyntheticSession('short')
    const ESC_ = String.fromCharCode(27)
    const sgr = (b: number, c: number, r: number, up = false): string =>
      `${ESC_}[<${b};${c};${r}${up ? 'm' : 'M'}`
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 34, data: sgr(0, 30, 26) },
        { atTick: 37, data: sgr(32, 30, 27) },
        { atTick: 40, data: sgr(32, 30, 28) },
        { atTick: 43, data: sgr(32, 30, 30) },
        { atTick: 46, data: sgr(0, 30, 30, true) },
      ],
      total: 60, cols, rows,
    }
  }
  if (name === 'exit-notice') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 34, minTick: 8, awaitText: '❯', data: String.fromCharCode(3) }],
      readyText: 'twice to close Mercury',
      stableTicks: 2,
      total: 70, cols, rows,
    }
  }
  if (name === 'copy-receipt-select' || name === 'copy-receipt-ctrlc') {
    writeSyntheticSession('short')
    if (name === 'copy-receipt-ctrlc') {
      const cfgPath = join(CONFIG_HOME, '.mercury.json')
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
        cfg['copyOnSelect'] = false
        writeFileSync(cfgPath, JSON.stringify(cfg))
      } catch {
        writeFileSync(cfgPath, JSON.stringify({ copyOnSelect: false }))
      }
    }
    const ESC_ = String.fromCharCode(27)
    const sgr = (b: number, c: number, r: number, up = false): string =>
      `${ESC_}[<${b};${c};${r}${up ? 'm' : 'M'}`
    const drag = [
      { atTick: 34, data: sgr(0, 30, 26) },
      { atTick: 37, data: sgr(32, 30, 27) },
      { atTick: 40, data: sgr(32, 30, 28) },
      { atTick: 43, data: sgr(32, 30, 30) },
      { atTick: 46, data: sgr(0, 30, 30, true) },
    ]
    return {
      argv: ['node', BIN, '--resume', SID],
      sends:
        name === 'copy-receipt-ctrlc'
          ? [...drag, { afterPrevTicks: 4, data: String.fromCharCode(3) }]
          : drag,
      readyText: 'Copied to clipboard',
      stableTicks: 2,
      total: 80, cols, rows,
    }
  }
  if (name === 'composer-paste') {
    writeSyntheticSession('short')
    const ESC_ = String.fromCharCode(27)
    const body = Array.from(
      { length: 60 },
      (_, i) => `const baselineRow${i} = ${i} // rendezvous r0 paste fixture`,
    ).join('\n')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        {
          atTick: 60,
          minTick: 30,
          awaitRaw: `${ESC_}[?2004h`,
          data: `${ESC_}[200~${body}${ESC_}[201~`,
        },
      ],
      readyText: 'Pasted text', stableTicks: 4,
      total: 100, cols, rows,
    }
  }
  if (name === 'prompts-panel' || name === 'prompts-panel-resize') {
    writeSyntheticSession('short')
    const resize = name === 'prompts-panel-resize'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/workbench' },
        { atTick: 36, data: '\r' },
        ...(resize
          ? [{ atTick: 999, awaitText: 'SAVED PROMPTS', minTick: 5, awaitSettleTicks: 2, data: '\x1b[A' }]
          : []),
      ],
      ...(resize
        ? {
            resizes: [
              { atTick: 90, cols: 80, rows: 30 },
              { atTick: 110, cols: cols, rows: rows },
            ],
            total: 130,
          }
        : { readyText: 'SAVED PROMPTS', stableTicks: 4, total: 110 }),
      cols,
      rows,
    }
  }
  if (name === 'accounts') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/accounts' }, { atTick: 38, data: '\r' }],
      total: 54, cols, rows,
    }
  }
  if (name === 'accounts-board-multi') {
    stageAccountsBoardFile(
      '.openai-auth.json',
      JSON.stringify({
        version: 1,
        tokens: {
          idToken: '',
          accessToken: 'fixture-access',
          refreshToken: 'fixture-refresh',
          accountId: 'acct_fixture',
          planType: 'plus',
        },
      }),
    )
    stageAccountsBoardFile(
      '.provider-secrets.json',
      JSON.stringify({
        version: 1,
        openaiApiKey: 'sk-fixture-openai-key-abcd',
        zaiApiKey: 'zai-fixture-key-efgh',
      }),
    )
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/accounts' }, { atTick: 36, data: '\r' }],
      total: 70, cols, rows,
    }
  }
  if (name === 'accounts-board-signed-out') {
    const scratchHome = mkdtempSync(join(tmpdir(), 'mercury-render-accounts-home-'))
    accountsBoardEnvStash = {
      prevHome: process.env.HOME,
      prevStore: process.env.MERCURY_CREDENTIAL_STORE,
      scratchHome,
    }
    process.env.HOME = scratchHome
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    stageAccountsBoardFile('.openai-auth.json', null)
    stageAccountsBoardFile('.provider-secrets.json', null)
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/accounts' }, { atTick: 36, data: '\r' }],
      total: 70, cols, rows,
    }
  }
  if (name === 'accounts-board-operator-shape' || name === 'model-picker-operator-shape') {
    const scratchHome = mkdtempSync(join(tmpdir(), 'mercury-render-accounts-home-'))
    accountsBoardEnvStash = {
      prevHome: process.env.HOME,
      prevStore: process.env.MERCURY_CREDENTIAL_STORE,
      scratchHome,
    }
    process.env.HOME = scratchHome
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    const dead = 'http://127.0.0.1:9'
    process.env.MERCURY_OPENAI_API_BASE = dead
    process.env.MERCURY_OPENAI_CHATGPT_BASE = dead
    process.env.MERCURY_OPENAI_AUTH_BASE = dead
    stageAccountsBoardFile(
      '.openai-auth.json',
      JSON.stringify({
        version: 1,
        tokens: {
          idToken: '',
          accessToken: 'fixture-access',
          refreshToken: 'fixture-refresh',
          accountId: 'acct_fixture',
          planType: 'plus',
        },
      }),
    )
    stageAccountsBoardFile('.provider-secrets.json', null)
    writeSyntheticSession('short')
    const open = name === 'accounts-board-operator-shape' ? '/accounts' : '/model'
    return {
      argv: ['node', BIN, '--resume', SID, '--model', 'gpt-5.6-sol'],
      sends: [{ atTick: 30, data: open }, { atTick: 36, data: '\r' }],
      total: 70, cols, rows,
    }
  }
  if (name === 'gate-openai-only') {
    const scratch = mkdtempSync(join(tmpdir(), 'mercury-render-gate-'))
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    writeFileSync(
      join(scratch, '.openai-auth.json'),
      JSON.stringify({
        version: 1,
        tokens: {
          idToken: '',
          accessToken: 'fixture-access',
          refreshToken: 'fixture-refresh',
          accountId: 'acct_fixture',
          planType: 'plus',
        },
      }),
    )
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    return { argv: ['node', BIN], sends: [{ atTick: 32, data: 'x' }], total: 70, cols, rows }
  }
  if (name === 'gpt-turn-render') {
    writeSyntheticSession('gpt-thinking')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'router-connect-steer') {
    writeSyntheticSession('short')
    process.env.MERCURY_ROUTER = '1'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/router connect' }, { atTick: 38, data: '\r' }],
      total: 56, cols, rows,
    }
  }
  if (name === 'login-card') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/login' }, { atTick: 38, data: '\r' }],
      total: 56, cols, rows,
    }
  }
  if (
    name === 'login-kimi-device' ||
    name === 'login-glm-key' ||
    name === 'login-deepseek-key' ||
    name === 'login-claude-waiting' ||
    name === 'login-openai-browser' ||
    name === 'login-openai-choice' ||
    name === 'login-openrouter-choice' ||
    name === 'login-gemini-choice' ||
    name === 'login-hf-choice' ||
    name === 'login-audit-leftarrow-key' ||
    name === 'login-audit-esc-key' ||
    name === 'login-audit-esc-choice' ||
    name === 'accounts-board-kimi-signed-in'
  ) {
    //     global → the device screen, fed by ONE detached fixture OAuth host
    const scratch = mkdtempSync(join(tmpdir(), `mercury-render-${name}-`))
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_LOCAL_API_KEY', 'MERCURY_HUGGINGFACE_BILL_TO', 'MERCURY_MOONSHOT_OAUTH_CLIENT_ID']) {
      delete process.env[key]
    }
    const dead = 'http://127.0.0.1:9'
    process.env.MERCURY_OPENAI_API_BASE = dead
    process.env.MERCURY_OPENAI_CHATGPT_BASE = dead
    process.env.MERCURY_OPENAI_AUTH_BASE = dead
    process.env.MERCURY_OPENROUTER_API_BASE = dead
    process.env.MERCURY_OPENROUTER_AUTH_BASE = dead
    process.env.MERCURY_GEMINI_API_BASE = dead
    process.env.MERCURY_GEMINI_OAUTH_AUTH_BASE = dead
    process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = dead
    process.env.MERCURY_MOONSHOT_API_BASE = dead
    process.env.MERCURY_MOONSHOT_OAUTH_BASE = dead
    process.env.MERCURY_MOONSHOT_CODING_BASE = dead
    process.env.MERCURY_ZAI_API_BASE = dead
    process.env.MERCURY_DEEPSEEK_API_BASE = dead
    process.env.MERCURY_HUGGINGFACE_HUB_BASE = dead
    process.env.MERCURY_HUGGINGFACE_API_BASE = `${dead}/v1`
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.BROWSER = 'true'
    if (name === 'login-kimi-device') {
      const port = 47734
      const pidName = 'mercury-render-kimi-fixture.pid'
      try {
        const stale = Number(readFileSync(join(tmpdir(), pidName), 'utf8').trim())
        if (Number.isFinite(stale) && stale > 1) process.kill(stale)
      } catch {
      }
      const serverJs = `const http=require('http');http.createServer((q,s)=>{let b='';q.on('data',c=>{b+=c});q.on('end',()=>{const j=(code,x)=>{s.writeHead(code,{'content-type':'application/json'});s.end(JSON.stringify(x))};if(q.method==='POST'&&q.url==='/api/oauth/device_authorization')return j(200,{device_code:'render-device-code',user_code:'KIMI-FIXT',verification_uri:'http://127.0.0.1:${port}/activate',verification_uri_complete:'http://127.0.0.1:${port}/activate?user_code=KIMI-FIXT',expires_in:300,interval:2});if(q.method==='POST'&&q.url==='/api/oauth/token')return j(400,{error:'authorization_pending'});if(q.url==='/ready')return j(200,{ok:true});j(404,{error:'not found'})})}).listen(${port},'127.0.0.1')`
      const child = spawn('node', ['-e', serverJs], { detached: true, stdio: 'ignore' })
      child.unref()
      writeFileSync(join(tmpdir(), pidName), String(child.pid ?? ''))
      execSync(
        `sh -c 'i=0; while [ $i -lt 40 ]; do curl -s -m 1 http://127.0.0.1:${port}/ready > /dev/null && exit 0; i=$((i+1)); sleep 0.25; done; echo "${pidName} server never became ready" >&2; exit 7'`,
      )
      process.env.MERCURY_MOONSHOT_OAUTH_BASE = `http://127.0.0.1:${port}`
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, data: '/logins kimi' },
          { atTick: 36, data: '\r' },
          { atTick: 44, data: '\r' },
          { atTick: 50, data: '\r' },
          { atTick: 56, data: '\r' },
        ],
        total: 90, cols, rows,
      }
    }
    if (name === 'login-glm-key') {
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, data: '/logins glm' },
          { atTick: 36, data: '\r' },
          { atTick: 44, data: '\r' },
          { atTick: 50, data: '\r' },
        ],
        total: 72, cols, rows,
      }
    }
    if (name === 'login-deepseek-key') {
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, data: '/logins deepseek' },
          { atTick: 36, data: '\r' },
          { atTick: 44, data: '\r' },
        ],
        total: 66, cols, rows,
      }
    }
    if (name === 'login-claude-waiting') {
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, data: '/logins' },
          { atTick: 36, data: '\r' },
          { atTick: 44, data: '\r' },
        ],
        total: 90, cols, rows,
      }
    }
    if (name === 'login-openai-browser') {
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, data: '/logins openai' },
          { atTick: 36, data: '\r' },
          { atTick: 44, data: '\r' },
        ],
        total: 80, cols, rows,
      }
    }
    if (
      name === 'login-openai-choice' ||
      name === 'login-openrouter-choice' ||
      name === 'login-gemini-choice' ||
      name === 'login-hf-choice'
    ) {
      const family =
        name === 'login-openai-choice'
          ? 'openai'
          : name === 'login-openrouter-choice'
            ? 'openrouter'
            : name === 'login-gemini-choice'
              ? 'gemini'
              : 'huggingface'
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, data: `/logins ${family}` },
          { atTick: 36, data: '\r' },
          { atTick: 44, data: '\r' },
        ],
        total: 72, cols, rows,
      }
    }
    if (name === 'login-audit-leftarrow-key') {
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, data: '/logins glm' },
          { atTick: 36, data: '\r' },
          { atTick: 44, data: '\r' },
          { atTick: 50, data: '\r' },
          { atTick: 58, data: 'abc' },
          { atTick: 64, data: '\u001b[D' },
        ],
        total: 84, cols, rows,
      }
    }
    if (name === 'login-audit-esc-key') {
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, data: '/logins deepseek' },
          { atTick: 36, data: '\r' },
          { atTick: 44, data: '\r' },
          { atTick: 52, data: '\u001b' },
        ],
        total: 76, cols, rows,
      }
    }
    if (name === 'login-audit-esc-choice') {
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, data: '/logins kimi' },
          { atTick: 36, data: '\r' },
          { atTick: 44, data: '\r' },
          { atTick: 52, data: '\u001b' },
        ],
        total: 76, cols, rows,
      }
    }
    writeFileSync(
      join(scratch, '.moonshot-auth.json'),
      JSON.stringify({
        version: 1,
        tokens: { accessToken: 'kimi-render-fixture-access-0001', refreshToken: 'kimi-render-fixture-refresh-0001', accessTokenExpiresAtMs: 4102444800000, scope: 'kimi-code' },
        region: 'global',
      }),
    )
    return { argv: ['node', BIN], sends: [{ atTick: 30, data: '/accounts' }, { atTick: 36, data: '\r' }], total: 70, cols, rows }
  }
  if (name === 'status-facts') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/status' }, { atTick: 38, data: '\r' }],
      total: 60, cols, rows,
    }
  }
  if (name === 'companion-cockpit' || name === 'companion-deck') {
    writeSyntheticSession('short')
    process.env.MERCURY_DECK_COMPANION = '1'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [],
      total: 56, cols, rows,
    }
  }
  if (name === 'tasks-mission') {
    writeSyntheticSession('short')
    writeMissionLedgerFixture()
    process.env.MERCURY_TASK_LIST_ID = MISSION_FIXTURE_LIST
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/tasks' }, { atTick: 38, data: '\r' }],
      total: 60, cols, rows,
    }
  }
  if (name === 'cockpit-scrolled') {
    writeSyntheticSession('tall')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 90, minTick: 40, awaitText: 'RECENT', awaitSettleTicks: 2, data: '\x1b[5~' },
        { atTick: 94, minTick: 44, awaitText: 'NEXT', data: '\x1b[5~' },
        ...Array.from({ length: 12 }, () => ({ afterPrevTicks: 4, data: '\x1b[5~' })),
      ],
      readyText: ['RECENT', 'NEXT'],
      stableTicks: 3,
      total: 160, cols, rows,
    }
  }
  if (name === 'click-expand') {
    writeSyntheticSession('expand')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [],
      total: 70, cols, rows,
    }
  }
  if (name === 'two-bash-click') {
    writeSyntheticSession('two-bash')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [],
      total: 70, cols, rows,
    }
  }
  if (name === 'tool-lifecycle') {
    writeSyntheticSession('lifecycle')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [],
      total: 70, cols, rows,
    }
  }
  if (name === 'autopilot-band') {
    process.env.MERCURY_AUTOPILOT = '1'
    const settingsPath = join(tmpdir(), 'autopilot-band-settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ skipSovereignConsentPrompt: true }),
    )
    writeSyntheticSession('short')
    return {
      argv: [
        'node', BIN, '--resume', SID,
        '--dangerously-bypass-permissions', '--settings', settingsPath,
      ],
      sends: [{ atTick: 32, data: '\x1b[Z' }],
      total: 52, cols, rows,
    }
  }
  if (name === 'mode-band-accept' || name === 'mode-band-plan' || name === 'mode-band-auto') {
    const mode = { 'mode-band-accept': 'implement', 'mode-band-plan': 'strategy', 'mode-band-auto': 'flow' }[name]!
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID, '--permission-mode', mode],
      sends: [],
      readyText: 'shift+tab to cycle',
      stableTicks: 4,
      total: 48, cols, rows,
    }
  }
  if (name === 'mode-band-bypass') {
    const settingsPath = join(tmpdir(), 'mode-band-bypass-settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ skipSovereignConsentPrompt: true }),
    )
    writeSyntheticSession('short')
    return {
      argv: [
        'node', BIN, '--resume', SID,
        '--dangerously-bypass-permissions', '--settings', settingsPath,
      ],
      sends: [],
      readyText: 'auto-approved',
      stableTicks: 4,
      total: 48, cols, rows,
    }
  }
  if (name === 'cockpit-policy') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/cockpit' },
        { atTick: 36, data: '\r' },
        { atTick: 44, data: '5' },
      ],
      total: 60, cols, rows,
    }
  }
  if (name === 'sessions-manager' || name === 'resume-full-history') {
    writeSyntheticSession('tools')
    writeSyntheticSession('short', SID_ERRORED)
    const cmd = name === 'sessions-manager' ? '/sessions' : '/resume'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: cmd },
        { atTick: 36, data: '\r' },
      ],
      readyText: name === 'sessions-manager' ? 'Switch to' : 'Full history',
      stableTicks: 4,
      total: 64, cols, rows,
    }
  }
  if (name === 'appearance') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/appearance' }, { atTick: 36, data: '\r' }],
      total: 52, cols, rows,
    }
  }
  if (name === 'bug') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/bug' }, { atTick: 36, data: '\r' }],
      total: 52, cols, rows,
    }
  }
  if (name === 'mode-cycle-drive') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '\u001b[Z' },
        { atTick: 36, data: '\u001b[Z' },
        { atTick: 42, data: '\u001b[Z' },
      ],
      total: 56, cols, rows,
    }
  }
  if (name === 'appearance-arrows') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/appearance' },
        { atTick: 36, data: '\r' },
        { atTick: 46, data: String.fromCharCode(27) + '[B' },
        { atTick: 50, data: String.fromCharCode(27) + '[B' },
      ],
      total: 64, cols, rows,
    }
  }
  if (name === 'feel-journey') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/appearance' },
        { atTick: 36, data: '\r' },
        { atTick: 46, data: String.fromCharCode(27) + '[B' },
        { atTick: 54, data: String.fromCharCode(27) },
        { atTick: 70, data: 'draft survives overlays' },
      ],
      total: 92, cols, rows,
    }
  }
  if (name === 'cockpit-model' || name === 'cockpit-palette') {
    writeSyntheticSession('short')
    const cmd = name === 'cockpit-model' ? '/model' : '/cockpit'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: cmd }, { atTick: 36, data: '\r' }],
      total: 52, cols, rows,
    }
  }
  if (name === 'authority') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/authority' },
        { atTick: 36, data: '\r' },
        { atTick: 44, data: '\u001b[B' },
        { atTick: 48, data: '\u001b[B' },
        { atTick: 54, data: '\r' },
      ],
      total: 70, cols, rows,
    }
  }
  if (name === 'saturn') {
    writeSyntheticSession('short')
    const daemonDir = process.env.MERCURY_DAEMON_DIR!
    mkdirSync(daemonDir, { recursive: true })
    const acct = { family: 'anthropic', source: 'oauth', identity: 'op@example.com' }
    const sched = (id: string, when: Record<string, unknown>, action: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      schema: 1, id, when, action, account: acct, modelKey: 'claude-opus-5',
      createdAt: Date.now() - 3_600_000, createdBy: 'operator:render', ...extra,
    })
    writeFileSync(join(daemonDir, 'concourse-workers.json'), JSON.stringify({
      version: 1,
      workers: {
        'render-w1': {
          schema: 1, runnerId: 'render-w1', sessionId: 'rndr-sess-1', workspaceId: REPO,
          isolation: 'shared', modelKey: 'claude-opus-5', spawnedAt: Date.now() - 60_000, lastLiveAt: Date.now(),
          title: 'render session',
          schedules: [
            sched('aaaa1111', { kind: 'at', atMs: Date.now() + 2 * 3_600_000, spelling: 'in 2h' }, { kind: 'fire', prompt: 'run the nightly summary' }),
            sched('cccc3333', { kind: 'every', cron: '0 9 * * *', spelling: 'every day 09:00' }, { kind: 'fire', prompt: 'stand-up notes' }, { paused: true }),
            sched('bbbb2222', { kind: 'at', atMs: Date.now() + 26 * 3_600_000, spelling: 'tomorrow 07:30' }, {
              kind: 'birth',
              birth: { workspaceDir: REPO, modelKey: 'claude-opus-5', presence: 'screen-present', kitPreset: 'review-kit', opening: 'sweep the overnight issues' },
            }),
          ],
          heldFires: [{
            scheduleId: 'aaaa1111', dueAt: Date.now() - 3_600_000, reason: 'sign-in-expired',
            envelope: { scheduleId: 'aaaa1111', kind: 'fire', dueAt: Date.now() - 3_600_000, prompt: 'run the nightly summary' },
            heldAt: Date.now() - 3_500_000,
          }],
        },
      },
    }))
    writeFileSync(join(daemonDir, 'saturn-box-schedules.json'), JSON.stringify({
      version: 1,
      schedules: [sched('eeee5555', { kind: 'at', atMs: Date.now() + 6 * 3_600_000, spelling: 'in 6h' }, {
        kind: 'birth',
        birth: { workspaceDir: REPO, modelKey: 'claude-opus-5', presence: 'headless', opening: 'run the audit' },
      })],
      heldFires: [],
    }))
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/saturn' },
        { atTick: 36, data: '\r' },
        { atTick: 44, data: '\u001b[B' },
        { atTick: 46, data: '\u001b[B' },
      ],
      total: 62, cols, rows,
    }
  }
  if (name === 'tabula' || name === 'tabula-empty') {
    writeSyntheticSession('short')
    if (name === 'tabula') {
      const slug = REPO.replace(/[^a-zA-Z0-9]/g, '-')
      const dir = join(process.env.MERCURY_TABULA_DIR!, slug)
      mkdirSync(dir, { recursive: true })
      const refinedBase = 'fix picker jank'
      let h = 0
      for (let i = 0; i < refinedBase.length; i++) h = ((h << 5) - h + refinedBase.charCodeAt(i)) | 0
      const ev = [
        { t: '2026-07-08T09:00:00Z', op: 'add', id: 'aa11bb', text: 'ship the telemetry board', pri: 'now' },
        { t: '2026-07-08T09:01:00Z', op: 'add', id: 'bb22cc', text: refinedBase, pri: 'now' },
        { t: '2026-07-08T09:02:00Z', op: 'add', id: 'cc33dd', text: 'benchmark the pooled gate at 8 slots' },
        { t: '2026-07-08T09:03:00Z', op: 'add', id: 'dd44ee', text: 'read the mneme consolidation paper again', pri: 'later' },
        { t: '2026-07-08T09:04:00Z', op: 'add', id: 'ee55ff', text: 'retire the legacy splash art', pri: 'later' },
        { t: '2026-07-08T09:05:00Z', op: 'done', id: 'ee55ff', done: true },
        { t: '2026-07-08T09:06:00Z', op: 'refine', id: 'bb22cc', refinedText: 'Fix the model picker focus jank on the tier rows', baseHash: h.toString(36) },
      ]
      writeFileSync(join(dir, 'journal.jsonl'), ev.map(e => JSON.stringify(e)).join('\n') + '\n')
    }
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/tabula' }, { atTick: 36, data: '\r' }],
      total: 56, cols, rows,
    }
  }
  if (name === 'capabilities') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/capabilities' },
        { atTick: 36, data: '\r' },
        { atTick: 44, data: '\u001b[B' },
        { atTick: 46, data: '\u001b[B' },
      ],
      total: 62, cols, rows,
    }
  }
  if (name === 'capabilities-env') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/capabilities' },
        { atTick: 36, data: '\r' },
        { atTick: 44, data: '6' },
        { atTick: 46, data: '\u001b[B' },
      ],
      total: 62, cols, rows,
    }
  }
  if (name === 'memory-files') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/memory files' }, { atTick: 36, data: '\r' }],
      total: 56, cols, rows,
    }
  }
  if (name.startsWith('agents-studio')) {
    writeSyntheticSession('short')
    writeAgentStudioFixtures()
    const base = [{ atTick: 30, data: '/agents' }, { atTick: 36, data: '\r' }]
    if (name === 'agents-studio-rich') {
      return {
        argv: ['node', BIN, '--resume', SID],
        sends: base,
        readyText: 'studio-fix-writer', stableTicks: 4,
        total: 90, cols, rows,
      }
    }
    if (name === 'agents-studio-inspect') {
      return {
        argv: ['node', BIN, '--resume', SID],
        sends: [...base, { atTick: 48, data: 'dup-lens' }, { atTick: 58, data: '\r' }],
        readyText: 'shadow chain', stableTicks: 4,
        total: 110, cols, rows,
      }
    }
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [...base, { atTick: 48, data: 'N' }],
      readyText: 'where should this agent live', stableTicks: 4,
      total: 110, cols, rows,
    }
  }
  if (name === 'manager-follow') {
    writeSyntheticSession('short')
    const down = '\u001b[B'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/manager' },
        { atTick: 36, data: '\r' },
        ...Array.from({ length: 14 }, (_, k) => ({ atTick: 42 + k * 2, data: down })),
      ],
      readyText: '↑ ', stableTicks: 4,
      total: 110, cols, rows,
    }
  }
  if (name === 'manager-filter' || name === 'manager-nomatch') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/manager' },
        { atTick: 36, data: '\r' },
        {
          atTick: 120,
          minTick: 10,
          awaitText: 'opens for real',
          awaitSettleTicks: 3,
          data: name === 'manager-filter' ? 'agent' : 'zzzz',
        },
      ],
      readyText: name === 'manager-filter' ? 'match · ↵' : 'No surfaces match',
      stableTicks: 4,
      total: 170, cols, rows,
    }
  }
  if (['critter', 'workflows', 'teammates', 'deck', 'sessions', 'substrate', 'trace', 'fleet', 'ledger', 'cards', 'ide', 'config', 'permissions', 'hooks', 'agents', 'diff', 'tickets', 'memory', 'workbench', 'surfaces', 'palette', 'realms', 'status'].includes(name)) {
    writeSyntheticSession('short')
    const sends = [{ atTick: 30, data: `/${name}` }, { atTick: 36, data: '\r' }]
    const settled = name === 'sessions'
      ? { readyText: 'Switch to', stableTicks: 4, total: 100 }
      : { total: 56 }
    return {
      argv: ['node', BIN, '--resume', SID],
      sends,
      ...settled, cols, rows,
      chromeMarkers: name === 'ide' ? ['Select IDE'] : undefined,
    }
  }
  if (name === 'keys-escape') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/keys' },
        { atTick: 36, data: '\r' },
        { atTick: 120, minTick: 10, awaitText: 'input atlas', awaitSettleTicks: 3, data: '\x1b', mark: 'atlas-open' },
      ],
      readyText: 'for commands', stableTicks: 6,
      total: 170, cols, rows,
    }
  }
  if (name === 'workflows-live-empty') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/workflows' }, { atTick: 36, data: '\r' }],
      readyText: 'No workflow runs', stableTicks: 4,
      total: 90, cols, rows,
    }
  }
  if (
    name === 'workflows-live-past' ||
    name === 'workflows-live-run' ||
    name === 'workflows-live-inspector' ||
    name === 'workflows-live-inspector-long' ||
    name === 'workflows-live-carryback' ||
    name === 'workflows-live-arrows' ||
    name === 'workflows-live-settled' ||
    name === 'workflows-live-backoff'
  ) {
    writeSyntheticSession('short')
    writeWorkflowFixtures({
      longOut: name === 'workflows-live-inspector-long',
      settledChildren: name === 'workflows-live-settled',
    })
    const TAB = String.fromCharCode(9)
    const RAW_ARM = '\u001b[?2004h'
    const sends =
      name === 'workflows-live-past'
        ? [
            { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
            { afterPrevTicks: 6, data: '\r' },
            { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: TAB },
            { afterPrevTicks: 4, data: TAB },
          ]
        : name === 'workflows-live-run'
          ? [
              { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
              { afterPrevTicks: 6, data: '\r' },
              { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: TAB },
              { afterPrevTicks: 4, data: TAB },
              { afterPrevTicks: 8, data: '\r' },
            ]
          : name === 'workflows-live-inspector' || name === 'workflows-live-inspector-long'
            ? [
                { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
                { afterPrevTicks: 6, data: '\r' },
                { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: TAB },
                { afterPrevTicks: 4, data: TAB },
                { afterPrevTicks: 8, data: '\r' },
                { atTick: 360, awaitText: 'out Design complete', minTick: 12, data: '\r' },
                ...(name === 'workflows-live-inspector-long'
                  ? [{ atTick: 460, awaitText: 'e expand', minTick: 8, data: 'e' }]
                  : []),
              ]
            : name === 'workflows-live-arrows'
              ? [
                  { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
                  { afterPrevTicks: 6, data: '\r' },
                  { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: '\x1b[B' },
                  { afterPrevTicks: 4, data: '\x1b[B' },
                  { afterPrevTicks: 4, data: '\x1b[B' },
                ]
              : name === 'workflows-live-settled'
                ? [
                    { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
                    { afterPrevTicks: 6, data: '\r' },
                    { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: TAB },
                    { afterPrevTicks: 4, data: TAB },
                    { afterPrevTicks: 6, data: '\x1b[B' },
                    { afterPrevTicks: 4, data: '\x1b[B' },
                    { afterPrevTicks: 8, data: '\r' },
                  ]
                : name === 'workflows-live-backoff'
                  ? [
                      { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
                      { afterPrevTicks: 6, data: '\r' },
                      { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: TAB },
                      { afterPrevTicks: 4, data: TAB },
                      { afterPrevTicks: 6, data: '\x1b[B' },
                      { afterPrevTicks: 8, data: '\r' },
                    ]
                : [
                { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
                { afterPrevTicks: 6, data: '\r' },
                { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: TAB },
                { afterPrevTicks: 4, data: TAB },
                { afterPrevTicks: 6, data: '\x1b[B' },
                { afterPrevTicks: 6, data: '\r' },
                { afterPrevTicks: 25, data: '\x1b[D' },
              ]
    const ready =
      name === 'workflows-live-past'
 ? { readyText: ['substrate-carried', '◈ 29.7k'], stableTicks: 4 }
        : name === 'workflows-live-run'
          ? { readyText: ['out Design complete'], stableTicks: 4 }
          : name === 'workflows-live-inspector'
            ? { readyText: ['the returned result', 'no reasoning captured'], stableTicks: 4 }
            : name === 'workflows-live-inspector-long'
              ? { readyText: ['e compact'], stableTicks: 4 }
              : name === 'workflows-live-arrows'
                ? { readyText: ['▸ stale-drifter'], stableTicks: 4 }
                : name === 'workflows-live-settled'
                  ? { readyText: ['harbor-sweep', 'skipped'], stableTicks: 4 }
                  : name === 'workflows-live-backoff'
                    ? { readyText: ['provider backoff'], stableTicks: 4 }
 : { readyText: ['substrate-carried'], stableTicks: 5 }
    return {
      argv: ['node', BIN, '--resume', SID],
      sends,
      ...ready,
      total:
        name === 'workflows-live-past'
          ? 260
          : name === 'workflows-live-run' ||
              name === 'workflows-live-settled' ||
              name === 'workflows-live-backoff'
            ? 340
            : name === 'workflows-live-carryback'
              ? 300
              : name === 'workflows-live-arrows'
                ? 260
                : name === 'workflows-live-inspector-long'
                  ? 520
                  : 420,
      cols, rows,
    }
  }
  if (name === 'workflows-external') {
    writeSyntheticSession('short')
    writeExternalWorkflowFixtures()
    const TAB = String.fromCharCode(9)
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/workflows' },
        { atTick: 36, data: '\r' },
        { atTick: 90, data: TAB },
        { atTick: 96, data: TAB },
      ],
      total: 118, cols, rows,
    }
  }
  if (name === 'settings-config') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/config' },
        { atTick: 36, data: '\r' },
        { atTick: 70, data: 'provider' },
      ],
      total: 100, cols, rows,
      chromeMarkers: ['Config', 'Usage'],
    }
  }
  if (name === 'settings-usage-engines') {
    writeSyntheticSession('short')
    writeFileSync(join(CONFIG_HOME, '.openai-auth.json'), JSON.stringify({
      version: 1,
      tokens: {
        idToken: '',
        accessToken: 'fixture-access',
        refreshToken: 'fixture-refresh',
        accountId: 'acct_fixture',
        planType: 'plus',
      },
    }))
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/usage' },
        { atTick: 36, data: '\r' },
      ],
      total: 80, cols, rows,
      chromeMarkers: ['Config', 'Usage'],
    }
  }
  if (name === 'settings-status-signedin') {
    const scratch = mkdtempSync(join(tmpdir(), 'mercury-render-status-signedin-'))
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    writeFileSync(
      join(scratch, '.openai-auth.json'),
      JSON.stringify({
        version: 1,
        tokens: {
          idToken: '',
          accessToken: 'fixture-access',
          refreshToken: 'fixture-refresh',
          accountId: 'acct_fixture',
          planType: 'plus',
        },
      }),
    )
    writeFileSync(
      join(scratch, '.openrouter-auth.json'),
      JSON.stringify({
        version: 1,
        minted: { key: 'sk-or-v1-renderfixture000000', mintedAtMs: 1755772800000, label: 'Mercury' },
      }),
    )
    writeFileSync(
      join(scratch, '.provider-secrets.json'),
      JSON.stringify({ version: 1, geminiApiKey: 'AIza-render-fixture-key0000' }),
    )
    for (const key of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'ZAI_API_KEY',
    ]) {
      delete process.env[key]
    }
    const dead = 'http://127.0.0.1:9'
    process.env.MERCURY_OPENAI_API_BASE = dead
    process.env.MERCURY_OPENAI_CHATGPT_BASE = dead
    process.env.MERCURY_OPENAI_AUTH_BASE = dead
    process.env.MERCURY_OPENROUTER_API_BASE = dead
    process.env.MERCURY_OPENROUTER_AUTH_BASE = dead
    process.env.MERCURY_GEMINI_API_BASE = dead
    process.env.MERCURY_GEMINI_OAUTH_AUTH_BASE = dead
    process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = dead
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    return {
      argv: ['node', BIN],
      sends: [
        { atTick: 30, data: '/usage\r' },
        { atTick: 70, data: '\u001b[D' },
        { atTick: 76, data: '\u001b[D' },
      ],
      total: 105, cols, rows,
      chromeMarkers: ['Config', 'Usage'],
    }
  }
  if (
    name === 'model-picker-hf' ||
    name === 'model-picker-local' ||
    name === 'accounts-board-hf-signed-in' ||
    name === 'settings-usage-hf' ||
    name === 'settings-usage-local'
  ) {
    const scratch = mkdtempSync(join(tmpdir(), `mercury-render-${name}-`))
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_LOCAL_API_KEY', 'MERCURY_HUGGINGFACE_BILL_TO']) {
      delete process.env[key]
    }
    const dead = 'http://127.0.0.1:9'
    process.env.MERCURY_OPENAI_API_BASE = dead
    process.env.MERCURY_OPENAI_CHATGPT_BASE = dead
    process.env.MERCURY_OPENAI_AUTH_BASE = dead
    process.env.MERCURY_OPENROUTER_API_BASE = dead
    process.env.MERCURY_OPENROUTER_AUTH_BASE = dead
    process.env.MERCURY_GEMINI_API_BASE = dead
    process.env.MERCURY_GEMINI_OAUTH_AUTH_BASE = dead
    process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = dead
    process.env.MERCURY_MOONSHOT_API_BASE = dead
    process.env.MERCURY_DEEPSEEK_API_BASE = dead
    process.env.MERCURY_HUGGINGFACE_HUB_BASE = dead
    process.env.MERCURY_HUGGINGFACE_API_BASE = `${dead}/v1`
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_CONFIG_DIR = scratch
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    const startFixture = (pidName: string, port: number, serverJs: string, readyPath: string): void => {
      try {
        const stale = Number(readFileSync(join(tmpdir(), pidName), 'utf8').trim())
        if (Number.isFinite(stale) && stale > 1) process.kill(stale)
      } catch {
      }
      const child = spawn('node', ['-e', serverJs], { detached: true, stdio: 'ignore' })
      child.unref()
      writeFileSync(join(tmpdir(), pidName), String(child.pid ?? ''))
      execSync(
        `sh -c 'i=0; while [ $i -lt 40 ]; do curl -s -m 1 http://127.0.0.1:${port}${readyPath} > /dev/null && exit 0; i=$((i+1)); sleep 0.25; done; echo "${pidName} server never became ready" >&2; exit 7'`,
      )
    }
    const hfToken = 'hf_render_fixture_token_000000001'
    if (name === 'model-picker-hf' || name === 'settings-usage-hf') {
      const port = 47731
      const body = readFileSync(join(REPO, 'scripts', 'provider-compat', 'fixtures', 'huggingface-models-2026-08-22.json'), 'utf8')
      const serverJs = `const http=require('http');const body=${JSON.stringify(body)};http.createServer((q,s)=>{if(q.url==='/v1/models'){s.writeHead(200,{'content-type':'application/json'});s.end(body);return}s.writeHead(404,{'content-type':'application/json'});s.end('{"error":"not found"}')}).listen(${port},'127.0.0.1')`
      startFixture('mercury-render-hf-fixture.pid', port, serverJs, '/v1/models')
      process.env.HF_TOKEN = hfToken
      process.env.MERCURY_HUGGINGFACE_API_BASE = `http://127.0.0.1:${port}/v1`
    }
    if (name === 'model-picker-local' || name === 'settings-usage-local') {
      const port = 47732
      const tags = { models: [
        { name: 'qwen3:8b', model: 'qwen3:8b', modified_at: '2026-08-20T08:06:48Z', size: 4683075271, digest: '0a8c26691023', details: { parent_model: '', format: 'gguf', family: 'qwen3', families: ['qwen3'], parameter_size: '8.2B', quantization_level: 'Q4_K_M' } },
        { name: 'llama3.2:latest', model: 'llama3.2:latest', modified_at: '2026-08-18T17:37:44Z', size: 2019393189, digest: 'a80c4f17acd5', details: { parent_model: '', format: 'gguf', family: 'llama', families: ['llama'], parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
        { name: 'llava:latest', model: 'llava:latest', modified_at: '2026-08-10T00:00:00Z', size: 4000000000, digest: '200765e12836', details: { parent_model: '', format: 'gguf', family: 'llama', families: ['llama', 'clip'], parameter_size: '7B', quantization_level: 'Q4_0' } },
      ] }
      const ps = { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 6000000000, digest: '0a8c26691023', details: tags.models[0]!.details, expires_at: '2026-08-22T05:00:00Z', size_vram: 6000000000, context_length: 32768 }] }
      const show: Record<string, unknown> = {
        'qwen3:8b': { parameters: 'stop "<|im_end|>"', details: tags.models[0]!.details, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, capabilities: ['completion', 'tools', 'thinking'] },
        'llama3.2:latest': { parameters: 'num_ctx                        16384', details: tags.models[1]!.details, model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 }, capabilities: ['completion', 'tools'] },
        'llava:latest': { parameters: '', details: tags.models[2]!.details, model_info: { 'general.architecture': 'llama', 'llama.context_length': 4096 }, capabilities: ['completion', 'vision'] },
      }
      const serverJs = `const http=require('http');const tags=${JSON.stringify(JSON.stringify(tags))};const ps=${JSON.stringify(JSON.stringify(ps))};const show=${JSON.stringify(JSON.stringify(show))};const shows=JSON.parse(show);http.createServer((q,s)=>{let b='';q.on('data',c=>{b+=c});q.on('end',()=>{const j=(code,x)=>{s.writeHead(code,{'content-type':'application/json'});s.end(typeof x==='string'?x:JSON.stringify(x))};if(q.url==='/api/tags')return j(200,tags);if(q.url==='/api/version')return j(200,{version:'0.11.4'});if(q.url==='/api/ps')return j(200,ps);if(q.url==='/api/show'){const m=(JSON.parse(b||'{}').model)||'';return m in shows?j(200,shows[m]):j(404,{error:'model not found'})}j(404,{error:'not found'})})}).listen(${port},'127.0.0.1')`
      startFixture('mercury-render-local-fixture.pid', port, serverJs, '/api/version')
      process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=http://127.0.0.1:${port}`
    }
    if (name === 'accounts-board-hf-signed-in') {
      writeFileSync(
        join(scratch, '.huggingface-auth.json'),
        JSON.stringify({
          version: 1,
          tokens: { accessToken: 'hf_oauth_render_fixture_access_0001', refreshToken: 'hf_oauth_render_fixture_refresh_0001', accessTokenExpiresAtMs: 4102444800000, scope: 'openid profile inference-api' },
          identity: { username: 'render-fixture', fullName: 'Render Fixture', observedAtMs: 1755820800000 },
          registeredClient: { clientId: '2fe1fbdb-ed49-4737-9676-035882bea588', hubBase: dead, issuedAtMs: 1755820800000 },
        }),
      )
    }
    if (name === 'model-picker-hf' || name === 'model-picker-local') {
      const steps = name === 'model-picker-hf' ? 22 : 45
      const downs = Array.from({ length: steps }, (_, k) => ({ atTick: 38 + k, data: '\u001b[B' }))
      return { argv: ['node', BIN], sends: [{ atTick: 30, data: '/model\r' }, ...downs], total: 38 + steps + 14, cols, rows }
    }
    if (name === 'accounts-board-hf-signed-in') {
      return { argv: ['node', BIN], sends: [{ atTick: 30, data: '/accounts' }, { atTick: 36, data: '\r' }], total: 70, cols, rows }
    }
    return {
      argv: ['node', BIN],
      sends: [{ atTick: 30, data: '/usage' }, { atTick: 36, data: '\r' }],
      total: 80, cols, rows,
      chromeMarkers: ['Config', 'Usage'],
    }
  }
  if (name === 'settings-usage' || name === 'settings-status-tab') {
    writeSyntheticSession('short')
    const sends = [
      { atTick: 30, data: '/usage' },
      { atTick: 36, data: '\r' },
      ...(name === 'settings-status-tab'
        ? [{ atTick: 70, data: '\u001b[D' }, { atTick: 76, data: '\u001b[D' }]
        : []),
    ]
    return {
      argv: ['node', BIN, '--resume', SID],
      sends,
      total: name === 'settings-status-tab' ? 105 : 80, cols, rows,
      chromeMarkers: ['Config', 'Usage'],
    }
  }
  if (name === 'router-board') {
    writeSyntheticSession('short')
    writeRouterFixtures()
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/router' }, { atTick: 36, data: '\r' }],
      total: 80, cols, rows,
    }
  }
  if (name === 'router-detail') {
    writeSyntheticSession('short')
    writeRouterFixtures()
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/router' },
        { atTick: 36, data: '\r' },
        { atTick: 70, data: '\r' },
      ],
      total: 110, cols, rows,
    }
  }
  if (name === 'health' || name === 'health-detail') {
    writeSyntheticSession('short')
    const sends = [{ atTick: 30, data: '/health' }, { atTick: 36, data: '\r' }]
    if (name === 'health-detail') {
      sends.push({ atTick: 66, data: '\u001b[B' }, { atTick: 70, data: '\u001b[B' }, { atTick: 76, data: '\r' })
    }
    return {
      argv: ['node', BIN, '--resume', SID],
      sends,
      total: name === 'health-detail' ? 105 : 80, cols, rows,
    }
  }
  if (name === 'provenance') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/provenance' }, { atTick: 36, data: '\r' }],
      total: 60, cols, rows,
    }
  }
  if (name === 'critter-home') {
    process.env.MERCURY_CRITTER = 'octopus'
    writeSyntheticSession('short')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 48, cols, rows }
  }
  if (name === 'critter-awake' || name === 'critter-sleep' || name === 'critter-flow') {
    if (name === 'critter-sleep') {
      process.env.MERCURY_CRITTER_SLEEP = '1'
    }
    if (name === 'critter-flow') {
      process.env.MERCURY_CRITTER_IDLE = '1'
    }
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/critter' }, { atTick: 36, data: '\r' }],
      total: 72, cols, rows,
    }
  }
  if (name === 'berth-sleep') {
    process.env.MERCURY_CRITTER_SLEEP = '1'
    writeSyntheticSession('short')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 56, cols, rows }
  }
  if (name === 'berth-ghost') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/model' }, { atTick: 36, data: '\r' }],
      total: 80, cols, rows,
    }
  }
  if (name === 'health-fault') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/health' }, { atTick: 36, data: '\r' }],
      total: 80, cols, rows,
    }
  }
  if (name.startsWith('concourse-r0-')) {
    const scratch = process.env.MERCURY_RENDER_SCRATCH || join(tmpdir(), `mercury-render-${name}-${process.pid}`)
    const emptyFixture = (): Record<string, unknown> => ({
      schema: 1,
      revision: 1,
      clock: '08:14:20',
      context: { projectLabel: 'Moodle', operatorHandle: 'sam', effortLabel: 'xhigh' },
      breadcrumb: { active: 'concourse' },
      coordinator: { mode: 'rules-only', assistModelLabel: 'GPT-5.6 Sol' },
      counts: { live: 0, needsYou: 0, working: 0, queued: 0, seatsHeld: 0, seatsDenominator: 0, admission: 'auto-balanced' },
      needsYou: [],
      groups: [],
      peek: null,
      newSession: {
        seeds: { projectLabel: 'Moodle', agentLabel: 'Mercury', modelLabel: 'GPT-5.6 Sol', modelIsDefault: true, effortLevel: 'high', effortIsDefault: true, isolation: 'isolated-worktree', seatsMax: 2 },
        draft: '',
      },
    })
    const noRailFixture = (): Record<string, unknown> => {
      const f = referenceFixtureSnapshot() as Record<string, unknown> & {
        counts: Record<string, unknown>
      }
      f['needsYou'] = []
      f.counts = { ...f.counts, needsYou: 0 }
      return f
    }
    const seedEnv = (fixture: Record<string, unknown>, policy: string | null): void => {
      rmSync(scratch, { recursive: true, force: true })
      seedFirstRun(scratch, [RUNTIME_CWD])
      applyRenderTheme(scratch)
      const fixturePath = join(scratch, 'concourse-fixture.json')
      const fixtureOverride = process.env.MERCURY_RENDER_FIXTURE
      const fixtureJson =
        fixtureOverride !== undefined && fixtureOverride.trim().startsWith('{')
          ? fixtureOverride
          : JSON.stringify(fixture)
      writeFileSync(fixturePath, fixtureJson)
      process.env.MERCURY_CONFIG_DIR = scratch
      process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
      if (policy === null) delete process.env.MERCURY_CONCOURSE
      else process.env.MERCURY_CONCOURSE = policy
      process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
      const daemonDir = process.env.MERCURY_RENDER_DAEMON_DIR || join(scratch, 'daemon')
      process.env.MERCURY_DAEMON_DIR = daemonDir
      process.env.MERCURY_DAEMON_DIR = daemonDir
      process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
      if (process.env.MERCURY_RENDER_SEED_OBLIGATIONS === '1') {
        try {
          const fx = JSON.parse(fixtureJson) as {
            needsYou?: Array<{ obligationId?: string; sessionId?: string; title?: string; question?: string }>
          }
          const crewDir = join(scratch, 'crew')
          mkdirSync(crewDir, { recursive: true })
          const { createHash } = require('node:crypto') as typeof import('node:crypto')
          const key = createHash('sha256').update(RUNTIME_CWD).digest('hex').slice(0, 16)
          const now = Date.now()
          const obligations: Record<string, unknown> = {}
          ;(fx.needsYou ?? []).forEach((o, i) => {
            if (!o.obligationId || !o.sessionId) return
            obligations[o.obligationId] = {
              schema: 1,
              obligationId: o.obligationId,
              ref: `fixture:${o.obligationId}`,
              sessionId: o.sessionId,
              question: o.question ?? o.title ?? 'fixture question',
              principals: [],
              owner: 'operator',
              status: 'open',
              createdOrdinal: i + 1,
              revision: 1,
              createdAtMs: now,
              updatedAtMs: now,
              settlementAttempts: [],
              notifications: {},
            }
          })
          writeFileSync(
            join(crewDir, `obligations-${key}.json`),
            JSON.stringify({ _v: 1, obligations, lastOrdinal: (fx.needsYou ?? []).length }),
          )
        } catch {
        }
      }
    }
    if (name === 'concourse-r0-empty') {
      seedEnv(emptyFixture(), 'always')
      return { argv: ['node', BIN], sends: [], total: 60, cols, rows }
    }
    if (name === 'concourse-r0-empty-enter') {
      seedEnv(emptyFixture(), 'always')
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, awaitText: 'no sessions', minTick: 5, awaitSettleTicks: 2, data: '\r' },
          { afterPrevTicks: 4, data: '\r' },
        ],
        total: 80,
        cols,
        rows,
      }
    }
    if (name === 'concourse-r0-select-move') {
      seedEnv(noRailFixture(), 'always')
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, awaitText: 'Fix OAuth callback', minTick: 5, awaitSettleTicks: 2, data: '\u001b[B' },
          { afterPrevTicks: 2, data: '\u001b[B' },
          { afterPrevTicks: 2, data: '\u001b[B' },
        ],
        total: 84,
        cols,
        rows,
      }
    }
    if (name === 'concourse-r0-filter') {
      seedEnv(referenceFixtureSnapshot(), 'always')
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 32, awaitText: 'answer & resume', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '\u001b[A' },
          { afterPrevTicks: 2, data: '/' },
          { afterPrevTicks: 2, awaitText: 'type to filter', awaitSettleTicks: 1, requireAwait: true, data: 'oauth' },
        ],
        total: 90,
        cols,
        rows,
      }
    }
    if (name === 'concourse-r0-click') {
      const at = (process.env.MERCURY_RENDER_CLICK ?? '').split(';').map(v => Number(v))
      const col = Number.isFinite(at[0]) && at[0]! > 0 ? at[0]! : 2
      const row = Number.isFinite(at[1]) && at[1]! > 0 ? at[1]! : 2
      const press = `\u001b[<0;${col};${row}M`
      const release = `\u001b[<0;${col};${row}m`
      const totalOverride = Number(process.env.MERCURY_RENDER_TOTAL ?? '')
      seedEnv(referenceFixtureSnapshot(), 'always')
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 32, awaitText: 'answer & resume', minTick: 5, awaitSettleTicks: 2, data: press + release },
          { afterPrevTicks: 2, data: press + release },
        ],
        total: Number.isFinite(totalOverride) && totalOverride > 0 ? totalOverride : 84,
        cols,
        rows,
      }
    }
    if (name === 'concourse-r0-suspend') {
      seedEnv(referenceFixtureSnapshot(), 'always')
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 32, awaitText: 'answer & resume', minTick: 5, awaitSettleTicks: 2, signal: 'SIGTSTP' },
          { afterPrevTicks: 10, signal: 'SIGCONT' },
          { afterPrevTicks: 10, mark: 'resumed', data: '\u001b[B' },
        ],
        total: 62,
        cols,
        rows,
      }
    }
    if (name === 'concourse-r0-alias') {
      seedEnv(noRailFixture(), null)
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 34, awaitText: '❯', minTick: 5, awaitSettleTicks: 2, data: '/concourse' },
          { afterPrevTicks: 3, data: '\r' },
        ],
        total: 100,
        cols,
        rows,
      }
    }
    if (name === 'concourse-r0-alias-resumed') {
      const fixturePath = join(tmpdir(), `sr-alias-resumed-fixture-${process.pid}.json`)
      writeFileSync(fixturePath, JSON.stringify(noRailFixture()))
      process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
      writeSyntheticSession('short')
      return {
        argv: ['node', BIN, '--resume', SID],
        sends: [
          { atTick: 34, awaitText: '\u276f', minTick: 5, awaitSettleTicks: 2, data: '/concourse' },
          { afterPrevTicks: 3, data: '\r' },
          { atTick: 90, awaitText: 'SESSIONS', minTick: 44, awaitSettleTicks: 3, data: '\u001b' },
        ],
        total: 120,
        cols,
        rows,
        chromeMarkers: ['\u276f', '\u256d', '\u2502', '\u2570', 'SESSIONS'],
      }
    }
    if (name === 'concourse-r0-esc-probe') {
      writeSyntheticSession('short')
      return {
        argv: ['node', BIN, '--resume', SID],
        sends: [
          { atTick: 40, awaitText: '\u276f', minTick: 5, awaitSettleTicks: 2, data: '\u001b' },
          { afterPrevTicks: 2, data: '\u001b' },
          { afterPrevTicks: 2, data: '\u001b' },
        ],
        total: 70,
        cols,
        rows,
        chromeMarkers: ['\u276f', '\u256d', '\u2502', '\u2570', 'Rewind'],
      }
    }
    if (name === 'concourse-r0-alias-escape') {
      const fixturePath = join(tmpdir(), `sr-alias-escape-fixture-${process.pid}.json`)
      writeFileSync(fixturePath, JSON.stringify(noRailFixture()))
      process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
      writeSyntheticSession('short')
      return {
        argv: ['node', BIN, '--resume', SID],
        sends: [
          { atTick: 34, awaitText: '❯', minTick: 5, awaitSettleTicks: 2, data: '/concourse' },
          { afterPrevTicks: 3, data: '\r' },
          { atTick: 70, awaitText: 'SESSIONS', minTick: 44, awaitSettleTicks: 2, data: '\u001b' },
          { afterPrevTicks: 1, data: '\u001b' },
          { afterPrevTicks: 1, data: '\u001b' },
          { afterPrevTicks: 1, data: '\u001b' },
        ],
        total: 110,
        cols,
        rows,
      }
    }
    if (name === 'concourse-r0-keys') {
      const seedKind = process.env.MERCURY_RENDER_SEED ?? 'noRail'
      const fixture = process.env.MERCURY_RENDER_FIXTURE
        ? (JSON.parse(process.env.MERCURY_RENDER_FIXTURE) as Record<string, unknown>)
        : seedKind === 'empty'
          ? emptyFixture()
          : seedKind === 'reference'
            ? referenceFixtureSnapshot()
            : noRailFixture()
      seedEnv(fixture, 'always')
      if (seedKind === 'live' && !process.env.MERCURY_RENDER_FIXTURE) {
        delete process.env.MERCURY_CONCOURSE_FIXTURE
      }
      const sends = JSON.parse(process.env.MERCURY_RENDER_KEYS ?? '[]') as Array<Record<string, unknown>>
      const total = Number(process.env.MERCURY_RENDER_TOTAL ?? 120)
      const resizes = JSON.parse(process.env.MERCURY_RENDER_RESIZES ?? '[]') as Array<Record<string, unknown>>
      const ready = process.env.MERCURY_RENDER_READY
      return {
        argv: ['node', BIN],
        sends,
        total,
        cols,
        rows,
        ...(resizes.length ? { resizes } : {}),
        ...(ready ? { readyText: JSON.parse(ready) as string | string[] } : {}),
      }
    }
    if (name === 'concourse-r0-route-cycle') {
      seedEnv(noRailFixture(), null)
      return {
        argv: ['node', BIN],
        sends: [
           { atTick: 34, awaitText: '❯', minTick: 5, awaitSettleTicks: 2, data: '/concourse' },
           { afterPrevTicks: 3, data: '\r' },
           { atTick: 80, awaitText: 'LIVE PEEK', minTick: 42, awaitSettleTicks: 2, data: '\u001b[A' },
           { afterPrevTicks: 2, mark: 'concourse-1', data: '\u001b[6;5~' },
           { atTick: 112, awaitText: 'Doctor / Health Check', minTick: 84, awaitSettleTicks: 2, data: '\u001b[A' },
           { afterPrevTicks: 2, mark: 'boot-settings', data: '\u001b[5;5~' },
           { atTick: 144, awaitText: 'LIVE PEEK', minTick: 116, awaitSettleTicks: 2, data: '\u001b[A' },
           { afterPrevTicks: 2, mark: 'concourse-2', data: '\r' },
           { afterPrevTicks: 10, data: '\u001b[A' },
           { afterPrevTicks: 2, mark: 'session', data: '\u001b' },
           { afterPrevTicks: 8, data: '\u001b[A' },
           { afterPrevTicks: 2, mark: 'concourse-3', data: '\u001b' },
           { afterPrevTicks: 8, data: '\u001b[A' },
           { afterPrevTicks: 2, mark: 'root-1', data: '/concourse' },
           { afterPrevTicks: 3, data: '\r' },
           { atTick: 216, awaitText: 'LIVE PEEK', minTick: 190, awaitSettleTicks: 2, data: '\u001b[A' },
           { afterPrevTicks: 2, mark: 'concourse-4', data: '\u001b' },
        ],
        total: 245,
        cols,
        rows,
      }
    }
    if (name === 'concourse-r0-session-enter') {
      seedEnv(noRailFixture(), 'always')
      return {
        argv: ['node', BIN],
        sends: [
          { atTick: 30, awaitText: 'Fix OAuth callback', minTick: 5, awaitSettleTicks: 2, data: '\r' },
          { afterPrevTicks: 3, data: '\r' },
          { afterPrevTicks: 10, data: 'hello' },
        ],
        total: 110,
        cols,
        rows,
        chromeMarkers: ['❯', '╭', '│', '╰', 'read-only', 'Mercury', 'SESSIONS', 'session'],
      }
    }
  }
  throw new Error(`unknown scenario: ${name}`)
}

export function routerFixtureDir(): string {
  return join(tmpdir(), `mercury-router-fixture-${process.pid}`)
}

function writeRouterFixtures(): void {
  const dir = routerFixtureDir()
  mkdirSync(dir, { recursive: true })
  process.env.MERCURY_ROUTER_STATE_DIR = dir
  const now = Date.now()
  const accept = (id: string): Array<{ id: string; description: string; kind: 'report' }> => [
    { id: `${id}-a1`, description: 'tests green', kind: 'report' },
  ]
  const model = (cls: 'opus' | 'sonnet', m: string, effort: string) => ({
    provider: 'anthropic', model: m, modelClass: cls, effort, contextWindow: 1_000_000,
  })
  const fanoutPlan = {
    version: 1,
    id: 'rp-fx-fanout',
    revision: 1,
    mode: 'fanout',
    title: 'ship the three-stage migration',
    objective: 'schema, then implementation and docs',
    features: { taskShape: 'bounded', ambiguity: 0, coupling: 1, parallelism: 2, contextDemand: 1, verificationDemand: 1, estimatedFiles: 3, explicitPaths: [], requiresSynthesis: true },
    profile: 'dependency-graph',
    nodes: [
      { id: 'n1', title: 'schema', task: 'migrate the schema', dependsOn: [], ownsPaths: ['src/schema.ts'], acceptance: accept('n1'), state: 'accepted', attempt: 1, assignedWorker: 'w1', assignedModel: model('sonnet', 'claude-sonnet-5', 'high'), busRequestId: 'fx-r1', expectedResult: 'typed completion', completion: { summary: 'schema migrated, both checks green', checksReported: ['schema compiles: PASS'], changedAreas: ['src/schema.ts'], unresolved: [], reportedAt: now - 200_000, acceptedBy: 'planner', acceptedAt: now - 190_000 } },
      { id: 'n2', title: 'implementation', task: 'implement against the new schema', dependsOn: ['n1'], ownsPaths: ['src/impl.ts'], acceptance: accept('n2'), state: 'working', attempt: 2, assignedWorker: 'w2', assignedModel: model('sonnet', 'claude-sonnet-5', 'high'), busRequestId: 'fx-r2', workerGeneration: 2, expectedResult: 'typed completion' },
      { id: 'n3', title: 'docs', task: 'update the docs', dependsOn: ['n1'], ownsPaths: ['docs/m.md'], acceptance: accept('n3'), state: 'held', attempt: 1, assignedWorker: 'w3', assignedModel: model('opus', 'claude-opus-4-8[1m]', 'xhigh'), busRequestId: 'fx-r3', expectedResult: 'typed completion' },
    ],
    synthesis: { required: true, owner: 'planner', acceptance: [{ id: 'synthesis-integrated', description: 'all required nodes accepted', kind: 'report' }] },
    decision: {
      policyVersion: 'router-1', source: 'structured-intent', posture: 'adaptive',
      selectedProfile: 'dependency-graph',
      selectedModels: [model('sonnet', 'claude-sonnet-5', 'high'), model('sonnet', 'claude-sonnet-5', 'high'), model('opus', 'claude-opus-4-8[1m]', 'xhigh')],
      decisiveReasons: ['ordered-dependencies'], displayReasons: ['nodes are separable but ordered — dependency graph'],
      adjustments: ['overlap-serialized'],
      workerAffinity: { keptCurrentModel: false, changeoverPenalty: 1, reason: 'decisive signal outweighs the fresh-process cost' },
    },
    state: 'running', createdAt: now - 300_000, updatedAt: now - 20_000,
  }
  const sequentialPlan = {
    version: 1,
    id: 'rp-fx-sequential',
    revision: 1,
    mode: 'sequential',
    title: 'status --json flag',
    objective: 'add the missing --json output mode',
    features: { taskShape: 'bounded', ambiguity: 0, coupling: 0, parallelism: 0, contextDemand: 1, verificationDemand: 1, estimatedFiles: 1, explicitPaths: ['src/commands/status.ts'], requiresSynthesis: false },
    profile: 'sonnet-opus-review',
    nodes: [
      { id: 'n1', title: 'status --json', task: 'add the flag + one test', dependsOn: [], ownsPaths: ['src/commands/status.ts'], acceptance: accept('n1'), state: 'accepted', attempt: 1, assignedWorker: 'implementer', assignedModel: model('sonnet', 'claude-sonnet-5', 'high'), busRequestId: 'fx-s1', expectedResult: 'typed completion', completion: { summary: 'flag added, test green', checksReported: ['new test: PASS'], changedAreas: ['src/commands/status.ts'], unresolved: [], reportedAt: now - 500_000, acceptedBy: 'scribe', acceptedAt: now - 490_000 } },
    ],
    synthesis: { required: false, owner: 'planner', acceptance: [] },
    decision: {
      policyVersion: 'router-1', source: 'structured-intent', posture: 'adaptive',
      selectedProfile: 'sonnet-opus-review',
      selectedModels: [model('sonnet', 'claude-sonnet-5', 'high')],
      decisiveReasons: ['bounded-implementation', 'affinity-kept-model'],
      displayReasons: ['well-specified implementation — executor lane with a review gate'],
      adjustments: [],
      workerAffinity: { keptCurrentModel: true, changeoverPenalty: 0, reason: 'current worker already runs the selected class' },
    },
    state: 'accepted', createdAt: now - 600_000, updatedAt: now - 480_000,
  }
  const events = [
    { ts: now - 200_000, planId: 'rp-fx-fanout', nodeId: 'n1', from: 'working', to: 'reported' },
    { ts: now - 190_000, planId: 'rp-fx-fanout', nodeId: 'n1', from: 'reported', to: 'accepted', reason: 'accepted by planner' },
    { ts: now - 180_000, planId: 'rp-fx-fanout', nodeId: 'n3', from: 'dispatched', to: 'held', reason: 'reconfiguring w3 → claude-opus-4-8[1m]@xhigh' },
    { ts: now - 20_000, planId: 'rp-fx-fanout', nodeId: 'n2', from: 'delivered', to: 'working' },
  ]
  writeFileSync(
    join(dir, 'plans.json'),
    JSON.stringify({ _v: 1, plans: [sequentialPlan, fanoutPlan], events, updatedAt: now - 20_000 }),
  )
}
const MISSION_FIXTURE_LIST = `render_fixture_${process.pid}`
const MISSION_TASKS_DIR = join(CONFIG_HOME, 'tasks', MISSION_FIXTURE_LIST)

function writeMissionLedgerFixture(): void {
  mkdirSync(MISSION_TASKS_DIR, { recursive: true })
  const mk = (
    id: string,
    subject: string,
    status: 'pending' | 'in_progress' | 'completed',
    activeForm?: string,
  ) =>
    writeFileSync(
      join(MISSION_TASKS_DIR, `${id}.json`),
      JSON.stringify({
        id,
        subject,
        description: subject,
        status,
        ...(activeForm ? { activeForm } : {}),
        blocks: [],
        blockedBy: [],
      }),
    )
  mk('1', 'Chart the reef current', 'in_progress', 'Charting the reef current')
  mk('2', 'Refit the tide gauges', 'pending')
  mk('3', 'Sound the harbor depth', 'pending')
  mk('4', 'Stow the survey gear', 'completed')
}

function cleanupMissionLedgerFixture(): void {
  delete process.env.MERCURY_TASK_LIST_ID
  try {
    rmSync(MISSION_TASKS_DIR, { recursive: true, force: true })
  } catch {
  }
}

const AGENT_STUDIO_FIXTURES = [
  join(RUNTIME_CWD, '.mercury', 'agents', 'studio-fix-writer.md'),
  join(RUNTIME_CWD, '.mercury', 'agents', 'dup-lens.md'),
  join(RUNTIME_CWD, '.claude', 'agents', 'dup-lens.md'),
  join(RUNTIME_CWD, '.claude', 'agents', 'broken-fixture.md'),
]

function writeAgentStudioFixtures(): void {
  const agentMd = (fields: string, body: string): string =>
    `---\n${fields}\n---\n\n${body}\n`
  mkdirSync(join(RUNTIME_CWD, '.mercury', 'agents'), { recursive: true })
  mkdirSync(join(RUNTIME_CWD, '.claude', 'agents'), { recursive: true })
  writeFileSync(
    AGENT_STUDIO_FIXTURES[0]!,
    agentMd(
      'name: studio-fix-writer\ndescription: "Use when drafting fix notes."\nmodel: sonnet\neffort: high\nmemory: project',
      'You write terse fix notes.',
    ),
  )
  writeFileSync(
    AGENT_STUDIO_FIXTURES[1]!,
    agentMd('name: dup-lens\ndescription: "The NATIVE lens (wins)."\nmodel: opus', 'Native lens body.'),
  )
  writeFileSync(
    AGENT_STUDIO_FIXTURES[2]!,
    agentMd('name: dup-lens\ndescription: "The legacy compat lens (shadowed)."', 'Compat lens body.'),
  )
  writeFileSync(
    AGENT_STUDIO_FIXTURES[3]!,
    '---\nname: broken-fixture\n---\n\nNo description on purpose.\n',
  )
}

export function cleanupScenario(name: string): void {
  if (name === 'copy-receipt-ctrlc') {
    const cfgPath = join(CONFIG_HOME, '.mercury.json')
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      delete cfg['copyOnSelect']
      writeFileSync(cfgPath, JSON.stringify(cfg))
    } catch {
    }
  }
  if (name.startsWith('accounts-board-') || name === 'model-picker-operator-shape') {
    for (const [path, prior] of accountsBoardStash) {
      try {
        if (prior === null) rmSync(path, { force: true })
        else writeFileSync(path, prior)
      } catch {
      }
    }
    accountsBoardStash.clear()
    if (accountsBoardEnvStash) {
      if (accountsBoardEnvStash.prevHome === undefined) delete process.env.HOME
      else process.env.HOME = accountsBoardEnvStash.prevHome
      if (accountsBoardEnvStash.prevStore === undefined) delete process.env.MERCURY_CREDENTIAL_STORE
      else process.env.MERCURY_CREDENTIAL_STORE = accountsBoardEnvStash.prevStore
      if (accountsBoardEnvStash.scratchHome) {
        try {
          rmSync(accountsBoardEnvStash.scratchHome, { recursive: true, force: true })
        } catch {
        }
      }
      accountsBoardEnvStash = null
    }
  }
  if (name === 'model-picker-hf' || name === 'settings-usage-hf' || name === 'model-picker-local' || name === 'settings-usage-local') {
    const pidFile = join(tmpdir(), name.endsWith('-hf') ? 'mercury-render-hf-fixture.pid' : 'mercury-render-local-fixture.pid')
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(pid) && pid > 1) process.kill(pid)
    } catch {
    }
    try {
      rmSync(pidFile, { force: true })
    } catch {
    }
  }
  if (name === 'login-kimi-device') {
    const pidFile = join(tmpdir(), 'mercury-render-kimi-fixture.pid')
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(pid) && pid > 1) process.kill(pid)
    } catch {
    }
    try {
      rmSync(pidFile, { force: true })
    } catch {
    }
  }
  if (name === 'model-picker-gpt' || name === 'model-picker-gpt-toggle' || name === 'submodels-gpt') {
    const pidFile = join(tmpdir(), 'mercury-render-gpt-fixture.pid')
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(pid) && pid > 1) process.kill(pid)
    } catch {
    }
    try {
      rmSync(pidFile, { force: true })
    } catch {
    }
  }
  if (name.startsWith('agents-studio')) {
    for (const f of AGENT_STUDIO_FIXTURES) {
      try {
        rmSync(f, { force: true })
      } catch {
      }
    }
    for (const dir of [
      join(RUNTIME_CWD, '.mercury', 'agents'),
      join(RUNTIME_CWD, '.claude', 'agents'),
    ]) {
      try {
        rmdirSync(dir)
      } catch {
      }
    }
  }
  if (name === 'cockpit-console' || name === 'tasks-mission') {
    cleanupMissionLedgerFixture()
  }
  if (name.startsWith('companion-')) {
    process.env.MERCURY_DECK_COMPANION = '0'
  }
  try {
    rmSync(join(tmpdir(), `mercury-render-tabula-${process.pid}`), { recursive: true, force: true })
  } catch {
  }
  if (name === 'critter-home') {
    delete process.env.MERCURY_CRITTER
  }
  if (name === 'critter-sleep' || name === 'berth-sleep') {
    delete process.env.MERCURY_CRITTER_SLEEP
  }
  if (name === 'critter-flow') {
    delete process.env.MERCURY_CRITTER_IDLE
  }
  try { rmSync(join(PROJECTS, `${SID}.jsonl`)) } catch {  }
  if (name === 'resume-picker') {
    try { rmSync(join(PROJECTS, `${SID_ERRORED}.jsonl`)) } catch {  }
  }
  if (
    name === 'workflows-live-past' ||
    name === 'workflows-live-run' ||
    name === 'workflows-live-inspector' ||
    name === 'workflows-live-carryback' ||
    name === 'workflows-live-arrows'
  ) {
    cleanupWorkflowFixtures()
  }
  if (name === 'workflows-external') {
    cleanupExternalWorkflowFixtures()
  }
  reapDeadPidFixtures()
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
function reapDeadPidFixtures(): void {
  try {
    for (const entry of readdirSync(WF_RUNS_ROOT)) {
      const m = /^wf_fixture_[a-z]+_([0-9a-f]{6})$/.exec(entry)
      if (!m) continue
      if (!pidAlive(parseInt(m[1]!, 16))) {
        try { rmSync(join(WF_RUNS_ROOT, entry), { recursive: true, force: true }) } catch {  }
      }
    }
  } catch {  }
  try {
    for (const entry of readdirSync(PROJECTS)) {
      const m = /^00000000-aaaa-bbbb-[cd]{4}-([0-9a-f]{12})\.jsonl$/.exec(entry)
      if (!m) continue
      if (!pidAlive(parseInt(m[1]!, 16))) {
        try { rmSync(join(PROJECTS, entry)) } catch {  }
      }
    }
  } catch {  }
}
