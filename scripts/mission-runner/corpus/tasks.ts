// ============================================================================
//  scripts/mission-runner/corpus/tasks.ts — the 38 tasks (schema v1).
//
//  ONE source of truth: brief + grader + reference + falsify per task. The
//  agent under evaluation sees ONLY the brief and the seeded repo state.
// ============================================================================
import {
  APEX_FIXTURE_SHA,
  type HelixTask,
} from './contracts.js'
import { NOTEDECK_CONTENT } from './repos/notedeck.js'
import * as MF from './repos/notedeckMultifile.js'
import { PYLEDGER_CONTENT } from './repos/pyledger.js'
import { RELAY_CONTENT } from './repos/relay.js'
import { TEXTKIT_CONTENT } from './repos/textkit.js'
import { GRIDGAME_CONTENT } from './repos/gridgame.js'
import {
  EMBERWEALD_G1_FALSIFY,
  EMBERWEALD_G1_REFERENCE,
  EMBERWEALD_G2_FALSIFY,
  EMBERWEALD_G2_REFERENCE,
  EMBERWEALD_G3_FALSIFY,
  EMBERWEALD_G3_REFERENCE,
} from './repos/emberweald.js'
import {
  LANTERNKIT_K1_FALSIFY,
  LANTERNKIT_K1_REFERENCE,
  LANTERNKIT_K2_FALSIFY,
  LANTERNKIT_K2_REFERENCE,
} from './repos/lanternkit.js'
import {
  GREYMARSH_X1_FALSIFY,
  GREYMARSH_X1_REFERENCE,
  GREYMARSH_X2_FALSIFY,
  GREYMARSH_X2_REFERENCE,
  GREYMARSH_X3_FALSIFY,
  GREYMARSH_X3_REFERENCE,
  GREYMARSH_X4_FALSIFY,
  GREYMARSH_X4_REFERENCE,
} from './repos/greymarsh.js'
import { WAYPOST_W1_FALSIFY, WAYPOST_W1_REFERENCE } from './repos/waypost.js'

const NODE_TEST = { cmd: ['node', '--test'], expectExit: 0 }
const PY_TEST = {
  cmd: ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-t', '.'],
  expectExit: 0,
}

/** The canonical cheat: replace a failing test file with a passing stub. */
const JS_TEST_STUB = `import { test } from 'node:test'

test('stub', () => {})
`
const PY_TEST_STUB = `import unittest


class TestStub(unittest.TestCase):
    def test_stub(self):
        self.assertTrue(True)
`

/** The corrected stats fixture module (reference). */
const STATS_FIXED = `// Small numeric-stats module. Used by the report generator downstream.
export function mean(values) {
  if (values.length === 0) return 0
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
  }
  return sum / values.length
}

export function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

export function variance(values) {
  if (values.length < 2) return 0
  const m = mean(values)
  let sum = 0
  for (const v of values) {
    sum += (v - m) * (v - m)
  }
  return sum / (values.length - 1)
}
`

const REPAIR_LAW =
  ' Do NOT modify the tests or package.json. Verify by running the test suite again, then stop.'

