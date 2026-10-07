import { armScratch, check, cleanup, finish } from './lspProofDoor.ts'

const scratch = armScratch('lsp-split-catalogue')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getEngineModel } = await import('../../src/utils/model/model.js')
const { isDeferredToolFor } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const names = ['LspRead', 'LspRename', 'LspMoveSymbol', 'LspMoveFile', 'LspCodeAction', 'LspFormat', 'LspRequest']
const tools = getAllBaseTools()
const selected = names.map(name => tools.find(tool => tool.name === name))
check('the catalogue carries seven language-service tools and no callable LSP', selected.every(Boolean) && !tools.some(tool => tool.name === 'LSP'), tools.filter(tool => /lsp/i.test(tool.name)).map(tool => tool.name).join(', '))
const required = [['operation'], ['filePath', 'line', 'character', 'newName'], ['filePath', 'line', 'character', 'targetPath'], ['filePath', 'newPath'], ['filePath', 'line', 'character'], ['filePath'], ['filePath', 'method']]
const bytes = [2645, 1787, 1788, 1230, 2090, 1599, 974]
const quotes = [['filePath', 'query', 'paths'], ['filePath', 'newName'], ['filePath', 'targetPath'], ['filePath', 'newPath'], ['filePath'], ['filePath'], ['filePath']]
for (let i = 0; i < names.length; i++) {
  const tool = selected[i]
  if (!tool) continue
  const description = await tool.description()
  const input_schema = tool.inputJSONSchema
  const sent = await toolToAPISchema(tool, { getToolPermissionContext: async () => getEmptyToolPermissionContext(), tools, agents: [], model: getEngineModel(), deferLoading: i !== 0 }) as { description: string; input_schema: unknown }
  check(`${tool.name}: the wire carries the exact description and explicit schema`, sent.description === description && JSON.stringify(sent.input_schema) === JSON.stringify(input_schema))
  const wire = { name: tool.name, description, input_schema, eager_input_streaming: true, ...(i ? { defer_loading: true } : {}) }
  check(`${tool.name}: exact serialized definition byte count ${bytes[i]}`, Buffer.byteLength(JSON.stringify(wire)) === bytes[i], `${Buffer.byteLength(JSON.stringify(wire))}`)
  check(`${tool.name}: the whole required set is advertised`, JSON.stringify(input_schema?.required) === JSON.stringify(required[i]))
  check(`${tool.name}: rejects undocumented keys`, !tool.inputSchema.safeParse({ ...Object.fromEntries(required[i]!.map(k => [k, ['line', 'character'].includes(k) ? 1 : 'value'])), nonsense: true }).success)
  check(`${tool.name}: load policy`, tool.shouldDefer === true && (i === 0 ? tool.loadInFullOnCloud === true : tool.loadInFullOnCloud !== true))
  check(`${tool.name}: actual cloud/local deferral predicates`, isDeferredToolFor(tool, getEngineModel()) === (i !== 0) && isDeferredToolFor(tool, 'local/qwen3-32b') === true)
  check(`${tool.name}: search hint exists and fits`, typeof tool.searchHint === 'string' && tool.searchHint.length > 0 && tool.searchHint.length <= 100)
  check(`${tool.name}: straight quotes`, JSON.stringify(tool.straightQuoteInputs) === JSON.stringify(quotes[i]))
  for (const input of [{}, { apply: false }, { apply: true }]) {
    const read = i === 0 || (i !== 6 && input.apply !== true)
    check(`${tool.name}: read and concurrency posture ${JSON.stringify(input)}`, tool.isReadOnly(input) === read && tool.isConcurrencySafe(input) === read)
  }
}
cleanup(scratch)
finish('prove-lsp-split-catalogue')
