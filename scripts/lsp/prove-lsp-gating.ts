
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync } from 'node:fs'
import * as path from 'node:path'

const {
  mercuryLspEnabled,
  isLspToolCatalogEnabled,
  mercuryLspWriteOpsEnabled,
  mercuryLspServersEnv,
} = await import('../../src/integrations/lsp/mercuryLsp.js')
const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.js')
const { getMercuryLspServerSources, probeBuiltinTsServer, MERCURY_TS_SERVER_NAME } =
  await import('../../src/integrations/lsp/builtinServers.js')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const saved = {
  lsp: process.env.MERCURY_LSP,
  servers: process.env.MERCURY_LSP_SERVERS,
}
function restore(): void {
  if (saved.lsp === undefined) delete process.env.MERCURY_LSP
  else process.env.MERCURY_LSP = saved.lsp
  if (saved.servers === undefined) delete process.env.MERCURY_LSP_SERVERS
  else process.env.MERCURY_LSP_SERVERS = saved.servers
}

try {
  delete process.env.MERCURY_LSP
  check('unset ⇒ bridge ON', mercuryLspEnabled() === true, 'mercuryLspEnabled in src/integrations/lsp/mercuryLsp.ts must read the MERCURY_LSP flag as on when unset')
  check('unset ⇒ catalog ON', isLspToolCatalogEnabled() === true, 'isLspToolCatalogEnabled in src/integrations/lsp/mercuryLsp.ts must be on when MERCURY_LSP is unset')
  check('unset ⇒ write ops ON', mercuryLspWriteOpsEnabled() === true, 'mercuryLspWriteOpsEnabled in src/integrations/lsp/mercuryLsp.ts must be on when MERCURY_LSP is unset')

  process.env.MERCURY_LSP = '0'
  check("'0' ⇒ bridge OFF (live re-read)", mercuryLspEnabled() === false, 'mercuryLspEnabled in src/integrations/lsp/mercuryLsp.ts must re-read MERCURY_LSP on every call, not cache it')
  check("'0' ⇒ catalog OFF (no compat env)", isLspToolCatalogEnabled() === false, 'isLspToolCatalogEnabled in src/integrations/lsp/mercuryLsp.ts must follow MERCURY_LSP=0 alone')
  check("'0' ⇒ write ops OFF", mercuryLspWriteOpsEnabled() === false, 'mercuryLspWriteOpsEnabled in src/integrations/lsp/mercuryLsp.ts must be off when MERCURY_LSP=0')
  check("'0' ⇒ servers env suppressed", mercuryLspServersEnv() === undefined, 'mercuryLspServersEnv in src/integrations/lsp/mercuryLsp.ts must return undefined when MERCURY_LSP=0')
  {
    const sources = getMercuryLspServerSources()
    check(
      "'0' ⇒ zero server sources",
      Object.keys(sources.env).length === 0 && Object.keys(sources.builtin).length === 0,
      'getMercuryLspServerSources in src/integrations/lsp/builtinServers.ts must return empty env and builtin maps when MERCURY_LSP=0',
    )
  }

  check("'0' ⇒ catalog OFF, no second switch", isLspToolCatalogEnabled() === false, 'isLspToolCatalogEnabled in src/integrations/lsp/mercuryLsp.ts must not depend on any switch besides MERCURY_LSP')

  delete process.env.MERCURY_LSP
  delete process.env.MERCURY_LSP_SIDECAR_ENTRY
  {
    const probe = probeBuiltinTsServer()
    check(
      'respawn safety: proof argv[1] refused, typescript still reported',
      probe.available === false &&
        !!probe.typescriptPath &&
        (probe.reason ?? '').includes('not a Mercury entry'),
      `${probe.reason ?? ''} (probeBuiltinTsServer in src/integrations/lsp/builtinServers.ts must refuse an argv[1] that is not a Mercury entry, with that reason, and still report typescriptPath)`,
    )
    const sources = getMercuryLspServerSources()
    check(
      'respawn safety: no builtin offered without a trustable entry',
      !(MERCURY_TS_SERVER_NAME in sources.builtin),
      'getMercuryLspServerSources in src/integrations/lsp/builtinServers.ts must leave mercury-ts out of builtin when probeBuiltinTsServer is unavailable',
    )
  }
  const sidecarEntry = path.resolve(import.meta.dir, '../../src/integrations/lsp/ts-sidecar/entry.ts')
  process.env.MERCURY_LSP_SIDECAR_ENTRY = sidecarEntry
  {
    const probe = probeBuiltinTsServer()
    check(
      'probe: override arms the builtin (typescript + direct entry)',
      probe.available === true && !!probe.typescriptPath && probe.directEntry === true,
      `${probe.reason ?? ''} (probeBuiltinTsServer in src/integrations/lsp/builtinServers.ts must accept the MERCURY_LSP_SIDECAR_ENTRY override as a direct entry)`,
    )
    const sources = getMercuryLspServerSources()
    const ts = sources.builtin[MERCURY_TS_SERVER_NAME]
    check(
      'builtin: mercury-ts offered (direct entry args) + initializationOptions.typescriptPath',
      !!ts &&
        ts.args?.length === 1 &&
        ts.args[0] === sidecarEntry &&
        typeof (ts.initializationOptions as { typescriptPath?: string })?.typescriptPath ===
          'string' &&
        ts.source === 'mercury-builtin',
      'getMercuryLspServerSources in src/integrations/lsp/builtinServers.ts must offer mercury-ts with the sidecar entry as its only arg, initializationOptions.typescriptPath and source mercury-builtin',
    )
    check(
      'builtin: extension map claims .ts/.tsx/.js',
      !!ts && ['.ts', '.tsx', '.js'].every(e => e in ts.extensionToLanguage),
      'the mercury-ts entry built in src/integrations/lsp/builtinServers.ts must list .ts, .tsx and .js in extensionToLanguage',
    )
  }
  delete process.env.MERCURY_LSP_SIDECAR_ENTRY

  process.env.MERCURY_LSP_SERVERS = JSON.stringify({
    good: {
      command: 'my-lsp',
      extensionToLanguage: { '.zig': 'zig' },
    },
    bad_no_ext: { command: 'nope' },
  })
  {
    const sources = getMercuryLspServerSources()
    const names = Object.keys(sources.env)
    check(
      "env servers: valid entry scoped as env:good, invalid 'bad_no_ext' skipped",
      names.length === 1 &&
        names[0] === 'env:good' &&
        sources.env['env:good']!.source === 'mercury-env',
      `${names.join(',')} (getMercuryLspServerSources in src/integrations/lsp/builtinServers.ts must scope MERCURY_LSP_SERVERS entries as env:<name> and skip entries without extensionToLanguage)`,
    )
  }
  process.env.MERCURY_LSP_SERVERS = 'not json'
  {
    const sources = getMercuryLspServerSources()
    check('env servers: malformed JSON ⇒ ignored, never throws', Object.keys(sources.env).length === 0, 'getMercuryLspServerSources in src/integrations/lsp/builtinServers.ts must return no env servers when MERCURY_LSP_SERVERS is not valid JSON')
  }
  delete process.env.MERCURY_LSP_SERVERS

  const lspRow = FLAG_REGISTRY.find(r => r.env === 'MERCURY_LSP')
  const serversRow = FLAG_REGISTRY.find(r => r.env === 'MERCURY_LSP_SERVERS')
  check(
    "registry: MERCURY_LSP is default-on/behavioral with evidence",
    !!lspRow && lspRow.kind === 'default-on' && lspRow.tier === 'behavioral' && !!lspRow.evidence,
    'the MERCURY_LSP row in FLAG_REGISTRY needs kind default-on, tier behavioral and an evidence path',
  )
  check(
    'registry: evidence artifact exists on disk',
    !!lspRow?.evidence && existsSync(path.resolve(import.meta.dir, '../..', lspRow.evidence)),
    `${lspRow?.evidence ?? 'no evidence'} (the evidence path of the MERCURY_LSP row in the flag registry (FLAG_REGISTRY) must name a file that exists in the repo)`,
  )
  check("registry: MERCURY_LSP_SERVERS is a value knob", !!serversRow && serversRow.kind === 'value', 'FLAG_REGISTRY in the flag registry needs a MERCURY_LSP_SERVERS row with kind value')
} finally {
  restore()
}

if (failures > 0) {
  console.error(`prove-lsp-gating: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-gating: GREEN')
