import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitClient, gitFixture } from '../builtin-tools/gitFixture.ts'

const at = process.argv.indexOf('--baseline')
if (at < 0 || !process.argv[at + 1]) throw new Error('pass --baseline <scratch record>, and --record for the parent')
const baseline = process.argv[at + 1]!
const world = gitFixture('ast-clean-cost-')
const preload = join(world.scratch, 'trace.cjs')
const trace = join(world.scratch, 'trace.json')
world.put('clean.ts', 'const first = needle(1);\nconst second = needle(2);\n')
writeFileSync(preload, String.raw`
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const write = fs.writeFileSync;
const calls = {};
let parses = 0;
const hit = (name, args) => {
  if (typeof args[0] === 'string' && path.resolve(args[0]) === process.env.AST_PROOF_FILE) calls[name] = (calls[name] || 0) + 1;
};
for (const name of ['readFileSync', 'statSync', 'lstatSync', 'existsSync', 'openSync', 'accessSync', 'realpathSync']) {
  const original = fs[name];
  const wrapped = function (...args) { hit(name, args); return Reflect.apply(original, this, args); };
  if (original.native) wrapped.native = function (...args) { hit(name + '.native', args); return Reflect.apply(original.native, this, args); };
  fs[name] = wrapped;
}
for (const name of ['readFile', 'stat', 'lstat', 'open', 'access', 'realpath']) {
  const original = fs.promises[name];
  fs.promises[name] = function (...args) { hit('promises.' + name, args); return Reflect.apply(original, this, args); };
}
Module.syncBuiltinESMExports();
const load = Module._load;
Module._load = function (...args) {
  const mod = Reflect.apply(load, this, args);
  if (String(args[0]).endsWith('tree-sitter.js') && mod.Parser && !mod.Parser.prototype.__astProofCounted) {
    const parse = mod.Parser.prototype.parse;
    mod.Parser.prototype.parse = function (...values) { parses++; return Reflect.apply(parse, this, values); };
    Object.defineProperty(mod.Parser.prototype, '__astProofCounted', { value: true });
  }
  return mod;
};
process.once('SIGTERM', () => { write(process.env.AST_PROOF_TRACE, JSON.stringify({ calls, parses })); process.exit(0); });
`)
Object.assign(world.env, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${preload}"`, AST_PROOF_FILE: join(world.root, 'clean.ts'), AST_PROOF_TRACE: trace })
let client: Awaited<ReturnType<typeof gitClient>> | undefined
try {
  client = await gitClient(world)
  const answers = []
  for (const [name, input] of [
    ['AstSearch', { pattern: 'needle($X)', path: 'clean.ts' }],
    ['AstEdit', { pattern: 'needle($X)', rewrite: 'found($X)', path: 'clean.ts' }],
  ] as const) answers.push((await client.call(name, input)).replaceAll(world.root, '<root>'))
  await client.close(); client = undefined
  const measured = { ...JSON.parse(readFileSync(trace, 'utf8')), answers }
  if (!(measured.parses > 0) || !(measured.calls.readFileSync > 0)) throw new Error('the real Node trace did not observe parser and file calls')
  if (process.argv.includes('--record')) {
    writeFileSync(baseline, JSON.stringify(measured, null, 2) + '\n')
    console.log(`RECORDED clean Node cost: ${JSON.stringify(measured.calls)}; parser calls ${measured.parses}`)
  } else {
    const before = JSON.parse(readFileSync(baseline, 'utf8'))
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    const rows = [['per-file filesystem calls', equal(before.calls, measured.calls)], ['parser calls', before.parses === measured.parses], ['answer bytes including the paired edit token', equal(before.answers, measured.answers)]] as const
    for (const [label, ok] of rows) console.log(`[${ok ? 'PASS' : 'FAIL'}] clean-file ${label}`)
    console.log(`Node cost: ${JSON.stringify(measured.calls)}; parser calls ${measured.parses}`)
    if (rows.some(([, ok]) => !ok)) process.exitCode = 1
  }
} finally { await client?.close(); world.dispose() }
