#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-samples-doc-'))
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_SAMPLES = '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
function thrown(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}
async function rejected(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — samples doc proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

type Renderer = typeof import('../../src/services/samples/renderDoc.ts')
type Theme = typeof import('../../src/services/samples/docTheme.ts')
let renderer: Renderer
let theme: Theme
try {
  renderer = await import('../../src/services/samples/renderDoc.ts')
  theme = await import('../../src/services/samples/docTheme.ts')
} catch (error) {
  console.log(`  [FAIL] the renderer exists (src/services/samples/renderDoc.ts) — ${error instanceof Error ? error.message : String(error)}`)
  console.log('\n❌ samples doc: the product has no doc road')
  process.exit(1)
}
const { normalizeSampleDoc, renderSampleDoc, sanitizeSvg, diffTones } = renderer
const bridge = await import('../../src/services/samples/bridge.ts')
const { handleSampleCall, keepSample, specOf, SAMPLE_DOC_REFUSAL } = bridge
const { SAMPLE_HTML_CAP_BYTES } = await import('../../src/services/samples/contracts.ts')
const store = await import('../../src/services/samples/store.ts')
const listener = await import('../../src/services/samples/listener.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')
const { SAMPLE_PROMPT_LINES } = await import('../../src/tools/EvalTool/prompt.ts')

interface Fixture {
  styleSha256: string
  scriptSha256: string
  plain: { payload: { name: string; title: string; ask: string; doc: unknown }; skeleton: string[] }
  template: { title: string; doc: unknown; skeleton: string[] }
  review: { title: string; doc: unknown; skeleton: string[] }
}
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'samples-doc-reference.json'), 'utf8')) as Fixture

function skeleton(html: string): string[] {
  const body = html.slice(html.indexOf('<body>'), html.lastIndexOf('<script>'))
  const out: string[] = []
  for (const m of body.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) {
    const tag = m[1]!
    const attrs = m[2] ?? ''
    if (tag === 'path') continue
    const id = /\sid="([^"]*)"/.exec(attrs)?.[1]
    const cls = /\sclass="([^"]*)"/.exec(attrs)?.[1]
    const part = /\sdata-part="([^"]*)"/.exec(attrs)?.[1]
    out.push(`${tag}${id ? '#' + id : ''}${cls ? '.' + cls.split(/\s+/).join('.') : ''}${part ? '[data-part=' + part + ']' : ''}`)
  }
  return out
}
function firstDiff(a: string[], b: string[]): string {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `@${i}: ours=${a[i] ?? '∅'} ref=${b[i] ?? '∅'} (${a.length} vs ${b.length} nodes)`
  return ''
}
const untoned = (nodes: string[]): string[] => nodes.map(n => n.replace(/\.tone-(del|add|dim|warn-line|accent)\b/g, ''))
const ids = (html: string): string[] => [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]!)
const bodyOf = (html: string): string => html.slice(html.indexOf('<body>'), html.lastIndexOf('<script>'))
const render = (doc: unknown, title?: string): string => renderSampleDoc(normalizeSampleDoc(doc), title !== undefined ? { title } : {})

