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
console.log(failures ? `FAIL: ${failures} recall ranking checks` : 'PASS: recall ranking checks')
process.exitCode = failures ? 1 : 0
