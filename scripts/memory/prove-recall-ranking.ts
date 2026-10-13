import { readFileSync } from 'node:fs'
import { lookupTokens, rankCandidates, type LookupCandidate } from '../../src/mneme/mnemeLookup.js'

let failures = 0
function check(label: string, holds: boolean, detail: unknown = ''): void {
  console.log(`[${holds ? 'PASS' : 'FAIL'}] ${label}${holds ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!holds) failures++
}
const rows = JSON.parse(readFileSync(new URL('./fixtures/ranking/entries.json', import.meta.url), 'utf8')) as Array<{ seq: number; text: string; time: string }>
const pool: LookupCandidate[] = rows.map(row => ({
  id: `seq:${row.seq}`, text: row.text, signature: `<seq=${row.seq}, time=${row.time}, source=proof>`,
  slug: 'ranking', pagePath: 'topic-ranking.md', seq: row.seq, pending: false,
}))

for (const forms of [
  ['deploy', 'deployed', 'deploying', 'deployment'],
  ['check', 'checked', 'checking', 'checks'],
  ['run', 'running'],
  ['rotate', 'rotated', 'rotating'],
  ['try', 'tried', 'tries', 'trying'],
]) {
  const stems = forms.map(word => lookupTokens(word).join(' '))
  check(`word forms share one stem: ${forms.join(', ')}`, new Set(stems).size === 1, stems)
}
for (const word of ['deploy.ts', 'src/deploying', 'deploy-worker', 'deployed2', 'deploy_worker']) {
  check(`identifier stays intact: ${word}`, lookupTokens(word)[0] === word)
}
check('query terms keep the stop-word and count rules', lookupTokens('the and are work 123').length === 0 && lookupTokens(Array.from({ length: 30 }, (_, i) => `term${i}`).join(' ')).length === 16)
check('deploying finds deployed and deployment', JSON.stringify(rankCandidates('deploying', pool).map(hit => hit.id).sort()) === JSON.stringify(['seq:1', 'seq:2']))
check('a universal term remains nondiscriminating', rankCandidates('service', pool).length === 0)
check('one exact hit from a year ago is still returned', rankCandidates('quartzlantern', pool)[0]?.id === 'seq:3')
check('one row alone can match', rankCandidates('deploying', pool.slice(0, 1))[0]?.id === 'seq:1')
check('lookup output keeps its existing fields', JSON.stringify(Object.keys(rankCandidates('quartzlantern', pool)[0] ?? {}).sort()) === JSON.stringify(['id', 'matched', 'pagePath', 'pending', 'score', 'seq', 'signature', 'slug', 'text']))
const candidate = (id: number, text: string): LookupCandidate => ({ ...pool[0]!, id: `seq:${id}`, seq: id, text })
const frequencyPool = [candidate(10, 'quartz filler filler filler'), candidate(11, 'quartz quartz filler filler'), candidate(12, 'quartz quartz quartz filler'), candidate(13, 'amber filler filler filler')]
const frequencyHits = rankCandidates('quartz', frequencyPool)
const scores = frequencyPool.slice(0, 3).map(c => frequencyHits.find(hit => hit.id === c.id)!.score)
check('term frequency saturates instead of multiplying without bound', scores[1]! > scores[0]! && scores[2]! > scores[1]! && scores[2]! - scores[1]! < scores[1]! - scores[0]!, scores)
check('BM25 uses the expected IDF and saturation', Math.abs(scores[1]! - Math.log(1 + 1.5 / 3.5) * 2 * 2.2 / 3.2) < 1e-12, scores[1])
const lengthHits = rankCandidates('quartz', [candidate(20, 'quartz short'), candidate(21, 'quartz short filler filler filler filler'), candidate(22, 'amber short')])
check('token length normalises longer documents', lengthHits[0]?.id === 'seq:20')
check('characters do not substitute for token length', rankCandidates('quartz', [candidate(23, 'quartz abc'), candidate(24, 'quartz abcdefghijklmnop'), candidate(25, 'amber short')]).every((hit, _, hits) => Math.abs(hit.score - hits[0]!.score) < 1e-12))
check('identifier boundaries do not admit a prefix match', rankCandidates('src/deploy', [candidate(26, 'src/deploying')]).length === 0)
check('candidate tokens are not truncated to the query budget', rankCandidates('quartz', [candidate(27, `${'filler '.repeat(20)}quartz`), candidate(28, 'amber')])[0]?.id === 'seq:27')
const now = Date.parse('2026-10-13T00:00:00.000Z')
const dated = [
  { ...candidate(30, 'quartz certificates'), time: rows[0]!.time },
  { ...candidate(31, 'quartz certificates'), time: rows[1]!.time },
  { ...candidate(32, 'amber certificates'), time: rows[3]!.time },
]
const recent = rankCandidates('quartz', dated, { now })
check('last week outranks three months ago despite the older sequence', recent[0]?.id === 'seq:30')
check('the recency multiplier follows the ninety-day exponential', Math.abs(recent[0]!.score / recent[1]!.score - Math.exp(85 / 90)) < 1e-12)
const yearOld = rankCandidates('quartzlantern', pool.map((c, i) => ({ ...c, time: rows[i]!.time })), { now })
check('a decayed year-old exact match remains positive and findable', yearOld[0]?.id === 'seq:3' && yearOld[0]!.score > 0)
const pinned = rankCandidates('quartz', dated.map(c => ({ ...c, pinned: c.seq === 31 })), { now })
check('pins do not decay', pinned[0]?.id === 'seq:31')
const pending = { ...dated[0]!, id: 'pending:2026-10-13T00:00:00.000Z', seq: undefined, pending: true, time: '2026-10-13T00:00:00.000Z' }
check('pending observations rank beside facts using their own timestamp', rankCandidates('quartz', [...dated, pending], { now })[0]?.id === pending.id)
const invalid = rankCandidates('quartz', [{ ...dated[0]!, time: 'unknown' }, { ...dated[1]!, time: '2026-10-14T00:00:00.000Z' }, dated[2]!], { now })
check('unknown and future dates do not invent an age or a boost', invalid.length === 2 && invalid[0]!.score === invalid[1]!.score)
check('numerical underflow never removes an otherwise matching old record', rankCandidates('quartz', [{ ...dated[0]!, time: '0001-01-01T00:00:00.000Z' }], { now })[0]?.id === 'seq:30')
console.log(failures ? `FAIL: ${failures} recall ranking checks` : 'PASS: recall ranking checks')
process.exitCode = failures ? 1 : 0
