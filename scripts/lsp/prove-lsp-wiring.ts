
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const repo = path.resolve(import.meta.dir, '../..')
const read = (p: string) => readFileSync(path.join(repo, p), 'utf8')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

{
  const s = read('src/tools.ts')
  check(
    'tools.ts: catalog spread rides isLspToolCatalogEnabled()',
    s.includes('isLspToolCatalogEnabled() ? LSP_TOOLS : []'),
  )
  check(
    'tools.ts: no bare env read decides the LSP catalogue',
    !/isEnvTruthy\(process\.env\.[A-Z_]+\) \? \[LSPTool\]/.test(s),
  )
}

{
  const s = read('src/services/lsp/config.ts')
  const order = s.indexOf('mercurySources.env, allServers, mercurySources.builtin')
  check('config.ts: first-wins merge order env > extensions > builtin', order !== -1)
  check(
    'config.ts: server sources fail-open to {} on error',
    s.includes('Error loading Mercury LSP server sources'),
  )
}

{
  const s = read('src/entrypoints/cli.tsx')
  const idx = s.indexOf("process.argv[2] === '--lsp-ts-sidecar'")
  check('cli.tsx: --lsp-ts-sidecar fast-path present', idx !== -1)
  const after = s.slice(idx, idx + 600)
  check(
    'cli.tsx: sidecar route runs unconditionally ',
    after.includes('runLspSidecarEntry'),
  )
}

{
  const s = read('src/services/lsp/LSPServerInstance.ts')
  check(
    'LSPServerInstance: rename/codeAction/diagnostic client caps behind mercuryLspEnabled()',
    s.includes('...(mercuryLspEnabled()') &&
      s.includes('prepareSupport: true') &&
      s.includes('codeActionLiteralSupport'),
  )
  check(
    'LSPServerInstance: capabilities passthrough exposed for the ops layer',
    s.includes('get capabilities()'),
  )
}

{
  const s = read('src/utils/healthReport.ts')
  check("healthReport: check id 'lsp' present", s.includes("id: 'lsp'"))
  check(
    'healthReport: uses the SAME probe as boot (probeBuiltinTsServer)',
    s.includes('probeBuiltinTsServer()'),
  )
  check(
    "healthReport: off state names the registered flag ('MERCURY_LSP=0')",
    s.includes('MERCURY_LSP=0'),
  )
}

{
  const s = read('src/constants/subagentDoctrine.ts')
  check('subagentDoctrine: no IDE-evidence line of its own', !s.includes('getLspDoctrineLine') && !s.includes('ide-evidence'))
}

{
  const s = read('src/tools/LSPTool/prompt.ts')
  check(
    'prompt.ts: the read description names the six deferred writing tools',
    s.includes('Changes go through tools loaded with ToolSearch: LspRename, LspMoveSymbol, LspMoveFile, LspCodeAction, LspFormat, LspRequest.'),
  )
  check(
    'prompt.ts: the read description does not gloss the six tools again (the deferred roster lines carry each one\'s search hint)',
    !s.includes('LspRequest (one raw protocol request)') && !s.includes('LspRename (rename a symbol)'),
  )
}

{
  const { createHash } = await import('node:crypto')
  const { LSP_DESCRIPTIONS, LSP_TOOL_NAMES } = await import('../../src/tools/LSPTool/prompt.ts')
  const { truncateToLines } = await import('../../src/utils/stringUtils.ts')
  const CARD_SHA256: Record<string, string> = {
    LspRead: 'c67a0336cff2a20c4a422f4ea132d7860da5042bdf5abe9ec0ee931d7b46eaec',
    LspRename: 'c3b1f84bf5304bf8434d68aeacb2c27a06a1d82c3be85a5223ac0135228735e9',
    LspMoveSymbol: 'cc8bab7b2d215fd6e2789f1001d5e35fb76a6d4d18e510e6b17a87cfd1811ced',
    LspMoveFile: '8a8e6ec1f11dd96a4f1fc9a7dc5643e41fa07c54d20cf24d434ef49c70e5d05a',
    LspCodeAction: '88bf29165c81c37ffb8e4f6a20e6a22db73ead72c37700a2983be7d1fd4b2b5a',
    LspFormat: '96b0de2212be0ca1a9452f3fa5015f6588233c40c074b6aec1d31810d5c8f1bd',
    LspRequest: '475d9ac660191a081241eaf7b1f8d32a10d040da92b6c8dbc97daa967ac5fb9d',
  }
  for (const name of LSP_TOOL_NAMES) {
    const card = truncateToLines(LSP_DESCRIPTIONS[name], 3)
    check(`${name}: the text the Fallback permission card prints (its description cut to three lines) matches the pinned card`, createHash('sha256').update(card).digest('hex') === CARD_SHA256[name], card.slice(0, 120))
  }
}

{
  const s = read('src/tools/LSPTool/LSPTool.ts')
  check(
    'LSPTool: isReadOnly/isConcurrencySafe are input-aware over apply ops',
    s.includes('isReadOnly: (input: LspInput) => !writes(input)') && s.includes("name === 'LspRequest' || (name !== 'LspRead' && input?.apply === true)"),
  )
  check(
    'LSPTool: apply ops route checkWritePermissionForTool',
    s.includes('if (writes(input)) return checkWritePermissionForTool(tool, input, permissionContext)'),
  )
  check(
    'LSPTool: the Mercury operations dispatch to mercuryOps before the base method mapping',
    s.indexOf('runMercuryLspOp({') !== -1 &&
      s.indexOf('runMercuryLspOp({') < s.indexOf('getMethodAndParams(input, documentPath)'),
  )
}

