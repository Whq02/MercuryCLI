#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { parseFrontmatterPaths, parseInstructionFileContent } = await import(join(SRC, 'services/instructions/sourceText.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const guide = '/proof/project/MERCURY.md'
const parse = (text: string) => parseInstructionFileContent(text, guide, 'Project', guide)

console.log('frontmatter paths')
check('no paths key: the body alone', same(parseFrontmatterPaths('---\ndescription: x\n---\nbody\n'), { content: 'body\n' }))
const trimmed = parseFrontmatterPaths('---\npaths:\n  - src/**\n  - docs/**/**\n  - ""\n  - lib\n---\nbody\n')
check('one trailing /** is cut from each pattern, empties drop, the rest stay', same(trimmed.paths, ['src', 'docs/**', 'lib']), JSON.stringify(trimmed))
check('every pattern "**" means unconditional', same(parseFrontmatterPaths('---\npaths: "**"\n---\nbody\n'), { content: 'body\n' }))
check('patterns that all reduce to nothing mean unconditional', same(parseFrontmatterPaths('---\npaths: "/**"\n---\nbody\n'), { content: 'body\n' }), JSON.stringify(parseFrontmatterPaths('---\npaths: "/**"\n---\nbody\n')))
check('a "**" beside a real pattern keeps both', same(parseFrontmatterPaths('---\npaths: ["**", "src/**"]\n---\nbody\n').paths, ['**', 'src']))
check('globs: scopes a rule the same way paths: does', same(parseFrontmatterPaths('---\nglobs: "src/**/*.tsx"\n---\nbody\n'), { content: 'body\n', paths: ['src/**/*.tsx'] }), JSON.stringify(parseFrontmatterPaths('---\nglobs: "src/**/*.tsx"\n---\nbody\n')))
check('paths: wins when both keys are present', same(parseFrontmatterPaths('---\npaths: lib/**\nglobs: src/**\n---\nbody\n').paths, ['lib']))

console.log('html comments')
const plain = parse('Keep this.\n\nAnd this.\n')
check('a file without a comment keeps its bytes and is not marked as differing', plain.info?.content === 'Keep this.\n\nAnd this.\n' && plain.info?.contentDiffersFromDisk === false)
const commented = parse('Lead.\n\n<!-- hidden note -->\n\nTail.\n')
check('a whole-line comment leaves, its blank line stays, and the file is marked as differing', commented.info?.content === 'Lead.\n\n\n\nTail.\n' && commented.info?.contentDiffersFromDisk === true && commented.info?.rawContent === 'Lead.\n\n<!-- hidden note -->\n\nTail.\n', JSON.stringify(commented.info?.content))
const residue = parse('<!-- one --> Use bun <!-- two -->\n')
check('text sharing the comment line survives, every span is removed', residue.info?.content === ' Use bun \n', JSON.stringify(residue.info?.content))
const spanning = parse('Start.\n\n<!--\nline one\nline two\n-->\n\nEnd.\n')
check('a comment spanning lines is one span', spanning.info?.content === 'Start.\n\n\n\nEnd.\n', JSON.stringify(spanning.info?.content))
const openOnly = parse('Start.\n\n<!-- never closed\n\nEnd.\n')
check('an unclosed comment is not stripped', openOnly.info?.content.includes('<!-- never closed') === true, JSON.stringify(openOnly.info?.content))

console.log('include paths through the walker')
const walked = parse([
  'See @docs/intro.md and @./setup.md.',
  '',
  '<!-- @docs/hidden.md --> after the comment @docs/after.md',
  '',
  '```',
  '@docs/in-fence.md',
  '```',
  '',
  'Inline `@docs/in-span.md` stays out.',
  '',
  '- item @docs/listed.md',
  '  - nested @docs/nested.md',
  '',
  '<div>@docs/in-html.md</div>',
  '',
  'Hello @alice and @scope/pkg.',
].join('\n') + '\n')
const names = walked.includePaths.map((p: string) => p.slice('/proof/project/'.length))
check('prose mentions and included files are collected in reading order', same(names, ['docs/intro.md', 'setup.md', 'docs/after.md', 'docs/listed.md', 'docs/nested.md', 'scope/pkg']), JSON.stringify(names))
check('a fenced block, a code span, a comment interior and a plain html block contribute nothing', !names.some((n: string) => /in-fence|in-span|hidden|in-html/.test(n)))
check('a bare mention rides beside the includes, not among them; a scoped name with a slash is path evidence', walked.bareMentionPaths.some((p: string) => p.endsWith('/alice')) && !walked.includePaths.some((p: string) => p.endsWith('/alice')) && walked.bareMentionPaths.length === 1, JSON.stringify(walked.bareMentionPaths))

console.log('the parse entry')
const refused = parseInstructionFileContent('bytes', '/proof/project/diagram.PNG', 'Project', '/proof/project/diagram.PNG')
check('a non-text extension composes nothing: no entry, no includes, no mentions', refused.info === null && refused.includePaths.length === 0 && refused.bareMentionPaths.length === 0)
const extensionless = parseInstructionFileContent('Rules. See @docs/a.md\n', '/proof/project/Makefile', 'Project', '/proof/project/Makefile')
check('an extension-less file composes and its includes are read', extensionless.info?.content === 'Rules. See @docs/a.md\n' && extensionless.includePaths.length === 1)
const upper = parseInstructionFileContent('Rules.\n', '/proof/project/NOTES.MD', 'Project')
check('an upper-case text extension composes', upper.info?.content === 'Rules.\n')
const crlf = parse('Line one.\r\n\r\nSee @docs/crlf.md\r\n')
check('a CRLF file without a comment keeps its bytes even when the includes are lexed', crlf.info?.content === 'Line one.\r\n\r\nSee @docs/crlf.md\r\n' && crlf.info?.contentDiffersFromDisk === false && crlf.includePaths.length === 1, JSON.stringify(crlf.info?.content))
const fronted = parse('---\npaths: src/**\n---\nBody.\n')
check('a frontmatter-only transform marks the entry and keeps the disk bytes beside it', fronted.info?.content === 'Body.\n' && fronted.info?.contentDiffersFromDisk === true && fronted.info?.rawContent === '---\npaths: src/**\n---\nBody.\n' && same(fronted.info?.globs, ['src']), JSON.stringify(fronted.info))
const noBase = parseInstructionFileContent('See @docs/a.md\n\n<!-- x -->\n\nmore\n', guide, 'Project')
check('without an include base the content is still stripped and no include is read', noBase.info?.content === 'See @docs/a.md\n\n\n\nmore\n' && noBase.includePaths.length === 0 && noBase.bareMentionPaths.length === 0, JSON.stringify(noBase))
const inline = parse('See @docs/a.md and <!-- x --> more\n')
check('a comment inside a paragraph line is not a comment block: it stays, and the include beside it is read', inline.info?.content === 'See @docs/a.md and <!-- x --> more\n' && inline.info?.contentDiffersFromDisk === false && inline.includePaths.length === 1, JSON.stringify(inline))
const repeated = parse('See @docs/a.md then @docs/a.md again, and @bob plus @bob.\n')
check('a spelling repeated in one file resolves once in each list', repeated.includePaths.length === 1 && repeated.bareMentionPaths.length === 1, JSON.stringify(repeated))

console.log(failures ? `FAIL instruction comments and paths: ${failures} failures` : 'PASS instruction comments and paths')
process.exit(failures ? 1 : 0)
