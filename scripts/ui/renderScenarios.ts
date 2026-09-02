import { execSync, spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmdirSync, rmSync, utimesSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { REJECT_MESSAGE } from '../../src/utils/messages/rejectionText.ts'
import {
  STREAM_FAULT_RECOVERY_NUDGE,
  streamFaultAfterPartialText,
} from '../../src/services/api/errors.ts'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { entryToRecord } from '../../src/fabric/entryCodec.ts'
import { ordinalOf } from '../../src/fabric/ordinal.ts'
import { saveBootDefaultsProfile } from '../../src/substrate/startupMenu.ts'
import { referenceFixtureSnapshot } from '../notifications/concourseReferenceSeed.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { resolveProofHome } from '../lib/proofHome.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
// CONFIG_HOME (the ONE home the fixture writer and every spawned TUI share)
// is defined below RUNTIME_CWD — the helper that answers it seeds trust for
// the cwd the child boots in.
// The cwd the spawned TUI boots in, and the SOURCE of the session-staging
// slug below. This was a hardcoded
// operator-machine absolute path — on any other machine (the CI shards) the
// path did not exist, so every PTY prover pinning `cwd: RUNTIME_CWD` died
// with ENOENT and every staged session 404'd on a foreign slug. The
// invariant was never "the main checkout's literal path"; it is "the slug
// MUST be derived from the SAME directory the child boots in". Deriving
// both from one dynamic root satisfies it everywhere: the main checkout, a
// worktree (stages under the worktree's own slug — a cross-checkout slug
// mismatch cannot occur), and CI. `MERCURY_RENDER_CWD` stays as an explicit
// override seam.
// Exported so PTY provers pin their child cwd to the SAME path the slug
// derives from.

/** FN-008 §2 (the light-theme matrix): MERCURY_RENDER_THEME rewrites the
 *  seeded home's theme so a journey can LOOK at any appearance family —
 *  the env seam lives at the HARNESS (the product reads config only). The
 *  patch lands in the SAME global config the ONE seeder writes —
 *  `<home>/.mercury.json`, the file getGlobalMercuryFile (utils/env.ts)
 *  resolves; the `.claude.json` spelling is never adopted. The seam must
 *  ride EVERY seeding path — a seam living in only one seedEnv family
 *  leaves the BASE 'concourse' scenario (the theme matrix's actual target)
 *  unthemed. One helper, every seeding path.
 */
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
  // Dark-only ruling: a stored non-dark theme now COLLAPSES to
  // dark at the resolution owner — the matrix keeps driving the dormant
  // families through their gate, MERCURY_THEME_PIN (its registry-stated
  // purpose), which the child inherits from this env.
  process.env.MERCURY_THEME_PIN = renderTheme
}

export const RUNTIME_CWD = (process.env.MERCURY_RENDER_CWD ?? REPO).normalize('NFC')
// The proof's config home (scripts/lib/proofHome.ts): an inherited
// MERCURY_CONFIG_DIR pin as-is, otherwise a fresh seeded scratch exported
// into process.env so the spawned TUI resolves the SAME home the fixtures
// are staged under (getMercuryHome honours MERCURY_CONFIG_DIR first) —
// never a directory that belongs to another program. Seeding is the ONE
// seeder's (firstRunSeed.ts: absent-only, trust keyed by RUNTIME_CWD).
// Exported so every spawner pins the vshot child to this exact value.
export const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
// Per-process session id (audit U20): concurrent render-tui invocations (the
// routine 80+120 dual render) staged/cleaned ONE shared fixture file and raced.
export const SID = `00000000-aaaa-bbbb-cccc-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`
// Second per-process session id, for scenarios that need TWO sessions on disk
// at once (resume-picker) — same U20 pid-suffix race-guard as SID, distinct
// third group so both files coexist and clean up independently.
export const SID_ERRORED = `00000000-aaaa-bbbb-dddd-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`

// /workflows live-board fixtures — PID-suffixed (same U20 race the SID comment
// above documents: a concurrent 80+120 dual render must not share one fixture
// run dir). Two run.json manifests are seeded directly under the SPAWNED
// binary's cwd (RUNTIME_CWD, NOT REPO — see the note above) at
// <RUNTIME_CWD>/.claude/workflows/runs/<runId>/run.json — the exact layout
// WorkflowTool/runManifest.ts's workflowRunsRoot(cwd) reads.
const WF_SUFFIX = (process.pid % 0xffffff).toString(16).padStart(6, '0')
const WF_RUN_COMPLETED = `wf_fixture_completed_${WF_SUFFIX}`
const WF_RUN_STALE = `wf_fixture_stale_${WF_SUFFIX}`
const WF_RUN_PAUSED = `wf_fixture_paused_${WF_SUFFIX}`
const WF_RUN_EXT_LIVE = `wf_fixture_extlive_${WF_SUFFIX}`
const WF_RUN_EXT_WEDGED = `wf_fixture_extwedged_${WF_SUFFIX}`
// the SOURCE root : fixture and board derive from ONE seam
const { workflowRunsRoot } = await import('../../src/tools/WorkflowTool/runManifest.js')
const WF_RUNS_ROOT = workflowRunsRoot(RUNTIME_CWD)
const WF_FIXTURE_AGENT_ID = 'fxagentA'

// A long single-line prose message — exercises transcript WRAP width. Short
// messages (the resume-2turn pair) never wrap wide enough to hit the cockpit's
// right rail, which is exactly how the rail-overlap bug shipped. The cockpit-wide
// scenario forces wrapping so a render proves the transcript stays in its column.
const LONG_PROSE =
  'as coming you gave up something you could not name and the vast indifferent sea at his back ' +
  'was only the shape of every harbor he had ever left behind with no instruction and no mercy ' +
  'and the bones of broken ships carried no warning to the man who had once worn the far country ' +
  'like a second skin and now he had neither port to keep him warm nor any pretense left to sell.'

// Stress content: an unbreakable long URL (can't wrap — the classic overflow
// hazard the live screenshot showed), a fenced code block, and a wide table row.
// Exercises the center transcript at the reduced cockpit width.
const LONG_URL =
  'see https://commoncultureintl.example.com/very/long/unbreakable/path/segment/that/cannot/wrap/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?q=1 for the spec'
const CODE_BLOCK =
  'here:\n```ts\nexport function aVeryLongFunctionNameThatRunsToTheEdge(argumentOne: string, argumentTwo: number): Promise<void> { return doTheThing() }\n```\ndone'
const TABLE_ROW =
  '| column-one-header | column-two-header | column-three-header | column-four-header | column-five-header |'

// Tool-card fixtures for the 'tool-cards' scenario (inline-short-results
// coverage): an assistant tool_use + its user tool_result pair, mirroring the
// REAL persisted shapes (toolUseResult carries the structured per-tool data —
// sampled from live session logs, not invented).
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
// a Structure preview carrying the inline change-view payload
// (real structuredPatch-shaped hunks) — drives the ONE premium semantic-edit
// card (syntax-aware per-file diffs · counts · diagnostics · refs).
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
// fixtures: the ChangeSet aggregate inline change view across its
// state vocabulary — applied (multi-file + a NAMED omitted-hunk cut + an
// already-satisfied member), all-no-change, and stale (next action).
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
// Lifecycle fixtures (interaction-finish slice 6): a RESOLVED Edit with a
// real structuredPatch (the settled card + its honest ±counts) and an
// UNRESOLVED Bash (no tool_result → the queued/unresolved card) — the
// one-card-per-tool-id contract across the whole lifecycle.
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
    // FULL FileEditTool outputSchema shape — a partial object fails the zod
    // parse and the settled diff card silently never paints.
    filePath: RUNTIME_CWD + '/lifecycle-demo.txt',
    oldString: 'alpha', newString: 'omega',
    originalFile: 'alpha\n',
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-alpha', '+omega'] }],
    userModified: false,
    replaceAll: false,
  },
}
// fixtures: the honest no-change cards — an identical-hunk Edit
// and a byte-identical Write. toolUseResult carries the FULL output shapes
// (incl. the noChange marker); render-nochange-cards.ts asserts the dim
// "No changes" rows paint instead of update/create cards.
// MACHINE-NEUTRAL (the F6 ambient-state law, gate run 30062498903): the path
// derives from the BOOT cwd so the renderer relativizes it to the bare
// filename on every machine — a baked absolute calibration-machine path
// rendered as a WRAPPED absolute path on the CI runner and the single-line
// row grep could never match.
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
  content: [{ type: 'tool_result', tool_use_id: 'toolu_read1', content: [{ type: 'text', text: '{\n  "name": "hermes"\n}' }] }],
  toolUseResult: {
    type: 'text',
    file: { filePath: RUNTIME_CWD + '/package.json', content: '{\n  "name": "hermes"\n}', numLines: 3, startLine: 1, totalLines: 3 },
  },
}
// Click-to-expand fixtures: an Agent (Task) tool_use + COMPLETED
// result whose report is hidden behind the collapsed `Done (…)` line, a lone
// Glob result (`Found N files ⌄`, not grouped — a single search never joins a
// collapsed_read_search group), and a long is_error tool_result (the fork's
// classified error card folds its body). All three must toggle open on click.
const AGENT_REPORT_LINE = 'REPORT-LINE the manifest pins bun 1.2 and the build is green.'
const TOOL_USE_AGENT = {
  type: 'tool_use', id: 'toolu_agent1', name: 'Agent',
  input: { description: 'Scout the manifest', prompt: 'Read package.json and report.', subagent_type: 'Explore' },
}
const TOOL_RESULT_AGENT = {
  content: [{ type: 'tool_result', tool_use_id: 'toolu_agent1', content: [{ type: 'text', text: AGENT_REPORT_LINE }] }],
  toolUseResult: {
    // Must PASS AgentTool's outputSchema (syncOutputSchema) — a failed parse
    // makes UserToolSuccessMessage render null (an invisible row).
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
// The lone-error leg reuses TOOL_USE_EDIT_ERR + EDIT_ERROR_TEXT below (the
// 'errors' variant's fixture): Edit is non-collapsible, so its is_error row
// stays OUT of collapsed_read_search groups — the exact row the
// isToolErrorResultTruncated clickable branch guards.
// A Workflow tool_use + its async_launched result — exercises the INLINE
// renderers (renderToolUseMessage description line + renderToolResultMessage's
// live-subscribed result line; with no live AppState task the result falls to
// the honest "/workflows to view" branch, proving the renderer mounts + paints
// in the real binary rather than the old null stub).
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

// Failure-state fixtures (the 'errors' variant → errors-transcript + resume-picker).
// The errored TOOL is Edit, deliberately NOT Bash/Read: under fullscreen the home
// view collapses read/run groups — Bash included (collapseReadSearch.ts) — into a
// one-line summary that would hide the card under test. Edit is non-collapsible,
// so its is_error result reaches the fork's FallbackToolUseErrorMessage classified
// fold — and ONLY the default view paints the fold (verbose/ctrl+o deliberately
// falls through to the raw uncapped lines), so the scenario captures the resumed
// home view with no keys sent.
// FIXTURE PATHS ride RUNTIME_CWD (the F6 ambient-state law,
// round 11): a path INSIDE the capture cwd relativizes to the same short
// `src/…` display on every machine. The old operator-absolute spellings
// rendered short on the calibration machine but absolute/wrapped on CI —
// the tool header's glyph and its path needle landed on DIFFERENT rows.
const TOOL_USE_EDIT_ERR = {
  type: 'tool_use', id: 'toolu_editerr1', name: 'Edit',
  input: {
    file_path: join(RUNTIME_CWD, 'src', 'utils', 'cockpit', 'missing-manifest.ts'),
    old_string: 'export const manifest', new_string: 'export const manifestV2',
  },
}
// A DENIED Edit (permission rejected) — the tool_result carries the canonical
// REJECT_MESSAGE. Paired with TOOL_USE_EDIT_ERR in the 'denials' variant so one
// capture shows the split: this card leads with the CRIMSON ✕ (the operator
// said no), the ENOENT card beside it with the AMBER ▲ (ordinary failure).
// Edit is non-collapsible, so BOTH reach FallbackToolUseErrorMessage.
const TOOL_USE_EDIT_DENIED = {
  type: 'tool_use', id: 'toolu_editdeny1', name: 'Edit',
  input: {
    file_path: join(RUNTIME_CWD, 'src', 'prod-rollout.ts'),
    old_string: 'const rollout = false', new_string: 'const rollout = true',
  },
}
// Multi-line + `    at ` frames + ENOENT: exercises the headline glyph, the
// FAINT body line, the `└ +3 stack frames` fold row, AND the errno hint row of
// classifyToolError in one card.
const EDIT_ERROR_TEXT = [
  `Error: ENOENT: no such file or directory, open '${join(RUNTIME_CWD, 'src', 'utils', 'cockpit', 'missing-manifest.ts')}'`,
  'The target file could not be read before editing.',
  '    at Object.openSync (node:fs:601:3)',
  '    at readFileSync (node:fs:469:35)',
  '    at applyEdit (src/tools/FileEditTool/applyEdit.ts:42:19)',
].join('\n')
// The persisted API-error shape (createAssistantAPIErrorMessage): top-level
// isApiErrorMessage + the `API Error: ` text prefix. The fork card splits the
// first sentence CRIMSON-bold and folds the trailing JSON blob to a char count.
// The same top-level field is what scanTailForEndedOnError rules on, so a
// session TAILING on this line doubles as the resume-picker's
// `✕ ended on error` trigger.
const API_ERROR_TEXT =
  'API Error: 529 overloaded. The upstream service is shedding load — wait a moment before retrying. ' +
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_fixture_529"}'

// the continuable-class fault text, composed through the OWNED
// composer so the fixture can never drift from the real transports.
const STREAM_FAULT_TEXT = streamFaultAfterPartialText(
  'OpenAI',
  'server_error',
  'stream closed unexpectedly mid-response',
)

// Exported for standalone proof legs (prove-sessiontab-switch drives a second
// fixture through the REAL /sessiontab flip) — scenario() remains the normal
// entry; callers must pin env exactly like scenario() does before spawning.
/** Belt: purge any durable prompt DRAFT keyed by a synthetic fixture SID —
 *  a prior run's child killed while a modal was up can leave one (drafts
 *  are per-session), and a leaked draft prefixes the next fixture's typed
 *  sends ('/party' became '/party/party' — measured). Sync +
 *  fail-soft; only ever touches <configHome>/drafts/*.json entries whose
 *  key matches the given SID. */
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
        /* unreadable file — leave it */
      }
    }
  } catch {
    /* fail-soft: hygiene only */
  }
}

/** Encode fixture entry rows as the transcript's record lines — the same
 *  codec the writer rides, with a deterministic per-file ordinal clock. */
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
    isSidechain: false, userType: 'external', entrypoint: 'cli',
 // cwd = RUNTIME_CWD (F6, round 13): the first message's cwd
    // becomes LogOption.projectPath, and project-scoped surfaces (/sessiontab,
    // the RECENT lane) filter on it — a baked operator path made every
    // synthetic session "another project's" on CI, so the /sessiontab flip
    // honestly refused while the CLI --resume (cross-project reach) worked.
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
        // Errored tool_result: content is the raw error STRING (the production
        // persisted shape for tool failures — and the only shape the classifier
        // folds; an array here would render the generic 'Tool execution failed').
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
        // The plain-timeout card — its hint must help the UNSET
        // operator (this capture runs without API_TIMEOUT_MS in the env, so
        // the "slow link? set API_TIMEOUT_MS" variant is the one painted).
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
        // The status-glyph DENIAL split (task #1): a DENIED Edit (tool_result =
        // REJECT_MESSAGE) and an ERRORED Edit (ENOENT) back-to-back. Both are
        // non-collapsible ⇒ each renders its own card, so one capture shows the
        // ✕ CRIMSON (denied) beside the ▲ AMBER (ordinary failure) — the whole
        // point of the split, proven by prove-denied-glyph-split.ts.
        base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
          message: { role: 'user', content: 'flip the rollout flag, then fix the manifest edit' },
          timestamp: '2026-06-19T12:00:01.000Z' }),
        base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_synth_d1',
          message: { id: 'msg_synth_d1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
            content: [TOOL_USE_EDIT_DENIED], stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-06-19T12:00:02.000Z' }),
        // Denied tool_result: is_error, content is the canonical REJECT_MESSAGE
        // STRING (the persisted shape for a permission rejection).
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
 // a RECOVERED continuable stream fault — partial prose,
        // the marker-carrying API-error message, the OWNED recovery nudge
        // (isMeta), then the continuation. Default view must render the
        // restrained ▲ "resumed" row, never the CRIMSON terminal card
        // (prove-stream-fault-presentation.ts asserts on this fixture).
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
        // Sweep #2 (packets 8 + 11): a settled response carrying a
        // tight nested list, an ordered list with a continuation line, and a
        // horizontal rule followed by prose — items stack, continuations
        // hang, the rule ends its own line.
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
        // Sweep #2 (round-1 deferral 34): two shell commands with a
        // todo rewrite between them — the checklist update defers behind the
        // ONE collapsed shell row instead of splitting it in two.
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
 // an identical-hunk Edit + a byte-identical Write — the
        // honest no-change cards (dim "No changes" rows, never update/create
        // views). render-nochange-cards.ts asserts at 80 + 120.
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
        // One-card-per-tool-id lifecycle (interaction-finish slice 6): a
        // RESOLVED Edit (settled summary must appear exactly once — the
        // inline dispatcher suppresses the downstream block) and an
        // UNRESOLVED Bash (no result row → the queued/unresolved card).
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
        // transition preview-card choreography: a history carrying an OpenAI
        // continuation record (apexProviderTurn) — ANY model switch away
        // from the served id resets it, so `/model sonnet` computes a
        // needs_choice plan (stateless-replay-reset) and parks at the card.
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
        // Item D (provider-uniform turn rendering): a SETTLED GPT turn whose
        // content carries [thinking, text]. The default view must show the
        // prose ONLY — no in-chat thinking expander for the openai route
        // (reveal modes keep the reasoning; the quiet-stream dim line is a
        // live-turn state a settled fixture cannot carry).
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
        // Thinking-disclosure coverage: an assistant
        // message whose content is [thinking, text]. normalizeMessages splits
        // it into two rows; the finalized thinking row must render as the
        // collapsed `∴ Thinking ⌄` disclosure line in the DEFAULT view (the
        // old dispatch nulled it — reasoning silently unreachable), with the
        // answer prose beneath it.
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
        // Click-to-expand coverage: agent result + lone glob + folded error.
        // Assistant TEXT turns interleave the tool pairs so consecutive
        // collapsible ops never fuse into a collapsed_read_search group —
        // each result must render as its OWN clickable row.
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
        // dead-click instrument coverage: TWO separate single-Bash collapsed
        // rows ("Ran 1 bash command ⌄" each — text turns between them keep
        // the groups from fusing) so a click prover can drive BOTH the
        // most-recent row and the further-up row. The field report: only the
        // most recent expanded.
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
        // Filler turns force the transcript PAST the viewport so the scrollbox
        // actually scrolls (auto-follow at the tail) — the field shape: the
        // older collapsed row visible near the viewport top of scrolled
        // content. Chained sequentially (a shared parent would FORK the
        // session and the leaf-walk would drop the second bash group).
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
        // A fork child's transcript head: the buildChildMessage shape — the
        // <fork-boilerplate> rules envelope + `Your directive: …` tail. The
        // UserForkBoilerplateMessage renderer must lead with the directive and
        // collapse the rules to a dim one-liner (never the raw XML wall).
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
        // A transcript whose TAIL is two inbound channel pushes in the exact
        // wrapChannelMessage shape (source first, optional user, \n-wrapped
        // body): the local-bus two-user row (`← local · kim: …`) and a
        // an extension's MCP server push (displayServerName shows the leaf,
        // `← slack: …`). UserTextMessage must dispatch both to
        // UserChannelMessage — the severed-wire relanding's render surface.
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
        // EXACTLY the triple a local /model run persists (processSlashCommand /
        // createModelSwitchBreadcrumbs): the isMeta caveat + the command
        // breadcrumb + the local-stdout ack. NO conversation — the landing
        // (mascot hero + lockup + session table) must survive a resume onto
        // this transcript (the model-switch mascot-vanish report;
        // asserted by render-model-switch.ts on the 'model-switch-home'
        // scenario, predicate-locked by prove-home-hero-noise.ts).
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
 // an ASSISTANT markdown link — the transcript
        // markdown owner (createHyperlink) wraps it in OSC 8, and the
        // per-cell writer paths must carry the opener across repaints
        // (FRAME-WRITER-LINK-FIDELITY; prove-link-journey.py's tee laws).
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
    ? // 18 turn PAIRS — content far taller than any capture viewport, so a
      // scenario can actually SCROLL (the rail-drag repro class needs real
      // scroll-away; the other variants all fit a 40-row screen).
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
          // A wide-glyph (CJK) prompt so the cell-parity width law has real
          // wide cells to police in the prompts panel's receipt roll.
          message: { role: 'user', content: 'second task — 日本語の確認' }, timestamp: '2026-06-19T12:00:02.000Z' }),
      ]
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  writeFileSync(join(PROJECTS, `${sid}.jsonl`), encodeFixtureTranscript(lines, sid))
}

