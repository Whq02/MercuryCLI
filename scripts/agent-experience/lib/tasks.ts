// ============================================================================
//  scripts/agent-experience/lib/tasks.ts — the thirteen first-session tasks.
//
//  Each task is: the operator's plain ask (the prompt a live model receives;
//  the mechanical legs prefix a routing marker), the tools a first-session
//  operator would have pre-approved for it, a deterministic ORACLE over the
//  project state and the transcript, and — for the mechanical legs — the
//  scripted tool path a competent model takes, including the DELIBERATE
//  first-session mistakes (probes) whose error text the scorer records:
//  an edit against unread/mismatched text, a wrong parameter name, a call
//  missing its required field, a guessed skill name, a failing shell run.
//  Every probe is a stumble harvested from the operator's reference session.
// ============================================================================
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { digestOf, rewritePlanToken } from '../../../src/utils/astPatterns.ts'
import type { FixtureHit } from './fixture.ts'
import type { RunRecord } from './runner.ts'
import { systemPromptText, userTexts } from './wire.ts'
import type { ScriptedTurn } from './wire.ts'
import {
  EMPTY_MEAN_TEST,
  FIXTURE_PAGE_TITLE,
  MEDIAN_BUG_NEW,
  MEDIAN_BUG_OLD,
  changedFiles,
  runTests,
  type ProjectFacts,
} from './project.ts'

export interface TaskContext {
  projectDir: string
  pageUrl: string
  mechanical: boolean
  facts: ProjectFacts
  nodeBin: string
}

export interface OracleInput {
  run: RunRecord
  /** This run's fixture hits (mechanical legs; empty on the live leg). */
  hits: FixtureHit[]
  /** The prior phase's run for a two-phase task. */
  prior?: RunRecord
}

export interface OracleVerdict {
  pass: boolean | null
  detail: string
}

export interface TaskDef {
  id: string
  title: string
  /** The operator's ask, in plain words. */
  ask: string
  needs?: 'browser'
  /** Two-phase: this task resumes the named task's session and project. */
  resumeOf?: string
  allowedTools: string[]
  maxTurns: number
  prompt(ctx: TaskContext): string
  script(ctx: TaskContext): ScriptedTurn[]
  seats?(ctx: TaskContext): Record<string, ScriptedTurn[]>
  /** Tool names of the script's deliberate mistakes, in order. */
  probeTools: string[]
  oracle(ctx: TaskContext, input: OracleInput): OracleVerdict
}

