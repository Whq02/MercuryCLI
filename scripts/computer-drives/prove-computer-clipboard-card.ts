import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, drive, endLeg, finish, joined, OPENING, printFrame, requireCaptureDriver, scratch, SIZES, startLeg } from '../computer/computerDriveKit.ts'
import { ansiToPng } from '../../src/utils/ansiToPng.ts'

const driver = requireCaptureDriver('computer-drives')
for (const size of SIZES) {
  const leg = await startLeg(`clipboard-${size.cols}`, [{ kind: 'tool_use', name: 'Computer', input: { action: 'read', clipboard: true } }], null, scratch)
  const result = await drive(driver, leg, size, [...OPENING('read the copied text'), { requireAwait: true, awaitText: 'Allow Mercury to read the clipboard text?', awaitStableTicks: 2, mark: 'clipboard', data: '\u001b' }], 180)
  await endLeg(leg)
  const rows = result.marks.clipboard ?? []
  const text = joined(rows)
  printFrame(`clipboard ${size.cols}`, rows)
  check(`${size.cols}: clipboard consent appears in the real terminal`, result.status === 0 && text.includes('Allow Mercury to read the clipboard text?') && text.includes('read clipboard'), `${result.endReason}: ${result.stderr.slice(-300)}`)
  check(`${size.cols}: an app grant is not presented as clipboard consent`, !text.includes('first act in this application') && !text.includes('for 1 hour') && !text.includes('for 24 hours') && !text.includes('drive your mouse') && !text.includes('needs separate consent'), text)
  check(`${size.cols}: Yes, No and sovereign remain available`, text.includes('1. Yes') && text.includes('2. No, and tell Mercury') && text.includes('3. Enable sovereign mode'), text)
  if (rows.length) {
    const image = join(scratch, `clipboard-${size.cols}.png`)
    writeFileSync(image, ansiToPng(rows.join('\n')))
    console.log(`Clipboard card image: ${image}`)
  }
}
finish('prove-computer-clipboard-card')
