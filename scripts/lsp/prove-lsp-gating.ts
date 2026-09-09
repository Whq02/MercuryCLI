
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync } from 'node:fs'
import * as path from 'node:path'

const {
  mercuryLspEnabled,
  isLspToolCatalogEnabled,
  mercuryLspWriteOpsEnabled,
  mercuryLspServersEnv,
  getLspDoctrineLine,
  getLspPackEvidenceText,
} = await import('../../src/services/lsp/mercuryLsp.js')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.js')
const { getMercuryLspServerSources, probeBuiltinTsServer, MERCURY_TS_SERVER_NAME } =
  await import('../../src/services/lsp/builtinServers.js')

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
  check('unset ⇒ bridge ON', mercuryLspEnabled() === true)
  check('unset ⇒ catalog ON', isLspToolCatalogEnabled() === true)
  check('unset ⇒ write ops ON', mercuryLspWriteOpsEnabled() === true)
  check('unset ⇒ doctrine line present', getLspDoctrineLine() !== null)
  check('unset ⇒ pack evidence present', getLspPackEvidenceText() !== null)

  process.env.MERCURY_LSP = '0'
  check("'0' ⇒ bridge OFF (live re-read)", mercuryLspEnabled() === false)
  check("'0' ⇒ catalog OFF (no compat env)", isLspToolCatalogEnabled() === false)
  check("'0' ⇒ write ops OFF", mercuryLspWriteOpsEnabled() === false)
  check("'0' ⇒ doctrine line null", getLspDoctrineLine() === null)
  check("'0' ⇒ pack evidence null", getLspPackEvidenceText() === null)
  check("'0' ⇒ servers env suppressed", mercuryLspServersEnv() === undefined)
  {
    const sources = getMercuryLspServerSources()
    check(
      "'0' ⇒ zero server sources",
      Object.keys(sources.env).length === 0 && Object.keys(sources.builtin).length === 0,
    )
  }

  check("'0' ⇒ catalog OFF, no second switch", isLspToolCatalogEnabled() === false)

  delete process.env.MERCURY_LSP
  delete process.env.MERCURY_LSP_SIDECAR_ENTRY
  {
    const probe = probeBuiltinTsServer()
    check(
      'respawn safety: proof argv[1] refused, typescript still reported',
      probe.available === false &&
        !!probe.typescriptPath &&
        (probe.reason ?? '').includes('not a Mercury entry'),
      probe.reason,
    )
    const sources = getMercuryLspServerSources()
    check(
      'respawn safety: no builtin offered without a trustable entry',
      !(MERCURY_TS_SERVER_NAME in sources.builtin),
    )
  }
  const sidecarEntry = path.resolve(import.meta.dir, '../../src/services/lsp/tsSidecar/entry.ts')
  process.env.MERCURY_LSP_SIDECAR_ENTRY = sidecarEntry
  {
    const probe = probeBuiltinTsServer()
    check(
      'probe: override arms the builtin (typescript + direct entry)',
      probe.available === true && !!probe.typescriptPath && probe.directEntry === true,
      probe.reason,
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
    )
    check(
      'builtin: extension map claims .ts/.tsx/.js',
      !!ts && ['.ts', '.tsx', '.js'].every(e => e in ts.extensionToLanguage),
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
      names.join(','),
    )
  }
  process.env.MERCURY_LSP_SERVERS = 'not json'
  {
    const sources = getMercuryLspServerSources()
    check('env servers: malformed JSON ⇒ ignored, never throws', Object.keys(sources.env).length === 0)
  }
  delete process.env.MERCURY_LSP_SERVERS

  const lspRow = FLAG_REGISTRY.find(r => r.env === 'MERCURY_LSP')
  const serversRow = FLAG_REGISTRY.find(r => r.env === 'MERCURY_LSP_SERVERS')
  check(
    "registry: MERCURY_LSP is default-on/behavioral with evidence",
    !!lspRow && lspRow.kind === 'default-on' && lspRow.tier === 'behavioral' && !!lspRow.evidence,
  )
  check(
    'registry: evidence artifact exists on disk',
    !!lspRow?.evidence && existsSync(path.resolve(import.meta.dir, '../..', lspRow.evidence)),
    lspRow?.evidence,
  )
  check("registry: MERCURY_LSP_SERVERS is a value knob", !!serversRow && serversRow.kind === 'value')
} finally {
  restore()
}

if (failures > 0) {
  console.error(`prove-lsp-gating: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-gating: GREEN')
