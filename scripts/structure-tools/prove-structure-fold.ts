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
const steering = await import(join(REPO, 'src/services/projectIntel/steering.ts'))
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
  check('replacement owns original-node substitution and insertion placement', schema.input_schema.properties.replacement.description.includes('$TEXT in replace is the original node') && schema.input_schema.properties.replacement.description.includes('own line at the node boundary'))
  for (const tools of [[AstSearchTool, AstEditTool], [AstSearchTool], [AstEditTool], []]) {
    const text = await StructureTool.prompt({ ...options, tools: [StructureTool, ...tools] as never })
    check('Structure describes its own queries and previewed writes under 250 bytes', text.includes('Queries return match ids; previews return plans without writing.') && text.includes('unchanged sources and valid syntax') && Buffer.byteLength(text) <= 250)
    check('offered companions do not add sibling-tool routing or a second operation schema', !/AstSearch|AstEdit|LspRename|Inspect|op:"|Selects:/.test(text))
  }
  check('rename is token-only in its field, not a semantic rename claim', schema.input_schema.properties.to.description.includes('rename changes the token, not every symbol reference'))
  check('the file field owns the accepted extensions', schema.input_schema.properties.files.description.includes('.js/.jsx/.mjs/.cjs/.ts/.mts/.cts/.tsx'))
  for (const [tool, companion] of [[AstSearchTool, AstEditTool], [AstEditTool, AstSearchTool]] as const) {
    const alone = await toolToAPISchema(tool as never, { ...options, tools: [tool] as never }) as any
    const together = await toolToAPISchema(tool as never, options) as any
    check(`${tool.name}: names no companion whatever the pool offers, and its text is the same alone or together`, !alone.description.includes(companion.name) && !together.description.includes(companion.name) && alone.description === together.description)
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
    check('removed action and field use generic enum and unknown-key errors', mixed.isError && mixed.text.includes('Parameter `action` must be one of:') && mixed.text.includes('The parameter `out` was not expected') && !mixed.text.includes('"rewrite"') && !/AstSearch|AstEdit/.test(mixed.text), mixed.text)
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
  check('no steering lines ride Grep or Edit: the search and edit steering functions are gone (no tool describes another)', !('searchSteeringLine' in steering) && !('editSteeringLine' in steering))
  check('AstEdit and AstSearch both stay deferred, neither loaded in full on cloud', AstEditTool.shouldDefer === true && !AstEditTool.loadInFullOnCloud && AstSearchTool.shouldDefer === true && !AstSearchTool.loadInFullOnCloud)
  for (const [tool, ceiling] of [[StructureTool, 2600], [AstSearchTool, 3659], [AstEditTool, 3050]] as const) {
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
  const live = await toolToAPISchema(StructureTool as never, { ...options, deferLoading: true }) as any
  const resumeWith = async (latch: string, inputSchema: unknown): Promise<{ key: string; definition: string; plan: any; restored: any }> => {
    const key = conversationRosterKey(latch, [first], model)
    const definition = JSON.stringify({ name: 'Structure', description: 'saved definition', input_schema: inputSchema, defer_loading: true })
    const record = createAttachmentMessage({ type: 'bound_prefix', boundKey: key, rosterEnabled: true, roster: [{ name: 'Structure', deferred: true, definition }], sections: [], systemContext: {} })
    clearToolRosterLatches()
    clearToolRosterRestore()
    restoreBoundPrefixFromMessages([first, record], { rosterOnly: true })
    const plan = await planToolPayload({ model, tools: [StructureTool, ToolSearchTool] as never, messages: [first, record], latchKey: latch, getToolPermissionContext: async () => permission, agents: [] })
    const restored = await toolToAPISchema(StructureTool as never, { ...options, conversationKey: key, deferLoading: plan.deferredNames.has('Structure') })
    return { key, definition, plan, restored }
  }
  const kept = await resumeWith('ast-resume', live.input_schema)
  check('resume replays the recorded Structure definition and deferred mark byte-for-byte', getConversationToolSchemas(kept.key).get('Structure') === kept.definition && JSON.stringify(kept.restored) === kept.definition && kept.plan.deferredNames.has('Structure'))
  const moved = await resumeWith('ast-resume-moved', { type: 'object', properties: { op: { type: 'string' }, pattern: { type: 'string' }, lang: { type: 'string' }, out: { type: 'string' } }, required: ['op'], additionalProperties: false })
  check('a bound Structure definition replays byte-for-byte even when its input schema changed', JSON.stringify(moved.restored) === moved.definition && getConversationToolSchemas(moved.key).get('Structure') === moved.definition && moved.plan.deferredNames.has('Structure'), JSON.stringify(moved.restored).slice(0, 300))
  const unbound = await toolToAPISchema(StructureTool as never, { ...options, conversationKey: moved.key, deferLoading: true, bound: false }) as any
  const markKept = toolReferenceWireAccepted() ? unbound.defer_loading === true : unbound.defer_loading === undefined
  check('an unreferenced deferred Structure takes the live schema and keeps its deferred mark', JSON.stringify(unbound.input_schema) === JSON.stringify(live.input_schema) && unbound.description === live.description && markKept && getConversationToolSchemas(moved.key).get('Structure') === JSON.stringify(unbound), JSON.stringify(unbound).slice(0, 300))
  clearToolRosterLatches()
  clearToolRosterRestore()
} finally {
  process.chdir(REPO)
  for (const dir of [root, env.home, env.engineDir]) rmSync(dir, { recursive: true, force: true })
}
finish('STRUCTURE SELECT FOLD')