// Seeds two run.json manifests (WorkflowsBoard's Past section, disk-sourced —
// no matching AppState task in this synthetic render) plus ONE synthetic
// agent transcript so the 'workflows-live-inspector' scenario can drill all
// the way to a real PROMPT/ACTIVITY/OUTCOME read:
//   - wf_fixture_completed_<pid>: status 'completed', 2 phases (design/build),
//     2 agents, transcriptDir holding agent-fxagentA.jsonl (a real read/tool
//     call/final-text so the inspector's expand-all has something to show).
//   - wf_fixture_stale_<pid>: status 'running', ownerPid 999999 (no such
//     process) AND a manifest mtime backdated past RUN_MANIFEST_STALE_MS
//     (45s) — isRunOrphaned must read this as stale, not a live spinner.
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
 // longOut item 9): a multi-line result that EXCEEDS the
          // inspector's out ceiling, so the clipped→`e expand` path renders.
          // The first line stays identical — every existing needle holds.
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

  // A persisted script beside the manifest so the run view's `S save` control
  // arms (scriptPath must point at a readable file).
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
    totalToolCalls: 19,
    // phaseIndex is deliberately 1-BASED here — the pre-fix executor era's
    // shape. The title-merging projector (groupAgentsByPhase) must HEAL these
    // rows into the planned design/build buckets: the run view render proves
    // no duplicate "design (0)/design (1)" pair survives (task #3).
    agents: [
      {
        agentId: WF_FIXTURE_AGENT_ID, index: 0, label: 'design', state: 'done',
        phaseIndex: 1, phaseTitle: 'design', model: 'claude-opus-4-8', effort: 'high',
        tokens: 12_400, toolCalls: 9, durationMs: 45_000, attempt: 1,
        startedAt: now - 115_000, queuedAt: now - 120_000,
        promptPreview: 'Design the /substrate gate panel — schema, honest planned/gated states.',
        lastToolName: 'Read', lastToolSummary: 'src/components/SubstratePanel.tsx',
        resultPreview: 'Design complete — contract shipped, honest planned/gated states covered.',
      },
      {
        agentId: 'fxagentB', index: 1, label: 'build', state: 'done',
        phaseIndex: 2, phaseTitle: 'build', model: 'claude-opus-4-8',
        tokens: 17_300, toolCalls: 10, durationMs: 60_000, attempt: 1,
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
    ownerPid: 999999, // no such process — pidAlive() must return false
    agentCount: 1,
    totalTokens: 4_200,
    totalToolCalls: 3,
    agents: [
      {
        agentId: 'fxagentC', index: 0, label: 'scan', state: 'progress',
        phaseIndex: 0, phaseTitle: 'scan', model: 'claude-opus-4-8',
        tokens: 4_200, toolCalls: 3, attempt: 1,
 // (workflows-live-backoff): the producer's liveness fields —
        // the lane must NAME the provider wait instead of "thinking".
        // lastProgressAt sits far in the future so the pulse stays FRESH for
        // the whole capture regardless of runner speed (agentPulse floors
        // negative ages to 0); a real run keeps it fresh via the recovery
        // heartbeat re-emits.
        waiting: 'provider-backoff', retryInMs: 45_000, retryAttempt: 2,
        lastProgressAt: now + 3_600_000,
      },
    ],
  }
  const staleManifestPath = join(runDirStale, 'run.json')
  writeFileSync(staleManifestPath, JSON.stringify(staleManifest))
  // Backdate the manifest's mtime past RUN_MANIFEST_STALE_MS (45s) so
  // isRunOrphaned's heartbeat check reads this 'running' row as stale — a
  // freshly-written file's real mtime would be "now", never triggering it.
  const old = new Date(now - 120_000)
  utimesSync(staleManifestPath, old, old)

 // Third fixture opt-in): a PAUSED run whose settle projected its
  // in-flight children — one 'stopped' (parent settled mid-flight) and one
  // operator-'skipped' beside a 'done' sibling. The settled scenario's render
  // pins the lane words: stopped/skipped must read muted, never as errors and
  // never as motion. Oldest startTime ⇒ sorts LAST in Past, so the existing
  // scenarios' row order (completed, stale) is untouched.
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
  // ONLY the fixture run dirs this process created — never the runs root
  // (a shared, cwd-scoped directory a real /workflows session also writes to).
  for (const dir of [
    join(WF_RUNS_ROOT, WF_RUN_COMPLETED),
    join(WF_RUNS_ROOT, WF_RUN_STALE),
    join(WF_RUNS_ROOT, WF_RUN_PAUSED),
  ]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* already gone */
    }
  }
}

// Seeds the 'workflows-external' scenario: TWO claims-running manifests owned by
// THIS render-tui process (ownerPid: process.pid — alive by construction for the
// whole capture; vshot.py and the binary are our children), with no matching
// AppState task in the spawned binary, so partitionDiskRuns files BOTH under the
// board's conditional External section (WorkflowsBoard.tsx):
//   - extlive: FRESH mtime (just written) ⇒ runLiveness 'live' ⇒ word 'run' +
//     'running elsewhere'. Freshness window: RUN_MANIFEST_STALE_MS is 45s, so
//     the board must READ the manifest within 45s of this write — the tick
//     budget keeps a first attempt well inside; the oracle's RETRY attempt can
//     land past it, decaying this row honestly to 'wedged' (the capture is
//     still valid — the section + both rows are the assert-by-eye target; the
//     per-row 'run' word is checked on a first-attempt render).
//   - extwedged: mtime forced 120s back (utimesSync, past the 45s heartbeat)
//     with the owner pid STILL ALIVE ⇒ 'wedged' + 'heartbeat silent, pid alive'
//     — the hung-engine word, distinct from the orphan the stale fixture above
//     exercises (dead pid ⇒ quiet Past row).
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
      /* already gone */
    }
  }
}

// ── DIST-FRESHNESS GUARD (the stale-dist wrong-build class) ────
// Every scenario boots BIN. A dist built from a DIFFERENT tree than the
// source under verification makes every capture a wrong-build observation —
// a stale dist masquerades as a product bug.
// Compare the manifest's buildTree — build.ts's
// WORKING-TREE hash (temp-index `add -A` + `write-tree`, dirty edits
// included) — against the same hash recomputed NOW, once per process
// (~1.2s). Skips: MERCURY_GATE_PREBUILT=1 (the pool's Phase-0 rebuild
// already guarantees every suite the same fresh build) and
// MERCURY_STALE_DIST_OK=1 (a capture that deliberately binds a historical
// dist must say so at its call site). Best-effort like the stamp itself:
// no manifest / non-git checkout ⇒ no verdict (the boot fails on its own
// terms).
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
    // The manifest stamps the WHOLE tracked tree (the /doctor content
    // binding — build.ts's scope, not ours to narrow). For CAPTURE
    // freshness only bundle inputs matter: a docs/scripts/rules edit does
    // not change the binary, and refusing on it made every lane brittle to
    // its own ledger writes (the acceptance-JSON flip staled
    // every later repro in the same run). Accept iff EVERY path in the
    // tree-to-tree delta is a known non-input; anything else — src/**,
    // build.ts, package/lock, vendored payloads, unknown new roots —
    // stays a refusal (fail-closed).
    const SAFE_DELTA = /^(docs\/|scripts\/|field\/|\.claude\/|\.mercury\/|\.github\/|[^/]+\.md$)/
    let changed: string[] | null = null
    try {
      changed = execSync(`git diff-tree -r --name-only ${declared} ${now}`, { cwd: REPO, stdio: 'pipe' })
        .toString()
        .split('\n')
        .filter(Boolean)
    } catch {
      changed = null // unknown delta (missing objects) ⇒ the strict verdict stands
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

// ── the accounts-board scenario fixtures ─────────────────────
//  The spawned child is PINNED to CONFIG_HOME (render-tui's env pin — a
//  scenario-local scratch config home never reaches it), so credential
//  fixtures stage IN the proof home and must restore whatever they
//  displaced. Fixture values only — never real tokens or keys.
const accountsBoardStash = new Map<string, string | null>()
let accountsBoardEnvStash: {
  prevHome: string | undefined
  prevStore: string | undefined
  scratchHome: string | null
} | null = null

/** Stage (or, with null, displace) one credential-store file in the proof
 *  home, remembering the prior contents for cleanupScenario to restore. */
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
  // Every capture pins its PTY cwd to the session-staging path (vshot honors
  // cfg.cwd via os.chdir): the RUNTIME_CWD constraint documented above is now
  // MECHANICAL — a worktree-invoked prover boots the staged fixtures instead
  // of 404ing "No conversation found" from the worktree's own slug. A
  // scenario that returns its own cwd still wins (spread order).
  assertFreshDist()
  return { cwd: RUNTIME_CWD, ...scenarioInner(name, cols, rows) }
}

