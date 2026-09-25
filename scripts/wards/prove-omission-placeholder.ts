#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const RULE = 'no-omission-placeholder'

async function main(): Promise<void> {
  delete process.env.MERCURY_WARDS
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'wards-omission-home-'))
  const { BUILTIN_WARDS, evaluateWards, buildWardDenial } = await import('../../src/utils/wards/wards.js')
  const { registerWardsHook, resetWardsEngagedSessionsForTest } = await import('../../src/utils/hooks/wardsHook.js')
  const { getSessionFunctionHooks } = await import('../../src/utils/hooks/sessionHooks.js')
  const { readFileSync } = await import('node:fs')

  type Call = { toolName: string; input: Record<string, unknown> }
  const write = (file_path: string, content: string): Call => ({ toolName: 'Write', input: { file_path, content } })
  const edit = (file_path: string, new_string: string, old_string = 'const before = 1'): Call => ({
    toolName: 'Edit',
    input: { file_path, old_string, new_string },
  })
  const verdictOf = (call: Call) => evaluateWards(BUILTIN_WARDS, call)
  const deniedBy = (call: Call): string | null => {
    const v = verdictOf(call)
    return v.allow ? null : v.rule.name
  }
  const denialText = (call: Call): string => {
    const v = verdictOf(call)
    return v.allow ? 'ALLOWED' : buildWardDenial(v, call.toolName)
  }
  const file = '/work/project/src/service.ts'
  const around = (line: string): string => `export function a() {\n  return 1\n}\n${line}\nexport function z() {\n  return 26\n}\n`

  console.log('============================================================')
  console.log(' the omission-placeholder ward — proof')
  console.log('============================================================')

  section('A. the builtin rule exists with the fields the placeholder needs')
  {
    const rule = BUILTIN_WARDS.find(r => r.name === RULE)
    check(`BUILTIN_WARDS carries '${RULE}'`, rule !== undefined, BUILTIN_WARDS.map(r => r.name).join(','))
    check('scope is edit', rule?.scope === 'edit', String(rule?.scope))
    check('comment lines are NOT skipped (the placeholder usually is a comment line)', rule?.skipCommentLines === false, String(rule?.skipCommentLines))
    check('only genuinely new content counts (newContentOnly)', rule?.newContentOnly === true, String(rule?.newContentOnly))
    check('lines are matched with their indentation removed (trimLines), so the pattern is start-anchored', rule?.trimLines === true && rule.patterns.every(p => p.startsWith('^')), String(rule?.trimLines))
    check('the rule is gated by no path (every file a Write or Edit can reach)', rule !== undefined && rule.pathPattern === undefined)
  }

  section('B. a Write whose content carries a placeholder is refused before any byte lands')
  {
    const call = write(file, around('// rest of methods ...'))
    check('Write with "// rest of methods ..." in content ⇒ denied by the rule', deniedBy(call) === RULE, denialText(call))
    const text = denialText(call)
    check('the denial names the rule', text.includes(`Ward '${RULE}'`), text)
    check('the denial quotes the placeholder line and its line number', text.includes('"// rest of methods ..."') && text.includes(`${file}:4`), text)
    check('the denial asks for the literal content', text.includes('literal content'), text)
    check('the denial keeps the content-rule closing (rewrite the call to comply)', text.endsWith('rewrite the call to comply.'), text)
  }

  section('C. an Edit whose new_string carries a placeholder is refused')
  {
    const call = edit(file, 'function a() {}\n(unchanged code ...)\nfunction z() {}')
    check('Edit with "(unchanged code ...)" in new_string ⇒ denied', deniedBy(call) === RULE, denialText(call))
    const all = { toolName: 'Edit', input: { file_path: file, old_string: 'x', new_string: '// unchanged methods ...', replace_all: true } }
    check('replace_all carries the same new_string road ⇒ denied', deniedBy(all) === RULE, denialText(all))
  }

  section('D. a placeholder that already stands in the file may be edited (old_string carries it)')
  {
    const moved = edit(file, '  (unchanged code ...)\nconst after = 2', '(unchanged code ...)\nconst before = 1')
    check('the same placeholder line present in old_string ⇒ allowed (delta-aware, indentation aside)', deniedBy(moved) === null, denialText(moved))
    const kept = edit(file, '// rest of methods ...\nconst after = 2', 'const before = 1\n// rest of methods ...')
    check('a real placeholder kept across the edit ⇒ allowed', deniedBy(kept) === null, denialText(kept))
    const extra = edit(file, '// rest of methods ...\n// rest of code ...', '// rest of methods ...')
    check('a NEW placeholder beside a kept one ⇒ denied (only the new one counts)', deniedBy(extra) === RULE && verdictOf(extra).allow === false && verdictOf(extra).excerpt === '// rest of code ...', denialText(extra))
  }

  section('E. the fixed phrase set — everything outside it passes, ellipsis or not')
  {
    const passes: Array<[string, string]> = [
      ['rest of the world', 'the prefix without an ellipsis'],
      ['rest of the world ...', 'the prefix with a word outside the set, then the ellipsis'],
      ['// rest of the owl...', 'a comment with a word outside the set'],
      ['The rest is history...', 'prose'],
      ['More examples coming soon...', 'prose'],
      ['Additional notes...', 'prose'],
      ['Existing users...', 'prose'],
      ['## Other options...', 'a Markdown heading'],
      ['* ... more items', 'a Markdown bullet'],
      ['- ... more items', 'a Markdown bullet'],
      ['(continued...)', 'a continuation mark'],
      ['... continued from page 1', 'a continuation mark'],
      ['... (truncated)', 'a truncation mark'],
      ['[... truncated 200 lines ...]', 'a truncation mark'],
      ['... skipped 3 files', 'a summary line'],
      ['// Existing sessions are resumed first...', 'a comment that happens to start with existing'],
      ['# Remaining arguments are forwarded to git...', 'a comment that happens to start with remaining'],
      ['To be continued...', 'prose'],
      ['| ... | rest of rows ... |', 'a table row'],
      ["expect(out).toBe('rest of the code ...')", 'the placeholder inside a string literal'],
      ['// the rest is history', 'prose with the word rest, no ellipsis'],
      ['// ...', 'a bare ellipsis comment'],
      ['/* ... */', 'a bare block-comment ellipsis'],
      ['...', 'a bare ellipsis line'],
      ['…', 'a bare unicode ellipsis line'],
      ['def m(self) -> int: ...', 'a Python body ellipsis'],
      ["console.log('loading...')", 'an ellipsis inside code'],
      ['Loading...', 'prose'],
      ['// Retrying...', 'a progress comment'],
      ['const all = [first, ...rest]', 'a spread of a variable named rest'],
      ['  ...rest', 'a spread of rest on its own line (a destructuring pattern)'],
      ['  {...rest}', 'a JSX spread of rest on its own line'],
      ['  ...remaining,', 'a spread of remaining with a trailing comma'],
      ['...existing', 'a spread at column zero'],
      ['// TODO ...', 'a TODO with an ellipsis'],
      ['// see above ...', 'a pointer, not an omission phrase'],
      ['// existing tests are in tests/ ...', 'the phrase runs into a path'],
      ['// wait for the rest of the response ...', 'a word outside the set before the phrase'],
      ['rest of code', 'the prefix alone'],
      ['rest of codes ...', 'a noun outside the set'],
      ['... more', 'a word outside the set'],
      ['and so on ...', 'an idiom outside the set'],
      ['// ... other methods ...', 'a phrase outside the fixed set'],
      ['// ... remaining code ...', 'a phrase outside the fixed set'],
      ['// ... snip ...', 'a phrase outside the fixed set'],
      ['// ----------------------------------------------------------------', 'a rule of dashes'],
      ['// ................................................................', 'a rule of dots'],
      ['# -*- coding: utf-8 -*-', 'a coding line'],
    ]
    for (const [line, why] of passes) {
      const w = write(file, around(line))
      check(`${JSON.stringify(line)} passes (${why})`, deniedBy(w) === null, denialText(w))
    }
  }

  section('F. every road that lands bytes passes the ward: hunks, append, section, ChangeSet, the patch dialect, AstEdit')
  {
    const hunks = { toolName: 'Edit', input: { file_path: file, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '2-3', replace: 'const kept = 1' }, { lines: '9', replace: '// ... existing code ...' }] } }
    check('a hunks edit carrying the placeholder in a hunk body ⇒ denied', deniedBy(hunks) === RULE, denialText(hunks))
    const insert = { toolName: 'Edit', input: { file_path: file, hunks: [{ lines: '4#ab3f', replace: '  // ... rest of the methods ...', insert: 'after' }] } }
    check('an insert hunk carrying the placeholder ⇒ denied', deniedBy(insert) === RULE, denialText(insert))
    const cleanHunks = { toolName: 'Edit', input: { file_path: file, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '2-3', replace: 'const kept = 1' }] } }
    check('a clean hunks edit ⇒ allowed', deniedBy(cleanHunks) === null, denialText(cleanHunks))
    const append = { toolName: 'Edit', input: { file_path: file, append: '// ... rest of the file unchanged' } }
    check('an append carrying the placeholder ⇒ denied', deniedBy(append) === RULE, denialText(append))
    const sectionNew = { toolName: 'Edit', input: { file_path: '/work/project/NOTES.md', section: '## Checks', new_string: '## Checks\n... rest of the content unchanged ...' } }
    check('a section replacement carrying the placeholder ⇒ denied', deniedBy(sectionNew) === RULE, denialText(sectionNew))
    const sectionAppend = { toolName: 'Edit', input: { file_path: '/work/project/NOTES.md', section: '## Checks', append: '(rest of the lines ...)' } }
    check('a section append carrying the placeholder ⇒ denied', deniedBy(sectionAppend) === RULE, denialText(sectionAppend))
    const notebook = { toolName: 'NotebookEdit', input: { notebook_path: '/work/project/a.ipynb', cell_id: 'c1', new_source: 'x = 1\n# ... rest of the code unchanged' } }
    check('a NotebookEdit new_source carrying the placeholder ⇒ denied', deniedBy(notebook) === RULE, denialText(notebook))
    const member = (replace: string) => ({ file_path: file, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '2', replace }] })
    const preview = { toolName: 'ChangeSet', input: { op: 'preview', changes: [member('const kept = 1'), member('// ... existing code ...')] } }
    check('a ChangeSet preview whose second member carries the placeholder ⇒ denied (the plan is never minted)', deniedBy(preview) === RULE, denialText(preview))
    const applyInline = { toolName: 'ChangeSet', input: { op: 'apply', changes: [member('// rest of code ...')] } }
    check('a ChangeSet apply with inline changes carrying the placeholder ⇒ denied', deniedBy(applyInline) === RULE, denialText(applyInline))
    const applyClean = { toolName: 'ChangeSet', input: { op: 'apply', changes: [member('const kept = 1')] } }
    check('a clean ChangeSet ⇒ allowed', deniedBy(applyClean) === null, denialText(applyClean))
    const applyPlan = { toolName: 'ChangeSet', input: { op: 'apply', plan_id: 'cs-0123' } }
    check('a ChangeSet apply by plan id carries no bytes in the call ⇒ allowed (the bytes were judged at preview)', deniedBy(applyPlan) === null, denialText(applyPlan))
    const patch = { toolName: 'ChangeSet', input: { op: 'preview', patch: `file ${file} fa:0123456789ab\nreplace 2\n| const kept = 1\n|\n| // ... rest of the code unchanged\n` } }
    const patchVerdict = verdictOf(patch)
    check("a patch-dialect body row carrying the placeholder ⇒ denied, on the section's file", deniedBy(patch) === RULE && !patchVerdict.allow && patchVerdict.target === file && patchVerdict.line === 3, denialText(patch))
    const patchClean = { toolName: 'ChangeSet', input: { op: 'preview', patch: `file ${file} fa:0123456789ab\nreplace 2\n| const kept = 1\n` } }
    check('a clean patch ⇒ allowed', deniedBy(patchClean) === null, denialText(patchClean))
    const ast = { toolName: 'AstEdit', input: { pattern: 'function $NAME() { $$$BODY }', rewrite: 'function $NAME() {\n  // ... existing code ...\n}', path: '/work/project/src', apply: true, plan: 'ae-0123' } }
    check('an AstEdit rewrite carrying the placeholder ⇒ denied', deniedBy(ast) === RULE, denialText(ast))
    const astClean = { toolName: 'AstEdit', input: { pattern: 'console.log($A)', rewrite: 'logger.info($A)' } }
    check('a clean AstEdit rewrite ⇒ allowed', deniedBy(astClean) === null, denialText(astClean))
  }

  section('G. the fixed phrase set — the seven Gemini prefixes, their normalisation, and the ellipsis-led idiom')
  {
    const denies = [
      'rest of ...', 'rest of method ...', 'rest of methods ...', 'rest of code ...',
      'unchanged code ...', 'unchanged method ...', 'unchanged methods ...',
      '// rest of code ...', '# rest of code ...', '(rest of code ...)', '// (rest of code ...)', '  Rest Of Code ...', 'rest   of\tcode ...', 'rest of code ... ...', 'rest of code .....',
      '// ... existing code ...', '// ... rest of the code unchanged', '// ... rest of the code unchanged.', '// ...existing code...',
      '# ... existing code ...', '-- ... rest of the file ...', '/* ... rest of file ... */', ' * ... rest of the file ...', '<!-- ... rest of the markup ... -->', '{/* ... rest of the markup ... */}',
      '// … existing code …', '// ... unchanged ...', '// ... rest of the code remains the same ...', '// ... code unchanged ...', '// the rest is unchanged ...',
      '// ... (rest of the implementation)', '// [... rest of file ...]', '// ... existing imports ...', '// ... existing methods ...', '# ... rest of the function ...',
      '// existing code remains the same ...', '... rest of the content unchanged ...', '// rest of the class ...', '// ... rest of the template ...',
    ]
    for (const line of denies) {
      const w = write(file, around(line))
      check(`${JSON.stringify(line)} ⇒ denied`, deniedBy(w) === RULE, denialText(w))
    }
    const probe = write(file, `export function a() {}\n// ... rest of the code unchanged`)
    const probeText = denialText(probe)
    check('the concourse probe line ends the content ⇒ denied with the line quoted', probeText.includes('"// ... rest of the code unchanged"') && probeText.includes(`${file}:2`), probeText)
  }

  section('H. a legitimate literal: a file whose content TESTS the ward passes the ward')
  {
    const here = readFileSync(import.meta.path, 'utf8')
    const self = write('/work/project/scripts/wards/prove-omission-placeholder.ts', here)
    check('a Write of this proof (its one-line literals carry every placeholder) ⇒ allowed', deniedBy(self) === null, denialText(self))
    const engine = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'wards', 'wards.ts'), 'utf8')
    const rules = write('/work/project/src/utils/wards/wards.ts', engine)
    check('a Write of the engine source (the rule and its vocabulary) ⇒ allowed', deniedBy(rules) === null, denialText(rules))
    const suite = readFileSync(join(import.meta.dir, 'prove-wards.ts'), 'utf8')
    check('a Write of the wards suite proof ⇒ allowed', deniedBy(write('/work/project/scripts/wards/prove-wards.ts', suite)) === null)
    const split = write(file, `const fixture = ${JSON.stringify('// rest of methods ...')}\nconst two = '// rest of' + ' methods ...'\n`)
    check('a one-line string literal carrying the placeholder ⇒ allowed (the line is code, not a placeholder)', deniedBy(split) === null, denialText(split))
    const template = write(file, 'const fixture = `function a() {}\n// rest of methods ...\nfunction z() {}`\n')
    check('a multi-line template literal with the placeholder on its own line ⇒ denied (write it split or escaped)', deniedBy(template) === RULE, denialText(template))
  }

  section('I. the matcher is linear on adversarial lines (whitespace runs, dot runs, repeated words)')
  {
    const lines: Array<[string, boolean]> = [
      [' '.repeat(12_500), false],
      [' '.repeat(100_000), false],
      ['\t'.repeat(100_000), false],
      [' '.repeat(100_000) + '// rest of code ...', true],
      [' '.repeat(100_000) + 'x', false],
      ['// ' + '-'.repeat(100_000), false],
      ['// ' + '.'.repeat(100_000), false],
      ['// ' + '…'.repeat(50_000), false],
      ['// ' + Array(20_000).fill('existing').join(' '), false],
      ['// ' + Array(20_000).fill('rest of').join(' ') + ' ...', false],
      ['... ' + Array(20_000).fill('rest of').join(' ') + ' x', false],
      ['(' + '('.repeat(50_000) + 'unchanged ...' + ')'.repeat(50_000), false],
      ['x'.repeat(100_000) + ' ...', false],
      ['rest of code ' + '.'.repeat(100_000), true],
      ['... ' + 'abc '.repeat(180_000), false],
      ['a.. b.. '.repeat(90_000), false],
      ['é'.repeat(100_000) + ' ...', false],
      ['😀'.repeat(100_000) + ' ...', false],
      ['"content": "' + 'text\\n'.repeat(8_000) + '... ' + 'more text\\n'.repeat(1_000) + '"', false],
    ]
    for (const [line, deny] of lines) {
      const t0 = performance.now()
      const v = verdictOf(write(file, around(line)))
      const ms = performance.now() - t0
      check(`${JSON.stringify(line.slice(0, 24))}… (${line.length} chars) evaluates in ${ms.toFixed(1)}ms (< 50ms), verdict ${deny ? 'deny' : 'allow'}`, ms < 50 && v.allow === !deny)
    }
    const indented = Array(10_000).fill(' '.repeat(200) + '// ... existing code ... x').join('\n')
    const t1 = performance.now()
    const vi = verdictOf(write(file, indented))
    const msi = performance.now() - t1
    check(`10 000 deeply indented near-miss lines evaluate in ${msi.toFixed(1)}ms (< 250ms) and pass`, msi < 250 && vi.allow)
    const big = around('const x = 1').repeat(2000)
    const t0 = performance.now()
    const v = verdictOf(write(file, big))
    const ms = performance.now() - t0
    check(`a ${big.length}-byte clean Write evaluates in ${ms.toFixed(1)}ms (< 250ms) and passes`, ms < 250 && v.allow)
  }

  section('J. the armed hook road denies with the teaching string')
  {
    type AnyState = { sessionHooks: Map<string, unknown> } & Record<string, unknown>
    let state: AnyState = { sessionHooks: new Map() }
    const setAppState = ((updater: (prev: AnyState) => AnyState) => {
      state = updater(state)
    }) as never
    resetWardsEngagedSessionsForTest()
    registerWardsHook(setAppState, 'w-omission')
    const matchers = getSessionFunctionHooks({ sessionHooks: state.sessionHooks } as never, 'w-omission', 'PreToolUse').get('PreToolUse' as never) ?? []
    const cb = matchers.flatMap((m: { hooks: Array<{ callback: (mm: never[], s?: never, c?: unknown) => unknown }> }) => m.hooks)[0]!.callback
    const ctx = (toolName: string, input: Record<string, unknown>) => ({ hookInput: { tool_name: toolName, tool_input: input }, tool: { name: toolName } })
    const denied = await cb([], undefined as never, ctx('Write', { file_path: file, content: around('// ... rest of the code unchanged') }))
    check('the hook denies the Write with the teaching string', typeof denied === 'string' && denied.includes(`Ward '${RULE}'`) && denied.includes('literal content'), String(denied).slice(0, 200))
    const allowed = await cb([], undefined as never, ctx('Write', { file_path: file, content: around('const x = 1') }))
    check('the hook passes a clean Write', allowed === true, JSON.stringify(allowed))
    const hunks = await cb([], undefined as never, ctx('Edit', { file_path: file, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '2', replace: '// ... existing code ...' }] }))
    check('the hook denies a hunks edit carrying the placeholder', typeof hunks === 'string' && hunks.includes(`Ward '${RULE}'`), String(hunks).slice(0, 200))
    const changeSet = await cb([], undefined as never, ctx('ChangeSet', { op: 'apply', changes: [{ file_path: file, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '2', replace: '// ... existing code ...' }] }] }))
    check('the hook denies a ChangeSet carrying the placeholder', typeof changeSet === 'string' && changeSet.includes(`Ward '${RULE}'`), String(changeSet).slice(0, 200))
    const ast = await cb([], undefined as never, ctx('AstEdit', { pattern: 'f($A)', rewrite: 'g($A)\n// ... rest of the code unchanged' }))
    check('the hook denies an AstEdit rewrite carrying the placeholder', typeof ast === 'string' && ast.includes(`Ward '${RULE}'`), String(ast).slice(0, 200))
    const t0 = performance.now()
    const blank = await cb([], undefined as never, ctx('Write', { file_path: file, content: ' '.repeat(100_000) }))
    const ms = performance.now() - t0
    check(`the hook passes a 100 000-space Write in ${ms.toFixed(1)}ms (< 50ms)`, blank === true && ms < 50)
    resetWardsEngagedSessionsForTest()
  }

  section('K. the rule set stays data')
  {
    check('BUILTIN_WARDS survives a JSON round-trip unchanged', JSON.stringify(JSON.parse(JSON.stringify(BUILTIN_WARDS))) === JSON.stringify(BUILTIN_WARDS))
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ OMISSION-PLACEHOLDER WARD PROOF PASSES')
  process.exit(0)
}

void main()
