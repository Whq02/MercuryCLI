import { getEmptyToolPermissionContext, type ToolUseContext } from '../../src/tools/kit/tool.js'
import { ListMcpResourcesTool } from '../../src/tools/list-mcp-resources/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from '../../src/tools/read-mcp-resource/ReadMcpResourceTool.js'
import { hasPermissionsToUseTool } from '../../src/permissions/rules/permissionDoor.js'
import { getDefaultAppState } from '../../src/screen/app-state/AppStateStore.js'
import { fetchResourcesForClient, pruneStaleMcpResourceTools, reconnectMcpServerImpl, supplementaryToolsForMcpClient } from '../../src/integrations/mcp/client.js'
import { tellMcpToolsTheClient } from '../../src/integrations/mcp/client/forTools.js'
import { dropMcpServerFromAppState } from '../../src/integrations/mcp/kitDial.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig } from '../../src/integrations/mcp-shapes/mcpServerRecords.js'
import type { AssistantMessage } from '../../src/engine/message-shapes/message.js'

tellMcpToolsTheClient({
  ensureConnectedClient: async client => client as ConnectedMCPServer,
  fetchResourcesForClient,
  reconnectMcpServerImpl,
})
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const dummyConfig = (name: string): ScopedMcpServerConfig => ({
  type: 'stdio',
  command: 'node',
  args: [`${name}.mjs`],
  scope: 'local',
})

function fakeConnected(
  name: string,
  resources: Array<{ uri: string; name: string; mimeType?: string }>,
  onList?: () => void,
): ConnectedMCPServer {
  return {
    name,
    type: 'connected',
    config: dummyConfig(name),
    capabilities: { tools: {}, resources: {} },
    client: {
      request: async (req: { method?: string }) => {
        if (req.method === 'resources/list') {
          onList?.()
          return { resources }
        }
        return {}
      },
    } as never,
    cleanup: async () => {},
  }
}

const dummyAssistantMessage = {
  type: 'assistant',
  uuid: '00000000-0000-4000-a000-000000000001',
  timestamp: new Date().toISOString(),
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
} as unknown as AssistantMessage

function makeContext(
  permissionOverrides: Partial<ReturnType<typeof getEmptyToolPermissionContext>>,
  mcpClients: MCPServerConnection[],
): ToolUseContext {
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      ...permissionOverrides,
    },
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    options: { mcpClients },
  } as unknown as ToolUseContext
}

let secretListHits = 0
let alphaListHits = 0
let extVaultListHits = 0

const alphaClient = fakeConnected(
  'alpha',
  [{ uri: 'fixture://alpha/readme.txt', name: 'readme', mimeType: 'text/plain' }],
  () => { alphaListHits++ },
)
const secretClient = fakeConnected(
  'secret',
  [{ uri: 'fixture://secret/key.txt', name: 'key', mimeType: 'text/plain' }],
  () => { secretListHits++ },
)
const extVaultClient = fakeConnected(
  'ext:vault',
  [{ uri: 'fixture://ext-vault/cert.pem', name: 'cert', mimeType: 'text/plain' }],
  () => { extVaultListHits++ },
)

const serverNameDenyCtx = makeContext(
  {
    alwaysDenyRules: { userSettings: ['mcp__secret'] },
    ruleReasons: { userSettings: { mcp__secret: 'private vault' } },
  },
  [alphaClient, secretClient],
)

const readSecretByName = await hasPermissionsToUseTool(
  ReadMcpResourceTool,
  { server: 'secret', uri: 'fixture://secret/key.txt' },
  serverNameDenyCtx,
  dummyAssistantMessage,
  'toolu_1',
)
check(
  'server-name deny rule denies ReadMcpResource with the existing deny sentence and reason',
  readSecretByName.behavior === 'deny' &&
    readSecretByName.decisionReason?.type === 'rule' &&
    readSecretByName.message === 'Using ReadMcpResource is denied by the rule mcp__secret in your user settings: private vault.',
  JSON.stringify(readSecretByName),
)

