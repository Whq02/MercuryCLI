import assert from 'node:assert/strict'
import { ISSUE_FORMS, ISSUE_FORM_URL_CAP, URL_CUT_NOTE, composeIssueBody, fullIssueTitle, issueFormUrl } from '../../src/commands/feedback/issueForms.ts'

let failures = 0
function check(label: string, run: () => void): void {
  try { run(); console.log('PASS ' + label) } catch (error) { failures++; console.error('FAIL ' + label + ': ' + String(error)) }
}
check('a Unicode title never ends in an unmatched surrogate', () => {
  const title = fullIssueTitle(ISSUE_FORMS.bug, '\u{1f600}'.repeat(200))
  assert.doesNotThrow(() => issueFormUrl(ISSUE_FORMS.bug, { slug: 'example/project', title, values: {} }))
  assert(!title.includes('\ufffd'))
})
for (const symbol of ['é', '中', '\u{1f600}']) {
  check(`truncated ${symbol.codePointAt(0)} fields decode as whole Unicode characters`, () => {
    for (let padding = 0; padding < 12; padding++) {
      const link = issueFormUrl(ISSUE_FORMS.bug, { slug: 'example/project', title: '[bug] ' + 'x'.repeat(padding), values: { steps: symbol.repeat(9000) } })
      assert(link.length <= ISSUE_FORM_URL_CAP)
      const encoded = link.split('&steps=')[1]!.split('&')[0]!
      const text = decodeURIComponent(encoded)
      assert(text.endsWith(URL_CUT_NOTE))
      assert.equal(text.slice(0, -URL_CUT_NOTE.length).split(symbol).join(''), '')
    }
  })
}
check('health evidence cannot close its own code fence', () => {
  const evidence = 'health detail\n````\nnot a new section\n`````\nend'
  const body = composeIssueBody(ISSUE_FORMS.bug, { values: { health: evidence }, recentErrors: [] })
  assert(body.includes('``````text\n' + evidence + '\n``````'))
})
check('ordinary issue words and their link still round-trip unchanged', () => {
  const title = fullIssueTitle(ISSUE_FORMS.bug, '[bug] a short title')
  const link = issueFormUrl(ISSUE_FORMS.bug, { slug: 'example/project', title, values: { steps: 'a & b', actual: 'line 1\nline 2' } })
  const parsed = new URL(link)
  assert.equal(parsed.searchParams.get('title'), '[bug] a short title')
  assert.equal(parsed.searchParams.get('steps'), 'a & b')
  assert.equal(parsed.searchParams.get('actual'), 'line 1\nline 2')
})
process.exit(failures ? 1 : 0)