{
  const s = read('src/services/lsp/tsSidecar/sidecar.ts')
  const specifiers = [...s.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)]
  const bad = specifiers
    .filter(m => {
      const isType = !!m[1]
      const spec = m[2]!
      if (spec.startsWith('node:')) return false
      if (spec === 'typescript' && isType) return false
      if (spec === '../sidecarFraming.js') return false
      return true
    })
    .map(m => m[2])
  check(
    'sidecar: imports only node builtins + type-only typescript + the shared framing owner',
    bad.length === 0 && s.includes("from '../sidecarFraming.js'"),
    bad.join(','),
  )
  check(
    'sidecar: typescript require is variable-indirected',
    s.includes('const target: string = tsPath') && s.includes('req(target)'),
  )
}

{
  const s = read('src/substrate/flagRegistry.ts')
  check(
    'the flag registry carries MERCURY_LSP + MERCURY_LSP_SERVERS',
    s.includes('MERCURY_LSP') && s.includes('MERCURY_LSP_SERVERS'),
  )
}

{
  const s = read('src/services/lsp/builtinServers.ts')
  check(
    'builtinServers: clangd + godot lanes merged into the builtin source',
    s.includes('builtinClangdServer()') && s.includes('builtinGodotServer()'),
  )
  check(
    'builtinServers: sidecar respawn delegates to the shared respawnEntry contract',
    s.includes('resolveMercuryRespawnEntry('),
  )
}
{
  const s = read('src/entrypoints/cli.tsx')
  const idx = s.indexOf("process.argv[2] === '--mercury-tcp-bridge'")
  check('cli.tsx: --mercury-tcp-bridge fast-path present', idx !== -1)
  const after = s.slice(idx, idx + 600)
  check(
    'cli.tsx: bridge route runs unconditionally ',
    after.includes('runTcpBridgeEntry'),
  )
}
{
  const s = read('src/utils/healthReport.ts')
  check(
    'healthReport: lsp check reads the lane probes (clangd + godot)',
    s.includes('probeBuiltinClangd()') && s.includes('probeGodotLane()'),
  )
  check(
    'healthReport: godot evidence probes editor reachability',
    s.includes('probeGodotEditorReachable('),
  )
}

{
  const s = read('src/tools/LSPTool/LSPTool.ts')
  check(
    'the raw protocol tool still routes to the engine',
    s.includes("case 'LspRequest': return 'rawRequest'") && s.includes('MERCURY_BRIDGE_OPERATIONS.has(operation)'),
  )
  const schema = read('src/tools/LSPTool/schemas.ts')
  check('the read schema carries no removed source/header operation', !schema.includes("'switchSourceHeader'"))
  const prompt = read('src/tools/LSPTool/prompt.ts')
  check('the raw request description takes any protocol method', prompt.includes('any method, params as JSON text'))
  const ui = read('src/tools/LSPTool/UI.tsx')
  check('UI: switchSourceHeader operation label', ui.includes('switchSourceHeader: {'))
  const ops = read('src/tools/LSPTool/mercuryOps.ts')
  check(
    'mercuryOps: textDocument/switchSourceHeader request with honest non-clangd fallback',
    ops.includes("'textDocument/switchSourceHeader'") &&
      ops.includes('does not support switchSourceHeader'),
  )
}

{
  const s = read('src/services/dap/dapClient.ts')
  check(
    'dapClient: godot adapter behind mercuryGodotEnabled()',
    s.includes('mercuryGodotEnabled()') && s.includes('GODOT_DAP_ADAPTER_KEY'),
  )
  check(
    'dapClient: godot launch args speak {project, scene} via buildLaunchArgs',
    s.includes('buildLaunchArgs') && s.includes('godotLaunchArgs'),
  )
  const tool = read('src/tools/DebugTool/DebugTool.ts')
  check(
    'DebugTool: godot inference is lane-gated',
    tool.includes('mercuryGodotEnabled()') && tool.includes("project.godot"),
  )
}

{
  const s = read('src/services/lsp/LSPServerManager.ts')
  const fn = s.slice(s.indexOf('async function forEachClaimant('), s.indexOf('async function openOn('))
  const primaryAt = fn.indexOf('await action(primary, true)')
  const fanoutAt = fn.indexOf('await Promise.all(')
  check('forEachClaimant: the primary is awaited alone, fail-fast, before any companion', primaryAt !== -1 && fn.includes('throw wrapped') && primaryAt < fn.indexOf('throw wrapped'))
  check('forEachClaimant: companions fan out concurrently after the primary', fanoutAt !== -1 && primaryAt < fanoutAt && fn.includes('companions.map(async server =>'))
  check('forEachClaimant: a companion failure is swallowed into its own debug line', fn.indexOf('failed (continuing)') > fanoutAt)
}

if (failures > 0) {
  console.error(`prove-lsp-wiring: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-wiring: GREEN')
