#!/usr/bin/env bun
// ============================================================================
//  prove-busy-stall-deadline — the chat's turn indicator cannot spin forever.
//
//  The class (spun-a-core-forever, one layer up): factsBusy is ENTERED by a
//  remote fact and was LEFT only by another — a dead runner's last write
//  said busy and nothing ever said otherwise; the facts feed cannot tell a
//  stopped writer from an idle one. The board already tells a dead runner
//  (runnerRecordAlive); the chat could not. The law: every wait that can
//  only be left by a remote fact carries an inactivity deadline with a
//  typed expiry — on expiry, ONE bounded probe at the truth's owner
//  (session-facts: its 'unknown-session' refusal IS the dead-runner
//  verdict); dead or unreachable settles the live view idle; a live
//  runner's answer ticks the feed and re-arms (alive-but-slow keeps its
//  honest spinner; wedged-but-alive is re-probed, never condemned).
//
//  Structural pins over the connector (the full drive — a real dead runner
//  under a live chat — is a pool journey).
// ============================================================================
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
