#!/usr/bin/env bun
// ============================================================================
//  scripts/harness-profiles/prove-ch6-close-sweep.ts — the CH-6 structural sweep:
//  §A CH-05 — the harness estate introduces NO second provider loop, query
//     loop, task router, project scanner, outcome store, or evaluator
//     (mechanical: the estate's imports and syscall surface);
//  §B CH-08 — the invariant floor is OUTSIDE profile control mechanically
//     (no forbidden-axis field names in the axes contract; the behaviour
//     floor type carries no harness field; the dependency points one way);
//  §C CH-29 — explicit bounds on every harness store (the resolution cache,
//     the receipt ring, the epoch-scoped history contract, the ledger's own
//     line/byte caps);
//  §D CH-37 — no second-domain owner (the estate never imports
//     the transition/replay/context/activity/reconnect/cap writers);
//  §E — the history spine: the router's own sample floor imported (never a
//     private constant), the four history reason codes in the closed tuple,
//     the epoch-scoped input contract (the qualified-selection branch stays
//     structurally dormant while zero qualified profiles exist — activation
//     requires the predeclared holdout process; recorded in the record);
//  §F CH-10 — task facts: the resolver's typed taskFactsDigest input folds
//     into factsDigest; the ONLY live task-facts consumer (the campaign)
//     draws from the bounded corpus owner with digests; live sessions pass
//     typed null (absence, never a keyword guess).
// ============================================================================
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
// Field names + type literals ONLY — comments stripped (the axes comments
// STATE the untouchability laws; the law text must not trip its own gate).
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
// IMPORT lines only — the estate's comments may NAME the owners it stays
// out of; naming the boundary is not crossing it.
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
