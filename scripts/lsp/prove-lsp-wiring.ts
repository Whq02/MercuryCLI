
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { getFlagSpec } from '../../src/substrate/flagRegistry.ts'

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
  const globals = globalThis as Record<string, unknown>
  if (globals.MACRO === undefined) globals.MACRO = { VERSION: '1.0.0' }
  const { runtimeChecks } = await import('../../src/utils/health/sections/runtime.ts')
  const { probeBuiltinTsServer } = await import('../../src/services/lsp/builtinServers.ts')
  const lspRow = runtimeChecks().find(row => row.id === 'lsp')
  check("health list: check id 'lsp' present", lspRow?.label === 'IDE-hands (LspRead)')
  const lspFlag = process.env.MERCURY_LSP
  delete process.env.MERCURY_LSP
  const armedSays = await lspRow?.run()
  const tsProbe = probeBuiltinTsServer()
  check(
    'health list: uses the SAME probe as boot (probeBuiltinTsServer)',
    armedSays !== undefined && armedSays.status !== 'off' && (tsProbe.typescriptPath ? armedSays.evidence.includes('typescript@') : armedSays.evidence.includes('no workspace typescript') || armedSays.evidence.includes(tsProbe.reason ?? '\0')),
    armedSays?.evidence,
  )
  process.env.MERCURY_LSP = '0'
  const offSays = await lspRow?.run()
  if (lspFlag === undefined) delete process.env.MERCURY_LSP
  else process.env.MERCURY_LSP = lspFlag
  check(
    "health list: off state names the registered flag as it was set (flagAsSet('MERCURY_LSP'))",
    offSays?.status === 'off' && offSays.evidence === 'MERCURY_LSP=0 — IDE-hands bridge disabled by flag',
    offSays?.evidence,
  )
}

{
  const s = read('src/constants/subagentDoctrine.ts')
  check('subagentDoctrine: no IDE-evidence line of its own', !s.includes('getLspDoctrineLine') && !s.includes('ide-evidence'))
}

{
  const s = read('src/tools/LSPTool/prompt.ts')
  check(
    'prompt.ts: the read description names none of the six writing tools (the deferred roster carries them)',
    !/LspRead: `[^`]*\b(?:LspRename|LspMoveSymbol|LspMoveFile|LspCodeAction|LspFormat|LspRequest|ToolSearch)\b/.test(s),
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
    LspRead: 'e8dcb24e66b983fc4569db7a0f4ba8cfa2fda359c3bb20a60c87ee20a9d5ab0a',
    LspRename: '7ce7e31decab00a564947aca7518da973b200dc5398b82d97a8e5023aaad7350',
    LspMoveSymbol: 'd06e6490705f7f8fc0f8b7190ccee3b6a0e306d13c8462a88d6c66f1fae9ab93',
    LspMoveFile: 'a26e776bb09eec4ee1d7a127e121b65fcb3454b8aab1c59468220c21af6f8bed',
    LspCodeAction: '6b3f0fd4e2496b6c2b7534e3075363cf0561248bc6c6417189b2988697f7c0ff',
    LspFormat: '512eb9b28f3d5c64d6ce670279d9c649fc26cfe5bea02db2c9b155e8a47fb29f',
    LspRequest: 'b533e047b9e67711d4696e07a4b9a03f3a7dc1540e118be2c7fe886a7da5f091',
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
  check(
    'the flag registry carries MERCURY_LSP + MERCURY_LSP_SERVERS',
    getFlagSpec('MERCURY_LSP') !== undefined && getFlagSpec('MERCURY_LSP_SERVERS') !== undefined,
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
  const { runtimeChecks } = await import('../../src/utils/health/sections/runtime.ts')
  const clang = await import('../../src/services/lsp/clangdLane.ts')
  const { probeGodotLane } = await import('../../src/services/lsp/godotLane.ts')
  const lspFlag = process.env.MERCURY_LSP
  delete process.env.MERCURY_LSP
  const says = await runtimeChecks().find(row => row.id === 'lsp')?.run()
  if (lspFlag !== undefined) process.env.MERCURY_LSP = lspFlag
  const cpp = clang.probeBuiltinClangd()
  const cppWords = !clang.mercuryLspCppEnabled() ? 'cpp lane off (' : !cpp.available || !cpp.clangdPath ? 'no clangd' : 'clangd ok'
  const godot = probeGodotLane()
  const godotWords = !godot.enabled ? 'godot lane off (MERCURY_GODOT)' : !godot.projectRoot ? 'godot armed · no project.godot here' : `:${godot.lspPort}`
  check(
    'health list: lsp check reads the lane probes (clangd + godot)',
    says?.evidence.includes(cppWords) === true && says.evidence.includes(godotWords),
    `${says?.evidence} · wanted: ${cppWords} · ${godotWords}`,
  )
  check(
    'health list: godot evidence probes editor reachability',
    godot.enabled && godot.projectRoot ? /godot editor (NOT )?listening :\d+/.test(says?.evidence ?? '') : says?.evidence.includes(godotWords) === true,
    says?.evidence,
  )
  const net = await import('node:net')
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
  const game = mkdtempSync(path.join(tmpdir(), 'lsp-godot-project-'))
  writeFileSync(path.join(game, 'project.godot'), 'config_version=5\n')
  const editor = net.createServer()
  await new Promise<void>(resolve => editor.listen(0, '127.0.0.1', () => resolve()))
  const port = (editor.address() as { port: number }).port
  const armed = [['MERCURY_GODOT', '1'], ['MERCURY_GODOT_LSP_PORT', String(port)], ['MERCURY_LSP', undefined]] as const
  const before = armed.map(([name]) => [name, process.env[name]] as const)
  for (const [name, value] of armed) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const lspRow = runtimeChecks().find(row => row.id === 'lsp')
  const listening = await runWithCwdOverride(game, async () => lspRow?.run())
  await new Promise<void>(resolve => editor.close(() => resolve()))
  const dark = await runWithCwdOverride(game, async () => lspRow?.run())
  for (const [name, value] of before) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(game, { recursive: true, force: true })
  check(
    'health list: in a Godot project with the lane armed the row asks the port: listening while something listens there, and NOT listening, with the way to open the editor, once nothing does',
    listening?.evidence.includes(`godot editor listening :${port}`) === true && dark?.evidence.includes(`godot editor NOT listening :${port} — open the project in the Godot editor`) === true,
    `${listening?.evidence} | ${dark?.evidence}`,
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
  check('the raw request description takes any protocol method', prompt.includes('any method, with params as JSON text'))
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
