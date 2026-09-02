#!/usr/bin/env bun
// ============================================================================
//  prove-inline-picker-model-door — the inline model picker (alt+p, the
//  command-palette row, the usage handoff/offer tail) switches a
//  daemon-hosted chat through the session's OWN model door
//  (release-hardening audit rank 23).
//
//  The gap: applyModelSelection settled every pick into the SCREEN
//  process's state (settleModelSelection → setAppState patch) and never
//  called getFocusedSessionConnector().setModel — while both /model
//  surfaces route a daemon-hosted chat through that door. A toast said
//  "Set model to <name>" and the persisted setting was rewritten, but the
//  session ran its previous model for every following message; a
//  cross-provider pick sent the next turns to the old provider with its
//  spend and usage window; a mid-turn pick parked in the screen's slot and
//  was "applied" at the screen's boundary without the session hearing of
//  it. The read side of the same component already resolves the session's
//  facts through the connector (the composer chip disagreed at once) —
//  the asymmetry was confined to the write.
//
//  This is a structural ratchet (the component needs a driven journey to
//  exercise, and journeys ride the PTY window): it pins the daemon arm's
//  presence, its receipt handling, its position ahead of the screen-state
//  settlement, and the /model surfaces' unchanged door — every needle
//  proven present, ordering compared on found indices only.
//
//  PROVE_SRC names another checkout's src (the A/B control: against the
//  pre-fix tree L1 and L2 read red).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const promptInput = readFileSync(join(SRC, 'components/PromptInput/PromptInput.tsx'), 'utf8')
const applyAt = promptInput.indexOf('const applyModelSelection = (value: string | null): void => {')
const nextFnAt = promptInput.indexOf('const handleModelSelect', applyAt)
const apply = applyAt >= 0 && nextFnAt > applyAt ? promptInput.slice(applyAt, nextFnAt) : ''

console.log('L1 the apply tail routes a daemon-hosted chat through the connector door')
check('the apply tail exists', apply.length > 0, `applyAt=${applyAt} nextFnAt=${nextFnAt}`)
check('it gates on the daemon carrier', apply.includes("focused.carrier === 'daemon'"))
check('it calls the session model door', apply.includes('focused.setModel(value)'))
check("a refusal is painted with the door's own detail", apply.includes("receipt.state === 'refused'") && apply.includes('receipt.detail'))
check('a busy session parks through the door (queued receipt handled)', apply.includes("receipt.state === 'queued'"))
check('a no-op is answered without a false switch claim', apply.includes("receipt.state === 'no-op'"))
check("the loss note rides the SESSION's effective model", apply.includes('focused.modelFacts().effective'))

console.log('L2 the screen-state settlement stays, behind the door')
{
  const doorAt = apply.indexOf('focused.setModel(value)')
  const settleAt = apply.indexOf('settleModelSelection(')
  check('the screen settlement owner is still present (the no-chat case owns it)', settleAt >= 0)
  check('the daemon arm sits ahead of the screen settlement', doorAt >= 0 && settleAt >= 0 && doorAt < settleAt, `door=${doorAt} settle=${settleAt}`)
  const returnBeforeSettle = apply.slice(doorAt, settleAt)
  check('the daemon arm returns before the screen settlement can run', doorAt >= 0 && settleAt >= 0 && returnBeforeSettle.includes('return'))
}

console.log('L3 the two /model surfaces still ride the same door (the shape this fix mirrors)')
{
  const mercuryModel = readFileSync(join(SRC, 'commands/model/mercuryModel.tsx'), 'utf8')
  const modelTsx = readFileSync(join(SRC, 'commands/model/model.tsx'), 'utf8')
  check('mercuryModel.tsx routes the daemon carrier through setModel', mercuryModel.includes("focused.carrier === 'daemon'") && mercuryModel.includes('focused.setModel('))
  check('model.tsx rides the door too', modelTsx.includes('focused.setModel('))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
