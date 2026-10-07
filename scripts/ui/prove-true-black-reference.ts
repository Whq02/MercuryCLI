import { matrix } from './generate-visual-baseline.ts'
import { entryId, readManifest, readStoredGrid, gridDigest, styleDigest } from './visualBaseline.ts'

const id = 'frame--120x40--true-black--truecolor--full'
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`)
}
check('the writer matrix includes the True Black reference frame', matrix().some(spec => entryId(spec) === id))
const entry = readManifest()?.entries.find(row => row.id === id)
check('the writer recorded the True Black reference in the manifest', entry !== undefined)
if (entry) {
  const grid = readStoredGrid(entry)
  check('the stored reference is the requested size and appearance', grid.cols === 120 && grid.rows === 40 && entry.theme === 'true-black')
  check('the reference is a painted product frame', grid.text.some(row => row.includes('first task')) && grid.text.some(row => row.includes('Type a prompt')) && grid.styles.some(row => row.length > 0), grid.text.join('\n'))
  const blackCells = grid.styles.flat().reduce((count, [, length, , background]) => count + (background === '000000' ? length : 0), 0)
  check('True Black paints a black ground, not just a named manifest row', blackCells > grid.cols * grid.rows / 2, `${blackCells} black cells`)
  check('the stored text and style digests match the writer receipt', gridDigest(grid, entry.masks) === entry.gridDigest && styleDigest(grid, entry.masks) === entry.styleDigest)
  check('the frame is tied to its source and built artifact', /^[0-9a-f]{7,40}$/.test(entry.sourceSha) && /^[0-9a-f]{40}$/.test(entry.buildDigest), JSON.stringify({ sourceSha: entry.sourceSha, buildDigest: entry.buildDigest }))
}
console.log(`true-black-reference: ${failures} failures`)
process.exit(failures ? 1 : 0)