const CODING_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash(node:*)', 'Bash(npm:*)', 'Bash(cat:*)', 'Bash(ls:*)', 'Bash(wc:*)', 'Bash(git:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(sed:*)']

const call = (name: string, input: Record<string, unknown>): ScriptedTurn => ({ calls: [{ name, input }] })
const final = (text: string): ScriptedTurn => ({ final: text })

function toolResultsOf(run: RunRecord, toolName: string): Array<{ text: string; isError: boolean }> {
  const ids = new Set(run.toolUses.filter(u => u.name === toolName).map(u => u.id))
  return run.toolResults.filter(r => ids.has(r.id))
}

function numstat(dir: string, file: string): string {
  try {
    return execFileSync('git', ['diff', '--numstat', '--', file], { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).toString('utf8').trim()
  } catch {
    return ''
  }
}

function readFile(dir: string, rel: string): string {
  try {
    return execFileSync('cat', [join(dir, rel)], { stdio: 'pipe' }).toString('utf8')
  } catch {
    return ''
  }
}

function withMarker(ctx: TaskContext, id: string, ask: string): string {
  return ctx.mechanical ? `[ax:${id}] ${ask}` : ask
}

export const TASKS: TaskDef[] = [
  {
    id: 'fix-bug',
    title: 'find and fix a bug',
    ask: 'The test suite fails when you run `node --test`. Find the bug in src/stats.js and fix it so the suite passes. Do not change the tests.',
    allowedTools: CODING_TOOLS,
    maxTurns: 12,
    prompt: ctx => withMarker(ctx, 'fix-bug', TASKS_ASK('fix-bug')),
    // The failing run is a legitimate call whose result is an error: the
    // probe records what a model reads back from a failing shell command.
    probeTools: ['Bash'],
    script: ctx => [
      call('Bash', { command: 'node --test', description: 'Run the test suite' }),
      call('Read', { file_path: join(ctx.projectDir, 'src', 'stats.js') }),
      call('Edit', { file_path: join(ctx.projectDir, 'src', 'stats.js'), old_string: MEDIAN_BUG_OLD, new_string: MEDIAN_BUG_NEW }),
      call('Bash', { command: 'node --test 2>&1 | tail -12', description: 'Re-run the suite after the fix' }),
      final('Fixed median() in src/stats.js: an even-length list now averages its two middle values. node --test passes (4 of 4).'),
    ],
    oracle: (ctx, { run }) => {
      const tests = runTests(ctx.projectDir, ctx.nodeBin)
      const changed = changedFiles(ctx.projectDir)
      const onlyStats = changed.length === 1 && changed[0] === 'src/stats.js'
      const pass = tests.exit === 0 && onlyStats
      return { pass, detail: `node --test exit ${tests.exit}; changed files: ${changed.join(', ') || 'none'}; final: ${run.finalText.slice(0, 80)}` }
    },
  },
  {
    id: 'add-test',
    title: 'add a test and run it',
    ask: 'Add a test case to test/stats.test.js asserting that mean([]) returns 0, then run the suite and report the outcome.',
    allowedTools: CODING_TOOLS,
    maxTurns: 12,
    prompt: ctx => withMarker(ctx, 'add-test', TASKS_ASK('add-test')),
    probeTools: [],
    script: ctx => [
      call('Read', { file_path: join(ctx.projectDir, 'test', 'stats.test.js') }),
      call('Edit', {
        file_path: join(ctx.projectDir, 'test', 'stats.test.js'),
        old_string: "test('median of an even-length list averages the middle pair', () => {\n  assert.equal(median([1, 2, 3, 4]), 2.5)\n})\n",
        new_string: `test('median of an even-length list averages the middle pair', () => {\n  assert.equal(median([1, 2, 3, 4]), 2.5)\n})\n${EMPTY_MEAN_TEST}`,
      }),
      call('Bash', { command: 'node --test 2>&1 | tail -15', description: 'Run the suite' }),
      final('Added "mean of an empty list is 0" to test/stats.test.js; it passes. The suite still reports the pre-existing even-length median failure (3 pass, 1 fail).'),
    ],
    oracle: (ctx, { run }) => {
      const source = readFile(ctx.projectDir, 'test/stats.test.js')
      const hasTest = /mean\(\[\]\)/.test(source)
      let newCasePasses = false
      try {
        execFileSync(ctx.nodeBin, ['--test', '--test-name-pattern', 'empty'], { cwd: ctx.projectDir, stdio: 'pipe', timeout: 30_000 })
        newCasePasses = true
      } catch {
        newCasePasses = false
      }
      const changed = changedFiles(ctx.projectDir)
      const onlyTest = changed.length === 1 && changed[0] === 'test/stats.test.js'
      const ranSuite = toolResultsOf(run, 'Bash').some(r => /node --test|\bpass\b|\bfail\b|# tests/i.test(r.text)) || run.toolUses.some(u => u.name === 'Bash' && /node --test|npm test/.test(String(u.input.command ?? '')))
      return { pass: hasTest && newCasePasses && onlyTest && ranSuite, detail: `test present: ${hasTest}; new case passes: ${newCasePasses}; changed: ${changed.join(', ') || 'none'}; suite run: ${ranSuite}` }
    },
  },
  {
    id: 'anchored-edit',
    title: 'edit a file precisely',
    ask: 'In README.md, change the heading `## Usage` to `## Usage (CLI)`. Change nothing else in the file.',
    allowedTools: CODING_TOOLS,
    maxTurns: 10,
    prompt: ctx => withMarker(ctx, 'anchored-edit', TASKS_ASK('anchored-edit')),
    // The first-session stumble: an edit before any read, against text that
    // does not match (case). The error text is what the model learns from.
    probeTools: ['Edit'],
    script: ctx => [
      call('Edit', { file_path: join(ctx.projectDir, 'README.md'), old_string: '## usage', new_string: '## Usage (CLI)' }),
      call('Read', { file_path: join(ctx.projectDir, 'README.md') }),
      call('Edit', { file_path: join(ctx.projectDir, 'README.md'), old_string: '## Usage\n', new_string: '## Usage (CLI)\n' }),
      final('Changed the README heading to "## Usage (CLI)"; nothing else touched.'),
    ],
    oracle: ctx => {
      const source = readFile(ctx.projectDir, 'README.md')
      const changed = changedFiles(ctx.projectDir)
      const stat = numstat(ctx.projectDir, 'README.md')
      const oneLine = /^1\t1\tREADME\.md$/.test(stat)
      const pass = source.includes('## Usage (CLI)') && oneLine && changed.length === 1
      return { pass, detail: `heading present: ${source.includes('## Usage (CLI)')}; numstat: ${stat || 'no diff'}; changed: ${changed.join(', ') || 'none'}` }
    },
  },
  {
    id: 'search-symbol',
    title: 'search the repo for a symbol',
    ask: 'Where is `normalizeRecord` defined, and where is it called? Report file:line for the definition and for each call site.',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash(grep:*)', 'Bash(rg:*)'],
    maxTurns: 8,
    prompt: ctx => withMarker(ctx, 'search-symbol', TASKS_ASK('search-symbol')),
    // The stumble: the search tool called with a guessed parameter name.
    probeTools: ['Grep'],
    script: ctx => [
      call('Grep', { query: 'normalizeRecord', path: ctx.projectDir }),
      call('Grep', { pattern: 'normalizeRecord', path: ctx.projectDir, output_mode: 'content', '-n': true }),
      final(`normalizeRecord is defined at src/records.js:${ctx.facts.defLine} and called at src/stats.js:${ctx.facts.callLine} (imported at src/stats.js:2).`),
    ],
    oracle: (ctx, { run }) => {
      const text = run.finalText
      const hasDef = text.includes(`records.js:${ctx.facts.defLine}`)
      const hasCall = text.includes(`stats.js:${ctx.facts.callLine}`)
      const searched = run.toolUses.some(u => u.name === 'Grep' || (u.name === 'Bash' && /grep|rg/.test(String(u.input.command ?? ''))))
      return { pass: hasDef && hasCall && searched, detail: `definition cited: ${hasDef}; call site cited: ${hasCall}; searched: ${searched}` }
    },
  },
  {
    id: 'shell-pipeline',
    title: 'run a shell pipeline and read its output',
    ask: 'Using a single shell pipeline, count the total number of lines across all .js files under src/ and report the number.',
    allowedTools: ['Bash(cat:*)', 'Bash(wc:*)', 'Bash(find:*)', 'Bash(ls:*)', 'Read', 'Glob'],
    maxTurns: 8,
    prompt: ctx => withMarker(ctx, 'shell-pipeline', TASKS_ASK('shell-pipeline')),
    probeTools: [],
    script: ctx => [
      call('Bash', { command: 'cat src/*.js | wc -l', description: 'Count lines across src/*.js' }),
      final(`The .js files under src/ total ${ctx.facts.srcLineCount} lines.`),
    ],
    oracle: (ctx, { run }) => {
      const n = ctx.facts.srcLineCount
      const cited = new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(run.finalText)
      const piped = run.toolUses.some(u => u.name === 'Bash' && /\|/.test(String(u.input.command ?? '')))
      return { pass: cited && piped, detail: `expected ${n}; cited: ${cited}; pipeline used: ${piped}` }
    },
  },
  {
    id: 'use-skill',
    title: 'use a bundled skill',
    ask: 'Use the bundled provider-apis skill, then tell me which HTTP endpoint the OpenAI Responses dialect posts to.',
    allowedTools: ['Skill', 'Read', 'Grep', 'Glob'],
    maxTurns: 8,
    prompt: ctx => withMarker(ctx, 'use-skill', TASKS_ASK('use-skill')),
    // The stumble: a near-miss skill name.
    probeTools: ['Skill'],
    script: () => [
      call('Skill', { skill: 'provider-api' }),
      call('Skill', { skill: 'provider-apis' }),
      final('The OpenAI Responses dialect posts to POST /v1/responses (the base URL plus /responses).'),
    ],
    oracle: (_ctx, { run }) => {
      const uses = run.toolUses.filter(u => u.name === 'Skill' && String(u.input.skill ?? '').replace(/^\//, '') === 'provider-apis')
      const ids = new Set(uses.map(u => u.id))
      const loaded = run.toolResults.some(r => ids.has(r.id) && !r.isError)
      const answered = /responses/i.test(run.finalText)
      return { pass: loaded && answered, detail: `provider-apis loaded: ${loaded}; answer names responses: ${answered}` }
    },
  },
  {
    id: 'delegate-agent',
    title: 'delegate a subtask to an agent',
    ask: 'Delegate to a subagent: have it read test/stats.test.js and report which functions the tests cover. Then relay its report to me.',
    allowedTools: ['Agent', 'Read', 'Grep', 'Glob'],
    maxTurns: 8,
    prompt: ctx => withMarker(ctx, 'delegate-agent', TASKS_ASK('delegate-agent')),
    probeTools: [],
    script: ctx => [
      call('Agent', { description: 'Summarize test coverage', prompt: `[ax-seat:summary] Read ${join(ctx.projectDir, 'test', 'stats.test.js')} and report which functions the tests cover.`, subagent_type: 'general-purpose' }),
      final('The subagent reports the tests cover two functions: mean (one case) and median (two cases, odd- and even-length).'),
    ],
    seats: ctx => ({
      summary: [
        call('Read', { file_path: join(ctx.projectDir, 'test', 'stats.test.js') }),
        final('The tests cover two functions: mean (one case) and median (two cases: odd-length and even-length lists).'),
      ],
    }),
    oracle: (ctx, { run, hits }) => {
      const results = toolResultsOf(run, 'Agent')
      const reported = results.some(r => !r.isError && /median/i.test(r.text))
      const relayed = /mean/i.test(run.finalText) && /median/i.test(run.finalText)
      // Mechanical: the seat must have run ITS script — the fixture saw the
      // seat request and the seat's own Read reached the transcript.
      const seatRan = ctx.mechanical ? hits.some(h => h.kind === 'seat' && h.seatId === 'summary') && run.subagentToolUses.some(u => u.name === 'Read') : true
      return { pass: reported && relayed && seatRan, detail: `agent reported: ${reported}; relayed: ${relayed}; seat ran its script: ${seatRan}` }
    },
  },
  {
    id: 'ide-diagnostics',
    title: 'open a file in the IDE seam',
    ask: "Open src/stats.js in Mercury's IDE seam — the language server — and report its diagnostics.",
    allowedTools: ['LSP', 'Read', 'Grep', 'Glob'],
    maxTurns: 8,
    prompt: ctx => withMarker(ctx, 'ide-diagnostics', TASKS_ASK('ide-diagnostics')),
    probeTools: [],
    script: ctx => [
      call('LSP', { operation: 'diagnostics', filePath: join(ctx.projectDir, 'src', 'stats.js') }),
      final('Opened src/stats.js in the language server; its diagnostics are listed in the LSP result above.'),
    ],
    oracle: (_ctx, { run }) => {
      const results = toolResultsOf(run, 'LSP')
      const opened = results.some(r => !r.isError && !/outcome:\s*(failed|indeterminate)|unavailable|no language server|not available|not enabled/i.test(r.text))
      const used = run.toolUses.some(u => u.name === 'LSP')
      return { pass: used && opened, detail: `LSP called: ${used}; server answered: ${opened}; first result: ${(results[0]?.text ?? '').slice(0, 120).replace(/\n/g, ' ')}` }
    },
  },
  {
    id: 'browser-page',
    title: 'drive the browser tool on a fixture page',
    ask: 'Open the fixture page in the Browser tool, tell me the page title, and take a screenshot.',
    needs: 'browser',
    allowedTools: ['Browser'],
    maxTurns: 10,
    prompt: ctx => withMarker(ctx, 'browser-page', `Open ${ctx.pageUrl} in the Browser tool, tell me the page title, and take a screenshot.`),
    // The stumble: the open call without its url.
    probeTools: ['Browser'],
    script: ctx => [
      call('Browser', { op: 'open' }),
      call('Browser', { op: 'open', url: ctx.pageUrl }),
      call('Browser', { op: 'screenshot', label: 'ax-fixture' }),
      call('Browser', { op: 'close' }),
      final(`The page title is "${FIXTURE_PAGE_TITLE}"; screenshot captured.`),
    ],
    oracle: (_ctx, { run }) => {
      const opens = toolResultsOf(run, 'Browser')
      const sawTitle = opens.some(r => !r.isError && r.text.includes(FIXTURE_PAGE_TITLE))
      const reported = run.finalText.includes(FIXTURE_PAGE_TITLE)
      return { pass: sawTitle && reported, detail: `title in a Browser result: ${sawTitle}; title reported: ${reported}` }
    },
  },
  {
    id: 'guide-question',
    title: 'ask the guide agent a how-do-I question',
    ask: "Ask Mercury's built-in guide agent this question and relay its answer: how do I change the permission mode in Mercury?",
    allowedTools: ['Agent', 'Read', 'Grep', 'Glob', 'WebFetch'],
    maxTurns: 8,
    prompt: ctx => withMarker(ctx, 'guide-question', TASKS_ASK('guide-question')),
    probeTools: [],
    script: () => [
      call('Agent', { description: 'Ask the Mercury guide', prompt: '[ax-seat:guide] How do I change the permission mode in Mercury?', subagent_type: 'mercury-guide' }),
      final('The guide says: in an interactive session the mode cycles on the shift+tab carousel; /authority is the control surface; a headless run sets it with --permission-mode <mode>.'),
    ],
    seats: () => ({
      guide: [final('Interactive sessions cycle the permission mode on the shift+tab carousel; /authority is the control surface; a headless run sets it at launch with --permission-mode <mode>.')],
    }),
    oracle: (ctx, { run, hits }) => {
      const surfaces = /shift\s*\+?\s*tab|\/authority|--permission-mode|\/sovereign/i
      const relayed = surfaces.test(run.finalText)
      if (!ctx.mechanical) {
        const asked = run.toolUses.some(u => u.name === 'Agent' && String(u.input.subagent_type ?? '') === 'mercury-guide')
        return { pass: asked && relayed, detail: `guide asked: ${asked}; a real surface named: ${relayed}` }
      }
      const seat = hits.find(h => h.kind === 'seat' && h.seatId === 'guide')
      const prompt = seat ? systemPromptText(seat.body, seat.dialect!) : ''
      const isGuide = /product and API guide/i.test(prompt)
      const knowsRoster = /\/authority/.test(prompt)
      return { pass: !!seat && isGuide && knowsRoster && relayed, detail: `guide seat request: ${!!seat}; guide prompt: ${isGuide}; roster carries /authority: ${knowsRoster}; relayed: ${relayed}` }
    },
  },
  {
    id: 'two-seats',
    title: 'coordinate two seats',
    ask: 'Coordinate two seats in parallel — seat A: count the test cases in test/stats.test.js; seat B: list the functions src/stats.js exports. Launch both at once, then merge their reports into one summary.',
    allowedTools: ['Agent', 'Read', 'Grep', 'Glob'],
    maxTurns: 8,
    prompt: ctx => withMarker(ctx, 'two-seats', TASKS_ASK('two-seats')),
    probeTools: [],
    script: ctx => [
      {
        calls: [
          { name: 'Agent', input: { description: 'Seat A: count tests', prompt: `[ax-seat:count] Count the test cases in ${join(ctx.projectDir, 'test', 'stats.test.js')}.`, subagent_type: 'general-purpose' } },
          { name: 'Agent', input: { description: 'Seat B: list exports', prompt: `[ax-seat:exports] List the functions ${join(ctx.projectDir, 'src', 'stats.js')} exports.`, subagent_type: 'general-purpose' } },
        ],
      },
      final(`Seat A: test/stats.test.js holds ${ctx.facts.testCount} test cases. Seat B: src/stats.js exports ${ctx.facts.exports.join(', ')}.`),
    ],
    seats: ctx => ({
      count: [call('Read', { file_path: join(ctx.projectDir, 'test', 'stats.test.js') }), final(`test/stats.test.js holds ${ctx.facts.testCount} test cases.`)],
      exports: [call('Read', { file_path: join(ctx.projectDir, 'src', 'stats.js') }), final(`src/stats.js exports ${ctx.facts.exports.join(', ')}.`)],
    }),
    oracle: (ctx, { run }) => {
      const agentUses = run.toolUses.filter(u => u.name === 'Agent')
      const perMessage = new Map<string, number>()
      for (const u of agentUses) perMessage.set(u.messageId, (perMessage.get(u.messageId) ?? 0) + 1)
      const parallel = [...perMessage.values()].some(n => n >= 2)
      const results = toolResultsOf(run, 'Agent')
      // Both seats answered with THEIR facts (a side-routed seat answers
      // with neither): the count from seat A, the exports from seat B.
      const countRe = new RegExp(`(^|[^0-9])${ctx.facts.testCount}([^0-9]|$)`)
      const seatA = results.some(r => !r.isError && countRe.test(r.text))
      const seatB = results.some(r => !r.isError && /median/i.test(r.text))
      const bothAnswered = seatA && seatB
      const merged = countRe.test(run.finalText) && /median/i.test(run.finalText)
      const pass = ctx.mechanical ? parallel && bothAnswered && merged : agentUses.length >= 2 && bothAnswered && merged
      return { pass, detail: `agent calls: ${agentUses.length}; one parallel round: ${parallel}; both seats answered with their facts: ${bothAnswered}; merged: ${merged}` }
    },
  },
  {
    id: 'structural-rename',
    title: 'rename a function structurally across three files',
    ask: 'Rename the function normalizeRecord to normaliseRecord everywhere in the source — its declaration in src/records.js, the imports and every use in src/stats.js and src/format.js — with the structural tools (AstSearch to find it, AstEdit to rewrite it), not text replacement. Leave README.md and the tests alone, then run node --test to confirm the modules still load.',
    allowedTools: ['AstSearch', 'AstEdit', 'Read', 'Grep', 'Glob', 'Bash(node:*)'],
    maxTurns: 10,
    prompt: ctx => withMarker(ctx, 'structural-rename', TASKS_ASK('structural-rename')),
    // The first-session stumble: an apply before the dry run — the error text
    // names the two-call law (dry run, then apply with the plan token).
    probeTools: ['AstEdit'],
    script: ctx => {
      // The plan token is content-addressed over the pattern, the rewrite and
      // every changed file's before/after digest in root-relative order — the
      // scripted model names it ahead of time from the fixture's own bytes.
      const rels = ['src/format.js', 'src/records.js', 'src/stats.js']
      const files = rels.map((rel): [string, string, string] => {
        const before = readFile(ctx.projectDir, rel)
        return [rel, digestOf(before), digestOf(before.replaceAll('normalizeRecord', 'normaliseRecord'))]
      })
      const plan = rewritePlanToken('normalizeRecord', 'normaliseRecord', files)
      const scope = { path: ctx.projectDir, glob: '**/*.js' }
      return [
        call('AstSearch', { pattern: 'normalizeRecord', ...scope, mode: 'count' }),
        call('AstEdit', { pattern: 'normalizeRecord', rewrite: 'normaliseRecord', ...scope, apply: true }),
        call('AstEdit', { pattern: 'normalizeRecord', rewrite: 'normaliseRecord', ...scope }),
        call('AstEdit', { pattern: 'normalizeRecord', rewrite: 'normaliseRecord', ...scope, apply: true, plan }),
        call('Bash', { command: 'node --test 2>&1 | tail -8', description: 'Confirm the renamed modules still load' }),
        final('Renamed normalizeRecord to normaliseRecord structurally — the declaration in src/records.js, the imports and every use in src/stats.js and src/format.js — through one AstEdit plan; README and tests untouched. node --test still shows only the pre-existing even-length median failure (2 pass, 1 fail).'),
      ]
    },
    oracle: (ctx, { run }) => {
      const sources = ['src/records.js', 'src/stats.js', 'src/format.js'].map(f => readFile(ctx.projectDir, f))
      const noOld = sources.every(s => !s.includes('normalizeRecord'))
      const allNew = sources.every(s => s.includes('normaliseRecord'))
      const changed = changedFiles(ctx.projectDir)
      const onlySources = changed.length === 3 && changed.every(f => f.startsWith('src/'))
      const readmeIntact = readFile(ctx.projectDir, 'README.md').includes('normalizeRecord')
      const structural = run.toolUses.some(u => u.name === 'AstEdit' && u.input.apply === true && typeof u.input.plan === 'string')
      // The suite's pre-existing shape (2 pass, the even-length median fails)
      // must survive the rename: a broken import would surface as a
      // ReferenceError or a module-load failure, not as that one assertion.
      const tests = runTests(ctx.projectDir, ctx.nodeBin)
      const passed = Number(/(?:^|\n)(?:ℹ|#) pass (\d+)/.exec(tests.output)?.[1] ?? -1)
      const failed = Number(/(?:^|\n)(?:ℹ|#) fail (\d+)/.exec(tests.output)?.[1] ?? -1)
      const loads = passed === 2 && failed === 1 && !/ReferenceError|SyntaxError|ERR_MODULE_NOT_FOUND/.test(tests.output)
      return {
        pass: noOld && allNew && onlySources && readmeIntact && structural && loads,
        detail: `old name gone: ${noOld}; new name in all three: ${allNew}; changed: ${changed.join(', ') || 'none'}; README intact: ${readmeIntact}; structural apply: ${structural}; modules load (2 pass, 1 fail as before): ${loads} (${passed}/${failed})`,
      }
    },
  },
  {
    id: 'resume-a',
    title: 'resume a session (phase 1: the codeword)',
    ask: 'Remember this codeword for later in this session: PELICAN-42. Reply with the single word: noted.',
    allowedTools: [],
    maxTurns: 3,
    prompt: ctx => withMarker(ctx, 'resume-a', TASKS_ASK('resume-a')),
    probeTools: [],
    script: () => [final('noted')],
    oracle: (_ctx, { run }) => ({ pass: /noted/i.test(run.finalText), detail: `final: ${run.finalText.slice(0, 60)}` }),
  },
  {
    id: 'resume-b',
    title: 'resume a session (phase 2: recall)',
    ask: 'What was the codeword I gave you earlier in this session? Answer with the codeword only.',
    resumeOf: 'resume-a',
    allowedTools: [],
    maxTurns: 3,
    prompt: ctx => withMarker(ctx, 'resume-b', TASKS_ASK('resume-b')),
    probeTools: [],
    script: () => [final('PELICAN-42')],
    oracle: (ctx, { run, hits }) => {
      const recalled = /PELICAN-42/.test(run.finalText)
      if (!ctx.mechanical) return { pass: recalled, detail: `recalled: ${recalled}` }
      const main = hits.find(h => h.kind === 'main' && h.taskId === 'resume-b')
      const texts = main ? userTexts(main.body, main.dialect!) : []
      const carried = texts.some(t => t.includes('PELICAN-42')) && (main?.raw ?? '').includes('noted')
      return { pass: recalled && carried, detail: `recalled: ${recalled}; resumed request carried the prior turn: ${carried}` }
    },
  },
]

/** The plain ask by id (the prompt builders read it so the text lives once). */
export function TASKS_ASK(id: string): string {
  const task = TASKS.find(t => t.id === id)
  if (!task) throw new Error(`unknown task ${id}`)
  return task.ask
}

export function taskById(id: string): TaskDef {
  const task = TASKS.find(t => t.id === id)
  if (!task) throw new Error(`unknown task ${id}`)
  return task
}
