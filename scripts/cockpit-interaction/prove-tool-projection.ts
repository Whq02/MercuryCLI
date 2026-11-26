#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  MERCURY_DEMO: false,
}

const { checker } = await import('../engine-durability/harness.ts')
const {
  EMPTY_FACETS,
  facetsSatisfy,
  parseSearchQuery,
  renderableSearchText,
  toolInputFiles,
} = await import('../../src/screen/virtual-message-list/transcriptSearch.ts')

const t = checker()

  t.section('§3 — the operators')
  {
    const plain = parseSearchQuery('timeout')
    t.check('plain text stays plain text', plain.text === 'timeout' && !plain.structured, JSON.stringify(plain))

    const byTool = parseSearchQuery('tool:Bash')
    t.check('tool: filters by tool', byTool.tools.join() === 'bash' && byTool.structured, JSON.stringify(byTool))
    t.check('and leaves no free text behind', byTool.text === '', `"${byTool.text}"`)

    const byFile = parseSearchQuery('file:Chat.tsx timeout')
    t.check('file: filters by path', byFile.files.join() === 'chat.tsx', JSON.stringify(byFile))
    t.check('and keeps the free text beside it', byFile.text === 'timeout', byFile.text)

    const failed = parseSearchQuery('failed:')
    t.check('failed: is a filter on its own', failed.failedOnly && failed.text === '', JSON.stringify(failed))

    const combined = parseSearchQuery('tool:Bash failed: npm')
    t.check(
      'and they compose — "rows where Bash failed, mentioning npm"',
      combined.tools.join() === 'bash' && combined.failedOnly && combined.text === 'npm',
      JSON.stringify(combined),
    )

    const quoted = parseSearchQuery('file:"my dir/App Kit.tsx" crash')
    t.check(
      'a quoted file: value spans spaces as ONE filter',
      quoted.files.join() === 'my dir/app kit.tsx' && quoted.text === 'crash',
      JSON.stringify(quoted),
    )
    const repeated = parseSearchQuery('tool:bash tool:grep')
    t.check(
      'repeated operators COMBINE — both must match, neither silently wins',
      repeated.tools.join(',') === 'bash,grep',
      JSON.stringify(repeated.tools),
    )
    const unterminated = parseSearchQuery('file:"my dir')
    t.check(
      'an unterminated quote is text mid-keystroke, not a filter on everything',
      !unterminated.structured && unterminated.text === 'file:"my dir',
      JSON.stringify(unterminated),
    )

    const colonText = parseSearchQuery('TODO: fix this')
    t.check(
      'an unrecognized word: stays searchable — TODO: still finds TODO:',
      colonText.text === 'todo: fix this' && !colonText.structured,
      JSON.stringify(colonText),
    )
    const bare = parseSearchQuery('tool:')
    t.check(
      'and a half-typed operator is text, not a filter on everything',
      !bare.structured && bare.text === 'tool:',
      JSON.stringify(bare),
    )
    const spaced = parseSearchQuery('  a  b ')
    t.check(
      'whitespace in a plain query survives verbatim',
      spaced.text === '  a  b ' && !spaced.structured,
      JSON.stringify(spaced.text),
    )

    const facets = { tools: ['Bash'], files: ['/repo/src/Chat.tsx'], failed: true }
    t.check('tool: matches its tool', facetsSatisfy(facets, parseSearchQuery('tool:bash')), 'hit')
    t.check('and rejects another', !facetsSatisfy(facets, parseSearchQuery('tool:grep')), 'miss')
    t.check('file: matches a path substring', facetsSatisfy(facets, parseSearchQuery('file:Chat')), 'hit')
    t.check('failed: matches a failure', facetsSatisfy(facets, parseSearchQuery('failed:')), 'hit')
    t.check(
      'repeated tool: is AND at the row — one present, one absent = no match',
      !facetsSatisfy(facets, parseSearchQuery('tool:bash tool:grep')) &&
        facetsSatisfy({ ...facets, tools: ['Bash', 'Grep'] }, parseSearchQuery('tool:bash tool:grep')),
      'both must be on the row',
    )
    t.check(
      'and a SUCCESS is excluded from failed:',
      !facetsSatisfy({ ...facets, failed: false }, parseSearchQuery('failed:')),
      'miss',
    )
    t.check(
      'a caller with no facets answers no operator — honest, never a false hit',
      !facetsSatisfy(EMPTY_FACETS, parseSearchQuery('tool:bash')),
      'no phantom',
    )

    t.check(
      'file paths come off the fields tools actually declare',
      toolInputFiles({ file_path: '/a/b.ts' }).join() === '/a/b.ts' &&
        toolInputFiles({ files: ['x', 'y'] }).join() === 'x,y' &&
        toolInputFiles({ command: 'rm -rf /' }).length === 0,
      'allowlisted',
    )
  }

  t.section('§4 — the wiring: one projection, one source of "failed"')
  {
    const { DocumentTool } = await import('../../src/tools/document/DocumentTool.ts')
    const documentResult = { op: 'inspect', road: 'pdf', files: [{ path: '/reports/quarterly-summary.pdf', bytes: 1024, sha256: 'ab' }], detail: 'twelve pages, two tables' }
    const resultRow = (id: string) => ({ type: 'user', uuid: `u-${id}`, timestamp: new Date(0).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: documentResult }) as unknown as Parameters<typeof renderableSearchText>[0]
    const through = renderableSearchText(resultRow('doc-1'), id => (id === 'doc-1' ? DocumentTool : undefined))
    t.check(
      'a Document result row is searchable by its file path and its detail through the tool\'s own extractor',
      through.includes('quarterly-summary.pdf') && through.includes('twelve pages'),
      JSON.stringify(through),
    )
    const fallbackOnly = renderableSearchText(resultRow('doc-2'))
    t.check(
      'the duck-type fallback alone reads none of Document\'s fields — the extractor is the road, not decoration',
      !fallbackOnly.includes('quarterly-summary.pdf') && !fallbackOnly.includes('twelve pages'),
      JSON.stringify(fallbackOnly),
    )
    const quiet = renderableSearchText(resultRow('doc-3'), () => ({ name: 'Monitor', extractSearchText: () => 'never indexed' }))
    t.check('a non-indexing tool contributes no search text even with an extractor', quiet === '', JSON.stringify(quiet))
    const { highlightTextOf } = await import('../../src/screen/chat/useChatSearch.tsx')
    const highlighted = ['', 'gate verdict', 'tool:bash verdict', 'file:src/a.ts tool:"Read" failed: build ok', 'failed:'].map(query => highlightTextOf(query))
    t.check(
      'every HIGHLIGHT call either clears or routes through the query parser',
      highlighted.join('|') === '|gate verdict|verdict|build ok|',
      highlighted.join('|'),
    )
    t.check(
      'so an operator token is never inverse-highlighted as content',
      highlighted.every(text => !/\b(?:tool|file|failed):/.test(text)),
      highlighted.join('|'),
    )
  }

t.finish('prove-tool-projection')
export {}
