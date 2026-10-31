#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, j, openKit, section } from './flowLawKit.ts'

const kit = await openKit('flow-sovereign-parity')
const corpus = JSON.parse(readFileSync(join(import.meta.dir, '..', 'bash', 'parser-corpus-parity.json'), 'utf8')) as { entries: Array<{ command: string }> }
const commands = [...new Set(corpus.entries.map(entry => entry.command))]

type Row = { command: string; sovereign: string; flow: string; message: string; item: number | null }
const rows: Row[] = []
const exceptions: Row[] = []
const breaks: Row[] = []

try {
  section(`§1 every command Sovereign runs, Flow runs — except the ones the five name (${commands.length} corpus commands)`)
  for (const command of commands) {
    const sovereign = (await kit.decide(command, { mode: 'sovereign', road: 'hosted' })).decision
    const flow = (await kit.decide(command, { mode: 'flow', road: 'hosted' })).decision
    const ask = await kit.flowShellAsk(command)
    const row: Row = { command, sovereign: sovereign.behavior, flow: flow.behavior, message: flow.message ?? '', item: ask?.item ?? null }
    rows.push(row)
    if (sovereign.behavior === 'allow' && flow.behavior === 'allow') continue
    if (sovereign.behavior === 'deny' && flow.behavior === 'deny') continue
    if (sovereign.behavior === 'allow' && flow.behavior === 'ask' && row.item !== null && row.message.startsWith('Flow asks before ')) {
      exceptions.push(row)
      continue
    }
    breaks.push(row)
  }
  const allowedByBoth = rows.filter(row => row.sovereign === 'allow' && row.flow === 'allow').length
  const deniedByBoth = rows.filter(row => row.sovereign === 'deny' && row.flow === 'deny').length
  console.log(`  ${allowedByBoth} run in both · ${deniedByBoth} refused in both · ${exceptions.length} Flow asks · ${breaks.length} disagreements`)
  for (const row of exceptions) console.log(`  item ${row.item} · ${j(row.command).slice(0, 90)} → ${row.message}`)
  for (const row of breaks) console.log(`  BREAK · sovereign ${row.sovereign} · flow ${row.flow} · ${j(row.command).slice(0, 90)} → ${row.message}`)
  check('no command Sovereign runs is refused or left unexplained by Flow', breaks.length === 0, j(breaks.slice(0, 5)))
  check('every Flow ask is one of the five and says so in its first words', exceptions.every(row => row.item !== null && [1, 2, 3, 4].includes(row.item) && /^Flow asks before .+: .+\.$/.test(row.message)), j(exceptions.filter(row => row.item === null).slice(0, 5)))
  check('the exceptions are a short list, not the corpus (under 5 in 100)', exceptions.length * 20 < commands.length, `${exceptions.length} of ${commands.length}`)
  check('Flow runs more than 95 in 100 of what Sovereign runs', allowedByBoth * 100 >= 95 * rows.filter(row => row.sovereign === 'allow').length, `${allowedByBoth} of ${rows.filter(row => row.sovereign === 'allow').length}`)
  const byItem = exceptions.reduce<Record<string, number>>((acc, row) => ({ ...acc, [String(row.item)]: (acc[String(row.item)] ?? 0) + 1 }), {})
  console.log(`  exceptions by item: ${j(byItem)}`)

  section('§2 a deny rule and an ask rule hold in Flow as in Default; Sovereign\'s road is untouched by this lane')
  const denied = await kit.decide('npm test', { mode: 'flow', rules: { deny: ['Bash(npm test)'] } })
  check('Flow: a deny rule refuses npm test', denied.decision.behavior === 'deny' && denied.decision.decisionReason?.type === 'rule', j(denied.decision))
  const asked = await kit.decide('npm test', { mode: 'flow', rules: { ask: ['Bash(npm test)'] } })
  check('Flow: an ask rule asks for npm test in the rule\'s words', asked.decision.behavior === 'ask' && asked.decision.decisionReason?.type === 'rule' && asked.wrapper.decidedBy === 'flowFloors', j(asked.decision))
  const plain = await kit.decide('npm test', { mode: 'flow' })
  check('Flow: npm test with no rule runs, decided by flowAllow with the mode as its reason', plain.decision.behavior === 'allow' && plain.wrapper.decidedBy === 'flowAllow' && plain.decision.decisionReason?.type === 'mode' && plain.decision.decisionReason.mode === 'flow', j(plain))
} finally {
  kit.close()
}
finish('prove-flow-sovereign-parity')
