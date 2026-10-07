#!/usr/bin/env bun
const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1]! : fallback
}
const HUE = flag('--hue', '#dd4444')
const GROUND = flag('--ground', '#0d181b')
const PUPIL = flag('--pupil', '#1f3841')
const WHITE = flag('--white', '#ede8dd')

const rgb = (hex: string): string => {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex)
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`)
  return `${parseInt(m[1]!, 16)};${parseInt(m[2]!, 16)};${parseInt(m[3]!, 16)}`
}
const fg = (hex: string): string => `\x1b[38;2;${rgb(hex)}m`
const bg = (hex: string): string => `\x1b[48;2;${rgb(hex)}m`
const RESET = '\x1b[0m'
const W = 5

type Shape = { label: string; cell: string; terminalApp: string }
const SHAPES: Shape[] = [
  { label: 'A  top pixel · ▄ glyph=ground bg=hue', cell: `${bg(HUE)}${fg(GROUND)}▄`, terminalApp: 'hue rows 0-20, ground 21-32, HUE row 33: a hairline of hue at the cell bottom' },
  { label: 'B  top pixel · ▀ glyph=hue bg=ground', cell: `${bg(GROUND)}${fg(HUE)}▀`, terminalApp: 'ground rows 0-7 (an 8 px notch at the top), hue 8-19, ground 20-33: no hue below' },
  { label: 'C  top pixel · ▀ glyph=hue, no bg', cell: `${fg(HUE)}▀`, terminalApp: "as B with the terminal's own background in the notch and below" },
  { label: 'D  bottom pixel · ▄ glyph=hue bg=ground', cell: `${bg(GROUND)}${fg(HUE)}▄`, terminalApp: 'ground rows 0-20, hue 21-32, ground 33: no leak' },
  { label: 'E  top pixel · █ glyph=hue bg=ground', cell: `${bg(GROUND)}${fg(HUE)}█`, terminalApp: 'ground rows 0-7 (the notch), hue 8-32 (the lower half too), ground 33' },
  { label: 'F  top pixel · space, bg=hue', cell: `${bg(HUE)} `, terminalApp: 'hue rows 0-33: the lower half is hue' },
  { label: 'G  white over pupil · ▀ glyph=white bg=pupil', cell: `${bg(PUPIL)}${fg(WHITE)}▀`, terminalApp: 'pupil rows 0-7 (the second pair above the white), white 8-19, pupil 20-33' },
  { label: 'H  white over pupil · ▄ glyph=pupil bg=white', cell: `${bg(WHITE)}${fg(PUPIL)}▄`, terminalApp: 'white rows 0-20, pupil 21-32, white 33: one pair' },
]

const run = (cell: string): string => `${cell.repeat(W)}${RESET}`
const groundRow = (): string => run(`${bg(GROUND)} `)
const hueRow = (): string => run(`${bg(HUE)}${fg(HUE)}▄`)

console.log(`half-cell shapes · hue ${HUE} · ground ${GROUND} · pupil ${PUPIL} · white ${WHITE}`)
console.log('each scene: a row of the hue above (left column) or the ground above (right column), the shape, the ground below.')
console.log('read the seams: a line of ground inside the hue, a line of hue below the shape, a bar above the white.')
console.log('')
for (const shape of SHAPES) {
  console.log(shape.label)
  console.log(`   Terminal.app, SF Mono 13 pt, line spacing 1.0 (the Air's E1/E5 pixels): ${shape.terminalApp}`)
  console.log(`   ${hueRow()}   ${groundRow()}`)
  console.log(`   ${run(shape.cell)}   ${run(shape.cell)}`)
  console.log(`   ${groundRow()}   ${groundRow()}`)
  console.log('')
}
console.log('the painter after this change: a top pixel with a painted pixel above it is A; with nothing above it is B; a bottom pixel is D; a pair is H.')
