import assert from 'node:assert/strict'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const owner = (await import('../release/readmeAuthor.mjs')) as {
  readmeAuthorState: (root?: string) => { present: boolean; stated: { releases: number } | null; facts: { releases: number }; current: boolean }
  authorLine: (facts: { releases: number }) => string
}
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => { assert.ok(ok, `${label}${detail ? ` — ${detail}` : ''}`); checks++; console.log(`  [PASS] ${label}`) }

const state = owner.readmeAuthorState(ROOT)
check('README.md carries the Author line in its one shape: the release count ends the sentence', state.present, 'run node scripts/release/readmeAuthor.mjs write, or restore the sentence the generator matches')
check('the release count is the published release pages under docs/releases', state.stated?.releases === state.facts.releases, JSON.stringify({ readme: state.stated?.releases, tree: state.facts.releases }))
check('the generator writes the same line it checks', owner.authorLine(state.facts).endsWith(`this release, ${state.facts.releases} public releases.`), owner.authorLine(state.facts))
check('the number is not zero (a placeholder never ships)', state.facts.releases > 0)
console.log(`\nREADME author line: ${checks} checks, 0 failures`)
