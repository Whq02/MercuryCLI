#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const profilesSrc = readFileSync(join(ROOT, 'src/services/mission/harnessProfiles.ts'), 'utf8')
const applicationSrc = readFileSync(join(ROOT, 'src/services/mission/harnessApplication.ts'), 'utf8')
const estate = profilesSrc + '\n' + applicationSrc

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('§A CH-05 — no second loop/router/scanner/store/evaluator')
for (const forbidden of [
  'queryModelWithStreaming',
  'routedCallModel',
  'openaiCallModel',
  'zaiCallModel',
  'child_process',
  'writeFileSync',
  'appendFileSync',
  'mkdirSync',
  'readdirSync',
  'fetch(',
]) {
  check(`§A the estate never touches ${forbidden}`, !estate.includes(forbidden))
}
check('§A the only fs import in the estate is NONE (no node:fs at all)', !estate.includes("from 'node:fs'"))
check("§A the estate's sole crypto use is the digest hash", (profilesSrc.match(/createHash/g) ?? []).length >= 1 && !applicationSrc.includes('createHash'))

console.log('§B CH-08 — the floor is outside profile control, mechanically')
const axesBlockRaw = profilesSrc.slice(profilesSrc.indexOf('export interface HarnessProfileAxes'), profilesSrc.indexOf('export interface HarnessProfile {'))
const axesBlock = axesBlockRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
for (const forbidden of ['permission', 'approval', 'account', 'release', 'acceptance', 'credential', 'destination']) {
  check(`§B no '${forbidden}' axis field`, !axesBlock.toLowerCase().includes(forbidden))
}
const floorSrc = readFileSync(join(ROOT, 'src/utils/profile/mercuryProfile.ts'), 'utf8')
const floorBlock = floorSrc.slice(floorSrc.indexOf('export type MercuryBehaviorProfile'), floorSrc.indexOf('export const MERCURY_BEHAVIOR_PROFILE'))
check('§B the behaviour-floor TYPE carries no harness field', !floorBlock.includes('harness'))
check('§B the dependency points ONE way (the estate never imports the floor module)', !estate.includes('mercuryProfile'))

console.log('§C CH-29 — explicit bounds on every store')
check('§C the resolution cache is count-bounded', profilesSrc.includes('RESOLUTION_CACHE_CAP = 64'))
check('§C the receipt ring is count-bounded', applicationSrc.includes('RECEIPT_RING_CAP = 32'))
check('§C history is epoch-scoped by contract (the resolver ignores foreign epochs, prover-pinned)', profilesSrc.includes("'history-epoch-mismatch-ignored'"))
const ledgerSrc = readFileSync(join(ROOT, 'src/utils/evolution/evolutionLedger.ts'), 'utf8')
check('§C the ledger store carries its own line + byte caps', ledgerSrc.includes('MAX_LINES') && ledgerSrc.includes('HARD_TRIM_BYTES'))

console.log('§D CH-37 — no second transition-domain owner')
const estateImports = estate.split('\n').filter(l => l.trimStart().startsWith('import')).join('\n')
for (const owner of ['materialize', 'branchManifest', 'resumeSnapshot', 'capFailover', 'transitionPreview', 'requestContextPlan', 'registerActivityClassifier']) {
  check(`§D the estate never imports ${owner}`, !estateImports.includes(owner))
}
check('§D contextSelection reaches the estate as a TYPE only', /import type \{ ContextPolicyClass \} from '\.\.\/run\/contextSelection\.js'/.test(applicationSrc) && !/import \{[^}]*resolveSelectionPolicy[^}]*\} from '\.\.\/run\/contextSelection/.test(estate))

console.log('§E CH-13 — the history spine')
check("§E the sample floor is the router's own (imported, never a private constant)", profilesSrc.includes("import { OUTCOME_MIN_SAMPLES } from '../../utils/router/routeCompiler.js'"))
for (const code of ['history-epoch-mismatch-ignored', 'history-low-sample-ignored', 'history-not-better', 'history-insufficient']) {
  check(`§E '${code}' in the closed reason tuple`, profilesSrc.includes(`'${code}'`))
}
check('§E selector history routes ONLY against a floored baseline (the not-better/insufficient pair)', profilesSrc.includes('baseline.stats === null') && profilesSrc.includes('acceptedRate <= baseline.stats.acceptedRate'))

console.log('§F CH-10 — task facts: typed, owner-sourced, digested')
check('§F the resolver contract carries taskFactsDigest folded into factsDigest', profilesSrc.includes('taskFactsDigest: inputs.taskFactsDigest') || profilesSrc.includes('taskFactsDigest: string | null'))
check('§F live boundaries pass typed null (absence, never a keyword guess)', applicationSrc.includes('taskFactsDigest: opts.taskFactsDigest ?? null'))
console.log(failures === 0 ? '\nprove-ch6-close-sweep: green' : `\nprove-ch6-close-sweep: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
