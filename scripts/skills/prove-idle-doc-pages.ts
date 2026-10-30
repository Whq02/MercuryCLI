import { execFileSync, spawnSync } from 'node:child_process'
import { bundledDocPagesPacked } from '../../src/skills/bundled/mercuryDocsPages.ts'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scratch = mkdtempSync(join(tmpdir(), 'idle-doc-pages-'))
try {
  const pages = ['README.md', ...execFileSync('git', ['-C', root, 'ls-files', '--', 'docs'], { encoding: 'utf8' }).trim().split('\n').filter(name => /^docs\/[^/]+\.md$/.test(name))]
  const prefixes = new Set(pages.map(name => readFileSync(join(root, name), 'utf8').slice(0, 1024)))
  assert.equal(prefixes.size, pages.length)
  const entry = join(scratch, 'fixture.ts')
  writeFileSync(entry, `
import { writeHeapSnapshot } from 'node:v8'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { enableConfigs } from ${JSON.stringify(join(root, 'src/utils/config.ts'))}
import { registerMercuryDocsSkill, mercuryDocPages, mercuryDocsPrompt } from ${JSON.stringify(join(root, 'src/skills/bundled/mercuryDocs.ts'))}
import { getBundledSkills, getBundledSkillExtractDir } from ${JSON.stringify(join(root, 'src/skills/bundledSkills.ts'))}
enableConfigs()
registerMercuryDocsSkill()
const command = getBundledSkills().find(c => c.name === 'mercury-docs')!
const before = { name:command.name, description:command.description, argumentHint:command.argumentHint, allowedTools:command.allowedTools }
writeHeapSnapshot(join(process.env.MERCURY_CONFIG_DIR!, 'before.heapsnapshot'))
const results = await Promise.all([command.getPromptForCommand('how do I schedule a prompt', {} as never), command.getPromptForCommand('how do I schedule a prompt', {} as never)])
const pages = mercuryDocPages()
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const files = Object.fromEntries(Object.entries(pages).map(([name, text]) => [name, {expected:digest(text), actual:digest(readFileSync(join(getBundledSkillExtractDir('mercury-docs'), name), 'utf8'))}]))
writeHeapSnapshot(join(process.env.MERCURY_CONFIG_DIR!, 'after.heapsnapshot'))
writeFileSync(join(process.env.MERCURY_CONFIG_DIR!, 'result.json'), JSON.stringify({before, after:{ name:command.name, description:command.description, argumentHint:command.argumentHint, allowedTools:command.allowedTools }, files, frozen:Object.isFrozen(pages), memoized:pages===mercuryDocPages(), prompt:mercuryDocsPrompt('how do I schedule a prompt'), concurrent:JSON.stringify(results[0])===JSON.stringify(results[1]), result:results[0]}))
`)
  const built = await Bun.build({
    entrypoints: [entry], outdir: scratch, naming: 'fixture.mjs', target: 'node', format: 'esm', minify: true,
    loader: { '.md': 'text', '.txt': 'text', '.sh': 'text', '.py': 'text', '.html': 'text', '.xml': 'text', '.dot': 'text' },
    define: { MACRO: JSON.stringify({ VERSION: '1.0.0' }), MERCURY_DOC_PAGES_PACKED: JSON.stringify(bundledDocPagesPacked()), 'process.env.NODE_ENV': JSON.stringify('test') },
    plugins: [{ name: 'source-imports', setup(build: { onResolve: (options: { filter: RegExp }, resolve: (args: { path: string }) => { path: string; external?: boolean } | undefined) => void }) {
      build.onResolve({ filter: /^src\// }, args => {
        const base = resolve(root, args.path.replace(/\.(js|jsx)$/, ''))
        const path = [base, ...['.ts', '.tsx', '.js', '.json'].flatMap(ext => [base + ext, join(base, 'index' + ext)])].find(path => statSync(path, { throwIfNoEntry: false })?.isFile())
        return path ? { path } : undefined
      })
      build.onResolve({ filter: /^color-diff-napi$/ }, () => ({ path: join(root, 'src/native-ts/color-diff/index.ts') }))
      build.onResolve({ filter: /\.node$/ }, args => ({ path: args.path, external: true }))
      build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: join(root, 'node_modules/jsonc-parser/lib/esm/main.js') }))
    } }],
  })
  assert.ok(built.success, built.logs.join('\n'))
  const child = spawnSync('node', [join(scratch, 'fixture.mjs')], {
    cwd: scratch, encoding: 'utf8', timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, MERCURY_CONFIG_DIR: scratch, MERCURY_TMPDIR: join(scratch, 'tmp'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' },
  })
  assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`)
  const retainedPages = (file: string) => {
    const heap = JSON.parse(readFileSync(file, 'utf8'))
    const fields: string[] = heap.snapshot.meta.node_fields
    const width = fields.length, name = fields.indexOf('name'), type = fields.indexOf('type'), size = fields.indexOf('self_size')
    let count = 0, bytes = 0
    for (let node = 0; node < heap.nodes.length; node += width) {
      if (heap.snapshot.meta.node_types[type][heap.nodes[node + type]] !== 'string' || !prefixes.has(heap.strings[heap.nodes[node + name]])) continue
      count++
      bytes += heap.nodes[node + size]
    }
    return { count, bytes }
  }
  const before = retainedPages(join(scratch, 'before.heapsnapshot'))
  const after = retainedPages(join(scratch, 'after.heapsnapshot'))
  console.log(JSON.stringify({ pages: pages.length, before, after }))
  assert.equal(before.count, 0, 'registering the documentation skill must not retain page strings')
  assert.equal(before.bytes, 0)
  assert.equal(after.count, pages.length, 'first use must materialize every shipped page')
  const result = JSON.parse(readFileSync(join(scratch, 'result.json'), 'utf8'))
  assert.deepEqual(result.before, result.after)
  assert.equal(result.frozen, true)
  assert.equal(result.memoized, true)
  assert.equal(result.concurrent, true)
  assert.deepEqual(Object.keys(result.files).sort(), [...pages].sort())
  for (const name of pages) {
    assert.equal(result.files[name].actual, result.files[name].expected, name)
    const text = readFileSync(join(root, name), 'utf8')
    const { createHash } = await import('node:crypto')
    assert.equal(result.files[name].actual, createHash('sha256').update(text).digest('hex'), name)
  }
  assert.equal(result.result.length, 1)
  assert.equal(result.result[0].type, 'text')
  assert.ok(result.result[0].text.endsWith(result.prompt))
  assert.ok(result.result[0].text.startsWith('Base directory for this skill: '))
  console.log('PASS: no idle pages; first use preserves every page, prompt and extraction')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