function scenarioInner(name: string, cols: number, rows: number) {
  // Deterministic captures: the boot preflight (MERCURY_BOOT_PREFLIGHT,
  // fork-default-ON) fires on every interactive mount, spawns a git probe and
  // writes last-preflight.json into the project doctor store
  // (adoptiveProjectPath — `.mercury` canonical) — a boot side-effect, not the
  // chrome under test, and its chip alert varies with the live repo/gate
  // state. Pin it OFF for every scenario (a dedicated preflight scenario may
  // re-set it explicitly); the spawned PTY inherits this process env.
  process.env.MERCURY_BOOT_PREFLIGHT = '0'
 // The capture harness DECLARES the terminal it emulates : the
  // child inherits this process's TERM, which on CI runners is often 'dumb' —
  // and a dumb TERM now legitimately trips the full-profile requirement card
  // (terminalProfile.ts) instead of booting the cockpit. pyte IS an xterm
  // emulator, so xterm-256color is the honest declaration on every machine.
  // A scenario that wants the requirement card overrides this in its branch.
  process.env.TERM = 'xterm-256color'
 // Identity hermeticity closure review): the operator display name
  // is `process.env.USER || 'operator'` (substrate/identity/identity.ts) and paints
  // into the SEAT rail and transcript author cells — ambient machine state
  // inside a proof (a hosted runner would capture 'runner' against grids
  // stored as 'sam'). Pin the fixture operator to the name the committed
  // baseline was captured with.
  process.env.USER = 'sam'
  // The presence seat rail and transcript nameplate resolve their name
  // through their OWN seam — the MERCURY_OPERATOR flag (getOperatorName in
  // utils/cockpit/presenceLive.ts · userHandle in TranscriptNameplate.tsx),
  // else os.userInfo().username, which NO env pin can reach (hosted gate
  // run: the seat row painted '● runner (you)' against grids stored
  // as '● sam (you)' while every USER consumer was pinned). Pin the
  // product's designed override to the fixture name — ABSENT-ONLY across
  // both spellings: a prover that names its own seats (hover-e2e's 'op',
  // presence-live's 'alice') keeps its identity, spawn-env pins must use
  // the CANONICAL spelling to beat this inherited value.
  if (!process.env.MERCURY_OPERATOR && !process.env.MERCURY_OPERATOR) {
    process.env.MERCURY_OPERATOR = 'sam'
  }
  // Auth-state hermeticity (gate preflight A): the committed grids were
  // captured KEYLESS — the 'Not logged in · Run /logins' row paints, and the
  // seeded onboarding means no key dialog either way. A hosted gate exports
  // ANTHROPIC_API_KEY workflow-wide, which would flip apiKeyStatus valid and
  // vanish the row. Captures are keyless on every machine.
  delete process.env.ANTHROPIC_API_KEY
  // Keychain hermeticity (visual-baseline): on darwin the
  // secure-storage chain reads the REAL macOS keychain regardless of the
  // scratch config home, so 'keyless' captures boot logged-in on an
  // operator Mac while hosted runners paint the standing auth row —
  // and a transient toast can mask the
  // divergence in the height-1 notifications window. Pin the registered
  // file-store seam so the keyless law above is mechanically true on EVERY
  // machine. Absent-only: a dedicated auth-surface scenario may override.
  process.env.MERCURY_CREDENTIAL_STORE = process.env.MERCURY_CREDENTIAL_STORE ?? 'file'
  // CI hermeticity (the zero-painted-cells class):
  // runners export CI=true job-wide, and the product legitimately branches on
  // it — the auth walk under CI is env-credential-only (utils/auth.ts), so a
  // keyless capture child renders through a DIFFERENT code path on a runner
  // than on the machine the grids were captured on. A capture declares a
  // non-CI interactive terminal; the CI-shaped keyless boot has its own
  // standing proof (scripts/interaction/prove-keyless-ci-boot.ts).
  delete process.env.CI
  // Liveness hermeticity (the alive-REPL pass): the standing-chrome
  // animations (WorkingGlyph rotation · caret ReadyBreath · sigil TwinkleSpark ·
  // settle flashes) sample the live clock, so a capture lands on an arbitrary
  // frame — the 260ms ✦ glint would flake any '✶ Mercury' needle ~3% of runs.
  // Pin them OFF: the frame-0 invariant means =0 renders the EXACT static cell
  // every needle was written against (◐ stays ◐, ✶ stays ✶, the caret stays
  // steady accent). A live-motion scenario must explicitly re-enable (set '1').
  process.env.MERCURY_LIVE_GLYPHS = process.env.MERCURY_LIVE_GLYPHS ?? '0'
  // Critter-gaze hermeticity (same class): a scenario that sends synthetic
  // SGR mouse bytes would shift the hero's pupils and flake any letterform
  // needle. Pin gaze OFF; the dedicated gaze leg re-enables with '1'.
  process.env.MERCURY_CRITTER_GAZE = process.env.MERCURY_CRITTER_GAZE ?? '0'
  // Critter-idle hermeticity (same class; the R7 close catch): the Concourse
  // resident's BLINK rides the critterIdle clock (default-on in product by the
  // operator's #62 directive) — unpinned it repaints the empty board every
  // few ticks and breaks the SR-108 byte-silence census. Frame 0 is the
  // authored rest art; a dedicated blink leg re-enables with '1'.
  process.env.MERCURY_CRITTER_IDLE = process.env.MERCURY_CRITTER_IDLE ?? '0'
  // Critter-SLEEP hermeticity (same class). The live
  // derivation would never fire inside a capture — the idle threshold is five
  // minutes and the baseline is stamped at boot — but pinning it states the
  // resting state instead of relying on that arithmetic, and it keeps the
  // sleeping frames out of every capture that did not ask for them. The
  // dedicated state legs re-enable with '1', which FORCES the sleeping frame:
  // that is the only way to photograph a five-minute idle.
  process.env.MERCURY_CRITTER_SLEEP = process.env.MERCURY_CRITTER_SLEEP ?? '0'
  // Live-clock hermeticity (same class; the operator's directive): the
  // header's seconds tick at 1 Hz in the product — unpinned, every capture's
  // clock cell would drift off its authored fixture time and the SR-108
  // idle censuses would count the tick. Pin =0: captures keep the
  // snapshot-baked string; a dedicated live-clock leg re-enables with '1'.
  process.env.MERCURY_LIVE_CLOCK = process.env.MERCURY_LIVE_CLOCK ?? '0'
  // Deck-companion hermeticity (same class): the row's soul (stars +
  // personality) is deterministic PER SESSION ID, which every capture mints
  // fresh — goldens would flake on rarity/wording. Pin the row OFF; a
  // dedicated companion leg re-enables with '1'.
  process.env.MERCURY_DECK_COMPANION = process.env.MERCURY_DECK_COMPANION ?? '0'
  // Instruction-scope hermeticity (the SAME class): the
  // 'CLAUDE.md present but not loaded' notice reads the CAPTURE CWD'S
  // real guide layout — the repo's own guide layout
  // makes hosted fresh frames paint the banner
  // over the auth row while local trees diverge by ambient state. Pin the
  // compat-instructions facet OFF for captures: SM-J-P7 guarantees zero
  // compat discovery (diagnostics included), so the notice can never mint;
  // native composition is otherwise byte-identical. A scenario that WANTS
  // the banner re-enables with 'on' and seeds its own compat file.
  process.env.MERCURY_CC_COMPAT_INSTRUCTIONS = process.env.MERCURY_CC_COMPAT_INSTRUCTIONS ?? 'off'
  // Doctor-state hermeticity (FLUX S5): the telemetry rail's CERT
  // chip and the wide-rail HEALTH card read last-cert.json + gate/verdict.json
  // from the cwd's project doctor/gate store (adoptiveProjectPath —
  // `.mercury` canonical) — the capture cwd must stay the repo for
  // session staging, so the dev machine's REAL health state leaked into
  // goldens (a morning /doctor run flipped 36/42 baseline entries; the wide
  // entries were recorded cert-present, the narrow ones cert-absent). Point
  // the state root at a pid-scratch so captures deterministically see NO
  // certificate; a scenario that wants one seeds it there explicitly.
  process.env.MERCURY_DOCTOR_STATE_DIR = join(tmpdir(), `hermes-render-doctor-${process.pid}`)
  // Daemon hermeticity: any surface with a live daemon cross-check (the seat
  // inspector's roster probe, doctor chips, …) would otherwise dial the REAL
  // config-home control socket — under the parallel gate a concurrent suite's
  // daemon answers and flips 'store · Ns ago' → 'live · roster rpc'
  // (nondeterministic capture). Point the daemon dir at a pid-suffixed scratch
  // so probes deterministically find nothing; a scenario that WANTS a live
  // daemon must spawn its own into this dir.
  process.env.MERCURY_DAEMON_DIR = join(tmpdir(), `hermes-render-daemon-${process.pid}`)
  // Teams hermeticity (same class): the cockpit rail's CREW lane
  // reads the crew team file through getTeamsDir() — against the operator's
  // real config home an ambient teammate record (@scout, live-wired 07-05)
  // makes every capture non-solo, displacing the RECENT/NEXT glanceables the
  // helm-home proof pins. Point teams at a pid-suffixed scratch so captures
  // deterministically see NO crew; a scenario that wants teammates must seed
  // its own into this dir.
  process.env.MERCURY_TEAMS_DIR = join(tmpdir(), `hermes-render-teams-${process.pid}`)
 // Crew hermeticity final audit — the same class): the board
  // CREW/FEED/GRAPH sections and the boot mint read the crew stores under
  // the config home — against the operator's real home a live session's
  // conversations leaked INTO captures (nondeterministic counts) and, worse,
  // capture-harness boots WROTE real stores (the twice-cleaned cv-main
  // mirror noise). Point the crew root at a pid-suffixed scratch; scenarios
  // that want crew rows seed their own stores there.
  process.env.MERCURY_CREW_DIR = join(tmpdir(), `hermes-render-crew-${process.pid}`)
  // Tabula hermeticity (same class): the cockpit rail's TABULA
  // glance folds the per-project note journal under tabulaRoot() — against the
  // operator's real config home their live /note captures would appear in
  // every solo-cockpit frame (and shift the RECENT/NEXT needles). Point the
  // notepad root at a pid-suffixed scratch; the 'tabula' scenarios seed their
  // own journal into this dir. MINERVA stays default-OFF, belt included.
  process.env.MERCURY_TABULA_DIR = join(tmpdir(), `hermes-render-tabula-${process.pid}`)
  process.env.MERCURY_TABULA_MINERVA = '0'
  // Turn-receipt hermeticity: the default-ON per-turn receipt row
  // (MERCURY_TURN_RECEIPT) would append a new row to every tool-bearing capture
  // and shift the pinned needles/spacing of the standing scenarios — captures
  // pin it OFF (the LIVE_GLYPHS/CRITTER_GAZE pattern); the dedicated
  // 'turn-receipt' scenario re-enables it explicitly.
  process.env.MERCURY_TURN_RECEIPT = '0'
 // Verify-evidence hermeticity: the statusbar vfy
  // chip reads <cwd>/.claude/verify/evidence.json — the capture cwd is the
  // repo, so the OPERATOR'S live verification state (a red verify:fast record,
  // stale evidence after an edit) painted `vfy ✕ failed` into frame/cockpit
  // captures and flipped 16 baseline entries (the F6 ambient-state class;
  // green machines masked it). Captures pin the observation layer OFF — a
  // scenario that wants the chip must re-set '1' under its own cwd.
  process.env.MERCURY_VERIFY_EVIDENCE = process.env.MERCURY_VERIFY_EVIDENCE ?? '0'
  // Boot-env hermeticity (same class): applyBootMenuEnv() reads
  // $MERCURY_HOME/boot-env.json (default ~/.mercury) in every dist child — an
  // operator's saved enter-menu row (a THEMIS mode, …)
  // would silently flip flags inside every capture. Point the hermes home at
  // a pid-suffixed scratch so captures boot with NO saved menu; a scenario
  // that wants boot-env behavior must write its own file into this dir.
  process.env.MERCURY_HOME = join(tmpdir(), `hermes-render-home-${process.pid}`)
 // Split-home guard at the ONE seam (sovereign-home ): the bun-side
  // fixture writer and the dist child (which resolves its OWN sovereign home
  // when env-less) must resolve the SAME home or every --resume capture boots
  // onto an empty store. CONFIG_HOME is the proof's home (already exported at
  // module load; re-asserted here so a scenario built after an env scrub
  // still pins it). scenario() mutates process.env exactly like the daemon
  // pin above, so every spawner that builds a scenario — render-tui, the
  // standalone prove-*/render-* runners — inherits it with no per-file env
  // plumbing.
  process.env.MERCURY_CONFIG_DIR = process.env.MERCURY_CONFIG_DIR ?? CONFIG_HOME
  // Capture hermeticity (the second ambient-
  // notification class): a capture child must never reach the network for
  // anything at boot, and on a fresh runner a success toast would own the
  // most-recent notification row at capture time. Pin the product's own
  // designed override so NO capture child ever attempts it, whatever home
  // it resolves; a scenario that wants a fetch must re-set '0'.
  if (name === 'resume-2turn' || name === 'frame' || name === 'cockpit-wide' || name === 'cockpit-content') {
    writeSyntheticSession(name === 'cockpit-wide' ? 'long' : name === 'cockpit-content' ? 'content' : 'short')
    // total = event-loop pumps (each ~0.2s in vshot.py). 16 was too few — the binary
    // hadn't finished painting → intermittent blank captures. 45 (~9s) reliably lands a
    // fully-painted frame, well within render-tui.ts's 30s spawn timeout.
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'cockpit-wide-gpt') {
    // The telemetry rail's ACTIVE-SOURCE-AWARE usage panel under an OpenAI
    // pin (model-truth lane): the fixture ChatGPT credential + a gpt main
    // model flips the USAGE panel to the 'OpenAI usage' label and the
    // OpenAI shape — no 5h/7d bars, the honest fills-after-first-reply
    // absence until the account source states a band (fixtures never
    // activate anything; no wire is reachable in captures).
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
    process.env.ANTHROPIC_MODEL = 'gpt-5.6-sol'
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'usage-truth-signedout' || name === 'usage-truth-gpt-signedin') {
    // LANE U (usage truth): the telemetry rail and the /usage tab in ONE
    // frame — the operator's split-brain screenshot is the
    // acceptance shape, inverted: every surface must tell the SAME story.
    //   · usage-truth-signedout   — the seeded proof home carries no
    //     credential: the rail's USAGE box must paint the owner's honest
    //     why-not (never "fills after first reply"), and the tab's family
    //     sections their not-connected one-liners — one story, one frame.
    //   · usage-truth-gpt-signedin — the fixture ChatGPT credential + a gpt
    //     main model (the cockpit-wide-gpt home): the rail names 'OpenAI
    //     usage' on the subscription lane and the tab mounts the CONNECTED
    //     OpenAI section body — a "not connected" line anywhere in this
    //     frame is the regression. (No wire is reachable in captures, so
    //     both surfaces show the same honest no-signal-yet absence; the
    //     observed-bands equality is prove-usage-truth-surfaces §2's leg.)
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
      process.env.ANTHROPIC_MODEL = 'gpt-5.6-sol'
    }
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, awaitText: '❯', minTick: 5, data: '/usage' },
        { afterPrevTicks: 3, data: '\r' },
        // Settle on the mounted Usage tab (the anthropic section heading
        // renders at every width) so the grid captures the settled frame.
        { atTick: 80, awaitText: 'Anthropic usage', minTick: 10, awaitSettleTicks: 2, data: '' },
      ],
      total: 100,
      cols,
      rows,
    }
  }
  if (name === 'cockpit-band-98' || name === 'cockpit-band-96') {
    // The cockpit hysteresis band (useLayoutTier chromeModeLive): from 100
    // columns the rails persist down to 97 and shed at 96; the pure
    // computeChromeMode flapped at 99. Start at --cols (100), shrink to 98
    // (and, for -96, on to 96); the final frame is the band state.
    writeSyntheticSession('short')
    const resizes =
      name === 'cockpit-band-98'
        ? [{ atTick: 45, cols: 98, rows }]
        : [{ atTick: 45, cols: 98, rows }, { atTick: 60, cols: 96, rows }]
    return { argv: ['node', BIN, '--resume', SID], sends: [], resizes, total: name === 'cockpit-band-98' ? 70 : 85, cols, rows }
  }
  if (name === 'resize-return') {
 // the resize-return identity journey — 120→80→45→150→
    // back to the boot geometry; the final frame must equal a direct boot at
    // the same size (form, art, stable colour coordinates). Compared against
    // 'resume-2turn' by scripts/visual-finish/prove-resize-return.py.
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
 // (FRAME-WRITER-LINK-FIDELITY): a transcript markdown
    // link rendered through the per-cell writer paths on a hyperlink-capable
    // profile; the raw VSHOT_TEE is the evidence stream
    // (scripts/visual-finish/prove-link-journey.py holds the OSC 8 laws; the
    // resize variant relays the link mid-run).
    process.env.TERM_PROGRAM = 'iTerm.app'
    writeSyntheticSession('link')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [],
      ...(name === 'cockpit-link-resize'
        ? {
            // A ROUND-TRIP: the second relayout diffs two different layouts,
            // so the link row repaints through the per-cell dirty arm (the
            // ledger's measured path), not just a fresh full paint.
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
    // Sweep #2 (round-1 deferral 33, the live leg): a `!` command
    // runs for ~4s while /model opens its picker over it; the capture lands
    // AFTER the command finishes — the picker must still be on screen (the
    // bang's teardown clears only its own progress, never a dialog). The
    // -closed variant presses Esc afterwards so the settled bang row shows.
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
    // Sweep #2 (round-1 deferral 34): resume onto two shell commands
    // with a todo rewrite between them — ONE collapsed shell row ("2 shell
    // commands"), the checklist row after it, never two split shell rows.
    writeSyntheticSession('shell-interleave')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'turn-receipt') {
    // The per-turn work-receipt row: resume onto the 'tools' fixture (a real
    // Bash + Read turn) with the receipt ON — the dim `∙ … · 1 file read ·
    // 1 shell command` rollup must paint after the turn.
    process.env.MERCURY_TURN_RECEIPT = '1'
    writeSyntheticSession('tools')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'stream-fault-recovered') {
 // resume onto the recovered-stream-fault tail — the fault
    // message must paint the restrained ▲ "resumed" row (never the CRIMSON
    // API-error card) with the continuation prose beneath it.
    writeSyntheticSession('stream-fault')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'thinking-row') {
    // Finalized thinking renders as the collapsed `∴ Thinking ⌄` disclosure
    // row in the default view (audit #3); render-thinking-row.ts asserts.
    writeSyntheticSession('thinking')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'fork-boilerplate') {
    // Resume onto a fork child's transcript head: the directive-led collapsed
    // row must paint (`∙ fork directive: …` + `└ boilerplate collapsed`),
    // never the raw <fork-boilerplate> XML wall.
    writeSyntheticSession('fork')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'channel-message') {
    // Resume onto the channel-push tail: both `←` rows (local · kim + the
    // extension-leaf slack row) must render as UserChannelMessage rows, never
    // raw <channel …> XML (the pre-relanding failure mode).
    writeSyntheticSession('channel')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'harness-chip' || name === 'harness-view') {
    // The armed harness-profile surfaces — the frame
    // chip (` · harness <id>` beside the model) and the /harness drill-in
    // (identity · axes · declined · pin/reset rows). Armed via the
    // registered flag; the spawned PTY inherits this env (the
    // MERCURY_BOOT_PREFLIGHT precedent below). Off-flag frames stay
    // byte-identical — that certificate lives in prove-ch2-application.
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
    // The model-switch glitch repro: a transcript holding ONLY the
    // local /model chrome (caveat + breadcrumb + `Set model to` ack). The
    // landing block (mascot hero + lockup + session table + prompt-hint) must
    // STILL paint — hasRealConversation() reads this as no-conversation — with
    // the command capsule rendered beneath it. render-model-switch.ts asserts.
    writeSyntheticSession('model-noise')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'submodels-home') {
    // /submodels — the two SUB-model containers over the live account state
    // (real Anthropic ring; engine families paint their honest signed-out
    // routes). Captured at 80+120 per the UI law.
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
    // The signed-out routing journey: open /submodels, walk to a signed-out
    // family's row, ↵ routes to the attach surface (family pre-focused) with
    // the return chained, esc backs out one level — and the chained return
    // re-opens /submodels with the row's honest state. Marks snapshot each
    // leg (the grid BEFORE the send).
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/submodels\r' },
        // Container tab: minerva → console (the toggle axis).
        { afterPrevTicks: 8, data: '\t', mark: 'opened' },
        // Walk down THROUGH the Anthropic rows into the OpenAI family's
        // first signed-out row (headers skip under the kit's law).
        { afterPrevTicks: 4, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B' },
        { afterPrevTicks: 2, data: '\u001b[B', mark: 'walked' },
        // ↵ on the signed-out row routes to /logins (openai pre-focused).
        { afterPrevTicks: 4, data: '\r', mark: 'pre-route' },
        // Esc cancels the login; the chained return re-opens /submodels.
        { afterPrevTicks: 22, data: '\u001b', mark: 'at-logins' },
      ],
      total: 130,
      cols,
      rows,
    }
  }
  if (name === 'model-picker-home') {
    // The /model MercuryModelPicker surface (current-row state chain +
    // the §8.2 current→next header's OFF path — pendingNext absent renders the
    // legacy picker byte-identically). Captured at 80+120 per the UI law.
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/model\r' }],
      total: 60,
      cols,
      rows,
    }
  }
  if (name === 'model-picker-scribe-active') {
    // The /model picker's ENGAGED-mode states — the
    // scribe row's '(active)' suffix, the CURRENT dot on the router row
    // (engagement truth), and the MODES group's 'Scribe active — a real
    // model exits · the party row hands off' detail line. The session BOOTS
    // as a launched Scribe (MERCURY_SCRIBE=1 ⇒ the REPL mount effect
    // engages) with the live bus OFF so the engage spawns no daemon and the
    // capture stays hermetic (ensureScribeDaemon + engageScribeTeam both
    // gate on MERCURY_SCRIBE_BUS_LIVE). The party '(active)' arm shares the
    // same label machinery (modelOptions) — engaging the party needs a real
    // daemon, so its engaged capture stays a live-run item.
    process.env.MERCURY_SCRIBE = '1'
    process.env.MERCURY_SCRIBE_BUS_LIVE = '0'
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
    // OpenAI parity: the /model picker's 'Mercury — OpenAI models' group.
    //   · model-picker-gpt        — fixture key + a DETACHED
    //     fixture catalogue server ⇒ qualified GPT rows (Sol before Luna,
    //     plus the served previous-generation fixture id — EVERY served id
    //     is selectable since the generation floor died,
    //     model-truth) PLUS the unserved-lineup visible-but-unavailable pin
    //     rows (provider parity — each carries its resolver
    //     reason, never selectable; the hidden fixture row still never
    //     paints), and the per-provider signed-in detail under each group
    //     heading;
    //   · model-picker-gpt-toggle — same fixture, booted ON gpt-5.6-sol
    //     (272k served / 872k declared max there): /model opens with the
    //     current dot on Sol, then `c` toggles the window DOWN onto the
    //     served default — the capture shows the served-state column plus
    //     the honest both-windows notice line (the toggle);
    //   · model-picker-gpt-signin — NO account ⇒ the
    //     'GPT — sign in' action row (the always-visible-group law)
    //     followed by the lineup as unavailable rows — booted on a SCRATCH
    //     config home (the operator's machine may carry a real connected
    //     subscription; the scratch home is the isolation).
    //   · submodels-gpt — the SAME fixture (key + live catalogue), opening
    //     /submodels instead: the OpenAI family header wears the key label
    //     and the live GPT rows are selectable container picks (LANE SM —
    //     the picker reads the one credential truth);
    //   · submodels-signedout — the SAME scratch-home isolation, opening
    //     /submodels: every engine family header reads its honest
    //     not-signed-in state and the rows are the ROUTE to /logins.
    // The server is a detached child (spawnSync blocks this process during
    // the capture, so an in-process listener would never answer); cleanup
    // kills it by pid file.
    delete process.env.OPENAI_API_KEY
    if (name === 'model-picker-gpt-signin' || name === 'submodels-signedout') {
      const scratch = mkdtempSync(join(tmpdir(), 'mercury-render-gpt-signin-'))
      seedFirstRun(scratch, [RUNTIME_CWD])
      applyRenderTheme(scratch)
      process.env.MERCURY_CONFIG_DIR = scratch
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
      // A previous capture's detached server may have leaked (a killed run
      // never reaches cleanup) — clear it so this run's server owns the port.
      try {
        const stale = Number(readFileSync(join(tmpdir(), 'mercury-render-gpt-fixture.pid'), 'utf8').trim())
        if (Number.isFinite(stale) && stale > 1) process.kill(stale)
      } catch {
        /* none leaked */
      }
      // The catalogue body is built as REAL objects here and embedded as one
      // JSON-escaped string — the earlier line-array joined with ';' put
      // semicolons INSIDE the array literal, so the node child died on a
      // syntax error instantly and silently (stdio ignored) and the ready
      // gate spun against a dead port.
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
      // Synchronous BOUNDED ready gate (curl's --retry backs off
      // exponentially even with --retry-delay 0 — an unbounded spin against
      // a dead port was the wedge class): ≤40 probes × 250ms, then a LOUD
      // failure so the scenario throws instead of capturing the error row.
      execSync(
        `sh -c 'i=0; while [ $i -lt 40 ]; do curl -s -m 1 http://127.0.0.1:${port}/models > /dev/null && exit 0; i=$((i+1)); sleep 0.25; done; echo "gpt fixture server never became ready" >&2; exit 7'`,
      )
      process.env.OPENAI_API_KEY = 'render-fixture-key'
      // ALL THREE bases point at the fixture — catalogue (api-key source),
      // catalogue (subscription source), and the OAUTH ISSUER. The operator's
      // machine may hold a real connected subscription that outranks the env
      // key; with the issuer pinned here a token refresh dies against the
      // fixture (stale tokens, no write) instead of ROTATING the real grant
      // (the auth-persistence incident class) — the capture child
      // can perform ZERO real provider I/O by construction.
      process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${port}`
      process.env.MERCURY_OPENAI_CHATGPT_BASE = `http://127.0.0.1:${port}`
      process.env.MERCURY_OPENAI_AUTH_BASE = `http://127.0.0.1:${port}`
    }
    if (name === 'model-picker-gpt-toggle') {
      // Navigate to the toggle-capable Sol row (11 rows below the default
      // focus in this fixture's pinned model set) and press `c`: the window
      // flips onto the served default — column + notice both change. (A
      // `--model gpt-5.6-sol` boot is NOT used: boot-time gpt adoption
      // validates against the detached fixture server, which may answer
      // after the boot's validation pass — the navigation is deterministic
      // either way; the persistence half of the toggle is prover §8's.)
      const downs = Array.from({ length: 11 }, (_, k) => ({ atTick: 38 + k * 2, data: '\u001b[B' }))
      return {
        argv: ['node', BIN, '--resume', SID],
        sends: [
          { atTick: 30, data: '/model\r' },
          ...downs,
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
 // the /effort slider on a max-yes/xhigh-NO model
    // (claude-sonnet-4-6). The slider's stops must derive from the model's
    // resolved vocabulary — an offered stop the dispatch would step down is
    // the impossible-tier class. Captured at 80+120 per the UI law.
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
 // the /model picker's effort track on the same max-yes/
    // xhigh-NO model — the track may only offer that model's resolved stops.
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
    // A03 + G03 choreography. REQUIRES env MERCURY_SCRIPTED_STREAM=
    // slow-text on the render-tui invocation (vshot does not apply cfg.env;
    // process env flows through the spawn chain): the prompt starts the
    // scripted turn (~8s active window, zero network); `/model sonnet`
    // parks at the preview card MID-TURN (gpt-record history ⇒ lossy);
    // Enter confirms into the QUEUED path → the statusline projects the
    // pending `current → next` chip (G03). The -settled variant runs past
    // the scripted boundary: the parked switch applies with the
    // turn-boundary receipt and the chip clears (A03's boundary law).
    writeSyntheticSession('gpt-record')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: 'work through the release notes\r' },
        // meta+p opens the INLINE picker mid-turn (Chat-context keybinding;
        // a typed /model line would only reach the runner as words). CSI-u
        // encoding (p=112, alt modifier=3): the app arms kitty input, and a
        // raw ESC+p pair risks decoding as ESC (= stream interrupt) then a
        // typed 'p' — the first-iteration lesson.
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
    // B04/B07: /rewind over a synthetic history → pick the last real
    // message → the confirm card presents the timeline triad (View only ·
    // Create branch · Rerun from here) beside the restore rows, each with
    // its own confirm copy. Captured 80+120 (L28).
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
    // needs_choice: `/model sonnet` (alias — no network validation)
    // over a history carrying a GPT continuation record parks at the
    // TransitionPreviewCard (stateless-replay-reset ≥ 1) instead of
    // settling. Captured at 80+120 per the UI law (L28).
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
    // R05/R2: the LIVE cap-survival journey, BILLED BOTH WAYS — manual
    // only, never in any suite. Requires the real operator home + env at
    // spawn: MERCURY_MOCK_LIMITS=1 MERCURY_CAP_FAILOVER=
    // offer. warning → offer card → accept (settles onto the qualified GPT
    // default) → a real billed GPT turn → clear (reset) → the way-home card
    // → accept → a real billed Claude turn.
    return {
      argv: ['node', BIN],
      sends: [
        { atTick: 40, awaitText: 'for commands', minTick: 10, awaitSettleTicks: 2, data: '/mock-limits warning-7d\r', mark: 'seam' },
        { atTick: 90, awaitText: 'Claude usage window', minTick: 4, awaitSettleTicks: 2, data: '\r', mark: 'offer-accept' },
        { atTick: 140, awaitText: 'Model set to gpt-5.6', minTick: 4, awaitSettleTicks: 2, data: 'Reply with exactly: OK-GPT-JOURNEY\r', mark: 'gpt-turn' },
        { atTick: 260, awaitText: 'OK-GPT-JOURNEY', minTick: 10, awaitSettleTicks: 3, data: '/mock-limits clear\r', mark: 'reset' },
        { atTick: 300, awaitText: 'return home', minTick: 4, awaitSettleTicks: 2, data: '\r', mark: 'home-accept' },
        // The way home is LOSS-HONEST: leaving the OpenAI lane resets its
        // continuation record, so the transition preview gates the return — the
        // second ↵ is the explicit confirm through the settlement owner.
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
    // LANE IN (the instruction estate): the standing trim chip and the /init
    // signpost, driven on scratch PROJECTS with controlled estates — never
    // the repo's own instruction files. A FRESH boot lands on the landing
    // (the signpost's surface) with the frame statusline above the composer
    // (the chip's berth). Hermetic: scratch config home trusted for the
    // scratch project cwd; MERCURY_RENDER_INSTRESTATE_DIR lets the capture
    // caller pin the scratch root so it can assert the bare-boot law on the
    // project afterwards.
    const scratch =
      process.env.MERCURY_RENDER_INSTRESTATE_DIR ||
      join(tmpdir(), `hermes-render-instrestate-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    const project = join(scratch, 'project')
    mkdirSync(project, { recursive: true })
    execSync('git init -q', { cwd: project })
    if (name === 'trim-chip-armed') {
      // The ruled arming fixture: a 3-line pointer at a 600-line guide —
      // 603 EFFECTIVE lines, past the ~400 bar.
      writeFileSync(
        join(project, 'MERCURY.md'),
        '@AGENTS.md\nThe guide is AGENTS.md; this file only points at it.\nSee the guide.\n',
      )
      writeFileSync(
        join(project, 'AGENTS.md'),
        Array.from({ length: 600 }, (_, i) => `guide line ${i}`).join('\n') + '\n',
      )
    } else if (name === 'trim-chip-calm') {
      // 399 effective lines — the chip stays down; MERCURY.md present, so
      // the /init signpost stays down too (the absent-side capture for both).
      writeFileSync(
        join(project, 'MERCURY.md'),
        Array.from({ length: 399 }, (_, i) => `entry line ${i}`).join('\n') + '\n',
      )
    } else {
      // init-signpost: a repo with NO estate at all. The boot preflight is
      // deliberately re-armed (the base pins it '0'): with the estate gate
      // in force a REAL bare boot must still create no `.mercury/` here —
      // the capture caller asserts exactly that after the grid lands.
      process.env.MERCURY_BOOT_PREFLIGHT = '1'
    }
    // A real project has commits — and the landing's git glance (the
    // signpost's project gate) reads null on a commit-less init.
    writeFileSync(join(project, 'README.md'), 'fixture project\n')
    execSync('git add -A && git -c user.email=fix@x -c user.name=fix commit -qm seed', { cwd: project })
    seedFirstRun(scratch, [project])
    applyRenderTheme(scratch)
    process.env.MERCURY_CONFIG_DIR = scratch
    return { argv: ['node', BIN], sends: [], total: 45, cols, rows, cwd: project }
  }
  if (name === 'entry-provider') {
    // R02: the first-run provider ROUTER step. Boot a NOT-onboarded home:
    // invoke with MERCURY_CONFIG_DIR=<scratch> whose .claude.json carries
    // {theme, hasCompletedOnboarding:false, trusted cwd} — pre-written by the
    // caller (seedFirstRun is absent-only, so it leaves the file). The ↵ at
    // t30 keeps the theme, landing the flow on the provider step.
    return { argv: ['node', BIN], sends: [{ atTick: 30, data: '\r' }], total: 55, cols, rows }
  }
  if (name === 'concourse') {
 // (the render base): the §8.1 reference seed driven
    // through the REAL machinery — MERCURY_CONCOURSE=always routes the boot
    // into the registered concourse surface (the resolver), and the
    // registered fixture seam (MERCURY_CONCOURSE_FIXTURE) feeds the seed
    // snapshot so the screen renders the pixel-verified fixture content.
    // Hermetic: scratch config home + scratch daemon dir (never the
    // operator's live records).
    const scratch = join(tmpdir(), `hermes-render-concourse-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    const fixture = referenceFixtureSnapshot()
    // Rows carry a workspace so the MIRROR mounts (its
    // transcript read is honest — a fresh scratch has none, so the pane
    // paints the 'no chat yet' line, never art, never a fake transcript).
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
    // R6: below 80×24 the concourse's LEGITIMATE end state is the honest
    // too-small surface — deliberately chrome-less text, so it joins the
    // accepted markers beside the standard glyph set.
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
    // Sweep #2 rider R5: the surface-switch chord is untouched in
    // BOTH directions. The reserved chat stop retires:
    // a bare boot lands the
    // Boot face with NO chat, so the strip has two stops — shift+right
    // enters the Concourse (the board carries a STOPPED row the daemon
    // retired as empty+idle, painted as a fact in its NOW cell), and the
    // -back variant chords shift+left home to the face again. (The retired
    // reading walked "the root REPL → Concourse → REPL"; shift+right from
    // the board with no chat open is no movement.) Same scratch hermeticity
    // as 'concourse'.
    const scratch = join(tmpdir(), `hermes-render-surface-chord-${process.pid}`)
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
          projectLabel: 'hermes',
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
        // shift+right (CSI 1;2C) — the Boot face → Concourse step
        { atTick: 32, data: '\u001b[1;2C' },
        // the first-boot capacity card: n keeps the default seats
        { atTick: 42, data: 'n' },
        // shift+left (CSI 1;2D) — the Concourse → Boot face step
        ...(back ? [{ atTick: 62, data: '\u001b[1;2D' }] : []),
      ],
      total: back ? 88 : 64,
      cols,
      rows,
      // The face's canon ready line joins the chrome set: the -back
      // variant's legitimate end state is the Boot face itself.
      chromeMarkers: ['❯', '╭', '│', '╰', 'terminal too small', '↵ start'],
    }
  }
  if (name === 'concourse-burst-arrows' || name === 'concourse-burst-arrows-discrete' || name === 'concourse-burst-type' || name === 'concourse-tab-probe') {
    // The burst-delivery matrix (Windows field findings F2/F3).
    // The SAME populated fixture board driven with the SAME key events in two
    // framings — five ↓ coalesced into ONE stdin chunk (ConPTY key-repeat
    // framing) vs five discrete sends — must land on the SAME frame; a
    // 16-printable single chunk into the 'n' compose must echo every
    // character; one discrete Tab must move the focus ring off the board.
    // The pair is the split-invariance law at the PTY seam (the B3 corpus
    // proves it at the decoder; these prove it through the LIVE board).
    const scratch = join(tmpdir(), `hermes-render-${name}-${process.pid}`)
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
    // THE THREE TRUTHS, one frame (LANE CB): the coordinator answers what
    // model it runs on with the id the harness gave it; a harness notice
    // wears the harness plate instead of the Coordinator's; and a launch
    // receipt names the model the session started on. The pane reads the
    // DURABLE conversation store, so the capture seeds that store in a
    // scratch home and boots the real binary onto the concourse route —
    // every row below is the product's own paint of stored rows.
    const scratch = join(tmpdir(), `hermes-render-coordinator-truth-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    {
      const cfgPath = join(scratch, '.mercury.json')
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      // A settled operator: the first-boot capacity ask owns every key while
      // armed, and this frame is the pane, not the ask.
      cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
      cfg['concourseCoordinator'] = { mode: 'agent-assisted', assistModel: 'claude-opus-5' }
      writeFileSync(cfgPath, JSON.stringify(cfg))
    }
    const fixture = referenceFixtureSnapshot()
    for (const g of fixture.groups) {
      for (const r of g.rows) r.workspaceDir = scratch
    }
    // The capture seam paints the fixture's coordinator on the rail, so the
    // frame's rail states the same seat the pane is speaking for.
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
 //: the composed coordinator picker OPEN —
    // the REAL binary, the real 'm' keypress at a settled tick (sent twice:
    // the idle-parked first-keypress eat is a known PTY hazard and a second
    // 'm' is inert once the picker owns input), the real registry
    // composition inside the hermetic home. The seeded engine qualification
    // receipt uses placeholder digests deliberately: the hermetic home has
    // NO connected account — the row surfaces as the typed 'no connected
    // account' refusal beside the live Anthropic rows, which is exactly the
    // frame this capture pins (engines default-on; credentials gate).
    const scratch = join(tmpdir(), `hermes-render-concourse-picker-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    // A SETTLED home: the first-boot capacity ask is a declared modal that
    // owns every key while armed (the audited board grammar), so this journey's one ⌃s would
    // land in the ask instead of the picker. The picker journey is a
    // settled operator's — record the decided default.
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
    process.env.MERCURY_CONFIG_DIR = scratch // the auth-home spelling — the qualification store reads it
    process.env.MERCURY_CONCOURSE = 'always'
    process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
    process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
    return {
      argv: ['node', BIN],
      sends: [
        // ONE observed-ready ctrl+s (the strict-gating law): the
        // picker's real binding is the rail chip's ctrl+s (controlManifest
        // 'composer:model-chip'); the old 'm' + the retired 'LIVE PEEK' await
        // predate the concourse recomposition. The seats tally is the
        // rail's settled-state marker.
        { data: '\x13', requireAwait: true, awaitText: 'seats', awaitSettleTicks: 2, awaitStableTicks: 2 },
      ],
      total: 72,
      cols,
      rows,
    }
  }
  if (name === 'concourse-picker-operator' || name === 'concourse-picker-operator-pick') {
    // The operator's account shape: OpenAI signed in (a fixture
    // ChatGPT subscription), NO Anthropic credential (scratch HOME, the
    // file-plane credential store, env tokens cleared), and the operator's
    // own qualification store — ONE 'gpt-5.6-sol · primary' receipt, no
    // coordinator receipt. Every endpoint base pins dead: the subscription's
    // catalogue refresh fails fast and no wire is reachable. The picker opens
    // on ⌃s (the rail chip's binding); every row is selectable and carries
    // its truthful label — the Anthropic rows 'not signed in — /logins
    // anthropic'; the GPT rows carry credential/catalogue facts only (the
    // verdict-word removal: no qualification word on any row). The
    // '-pick' variant then filters to the GPT flagship and applies it, so
    // the switch receipt paints with the row's label on the note line.
    const scratch = join(tmpdir(), `hermes-render-concourse-picker-operator-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    applyRenderTheme(scratch)
    {
      const cfgPath = join(scratch, '.mercury.json')
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
      // The '-pick' variant starts where the operator was: agent-assisted on
      // Opus 5 with no Anthropic credential — the rail chip and the
      // configured row paint that state before the switch.
      if (name === 'concourse-picker-operator-pick') {
        cfg['concourseCoordinator'] = { mode: 'agent-assisted', assistModel: 'claude-opus-5' }
      }
      writeFileSync(cfgPath, JSON.stringify(cfg))
    }
    const fixture = referenceFixtureSnapshot()
    // The capture seam paints the fixture's coordinator on the rail (the
    // live resolution is the provers' surface): the '-pick' variant's rail
    // carries the operator's state word — agent-assisted on Opus 5 with no
    // credential — so the chip's warning paint and width are captured.
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
              // The picker's footer is its settled marker; then filter to the
              // GPT flagship, step onto it (the header skips), and apply.
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
    // The coordinator console with a CONVERSATION on it (a bonus
    // sweep): a seeded durable store under the scratch home — an operator
    // ask, a coordinator reply carrying an applied and a refused receipt
    // (the refused label long enough to wrap), and a long reply past the
    // fold (the "+N more lines" disclosure) — painted by the real pane at
    // the real sizes. Fixture seam + scratch daemon/crew dirs as the base
    // scenario; the rail carries agent-assisted on the GPT flagship.
    const scratch = join(tmpdir(), `hermes-render-concourse-coordinator-conversation-${process.pid}`)
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
    // The /console seat (a bonus sweep) on a SIGNED-IN shape: a
    // fixture ChatGPT subscription with a GPT main model (the context-gpt
    // rig), every endpoint base pinned dead. 'console-open' is the bare
    // surface (no asks yet); 'console-ask-dead-wire' asks one question
    // through the one-shot form, so the surface paints its pending-then-
    // error path at the real sizes (history row · question · answer box ·
    // ask line) — the console's own model follows the main model.
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
    process.env.ANTHROPIC_MODEL = 'gpt-5.6-sol'
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
    // §8.4 robustness fixture: hostile titles through the SAME live
    // machinery at the 120×30 composed layout — a raw-ESC-bearing title, an
    // overlong title, and a wide-glyph (CJK) title must truncate/neutralize
    // without corrupting the frame (the render oracle rejects a broken
    // paint; the parity prover asserts the printable residue).
    const scratch = join(tmpdir(), `hermes-render-concourse-hostile-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    const fixture = referenceFixtureSnapshot() as {
      groups: Array<{ rows: Array<Record<string, unknown>> }>
      peek: Record<string, unknown>
    }
    const working = fixture.groups[1]!
    working.rows[0]!['title'] = 'Fix \u001b[31mOAuth\u0007 callback' // raw ESC + BEL inside the DATA
    working.rows[1]!['title'] = 'Refactor the parser across every module boundary the workspace has ever declared including the deep vendored trees'
    // NOTE: the vshot/pyte capture places CJK as single-cell (wcwidth-blind)
    // so THIS row's grid line reads N cells short of the border — a CAPTURE
    // artifact only; ink and real terminals agree on width 2 (adjudicated
    // the parity prover §8 pins the exact artifact arithmetic).
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
 // (evidence): the in-process Boot Settings
    // route over a HERMETIC config home — the operator's real saved menu must
    // never reach a grid (the ambient-state law: boot-env.json otherwise
    // resolves under the live MERCURY_CONFIG_DIR). The scratch home is seeded
    // through the REAL owners: firstRunSeed (onboarded + trusted cwd), then
    // two saveBootDefaultsProfile commits → a deterministic revision-2
    // profile with its real digest + receipt painting in the header.
    const scratch = join(tmpdir(), `hermes-render-bootmenu-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    const bootEnv = join(scratch, 'boot-env.json')
    saveBootDefaultsProfile({ MERCURY_HELM_HOME: '0' }, bootEnv)
    saveBootDefaultsProfile({ MERCURY_HELM_HOME: '0', MERCURY_CACHE_TTL: '1h' }, bootEnv)
    process.env.MERCURY_CONFIG_DIR = scratch
    return {
      argv: ['node', BIN],
      sends: [
        { atTick: 32, data: '/bootmenu\r', mark: 'open' },
        // CB-09: /bootmenu NAMES the menu, so it deep-links —
        // the canonical Boot face mounts with the settings layer already
        // open (no 's' drill needed); the settled gate waits for the
        // projection's lockup so the revision-2 profile digest header still
        // captures as this scenario's evidence. esc from here reveals the
        // helmet face (the boot-face scenario covers that leg).
        { atTick: 52, awaitText: 'BOOT SETTINGS', minTick: 36, awaitSettleTicks: 2, data: '' },
      ],
      total: 85,
      cols,
      rows,
    }
  }
  if (name === 'boot-face') {
    // Phase-2 ruling 1: the CANONICAL in-process Boot face (the helmet
    // composition from the shared splash core). /bootmenu deep-links into
    // the settings layer (CB-09), so the face capture drives the esc chain:
    // settings → the helmet face — which doubles as the CB-09 layering
    // evidence. Hermetic home via the same seeding as boot-settings.
    const scratch = join(tmpdir(), `hermes-render-bootface-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    process.env.MERCURY_CONFIG_DIR = scratch
    return {
      argv: ['node', BIN],
      sends: [
        { atTick: 32, data: '/bootmenu\r', mark: 'open' },
        // esc closes the settings layer to the canonical face beneath (CB-09).
        { atTick: 52, awaitText: 'BOOT SETTINGS', minTick: 36, awaitSettleTicks: 2, data: '\u001b' },
        { atTick: 72, awaitText: 'Doctor / Health Check', minTick: 40, awaitSettleTicks: 2, mark: 'face', data: '' },
      ],
      total: 95,
      cols,
      rows,
    }
  }
  if (name === 'boot-kit-menu') {
    // L24(5): the MCPs & Skills MANAGER,
    // opened from the Boot face's own row — the operator's real-boot look
    // (the cpu-pure stills live under scripts/ui/fixtures/kit-menu/).
    // Same hermetic seeding + the CB-09 esc chain as boot-face, then ↓↓ from
    // the default New Session row (a fresh home composes no Continue row, so
    // the kit row is the third: New Session · Boot Menu · MCPs & Skills) and
    // ↵ opens the manager; its caption settles the capture. esc from here
    // reveals the face beneath (the layer's own topology).
    const scratch = join(tmpdir(), `hermes-render-bootkit-${process.pid}`)
    rmSync(scratch, { recursive: true, force: true })
    seedFirstRun(scratch, [RUNTIME_CWD])
    process.env.MERCURY_CONFIG_DIR = scratch
    return {
      argv: ['node', BIN],
      sends: [
        { atTick: 32, data: '/bootmenu\r', mark: 'open' },
        { atTick: 52, awaitText: 'BOOT SETTINGS', minTick: 36, awaitSettleTicks: 2, data: '\x1b' },
        { atTick: 72, awaitText: 'MCPs & Skills', minTick: 40, awaitSettleTicks: 2, mark: 'face', data: '\u001b[B\u001b[B' },
        { afterPrevTicks: 4, data: '\r' },
        { atTick: 100, awaitText: 'mcps & skills', minTick: 80, awaitSettleTicks: 2, mark: 'kit', data: '' },
      ],
      total: 120,
      cols,
      rows,
    }
  }
  if (name === 'cap-offer-card' || name === 'cap-offer-rejected') {
    // R04: the cap-survival offer card — /mock-limits (the revived
    // fixture seam) drives the REAL header→limits ingestion; the posture
    // decision core fires the one-keypress offer. Requires env at spawn:
    // MERCURY_MOCK_LIMITS=1 MERCURY_CAP_FAILOVER=offer. Hermetic boots have
    // no OpenAI seat, so the card ALSO proves the R06 degradation
    // honesty row (the unusable-lane blockers). Captured 80+120 (L28).
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
    // A resumed transcript whose tail is a Workflow tool_use + async_launched
    // result — verifies the inline renderers paint (description line + the live
    // result line) instead of the old null stub. -detail opens ctrl+o so the
    // detailed transcript shows the tool_use description line too.
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
    // A resumed transcript with REAL-shaped tool_use/tool_result pairs (Bash +
    // Read). The home view collapses resolved read/run groups; -detail opens
    // the ctrl+o detailed transcript where the per-tool cards + `└ result`
    // rows render — the inline-short-results surface.
    writeSyntheticSession('tools')
    const sends =
      name === 'tool-cards-detail' ? [{ atTick: 38, data: String.fromCharCode(15) }] : []
    return { argv: ['node', BIN, '--resume', SID], sends, total: name === 'tool-cards-detail' ? 60 : 45, cols, rows }
  }
  if (name === 'changeset-card' || name === 'changeset-card-detail') {
 // the ChangeSet aggregate inline change view — a resumed
    // transcript with applied (mixed change/no-change + NAMED omitted
    // hunks), all-no-change, and stale (next action) results. The -detail
    // flavor sends ctrl+o for the expanded per-file diff cards + plan meta.
    writeSyntheticSession('changeset')
    const sends =
      name === 'changeset-card-detail' ? [{ atTick: 38, data: String.fromCharCode(15) }] : []
    return { argv: ['node', BIN, '--resume', SID], sends, total: name === 'changeset-card-detail' ? 60 : 45, cols, rows }
  }
  if (name === 'nochange-cards') {
 // the honest no-change result cards — an identical-hunk Edit
    // and a byte-identical Write resumed from the persisted shapes.
    writeSyntheticSession('stillpoint')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'structure-card' || name === 'structure-card-detail') {
 // the premium inline change view for semantic edits — a
    // resumed transcript with a Structure preview carrying changeView. The
    // -detail flavor sends ctrl+o for the expanded per-file diff cards.
    writeSyntheticSession('structure')
    const sends =
      name === 'structure-card-detail' ? [{ atTick: 38, data: String.fromCharCode(15) }] : []
    return { argv: ['node', BIN, '--resume', SID], sends, total: name === 'structure-card-detail' ? 60 : 45, cols, rows }
  }
  if (name === 'errors-transcript') {
    // A resumed transcript whose TAIL is failure-shaped (the W2b failure-
    // rendering surfaces, all in the DEFAULT view — ctrl+o deliberately paints
    // the raw uncapped text instead of the folds): an errored Edit tool_result
    // (multi-line + `    at ` stack frames + ENOENT ⇒ the fork
    // FallbackToolUseErrorMessage classified fold: CRIMSON headline, FAINT
    // body, `└ +3 stack frames`, errno hint) followed by an `API Error: …`
    // assistant card (first sentence CRIMSON-bold, trailing JSON blob folded
    // to a char count). Resuming onto an errored tail also mounts the W2c
    // ResumeRecapCard with its ✕ end-state line — same capture, no keys sent.
    // SKIPPED, not forgotten: a hook blocking-error attachment. Attachment
    // messages are filtered OUT of persisted logs at write time for non-ant
    // users (isLoggableMessage, sessionStorage.ts), so a resumed session
    // carrying one is a state production cannot produce — hook-failure
    // rendering is a live-turn-only surface, not fixturable via --resume.
    writeSyntheticSession('errors')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 48, cols, rows }
  }
  if (name === 'denied-transcript') {
    // The status-glyph DENIAL split (the operator's word): a resumed
    // transcript whose tail is a DENIED Edit (✕ CRIMSON — permission rejected)
    // followed by an ERRORED Edit (▲ AMBER — ordinary ENOENT failure). One
    // capture, both glyphs — prove-denied-glyph-split.ts asserts the split by
    // glyph char AND fg color. No keys sent; the default view paints the folds.
    writeSyntheticSession('denials')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 48, cols, rows }
  }
  if (name === 'cockpit-mission') {
    // The HelmCenterHeader MISSION band (the overflow fix, the operator's
    // word): resume the cockpit and set a LONG standing mission via /mission —
    // the mission text must TRUNCATE inside the center panel and never collide
    // with the right-pinned clock. The pre-fix budget forgot the 'MISSION:'
    // label + paddingX and the left segment wasn't a shrinkable flex child, so a
    // long mission spilled ~10 cells past the border into the clock (the image the
    // operator sent). /mission registers locally — no API turn.
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
    // Sol 5.6 slice 6: /run — the live run inspector. Resume a synthetic
    // session and open the surface: with no active run it must render the
    // honest empty state (never dead chrome); the frame + footer controls
    // must paint at both 120 (cockpit) and 80 (deck-strip) without splits.
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
    // Sol 5.6 slice 3/6: /context — the exact-plan view (digest · epoch ·
    // reductions line riding the summary). Static ANSI print into the
    // transcript; captured post-print.
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
    // Telemetry-truth lane captures: the three status boards driven whole —
    // /substrate (the capability board), /deck (the usage redesign), /trace
    // (the friction stopwatch section) — on the hermetic keyless home.
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
    // Telemetry-truth lane: /context on an OpenAI-SOURCED session — the
    // provider-generic layout must render (this rig reproduced the blank-
    // render bug): fixture ChatGPT credential + a gpt main model; fixtures
    // pin every endpoint base, nothing dials out.
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
    process.env.ANTHROPIC_MODEL = 'gpt-5.6-sol'
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
    // /context on an Anthropic-SOURCED session: a fixture Claude-subscription
    // credential in the pinned file store (scope user:inference, plan max) —
    // the same print, the source's own facts. The API base pins DEAD (the
    // fail-open lesson: an unpinned base + a staged credential dials the
    // real endpoint) so token counting refuses instantly and the print
    // renders its honest unmeasured state.
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
    // /context with NOTHING logged in (the hermetic keyless home): the
    // honest-absence layout with the attach route — never a blank block.
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
    // Bare --resume ⇒ the session picker. TWO fixtures on disk: SID (the
    // 'tools' variant — the tail-scan walks back to a clean assistant line ⇒
    // endedOnError false ⇒ unmarked row) and SID_ERRORED (the 'errors' variant
    // — its tail assistant carries isApiErrorMessage ⇒ formatLogMetadata
    // appends `✕ ended on error` to the row). The picker lists the REAL
    // projects dir (shared with live sessions, mtime-sorted — the
    // just-written fixtures land at/near the top): the capture verifies the
    // row FORMAT + picker chrome, never an exclusive listing. Extra ticks
    // over the resume baseline: metadata enrichment (readLiteMetadata) runs
    // per-row across every listed real session before rows settle.
    writeSyntheticSession('tools')
    writeSyntheticSession('errors', SID_ERRORED)
    return { argv: ['node', BIN, '--resume'], sends: [], total: 60, cols, rows }
  }
  if (name === 'cockpit-focus' || name === 'cockpit-drill') {
    // A2.2 Phase-3 focus model. cockpit-focus: Tab from the empty prompt focuses
    // the LANES rail (banner + ❯ caret on the first row). cockpit-drill: Tab ×2
    // reaches TELEMETRY, ↓ walks the cursor, ↵ opens the row's owning surface in
    // the center — the full focus→drill loop in one capture. (Control bytes are
    // built via fromCharCode so this source never carries a raw TAB/ESC.)
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
    // The RUNS lane: a REAL background shell surfaces in the
    // cockpit rail. Types a bang command (`!sleep 300` — model-free, no
    // permission ask), lets it run foreground past the ~2s progress
    // threshold (BackgroundHint + registerForeground both mount at that
    // gate — ctrl+b sent EARLIER is a no-op: nothing is registered yet),
    // then ctrl+b backgrounds it (task:background → backgroundAll) — a
    // genuine local_bash task with status 'running', isBackgrounded=true.
    // The lanes rail must render `RUNS · 1 live`, the rotating work glyph,
    // the command title, the `shell <elapsed>` verb — and the transcript
    // the "manually backgrounded" receipt (the full chain, end to end).
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
    // The RUNS drill-through loop: background a real
    // shell, Tab-focus the lanes rail, ↓ to the RUNS row, ↵ — the row routes
    // `/tasks <id>` so THAT task's Mercury process card opens directly (never
    // the generic list). The -esc variant then sends ESC and must land back
    // on the cockpit (the fork card's esc was a probe-caught dead key).
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
    // The Helm console (mini-REPL) under the telemetry rail's SUBSTRATE
    // (MERCURY_HELM_CONSOLE, ≥150 cols): Tab ×2 → telemetry focus, a ↓ burst
    // clamps the cursor onto the LAST selectable row — the console input on a
    // fresh session (no entries yet) — then typing AUTO-ENTERS compose (the
    // printable lands in the console line, never the prompt). Asserted by
    // scripts/helm-console/prove-console-render.ts on the grid json: section
    // header + ❯ buffer + ▌ block cursor + the compose hint. ↵ is deliberately
    // NOT sent — a submit spends usage (the billed live E2E covers that leg).
    //
    // The SAME capture also proves the lanes-rail MISSION BOARD (the task
    // ledger's cockpit home): a fixture task list is seeded on disk and the
    // PTY child pinned to it via MERCURY_TASK_LIST_ID — one in-progress
    // task (activeForm on the ◐ row) + two queued (○ rows).
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
    // ctrl+o opens the detailed-transcript overlay — verifies the footer's
    // 'drag select · ctrl+c copy' hint (P8 copy discoverability).
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: String.fromCharCode(15) }],
      total: 46, cols, rows,
    }
  }
  if (name === 'help') {
    // '?' on the empty prompt toggles the help menu — renders the shortcut
    // columns + the fork's deck-chip legend (uniqueness-program P5).
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '?' }],
      total: 46, cols, rows,
    }
  }
  if (name === 'help-commands') {
    // /help → tab to the "commands" tab — verifies the fork's domain-grouped
    // command browser (commandDomains.ts headers between groups) instead of
    // the old ~150-command alphabetical wall.
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 44, data: '/help' },
        { atTick: 54, data: '\r' },
        { atTick: 76, data: '\t' },
      ],
      total: 108, cols, rows,
      // Full-claim borderless browser: the SURFACE-CLAIM fill
      // correctly blanks the home chrome the default oracle markers used to
      // catch bleeding through — supply the view's own stable needles.
      chromeMarkers: ['Browse default commands', '▔'],
    }
  }
  if (name === 'queue-view') {
 // /queue — the -honest background-queue capability surface:
    // gated banner + PROBED daemon state + run-target matrix + a truthful empty
    // queue. The old illustrative job rows and the fabricated capacity meter are
    // deleted; this capture is the standing witness that they stay gone.
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
    // LIVE-INTEGRATION drag-copy probe (the operator: "it copies
    // everything outside the repl"): a real SGR press→drag→release over the
    // helm home's CENTER transcript. The pure clip-band proof covers the
    // selection math only — THIS drives ink.tsx's applySelectionClipBand walk
    // (hitTest → enclosing scroll pane → band) in the real tree. Copy-on-
    // select pbcopy's the selection; the caller (prove/probe script) then
    // inspects the host clipboard for rail leakage. Coords are 1-based SGR
    // cells at 120×44: col 30 sits in the center transcript, rows 26→30
    // cross the two turn lines; the left rail owns cols ≤21 at those rows.
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
    // Exit-grammar fix: ONE idle ctrl+c arms the exit
    // chord — the footer notice "press ctrl+c twice to close Mercury" for a
    // 3 s window. Observed-ready both ways: the press waits for the composer
    // sigil, the capture ends on the notice actually painting (the 3 s
    // window would outrun any fixed-tick guess on a slow boot).
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
    // Exit-grammar fix: the ONE copy receipt — "Copied
    // to clipboard", bottom-right (the notifications column's transient
    // row). -select: the clipband-probe drag, copy-on-select (default ON)
    // fires on release. -ctrlc: copy-on-select is seeded OFF in the proof
    // home, so the drag itself copies nothing and the receipt can ONLY come
    // from the plain-ctrl+c-with-selection path (cleanupScenario restores
    // the key — the proof home outlives one capture under a pinned
    // MERCURY_CONFIG_DIR).
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
 // baseline: the composer holding a LARGE PASTE. Today's
    // owner behavior (PromptInput PASTE_THRESHOLD=800 chars / >2 lines) routes
    // the body through pasteStore and paints ONE `[Pasted text #1 …]`
    // reference chip — never body spill. This pins the pre-ComposerDocumentV2
    // truth the B1 migration must preserve byte-for-byte in the composer band.
    // Observed-ready: the paste fires only once the bracketed-paste arm is on
    // the wire; readyText gates the settled chip, not a tick guess.
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
    // The PROMPTS PANEL (/workbench — the WORK panel retired in
    // place): the receipt roll over the
    // resumed 'short' session (two plain prompts), the cursor seeded on the
    // newest. The -resize variant selects the older prompt with ↑ and
    // crosses wide→narrow→wide: the selection must hold its ROW (identity,
    // not index), the mascot never doubles, the tab strip re-lays without a
    // stale pane (the RV-30 law, carried over from the retired board).
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
    // /accounts — LIVE: real config-scope
    // scan + session identity. Guards the live view's chrome + honesty lines.
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/accounts' }, { atTick: 38, data: '\r' }],
      total: 54, cols, rows,
    }
  }
  if (name === 'accounts-board-multi') {
    // The SIGNED-IN-MULTI state of the account
    // slots board — every credentialed family shows its own slot(s): the
    // live Anthropic ring (real scan — the landed 'accounts' precedent) plus
    // a fixture ChatGPT subscription AND a stored OpenAI key side by side,
    // plus a stored Z.AI key. Fixtures stage in the proof home the child
    // is pinned to.
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
    // The SIGNED-OUT state — an empty scratch
    // HOME (the node child's os.homedir honours env HOME) empties the
    // Anthropic ring down to the session's own signed-out scope; the
    // credential store is pinned to the file plane (the hermeticity seam —
    // no path to the real keychain) and the openai/zai stores are displaced,
    // so the engine families paint their honest ABSENT rows with the
    // sign-in routes (absent must show — never hidden).
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
    // The OPERATOR'S SHAPE — no Anthropic credential,
    // a fixture ChatGPT subscription, the main loop on a GPT model. The
    // accounts board's "main loop" row must name the OpenAI subscription
    // (never the Anthropic snapshot) and the Anthropic header must read
    // 0/2; the /model picker must gate the Anthropic group behind its
    // sign-in action row exactly as the other families are gated, with the
    // OpenAI group carrying the present account. Same hermeticity as the
    // signed-out board: a scratch HOME empties the Anthropic ring, the file
    // credential plane keeps the real keychain out, every base is dead.
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
    // Item A (wallet-aware not-logged-in gate): the operator's repro —
    // OpenAI connected, NO Anthropic credential, the session model on the
    // Anthropic default. The red 'Not logged in' banner must NOT fire;
    // the amber provider-specific steering row paints instead. Scratch
    // home with a FIXTURE openai auth file (never real tokens).
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
    // A typed character leaves the splash face — the notifications column
    // mounts with the working composer (the operator's repro posture).
    return { argv: ['node', BIN], sends: [{ atTick: 32, data: 'x' }], total: 70, cols, rows }
  }
  if (name === 'gpt-turn-render') {
    // Item D: the settled GPT turn's default view — prose only, no in-chat
    // thinking expander (provider-uniform rendering).
    writeSyntheticSession('gpt-thinking')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 45, cols, rows }
  }
  if (name === 'router-connect-steer') {
    // The retired /router connect arm answers with the /logins steering
    // (the operator's order) — never a dead arm, never an OAuth start.
    writeSyntheticSession('short')
    process.env.MERCURY_ROUTER = '1'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/router connect' }, { atTick: 38, data: '\r' }],
      total: 56, cols, rows,
    }
  }
  if (name === 'login-card') {
    // OpenAI parity: the /logins card's provider rows (Claude · OpenAI ·
    // usage-based · gateway). Opens the card only — nothing is selected, so
    // no OAuth flow and no network ever start.
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
    // The /logins card's Kimi · GLM · DeepSeek legs: every
    // capture boots on a SCRATCH home with every provider base pinned
    // to a dead port (the fail-open law), the file credential plane, and the
    // browser opener a no-op (BROWSER=true — the device leg opens the
    // verification page, which must never reach the operator's browser):
    //   · login-kimi-device   — /logins kimi → the Kimi row → sign in →
    //     global → the device screen, fed by ONE detached fixture OAuth host
    //     (device_authorization answers the code; the token endpoint stays
    //     authorization_pending, so the screen holds on the code + URL);
    //   · login-glm-key       — /logins glm → the GLM row → the Coding Plan
    //     choice → the key-entry screen;
    //   · login-deepseek-key  — /logins deepseek → the DeepSeek row → the
    //     key-entry screen;
    //   · accounts-board-kimi-signed-in — a fixture .moonshot-auth.json
    //     (tokens + region) ⇒ the board's Kimi slot.
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
    process.env.BROWSER = 'true'
    if (name === 'login-kimi-device') {
      const port = 47734
      const pidName = 'mercury-render-kimi-fixture.pid'
      try {
        const stale = Number(readFileSync(join(tmpdir(), pidName), 'utf8').trim())
        if (Number.isFinite(stale) && stale > 1) process.kill(stale)
      } catch {
        /* none leaked */
      }
      const serverJs = `const http=require('http');http.createServer((q,s)=>{let b='';q.on('data',c=>{b+=c});q.on('end',()=>{const j=(code,x)=>{s.writeHead(code,{'content-type':'application/json'});s.end(JSON.stringify(x))};if(q.method==='POST'&&q.url==='/api/oauth/device_authorization')return j(200,{device_code:'render-device-code',user_code:'KIMI-FIXT',verification_uri:'http://127.0.0.1:${port}/activate',verification_uri_complete:'http://127.0.0.1:${port}/activate?user_code=KIMI-FIXT',expires_in:300,interval:2});if(q.method==='POST'&&q.url==='/api/oauth/token')return j(400,{error:'authorization_pending'});if(q.url==='/ready')return j(200,{ok:true});j(404,{error:'not found'})})}).listen(${port},'127.0.0.1')`
      const child = spawn('node', ['-e', serverJs], { detached: true, stdio: 'ignore' })
      child.unref()
      writeFileSync(join(tmpdir(), pidName), String(child.pid ?? ''))
      execSync(
        `sh -c 'i=0; while [ $i -lt 40 ]; do curl -s -m 1 http://127.0.0.1:${port}/ready > /dev/null && exit 0; i=$((i+1)); sleep 0.25; done; echo "${pidName} server never became ready" >&2; exit 7'`,
      )
      process.env.MERCURY_MOONSHOT_OAUTH_BASE = `http://127.0.0.1:${port}`
      // /logins kimi pre-focuses the row; ↵ opens the Kimi leg, ↵ picks the
      // sign-in, ↵ picks the global region, the device screen paints.
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
    // LANE LA: the six remaining /logins rows' screens on the same dead-base
    // rig, plus three input-ownership probes whose final frame is the
    // evidence of which handler owns esc/← on a leg screen.
    if (name === 'login-claude-waiting') {
      // ↵ on the Claude row starts the first-party PKCE flow: the authorize
      // URL is built locally and only DISPLAYED; the code listener binds an
      // ephemeral loopback port; BROWSER=true no-ops the open. The paste
      // prompt joins the frame three seconds after the waiting screen.
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
      // The GLM Coding Plan key screen with three typed characters, then ←:
      // the frame answers whether ← moves the caret or closes the login.
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
      // The DeepSeek key screen, then esc: back to the card, or closed?
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
      // The Kimi choice screen, then esc: the leg's own cancel receipt, or
      // the container's 'Login interrupted'?
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
    // OpenAI parity: the /status fact grid's provider-labeled account rows
    // (Claude · OpenAI) — the OpenAI row always exists (multi-auth norm).
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/status' }, { atTick: 38, data: '\r' }],
      total: 60, cols, rows,
    }
  }
  if (name === 'companion-cockpit' || name === 'companion-deck') {
    // #178: the ARMED companion at both widths (the operator's "not
    // observable on frontend" report — no capture ever rendered the armed
    // state). ≥100 cols: the cockpit's BerthCompanionLine (constant presence:
    // mood dot + soul line between quips). <100 cols: the deck-strip
    // COMPANION DOCK. The global hermeticity pin ('0') is overridden HERE —
    // the soul text is per-session (captures mint fresh ids), so proofs
    // assert structure/authored-pool membership, never a golden string.
    writeSyntheticSession('short')
    process.env.MERCURY_DECK_COMPANION = '1'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [],
      total: 56, cols, rows,
    }
  }
  if (name === 'tasks-mission') {
    // #181 (LIVESTALE): the /tasks board with a live MISSION ledger and ZERO
    // background runs. The old board read only the process registry and said
    // "no tasks currently running" while the cockpit rail showed the live
    // mission — the dual-list must render the Mission section (via the SAME
    // telemetry bus the rail reads) with the runs scope honestly labeled
    // empty. Fixture: the cockpit-console mission ledger (1 in-progress with
    // activeForm + 2 queued + 1 done), pid-pinned via MERCURY_TASK_LIST_ID.
    writeSyntheticSession('short')
    writeMissionLedgerFixture()
    process.env.MERCURY_TASK_LIST_ID = MISSION_FIXTURE_LIST
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/tasks' }, { atTick: 38, data: '\r' }],
      total: 60, cols, rows,
    }
  }
  // (tasks-runs-only RETIRED: the ADJUDICATOR-recorded known-red closed by
  // its own named direction — prove-tasks-mission §B now drives the
  // artifact-arena idiom (fake wire + real runner) instead of this keyless
  // world that could never revive one.)
  if (name === 'cockpit-scrolled') {
    // The rail-drag regression repro (the
    // §STALE-PAINT): a TALL session in the wide cockpit, PageUp'd to the top.
    // Before the the compose walk full-width scroll-hint guard, the
    // center pane's blit+shift dragged the LEFT lanes rail's rows by the
    // scroll delta (the right rail, painted after the shift, stayed) — SEAT's
    // body vanished/displaced at scroll-top. The proof asserts both rails
    // intact WITH the scrolled state on screen (hero + jump-to-bottom pill).
    writeSyntheticSession('tall')
 // OBSERVED-READY doctrine): RECENT/NEXT populate from
    // async scans — under pool load they landed AFTER the old fixed schedule's
    // capture window (2× pooled-gate red, solo green — the recorded ui flake).
    // The first two PageUps now AWAIT those sections (atTick degrades into
    // the hard deadline), the rest pace relative to the previous send, and
    // the capture ends on a byte-stable scrolled grid (static scene — the
    // glyph/gaze pins above). readyText re-asserts both sections POST-scroll
    // (rails pinned). Never-ready worst case = the old fixed schedule, later.
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        // minTick 40 = the old schedule's boot allowance as a FLOOR: sends
        // fire at the proven cadence or LATER (awaiting late sections),
        // never earlier — an early scroll widened the scrolled-away window
        // and a late boot append flipped the pill to 'N new messages'
        // (CI run 29694788951; the prover accepts both pill texts now).
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
    // Click-to-toggle disclosure coverage: an agent report hidden
    // behind the collapsed `Done (…)` line, a lone glob `Found N files ⌄`, and
    // a folded classified-error card. This cfg is the collapsed BASELINE —
    // prove-click-expand.ts clones it and injects SGR mouse press+release
    // sends (\x1b[<0;x;yM / m) to drive the expand/collapse toggles.
    writeSyntheticSession('expand')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [],
      total: 70, cols, rows,
    }
  }
  if (name === 'two-bash-click') {
    // two separate collapsed Bash rows for the both-rows click
    // prover (prove-click-expand.ts drives the SGR mouse bytes).
    writeSyntheticSession('two-bash')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [],
      total: 70, cols, rows,
    }
  }
  if (name === 'tool-lifecycle') {
    // One-card-per-tool-id lifecycle (interaction-finish slice 6): a resolved
    // Edit (settled summary exactly once) + an unresolved Bash (queued card).
    writeSyntheticSession('lifecycle')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [],
      total: 70, cols, rows,
    }
  }
  if (name === 'autopilot-band') {
    // AUTOPILOT modeBand: boot with --dangerously-skip-permissions
    // (the session lands in bypass mode), MERCURY_AUTOPILOT armed, then ONE
    // shift+tab (\x1b[Z) cycles bypass → autopilot — the band must paint
    // `⌖ autopilot on — permissions bypassed · self-tier armed · <tier>`.
    // The launch consent dialog is latched OFF via a HERMETIC --settings file
    // (flagSettings carries skipDangerousModePermissionPrompt — never a write
    // into the real config home; the dialog's accept would mutate userSettings).
    process.env.MERCURY_AUTOPILOT = '1'
    const settingsPath = join(tmpdir(), 'autopilot-band-settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ skipDangerousModePermissionPrompt: true }),
    )
    writeSyntheticSession('short')
    return {
      argv: [
        'node', BIN, '--resume', SID,
        '--dangerously-skip-permissions', '--settings', settingsPath,
      ],
      sends: [{ atTick: 32, data: '\x1b[Z' }],
      total: 52, cols, rows,
    }
  }
  if (name === 'mode-band-accept' || name === 'mode-band-plan' || name === 'mode-band-auto') {
    // The mode-seal band, one scenario per flag-seedable carousel station
    // Seed via the native --permission-mode
    // flag (deterministic — no tick-timed shift+tab), capture the standing
    // band `<seal> <title> on (shift+tab to cycle)`. Default's expected look
    // is NO band — any base scenario (resume-2turn) is its capture; bypass
    // and autopilot have their own scenarios (consent latch / env arm).
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
    // The loud ⊠ alarm band (display name "Sovereign Mode";
    // internal id bypassPermissions), WITHOUT the autopilot hop:
    // the same hermetic consent latch as autopilot-band
    // (skipDangerousModePermissionPrompt via --settings — never a real-home
    // write), no MERCURY_AUTOPILOT, no shift+tab. The band must paint
    // `⊠ sovereign mode on — all tool calls auto-approved` (its own tail —
    // no cycle hint).
    const settingsPath = join(tmpdir(), 'mode-band-bypass-settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ skipDangerousModePermissionPrompt: true }),
    )
    writeSyntheticSession('short')
    return {
      argv: [
        'node', BIN, '--resume', SID,
        '--dangerously-skip-permissions', '--settings', settingsPath,
      ],
      sends: [],
      readyText: 'auto-approved',
      stableTicks: 4,
      total: 48, cols, rows,
    }
  }
  if (name === 'cockpit-policy') {
    // The Policy tab: open /cockpit,
    // digit-jump straight to tab 5 (the new 1-N jump), and capture the
    // lever-hinted Authority rows + the digit hint in the tower footer.
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
    // The in-session session switcher (SessionManagerView): /sessions mounts
    // the PROJECT scope, argless /resume mounts the FULL-history scope
    // (cross-project + cleared, window-navigable) — the
    // continuity-slice surface. Two fixtures so the grid has rows.
    writeSyntheticSession('tools')
    writeSyntheticSession('short', SID_ERRORED)
    const cmd = name === 'sessions-manager' ? '/sessions' : '/resume'
    return {
      argv: ['node', BIN, '--resume', SID],
      // Both commands mount the live manager DIRECTLY (no
      // /sessions gallery hop).
      sends: [
        { atTick: 30, data: cmd },
        { atTick: 36, data: '\r' },
      ],
      // Observed-ready on the manager's OWN settled header (two-phase paint
      // law): a bare tick budget captured whatever open phase timing served —
      // the committed overlay-family grids froze the manager's 2-row mounting
      // skeleton, and any boot-schedule perturbation (theme pin, machine
      // load) moved the phase and diverged the check. The header only renders
      // with the manager fully mounted; stableTicks seals the settled frame.
      readyText: name === 'sessions-manager' ? 'Switch to' : 'Full history',
      stableTicks: 4,
      total: 64, cols, rows,
    }
  }
  if (name === 'appearance') {
    // /appearance — the unified appearance center (feel-pass slice 6):
    // canonical ThemePicker embedded + accent swatch + motion row.
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/appearance' }, { atTick: 36, data: '\r' }],
      total: 52, cols, rows,
    }
  }
  if (name === 'bug') {
    // /bug — the honest local-draft feedback dialog (SM-J-P4): the report is
    // drafted locally, nothing uploads, and the copy says so.
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/bug' }, { atTick: 36, data: '\r' }],
      total: 52, cols, rows,
    }
  }
  if (name === 'mode-cycle-drive') {
    // Round-4 fold seam proof: three shift+tab presses must walk the mode
    // carousel (default -> implement -> strategy -> flow) on the FIXED store
    // polarity; the frame shows the mode indicator after the third press.
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
    // Re-cut for the dark-only ruling: the theme list is ONE
    // row (Oasis dark). Open /appearance, press ↓ TWICE — every press is
    // ANSWERED (never a dead key) while the caret stays on the single row,
    // the dark ground stays intact (nothing to preview-leak), and ctrl+c
    // remains honoured.
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
    // The feel-pass regression journey under the dark-only
    // law: there is no Light-preview leg (one reachable
    // appearance). Open /appearance, ↓ (answered on the single row),
    // Esc-CANCEL back out, then type a draft. The final frame proves the
    // center unwound cleanly (dark chrome intact) and the prompt draft
    // survived the whole journey.
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/appearance' },
        { atTick: 36, data: '\r' },
        { atTick: 46, data: String.fromCharCode(27) + '[B' }, // ↓ — answered; the caret stays on Oasis dark
        { atTick: 54, data: String.fromCharCode(27) }, // Esc — the center unwinds
        { atTick: 70, data: 'draft survives overlays' },
      ],
      total: 92, cols, rows,
    }
  }
  if (name === 'cockpit-model' || name === 'cockpit-palette') {
    // Open a modal/overlay OVER the cockpit home to verify it isn't trapped at the
    // center column width (the TerminalSizeContext override) or colliding with rails.
    writeSyntheticSession('short')
    const cmd = name === 'cockpit-model' ? '/model' : '/cockpit'
    // vshot.py sends: [{atTick, data}] — atTick in ~0.2s ticks; type the command,
    // then ENTER (\r) a few ticks later, after the cockpit has settled.
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: cmd }, { atTick: 36, data: '\r' }],
      total: 52, cols, rows,
    }
  }
  if (name === 'authority') {
    // /authority — the permissions panel (read-only capability gates + writable
    // feature toggles + the bypass row). Drive ↓↓ then ↵: proves the panel
    // mounts, arrows move the cursor IMMEDIATELY (never mount-buffered), the
    // master-detail line follows the cursor, and a post-buffer ↵ lands
    // harmlessly on a read-only gate row (no write). The buffer contract itself
    // (↵/space gated 150ms, arrows not) is source-locked in
    // prove-interaction-grammar.ts.
    //
    // History: an earlier revision pinned MERCURY_HELM_HOME=0 here because
    // helm-on @120 captured a "stale master-detail row". The three-stage probe
    // proved that was a CAPTURE artifact — vshot's iteration
    // ticks raced under a chatty child and the capture ended MID-BURST of the
    // transition frame. With wall-clock ticks + tail drain in vshot.py the
    // helm-on path renders 10/10 correct (probe-authority-helm.ts), so the
    // scenario runs the DEFAULT home again (cockpit at ≥100 cols — more
    // production-true).
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
    // The SATURN scheduler screen (the slot
    // named): the in-chat /saturn mount over seeded session records + the
    // box tier — a fire one-shot, a paused recurrence (spelling verbatim),
    // a screen-present birth, a held fire, and a headless box birth, so the
    // capture carries every row register (owner sections · next-fire words
    // · held count · the parity-floor legend). Times are hour-rounded
    // deltas so the composed words stay stable across the capture minute.
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
    // The TABULA notepad board. 'tabula' seeds a mixed journal (now/next/later
    // + a done row + one Minerva-refined line) into the pid-scratch pinned
    // above — the child's getOriginalCwd() is the repo root render-tui spawns
    // in, so the seed keys by the SAME sanitizePath convention. 'tabula-empty'
    // seeds nothing (the clean-slate EmptyState leg).
    writeSyntheticSession('short')
    if (name === 'tabula') {
      const slug = REPO.replace(/[^a-zA-Z0-9]/g, '-')
      const dir = join(process.env.MERCURY_TABULA_DIR!, slug)
      mkdirSync(dir, { recursive: true })
      const refinedBase = 'fix picker jank'
      // Mirrors noteTextHash (src/utils/hash.ts djb2Hash: 0-seeded, ×31,
      // signed |0, base36) so the refine event survives the fold — a wrong
      // hash renders the original text (the anti-stale guard doing its job).
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
    // The local-first capability center (Sol 5.6 WS2): sectioned readiness
    // list + detail card, cursor-following window, the flag-registry
    // ENVIRONMENT section. A few ↓ steps prove the cursor + window move; the
    // hermetic pins above keep every probed row deterministic (no daemon, no
    // teams, no live MCP in the scenario home).
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
    // The ENVIRONMENT section reached by the '6' jump — proves the 200+
    // registry rows are reachable (windowed, not capped) and the detail card
    // carries effective value + source + consumer for the selected flag.
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
 // The /memory files legacy picker instruction-profile line
    // + Mercury-native source markers ride this dialog).
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/memory files' }, { atTick: 36, data: '\r' }],
      total: 56, cols, rows,
    }
  }
  if (name.startsWith('agents-studio')) {
  // §20: the Agent Studio over a MIXED library — a native .mercury
    // agent, a dual-home shadow pair (.mercury wins), and an invalid file that
    // must stay visible. Fixtures live under RUNTIME_CWD's config homes and
    // cleanupScenario removes exactly these files.
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
    // agents-studio-create: the guided flow's first step (stable step ids).
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [...base, { atTick: 48, data: 'N' }],
      readyText: 'where should this agent live', stableTicks: 4,
      total: 110, cols, rows,
    }
  }
  if (name === 'manager-follow') {
 // -adjunct: the /manager scroll-follow law — walk the cursor far
    // past the first window and capture that the ▸ row stays visible with
    // honest ↑/↓ counters (the pre-fix defect: the selection walked below
    // the clipping modal fold and "disappeared").
    writeSyntheticSession('short')
    const down = '\u001b[B'
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/manager' },
        { atTick: 36, data: '\r' },
        // One ↓ per tick: the identity-stable cursor derives its index per
        // RENDER, so many keys in one PTY chunk coalesce to +1 (a synthetic
        // artifact — interactive keys arrive per-frame).
        ...Array.from({ length: 14 }, (_, k) => ({ atTick: 42 + k * 2, data: down })),
      ],
      // '↑ ' (arrow + space) only renders in the '↑ N more' counter — the
      // DEEP state after the walk; the home hints' '↑↓' has no space.
      readyText: '↑ ', stableTicks: 4,
      total: 110, cols, rows,
    }
  }
  if (name === 'manager-filter' || name === 'manager-nomatch') {
    // The /manager search row filters the
    // grouped index live. 'manager-filter' captures a mid-filter frame
    // (surviving groups + the truthful 'N of M match' meta); 'manager-nomatch'
    // captures the honest zero state. The query types only after the
    // manager's OWN settled meta line paints (two-phase paint law), so the
    // characters can never land on the composer; the settle gates ride
    // filter-only strings ('match · ↵' / the EmptyState title), which the
    // resting frame never contains.
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
  if (['critter', 'workflows', 'teammates', 'deck', 'sessions', 'substrate', 'trace', 'fleet', 'ledger', 'cards', 'scribe-promote', 'ide', 'config', 'permissions', 'hooks', 'agents', 'diff', 'tickets', 'memory', 'workbench', 'surfaces', 'palette', 'realms', 'status'].includes(name)) {
    // Drive a bare fork command (no args) over a resumed session to verify the
 // Mercury views render with the terracotta + honest states.
    // 'parity'/'map' left with the specimen purge; 'surfaces' (né /manager) is
    // the rebuilt effective-catalogue index; /sessions mounts the live
    // manager DIRECTLY — no gallery hop.)
    writeSyntheticSession('short')
    const sends = [{ atTick: 30, data: `/${name}` }, { atTick: 36, data: '\r' }]
    // /sessions mounts the manager over the cockpit through an open animation
    // — a bare tick budget captures whatever phase timing serves (the
    // committed baseline grids froze the 2-row mounting skeleton; any boot
    // perturbation moved the phase and diverged the check). Gate on the
    // manager's OWN settled header + a stable frame, with budget headroom for
    // a loaded machine — ready exits early on the fast path, and a scene that
    // never mounts REFUSES (vshot end-reason) instead of passing a transient.
    const settled = name === 'sessions'
      ? { readyText: 'Switch to', stableTicks: 4, total: 100 }
      : { total: 56 }
    return {
      argv: ['node', BIN, '--resume', SID],
      sends,
      ...settled, cols, rows,
      // /ide's plain select is borderless under the full-claim fill; every
      // other command in this family paints round Mercury chrome the default
      // markers already match (markers are OR'd, so listing both is safe).
      chromeMarkers: name === 'ide' ? ['Select IDE'] : undefined,
    }
  }
  if (name === 'keys-escape') {
    // The input atlas advertises 'esc close' (the CommandCenter footer on a
    // captureInput-false surface); Escape in BROWSE mode must actually close
 // it (one instance: the browse useInput handled
    // nav/tab/ctrl keys and dropped decodeNavKey's 'cancel'). The capture
    // opens /keys, waits for the atlas, sends a bare ESC, and settles —
    // prove-keys-escape asserts the atlas is ABSENT from the final frame.
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/keys' },
        { atTick: 36, data: '\r' },
        // atTick is the HARD deadline (awaitText only fires the send early);
        // give the atlas generous room so the ESC can never land on the
        // composer before the panel exists. The MARK captures the grid at
        // send time — the prover asserts the atlas was ON it (a capture
        // where the atlas never opened must refuse, not pass vacuously).
        { atTick: 120, minTick: 10, awaitText: 'input atlas', awaitSettleTicks: 3, data: '\x1b', mark: 'atlas-open' },
      ],
      // Settle on the composer being back; the ABSENCE assertion lives in
      // the prover (vshot asserts presence only).
      readyText: 'for commands', stableTicks: 6,
      total: 170, cols, rows,
    }
  }
  if (name === 'workflows-live-empty') {
    // Zero runs anywhere (no AppState tasks, no run.json on disk — no fixture
    // writer called) — the board must render the honest empty card, never a
    // blank/broken frame. Generous total: the board shows 'loading…' until
    // its first listWorkflowRuns(cwd) disk read resolves (see the
    // workflows-live-past comment on this same read's PTY wall-clock cost).
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/workflows' }, { atTick: 36, data: '\r' }],
 // the loaded board's own whole-board empty card IS the capture target
      // (a zero-runs home paints the 'No workflow runs' card, not the
      // per-section 'no workflows running' hint — that one needs rows
      // elsewhere on the board).
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
    // Active/Recent are empty in a synthetic render (no real AppState task),
    // so the board opens on section 0 ('Active') — Tab twice to reach 'Past'
    // (Recent, then Past) where the 2 fixture rows actually render. The board
    // shows 'loading…' (NavigablePanes' own `loading` prop) — and gates the
    // tab/drill axes off — until its first listWorkflowRuns(cwd) disk read
    // resolves; that read measured ~10-12s of PTY wall-clock in this harness
    // (bundle boot + pyte overhead, not a product perf issue), so the Tab
    // presses below wait well past that instead of racing the fetch (an
    // earlier Tab landing mid-'loading' was silently swallowed — nav is
    // inactive while loading, so the board never left section 0).
    // Tab timing hardened (task #3): the board gates tab/drill off while its
    // first listWorkflowRuns(cwd) disk read paints 'loading…' — measured
    // ~10-12s of PTY wall-clock alone, and a CONTENDED standalone render
    // (three sequential captures) pushed past the old tick-90 Tabs, leaving
    // the capture stranded on the empty Active section. The Tabs sit later
    // now, with margin over the worst observed settle.
 // OBSERVED-READY (MERCURY : the Tab waits existed only for the
    // board's first listWorkflowRuns(cwd) disk read ('loading…' gates nav
    // off) — so Tab 1 AWAITS the loaded board's own Active empty-hint
    // ('no workflows running'; the synthetic render has no live task) with
    // the old tick as the hard deadline, and every later key schedules
    // RELATIVE to the send that actually fired. End-state needles are the
    // prove-workflows-board grep targets; stableTicks guards the growth tail.
    // RUNNER-SPEED HARDENING (CI run 29771546608 — the 2-core ubuntu runner
    // blew the tick-105/175 deadlines, pooled AND solo): the slash send is
    // boot-CAUSAL (awaitRaw on the bracketed-paste arm, minTick 30 = the
    // proven local cadence as the FLOOR — locally byte-identical, never
    // earlier), and every awaitText hard deadline + total roughly doubles.
    // awaitText fires at READY, so a fast machine never waits the new slack.
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
              // Open the completed run (sorts first — newer startTime) and HOLD
              // on the run view: phase separators + lanes + the selected
              // agent's dossier card are the capture target (task #3).
              { afterPrevTicks: 8, data: '\r' },
            ]
          : name === 'workflows-live-inspector' || name === 'workflows-live-inspector-long'
            ? [
                { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
                { afterPrevTicks: 6, data: '\r' },
                { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: TAB },
                { afterPrevTicks: 4, data: TAB },
                { afterPrevTicks: 8, data: '\r' }, // open the completed run (sorts first — newer startTime)
                // Board→run is a full AlternateScreen remount (§1: each view fully
                // replaces the previous one), which settles noticeably slower under
                // load than an in-place Tab/select — a tight gap here landed the
                // NEXT Enter while the board's own instance was still processing
                // the first one (a re-drill, not the run's onActivate). The
                // dossier's out-row marks the run view SETTLED; old-gap deadline.
                { atTick: 360, awaitText: 'out Design complete', minTick: 12, data: '\r' }, // open the selected agent (the full inspector auto-reads)
                // The long variant then EXPANDS: `e` arms only because the long
                // out clips (the footer hint and the key share one predicate).
                ...(name === 'workflows-live-inspector-long'
                  ? [{ atTick: 460, awaitText: 'e expand', minTick: 8, data: 'e' }]
                  : []),
              ]
            : name === 'workflows-live-arrows'
              ? [
                  // ARROWS WALK THE RAIL (operator-reported twice):
                  // the board boots on EMPTY Active; ↓↓ must cross the two
                  // empty sections onto Past row 0, and a third ↓ moves WITHIN
                  // Past — no Tab anywhere. The capture exit IS the assertion
                  // target (observed-ready on the row-2 caret).
                  { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
                  { afterPrevTicks: 6, data: '\r' },
                  { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: '\x1b[B' },
                  { afterPrevTicks: 4, data: '\x1b[B' }, // Recent(0) → Past row 0
                  { afterPrevTicks: 4, data: '\x1b[B' }, // Past row 0 → row 1 (stale-drifter)
                ]
              : name === 'workflows-live-settled'
                ? [
 // open the PAUSED fixture (sorts LAST — oldest
                    // startTime) and hold on its run view: the stopped/skipped
                    // lane words + the muted phase tones are the capture target.
                    { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
                    { afterPrevTicks: 6, data: '\r' },
                    { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: TAB },
                    { afterPrevTicks: 4, data: TAB },
                    { afterPrevTicks: 6, data: '\x1b[B' }, // ↓ → stale-drifter (row 2)
                    { afterPrevTicks: 4, data: '\x1b[B' }, // ↓ → harbor-sweep (row 3)
                    { afterPrevTicks: 8, data: '\r' }, // open its run view
                  ]
                : name === 'workflows-live-backoff'
                  ? [
 // open the stale-drifter run view — its one
                      // in-flight agent carries the producer's backoff fields;
                      // the lane must NAME the provider wait.
                      { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
                      { afterPrevTicks: 6, data: '\r' },
                      { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: TAB },
                      { afterPrevTicks: 4, data: TAB },
                      { afterPrevTicks: 6, data: '\x1b[B' }, // ↓ → stale-drifter (row 2)
                      { afterPrevTicks: 8, data: '\r' }, // open its run view
                    ]
                : [
                // CARRY-BACK (slice F leftover): ↓ onto the SECOND Past row,
                // open its run view, then ← back — the re-mounted board must
                // seed the cursor on the row it left from (initialRowKey),
                // not dump it at row 0. Remount gaps stay generous but relative.
                { atTick: 60, minTick: 30, awaitRaw: RAW_ARM, data: '/workflows' },
                { afterPrevTicks: 6, data: '\r' },
                { atTick: 220, awaitText: 'no workflows running', minTick: 8, data: TAB },
                { afterPrevTicks: 4, data: TAB },
                { afterPrevTicks: 6, data: '\x1b[B' }, // ↓ → stale-drifter (row 2)
                { afterPrevTicks: 6, data: '\r' }, // open its run view
                { afterPrevTicks: 25, data: '\x1b[D' }, // ← back to the board (remount settle)
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
    // Cross-process honesty (trust-cockpit W3): two claims-running manifests
    // owned by a live pid that is NOT the board's session ⇒ the conditional
    // External section with one 'run · running elsewhere' row (fresh
    // heartbeat) and one 'wedged · heartbeat silent, pid alive' row (mtime
    // backdated past the 45s window). Tab twice (post-'loading…', same timing
    // as workflows-live-past above) — the section header row always shows
    // `External (2)`, but NavigablePanes paints only the FOCUSED section's
    // rows, and Active(0) has focus on open. The tick budget also keeps a
    // first-attempt capture inside the extlive row's 45s freshness window (a
    // 2nd oracle-retry attempt can land past it, decaying that row honestly
    // to 'wedged' — section + rows still capture).
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
    // /config's provider-derived rows — the read-only main-loop
    // model pointer (provider · model — /model) and one account-presence row
    // per provider family the catalogue knows (no credential in the capture
    // home ⇒ honest absent rows). The search query 'provider' filters the list to exactly
    // these derived rows at both widths.
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
    // The /usage panel's DERIVED per-family sections with the
    // engine lanes armed. The panel's own availability law (any-provider-
    // credential) makes a credential-LESS home refuse the command — the
    // exact right behaviour and the wrong capture — so the scenario seeds
    // the OpenAI fixture credential (the lane prover's shape, never real
    // tokens): the headline state IS "OpenAI-only credential ⇒ the panel
    // exists", Anthropic absent-with-route beside it.
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
    // The NEUTRAL Status accounts
    // section with a MIXED credential estate — OpenAI + OpenRouter + Gemini
    // signed in from seeded fixture FILES, Anthropic honestly absent — so
    // one frame pins the uniform per-provider grammar in both states.
    // Scratch home; every provider base pinned to a dead local port so the
    // capture child performs ZERO real provider I/O by construction (the
    // fail-open law: an empty pin falls open to the real endpoints).
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
    // The Hugging Face router + local-server families (blind-shipped):
    // every capture boots on a SCRATCH home with every provider
    // base pinned to a dead port (the fail-open law), the local probe set
    // pinned to the fixture (or 'none'), and ONE detached fixture server
    // replaying the documented shapes:
    //   · model-picker-hf         — HF_TOKEN fixture + a fixture ROUTER serving
    //     the five verbatim catalogue rows ⇒ the Hugging Face group renders
    //     selectable live rows with the signed-in detail line;
    //   · model-picker-local      — a fixture OLLAMA (tags · version · ps ·
    //     show) ⇒ the local group renders the server's real list with the
    //     `local · Ollama` detail (served · num_ctx · server-default · tools);
    //   · accounts-board-hf-signed-in — a fixture .huggingface-auth.json
    //     (OAuth tokens + identity) ⇒ the board's Hugging Face slot;
    //   · settings-usage-hf / -local — the /usage sections for each family.
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
    const startFixture = (pidName: string, port: number, serverJs: string, readyPath: string): void => {
      try {
        const stale = Number(readFileSync(join(tmpdir(), pidName), 'utf8').trim())
        if (Number.isFinite(stale) && stale > 1) process.kill(stale)
      } catch {
        /* none leaked */
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
      // The local probe lands after the first paint; /model opens once the
      // composer sigil has painted, well past the sub-second probe. The
      // group under capture sits below the Anthropic/OpenAI/OpenRouter/
      // Gemini sections, so the focus walks down to it (22 rows to the
      // middle of the five live Hugging Face rows; 45 to the local rows
      // that follow the key-lane groups and the dated, unavailable pins).
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
    // The /usage Settings panel (the instrument restyle): the
    // kit tab grammar (no inverse blocks; selected = bold role color,
    // underlined while the header holds focus). -status-tab arrows ←← to the
    // Status tab: the identity header (✶ + version chip) over the
    // session/account/engine eyebrow sections with the aligned label grid.
    // The Usage tab body renders its honest loading/error state (no API in
    // captures) — the chrome is what this scenario pins.
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
      // The Settings pane scrolls the prompt frame out of the visible grid —
      // pin the tab strip instead of the default prompt-chrome markers.
      chromeMarkers: ['Config', 'Usage'],
    }
  }
  if (name === 'router-board') {
    // /router over a seeded route store: an active party dependency
    // graph (accepted/working/held node glyphs, the overlap-serialized
    // adjustment, the affinity record) above the accepted scribe plan — the
    // sideInfo "why this route?" glance must render reason CODES + the width
    // explanation, and the header must show posture + the honest provider
    // availability (openai/zai as not-integrated codes).
    writeSyntheticSession('short')
    writeRouterFixtures()
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/router' }, { atTick: 36, data: '\r' }],
      total: 80, cols, rows,
    }
  }
  if (name === 'router-detail') {
    // ↵ on the active plan row: the full decision record (policy version ·
    // source · posture · display reasons · per-node states with attempts +
    // models + the typed completion line) + the event tail.
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
  // (There are no legacy-doctor scenarios and no
  // certificate `s` legacy drill-down — the
  // panels live as certificate rows.)
  if (name === 'health' || name === 'health-detail') {
    // /health — the harness install certificate (docs/HEALTH-CERTIFICATE.md):
    // verdict banner + evidence-backed sectioned checks. Runs against the LIVE
    // repo state (the checks are honest reads, so row statuses vary with the
    // machine); the capture verifies the SURFACE paints — banner, sections,
    // evidence lines — at both column tiers, not specific verdicts. -detail
    // ↵-expands the first check after a generous settle (the workflows-live
    // lesson) so the full evidence + fix trail renders.
    writeSyntheticSession('short')
    const sends = [{ atTick: 30, data: '/health' }, { atTick: 36, data: '\r' }]
    // ↓↓ then ↵: proves the panel's own useInput owns the keys (cursor lands on
    // row 2) AND the expanded evidence trail renders under it.
    if (name === 'health-detail') {
      sends.push({ atTick: 66, data: '\u001b[B' }, { atTick: 70, data: '\u001b[B' }, { atTick: 76, data: '\r' })
    }
    return {
      argv: ['node', BIN, '--resume', SID],
      sends,
 // NOT observed-ready audit): the certificate is an INLINE
      // surface — '❯' stays visible below it, so a text gate degenerates to
      // stability-alone, and the cert's async check rows pause long enough
      // to fake stillness (the pinned STABLE-ALONE HAZARD). Fixed budget.
      total: name === 'health-detail' ? 105 : 80, cols, rows,
    }
  }
  if (name === 'provenance') {
    // /provenance — the system-prompt bill-of-materials.
    // A resumed session composes the prompt only when a QUERY runs, so this
    // deterministic capture verifies the panel CHROME + the honest EMPTY state
    // ("no composition recorded yet") — the trust-cockpit failure≠silence
    // pattern. The populated-state group math is proof-covered
    // (scripts/substrate/prove-prompt-provenance.ts).
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/provenance' }, { atTick: 36, data: '\r' }],
      total: 60, cols, rows,
    }
  }
  if (name === 'critter-home') {
    // The retint unify (operator-reported): with the octopus
    // critter pinned, 'critter-home' proves the WHOLE home paints in the
    // octopus hue (sprite + wordmark + plinth + rails together) — no split
    // sprite-vs-chrome paint (the ledgered two-read-paths class; the ONE
    // derivation is useSessionAccent).
    process.env.MERCURY_CRITTER = 'octopus'
    writeSyntheticSession('short')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 48, cols, rows }
  }
  // ── the critter STATE matrix ────────────────────────
  // The operator has to be able to LOOK at every critter in every state. The
  // /critter picker is the one surface that puts all four creatures on screen
  // in a single frame, so the three state legs all drive it rather than
  // capturing four sessions each: one capture per STATE, not per creature.
  if (name === 'critter-awake' || name === 'critter-sleep' || name === 'critter-flow') {
    if (name === 'critter-sleep') {
      // FORCED: the live derivation (CR-3: zero agents running past the
      // grace) cannot be staged in a capture. '1' pins the sleeping frame —
      // the authored per-critter sleep POSE, lids, the slow drift, the Zzz —
      // and deliberately overrides the picker cards' specimen veto, which
      // exists for live use: this one flag turns the picker into the
      // all-creatures sleep gallery.
      process.env.MERCURY_CRITTER_SLEEP = '1'
    }
    if (name === 'critter-flow') {
      // LOOK-ONLY, deliberately NOT hermetic: the undulation samples the live
      // clock, so this lands on an arbitrary sway phase and must never carry a
      // golden needle. It exists so the motion can be inspected at all — the
      // frame-0 pin every other capture uses would show a still critter, which
      // is exactly what this lane changed.
      process.env.MERCURY_CRITTER_IDLE = '1'
    }
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/critter' }, { atTick: 36, data: '\r' }],
      total: 72, cols, rows,
    }
  }
  // The BERTH asleep — the cockpit's own mascot at ≥100 cols, where the sleep
  // state actually matters day to day (the berth is the session's only critter
  // in the Helm home).
  if (name === 'berth-sleep') {
    process.env.MERCURY_CRITTER_SLEEP = '1'
    writeSyntheticSession('short')
    return { argv: ['node', BIN, '--resume', SID], sends: [], total: 56, cols, rows }
  }
  // THE GHOST-BOX REPRO (banked ~01:20). A slash-opened surface over
  // the Helm home: the operator's screenshot showed a stray empty rounded frame
  // painted to the RIGHT of the berth critter, vanishing when the surface
  // closed. Capture at 120 (the berth needs ≥100 cols) and confirm the strip
  // beside the critter is EMPTY SPACE, not an empty card.
  if (name === 'berth-ghost') {
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/model' }, { atTick: 36, data: '\r' }],
      total: 80, cols, rows,
    }
  }
  if (name === 'health-fault') {
    // FAILURE-STATE SLOT, live-render fallback — a seeded-FAULT fixture is NOT
    // safely stageable here: lastCertPath() (utils/healthReport.ts) resolves
    // the cwd's project doctor store (adoptiveProjectPath — `.mercury`
    // canonical; MERCURY_DOCTOR_STATE_DIR only re-roots it), the
    // spawned binary's cwd is pinned to the REAL checkout (RUNTIME_CWD —
    // pty.fork inherits the invoking shell's cwd; vshot has no per-scenario
    // cwd seam), and that path already holds the operator's live artifact
    // (the Helm health chip reads it) — a fixture write would clobber real
    // state. It would also prove nothing: last-cert is an OUTPUT of the
    // /health run — the certificate re-derives its verdict from live probes
    // every time, so a seeded FAULT could never paint the banner. This slot
    // therefore captures the certificate LIVE (same mechanics as 'health',
    // kept as a distinct name so the failure-state matrix stays enumerable):
    // the verdict banner + whatever honest degraded rows the machine carries
    // — the globally-pinned MERCURY_BOOT_PREFLIGHT=0 guarantees at least the
    // 'Env overrides' non-default row.
    writeSyntheticSession('short')
    return {
      argv: ['node', BIN, '--resume', SID],
      sends: [{ atTick: 30, data: '/health' }, { atTick: 36, data: '\r' }],
      total: 80, cols, rows,
    }
  }
  // ══════════════════════════════════════════════════════════════════════════
  //  The SR journey family (SR-005..007,
  //  SR-016/017/023/028/033/048..052/071/072/076/090). Each scenario drives
  //  the REAL dist through the registered fixture seam and the real
  //  route/screen/input machinery. Test-only seams: MERCURY_RENDER_SCRATCH
  //  (exposes the hermetic home for post-run inspection — transcript
  //  pollution proofs) and MERCURY_RENDER_CLICK ('col;row', 1-based — the
  //  two-pass pointer journeys synthesize an SGR press/release there).
  // ══════════════════════════════════════════════════════════════════════════
  if (name.startsWith('concourse-r0-')) {
    const scratch = process.env.MERCURY_RENDER_SCRATCH || join(tmpdir(), `hermes-render-${name}-${process.pid}`)
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
    // The reference seed WITHOUT the needs-you rail: initial region is then
    // the BOARD (§8.5 default-focus law), which makes arrow/Enter journeys
    // deterministic under the idle-parked first-keypress hazard.
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
      // R7 F5 (resume-click et al): a journey may hand the scenario a
      // COMPLETE fixture of its own (e.g. a paused-session peek) — the env
      // seam lives HERE, beside the theme seam; the scenario's default
      // fixture stands otherwise.
      const fixtureOverride = process.env.MERCURY_RENDER_FIXTURE
      const fixtureJson =
        fixtureOverride !== undefined && fixtureOverride.trim().startsWith('{')
          ? fixtureOverride
          : JSON.stringify(fixture)
      writeFileSync(fixturePath, fixtureJson)
      process.env.MERCURY_CONFIG_DIR = scratch
      if (policy === null) delete process.env.MERCURY_CONCOURSE
      else process.env.MERCURY_CONCOURSE = policy
      process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
      // MERCURY_RENDER_DAEMON_DIR (opt-in): held-socket journeys
      // (prove-concourse-async-truth) bind a REAL control socket BEFORE the
      // render starts, so their daemon dir must live OUTSIDE this seed's
      // rmSync wipe — a socket bound into the scratch races the wipe+reseed
      // and a lost race paints 'failed' (transport loss) where the journey
      // awaits the typed refusal. Absent ⇒ byte-identical scratch-local dir.
      const daemonDir = process.env.MERCURY_RENDER_DAEMON_DIR || join(scratch, 'daemon')
      process.env.MERCURY_DAEMON_DIR = daemonDir
      process.env.MERCURY_DAEMON_DIR = daemonDir
      process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
      // R7 E-MED-7: the fixtures painted needs-you rows whose DURABLE
      // obligations never existed, so every capture-based journey could
      // only exercise the store-miss path — 'open' NAVIGATING was
      // structurally unprovable on this rig. Opt-in seam: seed the crew
      // store to MATCH the painted fixture (per-project key = the child's
      // cwd, the obligations owner's own law).
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
          /* seeding is best-effort — a journey that needs it asserts its outcome */
        }
      }
    }
    if (name === 'concourse-r0-empty') {
      seedEnv(emptyFixture(), 'always')
      return { argv: ['node', BIN], sends: [], total: 60, cols, rows }
    }
    if (name === 'concourse-r0-empty-enter') {
      // One Enter must begin new-session editing (SR-033). Sent twice — the
      // idle-parked first-keypress eat is a known PTY hazard; on the fixed
      // tree the second ↵ lands inside the editor where an empty draft
      // previews/refuses without dispatch (SR-088 gates the provider).
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
      // Board-focused fixture; ↓×3 (eat-tolerant: 2 or 3 land) moves the
      // selection off the seeded row. The reproducer asserts the SAME-FRAME
      // board▸/Peek identity law, whichever row the cursor settled on.
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
      // SR-035: '/' in browse opens the Concourse's OWN filter editor (never
      // the root slash-command path); typing narrows the board live.
      seedEnv(referenceFixtureSnapshot(), 'always')
      return {
        argv: ['node', BIN],
        sends: [
          // Inert primer (r0-route-cycle discipline): the run's FIRST stdin
          // byte absorbs the documented >5s idle mode re-assert, so '/' is
          // never the first input (the first-input-after-idle class).
          { atTick: 32, awaitText: 'answer & resume', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '\u001b[A' },
          { afterPrevTicks: 2, data: '/' },
          // Type only after the filter editor's own legend paints — STRICT:
          // a missed filter-open reds as UNDELIVERED-SENDS instead of
          // typing hotkeys onto the still-open board.
          { afterPrevTicks: 2, awaitText: 'type to filter', awaitSettleTicks: 1, requireAwait: true, data: 'oauth' },
        ],
        total: 90,
        cols,
        rows,
      }
    }
    if (name === 'concourse-r0-click') {
      // Two-pass pointer journey: the reproducer discovered the target's
      // committed-grid coordinates on a sendless pass and passes them via
      // MERCURY_RENDER_CLICK ('col;row', 1-based). Press/release ×2 (the
      // first-keypress hazard applies to the whole stdin path).
      const at = (process.env.MERCURY_RENDER_CLICK ?? '').split(';').map(v => Number(v))
      const col = Number.isFinite(at[0]) && at[0]! > 0 ? at[0]! : 2
      const row = Number.isFinite(at[1]) && at[1]! > 0 ? at[1]! : 2
      const press = `\u001b[<0;${col};${row}M`
      const release = `\u001b[<0;${col};${row}m`
      // FN-008 receipts beside controls are timed (the route clears
      // applied notes after 4s; refused/failed linger 10s — R7 + item 8);
      // a journey grading a receipt passes a shorter MERCURY_RENDER_TOTAL
      // so the final frame lands INSIDE its receipt window (ticks are 0.2s
      // wall clock -- the default 84 samples ~10s after the click, at the
      // refused-clear boundary).
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
      // SR-042 (R7 F9): the process SUSPEND/RESUME first-key trace — park
      // the whole TUI with SIGTSTP mid-session, resume with SIGCONT (the
      // stdin-resume path re-asserts terminal modes), then ONE ↓: the walk
      // must step EXACTLY one row (no eaten key, no doubled key).
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
      // Boot the ROOT REPL (no concourse boot policy — Off gates boot
      // routing only; on-demand /concourse entry is lawful under every
      // policy), then drive the alias. The reproducer inspects the scratch
      // transcript store afterwards: the alias must leave ZERO
      // user/assistant rows (SR-016/017) — on the bound tree the command
      // persists and returns a chat receipt.
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
      // SR-018's expect-red journey: /concourse driven inside a RESUMED
      // cockpit session. On the bound tree the transcript receipt paints
      // while the root REPL still owns every cell and the Concourse never
      // elevates in this context (captured live at tick 62) —
      // the exact mixed-surface state of the 10.49.38 field frame. The
      // capture lands a few ticks after the command settles so the frame
      // shows the coexistence, not the boot.
      const fixturePath = join(tmpdir(), `sr-alias-resumed-fixture-${process.pid}.json`)
      writeFileSync(fixturePath, JSON.stringify(noRailFixture()))
      process.env.MERCURY_CONCOURSE_FIXTURE = fixturePath
      writeSyntheticSession('short')
      return {
        argv: ['node', BIN, '--resume', SID],
        sends: [
          { atTick: 34, awaitText: '\u276f', minTick: 5, awaitSettleTicks: 2, data: '/concourse' },
          { afterPrevTicks: 3, data: '\r' },
          // After the (slow) elevation settles, return once — the durable
          // trace of the mixed-surface violation is the receipt persisting
          // as conversation material in the revealed root transcript.
          { atTick: 90, awaitText: 'SESSIONS', minTick: 44, awaitSettleTicks: 3, data: '\u001b' },
        ],
        total: 120,
        cols,
        rows,
        chromeMarkers: ['\u276f', '\u256d', '\u2502', '\u2570', 'SESSIONS'],
      }
    }
    if (name === 'concourse-r0-esc-probe') {
      // Diagnostic probe (R0 journey design): does a bare double-Escape on a
      // resumed root open the Rewind selector on this build?
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
      // The transition-leak journey (SR-023): after the alias routes to the
      // Concourse, a burst of repeated Escape (a held key's autorepeat has
      // no key-up metadata) must settle at the root REPL WITHOUT opening
      // the destructive Rewind selector. The root resumes a STAGED 2-turn
      // session (the resume-2turn convention) so Rewind has real material -
      // the field session had conversation history; a virgin home cannot
      // arm the leak. The concourse fixture seam still feeds the route.
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
      // Generic driven-keys journey over the fixture concourse (the batch-B
      // input provers): MERCURY_RENDER_KEYS carries the vshot sends JSON —
      // provers build it with REAL escape bytes via String.fromCharCode, so
      // no source file ever holds a raw control byte. MERCURY_RENDER_SEED
      // picks the fixture ('empty' | 'reference' | default noRail);
      // MERCURY_RENDER_TOTAL bounds the run; MERCURY_RENDER_READY declares
      // the observed end (see below). The env seam lives HERE (the scripts
      // layer); the product reads none of these.
      const seedKind = process.env.MERCURY_RENDER_SEED ?? 'noRail'
      // MERCURY_RENDER_FIXTURE (JSON) overrides the seed wholesale — the
      // matrix provers build exact board/rail states (e.g. the SR-075
      // needs-you overflow) without a scenario per state. 'live' seeds the
      // scratch home WITHOUT the fixture seam: the surface builds the REAL
      // snapshot (empty board, but the durable draft/seed stores are live —
      // the SR-087 durability journeys need the un-masked path).
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
      // MERCURY_RENDER_READY (JSON string or string[]) → vshot readyText:
      // the journey's observed END. MERCURY_RENDER_TOTAL is a WALL-CLOCK
      // ceiling (tick = elapsed/0.2s — a crawling host gets no extra time),
      // so load-honest journeys carry big budgets; without a declared ready
      // end every green run would burn the whole budget. Absent ⇒
      // byte-identical budget-end behavior.
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
      // SR-010's census journey (+ SR-024's terminal-mode leg): ONE boot of
      // the real dist, then root → Concourse (alias) → Boot Settings
      // (ctrl+pgdn) → Concourse (ctrl+pgup) → session (Enter) → Concourse
      // (Esc) → root (Esc) → Concourse (alias) → root — two lifetimes' worth
      // of transitions under one Ink mount. The prover censuses the raw
      // stream (VSHOT_TEE): every terminal-mode obligation must be
      // boot-scoped; a second Ink lifetime would re-emit its mode set here.
      // Each route-committing send is PRECEDED (2 ticks) by an inert primer
      // keypress (↑) that absorbs the documented >5s stdin-gap mode
      // re-assert (App.handleReadable → reassertTerminalModes — the tmux/
      // ssh/wake self-heal fires on the FIRST input after a gap): with the
      // gap consumed, any mode write inside a route send's settle window is
      // route-driven by construction — the census's defect signal. The
      // prover pins route-send indices; keep the layouts in lockstep.
      // Marks snapshot each surface's settled frame for the route-truth leg
      // ('LIVE PEEK' is Concourse-only; 'Doctor / Health Check' is the Boot
      // face's own card row (the ORIGINAL launcher card — the
      // settings menu lives one 'm' deeper and never paints it); 'SESSIONS'
      // paints on BOTH the root rail and the board, so it cannot gate).
      seedEnv(noRailFixture(), null)
      return {
        argv: ['node', BIN],
        sends: [
          /*  0 */ { atTick: 34, awaitText: '❯', minTick: 5, awaitSettleTicks: 2, data: '/concourse' },
          /*  1 */ { afterPrevTicks: 3, data: '\r' }, // ROUTE → concourse
          /*  2 */ { atTick: 80, awaitText: 'LIVE PEEK', minTick: 42, awaitSettleTicks: 2, data: '\u001b[A' },
          /*  3 */ { afterPrevTicks: 2, mark: 'concourse-1', data: '\u001b[6;5~' }, // ROUTE → boot-settings
          /*  4 */ { atTick: 112, awaitText: 'Doctor / Health Check', minTick: 84, awaitSettleTicks: 2, data: '\u001b[A' },
          /*  5 */ { afterPrevTicks: 2, mark: 'boot-settings', data: '\u001b[5;5~' }, // ROUTE → concourse
          /*  6 */ { atTick: 144, awaitText: 'LIVE PEEK', minTick: 116, awaitSettleTicks: 2, data: '\u001b[A' },
          /*  7 */ { afterPrevTicks: 2, mark: 'concourse-2', data: '\r' }, // ROUTE → session
          /*  8 */ { afterPrevTicks: 10, data: '\u001b[A' },
          /*  9 */ { afterPrevTicks: 2, mark: 'session', data: '\u001b' }, // ROUTE → concourse
          /* 10 */ { afterPrevTicks: 8, data: '\u001b[A' },
          /* 11 */ { afterPrevTicks: 2, mark: 'concourse-3', data: '\u001b' }, // ROUTE → root
          /* 12 */ { afterPrevTicks: 8, data: '\u001b[A' },
          /* 13 */ { afterPrevTicks: 2, mark: 'root-1', data: '/concourse' },
          /* 14 */ { afterPrevTicks: 3, data: '\r' }, // ROUTE → concourse
          /* 15 */ { atTick: 216, awaitText: 'LIVE PEEK', minTick: 190, awaitSettleTicks: 2, data: '\u001b[A' },
          /* 16 */ { afterPrevTicks: 2, mark: 'concourse-4', data: '\u001b' }, // ROUTE → root
        ],
        total: 245,
        cols,
        rows,
      }
    }
    if (name === 'concourse-r0-session-enter') {
      // Enter on the selected board row opens the full session surface;
      // 'hello' must echo in a REAL composer (SR-090). The R0-bound tree
      // mounted the read-only SessionPeekScreen (no composer, no echo, a
      // 'read-only projection' banner); the R4 AttachedSessionScreen is the
      // interactive surface this journey now proves.
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
        // The bound tree's session route may paint a chrome-less projection
        // (or die on a missing worker record) — the REPRODUCER grades the
        // frame; the oracle only needs to accept that SOMETHING painted.
        chromeMarkers: ['❯', '╭', '│', '╰', 'read-only', 'Mercury', 'SESSIONS', 'session'],
      }
    }
  }
  throw new Error(`unknown scenario: ${name}`)
}

