import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../tools/readViewKit.js'

isolatedHome(import.meta.filename)
const { runArtifactArena, grabScreens, sendStamp } = await import('../streaming/artifactArena.js')
let passed = 0, failed = 0
const check = (name: string, ok: boolean, detail = '') => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail}`}`) }
for (const [columns, rows, key] of [[120, 40, 1], [80, 24, 9]]) {
  const run = await runArtifactArena({
    cols: columns, rows, seconds: 24, keep: true,
    turns: cwd => [
      { kind: 'tool_use', name: 'Read', input: { file_path: `${join(cwd, 'data.sqlite')}:items/${key}` } },
      { kind: 'tool_use', name: 'Write', input: { file_path: `${join(cwd, 'data.sqlite')}:items/${key}#delete`, content: 'DELETE' } },
      { kind: 'text', text: 'The row request is complete.' },
    ],
    seedHome: (_config, cwd) => {
      const db = new Database(join(cwd, 'data.sqlite'))
      db.run("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1,'visible before deletion')")
      db.close()
    },
    sends: ['after:Type a prompt:200:hello', 'after:hello:400:\\r', 'after:Delete this row?:1600:\\r'],
    anchor: { needle: 'Delete this row?', atMs: 8000 },
  })
  try {
    const approval = run.sendLog.find(send => send.after === 'Delete this row?')
    const frame = approval ? grabScreens(run, columns, rows, [sendStamp(run, approval) - 500])[0]!.rows.join('\n') : run.ptyReads.map(row => row.text).join('')
    console.log(`FRAME ${columns}x${rows}\n${frame}`)
    if (process.env.SQLITE_CARD_FRAMES) {
      mkdirSync(process.env.SQLITE_CARD_FRAMES, { recursive: true })
      writeFileSync(join(process.env.SQLITE_CARD_FRAMES, `delete-${columns}x${rows}.txt`), frame)
    }
    check(`${columns}x${rows}: ordinary permission frame names deletion`, !!approval && frame.includes('Delete SQLite row') && frame.includes('Delete this row?'))
    check(`${columns}x${rows}: the row or missing state is shown before approval`, frame.includes(key === 1 ? 'visible before deletion' : 'Row not found; nothing will be deleted.'))
    check(`${columns}x${rows}: it never calls the row a new file`, !frame.includes('Create file') && !frame.includes('Overwrite file'))
    const db = new Database(join(run.paths.cwd, 'data.sqlite'), { readonly: true })
    const count = (db.query('SELECT count(*) AS n FROM items').get() as { n: number }).n
    db.close()
    check(`${columns}x${rows}: approval applies only its addressed outcome`, count === (key === 1 ? 0 : 1))
  } finally { run.cleanup() }
}
console.log(`${passed}/${passed + failed} checks`)
process.exitCode = failed ? 1 : 0
