#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { whichSync } = await import('../../src/utils/which.ts')
const owner = await import('../../src/utils/subprocessEnv.ts') as {
  toolShellEnv?: (env: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv, platform?: string) => NodeJS.ProcessEnv
}
const compose = owner.toolShellEnv ?? ((env: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}) => ({ ...env, ...overrides }))
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
console.log('refusals')
for (const platform of ['darwin', 'linux', 'win32']) {
  check(`${platform}: npm defaults to cancellation, never approval`, compose({}, {}, platform).npm_config_yes === 'false')
  check(`${platform}: an explicit user choice still wins`, compose({ npm_config_yes: 'true' }, {}, platform).npm_config_yes === 'true')
  check(`${platform}: cloud prompts are not auto-answered by default`, compose({}, {}, platform).CLOUDSDK_CORE_DISABLE_PROMPTS === undefined)
  check(`${platform}: an explicit cloud prompt choice still wins`, compose({ CLOUDSDK_CORE_DISABLE_PROMPTS: '1' }, {}, platform).CLOUDSDK_CORE_DISABLE_PROMPTS === '1')
}
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
      check(`${choice}: the fixture metadata was actually read`, requests.includes(`/${name}`))
      if (choice === 'default') {
        check('default: npm cancels without fetching a package tarball', code !== 0 && /cancel|no YES option/i.test(output) && downloads === 0, `rc=${code} tarball requests=${downloads}; ${output.split(/\r?\n/)[0] ?? ''}`)
      } else {
        check(`${choice}: explicit consent reaches the download fixture, which refuses it`, code !== 0 && downloads > 0 && /403/.test(output), `rc=${code} tarball requests=${downloads}`)
      }
      check(`${choice}: no package was installed or executed`, !existsSync(join(work, 'node_modules', name)))
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  }
}
console.log(failures === 0 ? 'PASS tool shell refuses automatic package consent' : `FAIL tool shell automatic package consent (${failures})`)
process.exit(failures === 0 ? 0 : 1)
