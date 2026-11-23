#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { importTarget, parseSource, slash, visit } from '../gate/sourceCensus.ts'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'turn-rule-order-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'turn-rule-order-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { NO_TOOL_RULES } = await import('../../src/engine/loop/turn/noToolReply.ts')
const { SCENARIOS, record } = await import('./turnScenarios.ts')

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/core-runtime/prove-turn-rule-order.ts'
const RULES_FILE = 'src/engine/loop/turn/noToolReply.ts'
const SCENARIO_FILE = 'scripts/core-runtime/turnScenarios.ts'
const DOOR = 'src/engine/loop/turn-machine.ts'
const INSIDE = 'src/engine/loop/turn/'

const ORDER = [
  'overflow_recovery',
  'pause_turn_continuation',
  'reasoning_only_recovery',
  'max_output_tokens_recovery',
  'stream_fault_recovery',
  'empty_reply_retry',
  'tool_call_refusal_recovery',
  'chant_recovery',
  'max_turns',
  'api_error',
  'announced_step_nudge',
  'stop_hooks',
  'checkpoint_settle_guard',
  'queued_message',
]

type Held = { first: string; second: string; scenes: string[] } | { first: string; second: string; neverMeet: string }

const HELD: Held[] = [
  { first: 'overflow_recovery', second: 'pause_turn_continuation', scenes: ['paused_reply_then_overflow'] },
  { first: 'pause_turn_continuation', second: 'reasoning_only_recovery', scenes: ['paused_thought_without_words'] },
  { first: 'reasoning_only_recovery', second: 'max_output_tokens_recovery', neverMeet: "the second rule's own guard: it decides only for a reply that is not reasoning-only" },
  { first: 'max_output_tokens_recovery', second: 'stream_fault_recovery', neverMeet: 'how the rows are made: a withheld output cap comes from the Anthropic lane alone, a stream-fault row from three other lanes' },
  { first: 'stream_fault_recovery', second: 'empty_reply_retry', neverMeet: 'how the rows are made: an empty mark is put only on a reply with nothing minted or with no tool call at all, never on a stream-fault row' },
  { first: 'empty_reply_retry', second: 'tool_call_refusal_recovery', neverMeet: 'how the rows are made: a refused call always mints a note, so its reply carries no empty mark' },
  { first: 'tool_call_refusal_recovery', second: 'chant_recovery', scenes: ['chant_with_refused_call'] },
  { first: 'chant_recovery', second: 'max_turns', scenes: ['turn_budget_closing_chant'] },
  { first: 'max_turns', second: 'api_error', scenes: ['turn_budget_closing_api_error'] },
  { first: 'api_error', second: 'announced_step_nudge', neverMeet: 'how the rows are made: an API-error row is made with the stop reason stop_sequence, and the nudge asks for end_turn' },
  { first: 'announced_step_nudge', second: 'stop_hooks', scenes: ['announced_step_nudged', 'announced_step_twice', 'announced_step_before_stop_hook'] },
  { first: 'stop_hooks', second: 'checkpoint_settle_guard', scenes: ['checkpoint_left_open', 'checkpoint_then_queued_message'] },
  { first: 'checkpoint_settle_guard', second: 'queued_message', scenes: ['checkpoint_then_queued_message'] },
  { first: 'overflow_recovery', second: 'stream_fault_recovery', scenes: ['stream_fault_stamped_with_an_overflow'] },
]

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the order of the rules exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail: string[] = []): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) for (const line of detail) console.log(`         ${line}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)

console.log('============================================================')
console.log(' the reply that asks for no tool: its rules in their order, and the one door of the turn machine')
console.log('============================================================')

section('(1) the order of the rules is behaviour: the first rule that decides wins')
{
  const stands = NO_TOOL_RULES.map(rule => rule.name)
  const added = stands.filter(name => !ORDER.includes(name))
  const dropped = ORDER.filter(name => !stands.includes(name))
  const kept = stands.filter(name => ORDER.includes(name))
  const held = ORDER.filter(name => stands.includes(name))
  const moved = kept.filter((name, at) => held[at] !== name)
  check(
    `NO_TOOL_RULES of ${RULES_FILE} holds the ${ORDER.length} rules this proof names, in this order: ${ORDER.join(' → ')}`,
    added.length === 0 && dropped.length === 0 && moved.length === 0,
    [
      ...added.map(name => `${name} stands at place ${stands.indexOf(name) + 1} of NO_TOOL_RULES in ${RULES_FILE} and is not in ORDER of ${SELF}: a new rule is written into ORDER at the place it runs, with a scenario in scripts/core-runtime/turnScenarios.ts that reaches it`),
      ...dropped.map(name => `${name} is in ORDER of ${SELF} and no longer in NO_TOOL_RULES of ${RULES_FILE}: put the rule back, or delete its name from ORDER if the rule is meant to go`),
      ...moved.map(name => `${name} runs at place ${stands.indexOf(name) + 1} in ${RULES_FILE} and stands at place ${ORDER.indexOf(name) + 1} in ORDER of ${SELF}: put the rule back where it ran, or move its name in ORDER if the new order is meant`),
    ],
  )
  const twice = stands.filter((name, at) => stands.indexOf(name) !== at)
  check('no rule stands twice in the list', twice.length === 0, twice.map(name => `${name} stands more than once in NO_TOOL_RULES of ${RULES_FILE}: a rule runs once for a reply`))
  const idle = NO_TOOL_RULES.filter(rule => typeof rule.decide !== 'function').map(rule => rule.name)
  check('every rule of the list is a function the arm can call', idle.length === 0, idle.map(name => `${name} in NO_TOOL_RULES of ${RULES_FILE} has no decide function`))
}

section('(2) what holds each order: a scene whose recording changes when the two rules are swapped, or the reason the two never meet on one reply')
{
  const pairOf = (row: Held): string => `${row.first} before ${row.second}`
  const adjacent = ORDER.slice(0, -1).map((name, at) => `${name} before ${ORDER[at + 1]}`)
  const unheld = adjacent.filter(pair => !HELD.some(row => pairOf(row) === pair))
  const strangers = HELD.filter(row => !ORDER.includes(row.first) || !ORDER.includes(row.second) || ORDER.indexOf(row.first) >= ORDER.indexOf(row.second)).map(pairOf)
  const twice = HELD.map(pairOf).filter((pair, at, all) => all.indexOf(pair) !== at)
  check(
    `each of the ${adjacent.length} adjacent orders of the list has its row in HELD, and ${HELD.length - adjacent.length} order of two rules that do not stand side by side`,
    unheld.length === 0 && strangers.length === 0 && twice.length === 0,
    [
      ...unheld.map(pair => `${pair} has no row in HELD of ${SELF}: name the scenes of ${SCENARIO_FILE} whose recording changes when the two are swapped, or the reason the two never meet on one reply`),
      ...strangers.map(pair => `${pair} is a row of HELD of ${SELF} and not an order of the list: a row names two rules of ORDER, the earlier first`),
      ...twice.map(pair => `${pair} stands twice in HELD of ${SELF}`),
    ],
  )

  const list = NO_TOOL_RULES as Array<(typeof NO_TOOL_RULES)[number]>
  const swapped = async <T>(row: Held, work: () => Promise<T>): Promise<T> => {
    const a = list.findIndex(rule => rule.name === row.first)
    const b = list.findIndex(rule => rule.name === row.second)
    const [one, other] = [list[a]!, list[b]!]
    list[a] = other
    list[b] = one
    try {
      return await work()
    } finally {
      list[a] = one
      list[b] = other
    }
  }
  const textOf = (recording: unknown): string => JSON.stringify(recording)
  const sceneOf = (name: string): (typeof SCENARIOS)[number] | undefined => SCENARIOS.find(scenario => scenario.name === name)
  const twiceRecordable = SCENARIOS.filter(scenario => scenario.oncePerProcess !== true)
  const rows = HELD.filter(row => ORDER.includes(row.first) && ORDER.includes(row.second))

  const asItStands = new Map<string, string>()
  for (const scenario of twiceRecordable) asItStands.set(scenario.name, textOf(await record(scenario)))
  for (const row of rows) {
    if (!('neverMeet' in row)) continue
    const moved: string[] = []
    await swapped(row, async () => {
      for (const scenario of twiceRecordable) if (textOf(await record(scenario)) !== asItStands.get(scenario.name)) moved.push(scenario.name)
    })
    check(
      `${pairOf(row)}: the two never meet on one reply (${row.neverMeet}), and no recording of ${twiceRecordable.length} scenarios changes when they are swapped`,
      moved.length === 0,
      [`${moved.join(', ')} of ${SCENARIO_FILE} ${moved.length === 1 ? 'changes' : 'change'} when the two rules are swapped: the two do meet, so the order is behaviour — name the ${moved.length === 1 ? 'scene' : 'scenes'} in this row of HELD of ${SELF} in place of the reason`],
    )
  }
  for (const row of rows) {
    if (!('scenes' in row)) continue
    for (const name of row.scenes) {
      const scenario = sceneOf(name)
      if (scenario === undefined) {
        check(`${pairOf(row)}: held by the scene ${name}`, false, [`${SCENARIO_FILE} holds no scenario named ${name}: plan a reply both rules act on there, or name the scene that holds this order in HELD of ${SELF}`])
        continue
      }
      const before = textOf(await record(scenario))
      const under = textOf(await swapped(row, () => record(scenario)))
      const after = textOf(await record(scenario))
      check(
        `${pairOf(row)}: the recording of ${name} changes when the two rules are swapped, and is itself again when they are put back`,
        before !== under && before === after,
        [
          before === under
            ? `the recording of ${name} is the same with ${row.second} before ${row.first}: the scene no longer shows this order — plan a reply both rules act on in ${SCENARIO_FILE}, or, if the two can no longer meet, give the reason in this row of HELD of ${SELF}`
            : `the recording of ${name} differs between two recordings under the list's own order: something of the run is not masked or carries over (${SCENARIO_FILE})`,
        ],
      )
    }
  }
}

