#!/usr/bin/env bun
import { vshotBudgetMs } from '../lib/captureDriver.ts'
// ============================================================================
//  scripts/cockpit-interaction/prove-tool-projection.ts — one projection behind the tool
//  surfaces, and a glyph vocabulary no tool can dodge (HZ7, findings
//  and).
//
//  Two failures this exists to prevent, and they are the same failure:
//
//  · A tool ships and nothing tells the eye what KIND of thing it did, so the
//    transcript is a dot column and a wall of names.
//  · A tool ships and nothing declares how its result is INDEXED, so search
//    silently under-reports it — a lie by omission, which is worse than a
//    miss the operator can see.
//
//  Both are closed by TOTALITY over the live tool pool: every registered name
//  has a family, and every registered name either implements
//  `extractSearchText` or is named in NON_INDEXING_TOOLS. A new tool cannot
//  inherit a default quietly; it fails this prover until somebody decides.
//
//    §1 the glyph registry   §2 the projection contract
//    §3 the search operators §4 the wiring   §5 REAL RENDER
//
//  The guarded gap: no toolGlyphs.ts, a projection with no facets
//  and no operators, NON_INDEXING_TOOLS with no owner.
// ============================================================================

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  IS_DEMO: false,
}

const SELF = new URL(import.meta.url).pathname