section('R the reference renderings: the same doc gives the same page')
const plainSpec = specOf(fixture.plain.payload)
check('R1 the terse payload (a string verdict, a section, a bare-string diff, object rows, bracket strings) renders the plain reference node for node', firstDiff(skeleton(plainSpec.html), fixture.plain.skeleton) === '', firstDiff(skeleton(plainSpec.html), fixture.plain.skeleton))
const templateHtml = render(fixture.template.doc, fixture.template.title)
check('R2 every block once renders the template reference node for node (242 nodes)', firstDiff(skeleton(templateHtml), fixture.template.skeleton) === '' && fixture.template.skeleton.length === 242, firstDiff(skeleton(templateHtml), fixture.template.skeleton))
const reviewHtml = render(fixture.review.doc, fixture.review.title)
check('R3 the review renders its reference node for node, the diff and terminal tones aside (those the renderer computes)', firstDiff(untoned(skeleton(reviewHtml)), untoned(fixture.review.skeleton)) === '', firstDiff(untoned(skeleton(reviewHtml)), untoned(fixture.review.skeleton)))
check('R4 the stylesheet is the approved one, byte for byte without its comment lines', sha(theme.DOC_STYLE.trim()) === fixture.styleSha256 && templateHtml.includes(`<style>${theme.DOC_STYLE}</style>`))
check('R5 the page script is the approved one, byte for byte without its comment lines', sha(theme.DOC_SCRIPT.trim()) === fixture.scriptSha256 && templateHtml.includes(`<script>${theme.DOC_SCRIPT}</script>`))
check('R6 the frame is drawn for every document: glyph field, sticky strip, helmet, eyebrow, surface toggle, outline', ['<canvas class="glyph-field" id="glyph-field" aria-hidden="true">', '<div class="sticky-verdict" id="sticky-verdict" hidden>', '<svg class="brand-mark"', 'MERCURY <span class="interpunct">·</span> SAMPLE', '<button type="button" class="btn-ghost" id="theme-toggle" aria-pressed="false">Parchment</button>', '<nav class="doc-outline" id="doc-outline" aria-label="Sections" hidden></nav>', '<main class="tabula" id="tabula-root">'].every(w => plainSpec.html.includes(w)))
check('R7 the stylesheet speaks both surfaces and the terminal window', ['html[data-theme="light"]', '--bg: #ece2cc', '--tty-bg: #0b0b0b', '--tty-text: #28fe14', '@media print', 'color-scheme: dark'].every(w => theme.DOC_STYLE.includes(w)) && !/linear-gradient|border-radius:\s*[1-9]/.test(theme.DOC_STYLE))
check('R8 nothing is fetched: no script src, stylesheet link, import, remote image or font', !/<script\s+src|<link[^>]+stylesheet|@import\s|url\(/.test(templateHtml) && (templateHtml.match(/https?:\/\//g) ?? []).every(() => true) && templateHtml.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '').match(/https?:\/\//) === null)
check('R9 the three pages weigh under 60 KB', [plainSpec.html, templateHtml, reviewHtml].every(h => Buffer.byteLength(h, 'utf8') < 60 * 1024), [plainSpec.html, templateHtml, reviewHtml].map(h => Buffer.byteLength(h, 'utf8')).join(','))
check('R10 the review eyebrow is the document\'s own and the title lands in <title> and h1', reviewHtml.includes('MERCURY <span class="interpunct">·</span> CODE REVIEW') && reviewHtml.includes('<title>Structured samples: doc replaces html · Mercury</title>') && reviewHtml.includes('<h1 class="doc-title" id="doc-title">Structured samples: doc replaces html</h1>'))

section('N the normaliser: terse input becomes a full page')
const plainDoc = normalizeSampleDoc((fixture.plain.payload as { doc: unknown }).doc)
check('N1 doc.verdict as a string becomes the first block, status info, stamped Summary', plainDoc.parts[0]?.kind === 'verdict' && plainDoc.parts[0].status === 'info' && plainDoc.parts[0].label === 'Summary' && plainSpec.html.includes('<section class="part part-verdict status-info" id="part-1-verdict" data-part="verdict" aria-label="Summary">'))
const tbl = plainDoc.parts[3]
check('N2 object rows take their columns from the keys of the first row', tbl?.kind === 'table' && tbl.columns.join('|') === 'Case|Result' && tbl.rows.length === 3 && tbl.rows[0]?.[0]?.text === 'page 1 (0..9)')
check('N3 a plain cell that starts with PASS is toned ok, a path mono, DEFECT danger, PENDING warn, an ID mono, a bracket prefix dropped', (() => {
  const d = normalizeSampleDoc({ parts: [{ kind: 'table', rows: [['PASS', 'lib/render.ts:164', 'Defect · minor', 'Pending', 'T-01', '[x] Verified', 'page 1 (0..9)', '4.85 : 1']] }] })
  const row = d.parts[0]?.kind === 'table' ? d.parts[0].rows[0]! : []
  return row.map(c => c.tone).join(',') === 'ok,mono,danger,warn,mono,ok,default,default' && row[5]?.text === 'Verified'
})())
check('N4 a diff from two plain strings: bare strings are code, labels default, the changed lines are toned by comparison, the rest stay plain', plainSpec.html.includes('<span class="code-line tone-del" id="part-3-b-1"><span class="line-num">1</span>const start = page * size;</span><span class="code-line" id="part-3-b-2">') && plainSpec.html.includes('<span class="code-line tone-add" id="part-3-a-1">') && plainSpec.html.includes('<span class="diff-label">Before</span>') && plainSpec.html.includes('<span class="diff-label">After</span>'))
check('N5 the line comparison is an LCS: a moved line is not a change, an edited one is', (() => {
  const t = diffTones(['a', 'b', 'c', 'd'], ['b', 'c', 'x', 'd'])
  return t.before.join(',') === 'true,false,false,false' && t.after.join(',') === 'false,false,true,false'
})())
check('N6 bracket strings read as checklist states and a bare string is done', (() => {
  const d = normalizeSampleDoc({ parts: [{ kind: 'checklist', items: ['[x] a', '[ ] b', '[!] c', '[-] d', 'e'] }] })
  return d.parts[0]?.kind === 'checklist' && d.parts[0].items.map(i => i.state).join(',') === 'done,pending,failed,skipped,done' && d.parts[0].items[0]?.text === 'a'
})())
check('N7 kind or type, hyphen or underscore, and the aliases: before_after is diff, code is terminal, checks is checklist, decision is question, stats is cards, outcome is verdict', (() => {
  const d = normalizeSampleDoc({ parts: [
    { type: 'Before_After', before: 'a', after: 'b' },
    { kind: 'code', lines: ['x'] },
    { kind: 'checks', items: ['[x] y'] },
    { kind: 'decision', heading: 'Q', options: ['A', 'B'] },
    { kind: 'stats', items: [{ label: 'n', value: '1' }] },
    { kind: 'outcome', text: 'fine' },
  ] })
  return d.parts.map(p => p.kind).join(',') === 'diff,terminal,checklist,question,cards,verdict'
})())
check('N8 an unknown kind is placed by its shape: prose makes a section, rows a table, string items a checklist', (() => {
  const d = normalizeSampleDoc({ parts: [{ kind: 'note', prose: 'p' }, { kind: 'grid-of-rows', rows: [['a']] }, { kind: 'todo', items: ['[ ] a'] }, 'a bare string part'] })
  return d.parts.map(p => p.kind).join(',') === 'section,table,checklist,section'
})())
check('N9 title ≈ heading, text ≈ summary, body ≈ prose, output ≈ lines; a prose string splits on blank lines, lines on newlines, meta on newlines, arrays join', (() => {
  const d = normalizeSampleDoc({ meta: 'a\nb', parts: [{ kind: 'section', title: 'H', body: 'one\n\ntwo\nstill two' }, { kind: 'terminal', output: 'l1\nl2\n' }, { kind: 'verdict', text: ['two', 'words'] }] })
  const s = d.parts[0], t = d.parts[1], v = d.parts[2]
  return d.meta.join('|') === 'a|b' && s?.kind === 'section' && s.heading === 'H' && s.prose.join('|') === 'one|two\nstill two' && t?.kind === 'terminal' && t.lines.map(l => l.text).join('|') === 'l1|l2' && v?.kind === 'verdict' && v.summary === 'two words'
})())
check('N10 headed blocks are numbered I, II, III in order, a block without a heading is skipped, numeral "" suppresses one', (() => {
  const h = render({ parts: [{ kind: 'section', heading: 'A', prose: 'x' }, { kind: 'terminal', lines: ['y'] }, { kind: 'section', heading: 'B', prose: 'x' }, { kind: 'section', heading: 'C', numeral: '', prose: 'x' }, { kind: 'section', heading: 'D', prose: 'x' }] })
  const nums = [...h.matchAll(/<span class="sec-num" aria-hidden="true">([^<]+)<\/span>/g)].map(m => m[1])
  return nums.join(',') === 'I.,II.,III.' && h.includes('<h2 class="section-title" id="part-4-heading">C</h2>') && !h.includes('<section class="part part-terminal" id="part-2-terminal" data-part="terminal">\n    <div class="section-head">')
})())
check('N11 terminal lines are toned by their first word: [PASS] add, [FAIL] del, # dim, ❌ warn, a failing count warn, a clean count plain; a model may name a tone', (() => {
  const d = normalizeSampleDoc({ parts: [{ kind: 'terminal', lines: ['  [PASS] ok', '  [FAIL] bad', '# a comment', '❌ 1 failure', '2 passed · 1 failed', '3 passed · 0 failed', '+ added', '- removed', 'ERROR: x', '>>> prove', { text: 'z', tone: 'accent' }] }] })
  const t = d.parts[0]
  return t?.kind === 'terminal' && t.lines.map(l => l.tone).join(',') === 'add,del,dim,warn,warn,default,add,del,del,dim,accent' && t.title === 'Terminal'
})())
check('N12 figure steps compile to a flow: six labels, no coordinates; alt derives from the heading', (() => {
  const h = render({ parts: [{ kind: 'figure', heading: 'Road', steps: ['a', { label: 'b', detail: 'd' }, { label: 'c', text: 't', detail: 'm' }, 'd', 'e', 'f'] }] })
  return h.includes('<div class="flow" id="part-1-flow" role="list" aria-label="Road">') && (h.match(/class="flow-step" role="listitem" id="part-1-step-\d"/g) ?? []).length === 6 && h.includes('<span class="label">b</span><span class="flow-text">d</span></div>') && h.includes('<span class="label">c</span><span class="flow-text">t</span><span class="flow-detail">m</span>')
})())
check('N13 a card with a title and no label lifts the title into the label; columns default to the item count up to three; a tone colours only the label', (() => {
  const h3 = render({ parts: [{ kind: 'cards', items: [{ title: 'T', value: '1', tone: 'ok' }, { label: 'L', value: '2' }, { label: 'M', body: 'b' }] }] })
  const h2 = render({ parts: [{ kind: 'cards', items: [{ label: 'L', value: '2' }, { label: 'M', body: 'b' }] }] })
  const h5 = render({ parts: [{ kind: 'cards', items: [1, 2, 3, 4, 5].map(n => ({ label: String(n), value: String(n) })) }] })
  return h3.includes('<div class="card-grid cols-3" id="part-1-grid">') && h3.includes('<article class="card tone-ok" id="part-1-card-1">\n        <span class="label">T</span>') && !bodyOf(h3).includes('card-title') && h2.includes('card-grid cols-2') && h5.includes('card-grid cols-3')
})())
check('N14 question options from strings and objects: no option pressed, Recommended as a word, the heading on the box for the decision line', (() => {
  const h = render({ parts: [{ kind: 'question', heading: 'Which way', options: ['Left', { label: 'Right', description: 'd', recommended: true }] }] })
  return h.includes('<div class="question-box" id="part-1-qbox" data-question="Which way">') && h.includes('<button type="button" class="question-opt" id="part-1-opt-1" data-opt="Left" aria-pressed="false">') && h.includes('<span class="opt-label">Right</span><span class="opt-rec">Recommended</span>') && !bodyOf(h).includes('aria-pressed="true"') && h.includes('id="part-1-status"') && h.includes('id="part-1-copy"')
})())
check('N15 a model-supplied id is used when it is a plain unique slug and never on a verdict, a reserved id or a part- id', (() => {
  const h = render({ verdict: 'v', parts: [{ kind: 'section', id: 'cause', heading: 'A', prose: 'x' }, { kind: 'section', id: 'cause', heading: 'B', prose: 'x' }, { kind: 'section', id: 'doc-title', heading: 'C', prose: 'x' }, { kind: 'section', id: 'part-9-section', heading: 'D', prose: 'x' }, { kind: 'section', id: 'Not A Slug', heading: 'E', prose: 'x' }] })
  return h.includes('id="cause" data-part="section"') && h.includes('id="part-3-section"') && h.includes('id="part-4-section"') && h.includes('id="part-5-section"') && h.includes('id="part-6-section"') && h.includes('id="part-1-verdict"')
})())
check('N16 top-level parts without doc is wrapped, a string doc is one section, both roads keep the title', (() => {
  const a = specOf({ name: 'n', parts: [{ kind: 'section', prose: 'p' }], verdict: 'v' })
  const b = specOf({ name: 'n', doc: 'just prose' })
  return a.html.includes('id="part-1-verdict"') && a.html.includes('id="part-2-section"') && b.html.includes('<p class="prose-p" id="part-1-p-1">just prose</p>') && a.source === 'doc'
})())
check('N17 doc.title is lifted into the sample title when the call has none; a given title wins', specOf({ name: 'n', doc: { title: 'From the doc', parts: [{ kind: 'section', prose: 'p' }] } }).title === 'From the doc' && specOf({ name: 'n', title: 'Given', doc: { title: 'From the doc', parts: [{ kind: 'section', prose: 'p' }] } }).title === 'Given' && specOf({ name: 'Just the name', doc: { parts: [{ kind: 'section', prose: 'p' }] } }).html.includes('<h1 class="doc-title" id="doc-title">Just the name</h1>'))

section('F the refusals: a teaching error names the field, nothing is kept')
const workDir = mkdtempSync(join(tmpdir(), 'mercury-samples-doc-work-'))
const SESSION = 'samples-doc-session'
const owner = makeOwnerKey({ workspace: workDir, sessionId: SESSION, lane: 'main' } as never)
check('F1 raw html from a model is refused with the teaching line', thrown(() => specOf({ name: 'x', html: '<p>x</p>' })) === SAMPLE_DOC_REFUSAL && SAMPLE_DOC_REFUSAL === 'sample() takes doc: { parts: [...] } — raw html is retired')
check('F2 the bridge road refuses the same way and writes nothing', (await rejected(handleSampleCall(owner, { name: 'x', html: '<p>x</p>' }))) === SAMPLE_DOC_REFUSAL && store.listSamples(SESSION).length === 0)
check('F3 a call with neither doc nor parts names doc; not an object names the shape', thrown(() => specOf({ name: 'x' })) === 'sample() needs doc: { parts: [...] } — the blocks Mercury draws' && thrown(() => specOf(null)) === 'sample() takes one object: { name, title?, doc, ask? }' && thrown(() => specOf({ doc: { parts: [] } })) === 'sample() needs a name (the same name publishes the next version)')
check('F4 an unknown kind is refused with the part and the nine kinds named', thrown(() => normalizeSampleDoc({ parts: [{ kind: 'section', prose: 'ok' }, { kind: 'banner', text2: 'x' }] })) === 'sample(): parts[1].kind "banner" is not one of verdict, section, cards, table, diff, terminal, figure, checklist, question' && thrown(() => normalizeSampleDoc({ parts: [{ value: 1 }] })) === 'sample(): parts[0] has no kind — one of verdict, section, cards, table, diff, terminal, figure, checklist, question')
check('F5 a bad field is refused with the field named', [
  [thrown(() => normalizeSampleDoc({ parts: [{ kind: 'verdict', status: 'maybe', summary: 's' }] })), 'sample(): parts[0].status "maybe" is not one of approved, changes-needed, warning, info, halted'],
  [thrown(() => normalizeSampleDoc({ parts: [{ kind: 'cards', columns: 7, items: [{ label: 'a' }] }] })), 'sample(): parts[0].columns must be 2, 3 or 4'],
  [thrown(() => normalizeSampleDoc({ parts: [{ kind: 'cards', items: [{ label: 'a', tone: 'purple' }] }] })), 'sample(): parts[0].items[0].tone "purple" is not one of default, ok, warn, danger, accent'],
  [thrown(() => normalizeSampleDoc({ parts: [{ kind: 'checklist', items: [{ text: 'a', state: 'maybe' }] }] })), 'sample(): parts[0].items[0].state "maybe" is not one of done, pending, failed, skipped'],
  [thrown(() => normalizeSampleDoc({ parts: [{ kind: 'verdict', detail: 'd' }] })), 'sample(): parts[0] verdict needs a summary'],
  [thrown(() => normalizeSampleDoc({ parts: [{ kind: 'question', heading: 'q' }] })), 'sample(): parts[0] question needs options'],
  [thrown(() => normalizeSampleDoc({ parts: [{ kind: 'table', rows: 'a,b' }] })), 'sample(): parts[0] table needs rows'],
  [thrown(() => normalizeSampleDoc({ parts: [{ kind: 'diff', before: 'a' }] })), 'sample(): parts[0] diff needs before and after'],
  [thrown(() => normalizeSampleDoc({ parts: [{ kind: 'figure', src: 'https://example.invalid/a.png' }] })), 'sample(): parts[0] figure needs steps, an inline svg or a data:image src (remote urls are dropped)'],
  [thrown(() => normalizeSampleDoc({ parts: [{ kind: 'section', heading: { a: 1 } }] })), 'sample(): parts[0].heading must be text'],
  [thrown(() => normalizeSampleDoc({ parts: [42] })), 'sample(): parts[0] must be a block object { kind, ... }'],
  [thrown(() => normalizeSampleDoc({ parts: {} })), 'sample(): doc.parts must be an array of blocks'],
  [thrown(() => normalizeSampleDoc({ parts: [] })), 'sample(): doc.parts is empty — give it at least one block'],
  [thrown(() => normalizeSampleDoc(7)), 'sample(): doc must be an object { parts: [...] }'],
].every(([got, want]) => got === want), JSON.stringify([
  thrown(() => normalizeSampleDoc({ parts: [{ kind: 'verdict', status: 'maybe', summary: 's' }] })),
  thrown(() => normalizeSampleDoc({ parts: [{ kind: 'cards', items: [{ label: 'a', tone: 'purple' }] }] })),
  thrown(() => normalizeSampleDoc({ parts: [{ kind: 'figure', src: 'https://example.invalid/a.png' }] })),
]))
const capLine = `sample() keeps at most ${SAMPLE_HTML_CAP_BYTES / (1024 * 1024)} MB per version`
check('F6 an oversize doc is refused before rendering, and a doc that renders past the cap after', thrown(() => specOf({ name: 'x', doc: { parts: [{ kind: 'section', prose: 'y'.repeat(SAMPLE_HTML_CAP_BYTES + 1) }] } })) === capLine && thrown(() => specOf({ name: 'x', doc: { parts: [{ kind: 'terminal', lines: Array.from({ length: 120_000 }, (_, i) => `line ${i} of a long log that is short in json`) }] } })) === capLine)
check('F7 title and ask must be text', thrown(() => specOf({ name: 'x', doc: { parts: [{ kind: 'section', prose: 'p' }] }, title: 1 })) === 'sample(): title must be a string' && thrown(() => specOf({ name: 'x', doc: { parts: [{ kind: 'section', prose: 'p' }] }, ask: 1 })) === 'sample(): ask must be a string')
check('F8 after every refusal the session has kept nothing', store.listSamples(SESSION).length === 0)

section('E escaping and the figure strip')
const hostile = render({
  title: '<script>alert(1)</script>',
  subtitle: 'sub <b>bold</b> **real** `code<x>`',
  meta: ['<img src=x onerror=alert(1)>'],
  verdict: 'v <script>',
  parts: [
    { kind: 'section', heading: 'H <i>x</i>', prose: 'p `a<b` **c**', items: ['<li>i'], note: 'n</aside>' },
    { kind: 'table', columns: ['<th>'], rows: [['<td>', { text: '<x>', tone: 'ok' }]] },
    { kind: 'terminal', command: 'rm -rf "<x>"', lines: ['<script>bad()</script>'] },
    { kind: 'question', heading: 'Q "quoted" <q>', options: [{ label: 'A "b" <c>', description: '<d>' }] },
    { kind: 'checklist', items: ['[x] <done>'] },
    { kind: 'diff', before: '<a>', after: '<b>' },
  ],
}, '<script>alert(1)</script>')
check('E1 every string is escaped: the only <script> on the page is Mercury\'s own', (hostile.match(/<script/g) ?? []).length === 1 && (hostile.match(/<\/script>/g) ?? []).length === 1 && !/<script>alert|<img|<b>bold|<li>i|<\/aside>n|<th>|<td>|<x>|<q>|<c>|<d>|<done>|<a>|<b>/.test(bodyOf(hostile)) && hostile.includes('<title>&lt;script&gt;alert(1)&lt;/script&gt; · Mercury</title>'))
check('E2 attributes are escaped: the decision heading and option carry their quotes as entities', hostile.includes('data-question="Q &quot;quoted&quot; &lt;q&gt;"') && hostile.includes('data-opt="A &quot;b&quot; &lt;c&gt;"'))
check('E3 backticks and double stars are the only inline markup, inside escaped text', hostile.includes('sub &lt;b&gt;bold&lt;/b&gt; <strong>real</strong> <code>code&lt;x&gt;</code>') && hostile.includes('<p class="prose-p" id="part-2-p-1">p <code>a&lt;b</code> <strong>c</strong></p>'))
const svgIn = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><style>body{display:none}</style><foreignObject><iframe src="https://example.invalid"></iframe></foreignObject><a href="javascript:alert(3)" xlink:href="jav&#x61;script:alert(4)"><rect class="fx-box" fill="#050910" width="4" height="4" onclick="alert(5)"/></a><image href="https://example.invalid/x.png" width="2"/><use xlink:href="//example.invalid/s.svg#a"/><text style="fill:url(https://example.invalid/p.svg#g)" x="1" y="2">ok</text><image href="data:image/png;base64,AAAA"/></svg>'
const svgOut = sanitizeSvg(svgIn)
check('E4 figure.svg keeps no script, style, foreignObject, on* handler, javascript: or remote reference, entity-encoded included', !/<script|<style|<foreignobject|<iframe|onload|onclick|javascript:|jav&#x61;script|https?:\/\/example|\/\/example|url\(/i.test(svgOut), svgOut)
check('E5 the namespace, classes, fills, sizes and data: images survive the strip', svgOut.includes('xmlns="http://www.w3.org/2000/svg"') && svgOut.includes('xmlns:xlink="http://www.w3.org/1999/xlink"') && svgOut.includes('class="fx-box"') && svgOut.includes('fill="#050910"') && svgOut.includes('width="4"') && svgOut.includes('href="data:image/png;base64,AAAA"') && svgOut.includes('>ok</text>'))
const figured = render({ parts: [{ kind: 'figure', heading: 'Fig', svg: svgIn, src: 'https://example.invalid/remote.png' }] })
check('E6 on the page the svg sits in the figure box with a role and label, and a remote src is dropped', figured.includes('<figure class="figure-box" id="part-1-figbox">') && figured.includes('role="img"') && figured.includes('aria-label="Fig"') && !figured.includes('<img') && !figured.includes('remote.png'))
check('E7 a data:image src is kept as an img with the alt', render({ parts: [{ kind: 'figure', src: 'data:image/png;base64,AAAA', alt: 'a dot' }] }).includes('<img src="data:image/png;base64,AAAA" alt="a dot">'))
check('E8 svg that is not an inline <svg> is refused by name', thrown(() => normalizeSampleDoc({ parts: [{ kind: 'figure', svg: '<div>no</div>' }] })) === 'sample(): parts[0].svg must be an inline <svg>…</svg>')

section('D determinism: the ids the marks attach to')
check('D1 two renders of the same doc are byte-identical', render(fixture.review.doc, fixture.review.title) === reviewHtml && render(fixture.template.doc, fixture.template.title) === templateHtml)
const templateIds = ids(templateHtml)
check('D2 ids are assigned by position: part-N-<kind> for every block, part-0-header first, every id unique', templateIds[0] === 'glyph-field' && templateIds.includes('part-0-header') && ['part-1-verdict', 'part-2-section', 'part-3-cards', 'part-4-table', 'part-5-diff', 'part-6-terminal', 'part-7-figure', 'part-8-checklist', 'part-9-question'].every(id => templateIds.includes(id)) && new Set(templateIds).size === templateIds.length)
check('D3 the pin targets DESIGN names exist: a paragraph, a cell, a diff line, a terminal line, a checklist item, an option, a step', ['part-2-p-2', 'part-4-cell-1-4', 'part-5-a-1', 'part-6-line-6', 'part-8-item-3', 'part-9-opt-1'].every(id => templateIds.includes(id)) && ids(reviewHtml).includes('part-7-step-4'))
check('D4 moving a block moves its ids with it, so the same place keeps the same id across versions when the order holds', (() => {
  const a = render({ parts: [{ kind: 'section', heading: 'A', prose: 'x' }, { kind: 'checklist', items: ['[x] a'] }] })
  const b = render({ parts: [{ kind: 'checklist', items: ['[x] a'] }, { kind: 'section', heading: 'A', prose: 'x' }] })
  return a.includes('id="part-2-item-1"') && b.includes('id="part-1-item-1"') && a.includes('id="part-1-p-1"') && b.includes('id="part-2-p-1"')
})())

section('C the contrast floors from the design, on the emitted tokens')
function tokensOf(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)) out[m[1]!] = m[2]!.toLowerCase()
  return out
}
const rootBlock = theme.DOC_STYLE.slice(theme.DOC_STYLE.indexOf(':root {'), theme.DOC_STYLE.indexOf('}', theme.DOC_STYLE.indexOf(':root {')))
const lightBlock = theme.DOC_STYLE.slice(theme.DOC_STYLE.indexOf('html[data-theme="light"] {'), theme.DOC_STYLE.indexOf('}', theme.DOC_STYLE.indexOf('html[data-theme="light"] {')))
const dark = tokensOf(rootBlock)
const light = tokensOf(lightBlock)
function luminance(hex: string): number {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b)
  return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100
}
const darkText = ['cream', 'text', 'prose', 'muted', 'faint', 'accent', 'water-light', 'red-ink', 'ok', 'warn']
const darkGrounds = ['bg', 'bg-deep', 'panel']
const darkPairs = darkText.flatMap(t => darkGrounds.map(g => contrast(dark[t]!, dark[g]!)))
check('C1 dark surface: every text token clears 4.5:1 on the page, the deep well and the panel; the floor is faint on panel at 4.85', darkPairs.every(r => r >= 4.5) && Math.min(...darkPairs) === 4.85 && contrast(dark.faint!, dark.panel!) === 4.85, darkPairs.join(','))
check('C2 dark surface: the rule and border tokens clear 3:1 as non-text; line-ui on the panel is the 3.36 floor', contrast(dark.red!, dark.bg!) >= 3 && contrast(dark['line-ui']!, dark.panel!) === 3.36 && contrast(dark['line-ui']!, dark.bg!) >= 3)
const lightText = ['cream', 'text', 'prose', 'muted', 'faint', 'accent', 'red-ink', 'ok', 'warn']
const lightGrounds = [light.bg!, light['bg-deep']!, light.panel!, '#dfd4bc']
const lightPairs = lightText.flatMap(t => lightGrounds.map(g => contrast(light[t]!, g)))
check('C3 parchment: every text token clears 4.5:1 on the paper, the deeper sheet, the panel and the darkest fibre; the floor is faint on fibre at 5.01', lightPairs.every(r => r >= 4.5) && Math.min(...lightPairs) === 5.01 && contrast(light.faint!, '#dfd4bc') === 5.01, lightPairs.join(','))
check('C4 parchment: line-ui clears 3:1 everywhere, 3.47 on the darkest fibre', lightGrounds.every(g => contrast(light['line-ui']!, g) >= 3) && contrast(light['line-ui']!, '#dfd4bc') === 3.47)
check('C5 the terminal window: phosphor, dim, red, yellow and cyan on near-black and their bands clear 4.5:1; red on the bar is the 4.95 floor; the Copy border is 3.40', contrast(dark['tty-text']!, dark['tty-bg']!) >= 4.5 && contrast(dark['tty-dim']!, dark['tty-bg']!) >= 4.5 && contrast(dark['tty-del']!, dark['tty-bg']!) >= 4.5 && contrast(dark['tty-warn']!, dark['tty-bg']!) >= 4.5 && contrast(dark['tty-accent']!, dark['tty-bg']!) >= 4.5 && contrast(dark['tty-text']!, dark['tty-add-band']!) >= 4.5 && contrast(dark['tty-del']!, dark['tty-del-band']!) >= 4.5 && contrast(dark['tty-del']!, dark['tty-bar']!) === 4.95 && contrast(dark['tty-bar-text']!, dark['tty-bar']!) >= 4.5 && contrast(dark['tty-cmd']!, dark['tty-bar']!) >= 4.5 && contrast(dark['tty-btn-text']!, dark['tty-bar']!) >= 4.5 && contrast(dark['tty-btn-line']!, dark['tty-bar']!) === 3.4)
check('C6 the tokens are the site\'s: the page ground, the deep well, the hairline, the accent and the bone', dark.bg === '#090d16' && dark['bg-deep'] === '#050910' && dark['panel-line'] === '#232d44' && dark['slot-line'] === '#3b496a' && dark.accent === '#a4b4da' && dark.cream === '#ede8dd' && light.bg === '#ece2cc' && light.text === '#241c15')

section('T the words a model sees')
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.ts')
const promptOn = await (EvalTool as { prompt: () => Promise<string> }).prompt()
check('T1 with samples on the prompt carries the doc block: the sample line, the nine kinds, the closing rule', promptOn.includes(SAMPLE_PROMPT_LINES.join('\n')) && SAMPLE_PROMPT_LINES.length === 12 && promptOn.includes('sample({name, title?, doc, ask?})') && /1\. `\{ kind: "verdict"/.test(promptOn) && /9\. `\{ kind: "question"/.test(promptOn) && promptOn.includes('Write the parts, not the page: no HTML, no styles.'))
check('T2 the first sentence is the owner\'s rule, unchanged: only when asked, never unasked, never to decorate', SAMPLE_PROMPT_LINES[0] === '- `sample({name, title?, doc, ask?})` — keep a page as a sample: a versioned page the operator opens in the browser and marks up; returns `{id, title, version, url}` and the result lists it. ONLY when the operator asked to see something (a page, a design, a mockup, a report to look at, "show me") — never unasked, never to decorate an answer; pass the operator\'s words as `ask`. The same name publishes the next version.')
check('T3 no sentence invites a sample', !/\b(consider|feel free|proactive|encourag|whenever (useful|helpful|appropriate|possible)|you (may|might) want|should (make|keep|create|use)|is a good (way|idea)|great for|perfect for|ideal for|recommended for)\b/i.test(SAMPLE_PROMPT_LINES.join('\n')) && !/\bhtml\b(?! `?is refused)/i.test(SAMPLE_PROMPT_LINES.slice(1).join('\n').replace(/Raw `html` is refused/, '').replace(/no HTML, no styles/, '')))
delete process.env.MERCURY_SAMPLES
const promptOff = await (EvalTool as { prompt: () => Promise<string> }).prompt()
check('T4 with samples off the prompt has no line about samples', !promptOff.includes('sample') && !promptOff.includes('doc'))
process.env.MERCURY_SAMPLES = '1'

section('B the bridge road: what the store keeps is the rendered page')
const kept = await handleSampleCall(owner, { name: 'paginate-fix', ask: 'show me the fix', doc: (fixture.plain.payload as { doc: unknown }).doc })
check('B1 a doc through the bridge is kept as version 1 with the name as its title and the ask carried', kept.version === 1 && kept.title === 'paginate-fix' && kept.ask === 'show me the fix' && /^http:\/\/127\.0\.0\.1:\d+\/s\/[a-z0-9]+\?t=[0-9a-f]{32}$/.test(kept.url))
check('B2 v1.html on disk is the rendered page, byte for byte', store.readVersion(SESSION, kept.id, 1) === renderSampleDoc(normalizeSampleDoc((fixture.plain.payload as { doc: unknown }).doc), { title: 'paginate-fix' }))
const kept2 = await handleSampleCall(owner, { name: 'paginate-fix', doc: { title: 'paginate() off-by-one fix', parts: [{ kind: 'section', prose: 'v2' }] } })
check('B3 the same name is version 2 and doc.title names the sample when the call has no title', kept2.id === kept.id && kept2.version === 2 && kept2.title === 'paginate() off-by-one fix' && store.getSample(SESSION, kept.id)?.title === 'paginate() off-by-one fix')
const product = await keepSample(SESSION, { name: 'memory page', title: 'Memory', html: '<!doctype html><h1 id="own">the product\'s own page</h1>', source: 'product' })
check('B4 the product\'s own road still keeps html as written when the caller says so (source: product)', product.version === 1 && store.readVersion(SESSION, product.id, 1) === '<!doctype html><h1 id="own">the product\'s own page</h1>')
check('B5 /memory page is the one product caller and it declares its source', readFileSync(join(import.meta.dirname, '..', '..', 'src', 'commands', 'memory', 'memoryPage.ts'), 'utf8').includes("html, source: 'product' })"))
const both = specOf({ name: 'both', html: '<p>ignored</p>', doc: { parts: [{ kind: 'section', prose: 'doc wins' }] } })
check('B6 a call with both html and doc renders the doc and drops the html', both.html.includes('doc wins') && !both.html.includes('<p>ignored</p>'))

section('P the poison — the comparators bite')
check('P1 one missing node fails the reference comparison', firstDiff(skeleton(plainSpec.html).slice(1), fixture.plain.skeleton) !== '')
check('P2 one changed class fails it', firstDiff(skeleton(plainSpec.html.replace('class="table-cell cell-ok"', 'class="table-cell cell-warn"')), fixture.plain.skeleton) !== '')
check('P3 a darker faint fails the dark floor', contrast('#6a7384', dark.panel!) < 4.85)
check('P4 the old refusal is not the new one', !/needs the page as html/.test(SAMPLE_DOC_REFUSAL))
check('P5 the stylesheet digest bites on one byte', sha(theme.DOC_STYLE.trim() + ' ') !== fixture.styleSha256)

await listener.closeSampleListener()
await disposeOwner(owner)

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ samples doc: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ samples doc: every law holds')
process.exit(0)