section(`(3) one door: nothing outside ${DOOR} and ${INSIDE} imports a file under ${INSIDE}`)
{
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) files.push(full)
    }
  }
  walk(join(ROOT, 'src'))
  const strangers: string[] = []
  let inside = 0
  for (const file of files.sort()) {
    const rel = slash(relative(ROOT, file))
    if (rel.startsWith(INSIDE)) {
      inside++
      continue
    }
    if (rel === DOOR) continue
    const { sf } = parseSource(ROOT, file)
    const reach = (spec: string, node: ts.Node): void => {
      const target = importTarget(file, spec)
      if (target === null) return
      const to = slash(relative(ROOT, target))
      if (!to.startsWith(INSIDE)) return
      strangers.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} imports ${to}: import ${DOOR} instead (runEventCore is the one door of the turn machine, and what a caller needs of a step is exported there by name)`)
    }
    visit(sf, node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) reach(node.moduleSpecifier.text, node)
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) reach(node.argument.literal.text, node)
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const first = node.arguments[0]
        if (first && ts.isStringLiteralLike(first)) reach(first.text, node)
      }
    })
  }
  check(`the ${inside} files under ${INSIDE} are imported by ${DOOR} and by one another only (${files.length} files under src read from their import, export, import() and require() lines)`, strangers.length === 0 && inside > 0, strangers.length > 0 ? strangers : [`no file stands under ${INSIDE}: name where the steps went in INSIDE of ${SELF}`])
}

console.log('')
console.log(failures === 0 ? 'prove-turn-rule-order: THE ORDER AND THE DOOR HOLD' : `prove-turn-rule-order: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