export function routerFixtureDir(): string {
  return join(tmpdir(), `hermes-router-fixture-${process.pid}`)
}

/** Seed the route store: one RUNNING party dependency-graph (mixed node
 *  states — accepted/working/held/blocked, an attempt-2 node, a shared-lane
 *  width adjustment) + one ACCEPTED scribe plan, plus a small event tail. All
 *  timestamps recent so freshness rows read live, none scheduled (no wall-clock
 *  drift class). */
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
  const partyPlan = {
    version: 1,
    id: 'rp-fx-party',
    revision: 1,
    mode: 'party',
    title: 'ship the three-stage migration',
    objective: 'schema, then implementation and docs',
    features: { taskShape: 'bounded', ambiguity: 0, coupling: 1, parallelism: 2, contextDemand: 1, verificationDemand: 1, estimatedFiles: 3, explicitPaths: [], requiresSynthesis: true },
    profile: 'dependency-graph',
    nodes: [
      { id: 'n1', title: 'schema', task: 'migrate the schema', dependsOn: [], ownsPaths: ['src/schema.ts'], acceptance: accept('n1'), state: 'accepted', attempt: 1, assignedWorker: 'dps1', assignedModel: model('sonnet', 'claude-sonnet-5', 'high'), busRequestId: 'fx-r1', expectedResult: 'typed completion', completion: { summary: 'schema migrated, both checks green', checksReported: ['schema compiles: PASS'], changedAreas: ['src/schema.ts'], unresolved: [], reportedAt: now - 200_000, acceptedBy: 'router', acceptedAt: now - 190_000 } },
      { id: 'n2', title: 'implementation', task: 'implement against the new schema', dependsOn: ['n1'], ownsPaths: ['src/impl.ts'], acceptance: accept('n2'), state: 'working', attempt: 2, assignedWorker: 'dps2', assignedModel: model('sonnet', 'claude-sonnet-5', 'high'), busRequestId: 'fx-r2', workerGeneration: 2, expectedResult: 'typed completion' },
      { id: 'n3', title: 'docs', task: 'update the docs', dependsOn: ['n1'], ownsPaths: ['docs/m.md'], acceptance: accept('n3'), state: 'held', attempt: 1, assignedWorker: 'dps3', assignedModel: model('opus', 'claude-opus-4-8[1m]', 'xhigh'), busRequestId: 'fx-r3', expectedResult: 'typed completion' },
    ],
    synthesis: { required: true, owner: 'router', acceptance: [{ id: 'synthesis-integrated', description: 'all required nodes accepted', kind: 'report' }] },
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
  const scribePlan = {
    version: 1,
    id: 'rp-fx-scribe',
    revision: 1,
    mode: 'scribe',
    title: 'status --json flag',
    objective: 'add the missing --json output mode',
    features: { taskShape: 'bounded', ambiguity: 0, coupling: 0, parallelism: 0, contextDemand: 1, verificationDemand: 1, estimatedFiles: 1, explicitPaths: ['src/commands/status.ts'], requiresSynthesis: false },
    profile: 'sonnet-opus-review',
    nodes: [
      { id: 'n1', title: 'status --json', task: 'add the flag + one test', dependsOn: [], ownsPaths: ['src/commands/status.ts'], acceptance: accept('n1'), state: 'accepted', attempt: 1, assignedWorker: 'implementer', assignedModel: model('sonnet', 'claude-sonnet-5', 'high'), busRequestId: 'fx-s1', expectedResult: 'typed completion', completion: { summary: 'flag added, test green', checksReported: ['new test: PASS'], changedAreas: ['src/commands/status.ts'], unresolved: [], reportedAt: now - 500_000, acceptedBy: 'scribe', acceptedAt: now - 490_000 } },
    ],
    synthesis: { required: false, owner: 'scribe', acceptance: [] },
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
    { ts: now - 200_000, planId: 'rp-fx-party', nodeId: 'n1', from: 'working', to: 'reported' },
    { ts: now - 190_000, planId: 'rp-fx-party', nodeId: 'n1', from: 'reported', to: 'accepted', reason: 'accepted by router' },
    { ts: now - 180_000, planId: 'rp-fx-party', nodeId: 'n3', from: 'dispatched', to: 'held', reason: 'reconfiguring dps3 → claude-opus-4-8[1m]@xhigh' },
    { ts: now - 20_000, planId: 'rp-fx-party', nodeId: 'n2', from: 'delivered', to: 'working' },
  ]
  writeFileSync(
    join(dir, 'plans.json'),
    JSON.stringify({ _v: 1, plans: [scribePlan, partyPlan], events, updatedAt: now - 20_000 }),
  )
}
// ── mission-ledger fixture (cockpit-console) ─────────────────────────────────
// The task-ledger store the lanes-rail MISSION BOARD reads: a pid-suffixed
// task LIST under <config>/tasks/ (the U20 concurrency guard), pinned to the
// PTY child via MERCURY_TASK_LIST_ID (the registry-canonical spelling —
// no foreign compat read) — a live session's real ledger can
// never bleed into a capture, and the fixture can never be adopted by one.
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
    /* already gone */
  }
}