const readAlphaUnasked = await hasPermissionsToUseTool(
  ReadMcpResourceTool,
  { server: 'alpha', uri: 'fixture://alpha/readme.txt' },
  serverNameDenyCtx,
  dummyAssistantMessage,
  'toolu_2',
)
check(
  'non-denied server still allows ReadMcpResource without a new ask',
  readAlphaUnasked.behavior === 'allow',
  JSON.stringify(readAlphaUnasked),
)

const listSecretFiltered = await hasPermissionsToUseTool(
  ListMcpResourcesTool,
  { server: 'secret' },
  serverNameDenyCtx,
  dummyAssistantMessage,
  'toolu_3',
)
check(
  'server-name deny rule denies server-filtered ListMcpResources with the existing deny sentence',
  listSecretFiltered.behavior === 'deny' &&
    listSecretFiltered.decisionReason?.type === 'rule' &&
    listSecretFiltered.message === 'Using ListMcpResources is denied by the rule mcp__secret in your user settings: private vault.',
  JSON.stringify(listSecretFiltered),
)

const listUnfilteredPerm = await hasPermissionsToUseTool(
  ListMcpResourcesTool,
  {},
  serverNameDenyCtx,
  dummyAssistantMessage,
  'toolu_4',
)
check(
  'unfiltered ListMcpResources stays allowed without a new ask',
  listUnfilteredPerm.behavior === 'allow',
  JSON.stringify(listUnfilteredPerm),
)

const listedByName = await ListMcpResourcesTool.call({}, serverNameDenyCtx)
check(
  'unfiltered ListMcpResources drops the denied server and returns only allowed server resources',
  secretListHits === 0 &&
    alphaListHits === 1 &&
    listedByName.data.length === 1 &&
    listedByName.data[0]?.server === 'alpha' &&
    listedByName.data[0]?.uri === 'fixture://alpha/readme.txt',
  JSON.stringify({ secretListHits, alphaListHits, data: listedByName.data }),
)

let missingErr = ''
try {
  await ListMcpResourcesTool.call({ server: 'no-such-server' }, serverNameDenyCtx)
} catch (err) {
  missingErr = err instanceof Error ? err.message : String(err)
}
check(
  'ListMcpResources unknown-server error omits the denied server from Available servers',
  missingErr.includes('alpha') && !missingErr.includes('secret'),
  missingErr,
)

const wildcardDenyCtx = makeContext(
  {
    mode: 'sovereign',
    alwaysDenyRules: { cliArg: ['mcp__secret__*'] },
  },
  [alphaClient, secretClient],
)

const readSecretWildcard = await hasPermissionsToUseTool(
  ReadMcpResourceTool,
  { server: 'secret', uri: 'fixture://secret/key.txt' },
  wildcardDenyCtx,
  dummyAssistantMessage,
  'toolu_5',
)
check(
  'server-wildcard deny rule denies ReadMcpResource even in sovereign mode',
  readSecretWildcard.behavior === 'deny' &&
    readSecretWildcard.decisionReason?.type === 'rule' &&
    readSecretWildcard.message === 'Using ReadMcpResource is denied by the rule mcp__secret__* from the command line.',
  JSON.stringify(readSecretWildcard),
)

const listedWildcard = await ListMcpResourcesTool.call({}, wildcardDenyCtx)
check(
  'server-wildcard deny rule drops the denied server from ListMcpResources',
  secretListHits === 0 &&
    listedWildcard.data.length === 1 &&
    listedWildcard.data[0]?.server === 'alpha',
  JSON.stringify({ secretListHits, data: listedWildcard.data }),
)

const singleToolDenyCtx = makeContext(
  {
    alwaysDenyRules: { userSettings: ['mcp__alpha__ping'] },
  },
  [alphaClient],
)

const readAlphaSingleToolDenied = await hasPermissionsToUseTool(
  ReadMcpResourceTool,
  { server: 'alpha', uri: 'fixture://alpha/readme.txt' },
  singleToolDenyCtx,
  dummyAssistantMessage,
  'toolu_6',
)
const listAlphaSingleToolDenied = await ListMcpResourcesTool.call({}, singleToolDenyCtx)
check(
  'single-tool deny rule does not block that server resources',
  readAlphaSingleToolDenied.behavior === 'allow' &&
    listAlphaSingleToolDenied.data.length === 1 &&
    listAlphaSingleToolDenied.data[0]?.server === 'alpha',
  JSON.stringify({ perm: readAlphaSingleToolDenied, data: listAlphaSingleToolDenied.data }),
)

