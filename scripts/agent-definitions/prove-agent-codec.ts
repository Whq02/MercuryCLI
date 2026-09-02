/**
 * the lossless codec proof.
 *
 * Byte-level golden fixtures over decodeAgentDocument / patchAgentDocument /
 * serializeAgentMarkdown: every supported field, unknown + nested passthrough,
 * comments/order/quotes/block scalars/unicode/CRLF, one-field edits that
 * byte-preserve everything else, invalid values with line locations, future
 * spec-version passthrough, and the fail-closed patch verifier.
 */
import {
  decodeAgentDocument,
  patchAgentDocument,
  serializeAgentMarkdown,
} from '../../src/services/agents/codec.js'
import { AgentCodecPatchError, revisionDigest } from '../../src/services/agents/contracts.js'

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── G1: every supported field decodes ───────────────────────────────────────
const FULL = `---
name: full-agent
description: "Use this agent when everything.\\\\nSecond line."
tools: Read, Grep, Glob
disallowedTools: Bash
skills: alpha, beta
model: opus[1m]
effort: xhigh
permissionMode: acceptEdits # deliberately the RETIRED spelling — decode must alias it to 'implement'
maxTurns: 12
memory: project
background: true
isolation: worktree
initialPrompt: "start here"
instructionProfile: native
color: cyan
mcpServers:
  - slack
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: echo hi
---

You are the full agent.

Second paragraph.
`
{
  console.log('G1: full-field decode')
  const doc = decodeAgentDocument(FULL, '/x/full-agent.md')
  const f = doc.fields
  check('name', f.name === 'full-agent')
  check(
    'description unescaped',
    f.description === 'Use this agent when everything.\nSecond line.',
    JSON.stringify(f.description),
  )
  check('tools', JSON.stringify(f.tools) === '["Read","Grep","Glob"]')
  check('disallowedTools', JSON.stringify(f.disallowedTools) === '["Bash"]')
  check('skills', JSON.stringify(f.skills) === '["alpha","beta"]')
  check('model', f.model === 'opus[1m]')
  check('effort', f.effort === 'xhigh')
  check('permissionMode', f.permissionMode === 'implement')
  check('maxTurns', f.maxTurns === 12)
  check('memory', f.memory === 'project')
  check('background', f.background === true)
  check('isolation', f.isolation === 'worktree')
  check('initialPrompt', f.initialPrompt === 'start here')
  check('instructionProfile', f.instructionProfile === 'native')
  check('color', f.color === 'cyan')
  check('mcpServers preserved', Array.isArray(f.mcpServers) && f.mcpServers.length === 1)
  check('hooks preserved', f.hooks !== undefined)
  // parseFrontmatter's fence regex consumes the blank separator after the
  // closing fence — `body` starts at the first content byte (loader parity).
  check('body verbatim', doc.body === 'You are the full agent.\n\nSecond paragraph.\n')
  check('no unknown keys', doc.unknownKeys.length === 0, doc.unknownKeys.join(','))
  check('no error diagnostics', doc.diagnostics.every(d => d.severity !== 'error'),
    JSON.stringify(doc.diagnostics))
}

