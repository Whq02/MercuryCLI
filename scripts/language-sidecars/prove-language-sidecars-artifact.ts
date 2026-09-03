#!/usr/bin/env bun
// ============================================================================
//  scripts/language-sidecars/prove-language-sidecars-artifact.ts — the §7 native-payload
//  bar proved from an ISOLATED copy of the artifact (no repo node_modules
//  beside it — the friend-machine shape):
//
//    identity    — --version answers from the isolated copy;
//    visuals     — `show --protocol iterm` renders a PNG WITHOUT sharp
//                  (native tiers need no decode — the S7 honesty claim);
//    web lanes   — the --lsp-web-sidecar route initializes + answers a css
//                  diagnostic over real stdio from the isolated copy;
//    grammars    — vendor/treesitter ships the registry set (23) + the
//                  engine loads and PARSES under stock node (isolated);
//    browser     — the driver is IN the bundle (no node_modules needed) and
//                  the manifest records the S7 imageProcessing honesty;
//    manifest    — selfContained, degraded[] EMPTY, grammarPack vendored.
// ============================================================================

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveExecutionProfile } from '../lib/executionProfile.ts'

const ROOT = join(import.meta.dir, '..', '..')
const ESC = String.fromCharCode(27)

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

// The isolated copy — dist alone, in a bare temp dir (spaced path).
const stage = mkdtempSync(join(tmpdir(), 'vista artifact '))
cpSync(join(ROOT, 'dist'), join(stage, 'dist'), { recursive: true })
const bundle = join(stage, 'dist', 'mercury.mjs')

// identity
{
  const r = spawnSync('node', [bundle, '--version'], { encoding: 'utf8', timeout: 60_000 })
  check('isolated: --version answers', r.status === 0 && r.stdout.includes('Mercury'), r.stderr.slice(0, 120))
}

// visuals: the iterm tier needs NO sharp binding (whole-file PNG)
{
  // A 1×1 PNG, hand-rolled bytes (no sharp in the isolated stage).
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050201f92457350000000049454e44ae426082',
    'hex',
  )
  const fixture = join(stage, 'pixel.png')
  writeFileSync(fixture, png)
  const r = spawnSync('node', [bundle, 'show', fixture, '--protocol', 'iterm'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  check('isolated: show/iterm renders WITHOUT sharp', r.status === 0 && r.stdout.startsWith(`${ESC}]1337;File=`), r.stderr.slice(0, 160))
}

// web lanes over real stdio from the isolated copy
{
  const child = spawn('node', [bundle, '--lsp-web-sidecar'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const frames: Buffer[] = []
  child.stdout.on('data', (c: Buffer) => frames.push(c))
  const send = (msg: object): void => {
    const body = JSON.stringify(msg)
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  send({ jsonrpc: '2.0', method: 'initialized', params: {} })
  send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: 'file:///t/a.css', version: 1, text: 'body { colr: red; }\n' } },
  })
  send({ jsonrpc: '2.0', id: 2, method: 'textDocument/diagnostic', params: { textDocument: { uri: 'file:///t/a.css' } } })
  // The diagnostic answer is the observable; bounded so a silent sidecar
  // still reaches the checks below with whatever it produced.
  {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !Buffer.concat(frames).toString('utf8').includes('"items"'))
      await new Promise(r => setTimeout(r, 25))
  }
  child.kill()
  const out = Buffer.concat(frames).toString('utf8')
  check('isolated: web sidecar initializes', out.includes('"serverInfo"') && out.includes('mercury-web'))
  check('isolated: css diagnostic answers', out.includes('"items"') && out.includes('colr'), out.slice(0, 200))
}

// grammars: the vendored engine parses under stock node from the isolated copy
{
  const vendor = JSON.parse(readFileSync(join(stage, 'dist', 'vendor', 'treesitter', 'vendor.json'), 'utf8')) as {
    grammars: string[]
  }
  check('isolated: 23 grammar wasms shipped', vendor.grammars.length === 23, String(vendor.grammars.length))
  const probe = `
    const path = require('path');
    const dir = ${JSON.stringify(join(stage, 'dist', 'vendor', 'treesitter'))};
    const ts = require(path.join(dir, 'tree-sitter.js'));
    const mod = ts.Parser ? ts : (ts.default ?? ts);
    mod.Parser.init({ locateFile: f => path.join(dir, f) }).then(async () => {
      const lang = await mod.Language.load(path.join(dir, 'tree-sitter-toml.wasm'));
      const p = new mod.Parser(); p.setLanguage(lang);
      const tree = p.parse('[a]\\nb = "c"\\n');
      console.log('PARSED', tree.rootNode.type, tree.rootNode.hasError);
    }).catch(e => { console.error('ENGINE FAIL', e.message); process.exit(1) });
  `
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf8', timeout: 60_000 })
  check('isolated: the S2 pack grammar PARSES under stock node', r.status === 0 && r.stdout.includes('PARSED') && r.stdout.includes('false'), (r.stderr || r.stdout).slice(0, 160))
}

// browser driver + manifest honesty
{
  const bundleText = readFileSync(bundle, 'utf8')
  check('isolated: the puppeteer driver is IN the bundle', bundleText.includes('puppeteer-core'))
  const manifest = JSON.parse(readFileSync(join(stage, 'dist', 'manifest.json'), 'utf8')) as Record<string, unknown>
  check('manifest: selfContained', manifest.selfContained === true)
  // The voice pack is the ONE pack a builder may lack (it needs cargo; a
  // build without it ships an honest `voice-input` row and every other
  // sidecar whole). Under the HOSTED profile the runtime pack is a second
  // allowed absence: the gate's runner vendors no Node runtime (the
  // launchers run the PATH node there), and its manifest says so. Any
  // other member — or either one off its profile — is a degraded artifact
  // this proof refuses; the local law is unchanged.
  const hosted = resolveExecutionProfile(ROOT).kind === 'hosted-gate'
  const allowedAbsences = new Set<unknown>(['voice-input', ...(hosted ? ['runtime'] : [])])
  const degraded = Array.isArray(manifest.degraded) ? (manifest.degraded as unknown[]) : null
  check(
    hosted
      ? 'manifest: degraded[] EMPTY (or only the voice pack and, under the hosted profile, the runtime pack — the allowed absences)'
      : 'manifest: degraded[] EMPTY (or exactly the voice pack, the one allowed absence)',
    degraded !== null && degraded.every(d => allowedAbsences.has(d)) && new Set(degraded).size === degraded.length,
    JSON.stringify(manifest.degraded),
  )
  const ip = manifest.imageProcessing as { selfContained?: boolean } | undefined
  check('manifest: imageProcessing honesty recorded', !!ip && ip.selfContained === false)
  const tsit = manifest.treeSitter as { grammarPack?: { vendored?: boolean } } | undefined
  check('manifest: grammarPack vendored', tsit?.grammarPack?.vendored === true)
}

if (failures > 0) {
  console.error(`\nvista artifact: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nvista artifact: green')
