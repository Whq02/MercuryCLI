import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitClient, gitFixture } from './gitFixture.ts'

let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
const world = gitFixture('git-one-mark-')
let client: Awaited<ReturnType<typeof gitClient>> | undefined
const utf16 = (text: string): Buffer => Buffer.from(text, 'utf16le')
const utf32 = (text: string): Buffer => Buffer.concat([...text].map(letter => { const unit = Buffer.alloc(4); unit.writeUInt32LE(letter.codePointAt(0)!); return unit }))
const marked16 = (text: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), utf16(text)])
const files: Array<{ file: string; encoding: string; width: number; write: (text: string) => Buffer }> = [
  { file: 'wide.txt', encoding: 'UTF-16', width: 2, write: marked16 },
  { file: 'little.txt', encoding: 'UTF-16LE-BOM', width: 2, write: marked16 },
  { file: 'quad.txt', encoding: 'UTF-32', width: 4, write: text => Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), utf32(text)]) },
  { file: 'bare.txt', encoding: 'UTF-16LE', width: 0, write: utf16 },
]
const marks = ['feff', 'fffe', '0000feff', 'fffe0000']
const raw = (args: string[], input?: Buffer): Buffer => execFileSync('git', args, { cwd: world.root, env: world.env, stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) })
const form = (file: string, stage: number): Buffer => {
  const temp = raw(['checkout-index', `--stage=${stage}`, '--temp', '--', file]).toString().split('\t')[0]!.trim()
  const bytes = readFileSync(join(world.root, temp))
  rmSync(join(world.root, temp), { force: true })
  return bytes
}
try {
  world.put('.gitattributes', files.map(f => `${f.file} text working-tree-encoding=${f.encoding}\n`).join('') + 'base-*.txt text working-tree-encoding=UTF-16\n')
  const seed = (side: string) => {
    for (const f of files) writeFileSync(join(world.root, f.file), f.write(`${side} é\nlast\n`))
    writeFileSync(join(world.root, 'base-wide.txt'), marked16(`${side}\n`))
    writeFileSync(join(world.root, 'undeclared.bin'), marked16(`${side}\n`))
    world.git(['add', '-A']); world.git(['commit', '--quiet', '-m', side])
  }
  seed('base'); world.git(['switch', '--quiet', '-c', 'other']); seed('theirs'); world.git(['switch', '--quiet', 'main']); seed('ours')
  try { world.git(['merge', '--no-edit', 'other']) } catch {}
  const stored = (file: string, stage: number): Buffer => raw(['cat-file', 'blob', `:${stage}:${file}`])
  const expected = new Map(files.map(f => {
    const joined = raw(['hash-object', '-w', '--stdin', '--no-filters'], Buffer.concat([stored(f.file, 2), stored(f.file, 3)])).toString().trim()
    return [f.file, { once: raw(['cat-file', '--filters', `--path=${f.file}`, joined]), sides: [form(f.file, 2), form(f.file, 3)], blob: Buffer.concat([stored(f.file, 2), stored(f.file, 3)]) }]
  }))
  const baseForm = form('base-wide.txt', 1)
  const undeclared = Buffer.concat([stored('undeclared.bin', 2), stored('undeclared.bin', 3)])
  client = await gitClient(world)
  for (const f of files) {
    const want = expected.get(f.file)!
    const answer = await client.call('Git', { op: 'resolve', path: f.file, take: 'both' })
    const written = readFileSync(join(world.root, f.file))
    const lead = written.subarray(0, f.width).toString('hex')
    check(`${f.encoding}: each side's checkout form ${f.width ? 'opens with the same byte-order mark' : 'carries no mark'}`, f.width ? marks.includes(want.sides[0]!.subarray(0, f.width).toString('hex')) && want.sides[0]!.subarray(0, f.width).equals(want.sides[1]!.subarray(0, f.width)) : !marks.includes(want.sides[0]!.subarray(0, 2).toString('hex')), want.sides.map(side => side.subarray(0, 4).toString('hex')).join(' '))
    check(`${f.encoding}: both writes the two sides as one text in the declared encoding`, answer.startsWith(`resolved '${f.file}' — staged;`) && written.equals(want.once) && written.equals(Buffer.concat([want.sides[0]!, want.sides[1]!.subarray(f.width)])), `${answer.slice(0, 120)}; ${written.toString('hex')}`)
    if (f.width) check(`${f.encoding}: the mark stands once, at the head`, marks.includes(lead) && written.subarray(f.width).toString('hex').match(new RegExp(`.{${f.width * 2}}`, 'g'))!.every(unit => unit !== lead), written.toString('hex'))
    let staged: Buffer = Buffer.alloc(0)
    try { staged = raw(['cat-file', 'blob', `:0:${f.file}`]) } catch {}
    check(`${f.encoding}: the staged blob is the stored sides joined`, staged.equals(want.blob) && staged.toString() === 'ours é\nlast\ntheirs é\nlast\n', staged.toString('hex'))
  }
  const base = await client.call('Git', { op: 'resolve', path: 'base-wide.txt', take: 'base' })
  check('a declared file taken as base is its one side\'s checkout form', base.startsWith("resolved 'base-wide.txt' — staged;") && readFileSync(join(world.root, 'base-wide.txt')).equals(baseForm), base.slice(0, 160))
  const kept = await client.call('Git', { op: 'resolve', path: 'undeclared.bin', take: 'both' })
  check('a file with no declared encoding keeps every stored byte, the second mark among them', kept.startsWith("resolved 'undeclared.bin' — staged;") && readFileSync(join(world.root, 'undeclared.bin')).equals(undeclared) && undeclared.subarray(0, 2).toString('hex') === 'fffe' && undeclared.indexOf(Buffer.from([0xff, 0xfe]), 2) > 0, kept.slice(0, 160))
  check('every path left the unmerged index', world.git(['ls-files', '--unmerged']) === '', world.git(['ls-files', '--unmerged']))
} finally { await client?.close(); world.dispose() }
console.log(`Git resolve one mark: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