// ── G2: unknown keys, comments, order, quotes, block scalars, unicode ───────
const GNARLY = `---
# The reviewer agent — do not rename.
name: gnarly
x-team-owner: "platform ✓ 团队"
description: 'single quoted'
# tools comment sits above tools
tools:
  - Read
  - Grep
custom-nested:
  depth:
    - one
    - two
notes: |
  a block scalar
  with two lines
model: sonnet
---

Body with unicode — ✓ 你好.
`
{
  console.log('G2: unknown/comment/order/quote/block-scalar/unicode decode')
  const doc = decodeAgentDocument(GNARLY, '/x/gnarly.md')
  check('name', doc.fields.name === 'gnarly')
  check('block-seq tools', JSON.stringify(doc.fields.tools) === '["Read","Grep"]')
  check(
    'unknown keys preserved',
    JSON.stringify([...doc.unknownKeys].sort()) ===
      JSON.stringify(['custom-nested', 'notes', 'x-team-owner']),
    doc.unknownKeys.join(','),
  )
  check('raw survives byte-for-byte', doc.raw === GNARLY)

  // One-field edit: model sonnet → opus. Everything else byte-preserved.
  const patched = patchAgentDocument(doc, { set: { model: 'opus' } })
  check('patched model decodes', patched.fields.model === 'opus')
  check(
    'edit is the ONLY byte change',
    patched.raw === GNARLY.replace('model: sonnet', 'model: opus'),
  )
  check('comments survive', patched.raw.includes('# tools comment sits above tools'))
  check('unknown nested survives', patched.raw.includes('custom-nested:\n  depth:'))
  check('block scalar survives', patched.raw.includes('notes: |\n  a block scalar'))
  check('unicode body survives', patched.raw.includes('Body with unicode — ✓ 你好.'))

  // Block-seq style is re-emitted in kind.
  const retooled = patchAgentDocument(doc, { set: { tools: ['Read', 'Edit', 'Write'] } })
  check(
    'block-seq re-emitted in kind',
    retooled.raw.includes('tools:\n  - Read\n  - Edit\n  - Write'),
    JSON.stringify(retooled.raw),
  )
  check('tools comment kept on retool', retooled.raw.includes('# tools comment sits above tools'))
  check('retooled decodes', JSON.stringify(retooled.fields.tools) === '["Read","Edit","Write"]')
}

// ── G3: CRLF preservation ───────────────────────────────────────────────────
const CRLF = '---\r\nname: crlf-agent\r\ndescription: "windows file"\r\nmodel: sonnet\r\n---\r\n\r\nBody line.\r\n'
{
  console.log('G3: CRLF')
  const doc = decodeAgentDocument(CRLF, '/x/crlf-agent.md')
  check('newline detected', doc.newline === '\r\n')
  check('decodes', doc.fields.name === 'crlf-agent' && doc.fields.model === 'sonnet')
  const patched = patchAgentDocument(doc, { set: { model: 'opus' } })
  check(
    'CRLF edit preserves every other CRLF byte',
    patched.raw === CRLF.replace('model: sonnet\r\n', 'model: opus\r\n'),
    JSON.stringify(patched.raw),
  )
  const added = patchAgentDocument(doc, { set: { color: 'red' } })
  check('new key gets CRLF too', added.raw.includes('color: red\r\n'), JSON.stringify(added.raw))
}

// ── G4: field add / remove / empty values ───────────────────────────────────
{
  console.log('G4: add/remove/empty')
  const base = decodeAgentDocument(
    '---\nname: lean\ndescription: "d"\nmemory: user\n---\n\nBody.\n',
  )
  const withEffort = patchAgentDocument(base, { set: { effort: 'high', maxTurns: 3 } })
  check('added effort', withEffort.fields.effort === 'high')
  check('added maxTurns', withEffort.fields.maxTurns === 3)
  check('memory untouched', withEffort.fields.memory === 'user')
  const removed = patchAgentDocument(withEffort, { remove: ['memory'] })
  check('memory removed', removed.fields.memory === undefined)
  check('effort survives removal', removed.fields.effort === 'high')
  const noTools = patchAgentDocument(base, { set: { tools: [] } })
  check('empty tools list = none', JSON.stringify(noTools.fields.tools) === '[]')
  const bodyEdit = patchAgentDocument(base, { body: 'New body.\n' })
  check('body replaced', bodyEdit.body === 'New body.\n')
  check('frontmatter untouched on body edit',
    bodyEdit.raw.startsWith('---\nname: lean\ndescription: "d"\nmemory: user\n---\n'))
}