const normalizedDenyCtx = makeContext(
  {
    alwaysDenyRules: { userSettings: ['mcp__ext_vault__*'] },
  },
  [alphaClient, extVaultClient],
)

const readExtVaultDenied = await hasPermissionsToUseTool(
  ReadMcpResourceTool,
  { server: 'ext:vault', uri: 'fixture://ext-vault/cert.pem' },
  normalizedDenyCtx,
  dummyAssistantMessage,
  'toolu_7',
)
const listNormalized = await ListMcpResourcesTool.call({}, normalizedDenyCtx)
check(
  'normalized server name deny rule reaches ReadMcpResource and drops ext:vault from ListMcpResources',
  readExtVaultDenied.behavior === 'deny' &&
    extVaultListHits === 0 &&
    listNormalized.data.every(r => r.server !== 'ext:vault'),
  JSON.stringify({ perm: readExtVaultDenied, extVaultListHits, data: listNormalized.data }),
)

const plainConnected: ConnectedMCPServer = {
  ...alphaClient,
  name: 'plain',
  config: dummyConfig('plain'),
  capabilities: { tools: {} },
}
const needsAuthClient: MCPServerConnection = {
  name: 'oauthsrv',
  type: 'needs-auth',
  config: dummyConfig('oauthsrv'),
}

const suppConnectedRes = supplementaryToolsForMcpClient(alphaClient).map(t => t.name)
const suppPlain = supplementaryToolsForMcpClient(plainConnected).map(t => t.name)
const suppNeedsAuth = supplementaryToolsForMcpClient(needsAuthClient).map(t => t.name)
check(
  'supplementaryToolsForMcpClient returns resource tools for connected resource server, auth tool for needs-auth, and empty for plain',
  JSON.stringify(suppConnectedRes) === JSON.stringify(['ListMcpResources', 'ReadMcpResource']) &&
    suppPlain.length === 0 &&
    JSON.stringify(suppNeedsAuth) === JSON.stringify(['mcp__oauthsrv__authenticate']),
  JSON.stringify({ suppConnectedRes, suppPlain, suppNeedsAuth }),
)

const baseState = getDefaultAppState()
const withTwoResourceServers = {
  ...baseState,
  mcp: {
    ...baseState.mcp,
    clients: [alphaClient, secretClient],
    tools: [ListMcpResourcesTool, ReadMcpResourceTool],
  },
}
const afterDropOne = dropMcpServerFromAppState(withTwoResourceServers, 'alpha', alphaClient.config)
const afterDropBoth = dropMcpServerFromAppState(afterDropOne, 'secret', secretClient.config)
check(
  'resource tools stay offered while another connected server still has resources and leave when the last one drops',
  afterDropOne.mcp.tools.map(t => t.name).includes('ListMcpResources') &&
    afterDropOne.mcp.tools.map(t => t.name).includes('ReadMcpResource') &&
    !afterDropBoth.mcp.tools.map(t => t.name).includes('ListMcpResources') &&
    !afterDropBoth.mcp.tools.map(t => t.name).includes('ReadMcpResource'),
  JSON.stringify({
    afterDropOne: afterDropOne.mcp.tools.map(t => t.name),
    afterDropBoth: afterDropBoth.mcp.tools.map(t => t.name),
  }),
)

const prunedAfterCapLoss = pruneStaleMcpResourceTools(
  [plainConnected],
  [ListMcpResourcesTool, ReadMcpResourceTool],
)
check(
  'pruneStaleMcpResourceTools removes both resource tools when the remaining connected server has no resources capability',
  prunedAfterCapLoss.length === 0,
  JSON.stringify(prunedAfterCapLoss.map(t => t.name)),
)

if (failures > 0) {
  console.error(`\nprove-mcp-resource-deny-reach: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-mcp-resource-deny-reach: all green')
process.exit(0)
