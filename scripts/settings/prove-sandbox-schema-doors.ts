#!/usr/bin/env bun
// gate-watch: src/entrypoints/sandboxTypes.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const j = (v: unknown): string => JSON.stringify(v)

const { SandboxSettingsSchema } = await import('../../src/entrypoints/sandboxTypes.ts')
const parse = (value: unknown) => SandboxSettingsSchema().safeParse(value)

console.log('the schema is one object per process')
check('two reads answer the same schema object', SandboxSettingsSchema() === SandboxSettingsSchema())

console.log('every field is optional and the top level is loose')
{
  const empty = parse({})
  check('an empty sandbox block parses to an empty record', empty.success && j(empty.data) === j({}))
  const loose = parse({ enabled: true, someFutureKey: 'kept' })
  check('an unlisted top-level key survives validation', loose.success && (loose.data as Record<string, unknown>).someFutureKey === 'kept', j(loose))
}

console.log('the typed fields refuse the wrong shape and the nested objects are strict')
{
  check('enabled must be a boolean', !parse({ enabled: 'yes' }).success)
  check('enabledPlatforms must be a string list', !parse({ enabledPlatforms: 'macos' }).success && parse({ enabledPlatforms: ['macos', 'wsl'] }).success)
  check('httpProxyPort must be a number', !parse({ network: { httpProxyPort: '8080' } }).success && parse({ network: { httpProxyPort: 8080 } }).success)
  const network = parse({ network: { allowedDomains: ['a.b'], extra: 1 } })
  check('network drops an unknown key (the nested objects are not loose)', network.success && j(network.data) === j({ network: { allowedDomains: ['a.b'] } }), j(network))
  const filesystem = parse({ filesystem: { allowWrite: ['/tmp'], extra: 1 } })
  check('filesystem drops an unknown key', filesystem.success && j(filesystem.data) === j({ filesystem: { allowWrite: ['/tmp'] } }), j(filesystem))
  check('ignoreViolations is a record of string lists', parse({ ignoreViolations: { git: ['x'] } }).success && !parse({ ignoreViolations: { git: 'x' } }).success)
  const ripgrep = parse({ ripgrep: { command: 'rg', extra: 1 } })
  check('ripgrep needs its command, takes optional args and drops an unknown key', parse({ ripgrep: { command: 'rg' } }).success && parse({ ripgrep: { command: 'rg', args: ['--hidden'] } }).success && !parse({ ripgrep: { args: [] } }).success && ripgrep.success && j(ripgrep.data) === j({ ripgrep: { command: 'rg' } }), j(ripgrep))
}

console.log('the full block round-trips')
{
  const full = {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: ['example.org'], allowManagedDomainsOnly: false, allowUnixSockets: ['/tmp/s'], allowAllUnixSockets: false, allowLocalBinding: true, httpProxyPort: 1, socksProxyPort: 2 },
    filesystem: { allowWrite: ['/w'], denyWrite: ['/d'], denyRead: ['/r'], allowRead: ['/a'], allowManagedReadPathsOnly: false },
    ignoreViolations: { make: ['warn'] },
    enableWeakerNestedSandbox: true,
    enableWeakerNetworkIsolation: true,
    excludedCommands: ['ssh'],
    enabledPlatforms: ['macos', 'linux', 'wsl'],
    ripgrep: { command: 'rg', args: [] },
  }
  const parsed = parse(full)
  check('every documented key parses and reads back unchanged', parsed.success && j(parsed.data) === j(full), j(parsed))
}

console.log(failures === 0 ? '\nprove-sandbox-schema-doors: ALL PASS' : `\nprove-sandbox-schema-doors: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
