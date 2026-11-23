
import * as path from 'node:path'
import { getFlagSpec } from '../../src/platform/substrate/flagRegistry.ts'

const repo = path.resolve(import.meta.dir, '../..')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}


{
  const globals = globalThis as Record<string, unknown>
  if (globals.MACRO === undefined) globals.MACRO = { VERSION: '1.0.0' }
  const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
  const { probeBuiltinTsServer } = await import('../../src/integrations/lsp/builtinServers.ts')
  const lspRow = runtimeChecks().find(row => row.id === 'lsp')
  check("health list: check id 'lsp' present", lspRow?.label === 'IDE-hands (LspRead)', 'runtimeChecks() in src/platform/health/sections/runtime.ts must list a row with id lsp labelled IDE-hands (LspRead)')
  const lspFlag = process.env.MERCURY_LSP
  delete process.env.MERCURY_LSP
  const armedSays = await lspRow?.run()
  const tsProbe = probeBuiltinTsServer()
  check(
    'health list: uses the SAME probe as boot (probeBuiltinTsServer)',
    armedSays !== undefined && armedSays.status !== 'off' && (tsProbe.typescriptPath ? armedSays.evidence.includes('typescript@') : armedSays.evidence.includes('no workspace typescript') || armedSays.evidence.includes(tsProbe.reason ?? '\0')),
    armedSays?.evidence + ' | the lsp row in src/platform/health/sections/runtime.ts must report the probeBuiltinTsServer result (src/integrations/lsp/builtinServers.ts) and not read off while MERCURY_LSP is unset',
  )
  process.env.MERCURY_LSP = '0'
  const offSays = await lspRow?.run()
  if (lspFlag === undefined) delete process.env.MERCURY_LSP
  else process.env.MERCURY_LSP = lspFlag
  check(
    "health list: off state names the registered flag as it was set (flagAsSet('MERCURY_LSP'))",
    offSays?.status === 'off' && offSays.evidence === 'MERCURY_LSP=0 — IDE-hands bridge disabled by flag',
    offSays?.evidence + ' | with MERCURY_LSP=0 the lsp row in src/platform/health/sections/runtime.ts must report off with exactly this evidence text',
  )
}


{
  const { createHash } = await import('node:crypto')
  const { LSP_DESCRIPTIONS, LSP_TOOL_NAMES } = await import('../../src/tools/kit/names/lsp.ts')
  const { truncateToLines } = await import('../../src/platform/text/strings.ts')
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
    check(`${name}: the text the Fallback permission card prints (its description cut to three lines) matches the pinned card`, createHash('sha256').update(card).digest('hex') === CARD_SHA256[name], card.slice(0, 120) + ' | the first three lines of LSP_DESCRIPTIONS[' + name + '] in src/tools/kit/names/lsp.ts changed; restore them, or update CARD_SHA256 here if the change is intended')
  }
}


{
  check(
    'the flag registry carries MERCURY_LSP + MERCURY_LSP_SERVERS',
    getFlagSpec('MERCURY_LSP') !== undefined && getFlagSpec('MERCURY_LSP_SERVERS') !== undefined,
    'register the missing flag in the flag registry (FLAG_REGISTRY)',
  )
}

{
  const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
  const clang = await import('../../src/integrations/lsp/clangdLane.ts')
  const { probeGodotLane } = await import('../../src/integrations/lsp/godotLane.ts')
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
    `${says?.evidence} · wanted: ${cppWords} · ${godotWords} | the lsp row in src/platform/health/sections/runtime.ts must include the clangd and godot lane words`,
  )
  check(
    'health list: godot evidence probes editor reachability',
    godot.enabled && godot.projectRoot ? /godot editor (NOT )?listening :\d+/.test(says?.evidence ?? '') : says?.evidence.includes(godotWords) === true,
    says?.evidence + ' | the lsp row in src/platform/health/sections/runtime.ts must say whether the godot editor is listening on its port',
  )
  const net = await import('node:net')
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
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
    `${listening?.evidence} | ${dark?.evidence} | the lsp row in src/platform/health/sections/runtime.ts must probe the godot editor port and say listening or NOT listening`,
  )
}


if (failures > 0) {
  console.error(`prove-lsp-wiring: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-wiring: GREEN')