// agent-studio fixtures — exactly these files, cleaned by name.
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
    // Restore the copy-on-select default the scenario seeded OFF — the proof
    // home outlives one capture when MERCURY_CONFIG_DIR is pinned, so a
    // stray key would flip later captures' drag-copy behaviour.
    const cfgPath = join(CONFIG_HOME, '.mercury.json')
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      delete cfg['copyOnSelect']
      writeFileSync(cfgPath, JSON.stringify(cfg))
    } catch {
      /* home already gone */
    }
  }
  if (name.startsWith('accounts-board-') || name === 'model-picker-operator-shape') {
    // Restore whatever the credential-store fixtures displaced in the proof
    // home, and hand back the env the signed-out state redirected.
    for (const [path, prior] of accountsBoardStash) {
      try {
        if (prior === null) rmSync(path, { force: true })
        else writeFileSync(path, prior)
      } catch {
        /* best effort — a leaked fixture file is proof-home clutter only */
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
          /* temp-dir clutter only */
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
      /* never started or already gone */
    }
    try {
      rmSync(pidFile, { force: true })
    } catch {
      /* gone */
    }
  }
  if (name === 'login-kimi-device') {
    const pidFile = join(tmpdir(), 'mercury-render-kimi-fixture.pid')
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(pid) && pid > 1) process.kill(pid)
    } catch {
      /* never started or already gone */
    }
    try {
      rmSync(pidFile, { force: true })
    } catch {
      /* gone */
    }
  }
  if (name === 'model-picker-gpt') {
    const pidFile = join(tmpdir(), 'mercury-render-gpt-fixture.pid')
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(pid) && pid > 1) process.kill(pid)
    } catch {
      /* never started or already gone */
    }
    try {
      rmSync(pidFile, { force: true })
    } catch {
      /* gone */
    }
  }
  if (name.startsWith('agents-studio')) {
    for (const f of AGENT_STUDIO_FIXTURES) {
      try {
        rmSync(f, { force: true })
      } catch {
        /* already gone */
      }
    }
    // Remove the fixture dirs only when WE emptied them (a real project
    // agents dir is never disturbed).
    for (const dir of [
      join(RUNTIME_CWD, '.mercury', 'agents'),
      join(RUNTIME_CWD, '.claude', 'agents'),
    ]) {
      try {
        rmdirSync(dir)
      } catch {
        /* non-empty or gone — leave it */
      }
    }
  }
  if (name === 'cockpit-console' || name === 'tasks-mission') {
    cleanupMissionLedgerFixture()
  }
  // companion-* re-arm the row for their capture — restore the hermeticity
  // pin so every later scenario in the same process stays soul-free.
  if (name.startsWith('companion-')) {
    process.env.MERCURY_DECK_COMPANION = '0'
  }
  // Tabula pid-scratch: scenarios seed journals into it ('tabula', the helm
  // rail legs) — always reset so a LATER scenario in the same process (the
  // 'tabula' → 'tabula-empty' pair) starts clean. Only ever a tmpdir pid path
  // set by scenario() itself, never an operator store.
  try {
    rmSync(join(tmpdir(), `hermes-render-tabula-${process.pid}`), { recursive: true, force: true })
  } catch {
    /* already gone */
  }
  // critter-home pins MERCURY_CRITTER in scenario() — undo it here so a
  // same-process follow-up scenario can't inherit the tint (the party-fixture
  // cleanup pattern).
  if (name === 'critter-home') {
    delete process.env.MERCURY_CRITTER
  }
  // The state legs pin the sleep/idle seams in scenario() — undo them
  // here for the same reason critter-home undoes its tint, so a same-process
  // follow-up scenario can't inherit a forced sleep or a live clock.
  if (name === 'critter-sleep' || name === 'berth-sleep') {
    delete process.env.MERCURY_CRITTER_SLEEP
  }
  if (name === 'critter-flow') {
    delete process.env.MERCURY_CRITTER_IDLE
  }
  try { rmSync(join(PROJECTS, `${SID}.jsonl`)) } catch { /* gone */ }
  if (name === 'resume-picker') {
    try { rmSync(join(PROJECTS, `${SID_ERRORED}.jsonl`)) } catch { /* gone */ }
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

/**
 * Reap fixtures LEAKED by a hard-killed render run. Every fixture here is
 * pid-suffixed (the U20 concurrency guard), so per-name cleanup only removes
 * THIS pid's — a render-tui killed outright (outer harness timeout, ctrl-C,
 * SIGKILL) leaks fixtures no later run ever names again. Leaked `wf_fixture_*`
 * run manifests are worse than clutter: the /workflows orphan check + the
 * /doctor Workflows row honestly report them as an orphaned run (seen live
 * — a WARN caused by a dead render's fixture). Sweep peers whose
 * embedded pid is DEAD; a LIVE pid (concurrent render) is never touched, so
 * the U20 race-guard stays intact. (pid % 0xffffff is the suffix encoding —
 * lossless for real macOS pids, which stay far below 16M.)
 */
function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = exists but not ours — treat as alive; ESRCH = gone.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
function reapDeadPidFixtures(): void {
  // Leaked workflow run manifests: .claude/workflows/runs/wf_fixture_*_<hex>
  try {
    for (const entry of readdirSync(WF_RUNS_ROOT)) {
      const m = /^wf_fixture_[a-z]+_([0-9a-f]{6})$/.exec(entry)
      if (!m) continue
      if (!pidAlive(parseInt(m[1]!, 16))) {
        try { rmSync(join(WF_RUNS_ROOT, entry), { recursive: true, force: true }) } catch { /* raced */ }
      }
    }
  } catch { /* no runs dir — nothing leaked */ }
  // Leaked synthetic sessions: PROJECTS/00000000-aaaa-bbbb-{cccc,dddd}-<hex12>.jsonl
  try {
    for (const entry of readdirSync(PROJECTS)) {
      const m = /^00000000-aaaa-bbbb-[cd]{4}-([0-9a-f]{12})\.jsonl$/.exec(entry)
      if (!m) continue
      if (!pidAlive(parseInt(m[1]!, 16))) {
        try { rmSync(join(PROJECTS, entry)) } catch { /* raced */ }
      }
    }
  } catch { /* no projects dir */ }
}
