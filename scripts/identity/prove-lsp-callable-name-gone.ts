import { armScratch, check, cleanup, finish } from '../lsp/lspProofDoor.ts'

const scratch = armScratch('lsp-callable-name-gone')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { findToolByName } = await import('../../src/Tool.ts')
const forbiddenCallableNames = ['LSP']
const tools = getAllBaseTools()
for (const name of forbiddenCallableNames) {
  check(`${name} is absent from the callable catalogue and aliases`, !tools.some(tool => tool.name === name) && findToolByName(tools, name) === undefined)
}
check('all seven concrete language-service tools have their own names', ['LspRead', 'LspRename', 'LspMoveSymbol', 'LspMoveFile', 'LspCodeAction', 'LspFormat', 'LspRequest'].every(name => findToolByName(tools, name)?.name === name))
cleanup(scratch)
finish('prove-lsp-callable-name-gone')