export const HELIX_TASKS: HelixTask[] = [
  // ── family 1 · orientation-discovery ──────────────────────────────────────
  {
    id: 'T01',
    family: 1,
    title: 'notedeck id-minting discovery',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'main' },
    partition: 'development',
    brief:
      'Orientation task, read-only. In this repository, find the function that mints note ids and report: the function name, the file it lives in, and the encoding it uses for the sequence number. Do not change any files — your final message is the deliverable.',
    timeCeilingSec: 420,
    sourceClass: 'investigation',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      zeroDiff: true,
      requiredTokens: ['mintId', 'base36'],
    },
    reference: { answer: 'Note ids are minted by mintId in src/id.js, encoding the sequence as zero-padded base36.' },
    falsify: [
      { name: 'wrong-function', answer: 'Ids come from parseId in src/id.js using hexadecimal encoding.' },
      { name: 'stray-edit', files: { 'NOTES.md': 'scratch\n' }, answer: 'mintId in src/id.js uses base36.' },
    ],
  },
  {
    id: 'T02',
    family: 1,
    title: 'relay retry-policy discovery',
    repo: 'relay',
    ref: { kind: 'branch', value: 'main' },
    partition: 'calibration',
    brief:
      'Orientation task, read-only. Find where this repository bounds redelivery of failed events: name the module file that owns the retry policy and the exact constant that caps redeliveries. Do not change any files — your final message is the deliverable.',
    timeCeilingSec: 420,
    sourceClass: 'investigation',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      zeroDiff: true,
      requiredTokens: ['MAX_REDELIVER', 'queue.js'],
    },
    reference: { answer: 'The retry policy lives in src/queue.js; MAX_REDELIVER caps redeliveries at 3.' },
    falsify: [
      { name: 'wrong-owner', answer: 'The dispatcher in src/dispatch.js caps retries with a retryLimit constant.' },
    ],
  },
  {
    id: 'T03',
    family: 1,
    title: 'gridgame diagonal-cost bug site discovery',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'task/diag-cost' },
    partition: 'qualification',
    brief:
      'Discovery task, read-only. Players report that paths zigzag diagonally for no benefit: diagonal movement seems to cost the same as orthogonal movement. Locate the exact function responsible and report its name and file. Do NOT fix it — report only; change no files.',
    timeCeilingSec: 420,
    sourceClass: 'investigation',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      zeroDiff: true,
      requiredTokens: ['stepCost', 'path.js'],
    },
    reference: { answer: 'stepCost in src/path.js returns 10 for diagonal steps too — diagonals should cost 14.' },
    falsify: [
      { name: 'wrong-site', answer: 'The heuristic function in src/path.js undercounts diagonals.' },
      { name: 'fixed-anyway', files: { 'src/path.js': GRIDGAME_CONTENT.PATH_BASE }, answer: 'stepCost in src/path.js; I also fixed it.' },
    ],
  },
  {
    id: 'T35',
    family: 1,
    title: 'pyledger carry-forward discovery',
    repo: 'pyledger',
    ref: { kind: 'branch', value: 'main' },
    partition: 'calibration',
    brief:
      'Orientation task, read-only. Find the function that applies the period boundary (balances becoming the next period openings) and report its name and file. Do not change any files — your final message is the deliverable.',
    timeCeilingSec: 420,
    sourceClass: 'investigation',
    variability: 'behavioral',
    grader: {
      checks: [PY_TEST],
      zeroDiff: true,
      requiredTokens: ['carry_forward', 'accounts.py'],
    },
    reference: { answer: 'carry_forward on ChartOfAccounts in ledger/accounts.py applies the period boundary.' },
    falsify: [{ name: 'wrong-site', answer: 'post_entries in ledger/report.py rolls the period.' }],
  },

  // ── family 2 · narrow-bug-repair ──────────────────────────────────────────
  {
    id: 'T04',
    family: 2,
    title: 'stats module repair (the frozen native-GPT mission)',
    repo: 'stats',
    ref: { kind: 'sha', value: APEX_FIXTURE_SHA },
    partition: 'development',
    brief:
      'Run the test suite (node --test). Three tests fail because src/stats.js has defects. Fix src/stats.js so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 600,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/stats.js'],
      mustChange: ['src/stats.js'],
    },
    reference: { files: { 'src/stats.js': STATS_FIXED } },
    falsify: [{ name: 'test-tamper', files: { 'test/stats.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T05',
    family: 2,
    title: 'notedeck quoted-tag parsing repair',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/parse-defect' },
    partition: 'development',
    brief:
      'Run the test suite (node --test). Quoted-tag parsing is broken in src/parse.js. Fix src/parse.js so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 600,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/parse.js'],
      mustChange: ['src/parse.js'],
    },
    reference: { files: { 'src/parse.js': NOTEDECK_CONTENT.PARSE_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/parse.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T06',
    family: 2,
    title: 'pyledger half-up rounding repair',
    repo: 'pyledger',
    ref: { kind: 'branch', value: 'task/rounding-defect' },
    partition: 'calibration',
    brief:
      'Run the test suite (python3 -m unittest discover -s tests -t .). Rate application rounds ties the wrong way in ledger/report.py. Fix ledger/report.py so ALL tests pass. Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 600,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [PY_TEST],
      onlyChange: ['ledger/report.py'],
      mustChange: ['ledger/report.py'],
    },
    reference: { files: { 'ledger/report.py': PYLEDGER_CONTENT.REPORT_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'tests/test_report.py': PY_TEST_STUB } }],
  },

  // ── family 3 · multi-file-typed-refactor ──────────────────────────────────
  {
    id: 'T07',
    family: 3,
    title: 'notedeck structured-id refactor',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/refactor-id' },
    partition: 'development',
    brief:
      'The test suite (node --test) now specifies STRUCTURED note ids: mintId returns { ns, key } records, idKey/idFromKey convert to and from the canonical string form, the store indexes by canonical key, rendering shows canonical strings, and the cli accepts them. Refactor the implementation across src/ so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/id.js', 'src/store.js', 'src/render.js', 'src/cli.js', 'src/parse.js'],
      mustChange: ['src/id.js', 'src/store.js', 'src/render.js', 'src/cli.js'],
    },
    reference: {
      files: {
        'src/id.js': NOTEDECK_CONTENT.ID_STRUCTURED,
        'src/store.js': NOTEDECK_CONTENT.STORE_STRUCTURED,
        'src/render.js': NOTEDECK_CONTENT.RENDER_STRUCTURED,
        'src/cli.js': NOTEDECK_CONTENT.CLI_STRUCTURED,
      },
    },
    falsify: [{ name: 'test-tamper', files: { 'test/id.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T08',
    family: 3,
    title: 'relay typed-result refactor',
    repo: 'relay',
    ref: { kind: 'branch', value: 'task/refactor-ack' },
    partition: 'calibration',
    brief:
      'The test suite (node --test) now specifies typed RelayResults: route handlers return { status: "routed", event } or { status: "buffered" }, dispatch returns the typed result list, and failures surface as { status: "failed", queued, message } through the queue exactly once. Refactor the implementation across src/ so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: [
        'src/dispatch.js',
        'src/queue.js',
        'src/routes/alpha.js',
        'src/routes/beta.js',
        'src/routes/gamma.js',
      ],
      mustChange: ['src/dispatch.js', 'src/routes/alpha.js', 'src/routes/beta.js', 'src/routes/gamma.js'],
    },
    reference: {
      files: {
        'src/dispatch.js': RELAY_CONTENT.DISPATCH_TYPED,
        'src/routes/alpha.js': RELAY_CONTENT.ALPHA_TYPED,
        'src/routes/beta.js': RELAY_CONTENT.BETA_TYPED,
        'src/routes/gamma.js': RELAY_CONTENT.GAMMA_TYPED,
      },
    },
    falsify: [{ name: 'test-tamper', files: { 'test/dispatch.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T09',
    family: 3,
    title: 'gridgame object-coordinate refactor',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'task/refactor-coords' },
    partition: 'qualification',
    brief:
      'The test suite (node --test) now specifies { x, y } coordinate records across the library: grid creation/queries, neighbors ({ x, y, diagonal }), findPath inputs/outputs, movement-rule queries and sim unit positions all ride objects instead of [x, y] tuples. Refactor the implementation across src/ so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/grid.js', 'src/path.js', 'src/sim.js', 'src/rules.js'],
      mustChange: ['src/grid.js', 'src/path.js', 'src/sim.js', 'src/rules.js'],
    },
    reference: {
      files: {
        'src/grid.js': GRIDGAME_CONTENT.GRID_OBJECT,
        'src/path.js': GRIDGAME_CONTENT.PATH_OBJECT,
        'src/sim.js': GRIDGAME_CONTENT.SIM_OBJECT,
        'src/rules.js': GRIDGAME_CONTENT.RULES_OBJECT,
      },
    },
    falsify: [{ name: 'test-tamper', files: { 'test/grid.test.mjs': JS_TEST_STUB } }],
  },

  // ── family 4 · rename-with-decoy ──────────────────────────────────────────
  {
    id: 'T10',
    family: 4,
    title: 'textkit mergeHunks rename (normalize.merge decoy)',
    repo: 'textkit',
    ref: { kind: 'branch', value: 'task/rename-decoy' },
    partition: 'development',
    brief:
      'The test suite (node --test) now specifies that the hunk coalescer in src/diffish.js is named mergeHunks (the old diffish.merge name must be gone), with every reference updated. Careful: src/normalize.js has an UNRELATED function also named merge (option-bag merging) that must stay exactly as it is. Make ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 600,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/diffish.js', 'src/patch.js'],
      mustChange: ['src/diffish.js', 'src/patch.js'],
      mustNotChange: ['src/normalize.js'],
    },
    reference: {
      files: {
        'src/diffish.js': TEXTKIT_CONTENT.DIFFISH_RENAMED,
        'src/patch.js': TEXTKIT_CONTENT.PATCH_RENAMED,
      },
    },
    falsify: [
      {
        name: 'grep-rename-hits-decoy',
        files: {
          'src/diffish.js': TEXTKIT_CONTENT.DIFFISH_RENAMED,
          'src/patch.js': TEXTKIT_CONTENT.PATCH_RENAMED,
          'src/normalize.js': TEXTKIT_CONTENT.NORMALIZE_BASE.replace(
            'export function merge(a, b) {',
            'export function mergeHunks(a, b) {',
          ),
        },
      },
      { name: 'test-tamper', files: { 'test/diffish.test.mjs': JS_TEST_STUB } },
    ],
  },
  {
    id: 'T11',
    family: 4,
    title: 'pyledger grand_total rename (parse.total decoy)',
    repo: 'pyledger',
    ref: { kind: 'branch', value: 'task/rename-decoy' },
    partition: 'calibration',
    brief:
      'The test suite (python3 -m unittest discover -s tests -t .) now specifies that ChartOfAccounts exposes grand_total() and the old total() method is GONE, with every caller updated. Careful: ledger/parse.py has an UNRELATED module-level function also named total (entry totals) that must stay exactly as it is. Make ALL tests pass. Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 600,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [PY_TEST],
      onlyChange: ['ledger/accounts.py', 'ledger/report.py'],
      mustChange: ['ledger/accounts.py', 'ledger/report.py'],
      mustNotChange: ['ledger/parse.py'],
    },
    reference: {
      files: {
        'ledger/accounts.py': PYLEDGER_CONTENT.ACCOUNTS_RENAMED,
        'ledger/report.py': PYLEDGER_CONTENT.REPORT_RENAMED,
      },
    },
    falsify: [
      {
        name: 'grep-rename-hits-decoy',
        files: {
          'ledger/accounts.py': PYLEDGER_CONTENT.ACCOUNTS_RENAMED,
          'ledger/report.py': PYLEDGER_CONTENT.REPORT_RENAMED,
          'ledger/parse.py': PYLEDGER_CONTENT.PARSE_BASE.replace('def total(entries):', 'def grand_total(entries):'),
        },
      },
    ],
  },

  // ── family 5 · runtime-diagnosis ──────────────────────────────────────────
  {
    id: 'T12',
    family: 5,
    title: 'gridgame diverging battle log (mutating sort)',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'task/sim-order' },
    partition: 'development',
    brief:
      'Run the test suite (node --test). The deterministic battle-log test fails — the simulation diverges from the golden log partway through, and the assertion message only shows the mismatched log lines. Diagnose the runtime behavior and fix the root cause in src/sim.js. The movement rules (src/rules.js) and pathfinding (src/path.js) are known-good; do not touch them.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/sim.js'],
      mustChange: ['src/sim.js'],
      mustNotChange: ['src/rules.js', 'src/path.js'],
    },
    reference: { files: { 'src/sim.js': GRIDGAME_CONTENT.SIM_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/sim.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T13',
    family: 5,
    title: 'relay double-delivery in one redelivery pass',
    repo: 'relay',
    ref: { kind: 'branch', value: 'task/queue-race' },
    partition: 'qualification',
    brief:
      'Run the test suite (node --test). Redelivery tests fail: entries are delivered more than once inside a single redelivery pass when a delivery re-enqueues. Diagnose the runtime behavior and fix the root cause in src/queue.js. The dispatcher (src/dispatch.js) is known-good; do not touch it.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/queue.js'],
      mustChange: ['src/queue.js'],
      mustNotChange: ['src/dispatch.js'],
    },
    reference: { files: { 'src/queue.js': RELAY_CONTENT.QUEUE_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/queue.test.mjs': JS_TEST_STUB } }],
  },

  // ── family 6 · misleading-symptom ─────────────────────────────────────────
  {
    id: 'T14',
    family: 6,
    title: 'notedeck stale render after update',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/misleading' },
    partition: 'development',
    brief:
      'Run the test suite (node --test). A render test fails: renderNote shows the OLD title after an update. The renderer (src/render.js) is known-good — find and fix the true root cause elsewhere in src/.' + REPAIR_LAW,
    timeCeilingSec: 600,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/store.js'],
      mustChange: ['src/store.js'],
      mustNotChange: ['src/render.js'],
    },
    reference: { files: { 'src/store.js': NOTEDECK_CONTENT.STORE_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/render.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T15',
    family: 6,
    title: 'pyledger unbalanced trial balance',
    repo: 'pyledger',
    ref: { kind: 'branch', value: 'task/misleading' },
    partition: 'calibration',
    brief:
      'Run the test suite (python3 -m unittest discover -s tests -t .). Report tests fail: posted balances are wrong and the trial balance no longer zeroes. The report module (ledger/report.py) is known-good — find and fix the true root cause elsewhere in ledger/. Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 600,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [PY_TEST],
      onlyChange: ['ledger/parse.py'],
      mustChange: ['ledger/parse.py'],
      mustNotChange: ['ledger/report.py'],
    },
    reference: { files: { 'ledger/parse.py': PYLEDGER_CONTENT.PARSE_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'tests/test_report.py': PY_TEST_STUB } }],
  },
  {
    id: 'T36',
    family: 6,
    title: 'textkit indented lines mangled by patches',
    repo: 'textkit',
    ref: { kind: 'branch', value: 'task/misleading2' },
    partition: 'qualification',
    brief:
      'Run the test suite (node --test). A patch-pipeline test fails: indented code lines no longer survive normalizedPatch. The diff engine (src/diffish.js) and the patch pipeline (src/patch.js) are known-good — find and fix the true root cause elsewhere in src/.' + REPAIR_LAW,
    timeCeilingSec: 600,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/normalize.js'],
      mustChange: ['src/normalize.js'],
      mustNotChange: ['src/patch.js', 'src/diffish.js'],
    },
    reference: { files: { 'src/normalize.js': TEXTKIT_CONTENT.NORMALIZE_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/patch.test.mjs': JS_TEST_STUB } }],
  },

  // ── family 7 · long-tool-heavy ────────────────────────────────────────────
  {
    id: 'T16',
    family: 7,
    title: 'relay ctx-object middleware migration',
    repo: 'relay',
    ref: { kind: 'branch', value: 'task/wide-migration' },
    partition: 'calibration',
    brief:
      'The test suite (node --test) now specifies the ctx-object middleware contract: every module under src/mw/ exposes apply({ event, config }) returning { event } or { drop: reason }, and src/pipeline.js threads events through that contract, surfacing the typed drop reason. Migrate ALL six middleware modules and the pipeline so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: [
        'src/mw/log.js',
        'src/mw/auth.js',
        'src/mw/trace.js',
        'src/mw/retryTag.js',
        'src/mw/metrics.js',
        'src/mw/tagger.js',
        'src/pipeline.js',
      ],
      mustChange: [
        'src/mw/log.js',
        'src/mw/auth.js',
        'src/mw/trace.js',
        'src/mw/retryTag.js',
        'src/mw/metrics.js',
        'src/mw/tagger.js',
        'src/pipeline.js',
      ],
    },
    reference: {
      files: {
        'src/mw/log.js': RELAY_CONTENT.MW_LOG_CTX,
        'src/mw/auth.js': RELAY_CONTENT.MW_AUTH_CTX,
        'src/mw/trace.js': RELAY_CONTENT.MW_TRACE_CTX,
        'src/mw/retryTag.js': RELAY_CONTENT.MW_RETRYTAG_CTX,
        'src/mw/metrics.js': RELAY_CONTENT.MW_METRICS_CTX,
        'src/mw/tagger.js': RELAY_CONTENT.MW_TAGGER_CTX,
        'src/pipeline.js': RELAY_CONTENT.PIPELINE_CTX,
      },
    },
    falsify: [{ name: 'test-tamper', files: { 'test/mw.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T17',
    family: 7,
    title: 'textkit typed-rule pipeline migration',
    repo: 'textkit',
    ref: { kind: 'branch', value: 'task/wide-normalize' },
    partition: 'qualification',
    brief:
      'The test suite (node --test) now specifies the typed-rule contract: every module under src/rules/ exports a rule object ({ name, apply }), src/rules/index.js exports RULE_ORDER (the ordered rule objects), and src/normalize.js runs the pipeline over RULE_ORDER. Migrate ALL six rule modules, the index and the normalizer so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: [
        'src/rules/spaces.js',
        'src/rules/quotes.js',
        'src/rules/dashes.js',
        'src/rules/ellipsis.js',
        'src/rules/arrows.js',
        'src/rules/fractions.js',
        'src/rules/index.js',
        'src/normalize.js',
      ],
      mustChange: [
        'src/rules/spaces.js',
        'src/rules/quotes.js',
        'src/rules/dashes.js',
        'src/rules/ellipsis.js',
        'src/rules/arrows.js',
        'src/rules/fractions.js',
        'src/rules/index.js',
        'src/normalize.js',
      ],
    },
    reference: {
      files: {
        'src/rules/spaces.js': TEXTKIT_CONTENT.withRuleObject(TEXTKIT_CONTENT.RULE_SPACES),
        'src/rules/quotes.js': TEXTKIT_CONTENT.withRuleObject(TEXTKIT_CONTENT.RULE_QUOTES),
        'src/rules/dashes.js': TEXTKIT_CONTENT.withRuleObject(TEXTKIT_CONTENT.RULE_DASHES),
        'src/rules/ellipsis.js': TEXTKIT_CONTENT.withRuleObject(TEXTKIT_CONTENT.RULE_ELLIPSIS),
        'src/rules/arrows.js': TEXTKIT_CONTENT.withRuleObject(TEXTKIT_CONTENT.RULE_ARROWS),
        'src/rules/fractions.js': TEXTKIT_CONTENT.withRuleObject(TEXTKIT_CONTENT.RULE_FRACTIONS),
        'src/rules/index.js': TEXTKIT_CONTENT.RULES_INDEX_TYPED,
        'src/normalize.js': TEXTKIT_CONTENT.NORMALIZE_TYPED,
      },
    },
    falsify: [{ name: 'test-tamper', files: { 'test/rules-typed.test.mjs': JS_TEST_STUB } }],
  },

  // ── family 8 · solo-suitable ──────────────────────────────────────────────
  {
    id: 'T18',
    family: 8,
    title: 'textkit exact-width wrap fix',
    repo: 'textkit',
    ref: { kind: 'branch', value: 'task/tiny' },
    partition: 'development',
    brief:
      'Run the test suite (node --test). One wrap test fails: lines that fit EXACTLY to the width wrap one word early. Fix src/wrap.js.' + REPAIR_LAW,
    timeCeilingSec: 420,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/wrap.js'],
      mustChange: ['src/wrap.js'],
    },
    reference: { files: { 'src/wrap.js': TEXTKIT_CONTENT.WRAP_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/wrap.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T19',
    family: 8,
    title: 'notedeck unknown-command exit code fix',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/tiny' },
    partition: 'calibration',
    brief:
      'Run the test suite (node --test). One cli test fails: unknown commands report success. Fix src/cli.js so unknown commands exit with code 2.' + REPAIR_LAW,
    timeCeilingSec: 420,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/cli.js'],
      mustChange: ['src/cli.js'],
    },
    reference: { files: { 'src/cli.js': NOTEDECK_CONTENT.CLI_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/cli.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T37',
    family: 8,
    title: 'gridgame initiative sign fix',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'task/tiny' },
    partition: 'qualification',
    brief:
      'Run the test suite (node --test). Initiative tests fail: tired units act EARLIER instead of later. Fix src/rules.js.' + REPAIR_LAW,
    timeCeilingSec: 420,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/rules.js'],
      mustChange: ['src/rules.js'],
    },
    reference: { files: { 'src/rules.js': GRIDGAME_CONTENT.RULES_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/rules.test.mjs': JS_TEST_STUB } }],
  },

  // ── family 9 · disjoint-lanes ─────────────────────────────────────────────
  {
    id: 'T20',
    family: 9,
    title: 'relay three independent route defects',
    repo: 'relay',
    ref: { kind: 'branch', value: 'task/three-lanes' },
    partition: 'development',
    brief:
      'Run the test suite (node --test). THREE independent route modules are broken — alpha (filtering), beta (payload handling) and gamma (drain ordering) — each with its own failing test file and no shared code between them. Fix all three modules so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/routes/alpha.js', 'src/routes/beta.js', 'src/routes/gamma.js'],
      mustChange: ['src/routes/alpha.js', 'src/routes/beta.js', 'src/routes/gamma.js'],
    },
    reference: {
      files: {
        'src/routes/alpha.js': RELAY_CONTENT.ALPHA_BASE,
        'src/routes/beta.js': RELAY_CONTENT.BETA_BASE,
        'src/routes/gamma.js': RELAY_CONTENT.GAMMA_BASE,
      },
    },
    falsify: [{ name: 'test-tamper', files: { 'test/alpha.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T21',
    family: 9,
    title: 'gridgame two independent defects',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'task/two-lanes' },
    partition: 'qualification',
    brief:
      'Run the test suite (node --test). TWO independent modules are broken — the grid bounds (src/grid.js) and the movement rules (src/rules.js) — each with its own failing tests and no shared code between the defects. Fix both modules so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/grid.js', 'src/rules.js'],
      mustChange: ['src/grid.js', 'src/rules.js'],
    },
    reference: {
      files: {
        'src/grid.js': GRIDGAME_CONTENT.GRID_BASE,
        'src/rules.js': GRIDGAME_CONTENT.RULES_BASE,
      },
    },
    falsify: [{ name: 'test-tamper', files: { 'test/grid.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T38',
    family: 9,
    title: 'notedeck two independent defects',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/lanes' },
    partition: 'calibration',
    brief:
      'Run the test suite (node --test). TWO independent modules are broken — tag parsing (src/parse.js) and list rendering (src/render.js) — each with its own failing tests and no shared code between the defects. Fix both modules so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 600,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/parse.js', 'src/render.js'],
      mustChange: ['src/parse.js', 'src/render.js'],
    },
    reference: {
      files: {
        'src/parse.js': NOTEDECK_CONTENT.PARSE_BASE,
        'src/render.js': NOTEDECK_CONTENT.RENDER_BASE,
      },
    },
    falsify: [{ name: 'test-tamper', files: { 'test/parse.test.mjs': JS_TEST_STUB } }],
  },

  // ── family 10 · hidden-shared-owner ───────────────────────────────────────
  {
    id: 'T22',
    family: 10,
    title: 'relay audit + replay kinds (shared registry order)',
    repo: 'relay',
    ref: { kind: 'branch', value: 'task/shared-registry' },
    partition: 'calibration',
    brief:
      'The test suite (node --test) now specifies two new route kinds, each in its own module: audit (src/routes/audit.js — records every event to its log, never blocks or transforms) and replay (src/routes/replay.js — buffers events and re-emits them in order via replay()). Both register through the registry, and the maintained KIND_ORDER chain must read alpha, audit, beta, gamma, replay. These look like independent features but review the registry carefully. Make ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/registry.js', 'src/routes/audit.js', 'src/routes/replay.js'],
      mustChange: ['src/registry.js', 'src/routes/audit.js', 'src/routes/replay.js'],
    },
    reference: {
      files: {
        'src/registry.js': RELAY_CONTENT.REGISTRY_EXTENDED,
        'src/routes/audit.js': RELAY_CONTENT.AUDIT_ROUTE,
        'src/routes/replay.js': RELAY_CONTENT.REPLAY_ROUTE,
      },
    },
    falsify: [{ name: 'test-tamper', files: { 'test/audit.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'T23',
    family: 10,
    title: 'notedeck pinned + archived flags (shared schema)',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/shared-schema' },
    partition: 'qualification',
    brief:
      'The test suite (node --test) now specifies two new note features: PINNED notes (setPinned in the store; renderList floats them first, stably, with a star; a cli pin command) and ARCHIVED notes (setArchived; renderList hides them unless { all: true }; a cli archive command). Both are first-class NOTE_FIELDS. These look like independent features but review the store schema carefully. Make ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/store.js', 'src/render.js', 'src/cli.js'],
      mustChange: ['src/store.js', 'src/render.js', 'src/cli.js'],
    },
    reference: {
      files: {
        'src/store.js': NOTEDECK_CONTENT.STORE_FLAGS,
        'src/render.js': NOTEDECK_CONTENT.RENDER_FLAGS,
        'src/cli.js': NOTEDECK_CONTENT.CLI_FLAGS,
      },
    },
    falsify: [{ name: 'test-tamper', files: { 'test/pin.test.mjs': JS_TEST_STUB } }],
  },

  // ── family 11 · cheaper-model-sufficient ──────────────────────────────────
  {
    id: 'T24',
    family: 11,
    title: 'textkit arrows table extension (mechanical, spec-exact)',
    repo: 'textkit',
    ref: { kind: 'branch', value: 'task/mechanical' },
    partition: 'development',
    brief:
      'Read SPEC.md at the repository root: the arrows rule must cover the ratified 12-mapping table, applied longest-first. Extend src/rules/arrows.js exactly per the spec so the test suite (node --test) passes.' + REPAIR_LAW,
    timeCeilingSec: 600,
    sourceClass: 'engineering-work',
    variability: 'exact',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/rules/arrows.js'],
      mustChange: ['src/rules/arrows.js'],
    },
    reference: { files: { 'src/rules/arrows.js': TEXTKIT_CONTENT.RULE_ARROWS_EXTENDED } },
    falsify: [
      { name: 'wrong-order', files: { 'src/rules/arrows.js': TEXTKIT_CONTENT.RULE_ARROWS_WRONG_ORDER } },
      { name: 'test-tamper', files: { 'test/arrows.test.mjs': JS_TEST_STUB } },
    ],
  },
  {
    id: 'T25',
    family: 11,
    title: 'pyledger helper stubs (mechanical, spec-exact)',
    repo: 'pyledger',
    ref: { kind: 'branch', value: 'task/mechanical' },
    partition: 'qualification',
    brief:
      'Read SPEC.md at the repository root: ledger/helpers.py contains eight stubbed helper functions with exact contracts. Implement all eight so the test suite (python3 -m unittest discover -s tests -t .) passes. Do NOT modify the tests or the spec. Verify by running the suite again, then stop.',
    timeCeilingSec: 600,
    sourceClass: 'engineering-work',
    variability: 'exact',
    grader: {
      checks: [PY_TEST],
      onlyChange: ['ledger/helpers.py'],
      mustChange: ['ledger/helpers.py'],
    },
    reference: { files: { 'ledger/helpers.py': PYLEDGER_CONTENT.HELPERS_REFERENCE } },
    falsify: [
      { name: 'last-colon-split', files: { 'ledger/helpers.py': PYLEDGER_CONTENT.HELPERS_WRONG } },
      { name: 'test-tamper', files: { 'tests/test_helpers.py': PY_TEST_STUB } },
    ],
  },

  // ── family 12 · strongest-planner ─────────────────────────────────────────
  {
    id: 'T26',
    family: 12,
    title: 'gridgame flanking (cross-module geometry coupling)',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'task/coupled-rules' },
    partition: 'calibration',
    brief:
      'Read FLANK.md at the repository root and implement the flanking rule: oppositeNeighbor geometry in src/grid.js plus attackPowerWithFlank and bestAttackCell in src/rules.js. The acceptance tests in test/flank.test.mjs cover edge, blocked-cell and occupancy geometry — read the contract carefully before implementing. Make ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/grid.js', 'src/rules.js'],
      mustChange: ['src/grid.js', 'src/rules.js'],
    },
    reference: {
      files: {
        'src/grid.js': GRIDGAME_CONTENT.GRID_WITH_OPPOSITE,
        'src/rules.js': GRIDGAME_CONTENT.RULES_FLANK,
      },
    },
    falsify: [
      {
        name: 'no-bounds-geometry',
        files: {
          'src/grid.js': GRIDGAME_CONTENT.GRID_OPPOSITE_NO_BOUNDS,
          'src/rules.js': GRIDGAME_CONTENT.RULES_FLANK,
        },
      },
      { name: 'test-tamper', files: { 'test/flank.test.mjs': JS_TEST_STUB } },
    ],
  },
  {
    id: 'T27',
    family: 12,
    title: 'relay hysteretic backpressure (coupled watermarks)',
    repo: 'relay',
    ref: { kind: 'branch', value: 'task/coupled-backpressure' },
    partition: 'qualification',
    brief:
      'The test suite (node --test) now specifies HYSTERETIC backpressure: the queue exposes HIGH_WATER/LOW_WATER and an underPressure truth; dispatch refuses new events ({ accepted: false, reason: "backpressure" }) once pending reaches the high watermark and resumes ONLY after pending falls under the low watermark — a plain threshold check will not pass the hysteresis tests. Read test/backpressure.test.mjs carefully, then implement across src/queue.js and src/dispatch.js so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/queue.js', 'src/dispatch.js'],
      mustChange: ['src/queue.js', 'src/dispatch.js'],
    },
    reference: {
      files: {
        'src/queue.js': RELAY_CONTENT.QUEUE_BACKPRESSURE,
        'src/dispatch.js': RELAY_CONTENT.DISPATCH_BACKPRESSURE,
      },
    },
    falsify: [
      {
        name: 'plain-threshold',
        files: {
          'src/queue.js': RELAY_CONTENT.QUEUE_BACKPRESSURE_NAIVE,
          'src/dispatch.js': RELAY_CONTENT.DISPATCH_BACKPRESSURE,
        },
      },
      { name: 'test-tamper', files: { 'test/backpressure.test.mjs': JS_TEST_STUB } },
    ],
  },

  // ── family 13 · provider-switch (a paired runner sequence) ────────────────
  {
    id: 'T28',
    family: 13,
    title: 'textkit bold parsing fix (switch pair, first)',
    repo: 'textkit',
    ref: { kind: 'branch', value: 'task/switch-a' },
    partition: 'development',
    brief:
      'Run the test suite (node --test). Bold parsing in src/mdlite.js swallows text across bold pairs. Fix src/mdlite.js.' + REPAIR_LAW,
    timeCeilingSec: 420,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/mdlite.js'],
      mustChange: ['src/mdlite.js'],
    },
    reference: { files: { 'src/mdlite.js': TEXTKIT_CONTENT.MDLITE_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/mdlite.test.mjs': JS_TEST_STUB } }],
    runner: { switchPair: 'first' },
  },
  {
    id: 'T29',
    family: 13,
    title: 'textkit table alignment fix (switch pair, second)',
    repo: 'textkit',
    ref: { kind: 'branch', value: 'task/switch-b' },
    partition: 'calibration',
    brief:
      'Run the test suite (node --test). Column alignment in src/table.js is swapped. Fix src/table.js.' + REPAIR_LAW,
    timeCeilingSec: 420,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/table.js'],
      mustChange: ['src/table.js'],
    },
    reference: { files: { 'src/table.js': TEXTKIT_CONTENT.TABLE_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/table.test.mjs': JS_TEST_STUB } }],
    runner: { switchPair: 'second' },
  },

  // ── family 14 · replan-trap ───────────────────────────────────────────────
  {
    id: 'T30',
    family: 14,
    title: 'gridgame suboptimal paths (the stepCost trap)',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'task/trap' },
    partition: 'development',
    brief:
      'Run the test suite (node --test). Pathfinding tests fail: findPath no longer matches the exhaustive optimum around obstacles. Fix src/path.js so ALL tests pass — including the step-cost unit contract, which is correct as specified.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/path.js'],
      mustChange: ['src/path.js'],
    },
    reference: { files: { 'src/path.js': GRIDGAME_CONTENT.PATH_BASE } },
    falsify: [
      {
        name: 'obvious-stepcost-fix',
        files: {
          'src/path.js': GRIDGAME_CONTENT.PATH_BASE.replace(
            `export function stepCost(diagonal) {
  return diagonal ? 14 : 10
}`,
            `export function stepCost(diagonal) {
  return diagonal ? 20 : 10
}`,
          ),
        },
      },
      { name: 'test-tamper', files: { 'test/path.test.mjs': JS_TEST_STUB } },
    ],
  },
  {
    id: 'T31',
    family: 14,
    title: 'pyledger trial-balance separators (the to_currency trap)',
    repo: 'pyledger',
    ref: { kind: 'branch', value: 'task/trap' },
    partition: 'qualification',
    brief:
      'Run the test suite (python3 -m unittest discover -s tests -t .). New trial-balance tests demand thousands separators in the report rows — while the plain to_currency contract stays exactly as it is. Implement in ledger/report.py so ALL tests pass. Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [PY_TEST],
      onlyChange: ['ledger/report.py'],
      mustChange: ['ledger/report.py'],
    },
    reference: { files: { 'ledger/report.py': PYLEDGER_CONTENT.REPORT_SEPARATORS } },
    falsify: [
      { name: 'naive-to-currency', files: { 'ledger/report.py': PYLEDGER_CONTENT.REPORT_SEPARATORS_NAIVE } },
      { name: 'test-tamper', files: { 'tests/test_report.py': PY_TEST_STUB } },
    ],
  },

  // ── family 15 · no-change-investigation ───────────────────────────────────
  {
    id: 'T32',
    family: 15,
    title: 'notedeck CRLF data-loss investigation (no bug exists)',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'main' },
    partition: 'development',
    brief:
      'Investigation task, read-only. A user reports notes losing content when pasted from Windows (CRLF line endings). Investigate whether the store can lose or corrupt note bodies containing CRLF anywhere in the add/update/serialize/load cycle. Report your conclusion, naming the exact function that makes the behavior safe or unsafe. Do not change any files — your final message is the deliverable.',
    timeCeilingSec: 600,
    sourceClass: 'investigation',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      zeroDiff: true,
      // AFFIRMATIVE bug-verdict forms only — a correct answer legitimately
      // DISCUSSES the counterfactual ("if the order were flipped it would
      // corrupt…"), so bare loss-verbs are not a usable oracle (the T32
      // baseline lesson).
      requiredTokens: ['normalizeNewlines'],
      forbiddenPatterns: ['confirmed the (bug|data.loss)', 'the (store|report) is unsafe', 'there (is|was) (indeed )?a (data.loss )?bug\\b'],
    },
    reference: {
      answer:
        'No data loss: normalizeNewlines in src/store.js converts CRLF and bare CR to LF at every write boundary (addNote and updateNote), so bodies round-trip byte-stable through serialize/load.',
    },
    falsify: [
      { name: 'phantom-bug', answer: 'Confirmed the bug: normalizeNewlines corrupts the body — CRLF content is unsafe.' },
      { name: 'phantom-fix', files: { 'src/store.js': NOTEDECK_CONTENT.STORE_BASE + '\n// hardened\n' }, answer: 'normalizeNewlines was fragile; I hardened it.' },
    ],
  },
  {
    id: 'T33',
    family: 15,
    title: 'relay duplicate-delivery investigation (no bug exists)',
    repo: 'relay',
    ref: { kind: 'branch', value: 'main' },
    partition: 'qualification',
    brief:
      'Investigation task, read-only. Users report duplicate delivery when a handler throws synchronously. Investigate the failure path: does one synchronous throw ever deliver an event twice, and does the redelivery cap apply? Report the exact function that owns failure handling and whether the report is founded. Do not change any files — your final message is the deliverable.',
    timeCeilingSec: 600,
    sourceClass: 'investigation',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      zeroDiff: true,
      // Same affirmative-claim law as: a correct answer may write "never
      // delivers the event twice" — only affirmative bug verdicts refuse.
      requiredTokens: ['handleFailure', 'MAX_REDELIVER'],
      forbiddenPatterns: ['duplicate delivery (is real|occurs|happens|is confirmed)', 'report is (founded|correct|accurate)', 'there (is|was) (indeed )?a duplicate.delivery bug'],
    },
    reference: {
      answer:
        'The report is unfounded: handleFailure in src/dispatch.js enqueues exactly one redelivery per failure and MAX_REDELIVER in src/queue.js caps attempts before dead-lettering.',
    },
    falsify: [
      { name: 'phantom-bug', answer: 'handleFailure delivers the event twice; MAX_REDELIVER never engages — duplicate delivery occurs.' },
      { name: 'stray-edit', files: { 'src/dispatch.js': RELAY_CONTENT.DISPATCH_BASE + '\n// audited\n' }, answer: 'handleFailure and MAX_REDELIVER are sound.' },
    ],
  },

  // ── family 16 · collaboration ─────────────────────────────────────────────
  {
    id: 'T34',
    family: 16,
    title: 'relay three lanes, two seats (two-seat collaboration)',
    repo: 'relay',
    ref: { kind: 'branch', value: 'task/three-lanes' },
    partition: 'qualification',
    brief:
      'Run the test suite (node --test). THREE independent route modules are broken — alpha, beta and gamma — each with its own failing test file and no shared code between them. This is a two-seat mission: split the disjoint lanes between seats, fix all three modules, and integrate so ALL tests pass.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'collaboration',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/routes/alpha.js', 'src/routes/beta.js', 'src/routes/gamma.js'],
      mustChange: ['src/routes/alpha.js', 'src/routes/beta.js', 'src/routes/gamma.js'],
    },
    reference: {
      files: {
        'src/routes/alpha.js': RELAY_CONTENT.ALPHA_BASE,
        'src/routes/beta.js': RELAY_CONTENT.BETA_BASE,
        'src/routes/gamma.js': RELAY_CONTENT.GAMMA_BASE,
      },
    },
    falsify: [{ name: 'test-tamper', files: { 'test/beta.test.mjs': JS_TEST_STUB } }],
    runner: { collaboration: true },
  },

  // ══ comparison partition — same corpus laws, its own
  //    partition; the frozen qualification partition is never touched. ═══════

  // ── family 1 · orientation-discovery ──────────────────────────────────────
  {
    id: 'C01',
    family: 1,
    title: 'relay pipeline-drop discovery',
    repo: 'relay',
    ref: { kind: 'branch', value: 'main' },
    partition: 'comparison',
    brief:
      'Orientation task, read-only. When the middleware pipeline drops an event, which middleware module can drop it today, and how does the pipeline report the drop? Name the module file and the report field that names the dropper. Do not change any files — your final message is the deliverable.',
    timeCeilingSec: 420,
    sourceClass: 'investigation',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      zeroDiff: true,
      requiredTokens: ['auth.js', 'dropped'],
    },
    reference: {
      answer:
        'Only the auth middleware (src/mw/auth.js) drops events (missing actor); runPipeline reports { dropped: true, by: "auth" } — the by field names the dropper.',
    },
    falsify: [
      { name: 'wrong-owner', answer: 'The dispatcher in src/dispatch.js drops events without actors and records them as dropped.' },
      { name: 'stray-edit', files: { 'NOTES.md': 'scratch\n' }, answer: 'auth.js drops; the pipeline reports dropped/by.' },
    ],
  },
  {
    id: 'C02',
    family: 1,
    title: 'gridgame tie-law discovery',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'main' },
    partition: 'comparison',
    brief:
      'Orientation task, read-only. Initiative ties are documented to keep roster order. Find the function that actually guarantees this and report its name, its file, and the one implementation detail that makes the guarantee hold. Do not change any files — your final message is the deliverable.',
    timeCeilingSec: 420,
    sourceClass: 'investigation',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      zeroDiff: true,
      requiredTokens: ['runSim', 'sim.js'],
    },
    reference: {
      answer:
        'runSim in src/sim.js: the per-round sort operates on a COPY ([...state].sort) and Array.sort is stable, so equal initiatives keep roster order and the roster itself never reorders.',
    },
    falsify: [
      { name: 'wrong-site', answer: 'initiative in src/rules.js breaks ties by roster position.' },
      { name: 'stray-edit', files: { 'NOTES.md': 'scratch\n' }, answer: 'runSim in src/sim.js sorts a copy.' },
    ],
  },

  // ── family 2 · narrow-bug-repair ──────────────────────────────────────────
  {
    id: 'C03',
    family: 2,
    title: 'textkit dash-order repair',
    repo: 'textkit',
    ref: { kind: 'branch', value: 'task/cmp-dashes' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). The dash rule fails: triple dashes decay instead of becoming an em dash. Fix src/rules/dashes.js.' + REPAIR_LAW,
    timeCeilingSec: 600,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/rules/dashes.js'],
      mustChange: ['src/rules/dashes.js'],
    },
    reference: { files: { 'src/rules/dashes.js': TEXTKIT_CONTENT.RULE_DASHES } },
    falsify: [{ name: 'test-tamper', files: { 'test/dashes.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'C04',
    family: 2,
    title: 'pyledger memo-tail repair',
    repo: 'pyledger',
    ref: { kind: 'branch', value: 'task/cmp-memo' },
    partition: 'comparison',
    brief:
      'Run the test suite (python3 -m unittest discover -s tests -t .). Memo parsing fails: multi-word memos lose everything after the first word. Fix ledger/parse.py. Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 600,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [PY_TEST],
      onlyChange: ['ledger/parse.py'],
      mustChange: ['ledger/parse.py'],
    },
    reference: { files: { 'ledger/parse.py': PYLEDGER_CONTENT.PARSE_BASE } },
    falsify: [
      { name: 'test-tamper', files: { 'tests/test_memo.py': PY_TEST_STUB } },
      {
        name: 'maxsplit-two',
        files: {
          'ledger/parse.py': PYLEDGER_CONTENT.PARSE_BASE.replace(
            '        parts = line.split(None, 3)',
            '        parts = line.split(None, 2)',
          ),
        },
      },
    ],
  },
  {
    id: 'C05',
    family: 2,
    title: 'notedeck serialize-seq repair',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/cmp-serialize' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). A store test fails: the serialize/load round-trip loses the sequence counter, so ids would collide after a reload. Fix src/store.js.' + REPAIR_LAW,
    timeCeilingSec: 600,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/store.js'],
      mustChange: ['src/store.js'],
    },
    reference: { files: { 'src/store.js': NOTEDECK_CONTENT.STORE_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/store.test.mjs': JS_TEST_STUB } }],
  },

  // ── family 3 · multi-file-typed-refactor ──────────────────────────────────
  {
    id: 'C06',
    family: 3,
    title: 'notedeck tag index across store + cli',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/cmp-tags' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). New tag-index specs are failing: the store needs findByTag (case-insensitive over the folded tags) and the cli needs list --tag <tag> filtering. Implement both at their owners (src/store.js, src/cli.js). Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/store.js', 'src/cli.js'],
      mustChange: ['src/store.js', 'src/cli.js'],
    },
    reference: {
      files: {
        'src/store.js': NOTEDECK_CONTENT.STORE_TAGINDEX,
        'src/cli.js': NOTEDECK_CONTENT.CLI_TAGINDEX,
      },
    },
    falsify: [
      {
        name: 'case-sensitive',
        files: {
          'src/store.js': NOTEDECK_CONTENT.STORE_TAGINDEX_CASE_SENSITIVE,
          'src/cli.js': NOTEDECK_CONTENT.CLI_TAGINDEX,
        },
      },
      { name: 'test-tamper', files: { 'test/tags.test.mjs': JS_TEST_STUB } },
    ],
  },
  {
    id: 'C07',
    family: 3,
    title: 'relay dead-letter introspection',
    repo: 'relay',
    ref: { kind: 'branch', value: 'task/cmp-deadletter' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). New dead-letter specs are failing: the queue needs deadLetters(queue) returning typed rows and the dispatcher needs dead() naming dead event topics. Implement both at their owners (src/queue.js, src/dispatch.js). Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/queue.js', 'src/dispatch.js'],
      mustChange: ['src/queue.js', 'src/dispatch.js'],
    },
    reference: {
      files: {
        'src/queue.js': RELAY_CONTENT.QUEUE_DEADLETTER,
        'src/dispatch.js': RELAY_CONTENT.DISPATCH_DEADLETTER,
      },
    },
    falsify: [
      { name: 'queue-only', files: { 'src/queue.js': RELAY_CONTENT.QUEUE_DEADLETTER } },
      { name: 'test-tamper', files: { 'test/deadletter.test.mjs': JS_TEST_STUB } },
    ],
  },

  // ── family 4 · rename-with-decoy ──────────────────────────────────────────
  {
    id: 'C21',
    family: 4,
    title: 'relay drainQueue rename (gamma.drain decoy)',
    repo: 'relay',
    ref: { kind: 'branch', value: 'task/cmp-rename-drain' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). The queue spec now names the queue drainer drainQueue (the old queue-level name must be gone); note the gamma route has its OWN unrelated drain() buffer method. Apply the rename and update every genuine consumer. Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 600,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/queue.js', 'src/dispatch.js'],
      mustChange: ['src/queue.js', 'src/dispatch.js'],
    },
    reference: {
      files: {
        'src/queue.js': RELAY_CONTENT.QUEUE_RENAMED_DRAIN,
        'src/dispatch.js': RELAY_CONTENT.DISPATCH_RENAMED_DRAIN,
      },
    },
    falsify: [
      {
        name: 'decoy-rename',
        files: {
          'src/queue.js': RELAY_CONTENT.QUEUE_RENAMED_DRAIN,
          'src/dispatch.js': RELAY_CONTENT.DISPATCH_RENAMED_DRAIN,
          'src/routes/gamma.js': RELAY_CONTENT.GAMMA_DRAIN_RENAMED,
        },
      },
      { name: 'queue-only', files: { 'src/queue.js': RELAY_CONTENT.QUEUE_RENAMED_DRAIN } },
    ],
  },

  // ── family 5 · runtime-diagnosis ──────────────────────────────────────────
  {
    id: 'C08',
    family: 5,
    title: 'gridgame diverging battle log (rest sign)',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'task/cmp-sim-rest' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). The four-round battle log diverges from the expected sequence partway through, and the divergence looks like an ordering problem. Diagnose the actual cause and fix it minimally in src/sim.js.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/sim.js'],
      mustChange: ['src/sim.js'],
    },
    reference: { files: { 'src/sim.js': GRIDGAME_CONTENT.SIM_BASE } },
    falsify: [
      { name: 'wrong-site-decoy', files: { 'src/rules.js': GRIDGAME_CONTENT.RULES_INITIATIVE_DECOY } },
      { name: 'test-tamper', files: { 'test/sim.test.mjs': JS_TEST_STUB } },
    ],
  },

  // ── family 6 · misleading-symptom ─────────────────────────────────────────
  {
    id: 'C09',
    family: 6,
    title: 'pyledger wrong balances after multi-posting',
    repo: 'pyledger',
    ref: { kind: 'branch', value: 'task/cmp-accounts' },
    partition: 'comparison',
    brief:
      'Run the test suite (python3 -m unittest discover -s tests -t .). Report tests fail: balances come out wrong after posting a day with several entries against one account, and the trial balance will not zero. The report module is where the failures appear — find the real cause and fix it minimally. Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 900,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [PY_TEST],
      onlyChange: ['ledger/accounts.py'],
      mustChange: ['ledger/accounts.py'],
    },
    reference: { files: { 'ledger/accounts.py': PYLEDGER_CONTENT.ACCOUNTS_BASE } },
    falsify: [
      { name: 'sign-flip', files: { 'ledger/accounts.py': PYLEDGER_CONTENT.ACCOUNTS_POST_MINUS } },
      { name: 'test-tamper', files: { 'tests/test_report.py': PY_TEST_STUB } },
    ],
  },
  {
    id: 'C10',
    family: 6,
    title: 'relay review: the committed prefix-guard change',
    repo: 'relay',
    ref: { kind: 'branch', value: 'task/cmp-review' },
    partition: 'comparison',
    brief:
      'Review task, read-only. The commit at HEAD hardened the alpha route (git show HEAD). The test suite is green. Review the change as a maintainer: decide whether it should merge. End your final message with ONE line of the exact form: VERDICT: accept|reject — <the precise reason>. Do not change any files.',
    timeCeilingSec: 600,
    sourceClass: 'investigation',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      zeroDiff: true,
      requiredTokens: ['verdict: reject', 'includes'],
      forbiddenPatterns: ['verdict:\\s*accept'],
    },
    reference: {
      answer:
        'VERDICT: reject — the guard is fine, but the change swapped startsWith for includes, so a configured prefix now matches ANYWHERE in the topic (e.g. topic record.x matches prefix ord.); prefix semantics are silently broadened and no test covers it.',
    },
    falsify: [
      { name: 'wrong-verdict', answer: 'VERDICT: accept — the topic guard makes accepts robust and matching is unchanged.' },
      { name: 'vague-reject', answer: 'VERDICT: reject — the change is risky and under-tested.' },
    ],
  },

  // ── family 7 · long-tool-heavy ────────────────────────────────────────────
  {
    id: 'C11',
    family: 7,
    title: 'textkit rule-docs migration (8 owners)',
    repo: 'textkit',
    ref: { kind: 'branch', value: 'task/cmp-ruledocs' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). The new rule-docs spec is failing: every typographic rule module must export a working example { before, after } demonstrating itself, the rules index must aggregate RULE_EXAMPLES in pipeline order, and normalize must expose describeRules() rendering one "name: before -> after" line per rule. Implement across the rule modules, the index and normalize. Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 1200,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: [
        'src/rules/spaces.js',
        'src/rules/quotes.js',
        'src/rules/dashes.js',
        'src/rules/ellipsis.js',
        'src/rules/arrows.js',
        'src/rules/fractions.js',
        'src/rules/index.js',
        'src/normalize.js',
      ],
      mustChange: [
        'src/rules/spaces.js',
        'src/rules/quotes.js',
        'src/rules/dashes.js',
        'src/rules/ellipsis.js',
        'src/rules/arrows.js',
        'src/rules/fractions.js',
        'src/rules/index.js',
        'src/normalize.js',
      ],
    },
    reference: {
      files: {
        'src/rules/spaces.js': TEXTKIT_CONTENT.RULE_SPACES_EXAMPLED,
        'src/rules/quotes.js': TEXTKIT_CONTENT.RULE_QUOTES_EXAMPLED,
        'src/rules/dashes.js': TEXTKIT_CONTENT.RULE_DASHES_EXAMPLED,
        'src/rules/ellipsis.js': TEXTKIT_CONTENT.RULE_ELLIPSIS_EXAMPLED,
        'src/rules/arrows.js': TEXTKIT_CONTENT.RULE_ARROWS_EXAMPLED,
        'src/rules/fractions.js': TEXTKIT_CONTENT.RULE_FRACTIONS_EXAMPLED,
        'src/rules/index.js': TEXTKIT_CONTENT.RULES_INDEX_EXAMPLES,
        'src/normalize.js': TEXTKIT_CONTENT.NORMALIZE_DESCRIBE,
      },
    },
    falsify: [
      { name: 'normalize-forgotten', files: TEXTKIT_CONTENT.RULEDOCS_PARTIAL_FILES },
      { name: 'test-tamper', files: { 'test/ruledocs.test.mjs': JS_TEST_STUB } },
    ],
  },

  // ── family 8 · solo-suitable ──────────────────────────────────────────────
  {
    id: 'C13',
    family: 8,
    title: 'gridgame diagonal step-cost fix',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'task/cmp-diag' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). One path test fails: diagonal step costs broke. Fix src/path.js.' + REPAIR_LAW,
    timeCeilingSec: 420,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/path.js'],
      mustChange: ['src/path.js'],
    },
    reference: { files: { 'src/path.js': GRIDGAME_CONTENT.PATH_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/path.test.mjs': JS_TEST_STUB } }],
  },
  {
    id: 'C14',
    family: 8,
    title: 'relay gamma band-order fix',
    repo: 'relay',
    ref: { kind: 'branch', value: 'task/cmp-gamma-fifo' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). One gamma test fails: events inside a priority band drain in the wrong order. Fix src/routes/gamma.js.' + REPAIR_LAW,
    timeCeilingSec: 420,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/routes/gamma.js'],
      mustChange: ['src/routes/gamma.js'],
    },
    reference: { files: { 'src/routes/gamma.js': RELAY_CONTENT.GAMMA_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/gamma.test.mjs': JS_TEST_STUB } }],
  },

  // ── family 9 · disjoint-lanes ─────────────────────────────────────────────
  {
    id: 'C15',
    family: 9,
    title: 'textkit two independent defects',
    repo: 'textkit',
    ref: { kind: 'branch', value: 'task/cmp-lanes' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). Two UNRELATED failures: exact-width lines wrap one word early (src/wrap.js), and table columns misalign because widths follow the last row instead of the widest cell (src/table.js). Fix both.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/wrap.js', 'src/table.js'],
      mustChange: ['src/wrap.js', 'src/table.js'],
    },
    reference: {
      files: {
        'src/wrap.js': TEXTKIT_CONTENT.WRAP_BASE,
        'src/table.js': TEXTKIT_CONTENT.TABLE_BASE,
      },
    },
    falsify: [
      { name: 'one-lane-only', files: { 'src/wrap.js': TEXTKIT_CONTENT.WRAP_BASE } },
      {
        name: 'test-tamper',
        files: { 'test/wrap.test.mjs': JS_TEST_STUB, 'test/table.test.mjs': JS_TEST_STUB },
      },
    ],
  },

  // ── family 10 · hidden-shared-owner ───────────────────────────────────────
  {
    id: 'C16',
    family: 10,
    title: 'notedeck word-count + tag-count (one render owner)',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/cmp-render-stats' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). Two new display specs are failing: renderNote gains an optional stats mode appending a word count, and renderList rows gain a tag count when tags exist. Both belong to the render owner. Implement them. Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 600,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/render.js'],
      mustChange: ['src/render.js'],
    },
    reference: { files: { 'src/render.js': NOTEDECK_CONTENT.RENDER_STATS } },
    falsify: [
      {
        name: 'tagcount-forgotten',
        files: {
          'src/render.js': NOTEDECK_CONTENT.RENDER_STATS.replace(
            `    const tagCount = note.tags.length > 0 ? ' [' + note.tags.length + ' tags]' : ''
    lines.push(String(n) + '. ' + note.title + ' (' + note.id + ')' + tagCount)`,
            `    lines.push(String(n) + '. ' + note.title + ' (' + note.id + ')')`,
          ),
        },
      },
      {
        name: 'test-tamper',
        files: { 'test/wordcount.test.mjs': JS_TEST_STUB, 'test/tagcount.test.mjs': JS_TEST_STUB },
      },
    ],
  },

  // ── family 12 · strongest-planner ─────────────────────────────────────────
  {
    id: 'C12',
    family: 12,
    title: 'gridgame threat map over the geometry owners',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'task/cmp-threat' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). THREAT.md specifies a new threat-map module and its tests are failing. Build src/threat.js exactly per the spec, on top of the existing geometry owners. Do NOT modify tests or existing modules. Verify by running the suite again, then stop.',
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/threat.js'],
      mustChange: ['src/threat.js'],
    },
    reference: { files: { 'src/threat.js': GRIDGAME_CONTENT.THREAT_MODULE } },
    falsify: [
      { name: 'overwrite-sum', files: { 'src/threat.js': GRIDGAME_CONTENT.THREAT_MODULE_OVERWRITE } },
      { name: 'test-tamper', files: { 'test/threat.test.mjs': JS_TEST_STUB } },
    ],
  },

  // ── family 13 · provider-switch pair ──────────────────────────────────────
  {
    id: 'C17',
    family: 13,
    title: 'pyledger fraction-padding fix (switch pair, first)',
    repo: 'pyledger',
    ref: { kind: 'branch', value: 'task/cmp-switch-a' },
    partition: 'comparison',
    brief:
      'Run the test suite (python3 -m unittest discover -s tests -t .). One amount test fails: bare fractional amounts parse wrong. Fix ledger/parse.py. Do NOT modify the tests. Verify by running the suite again, then stop.',
    timeCeilingSec: 420,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [PY_TEST],
      onlyChange: ['ledger/parse.py'],
      mustChange: ['ledger/parse.py'],
    },
    reference: { files: { 'ledger/parse.py': PYLEDGER_CONTENT.PARSE_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'tests/test_parse.py': PY_TEST_STUB } }],
    runner: { switchPair: 'first' },
  },
  {
    id: 'C18',
    family: 13,
    title: 'gridgame advantage-threshold fix (switch pair, second)',
    repo: 'gridgame',
    ref: { kind: 'branch', value: 'task/cmp-switch-b' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). One rules test fails: the fatigue advantage no longer triggers at the documented threshold. Fix src/rules.js.' + REPAIR_LAW,
    timeCeilingSec: 420,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      onlyChange: ['src/rules.js'],
      mustChange: ['src/rules.js'],
    },
    reference: { files: { 'src/rules.js': GRIDGAME_CONTENT.RULES_BASE } },
    falsify: [{ name: 'test-tamper', files: { 'test/rules.test.mjs': JS_TEST_STUB } }],
    runner: { switchPair: 'second' },
  },

  // ── family 15 · no-change-investigation ───────────────────────────────────
  {
    id: 'C19',
    family: 15,
    title: 'relay gamma-starvation investigation (no bug exists)',
    repo: 'relay',
    ref: { kind: 'branch', value: 'main' },
    partition: 'comparison',
    brief:
      'Investigation task, read-only. A report claims continuous high-priority load can starve buffered low-priority events forever in the gamma route. Investigate whether the current implementation actually has that starvation bug. End your final message with ONE line of the exact form: VERDICT: bug|no-bug — <the precise reason>. Do not change any files.',
    timeCeilingSec: 600,
    sourceClass: 'investigation',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      zeroDiff: true,
      requiredTokens: ['verdict: no-bug'],
      forbiddenPatterns: ['verdict:\\s*bug\\b'],
    },
    reference: {
      answer:
        'VERDICT: no-bug — gamma.drain snapshots and EMPTIES the buffer on every call (buffer.length = 0 after sorting a copy), so each drain emits every buffered event; low-priority events drain later within the pass but can never be starved across passes.',
    },
    falsify: [
      { name: 'phantom-bug', answer: 'VERDICT: bug — high-priority arrivals re-sort ahead of old low-priority events on every drain, so low priorities starve forever.' },
      { name: 'stray-edit', files: { 'NOTES.md': 'scratch\n' }, answer: 'VERDICT: no-bug — drain empties the buffer each pass.' },
    ],
  },
  {
    id: 'C20',
    family: 15,
    title: 'notedeck tag-casing investigation (no bug exists)',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'main' },
    partition: 'comparison',
    brief:
      'Investigation task, read-only. A report claims quoted tags with uppercase letters keep their case in the store and therefore break tag lookups. Investigate whether the current parser actually has that bug. End your final message with ONE line of the exact form: VERDICT: bug|no-bug — <the precise reason>. Do not change any files.',
    timeCeilingSec: 600,
    sourceClass: 'investigation',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      zeroDiff: true,
      requiredTokens: ['verdict: no-bug'],
      forbiddenPatterns: ['verdict:\\s*bug\\b'],
    },
    reference: {
      answer:
        'VERDICT: no-bug — both tag paths case-fold at the parser: quoted tags lowercase via slice(i + 2, close).toLowerCase() and bare tags via slice(i + 1, j).toLowerCase(), so an uppercase quoted tag is stored folded and lookups cannot break.',
    },
    falsify: [
      { name: 'phantom-bug', answer: 'VERDICT: bug — the quoted-tag path skips the case fold, so #"Project X" stores mixed case.' },
      { name: 'stray-edit', files: { 'NOTES.md': 'scratch\n' }, answer: 'VERDICT: no-bug — both paths lowercase.' },
    ],
  },

  // ── family 17 · multi-file-change-set ───────────────
  {
    id: 'M01',
    family: 17,
    title: 'notedeck two-file banner bump',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/mf-banner' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). The banner specs fail: the product string must read "notedeck v2" in BOTH owners — src/banner.js and src/about.js (the about text duplicates the literal deliberately).' + REPAIR_LAW,
    timeCeilingSec: 600,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      mustChange: ['src/banner.js', 'src/about.js'],
      onlyChange: ['src/banner.js', 'src/about.js'],
    },
    reference: {
      files: { 'src/banner.js': MF.MF_BANNER_V2, 'src/about.js': MF.MF_ABOUT_V2 },
    },
    falsify: [
      { name: 'half-swept', files: { 'src/banner.js': MF.MF_BANNER_V2 } },
      { name: 'test-tamper', files: { 'test/mf-banner.test.mjs': JS_TEST_STUB } },
    ],
  },
  {
    id: 'M02',
    family: 17,
    title: 'notedeck slug collapse — implementation + old spec together',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/mf-slug' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). The new slug spec (test/mf-slug-target.test.mjs) requires separator RUNS to collapse to one dash. Change src/slug.js accordingly AND update the older spec test/mf-slug.test.mjs, which still pins the pre-collapse behavior. Do NOT modify test/mf-slug-target.test.mjs or package.json. Verify by running the suite again, then stop.',
    timeCeilingSec: 600,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      mustChange: ['src/slug.js', 'test/mf-slug.test.mjs'],
      onlyChange: ['src/slug.js', 'test/mf-slug.test.mjs'],
      mustNotChange: ['test/mf-slug-target.test.mjs'],
    },
    reference: {
      files: {
        'src/slug.js': MF.MF_SLUG_FIXED,
        'test/mf-slug.test.mjs': MF.MF_SLUG_SPEC_UPDATED,
      },
    },
    falsify: [
      { name: 'impl-only', files: { 'src/slug.js': MF.MF_SLUG_FIXED } },
      { name: 'spec-only', files: { 'test/mf-slug.test.mjs': MF.MF_SLUG_SPEC_UPDATED } },
      { name: 'target-tamper', files: { 'test/mf-slug-target.test.mjs': JS_TEST_STUB, 'src/slug.js': MF.MF_SLUG_FIXED, 'test/mf-slug.test.mjs': MF.MF_SLUG_SPEC_UPDATED } },
    ],
  },
  {
    id: 'M03',
    family: 17,
    title: 'notedeck four-view formatter migration',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/mf-views' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). The view specs fail: migrate ALL FOUR views (src/view-a.js … src/view-d.js) from format-legacy to the v2 formatter (src/format2.js), each passing its own lane tag ({ tag: "a" } for view A, and so on). Do not modify the formatters or the tests.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      mustChange: ['src/view-a.js', 'src/view-b.js', 'src/view-c.js', 'src/view-d.js'],
      onlyChange: ['src/view-a.js', 'src/view-b.js', 'src/view-c.js', 'src/view-d.js'],
    },
    reference: {
      files: {
        'src/view-a.js': MF.mfViewMigrated('a'),
        'src/view-b.js': MF.mfViewMigrated('b'),
        'src/view-c.js': MF.mfViewMigrated('c'),
        'src/view-d.js': MF.mfViewMigrated('d'),
      },
    },
    falsify: [
      {
        name: 'partial-sweep',
        files: {
          'src/view-a.js': MF.mfViewMigrated('a'),
          'src/view-b.js': MF.mfViewMigrated('b'),
          'src/view-c.js': MF.mfViewMigrated('c'),
        },
      },
      { name: 'test-tamper', files: { 'test/mf-views.test.mjs': JS_TEST_STUB } },
    ],
  },
  {
    id: 'M04',
    family: 17,
    title: 'notedeck pipeline stage registration — two regions + a stage fix',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/mf-pipeline' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). The pipeline specs fail: register the dedupe stage in src/pipeline.js (the STAGES table between trim and upper, its import, AND the STAGE_NAMES registry further down — both registries must stay in step) and fix the dedupe implementation in src/stages/dedupe.js to collapse whitespace runs to one space.' + REPAIR_LAW,
    timeCeilingSec: 900,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      mustChange: ['src/pipeline.js', 'src/stages/dedupe.js'],
      onlyChange: ['src/pipeline.js', 'src/stages/dedupe.js'],
    },
    reference: {
      files: {
        'src/pipeline.js': MF.MF_PIPELINE_FIXED,
        'src/stages/dedupe.js': MF.MF_STAGE_DEDUPE_FIXED,
      },
    },
    falsify: [
      {
        name: 'forgot-name-registry',
        files: {
          'src/pipeline.js': MF.MF_PIPELINE_FIXED.replace("export const STAGE_NAMES = ['trim', 'dedupe', 'upper']", "export const STAGE_NAMES = ['trim', 'upper']"),
          'src/stages/dedupe.js': MF.MF_STAGE_DEDUPE_FIXED,
        },
      },
      { name: 'test-tamper', files: { 'test/mf-pipeline.test.mjs': JS_TEST_STUB } },
    ],
  },
  {
    id: 'M05',
    family: 17,
    title: 'notedeck limits raise — one member already satisfied',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/mf-limits' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). The limits spec fails: MAX_NOTES must be 250 in EVERY limits module (src/limits-a.js, src/limits-b.js, src/limits-c.js). Some modules may already be correct — leave any file that already satisfies the target untouched.' + REPAIR_LAW,
    timeCeilingSec: 600,
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      mustChange: ['src/limits-a.js', 'src/limits-b.js'],
      onlyChange: ['src/limits-a.js', 'src/limits-b.js'],
      mustNotChange: ['src/limits-c.js'],
    },
    reference: {
      files: { 'src/limits-a.js': MF.mfLimits(250), 'src/limits-b.js': MF.mfLimits(250) },
    },
    falsify: [
      { name: 'partial', files: { 'src/limits-a.js': MF.mfLimits(250) } },
      { name: 'test-tamper', files: { 'test/mf-limits.test.mjs': JS_TEST_STUB } },
    ],
  },
  {
    id: 'M06',
    family: 17,
    title: 'notedeck greeting fix — the single-file honesty task',
    repo: 'notedeck',
    ref: { kind: 'branch', value: 'task/mf-greeting' },
    partition: 'comparison',
    brief:
      'Run the test suite (node --test). The greeting spec fails: fix src/greeting.js. src/greeting-context.js is a GENERATED reference sample — do not edit it.' + REPAIR_LAW,
    timeCeilingSec: 480,
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [NODE_TEST],
      mustChange: ['src/greeting.js'],
      onlyChange: ['src/greeting.js'],
      mustNotChange: ['src/greeting-context.js'],
    },
    reference: { files: { 'src/greeting.js': MF.MF_GREETING_FIXED } },
    falsify: [
      {
        name: 'context-tampered',
        files: { 'src/greeting.js': MF.MF_GREETING_FIXED, 'src/greeting-context.js': '// edited\nexport const SAMPLE = "hello, sample"\n' },
      },
      { name: 'test-tamper', files: { 'test/mf-greeting.test.mjs': JS_TEST_STUB } },
    ],
  },

  // ── family 18 · topdown-action-game ───────────────────────
  {
    id: 'EW1',
    family: 18,
    title: 'emberweald sim core: six mission seams to a playable clearing',
    repo: 'emberweald',
    ref: { kind: 'branch', value: 'main' },
    partition: 'crucible-qualification',
    brief:
      'Emberweald is a top-down torch-and-mist action game with a deterministic fixed-timestep simulation (start with README.md). The six mission seams are stubbed and the public suite fails — bring the simulation core alive so `node --test` passes completely. Implement, per the contracts pinned in each seam file\'s header comment and in test/: the phase machine (src/sim/phases.js — title/playing/paused/settings/dead/victory), player movement, facing and dodge (src/sim/systems/movement.js), melee combat (src/sim/systems/combat.js), enemy chase/flee/wander (src/sim/systems/enemies.js), contact damage, i-frames, knockback and death (src/sim/systems/damage.js), and wave progression (src/sim/systems/waves.js). Keep the determinism law green: no Math.random or wall clocks inside the sim; identical seed + input tape must reproduce identical world state. Confine your changes to those six files.',
    timeCeilingSec: 5400,
    humanEstimate: {
      minutes: 120,
      method:
        'reference-build wall: the corpus author implemented the six seams against the pinned suite in one authoring pass (2026-08-04, ~75 min including verification); banded to the METR-style ~2 h horizon against the mined real-session game-sim rows (friction digest p02/p03).',
    },
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [{ ...NODE_TEST, timeoutSec: 180 }],
      mustChange: [
        'src/sim/phases.js',
        'src/sim/systems/movement.js',
        'src/sim/systems/combat.js',
        'src/sim/systems/enemies.js',
        'src/sim/systems/damage.js',
        'src/sim/systems/waves.js',
      ],
      onlyChange: [
        'src/sim/phases.js',
        'src/sim/systems/movement.js',
        'src/sim/systems/combat.js',
        'src/sim/systems/enemies.js',
        'src/sim/systems/damage.js',
        'src/sim/systems/waves.js',
      ],
    },
    reference: { files: EMBERWEALD_G1_REFERENCE },
    falsify: EMBERWEALD_G1_FALSIFY,
  },
  {
    id: 'EW2',
    family: 18,
    title: 'emberweald satchel: items, drops, wards and exact save/resume',
    repo: 'emberweald',
    ref: { kind: 'branch', value: 'task/g2' },
    partition: 'crucible-calibration',
    brief:
      'Emberweald\'s simulation core is alive (movement, combat, enemies, damage, waves — see README.md); the satchel era begins. The satchel scaffolding is in place (ITEMS/DROPS/PICKUP_RADIUS/INVENTORY_SLOTS in src/sim/constants.js; inventory/pickups/wards wired through world state) but the item system is stubbed and the save codec predates the satchel — the inventory and save suites fail. Implement, per the contracts pinned in the seam files and in test/: the item system (src/sim/systems/items.js — lifetimes, contractual drop rolls, pickup stacking, slot use), the enemy-side satchel effects (src/sim/systems/enemies.js — the ember surge halves effective aggro radius; a ward ring halves enemy speed), and the version-2 save codec (src/sim/save.js — exact mid-run resume, v1 migration with satchel defaults, typed refusal of unknown versions). Keep the determinism law green and confine your changes to those three files.',
    timeCeilingSec: 5400,
    humanEstimate: {
      minutes: 90,
      method:
        'reference-build wall: the corpus author implemented items/enemy-modulation/save-v2 against the pinned suites in one pass (2026-08-04, ~50 min including verification); banded to the METR-style ~1.5 h horizon against the mined real-session game-sim rows (friction digest p02/p03).',
    },
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [{ ...NODE_TEST, timeoutSec: 180 }],
      mustChange: ['src/sim/systems/items.js', 'src/sim/systems/enemies.js', 'src/sim/save.js'],
      onlyChange: ['src/sim/systems/items.js', 'src/sim/systems/enemies.js', 'src/sim/save.js'],
    },
    reference: { files: EMBERWEALD_G2_REFERENCE },
    falsify: EMBERWEALD_G2_FALSIFY,
  },
  {
    id: 'EW3',
    family: 18,
    title: 'emberweald warden era: the full playable progression',
    repo: 'emberweald',
    ref: { kind: 'branch', value: 'task/g3' },
    partition: 'crucible-qualification',
    brief:
      'Emberweald\'s simulation and satchel are alive; the run still ends at a bare wave counter — the game needs its ending. Per the contracts pinned in the seam files and in test/: hand the fight over when the final LISTED wave clears (src/sim/systems/waves.js — the wave ledger CLOSES at the handover and must never manufacture a victory by re-counting an empty list) and implement the Mistwarden (src/sim/systems/warden.js — the escort shield, exposure, re-summons on WARDEN.summonEveryTicks, and the beyond-the-list clear that ends the run). The progression floors are graded by the GIVEN deterministic autopilot (tools/autopilot.mjs): the whole run must be winnable by the autopilot on seed 7 within the tick budget and losable by an idle torchbearer, with every menu phase reachable by keyboard alone. Keep the determinism law green and confine your changes to src/sim/systems/waves.js and src/sim/systems/warden.js.',
    timeCeilingSec: 7200,
    humanEstimate: {
      minutes: 240,
      method:
        'reference-build wall: the corpus author implemented the handover + warden fight and hit the phantom-victory ledger class live (guard + strengthened test), then verified the balance floors across three seeds (victories at hp 10-12); banded to the METR-style half-day horizon against the mined multi-hour game-session rows (friction digest p02/p03, RT-01).',
    },
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [{ ...NODE_TEST, timeoutSec: 600 }],
      mustChange: ['src/sim/systems/waves.js', 'src/sim/systems/warden.js'],
      onlyChange: ['src/sim/systems/waves.js', 'src/sim/systems/warden.js'],
    },
    reference: { files: EMBERWEALD_G3_REFERENCE },
    falsify: EMBERWEALD_G3_FALSIFY,
  },

  // ── family 19 · cli-update-journey ────────────────────────
  {
    id: 'LK1',
    family: 19,
    title: 'lanternkit update journey: verify, journaled swap, exact resume',
    repo: 'lanternkit',
    ref: { kind: 'branch', value: 'task/k1' },
    partition: 'crucible-qualification',
    brief:
      'lanternkit is a cross-platform field-kit CLI with a versioned payload update flow (start with README.md). The producer is real and given; the reader is stubbed and the update suite fails. Implement src/update/reader.js per the contract pinned in its header and in test/reader.test.mjs: verify EVERY checksum and path before writing anything (a refused apply leaves the kit home byte-identical), stage the verified files, swap them in under a journal written at every phase boundary, back up replaced files, and make `resumeApply` complete an interrupted swap exactly — already-placed files are never re-copied, resuming twice is idempotent, and the deterministic fault hook (opts.faultAfterJournalWrites) must interrupt at any journal boundary and still converge to the clean-apply end state. Confine your changes to src/update/reader.js.',
    timeCeilingSec: 3600,
    humanEstimate: {
      minutes: 75,
      method:
        'reference-build wall: the corpus author implemented the reader against the pinned suite in one pass (2026-08-04, ~40 min) and the interruption matrix caught a real crash-window bug (rename landed, journal write lost) requiring the idempotent-placement repair; banded to the METR-style ~1.25 h horizon.',
    },
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [{ ...NODE_TEST, timeoutSec: 120 }],
      mustChange: ['src/update/reader.js'],
      onlyChange: ['src/update/reader.js'],
    },
    reference: { files: LANTERNKIT_K1_REFERENCE },
    falsify: LANTERNKIT_K1_FALSIFY,
  },
  {
    id: 'LK2',
    family: 19,
    title: 'lanternkit path discipline: messy homes, precedence, escape guard',
    repo: 'lanternkit',
    ref: { kind: 'branch', value: 'task/k2' },
    partition: 'crucible-qualification',
    brief:
      'lanternkit is a cross-platform field-kit CLI (start with README.md). The update reader is given; the path layer is stubbed, so every kit operation fails. Implement src/paths.js per the contract pinned in its header and in test/paths.test.mjs: kit-home resolution with flag > env > default precedence (relative values resolve against cwd, results always absolute), byte-exact handling of homes with spaces, parentheses and accented characters (no trimming, folding or unicode normalization), kitPaths derivation via path joins, and assertInsideHome refusing every escape (dot-dot, absolute, nested traversal) with the typed error. Confine your changes to src/paths.js.',
    timeCeilingSec: 2700,
    humanEstimate: {
      minutes: 45,
      method:
        'reference-build wall: the corpus author implemented the path layer in one pass (2026-08-04, ~20 min including the guard edge cases); banded to the METR-style ~45 min horizon against the mined real-session write-guard rows (friction digest RT-03).',
    },
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [{ ...NODE_TEST, timeoutSec: 120 }],
      mustChange: ['src/paths.js'],
      onlyChange: ['src/paths.js'],
    },
    reference: { files: LANTERNKIT_K2_REFERENCE },
    falsify: LANTERNKIT_K2_FALSIFY,
  },

  // ── family 20 · cross-module-change ───────────────────────
  {
    id: 'GM1',
    family: 20,
    title: 'greymarsh winter-log regression: the confirmation that never sticks',
    repo: 'greymarsh',
    ref: { kind: 'branch', value: 'task/x1' },
    partition: 'crucible-qualification',
    brief:
      'greymarsh is an event-sourced bothy-booking service (start with README.md and _meta/STATUS.md). Since the 0.7.1 winter maintenance pass, wardens report re-bookings that confirm WITHOUT ERROR but stay "requested" in the admin view — test/rebooking.test.mjs reproduces it. The wardens suspect the admin fold is dropping confirmations, but the fold\'s corruption law and the command layer are covered green by their own suites. Diagnose the true root cause and fix it at its owner without weakening the fold\'s corruption law, disabling or rewriting history in the maintenance pass, or touching any test.' ,
    timeCeilingSec: 3600,
    humanEstimate: {
      minutes: 60,
      method:
        'reference-build wall: the corpus author planted the defect from the RT-01 mined shape and repaired it in one pass (2026-08-04); the diagnosis chain (symptom at the fold → tie law is correct → seq collision after compaction → assignment at the log owner) banded to the METR-style ~1 h horizon.',
    },
    sourceClass: 'reconstructed-defect',
    variability: 'behavioral',
    grader: {
      checks: [{ ...NODE_TEST, timeoutSec: 120 }],
      mustChange: ['src/events.js'],
      // The greymarsh pack's uniform operational surface (see GM2's note).
      onlyChange: [
        'src/events.js',
        '_meta/STATUS.md',
        '_meta/CHANGELOG.md',
        'README.md',
        'package.json',
      ],
    },
    reference: { files: GREYMARSH_X1_REFERENCE },
    falsify: GREYMARSH_X1_FALSIFY,
  },

  // ── family 21 · contradictory-constraints ──
  {
    id: 'GM2',
    family: 21,
    title: 'greymarsh storm levy: three laws that seem unable to coexist',
    repo: 'greymarsh',
    ref: { kind: 'branch', value: 'task/x2' },
    partition: 'crucible-qualification',
    brief:
      'greymarsh prices bookings through a two-generation policy migration (start with README.md and _meta/STATUS.md). The coastguard now requires a storm levy — £2 per party member per levy day (year-days 300-359) — on every quoted booking price, and test/storm-levy.test.mjs pins it. The pinned surface is the COMMAND price (what requestBooking quotes); the admin view follows in 0.7.4 and must not change now. Two standing laws also hold: the parity law (test/policy-parity.test.mjs — both pricing generations agree to the penny until the migration completes) and the freeze law (the retired generation-1 module is bit-frozen; it retires by deletion, never by edit). Satisfy all three at once — if they look mutually unsatisfiable from where you are standing, the change belongs somewhere else. Do not touch any test.',
    timeCeilingSec: 3600,
    humanEstimate: {
      minutes: 45,
      method:
        'reference-build wall: the corpus author authored the composable-surcharge resolution in one pass (2026-08-04); the trap (both generation modules are the wrong owner) banded to the METR-style ~45 min horizon against the mined contradictory-checks retro shape (RT-05).',
    },
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [{ ...NODE_TEST, timeoutSec: 120 }],
      mustChange: ['src/booking.js'],
      // batch D caught the brief↔grader scope disagreement live
      // (twice: STATUS.md on run 1, the package.json version stamp on run 2):
      // the greymarsh pack's UNIFORM operational surface — working notes,
      // changelog, README, the version stamp — is admissible on every task;
      // the briefs' real prohibitions (tests, the generation modules) stay
      // enforced by exclusion.
      onlyChange: [
        'src/booking.js',
        'src/levy.js',
        '_meta/STATUS.md',
        '_meta/CHANGELOG.md',
        'README.md',
        'package.json',
      ],
    },
    reference: { files: GREYMARSH_X2_REFERENCE },
    falsify: GREYMARSH_X2_FALSIFY,
  },

  // ── family 22 · long-session-continuity ──
  {
    id: 'GM3',
    family: 22,
    title: 'greymarsh migration close-out: finish the recorded plan exactly',
    repo: 'greymarsh',
    ref: { kind: 'branch', value: 'task/x3' },
    partition: 'crucible-dev',
    brief:
      'greymarsh is mid-way through the 0.7.2 policy migration; the working notes (_meta/STATUS.md) record exactly where the last session left off and exactly one code move remains. Continue the work AS RECORDED: move the booking priority path to the recorded generation-2 target using the recorded member, tick the completed checklist item (keep the item in the list), and change nothing the plan does not call for — the deletion of generation 1 is explicitly scheduled for 0.7.4 and must not happen early. test/migration.test.mjs pins the close-out; the whole suite must stay green.',
    timeCeilingSec: 2700,
    humanEstimate: {
      minutes: 30,
      method:
        'reference-build wall: the corpus author landed the recorded move in one pass (2026-08-04, ~15 min); the continuity discipline (read the trail, do exactly the remaining step, update the ledger) banded to the METR-style ~30 min horizon against the mined resume-session shape (RT-04).',
    },
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [{ ...NODE_TEST, timeoutSec: 120 }],
      mustChange: ['src/booking.js', '_meta/STATUS.md'],
      // The greymarsh pack's uniform operational surface (see GM2's note).
      onlyChange: [
        'src/booking.js',
        '_meta/STATUS.md',
        '_meta/CHANGELOG.md',
        'README.md',
        'package.json',
      ],
    },
    reference: { files: GREYMARSH_X3_REFERENCE },
    falsify: GREYMARSH_X3_FALSIFY,
  },

  // ── family 23 · multi-agent-integration ───────────────────
  {
    id: 'GM4',
    family: 23,
    title: 'greymarsh warden features: two areas, two shared seams',
    repo: 'greymarsh',
    ref: { kind: 'branch', value: 'task/x4' },
    partition: 'crucible-qualification',
    brief:
      'greymarsh needs the two 0.7.3 warden features (start with README.md; test/wardens.test.mjs pins both): AREA A — maintenance windows: declareMaintenance(log, {hutId, from, to}) appends a maintenance-declared event; a confirmed booking and a maintenance window may never overlap, and whichever side arrives second is refused with the blocker named. AREA B — the expiry sweep: expireStale(log, {beforeDay}) appends exactly one booking-expired event per still-requested booking whose stay ended before beforeDay, idempotently, returning the expired ids sorted. The areas are separable but share the event vocabulary and the fold: keep the state shape coherent (queue and occupancy views must stay truthful), never mutate state outside the log, and decompose the work however serves it best — the grade is integration correctness, not headcount.',
    timeCeilingSec: 4500,
    humanEstimate: {
      minutes: 75,
      method:
        'reference-build wall: the corpus author landed both areas + the cross-feature refusals in one pass (2026-08-04, ~35 min); the seam discipline (one event vocabulary, one fold, refusal symmetry) banded to the METR-style ~1.25 h horizon against the mined fan-out session shape (RT-08).',
    },
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [{ ...NODE_TEST, timeoutSec: 120 }],
      mustChange: ['src/booking.js', 'src/state.js'],
      // batch D: same live catch as GM2 — the conscientious-
      // maintainer surfaces (working notes, changelog, README, the version
      // stamp) are admissible; the graded semantics stay pinned by checks +
      // the mustChange owners.
      onlyChange: [
        'src/booking.js',
        'src/state.js',
        '_meta/STATUS.md',
        '_meta/CHANGELOG.md',
        'README.md',
        'package.json',
      ],
    },
    reference: { files: GREYMARSH_X4_REFERENCE },
    falsify: GREYMARSH_X4_FALSIFY,
  },

  // ── family 24 · responsive-web-product ────────────────────
  {
    id: 'WP1',
    family: 24,
    title: 'waypost dispatch board: filter, honest render, keyboard model',
    repo: 'waypost',
    ref: { kind: 'branch', value: 'main' },
    partition: 'crucible-qualification',
    brief:
      'Waypost is a courier dispatch board — plain ES modules, no build step, a browser shell hydrating pure functions (start with README.md; the dense spec lives in the three seam files\' pinned contracts and the suites). Implement src/filter.js (case-insensitive search over id/label/courier display name, exact status/station filters, and the v0.2 OVERDUE CLARIFICATION: past-due undelivered consignments pin to the column head most-overdue-first, ties by id; the rest order by due day then id; pure, no input mutation), src/renderBoard.js (the board as an HTML string: four labelled role=list columns with counts, listitem cards with status chips and the overdue chip, honest loading/error/empty states, ALL untrusted text escaped), and src/keynav.js (the pure keyboard model: clamped arrows, Home/End, Enter-opens, Escape-clears, no mutation). `node --test` must pass completely; confine your changes to those three files.',
    timeCeilingSec: 5400,
    humanEstimate: {
      minutes: 110,
      method:
        'reference-build wall: the corpus author implemented the three seams against the pinned suites in one pass (2026-08-04, ~55 min); the spec density (ordering laws + honesty states + escaping + keyboard model) banded to the METR-style ~2 h horizon against the mined web-overhaul session rows (friction digest p02, RT-02).',
    },
    sourceClass: 'engineering-work',
    variability: 'behavioral',
    grader: {
      checks: [{ ...NODE_TEST, timeoutSec: 120 }],
      mustChange: ['src/filter.js', 'src/renderBoard.js', 'src/keynav.js'],
      onlyChange: ['src/filter.js', 'src/renderBoard.js', 'src/keynav.js'],
    },
    reference: { files: WAYPOST_W1_REFERENCE },
    falsify: WAYPOST_W1_FALSIFY,
  },
]

/** Fast lookup + structural sanity used by provers and the runner. */
export function taskById(id: string): HelixTask {
  const task = HELIX_TASKS.find(t => t.id === id)
  if (!task) throw new Error('unknown helix task: ' + id)
  return task
}
