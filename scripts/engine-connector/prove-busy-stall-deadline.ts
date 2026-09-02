#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '../../src/services/engine-connector/daemonConnector.ts'), 'utf8')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

t('the busy write arms/touches the stall deadline', /this\.factsBusy = next\.busy\n\s*if \(next\.busy\) this\.armBusyStall\(\)/.test(src))
t('…and the busy fall disarms it', /else this\.disarmBusyStall\(\)/.test(src))
t('the deadline rides the one primitive with a named seam', src.includes("armInactivityDeadline({") && src.includes("seam: 'engine-connector.factsBusy'"))
t('expiry probes the truth owner (session-facts)', /probeStalledTurn[\s\S]{0,400}action: 'session-facts'/.test(src))
t("a refusal or unreachable daemon settles the view idle", src.includes('settleStalledTurn') && /settleStalledTurn[\s\S]{0,400}this\.factsBusy = false\n\s*this\.recomputeLive\(\)/.test(src))
t('a live answer re-arms instead of condemning', /r\.outcome !== 'refused'[\s\S]{0,300}this\.armBusyStall\(\)/.test(src))
t('detach disarms (no timer outlives the connector)', /detach\(\): void \{\n\s*this\.disarmBusyStall\(\)/.test(src))

console.log(failures === 0 ? 'BUSY STALL DEADLINE: ALL PASS' : 'BUSY STALL DEADLINE: RED')
process.exit(failures)
