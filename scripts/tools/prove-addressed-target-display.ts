import { join, win32 } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const { src } = kit
let hintFor = ''
const check = (label: string, ok: boolean, detail = ''): void => kit.check(label, ok, ok ? detail : `${detail} | to fix: ${hintFor}`)
const file = await import(`${src}/platform/files/file.ts`)
const readUi = await import(`${src}/tools/read/rows.tsx`)
const writeUi = await import(`${src}/tools/write/rows.tsx`)
const editUi = await import(`${src}/tools/edit/rows.tsx`)

const split = (target: string): [string, string] => {
  const parts = file.splitAddressedTarget?.(target) ?? { container: target, address: '' }
  return [parts.container, parts.address]
}
const cases: Array<[target: string, container: string, address: string]> = [
  ['C:\\src\\s143\\sql\\rows.sqlite:items/1#delete', 'C:\\src\\s143\\sql\\rows.sqlite', ':items/1#delete'],
  ['C:\\src\\s143\\sql\\rows.sqlite:items/1', 'C:\\src\\s143\\sql\\rows.sqlite', ':items/1'],
  ['C:\\src\\s143\\sql\\rows.sqlite:items/name=a/b', 'C:\\src\\s143\\sql\\rows.sqlite', ':items/name=a/b'],
  ['C:\\src\\s143\\sql\\bundle.zip:docs/guide/intro.md', 'C:\\src\\s143\\sql\\bundle.zip', ':docs/guide/intro.md'],
  ['C:\\src\\s143\\sql\\rows.jsonl#read?q=.a/.b', 'C:\\src\\s143\\sql\\rows.jsonl', '#read?q=.a/.b'],
  ['C:\\src\\s143\\sql\\rows.sqlite#read?table=items&where=id/2>1', 'C:\\src\\s143\\sql\\rows.sqlite', '#read?table=items&where=id/2>1'],
  ['C:\\src\\s143\\sql\\rows.sqlite:items#read?where=id/2>1&limit=5', 'C:\\src\\s143\\sql\\rows.sqlite', ':items#read?where=id/2>1&limit=5'],
  ['C:\\src\\s143\\sql\\rows.sqlite#read?sql=SELECT id/2 FROM items', 'C:\\src\\s143\\sql\\rows.sqlite', '#read?sql=SELECT id/2 FROM items'],
  ['C:\\src\\s143\\sql\\notes.txt:1-5', 'C:\\src\\s143\\sql\\notes.txt:1-5', ''],
  ['C:\\src\\s143\\sql\\notes.txt', 'C:\\src\\s143\\sql\\notes.txt', ''],
  ['/work/sql/rows.sqlite:items/1#delete', '/work/sql/rows.sqlite', ':items/1#delete'],
]
hintFor = 'splitAddressedTarget in src/platform/files/file.ts must split a target at the first address marker after its container, Windows drive colon and line ranges excepted'
for (const [target, container, address] of cases) {
  const got = split(target)
  check(`the address of ${target} begins after its container`, got[0] === container && got[1] === address, JSON.stringify(got))
}

hintFor = 'displayAddressedTarget in src/platform/files/file.ts must relativize only the container and append the address exactly as typed'
const cwd = 'C:\\src\\s143\\sql'
const shown = (target: string): string => file.displayAddressedTarget?.(target, (container: string) => win32.relative(cwd, container)) ?? win32.relative(cwd, target)
check('the Windows path functions alone turn a row address into a path', win32.relative(cwd, 'C:\\src\\s143\\sql\\rows.sqlite:items/1#delete') === 'rows.sqlite:items\\1#delete')
check('a row deletion is shown with its address as typed', shown('C:\\src\\s143\\sql\\rows.sqlite:items/1#delete') === 'rows.sqlite:items/1#delete', shown('C:\\src\\s143\\sql\\rows.sqlite:items/1#delete'))
check('an archive member is shown with its entry path as typed', shown('C:\\src\\s143\\sql\\bundle.zip:docs/guide/intro.md') === 'bundle.zip:docs/guide/intro.md', shown('C:\\src\\s143\\sql\\bundle.zip:docs/guide/intro.md'))
check('a jq filter is shown as typed', shown('C:\\src\\s143\\sql\\rows.jsonl#read?q=.a/.b') === 'rows.jsonl#read?q=.a/.b', shown('C:\\src\\s143\\sql\\rows.jsonl#read?q=.a/.b'))
check('a table predicate is shown as typed', shown('C:\\src\\s143\\sql\\rows.sqlite#read?table=items&where=id/2>1') === 'rows.sqlite#read?table=items&where=id/2>1', shown('C:\\src\\s143\\sql\\rows.sqlite#read?table=items&where=id/2>1'))
check('a statement is shown as typed', shown('C:\\src\\s143\\sql\\rows.sqlite#read?sql=SELECT id/2 FROM items') === 'rows.sqlite#read?sql=SELECT id/2 FROM items', shown('C:\\src\\s143\\sql\\rows.sqlite#read?sql=SELECT id/2 FROM items'))
check('the container keeps the spelling of its platform', shown('C:\\src\\s143\\sql\\sub\\rows.sqlite:items/1') === 'sub\\rows.sqlite:items/1', shown('C:\\src\\s143\\sql\\sub\\rows.sqlite:items/1'))
check('a line range and a plain path are shown as before', shown('C:\\src\\s143\\sql\\notes.txt:1-5') === 'notes.txt:1-5' && shown('C:\\src\\s143\\sql\\sub\\notes.txt') === 'sub\\notes.txt')

hintFor = 'getDisplayPath in src/platform/files/file.ts and getToolUseSummary in the UI.tsx of src/tools/read, WriteTool and EditTool (and backfillObservableInput of ReadTool) must keep the address whole when showing a path'
const row = `${join(home, 'rows.sqlite')}:items/x/../1#delete`
const member = join(home, 'bundle.zip') + ':docs/./intro.md'
const query = `${join(home, 'rows.jsonl')}#read?q=.a/../b`
check('the display path keeps a row address whole on every platform', file.getDisplayPath(row) === 'rows.sqlite:items/x/../1#delete', file.getDisplayPath(row))
check('the display path keeps an archive entry whole', file.getDisplayPath(member) === 'bundle.zip:docs/./intro.md', file.getDisplayPath(member))
check('the display path keeps a query whole', file.getDisplayPath(query) === 'rows.jsonl#read?q=.a/../b', file.getDisplayPath(query))
check('a plain path is displayed as before', file.getDisplayPath(join(home, 'sub', 'notes.txt')) === join('sub', 'notes.txt'))
check('the Write row names the address as typed', writeUi.getToolUseSummary({ file_path: row, content: 'DELETE' }) === 'rows.sqlite:items/x/../1#delete', String(writeUi.getToolUseSummary({ file_path: row, content: 'DELETE' })))
check('the Edit row names the address as typed', editUi.getToolUseSummary({ file_path: `${join(home, 'rows.sqlite')}:items/x/../1` }) === 'rows.sqlite:items/x/../1', String(editUi.getToolUseSummary({ file_path: `${join(home, 'rows.sqlite')}:items/x/../1` })))
check('the Read row names the query as typed', readUi.getToolUseSummary({ file_path: query }) === 'rows.jsonl#read?q=.a/../b', String(readUi.getToolUseSummary({ file_path: query })))
const observed = { file_path: `${join(home, 'rows.sqlite')}:items/x/../1` }
kit.ReadTool.backfillObservableInput(observed)
check('what a hook and a card are shown of a Read keeps the address', observed.file_path === join(home, 'rows.sqlite') + ':items/x/../1', observed.file_path)
kit.finish()
