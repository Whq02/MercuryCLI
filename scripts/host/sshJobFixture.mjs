#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const home = process.env.MERCURY_CONFIG_DIR
if (!home) throw new Error('A scratch config home is required')
const config = JSON.parse(readFileSync(join(home, 'ssh-fixture.json'), 'utf8'))
assert.equal(new URL(config.modelBaseUrl).hostname, '127.0.0.1')
const args = process.argv.slice(2)
appendFileSync(join(home, 'ssh-fixture-calls.jsonl'), JSON.stringify(args) + '\n')
if (args.includes('-N')) {
  const forward = args[args.indexOf('-L') + 1]
  assert.match(forward, /^127\.0\.0\.1:\d+:127\.0\.0\.1:30000$/)
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk
      const response = await fetch(config.modelBaseUrl.replace(/\/v1$/, '') + req.url, { method: req.method, headers: req.headers, ...(body ? { body } : {}) })
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) { res.writeHead(502); res.end(String(error)) }
  })
  server.listen(Number(forward.split(':')[1]), '127.0.0.1')
  process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit()) })
} else {
  const remote = args.at(-1)
  assert.ok(args.includes('127.0.0.1'), 'fixture must never connect to a public host')
  const syntax = spawnSync('bash', ['-n', '-c', remote], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  if (remote.includes('nohup setsid')) {
    assert.ok(remote.indexOf('mkdir -p') < remote.indexOf('exec 2>>'))
    assert.ok(remote.indexOf('exec 2>>') < remote.indexOf('nohup setsid'))
    assert.ok(remote.includes('sleep 5') && remote.includes('pgrep -f'))
    assert.ok(!remote.includes('bash -lc'))
    if (config.failLaunch) { console.error('launch.log: fixture outer launch permission denied'); process.exit(1) }
  }
  if (remote.includes('command -v llama-server')) {
    console.log('MERCURY_PREBUILT_ENGINE')
  } else if (remote.includes('/health')) {
    if (config.hold) { console.error('fixture model loading'); process.exit(1) }
    console.log('healthy models')
  } else if (remote.startsWith('dd if=')) {
    const offset = Number(/skip=(\d+)/.exec(remote)?.[1] ?? 0)
    process.stdout.write((config.log ?? '').slice(offset, offset + 8192))
  } else if (remote.startsWith('du -sb')) {
    console.log('83000000000 weights')
  } else if (remote.includes('tail -n 8')) {
    process.stdout.write(config.log ?? '')
  }
}
