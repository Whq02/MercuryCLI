#!/usr/bin/env bun
import { EventEmitter } from 'node:events'

delete process.env.NO_COLOR
process.env.FORCE_COLOR = '3'

const React = await import('react')
const h = React.createElement
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { default: instances } = await import('../../src/ink/instances.ts')
const { Box, Text } = await import('../../src/ink.ts')
const { AlternateScreen } = await import('../../src/ink/components/AlternateScreen.tsx')

const COLS = 60
const ROWS = 14
const ROW_WIDTH = 40
const GROUND = 'rgb(13,24,27)'
const BAND = 'rgb(40,60,70)'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

class Terminal extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  write(): boolean {
    return true
  }
}

class Keyboard extends EventEmitter {
  isTTY = true
  isRaw = false
  readableLength = 0
  setEncoding(): this {
    return this
  }
  setRawMode(value: boolean): this {
    this.isRaw = value
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  pause(): this {
    return this
  }
  resume(): this {
    return this
  }
  read(): string | null {
    return null
  }
}

const settle = (ms = 200): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

type Verdict = 'ink' | 'blank' | 'unheard'
type World = { click: (col: number, row: number) => Verdict; frame: () => string; end: () => Promise<void> }

async function world(ground: string | undefined): Promise<World> {
  const heard: boolean[] = []
  const screen = new Terminal()
  const ink = new Ink({ stdout: screen as never, stdin: new Keyboard() as never, stderr: new Terminal() as never, patchConsole: false, exitOnCtrlC: false })
  instances.set(screen as never, ink)
  const line = (key: string, words: React.ReactNode, width = ROW_WIDTH): React.ReactNode =>
    h(Box, { key, width, flexShrink: 0, onClick: (event: { cellIsBlank: boolean }) => heard.push(event.cellIsBlank) }, words)
  ink.render(
    h(AlternateScreen, { mouseTracking: false },
      h(Box, { flexDirection: 'column', width: COLS, height: ROWS, ...(ground ? { backgroundColor: ground as never } : {}) },
        line('words', h(Text, null, 'Ran 4 bash commands')),
        line('wide', h(Text, null, 'Ran  4  bash')),
        line('nodes', h(Box, { flexDirection: 'row', gap: 2 }, h(Text, null, 'Ran'), h(Text, null, '4 bash'))),
        line('indent', h(Text, null, '   └ npm test')),
        line('tall', h(Box, { flexDirection: 'column' }, h(Text, null, 'first paragraph'), h(Text, null, ' '), h(Text, null, 'third row'))),
        line('ends', h(Box, { flexDirection: 'row', justifyContent: 'space-between', width: ROW_WIDTH }, h(Text, null, 'left'), h(Text, null, 'right'))),
        h(Box, { key: 'leading', flexDirection: 'row' }, h(Text, null, 'LEFT'), line('leading', h(Text, null, '  right'))),
        h(Box, { key: 'trailing', flexDirection: 'row' }, line('trailing', h(Text, null, 'left  ')), h(Text, null, 'RIGHT')),
        h(Box, { key: 'hollow', flexDirection: 'row' }, h(Text, null, 'left'), line('hollow', null, 10), h(Text, null, 'right')),
        line('band', h(Text, { backgroundColor: BAND as never }, '      ')),
        line('mark', h(Text, { inverse: true }, '  ')),
      ),
    ),
  )
  await settle()
  return {
    click: (col, row) => {
      const before = heard.length
      ink.dispatchClick(col, row)
      return heard.length === before ? 'unheard' : heard.at(-1) ? 'blank' : 'ink'
    },
    frame: () => ink.lastFrameText(),
    end: async () => {
      const exited = ink.waitUntilExit()
      ink.unmount()
      await exited
      instances.delete(screen as never)
    },
  }
}

const bare = await world(undefined)
const rows = bare.frame().split('\n')
t('§0 the scene paints the lines where the clicks land', rows[0]?.startsWith('Ran 4 bash commands') === true && rows[1]?.startsWith('Ran  4  bash') === true && rows[2]?.startsWith('Ran  4 bash') === true && rows[3]?.startsWith('   └ npm test') === true && rows[4]?.startsWith('first paragraph') === true && rows[6]?.startsWith('third row') === true && rows[7]?.startsWith('left') === true && rows[7]?.trimEnd().endsWith('right') === true && rows[7]?.trimEnd().length === ROW_WIDTH, JSON.stringify(rows.slice(0, 8)))

t('§1 a click on a letter lands on ink', bare.click(1, 0) === 'ink')
t('§1 a click on the space between two words lands on the line', bare.click(3, 0) === 'ink' && bare.click(5, 0) === 'ink' && bare.click(10, 0) === 'ink', `${bare.click(3, 0)} ${bare.click(5, 0)} ${bare.click(10, 0)}`)
t('§1 a click on either of two spaces between words lands on the line', bare.click(3, 1) === 'ink' && bare.click(4, 1) === 'ink' && bare.click(6, 1) === 'ink' && bare.click(7, 1) === 'ink', `${bare.click(3, 1)} ${bare.click(4, 1)} ${bare.click(6, 1)} ${bare.click(7, 1)}`)
t('§1 a click in the gap between two text nodes of one line lands on the line', bare.click(3, 2) === 'ink' && bare.click(4, 2) === 'ink', `${bare.click(3, 2)} ${bare.click(4, 2)}`)

t('§1 a click between the words that stand at the two ends of one line lands on the line', bare.click(20, 7) === 'ink' && bare.click(4, 7) === 'ink' && bare.click(ROW_WIDTH - 6, 7) === 'ink', `${bare.click(20, 7)} ${bare.click(4, 7)} ${bare.click(ROW_WIDTH - 6, 7)}`)

t('§2 a click past the end of a line is blank', bare.click(19, 0) === 'blank' && bare.click(30, 0) === 'blank' && bare.click(ROW_WIDTH - 1, 2) === 'blank', `${bare.click(19, 0)} ${bare.click(30, 0)} ${bare.click(ROW_WIDTH - 1, 2)}`)
t('§2 a click on the indentation before a line is blank', bare.click(0, 3) === 'blank' && bare.click(2, 3) === 'blank' && bare.click(4, 3) === 'ink' && bare.click(3, 3) === 'ink', `${bare.click(0, 3)} ${bare.click(2, 3)} ${bare.click(4, 3)} ${bare.click(3, 3)}`)
t('§2 a click on an empty row inside an item is blank, and the rows around it are not', bare.click(2, 5) === 'blank' && bare.click(2, 4) === 'ink' && bare.click(5, 4) === 'ink' && bare.click(5, 6) === 'ink', `${bare.click(2, 5)} ${bare.click(2, 4)} ${bare.click(5, 4)} ${bare.click(5, 6)}`)
t('§2 a click outside every handler is heard by none', bare.click(ROW_WIDTH + 5, 0) === 'unheard' && bare.click(10, 13) === 'unheard', `${bare.click(ROW_WIDTH + 5, 0)} ${bare.click(10, 13)}`)

t('§4 the scene paints a word outside each of three clickable boxes', rows[8] === 'LEFT  right' && rows[9] === `left${' '.repeat(ROW_WIDTH - 4)}RIGHT` && rows[10] === `left${' '.repeat(10)}right`, JSON.stringify(rows.slice(8, 11)))
t('§4 ink outside the box a click hit makes no line of its blank cells: the indentation after a neighbour\'s word, the space before a neighbour\'s word, an empty box between two words', bare.click(5, 8) === 'blank' && bare.click(4, 9) === 'blank' && bare.click(8, 10) === 'blank', `${bare.click(5, 8)} ${bare.click(4, 9)} ${bare.click(8, 10)}`)
t('§4 the words inside those boxes are ink, and a word outside them is heard by none', bare.click(7, 8) === 'ink' && bare.click(1, 9) === 'ink' && bare.click(1, 8) === 'unheard' && bare.click(15, 10) === 'unheard', `${bare.click(7, 8)} ${bare.click(1, 9)} ${bare.click(1, 8)} ${bare.click(15, 10)}`)
t('§5 a band of colour with no glyph in it is empty space, and a mark that shows on a space is ink', bare.click(2, 11) === 'blank' && bare.click(5, 11) === 'blank' && bare.click(0, 12) === 'ink' && bare.click(1, 12) === 'ink', `${bare.click(2, 11)} ${bare.click(5, 11)} ${bare.click(0, 12)} ${bare.click(1, 12)}`)
await bare.end()

const grounded = await world(GROUND)
t('§3 on a grounded screen a letter and the space between two words land on the line too', grounded.click(1, 0) === 'ink' && grounded.click(3, 0) === 'ink' && grounded.click(4, 1) === 'ink' && grounded.click(3, 2) === 'ink', `${grounded.click(1, 0)} ${grounded.click(3, 0)} ${grounded.click(4, 1)} ${grounded.click(3, 2)}`)
t('§5 on a grounded screen a click past the end of a line is blank, as on a bare one', grounded.click(19, 0) === 'blank' && grounded.click(30, 0) === 'blank' && grounded.click(ROW_WIDTH - 1, 2) === 'blank', `${grounded.click(19, 0)} ${grounded.click(30, 0)} ${grounded.click(ROW_WIDTH - 1, 2)}`)
t('§5 on a grounded screen a click on the indentation before a line is blank, and the mark and the space after it are the line', grounded.click(0, 3) === 'blank' && grounded.click(2, 3) === 'blank' && grounded.click(4, 3) === 'ink' && grounded.click(3, 3) === 'ink', `${grounded.click(0, 3)} ${grounded.click(2, 3)} ${grounded.click(4, 3)} ${grounded.click(3, 3)}`)
t('§5 on a grounded screen a click on an empty row inside an item is blank, and the rows around it are not', grounded.click(2, 5) === 'blank' && grounded.click(2, 4) === 'ink' && grounded.click(5, 4) === 'ink' && grounded.click(5, 6) === 'ink', `${grounded.click(2, 5)} ${grounded.click(2, 4)} ${grounded.click(5, 4)} ${grounded.click(5, 6)}`)
t('§5 on a grounded screen a click between the words at the two ends of one line lands on the line', grounded.click(20, 7) === 'ink' && grounded.click(4, 7) === 'ink', `${grounded.click(20, 7)} ${grounded.click(4, 7)}`)
t('§5 on a grounded screen ink outside the box a click hit makes no line of its blank cells', grounded.click(5, 8) === 'blank' && grounded.click(4, 9) === 'blank' && grounded.click(8, 10) === 'blank', `${grounded.click(5, 8)} ${grounded.click(4, 9)} ${grounded.click(8, 10)}`)
t('§5 on a grounded screen a band of another colour is empty space too, and a mark that shows on a space is ink', grounded.click(2, 11) === 'blank' && grounded.click(5, 11) === 'blank' && grounded.click(0, 12) === 'ink' && grounded.click(1, 12) === 'ink', `${grounded.click(2, 11)} ${grounded.click(5, 11)} ${grounded.click(0, 12)} ${grounded.click(1, 12)}`)
t('§5 on a grounded screen a click outside every handler is heard by none', grounded.click(ROW_WIDTH + 5, 0) === 'unheard' && grounded.click(10, 13) === 'unheard', `${grounded.click(ROW_WIDTH + 5, 0)} ${grounded.click(10, 13)}`)
await grounded.end()

console.log(failures === 0 ? 'CLICK BLANK VERDICT: ALL PASS' : 'CLICK BLANK VERDICT: RED')
process.exit(failures)
