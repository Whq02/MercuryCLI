import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './support.ts'

const paths = git('ls-files', '-z').split('\0').filter(path => path.startsWith('scripts/visual-contract/baselines/') && path.endsWith('.json'))
const rows = paths.map(path => [path, 'scripts/visual-contract/baseline-capture.ts', '//  scripts/visual-contract/baseline-capture.ts — R0: the BEFORE', '//  NOT a pool prover — a deliberate capture tool, the INTERVIEW'])
rows.push(['scripts/critters/fixtures/zzz-frames.json', 'scripts/critters/prove-critter-sleep.ts', "t.check('poison control: every clam frame DIFFERS from the base (the A/B is not vacuous)'", 'const current = await composeZzzFrames(process.cwd())'])
writeFileSync(join(import.meta.dir, 'frames-historical.tsv'), ['path\tprover\tdeclaration\tcaller', ...rows.map(row => row.join('\t'))].join('\n') + '\n')
console.log(`[PASS] ${rows.length} explicit historical frame records`)
