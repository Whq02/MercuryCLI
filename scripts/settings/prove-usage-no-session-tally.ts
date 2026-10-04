#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

console.log('§1 the usage popup carries no session tally line')
const usage = read('src/components/Settings/Usage.tsx')
check('no slot spells a "This session" line', !usage.includes("'This session"))
check('the screen-ledger tally is gone from the popup (no spendLine, no 0-tokens word)', !usage.includes('spendLine(') && !usage.includes('0 tokens'))
check('the scheduled and advisor workload lines keep their own labels', usage.includes("SCHEDULED_SPEND_LABEL = 'Scheduled'") && usage.includes("ADVISOR_SPEND_LABEL = 'Advisor'") && usage.includes('function workloadLines('))
check('an inactive slot still says it is not the billing source', usage.includes("INACTIVE_SLOT_LINE = 'not the active billing source this session'") && usage.includes('if (!active) return <Text dimColor>{INACTIVE_SLOT_LINE}</Text>'))
const words = JSON.parse(read('scripts/settings/usage-popup-words.json')) as Record<string, string[]>
check('the recorded popup words carry no session tally', Object.values(words).every(runs => runs.every(run => !run.startsWith('This session'))))

console.log('§2 the status bar and the rail read the focused session\'s facts for tokens and spend')
const frame = read('src/components/MercuryFrame.tsx')
const rail = read('src/components/HelmLanesRail.tsx')
check('the frame\'s spend is the focused session\'s usage facts', frame.includes('const usageFacts = getFocusedSessionConnector().usage()') && frame.includes('const cost = usageFacts.totalCostUSD'))
check('the frame never reads the screen\'s own cost ledger for the session figure', !frame.includes('getTotalCostUSD()') && !frame.includes('getModelUsage()'))
check('the lanes rail\'s glance spend is the focused session\'s usage facts', rail.includes('const focusedUsage = getFocusedSessionConnector().usage()') && rail.includes('const focusedSpendUSD = focusedUsage.totalCostUSD'))
check('the lanes rail never reads the screen\'s own cost ledger for the glance', !rail.includes('getTotalCostUSD()') && !rail.includes('getModelUsage()'))
const types = read('src/services/engine-connector/types.ts')
check('the facts carry the totals the bar and the rail show', ['totalCostUSD: number', 'totalInputTokens: number', 'totalOutputTokens: number', 'totalCacheReadInputTokens: number', 'unpricedTurns?: number'].every(f => types.includes(f)))
const print = read('src/cli/print.ts')
check('the runner answers those totals from its own ledger', print.includes('totalCostUSD: getTotalCostUSD(),') && print.includes('totalInputTokens: getTotalInputTokens(),') && print.includes('unpricedTurns: getTotalUnpricedTurns(),'))

console.log(`\n${failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAILURE(S)`} — prove-usage-no-session-tally`)
process.exit(failures === 0 ? 0 : 1)
