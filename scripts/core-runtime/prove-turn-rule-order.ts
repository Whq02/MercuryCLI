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

const { NO_TOOL_RULES } = await import('../../src/run-core/turn/noToolReply.ts')

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/core-runtime/prove-turn-rule-order.ts'
const RULES_FILE = 'src/run-core/turn/noToolReply.ts'
const DOOR = 'src/run-core/turn-machine.ts'
const INSIDE = 'src/run-core/turn/'

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

section(`(2) one door: nothing outside ${DOOR} and ${INSIDE} imports a file under ${INSIDE}`)
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
