#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { whichSync } = await import('../../src/platform/processes/which.ts')
const owner = await import('../../src/platform/processes/subprocessEnv.ts') as {
  toolShellEnv?: (env: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv, platform?: string) => NodeJS.ProcessEnv
}
const compose = owner.toolShellEnv ?? ((env: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}) => ({ ...env, ...overrides }))
let failures = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}
const envHint = 'fix toolShellEnv and its default table in src/platform/processes/subprocessEnv.ts so the default stays as the label says and an explicit caller value is kept'
console.log('refusals')
for (const platform of ['darwin', 'linux', 'win32']) {
  check(`${platform}: npm defaults to cancellation, never approval`, compose({}, {}, platform).npm_config_yes === 'false', '', envHint)
  check(`${platform}: an explicit user choice still wins`, compose({ npm_config_yes: 'true' }, {}, platform).npm_config_yes === 'true', '', envHint)
  check(`${platform}: cloud prompts are not auto-answered by default`, compose({}, {}, platform).CLOUDSDK_CORE_DISABLE_PROMPTS === undefined, '', envHint)
  check(`${platform}: an explicit cloud prompt choice still wins`, compose({ CLOUDSDK_CORE_DISABLE_PROMPTS: '1' }, {}, platform).CLOUDSDK_CORE_DISABLE_PROMPTS === '1', '', envHint)
  check(`${platform}: debconf prompts are not auto-answered by default`, compose({}, {}, platform).DEBIAN_FRONTEND === undefined, '', envHint)
  check(`${platform}: an explicit debconf frontend choice still wins`, compose({ DEBIAN_FRONTEND: 'noninteractive' }, {}, platform).DEBIAN_FRONTEND === 'noninteractive', '', envHint)
  check(`${platform}: composer prompts are not auto-answered by default`, compose({}, {}, platform).COMPOSER_NO_INTERACTION === undefined, '', envHint)
  check(`${platform}: an explicit composer interaction choice still wins`, compose({ COMPOSER_NO_INTERACTION: '1' }, {}, platform).COMPOSER_NO_INTERACTION === '1', '', envHint)
}
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { bashToolCheckExactMatchPermission, bashToolCheckPermission } = await import('../../src/tools/shell/bashPermissions.ts')
const { checkParsedCommand } = await import('./floor-proof-helpers.ts')
const baseCtx = getEmptyToolPermissionContext()
const allowPlainCtx = { ...baseCtx, alwaysAllowRules: { localSettings: ['Bash(npx mercury-fixture-no-auto-install)'] } }
const denyFlagCtx = { ...baseCtx, alwaysDenyRules: { localSettings: ['Bash(npx --yes *)'] } }
const plainAllowed = bashToolCheckExactMatchPermission({ command: 'npx mercury-fixture-no-auto-install' }, allowPlainCtx as never)
const flagExact = bashToolCheckExactMatchPermission({ command: 'npx --yes mercury-fixture-no-auto-install' }, allowPlainCtx as never)
const flagAsked = await bashToolCheckPermission({ command: 'npx --yes mercury-fixture-no-auto-install' }, allowPlainCtx as never)
const flagDenied = await checkParsedCommand({ command: 'npx --yes mercury-fixture-no-auto-install' }, denyFlagCtx as never)
check('permission layer: an allow rule for plain npx does not auto-allow explicit --yes', plainAllowed.behavior === 'allow' && flagExact.behavior === 'passthrough' && flagAsked.behavior === 'ask', `plain=${plainAllowed.behavior} exact=${flagExact.behavior} ask=${flagAsked.behavior}`, 'fix bashToolCheckExactMatchPermission and bashToolCheckPermission in src/tools/shell/bashPermissions.ts so an allow rule for plain npx does not match the --yes form')
check('permission layer: a deny rule on npx --yes * refuses explicit --yes on the command line', flagDenied.behavior === 'deny', `flag=${flagDenied.behavior}`, 'fix the deny-rule matching in src/tools/shell/bashPermissions.ts so Bash(npx --yes *) denies the explicit --yes command')
const npm = whichSync('npm')
const node = whichSync('node')
const resolved = npm ? realpathSync(npm) : null
const cli = resolved && /\.(?:cmd|bat|exe)$/i.test(resolved) ? join(dirname(resolved), 'node_modules', 'npm', 'bin', 'npm-cli.js') : resolved
if (!node || !cli || !existsSync(cli)) {
  console.log('[SKIP] native npm exec cancellation: npm and Node must be installed; the platform table refusals still run')
} else {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'shell-no-auto-consent-')))
  const requests: string[] = []
  let port = 0
  const name = 'mercury-fixture-no-auto-install'
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    requests.push(url)
    if (url.includes('.tgz')) {
      res.writeHead(403)
      res.end('fixture refuses all package downloads')
      return
    }
    if (url !== `/${name}`) {
      res.writeHead(404)
      res.end('fixture has no other package')
      return
    }
    const version = { name, version: '1.0.0', bin: { [name]: 'index.js' }, dist: { tarball: `http://127.0.0.1:${port}/${name}.tgz` } }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': version } }))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
    for (const choice of ['default', 'flag', 'environment'] as const) {
      const work = join(scratch, choice)
      mkdirSync(work)
      requests.length = 0
      const env = compose({ PATH: process.env.PATH, HOME: work, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, {
        npm_config_registry: `http://127.0.0.1:${port}`,
        npm_config_cache: join(work, 'cache'),
        npm_config_userconfig: join(work, 'missing-user-config'),
        npm_config_globalconfig: join(work, 'missing-global-config'),
        npm_config_fetch_retries: '0',
        ...(choice === 'environment' ? { npm_config_yes: 'true' } : {}),
      })
      const args = [cli, 'exec', ...(choice === 'flag' ? ['--yes'] : []), `--package=${name}`, '--', name]
      const child = spawn(node, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let output = ''
      child.stdout?.on('data', chunk => { output += chunk })
      child.stderr?.on('data', chunk => { output += chunk })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      const downloads = requests.filter(url => url.endsWith('.tgz')).length
      check(`${choice}: the fixture metadata was actually read`, requests.includes(`/${name}`), '', 'npm never reached the local registry fixture; check that npm_config_registry is passed through the env built by toolShellEnv in src/platform/processes/subprocessEnv.ts')
      if (choice === 'default') {
        check('default: npm cancels without fetching a package tarball', code !== 0 && /cancel|no YES option/i.test(output) && downloads === 0, `rc=${code} tarball requests=${downloads}; ${output.split(/\r?\n/)[0] ?? ''}`, 'npm must see npm_config_yes=false from toolShellEnv in src/platform/processes/subprocessEnv.ts so npm exec cancels instead of installing')
      } else {
        check(`${choice}: explicit consent reaches the download fixture, which refuses it`, code !== 0 && downloads > 0 && /403/.test(output), `rc=${code} tarball requests=${downloads}`, 'toolShellEnv in src/platform/processes/subprocessEnv.ts must keep an explicit --yes or npm_config_yes choice so npm reaches the download fixture')
      }
      check(`${choice}: no package was installed or executed`, !existsSync(join(work, 'node_modules', name)), '', 'a package was installed or run in the scratch folder; check the npm exec arguments and the env built by toolShellEnv in src/platform/processes/subprocessEnv.ts')
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  }
}
console.log(failures === 0 ? 'PASS tool shell refuses automatic package consent' : `FAIL tool shell automatic package consent (${failures})`)
process.exit(failures === 0 ? 0 : 1)
