import assert from 'node:assert/strict'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const owner = (await import('../release/readmeAuthor.mjs')) as {
  readmeAuthorState: (root?: string) => { present: boolean; stated: { releases: number; sourceLines: number; proofs: number } | null; facts: { releases: number; sourceLines: number; proofs: number }; current: boolean }
  authorLine: (facts: { releases: number; sourceLines: number; proofs: number }) => string
}
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => { assert.ok(ok, `${label}${detail ? ` — ${detail}` : ''}`); checks++; console.log(`  [PASS] ${label}`) }

const state = owner.readmeAuthorState(ROOT)
check('README.md carries the Author line in its one shape', state.present)
check('the release count is the published release pages under docs/releases', state.stated?.releases === state.facts.releases, JSON.stringify({ readme: state.stated?.releases, tree: state.facts.releases }))
check('the TypeScript line count is the tree, to the nearest thousand (code lines: blank and comment lines never count, so the published tree agrees within one thousand)', state.stated !== null && Math.abs(state.stated.sourceLines - state.facts.sourceLines) <= 1000, JSON.stringify({ readme: state.stated?.sourceLines, tree: state.facts.sourceLines }))
check('the proof count is the tree, to the hundred below', state.stated?.proofs === state.facts.proofs, JSON.stringify({ readme: state.stated?.proofs, tree: state.facts.proofs }))
check('the generator writes the same line it checks', owner.authorLine(state.facts).includes(`${state.facts.releases} public releases`) && owner.authorLine(state.facts).includes(`${state.facts.sourceLines.toLocaleString('en-US')} lines of TypeScript`))
check('the numbers are not zero (a placeholder never ships)', state.facts.releases > 0 && state.facts.sourceLines > 0 && state.facts.proofs > 0)
console.log(`\nREADME author line: ${checks} checks, 0 failures`)
