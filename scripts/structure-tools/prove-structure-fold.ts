import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, REPO } from '../ast-tools/lib/harness.ts'

const env = armEnvironment()
const { StructureTool } = await import(join(REPO, 'src/tools/StructureTool/StructureTool.ts'))
const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { STRUCTURE_SELECTS } = await import(join(REPO, 'src/services/structure/contracts.ts'))
const { toolToAPISchema } = await import(join(REPO, 'src/utils/api.ts'))
const { toolReferenceWireAccepted } = await import(join(REPO, 'src/services/providers/deferralWire.ts'))
const { getEmptyToolPermissionContext } = await import(join(REPO, 'src/Tool.ts'))
const { searchSteeringLine, editSteeringLine } = await import(join(REPO, 'src/services/projectIntel/steering.ts'))
const { getConversationToolSchemas } = await import(join(REPO, 'src/utils/toolSchemaCache.ts'))
const { restoreBoundPrefixFromMessages } = await import(join(REPO, 'src/services/providers/anthropic/boundPrefixRecord.ts'))
const { clearToolRosterLatches, clearToolRosterRestore, planToolPayload, conversationRosterKey } = await import(join(REPO, 'src/services/providers/toolEconomy.ts'))
const { createUserMessage } = await import(join(REPO, 'src/utils/messages.ts'))
const { createAttachmentMessage } = await import(join(REPO, 'src/utils/attachments/orchestrator.ts'))
const { getEngineModel } = await import(join(REPO, 'src/utils/model/model.ts'))
const { ToolSearchTool } = await import(join(REPO, 'src/tools/ToolSearchTool/ToolSearchTool.ts'))
const root = mkdtempSync(join(tmpdir(), 'structure-fold-'))
const pool = [StructureTool, AstSearchTool, AstEditTool]
const permission = getEmptyToolPermissionContext()
const options = { getToolPermissionContext: async () => permission, tools: pool as never, agents: [] }
try {
  await enterRoot(root)
  const schema = await toolToAPISchema(StructureTool as never, options) as any
  const expectedKeys = ['op', 'select', 'name', 'callee', 'module', 'value', 'within', 'files', 'limit', 'queryId', 'matchIds', 'replacement', 'to', 'newModule', 'newValue', 'previewId', 'matchId', 'action']
  const actions = ['replace', 'rename', 'remove', 'replace-import', 'replace-callee', 'set-value', 'insert-before', 'insert-after']
  check('Structure has exactly the 18 select fields in order', JSON.stringify(Object.keys(schema.input_schema.properties)) === JSON.stringify(expectedKeys), Object.keys(schema.input_schema.properties).join(','))
  check('Structure requires only op and rejects additional properties', JSON.stringify(schema.input_schema.required) === '["op"]' && schema.input_schema.additionalProperties === false)
  check('Structure has exactly eight select transformations', JSON.stringify(schema.input_schema.properties.action.enum) === JSON.stringify(actions))
  check('replacement names replace and the insertion actions', schema.input_schema.properties.replacement.description === 'preview replace · insert-before · insert-after: the new text ($TEXT, in replace, is the original node)')
  const rest = `JS/TS questions by node kind — imports by module, calls by dotted callee, declarations by kind and name, a node inside a named class or function — and for a rename, import swap, callee swap or property value that must land as one previewed change.`
  const operations = `\n\n1. op:"query" (select, filters…) — a bounded AST query. Selects: ${STRUCTURE_SELECTS.join(' · ')}. Filters: name (exact or glob with *), callee ('fs.*'), module, value, within ('class:Name'), files (globs relative to the project root), limit (default 50, max 200). Only .js .jsx .mjs .cjs .ts .mts .cts .tsx files are read. Returns stable match ids (sm-…) and the record mercury://structure/query/<id>.
2. op:"preview" (action, queryId?, matchIds?) — writes nothing; shows the files, the match count and each edit's first line before and after (8 per file, the rest counted). Actions: replace (replacement; $TEXT is the original node) · rename (to — the name token only) · remove · insert-before/insert-after (replacement — new text on its own line at the node's boundary) · replace-import (newModule) · replace-callee (to) · set-value (newValue).
3. op:"apply" (previewId) — refuses if a file changed since the preview or the result would not parse; writes atomically with rollback, verifies by re-reading, reruns parse diagnostics, and reports a partial application as a failure.
4. op:"explain" (matchId, queryId?) — the AST ancestry of one match.

Records: mercury://structure/query/<id> · mercury://structure/preview/<id> (Inspect).`
  for (const [tools, lead] of [
    [[AstSearchTool, AstEditTool], 'To find code by its shape in any language use AstSearch, and AstEdit to rewrite every match; use this tool for'],
    [[AstSearchTool], 'To find code by its shape in any language use AstSearch; use this tool for'],
    [[AstEditTool], 'To rewrite every match of a code shape in any language use AstEdit; use this tool for'],
    [[], 'Use it for'],
  ] as const) {
    const text = await StructureTool.prompt({ ...options, tools: [StructureTool, ...tools] as never })
    const expected = `Structural queries by node kind, and previewed, stale-safe codemods, over JS/TS/JSX/TSX only, on the TypeScript compiler's syntax tree. ${lead} ${rest}${operations}`
    check(`Structure exact description with ${tools.map(t => t.name).join(',') || 'no Ast companions'}`, text === expected)
    check('Structure prompt carries no duplicate-lane or unprinted-anchor claim', !/POLYGLOT|pattern lane|SYMBOL ADDRESSING|metavariable|expected anchors/.test(text))
  }
  for (const [tool, companion] of [[AstSearchTool, AstEditTool], [AstEditTool, AstSearchTool]] as const) {
    const alone = await toolToAPISchema(tool as never, { ...options, tools: [tool] as never }) as any
    const together = await toolToAPISchema(tool as never, options) as any
    check(`${tool.name}: schema cache and prompt advertise only an offered companion`, !alone.description.includes(companion.name) && together.description.includes(companion.name))
    const expected = tool.name === 'AstSearch' ? ['pattern', 'path', 'glob', 'lang', 'mode', 'limit', 'offset'] : ['pattern', 'rewrite', 'path', 'glob', 'lang', 'apply', 'plan']
    check(`${tool.name}: the seven-field contract stays intact`, JSON.stringify(Object.keys(alone.input_schema.properties)) === JSON.stringify(expected) && alone.input_schema.additionalProperties === false)
  }
  for (const tools of [pool, [StructureTool]]) {
    const prover = await makeContext(tools)
    for (const field of ['pattern', 'lang', 'out']) {
      const removed = await drive(StructureTool, { op: 'query', select: 'function', [field]: 'value' }, prover)
      const nonsense = await drive(StructureTool, { op: 'query', select: 'function', nonsense: 'value' }, prover)
      check(`${field} is the same unknown-input road as nonsense (${tools.length} tools)`, removed.isError && nonsense.isError && removed.text.replaceAll(`\`${field}\``, '`nonsense`') === nonsense.text && !/AstSearch|AstEdit|moved to/.test(removed.text), removed.text)
    }
    const mixed = await drive(StructureTool, { op: 'preview', action: 'rewrite', out: 'logging.info($X)' }, prover)
    check('removed action and field use generic enum and unknown-key errors', mixed.isError && mixed.text.includes('The parameter `action` must be one of the following values:') && mixed.text.includes('The parameter `out` was not expected') && !mixed.text.includes('"rewrite"') && !/AstSearch|AstEdit/.test(mixed.text), mixed.text)
    const scoped = await drive(StructureTool, { op: 'query', select: 'class', name: 'Store', files: ['src/**/*.rs'] }, prover)
    const expected = 'Structure reads only .js .jsx .mjs .cjs .ts .mts .cts .tsx files, and every files glob here ends in another extension (src/**/*.rs)' + (tools.length > 1 ? '. For another language call AstSearch with lang; a symbol by name is its declaration: {"pattern": "def process_order($$$ARGS): $$$BODY", "lang": "python"}.' : '; this session offers no structural search for other languages.')
    check('non-JS/TS-only scope refuses before its walk with the offered-tool wording', scoped.isError && scoped.text === `<tool_use_error>${expected}</tool_use_error>`, scoped.text)
  }
  writeFileSync(join(root, 'calls.ts'), Array.from({ length: 12 }, (_, i) => `fetchJson(${i})`).join('\n') + '\n')
  const prover = await makeContext(pool)
  const query = await drive(StructureTool, { op: 'query', select: 'call', callee: 'fetchJson', files: ['calls.ts'] }, prover)
  check('select query still finds twelve calls', !query.isError && query.text.includes('12 match(es)'), query.text)
  const preview = await drive(StructureTool, { op: 'preview', action: 'replace-callee', to: 'getJson' }, prover)
  check('preview shows eight pairs and counts the four omitted edits', !preview.isError && (preview.text.match(/^    - /gm) ?? []).length === 8 && preview.text.includes('    … +4 more edit(s) in this file, not shown — apply writes all 12'), preview.text)
  const previewId = /^sp-[a-f0-9]+/.exec(preview.text)?.[0]
  const applied = await drive(StructureTool, { op: 'apply', previewId: previewId ?? 'missing' }, prover)
  check('select apply still writes all twelve edits', !applied.isError && (readFileSync(join(root, 'calls.ts'), 'utf8').match(/getJson/g) ?? []).length === 12, applied.text)
  writeFileSync(join(root, 'helpers.ts'), 'export function helper(): void {}\n')
  for (const [action, insertion, expected] of [
    ['insert-before', 'const marker = true', 'const marker = true\nexport function helper(): void {}\n'],
    ['insert-after', 'const after = true', 'const marker = true\nexport function helper(): void {}\nconst after = true\n'],
  ]) {
    const selected = await drive(StructureTool, { op: 'query', select: 'function', name: 'helper', files: ['helpers.ts'] }, prover)
    const proposed = await drive(StructureTool, { op: 'preview', action, replacement: insertion }, prover)
    const id = /^sp-[a-f0-9]+/.exec(proposed.text)?.[0]
    const applied = await drive(StructureTool, { op: 'apply', previewId: id }, prover)
    const view = proposed.data?.changeView as { files?: Array<{ hunks: unknown[] }> } | undefined
    check(`select ${action} keeps the intact node and carries real hunks`, !selected.isError && !proposed.isError && !applied.isError && (view?.files?.[0]?.hunks.length ?? 0) > 0 && readFileSync(join(root, 'helpers.ts'), 'utf8') === expected, applied.text)
  }
  const absent = await drive(StructureTool, { op: 'apply', previewId: 'sp-000000000000' }, prover)
  check('absent preview names its process lifetime and the next step', absent.isError && absent.text === "apply refused [absent]: no preview 'sp-000000000000' in this conversation — previews live only in the process that made them, 16 at a time; run the query and the preview again", absent.text)
  const queryModule = await import(join(REPO, 'src/services/structure/polyglotQuery.ts'))
  check('duplicate pattern and symbol pipelines do not exist', !existsSync(join(REPO, 'src/services/structure/polyglotSymbols.ts')) && !existsSync(join(REPO, 'src/services/structure/polyglotTransform.ts')) && !('runPolyglotQuery' in queryModule) && !('relocatePatternMatches' in queryModule))
  check('the shared walker, ignores and compiler stay exported', ['discoverPolyglotFiles', 'loadRootIgnoreRules', 'compileFor'].every(key => typeof (queryModule as any)[key] === 'function'))
  check('search steering names only the offered shape owner', searchSteeringLine(new Set(['AstSearch'])) === '  - Semantic shortcut: for code by its shape, AstSearch matches the parse tree rather than the text.' && searchSteeringLine(new Set(['Structure'])) === null)
  check('edit steering names only the offered rewrite owner', editSteeringLine(new Set(['AstEdit'])) === 'Semantic shortcut: one rewrite at every match of a code shape belongs to AstEdit (dry run, then apply).' && editSteeringLine(new Set(['Structure'])) === null)
  check('AstEdit stays deferred and AstSearch loads in full', AstEditTool.shouldDefer === true && !AstEditTool.loadInFullOnCloud && AstSearchTool.loadInFullOnCloud === true)
  for (const [tool, ceiling] of [[StructureTool, 4219], [AstSearchTool, 3659], [AstEditTool, 3050]] as const) {
    const wire = await toolToAPISchema(tool as never, { ...options, deferLoading: tool.name !== 'AstSearch' }) as any
    const bytes = Buffer.byteLength(JSON.stringify(wire))
    const reference = { ...wire }
    if (tool.name === 'AstEdit') delete reference.defer_loading
    const referenceBytes = Buffer.byteLength(JSON.stringify(reference))
    check(`${tool.name}: reference definition <= ${ceiling} bytes`, referenceBytes <= ceiling, `${referenceBytes} reference bytes; ${bytes} wire bytes`)
    if (tool.name === 'AstEdit') {
      if (toolReferenceWireAccepted()) check('AstEdit retains exactly the inherited 21-byte defer mark on the block-form wire', wire.defer_loading === true && bytes - referenceBytes === 21, `${bytes - referenceBytes} mark bytes`)
      else check('AstEdit carries no defer mark on a text-form wire (the mark rides the block form only)', wire.defer_loading === undefined && bytes === referenceBytes, `${bytes - referenceBytes} mark bytes`)
    }
    console.log(`DEFINITION ${tool.name} ${referenceBytes} reference bytes; ${bytes} wire bytes`)
  }
  const first = createUserMessage({ content: 'resume fixture' })
  const model = getEngineModel()
  const key = conversationRosterKey('ast-resume', [first], model)
  const definition = JSON.stringify({ name: 'Structure', description: 'saved definition', input_schema: { type: 'object', properties: { op: { type: 'string' }, pattern: { type: 'string' }, lang: { type: 'string' }, out: { type: 'string' } }, required: ['op'], additionalProperties: false }, defer_loading: true })
  const record = createAttachmentMessage({ type: 'bound_prefix', boundKey: key, rosterEnabled: true, roster: [{ name: 'Structure', deferred: true, definition }], sections: [], systemContext: {} })
  clearToolRosterLatches()
  clearToolRosterRestore()
  restoreBoundPrefixFromMessages([first, record], { rosterOnly: true })
  const plan = await planToolPayload({ model, tools: [StructureTool, ToolSearchTool] as never, messages: [first, record], latchKey: 'ast-resume', getToolPermissionContext: async () => permission, agents: [] })
  const restored = await toolToAPISchema(StructureTool as never, { ...options, conversationKey: key, deferLoading: plan.deferredNames.has('Structure') })
  check('resume replays the recorded Structure definition and deferred mark byte-for-byte', getConversationToolSchemas(key).get('Structure') === definition && JSON.stringify(restored) === definition && plan.deferredNames.has('Structure'))
  clearToolRosterLatches()
  clearToolRosterRestore()
} finally {
  process.chdir(REPO)
  for (const dir of [root, env.home, env.engineDir]) rmSync(dir, { recursive: true, force: true })
}
finish('STRUCTURE SELECT FOLD')
