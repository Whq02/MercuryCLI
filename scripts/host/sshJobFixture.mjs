#!/usr/bin/env node
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
function bashSyntax(script) {
  const dir = mkdtempSync(join(tmpdir(), 'bash-syntax-'))
  const file = join(dir, 'script.sh')
  writeFileSync(file, script)
  try {
    return spawnSync('bash', ['-n', file.replaceAll('\\', '/')], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const needleAt = (source, needle) => {
  const at = source.indexOf(needle)
  assert.notEqual(at, -1, 'missing command needle: ' + needle)
  return at
}
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
  const syntax = bashSyntax(remote)
  assert.equal(syntax.status, 0, syntax.stderr)
  for (const answer of config.answers ?? []) {
    const pattern = new RegExp(answer.pattern)
    if (!pattern.test(remote)) continue
    const count = readFileSync(join(home, 'ssh-fixture-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(call => pattern.test(call.at(-1))).length
    const reply = answer.replies[Math.min(count - 1, answer.replies.length - 1)]
    if (reply.stdout) process.stdout.write(reply.stdout)
    if (reply.stderr) process.stderr.write(reply.stderr)
    process.exit(reply.code ?? 0)
  }
  if (remote.includes('nohup setsid')) {
    assert.ok(needleAt(remote, 'mkdir -p') < needleAt(remote, 'exec 2>>'))
    assert.ok(needleAt(remote, 'exec 2>>') < needleAt(remote, 'nohup setsid'))
    assert.ok(remote.includes('sleep 5') && remote.includes('pgrep -f'))
    assert.ok(!remote.includes('bash -lc'))
    if (config.failLaunch) { console.error('launch.log: fixture outer launch permission denied'); process.exit(1) }
  }
  if (remote.includes('command -v llama-server')) {
    console.log('MERCURY_PREBUILT_ENGINE yes')
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
