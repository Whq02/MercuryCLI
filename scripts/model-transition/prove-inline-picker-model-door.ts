#!/usr/bin/env bun
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