// ── G5: invalid values → diagnostics with locations, never coercion ─────────
{
  console.log('G5: invalid-value diagnostics')
  const doc = decodeAgentDocument(
    '---\nname: broken\ndescription: "d"\neffort: enormous\nmemory: galactic\nmaxTurns: -2\npermissionMode: yolo\n---\n\nBody.\n',
  )
  const codes = doc.diagnostics.map(d => d.code)
  check('invalid-effort flagged', codes.includes('invalid-effort'))
  check('invalid-memory flagged', codes.includes('invalid-memory'))
  check('invalid-max-turns flagged', codes.includes('invalid-max-turns'))
  check('invalid-permission-mode flagged', codes.includes('invalid-permission-mode'))
  check('fields not coerced',
    doc.fields.effort === undefined && doc.fields.memory === undefined &&
    doc.fields.maxTurns === undefined && doc.fields.permissionMode === undefined)
  const effortDiag = doc.diagnostics.find(d => d.code === 'invalid-effort')
  check('effort diagnostic carries its line', effortDiag?.line === 4, String(effortDiag?.line))
  const missing = decodeAgentDocument('just a plain file\n')
  check('missing frontmatter flagged',
    missing.diagnostics.some(d => d.code === 'missing-frontmatter'))
  const unterminated = decodeAgentDocument('---\nname: x\nno closing fence\n')
  check('unterminated frontmatter flagged',
    unterminated.diagnostics.some(d => d.code === 'unterminated-frontmatter'))
}

// ── G6: future spec-version passthrough ─────────────────────────────────────
{
  console.log('G6: spec-version')
  const doc = decodeAgentDocument(
    '---\nname: tomorrow\ndescription: "d"\nspec-version: 3\nfrom-the-future: [a, b]\n---\n\nBody.\n',
  )
  check('future version decoded', doc.fields.specVersion === 3)
  check('flagged info, not error',
    doc.diagnostics.some(d => d.code === 'future-spec-version' && d.severity === 'info'))
  const patched = patchAgentDocument(doc, { set: { model: 'sonnet' } })
  check('future keys survive edits',
    patched.raw.includes('spec-version: 3') && patched.raw.includes('from-the-future: [a, b]'))
}

// ── G7: fail-closed patch verification ──────────────────────────────────────
{
  console.log('G7: fail-closed patcher')
  const doc = decodeAgentDocument('---\nname: safe\ndescription: "d"\nmcpServers:\n  - slack\n---\n\nB.\n')
  let threw = false
  try {
    patchAgentDocument(doc, { set: { mcpServers: [{ x: {} }] } })
  } catch (e) {
    threw = e instanceof AgentCodecPatchError
  }
  check('nested field patch refuses (raw view owns it)', threw)
  // Quoting hazard: a description full of YAML specials must round-trip.
  const hazard = patchAgentDocument(doc, {
    set: { description: 'globs like **/*.{ts,tsx} and "quotes" and #comment: yes\nline2' },
  })
  check(
    'hazardous description round-trips exactly',
    hazard.fields.description ===
      'globs like **/*.{ts,tsx} and "quotes" and #comment: yes\nline2',
    JSON.stringify(hazard.fields.description),
  )
}

// ── G8: fresh serialization round-trips through the same decoder ────────────
{
  console.log('G8: fresh serialize')
  const rawOut = serializeAgentMarkdown(
    {
      name: 'fresh-agent',
      description: 'Use when fresh.\nWith a second line.',
      tools: ['Read', 'Grep'],
      model: 'opus[1m]',
      effort: 'max',
      memory: 'user',
      color: 'blue',
    },
    'You are fresh.',
  )
  const doc = decodeAgentDocument(rawOut, '/x/fresh-agent.md')
  check('serialized decodes clean', doc.diagnostics.every(d => d.severity !== 'error'),
    JSON.stringify(doc.diagnostics))
  check('round-trip name', doc.fields.name === 'fresh-agent')
  check('round-trip description', doc.fields.description === 'Use when fresh.\nWith a second line.')
  check('round-trip tools', JSON.stringify(doc.fields.tools) === '["Read","Grep"]')
  check('round-trip model quoted safely', doc.fields.model === 'opus[1m]')
  check('round-trip effort', doc.fields.effort === 'max')
  check('body present', doc.body.includes('You are fresh.'))
  let threwNested = false
  try {
    serializeAgentMarkdown({ name: 'x', description: 'd', hooks: {} }, 'b')
  } catch (e) {
    threwNested = e instanceof AgentCodecPatchError
  }
  check('fresh serialize refuses nested authorship', threwNested)
}

// ── G9: revision digest stability ───────────────────────────────────────────
{
  console.log('G9: revision digest')
  check('deterministic', revisionDigest(FULL) === revisionDigest(FULL))
  check('content-sensitive', revisionDigest(FULL) !== revisionDigest(FULL + ' '))
  check('16 hex chars', /^[0-9a-f]{16}$/.test(revisionDigest('x')))
}

