// prove-lsp-wiring — pins the IDE-hands bridge's integration seams so a
// refactor can't silently sever them. Structural (source-anchored) checks,
// each named for the seam it guards; the LIVE behavior is proven by
// prove-lsp-e2e (sidecar) and prove-lsp-apply-safety (apply pipeline).

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

// 1. Catalog: tools.ts routes LSPTool inclusion through the stamp gate.
{
  const s = read('src/tools.ts')
  check(
    'tools.ts: catalog spread rides isLspToolCatalogEnabled()',
    s.includes('isLspToolCatalogEnabled() ? [LSPTool] : []'),
  )
  check(
    'tools.ts: no bare ENABLE_LSP_TOOL catalog read remains',
    !s.includes('isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool]'),
  )
}

// 2. Server sourcing: config.ts merges env > extensions > builtin, first-wins.
{
  const s = read('src/services/lsp/config.ts')
  const order = s.indexOf('mercurySources.env, allServers, mercurySources.builtin')
  check('config.ts: first-wins merge order env > extensions > builtin', order !== -1)
  check(
    'config.ts: fork sources fail-open to {} on error',
    s.includes('Error loading Mercury LSP server sources'),
  )
}

// 3. CLI route: sidecar fast-path exists and is stamp-gated.
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

// 4. Client capabilities: stamp-gated additions in the initialize params.
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

// 5. Doctor: the lsp check exists, evidence-first, wired to the shared probe.
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

// 6. Doctrine + packs: every agent surface carries the IDE-evidence clause,
//    self-gated (splice-at-consumption for the generated packs).
{
  const s = read('src/constants/subagentDoctrine.ts')
  check('subagentDoctrine: getLspDoctrineLine spliced', s.includes('getLspDoctrineLine()'))
}

// 7. Tool prompt: fork ops section appended only when the bridge is on.
{
  const s = read('src/tools/LSPTool/prompt.ts')
  check(
    'prompt.ts: getLspToolDescription gates the IDE-hands section',
    s.includes("Mercury's editor-hands operations") && s.includes('mercuryOpsEnabled'),
  )
}

// 8. Tool schema/permissions: write ops are input-aware read-only=false and
//    permission-routed through the Edit-class check.
{
  const s = read('src/tools/LSPTool/LSPTool.ts')
  check(
    'LSPTool: isReadOnly/isConcurrencySafe are input-aware over apply ops',
    s.includes('isReadOnly(input: Input)') && s.includes('!isMercuryApplyOp(input)'),
  )
  check(
    'LSPTool: apply ops route checkWritePermissionForTool',
    s.includes('checkWritePermissionForTool(') && s.includes('isMercuryApplyOp(input)'),
  )
  check(
    'LSPTool: fork ops dispatch to mercuryOps before the base method mapping',
    s.indexOf('runMercuryLspOp({') !== -1 &&
      s.indexOf('runMercuryLspOp({') < s.indexOf('getMethodAndParams(input, documentPath)'),
  )
}

// 9. Sidecar purity: no harness imports (bun-loadable + bundle-safe), and the
//    typescript require stays variable-indirected. Since the ONE
//    allowed non-builtin value import is the shared zero-dep framing owner
//    (../sidecarFraming.js — extracted so mercury-web never grows a copy).
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

// 10. Registry: both rows live in the in-code registry (the source is the
//     truth; the rendered table is untracked inspection output).
{
  const s = read('src/substrate/flagRegistry.ts')
  check(
    'the flag registry carries MERCURY_LSP + MERCURY_LSP_SERVERS (with legacy aliases)',
    s.includes('MERCURY_LSP') && s.includes('MERCURY_LSP_SERVERS'),
  )
}

// 11. Language lanes: clangd + godot join the builtin source;
// the tcp bridge has its cli route; the doctor reads the SAME lane probes.
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

// 12. switchSourceHeader op: schema union + tool routing + prompt + UI label.
{
  const s = read('src/tools/LSPTool/LSPTool.ts')
  check(
    "LSPTool: switchSourceHeader in MERCURY_BRIDGE_OPERATIONS routing",
    //  moved routing to the MERCURY_BRIDGE_OPERATIONS set —
    // membership there IS the mercuryOps routing.
    s.includes("'switchSourceHeader'") &&
      s.includes('MERCURY_BRIDGE_OPERATIONS.has(input.operation)') &&
      /MERCURY_BRIDGE_OPERATIONS = new Set\(\[[^\]]*'switchSourceHeader'/s.test(s),
  )
  const schema = read('src/tools/LSPTool/schemas.ts')
  check(
    'schemas: switchSourceHeader union member (bridge-gated)',
    schema.includes("z.literal('switchSourceHeader')"),
  )
  const prompt = read('src/tools/LSPTool/prompt.ts')
  check(
    'prompt: switchSourceHeader documented in the IDE-hands section',
    prompt.includes('switchSourceHeader: For C/C++ files'),
  )
  const ui = read('src/tools/LSPTool/UI.tsx')
  check('UI: switchSourceHeader operation label', ui.includes('switchSourceHeader: {'))
  const ops = read('src/tools/LSPTool/mercuryOps.ts')
  check(
    'mercuryOps: textDocument/switchSourceHeader request with honest non-clangd fallback',
    ops.includes("'textDocument/switchSourceHeader'") &&
      ops.includes('does not support switchSourceHeader'),
  )
}

// 13. DAP godot adapter: lane-gated builtin row + editor launch contract.
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

// N. Claimant walk: the primary stays fail-fast and FIRST; companions run
//    concurrently (each action can carry a whole server start — the serial
//    walk paid every companion start in sequence before the tool
//    continued), each failure swallowed per companion, and the walk
//    resolves only after every companion settled (per-server ordering
//    across successive calls unchanged).
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
