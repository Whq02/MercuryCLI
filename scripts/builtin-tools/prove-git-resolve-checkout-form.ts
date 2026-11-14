import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitClient, gitFixture } from './gitFixture.ts'

let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
for (const scenario of ['crlf', 'stored', 'attribute-lf', 'smudge'] as const) {
  const world = gitFixture(`git-checkout-${scenario}-`)
  let client: Awaited<ReturnType<typeof gitClient>> | undefined
  const names = ['base.txt', 'both.txt', 'ours.txt', 'theirs.txt', 'base.bin', 'both.bin']
  const config: Array<[string, string]> = [['core.autocrlf', scenario === 'stored' ? 'false' : 'true']]
  if (scenario === 'smudge') {
    const filter = join(world.scratch, 'upper.cjs')
    writeFileSync(filter, "process.stdout.write(require('node:fs').readFileSync(0, 'utf8').toUpperCase())\n")
    config.push(['filter.upper.clean', 'cat'], ['filter.upper.smudge', `"${process.execPath.replaceAll('\\', '/')}" "${filter.replaceAll('\\', '/')}"`])
  }
  Object.assign(world.env, { GIT_CONFIG_COUNT: String(config.length), ...Object.fromEntries(config.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])) })
  const cat = (file: string, stage: number, filtered: boolean): Buffer => execFileSync('git', filtered ? ['cat-file', '--filters', `--path=${file}`, `:${stage}:${file}`] : ['cat-file', 'blob', `:${stage}:${file}`], { cwd: world.root, env: world.env, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    world.put('.gitattributes', scenario === 'attribute-lf' ? '*.txt text eol=lf\n' : scenario === 'smudge' ? '*.txt filter=upper\n' : '')
    const seed = (side: string) => {
      for (const file of names) writeFileSync(join(world.root, file), file.endsWith('.bin') ? Buffer.from(`\ufeff${side}\nlast\n`, 'utf16le') : Buffer.from(`${side}\nlast\n`))
      world.git(['add', '--', '.gitattributes', ...names]); world.git(['commit', '--quiet', '-m', side])
    }
    seed('base'); world.git(['switch', '--quiet', '-c', 'other']); seed('theirs'); world.git(['switch', '--quiet', 'main']); seed('ours')
    try { world.git(['merge', '--no-edit', 'other']) } catch {}
    const expected = new Map(names.map(file => {
      const stages = file.startsWith('both') ? [2, 3] : [file.startsWith('base') ? 1 : file.startsWith('ours') ? 2 : 3]
      return [file, Buffer.concat(stages.map(stage => cat(file, stage, true)))]
    }))
    const stored = new Map(['base.bin', 'both.bin'].map(file => [file, Buffer.concat((file.startsWith('both') ? [2, 3] : [1]).map(stage => cat(file, stage, false)))]))
    client = await gitClient(world)
    for (const file of names) {
      const take = file.startsWith('base') ? 'base' : file.startsWith('both') ? 'both' : file.startsWith('ours') ? 'ours' : 'theirs'
      const answer = await client.call('Git', { op: 'resolve', path: file, take })
      const actual = readFileSync(join(world.root, file))
      check(`${scenario}/${file}: ${take} writes Git checkout-form bytes`, actual.equals(expected.get(file)!) && answer.startsWith(`resolved '${file}' — staged;`), `${answer}; ${actual.toString('hex')}`)
      if (file.endsWith('.bin')) check(`${scenario}/${file}: binary and UTF-16 bytes survive`, actual.equals(stored.get(file)!))
      else if (scenario === 'crlf') check(`${scenario}/${file}: every line ends CRLF`, actual.toString().replaceAll('\r\n', '').indexOf('\n') === -1 && actual.includes(Buffer.from('\r\n')))
      else if (scenario === 'attribute-lf' || scenario === 'stored') check(`${scenario}/${file}: no CRLF conversion`, !actual.includes(Buffer.from('\r\n')))
      else check(`${scenario}/${file}: the external smudge filter ran`, actual.toString().includes(take === 'both' ? 'THEIRS' : take.toUpperCase()))
    }
    check(`${scenario}: all selected files leave the unmerged index`, world.git(['ls-files', '--unmerged']) === '')
  } finally { await client?.close(); world.dispose() }
}
console.log(`Git checkout-form resolution: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