// ── G10: FC-142 — a malformed tools restriction never widens ────────────────
{
  console.log('G10: FC-142 — malformed tools: forgive the natural spellings, refuse the unreadable')
  const doc = (tools: string, extra = ''): ReturnType<typeof decodeAgentDocument> =>
    decodeAgentDocument(
      `---\nname: t\ndescription: d\n${tools}\n${extra}---\nbody\n`,
      't.md',
    )

  const boolFalse = doc('tools: false')
  check(
    'tools: false ⇒ NO tools (the natural no-tools spelling, not the widest grant)',
    JSON.stringify(boolFalse.fields.tools) === '[]' &&
      boolFalse.diagnostics.every(d => d.severity !== 'error'),
    JSON.stringify(boolFalse.fields.tools),
  )
  const boolTrue = doc('tools: true')
  check(
    'tools: true ⇒ all tools (explicit), no error',
    boolTrue.fields.tools === undefined && boolTrue.diagnostics.every(d => d.severity !== 'error'),
  )
  const mapping = doc('tools:\n  Read:\n  Grep:')
  check(
    'the trailing-colon YAML-mapping typo ⇒ its keys land as the list',
    JSON.stringify(mapping.fields.tools) === '["Read","Grep"]' &&
      mapping.diagnostics.every(d => d.severity !== 'error'),
    JSON.stringify(mapping.fields.tools),
  )
  const numeric = doc('tools: 3')
  check(
    'tools: <number> ⇒ ERROR diagnostic refuses the definition (invalid-tools)',
    numeric.diagnostics.some(d => d.severity === 'error' && d.code === 'invalid-tools'),
    JSON.stringify(numeric.diagnostics.map(d => d.code)),
  )
  check('… and no tools field is populated from it', numeric.fields.tools === undefined)
  const mixed = doc('tools: [Read, 5]')
  check(
    'a list with a non-string entry ⇒ ERROR (leaf-pruning an allow narrows but a deny would widen — refuse both)',
    mixed.diagnostics.some(d => d.severity === 'error' && d.code === 'invalid-tools'),
  )
  const badDeny = doc('tools: Read', 'disallowedTools: 7\n')
  check(
    'disallowedTools: <number> ⇒ ERROR (invalid-disallowed-tools)',
    badDeny.diagnostics.some(d => d.severity === 'error' && d.code === 'invalid-disallowed-tools'),
    JSON.stringify(badDeny.diagnostics.map(d => d.code)),
  )
  const cleanList = doc('tools: [Read, Grep]')
  check(
    'a clean list still decodes verbatim (control)',
    JSON.stringify(cleanList.fields.tools) === '["Read","Grep"]' &&
      cleanList.diagnostics.every(d => d.severity !== 'error'),
  )
  // THE ABSENT KEY IS ALL TOOLS — the codec's oldest law, and the one the
  // narrow-never-widen arm must not swallow: an unreadable PRESENT value
  // narrows to no tools, but a MISSING `tools:` line is no restriction at
  // all. (The regression: the unreadable-primitive arm caught `undefined`
  // too, so every definition without a tools line — the studio's fresh
  // document, every discovered agent file that names none — loaded with
  // NO tools and the form read "none" where it had read "all tools".)
  const absent = doc('')
  check(
    'NO tools line ⇒ all tools (fields.tools undefined), no diagnostic',
    absent.fields.tools === undefined && absent.diagnostics.every(d => d.severity !== 'error'),
    JSON.stringify(absent.fields.tools),
  )
  const fresh = decodeAgentDocument(serializeAgentMarkdown({ name: '', description: '' }, ''))
  check(
    "the studio's fresh document (encoder ⇒ decoder) is all tools, never none",
    fresh.fields.tools === undefined,
    JSON.stringify(fresh.fields.tools),
  )
  const emptyLine = doc('tools:')
  check('… while an EMPTY `tools:` line stays NO tools (the encoder\'s empty-list spelling)', JSON.stringify(emptyLine.fields.tools) === '[]')
}

if (failures > 0) {
  console.error(`\n${failures} codec check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll codec checks pass.')