if (process.env.TOOLGLYPH_RENDER_CHILD) {
  const React = await import('react')
  const { render, Box, Text } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
    Text: React.ComponentType<Record<string, unknown>>
  }
  const { TOOL_FAMILY_MARKS } = await import('../../src/components/mercury-ui/toolGlyphs.js')
  // Render the whole vocabulary once: the assertion is that each mark reaches
  // the grid as exactly one cell, which only a real renderer can answer.
  void render(
    React.createElement(
      Box,
      { flexDirection: 'column' },
      ...Object.entries(TOOL_FAMILY_MARKS).map(([family, mark]) =>
        React.createElement(
          Text,
          { key: family },
          `${mark.glyph}|${mark.fallback}|${family}`,
        ),
      ),
    ),
  )
  setTimeout(() => process.exit(0), 900)
} else {
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { checker } = await import('../engine-durability/harness.ts')
  const {
    TOOL_FAMILY_BY_NAME,
    TOOL_FAMILY_MARKS,
    toolFamilyFor,
    toolMarkFor,
  } = await import('../../src/components/mercury-ui/toolGlyphs.ts')
  const { charWidth, GLYPH } = await import('../../src/components/mercury-ui/glyphs.ts')
  const {
    EMPTY_FACETS,
    facetsSatisfy,
    NON_INDEXING_TOOLS,
    parseSearchQuery,
    toolInputFiles,
  } = await import('../../src/utils/transcriptSearch.ts')

  const t = checker()
  const scratch = mkdtempSync(join(tmpdir(), 'hz-toolproj-'))

  // The pool held by this ratchet is the UNION of three enumerations, because
  // each alone has a hole the re-audit found the hard way:
  //  · the RUNTIME registry (getAllBaseTools) is the truth for what actually
  //    registers — but it is env-gated (win32 shells, availability probes),
  //    so alone it would let a gated tool's classification rot;
  //  · the `TOOL_NAME = '…'` constant sweep sees gated tools — but eight
  //    registered tools declare their name inline and were INVISIBLE to it
  //    while the record claimed totality;
  //  · the inline `name: '…'` sweep (buildTool files only) closes that hole.
  // A name from ANY source must be classified; a table entry in NO source is
  // stale.
  const { getAllBaseTools } = await import('../../src/tools.ts')
  // Two dirs are deliberately outside the pool: `testing/` holds dev-only
  // permission fixtures that never register, and `MCPTool/` is the dynamic
  // dispatch template whose REAL names arrive as `mcp__server__tool` (family
  // external by construction, indexed by the fallback arm).
  const SWEEP_EXCLUDED_DIRS = new Set(['testing', 'MCPTool'])
  const DIR_NAMES = new Map<string, Set<string>>()
  for (const dir of readdirSync('src/tools', { withFileTypes: true })) {
    if (!dir.isDirectory() || SWEEP_EXCLUDED_DIRS.has(dir.name)) continue
    const names = new Set<string>()
    for (const file of readdirSync(join('src/tools', dir.name))) {
      if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
      const src = readFileSync(join('src/tools', dir.name, file), 'utf8')
      for (const m of src.matchAll(/TOOL_NAME = '([A-Za-z]+)'/g)) names.add(m[1]!)
      if (src.includes('buildTool(')) {
        for (const m of src.matchAll(/^\s*name: '([A-Za-z][A-Za-z0-9]*)',?$/gm)) names.add(m[1]!)
      }
    }
    if (names.size > 0) DIR_NAMES.set(dir.name, names)
  }
  // TestingPermissionTool registers ONLY under NODE_ENV=test — which this
  // prover sets for the config gate. A dev fixture is not pool vocabulary.
  const LIVE_TOOLS = getAllBaseTools().filter(tool => tool.name !== 'TestingPermission')
  const LIVE = LIVE_TOOLS.map(tool => tool.name)
  const POOL: string[] = [
    ...new Set([...LIVE, ...[...DIR_NAMES.values()].flatMap(s => [...s])]),
  ].sort()

  // ──────────────────────────────────────────────────────────────────────────
  t.section('§1 — the glyph registry is total, width-stable and not colour-only')
  {
    t.check('the live tool pool was found', POOL.length > 40, `${POOL.length} tools`)
    t.check(
      'the RUNTIME registry is one of its sources — not only a filename convention',
      LIVE.length > 40 && LIVE.every(n => POOL.includes(n)),
      `${LIVE.length} registered live`,
    )
    // The names the convention sweep silently missed while the record claimed
    // totality — pinned so the enumeration can never regress to blind.
    // (Multiplayer left the list with the tool's retirement: a retired name
    // in the pool would be the stale-table defect the checks below forbid.)
    for (const name of ['ReadMcpResourceTool', 'Structure', 'Test', 'Journey', 'Git', 'Browser']) {
      t.check(`${name} is in the ratchet's pool`, POOL.includes(name), 'seen')
    }
    const unclassified = POOL.filter(name => TOOL_FAMILY_BY_NAME[name] === undefined)
    t.check(
      'EVERY registered tool has an authored family — no silent default',
      unclassified.length === 0,
      unclassified.join(', ') || 'total',
    )
    const stale = Object.keys(TOOL_FAMILY_BY_NAME).filter(name => !POOL.includes(name))
    t.check('and the table names no tool that no longer exists', stale.length === 0, stale.join(', ') || 'clean')

    const marks = Object.values(TOOL_FAMILY_MARKS)
    t.check(
      'every family mark is exactly one cell under the canonical width model',
      marks.every(m => charWidth(m.glyph) === 1),
      marks.map(m => `${m.glyph}=${charWidth(m.glyph)}`).join(' '),
    )
    const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u
    t.check('no emoji in the vocabulary', !marks.some(m => EMOJI.test(m.glyph)), 'cell-grid safe')
    t.check(
      'the families are visually DISTINCT — one glyph each',
      new Set(marks.map(m => m.glyph)).size === marks.length,
      `${new Set(marks.map(m => m.glyph)).size}/${marks.length}`,
    )
    t.check(
      'and their text fallbacks are distinct too — the family survives a glyphless profile',
      new Set(marks.map(m => m.fallback)).size === marks.length,
      marks.map(m => m.fallback).join(','),
    )
    // The mark must never be mistaken for the STATE dot: family and status are
    // two independent axes, and a shared shape would collapse them.
    const statusSpine = new Set([
      GLYPH.ok, GLYPH.pending, GLYPH.inProgress, GLYPH.done, GLYPH.read,
      GLYPH.fail, GLYPH.warn, GLYPH.circledBullet, GLYPH.fisheye, GLYPH.diamond,
      GLYPH.cursor, GLYPH.prompt,
    ])
    const collisions = marks.filter(m => statusSpine.has(m.glyph))
    t.check(
      'no family mark collides with the honest-state spine',
      collisions.length === 0,
      collisions.map(m => m.glyph).join(' ') || 'two axes, two vocabularies',
    )
    t.check(
      'tone is a TOKEN ROLE, never a colour literal',
      marks.every(m => ['accent', 'info', 'textSecondary'].includes(m.tone)),
      [...new Set(marks.map(m => m.tone))].join(','),
    )

    // Family assignment reads as an operator would expect.
    t.check('Bash is shell', toolFamilyFor('Bash') === 'shell', toolFamilyFor('Bash'))
    t.check('Grep is search', toolFamilyFor('Grep') === 'search', toolFamilyFor('Grep'))
    t.check('Edit is edit', toolFamilyFor('Edit') === 'edit', toolFamilyFor('Edit'))
    t.check('Agent is delegation', toolFamilyFor('Agent') === 'agent', toolFamilyFor('Agent'))
    t.check(
      'and an MCP tool is external BY CONSTRUCTION — it is somebody else\'s integration',
      toolFamilyFor('mcp__chrome-devtools__click') === 'external',
      toolFamilyFor('mcp__chrome-devtools__click'),
    )
    t.check('every pooled tool resolves a mark', POOL.every(n => toolMarkFor(n).glyph.length > 0), 'total')
  }

  // ──────────────────────────────────────────────────────────────────────────
  t.section('§2 — the projection contract: declared, never forgotten')
  {
    // EXACT per-tool truth for everything registered: the tool object either
    // has the method or it does not. The file sweep serves only the gated
    // names the registry cannot show on this host (PowerShell on darwin,
    // Godot behind its flag) — and a dir-level sweep is deliberately not
    // trusted for LIVE names, where a *_TOOL_NAME constant re-exported into a
    // neighbouring dir once mis-attributed an extractor (re-audit).
    const implementers = new Set<string>(
      LIVE_TOOLS.filter(tool => typeof tool.extractSearchText === 'function').map(tool => tool.name),
    )
    for (const [dirName, names] of DIR_NAMES) {
      let hasExtractor = false
      for (const file of readdirSync(join('src/tools', dirName))) {
        if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
        const src = readFileSync(join('src/tools', dirName, file), 'utf8')
        if (/extractSearchText\s*[(:]/.test(src)) hasExtractor = true
      }
      if (hasExtractor) {
        for (const n of names) if (!LIVE.includes(n)) implementers.add(n)
      }
    }
    t.check('some tools own their own extraction', implementers.size > 0, `${implementers.size}`)
    // The classes the first cut wrote off BY NAME while their renderers paint
    // exactly what an operator searches for — pinned individually so they can
    // never fall back to "nothing to index".
    for (const name of ['Agent', 'Edit', 'PowerShell', 'AskUserQuestion', 'TaskOutput', 'WebFetch', 'LSP', 'ChangeSet', 'Workshop', 'Test', 'Git']) {
      t.check(`${name} owns its extraction — its painted result is findable`, implementers.has(name), 'extracts')
    }

    const undeclared = POOL.filter(
      name => !implementers.has(name) && !NON_INDEXING_TOOLS.has(name),
    )
    t.check(
      'EVERY tool either extracts its own search text or is declared non-indexing',
      undeclared.length === 0,
      undeclared.join(', ') || 'total',
    )
    const bothWays = POOL.filter(name => implementers.has(name) && NON_INDEXING_TOOLS.has(name))
    t.check(
      'and no tool claims both — the declaration is unambiguous',
      bothWays.length === 0,
      bothWays.join(', ') || 'disjoint',
    )
    const ghosts = [...NON_INDEXING_TOOLS].filter(name => !POOL.includes(name))
    t.check(
      'the non-indexing list names no tool that no longer exists',
      ghosts.length === 0,
      ghosts.join(', ') || 'clean',
    )

    const search = readFileSync('src/utils/transcriptSearch.ts', 'utf8')
    t.check(
      'the stale "proper fix is a TODO" note is gone — the contract exists',
      !search.includes('extractSearchText(Out) on the Tool interface (TODO)'),
      'closed',
    )
    t.check(
      'and the duck-type arm says plainly that it is the FALLBACK',
      search.includes('This is the FALLBACK arm, not the contract'),
      'named',
    )
  }

  // ──────────────────────────────────────────────────────────────────────────
  t.section('§3 — the operators')
  {
    const plain = parseSearchQuery('timeout')
    t.check('plain text stays plain text', plain.text === 'timeout' && !plain.structured, JSON.stringify(plain))

    const byTool = parseSearchQuery('tool:Bash')
    t.check('tool: filters by tool', byTool.tools.join() === 'bash' && byTool.structured, JSON.stringify(byTool))
    t.check('and leaves no free text behind', byTool.text === '', `"${byTool.text}"`)

    const byFile = parseSearchQuery('file:REPL.tsx timeout')
    t.check('file: filters by path', byFile.files.join() === 'repl.tsx', JSON.stringify(byFile))
    t.check('and keeps the free text beside it', byFile.text === 'timeout', byFile.text)

    const failed = parseSearchQuery('failed:')
    t.check('failed: is a filter on its own', failed.failedOnly && failed.text === '', JSON.stringify(failed))

    const combined = parseSearchQuery('tool:Bash failed: npm')
    t.check(
      'and they compose — "rows where Bash failed, mentioning npm"',
      combined.tools.join() === 'bash' && combined.failedOnly && combined.text === 'npm',
      JSON.stringify(combined),
    )

    // Re-audit edges, decided rather than inherited: quoted values span
    // spaces; repeated operators AND rather than silently last-winning.
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

    // The trap: an operator grammar must not eat ordinary text.
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
    // And it must not RESHAPE ordinary text either: with no operator present
    // the query is the free text, byte for byte — tokenise-and-rejoin was
    // collapsing space runs and trimming, silently changing what matched
    // (re-audit finding).
    const spaced = parseSearchQuery('  a  b ')
    t.check(
      'whitespace in a plain query survives verbatim',
      spaced.text === '  a  b ' && !spaced.structured,
      JSON.stringify(spaced.text),
    )

    // Facet matching.
    const facets = { tools: ['Bash'], files: ['/repo/src/REPL.tsx'], failed: true }
    t.check('tool: matches its tool', facetsSatisfy(facets, parseSearchQuery('tool:bash')), 'hit')
    t.check('and rejects another', !facetsSatisfy(facets, parseSearchQuery('tool:grep')), 'miss')
    t.check('file: matches a path substring', facetsSatisfy(facets, parseSearchQuery('file:REPL')), 'hit')
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

  // ──────────────────────────────────────────────────────────────────────────
  t.section('§4 — the wiring: one projection, one source of "failed"')
  {
    const list = readFileSync('src/components/VirtualMessageList.tsx', 'utf8')
    t.check('the search path parses operators', /const query = parseSearchQuery\(/.test(list), 'parsed')
    t.check('and filters rows through the facets', list.includes('facetsSatisfy('), 'filtered')
    t.check(
      'a pure filter counts ROWS — non-matching rows are skipped in the count loop',
      /if \(!facets \|\| !facetsSatisfy\(facets, query\)\) continue/.test(list),
      'row-counted',
    )
    const messages = readFileSync('src/components/Messages.tsx', 'utf8')
    t.check('Messages supplies the facets', messages.includes('extractFacets={extractFacets}'), 'supplied')
    t.check(
      'and reads "failed" from the SAME lookups the renderer paints the dot from',
      messages.includes('live.erroredToolUseIDs.has(block.id)') && messages.includes('live.deniedToolUseIDs.has(block.id)'),
      'one truth',
    )
    t.check(
      'the facet cache is regenerated with the lookups — a mid-turn failure cannot be cached away',
      /const facetsCache = useMemo\(\s*\n\s*\(\) => new WeakMap<[^>]+>\(\),\s*\n\s*\[lookups\],/.test(messages),
      'lookups-keyed, not useRef-permanent (re-audit finding)',
    )
    const repl = readFileSync('src/screens/REPL.tsx', 'utf8')
    t.check(
      'every HIGHLIGHT call either clears or routes through the query parser',
      (() => {
        const sites = [...repl.matchAll(/setHighlight\(/g)]
        return sites.every(m => {
          const arg = repl.slice(m.index! + 'setHighlight('.length, m.index! + 120)
          return arg.startsWith("''") || arg.includes('parseSearchQuery(')
        })
      })(),
      `${[...repl.matchAll(/setHighlight\(/g)].length} call sites`,
    )
    t.check(
      'so an operator token is never inverse-highlighted as content',
      !/setHighlight\((query|searchQuery)\)/.test(repl),
      'no raw-query highlight remains',
    )
    const row = readFileSync('src/components/messages/AssistantToolUseMessage.tsx', 'utf8')
    t.check('the tool row wears the family mark', row.includes('toolMarkFor(param.name)'), 'marked')
    t.check(
      'toned through the registry, never a literal colour',
      row.includes('toolToneFor(param.name, tokens)'),
      'registry-toned',
    )
  }

  // ──────────────────────────────────────────────────────────────────────────
  t.section('§5 — REAL RENDER: every mark reaches the grid as one cell')
  {
    const out = join(scratch, 'glyphs.json')
    const cfg = join(scratch, 'cfg.json')
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        sends: [],
        total: 14,
        cols: 40,
        rows: 16,
        out,
      }),
    )
    const r = spawnSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfg], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(60_000),
      env: { ...process.env, TERM: 'xterm-256color', TOOLGLYPH_RENDER_CHILD: '1' },
    })
    let lines: string[] = []
    try {
      const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: { c: string }[][] }
      lines = payload.grid.map(cells => cells.map(cell => cell.c).join(''))
    } catch {
      /* reported below */
    }
    t.check('the vocabulary rendered', r.status === 0 && lines.length > 0, `exit=${r.status}`)
    for (const [family, mark] of Object.entries(TOOL_FAMILY_MARKS)) {
      const line = lines.find(l => l.includes(`|${family}`))
      t.check(
        `${family}: the mark paints, and its separator lands in column 2`,
        line !== undefined && line.startsWith(`${mark.glyph}|`),
        line?.slice(0, 12).trim() ?? 'missing',
      )
    }
  }

  rmSync(scratch, { recursive: true, force: true })
  t.finish('prove-tool-projection')
}
