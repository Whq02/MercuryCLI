import { appendFileSync } from 'node:fs'

const lines = JSON.parse(process.env.FIRST_SCREEN ?? '[]')
const later = JSON.parse(process.env.FIRST_SCREEN_THEN ?? '[]')
const keys = process.env.FIRST_SCREEN_KEYS
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on('data', chunk => {
  if (keys) appendFileSync(keys, `${JSON.stringify([...chunk])}\n`)
})
process.stdout.write('\x1b[2J\x1b[H')
for (const line of lines) process.stdout.write(`${line}\r\n`)
later.forEach((write, index) => setTimeout(() => process.stdout.write(write), 150 * (index + 1)))
setInterval(() => {}, 1000)
