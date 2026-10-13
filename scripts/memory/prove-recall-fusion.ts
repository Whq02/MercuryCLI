import { fuseRankings, rankAllCandidates, rankCandidates } from '../../src/mneme/mnemeLookup.js'

let failures = 0
function check(label: string, holds: boolean, detail: unknown = ''): void {
  console.log(`[${holds ? 'PASS' : 'FAIL'}] ${label}${holds ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!holds) failures++
}
check('rank fusion rewards agreement between competing orders', JSON.stringify(fuseRankings([['a', 'b', 'c'], ['c', 'b', 'd']])) === JSON.stringify(['c', 'b', 'a', 'd']))
check('the first ranking resolves equal reciprocal scores', JSON.stringify(fuseRankings([['b', 'a'], ['a', 'b']])) === JSON.stringify(['b', 'a']))
check('duplicates within one ranking receive only one vote', JSON.stringify(fuseRankings([['a', 'a', 'a', 'b'], ['b', 'a']])) === JSON.stringify(['a', 'b']))
check('rank fusion accepts an empty or a third ranking', fuseRankings([]).length === 0 && fuseRankings([['a', 'b'], ['b', 'a'], ['b']])[0] === 'b')
check('a supplied zero offset uses one-based ranks', JSON.stringify(fuseRankings([['a', 'b', 'c'], ['c', 'b', 'd']], 0)) === JSON.stringify(['c', 'a', 'b', 'd']))
for (const k of [-1, NaN, Infinity]) {
  let rejected = false
  try { fuseRankings([['a']], k) } catch (error) { rejected = error instanceof RangeError }
  check(`invalid offset is rejected: ${k}`, rejected)
}
const pool = [
  { id: 'seq:1', seq: 1, text: 'quartz quartz quartz', signature: '', slug: 'ranking', pagePath: 'ranking', pending: false },
  { id: 'seq:2', seq: 2, text: 'quartz quartz filler', signature: '', slug: 'ranking', pagePath: 'ranking', pending: false },
  { id: 'seq:3', seq: 3, text: 'quartz filler filler', signature: '', slug: 'ranking', pagePath: 'ranking', pending: false },
  { id: 'seq:4', seq: 4, text: 'amber filler filler', signature: '', slug: 'ranking', pagePath: 'ranking', pending: false },
]
const plain = rankCandidates('quartz', pool)
const usage = { '2': { last: '', count: 10 }, '3': { last: '', count: 20 }, '4': { last: '', count: 100 } }
const used = rankCandidates('quartz', pool, { usage })
const expected = fuseRankings([plain.map(hit => hit.id), ['seq:3', 'seq:2', 'seq:1']])
check('past use is a ranking, not just a score tie-break', JSON.stringify(used.map(hit => hit.id)) === JSON.stringify(expected) && used[1]?.id !== plain[1]?.id, used.map(hit => hit.id))
check('past use cannot introduce an unmatched record', used.every(hit => hit.id !== 'seq:4'))
check('exclusions apply before rank fusion', !rankCandidates('quartz', pool, { usage, exclude: new Set(['seq:2']) }).some(hit => hit.id === 'seq:2'))
const large = Array.from({ length: 35 }, (_, i) => ({ ...pool[0]!, seq: i + 10, id: `seq:${i + 10}` }))
large.push(pool[3]!)
check('the unlimited seam preserves all matches for the final partition', rankAllCandidates('quartz', large).length === 35)
check('the bounded road keeps its default and maximum', rankCandidates('quartz', large).length === 5 && rankCandidates('quartz', large, { limit: 100 }).length === 20)
check('an absent second ranking does not change the first', JSON.stringify(fuseRankings([[], ['a', 'b']])) === JSON.stringify(['a', 'b']))
console.log(failures ? `FAIL: ${failures} recall fusion checks` : 'PASS: recall fusion checks')
process.exitCode = failures ? 1 : 0
