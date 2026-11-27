import { readSync } from 'node:fs'
import { startTimeout } from '../../../platform/async/timers.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { markConsoleLent, markConsoleReturned } from '../../../platform/processes/process.js'
import { reclaimTerminalAfterChild } from '../../../platform/shell/terminalHandback.js'
import { drainStdin } from '../../renderer/instance/stdin.js'
import instances from '../../renderer/instances.js'

type LentStreams = { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream }

const RETURN_TO_MERCURY_WORDS = 'Press Enter to return to Mercury…'

export function waitForReturnKey(stdout: NodeJS.WriteStream, label: string): void {
  try {
    stdout.write(`\n[${label}] ${RETURN_TO_MERCURY_WORDS} `)
  } catch (error) {
    passedOver(error)
  }
  const buf = Buffer.alloc(1)
  while (true) {
    try {
      const n = readSync(0, buf, 0, 1, null)
      if (n <= 0) break
      const byte = buf[0]
      if (byte === 10 || byte === 13 || byte === 3 || byte === 4 || byte === 27) break
    } catch (error) {
      passedOver(error)
      break
    }
  }
}

export async function lendTerminal<T>(
  during: (stdout: NodeJS.WriteStream, stdin: NodeJS.ReadStream) => T | Promise<T>,
  options: LentStreams & { child?: string } = {},
): Promise<{ value: T } | null> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const instance = instances.get(stdout)
  if (!stdin.isTTY || !stdout.isTTY || instance === undefined) return null

  await instance.awaitTerminalQueries()
  drainStdin(stdin)
  markConsoleLent()
  instance.enterAlternateScreen()
  try {
    return { value: await during(stdout, stdin) }
  } finally {
    if (options.child !== undefined) reclaimTerminalAfterChild(options.child)
    instance.exitAlternateScreen()
    const release = startTimeout(() => {
      markConsoleReturned()
    }, 100)
    release.unref?.()
  }
}

function returnPressed(stdin: NodeJS.ReadStream): Promise<void> {
  return new Promise(resolve => {
    const wasRaw = stdin.isRaw === true
    const done = (): void => {
      stdin.removeListener('readable', onReadable)
      if (!wasRaw) {
        try {
          stdin.setRawMode(false)
        } catch (error) {
          passedOver(error)
        }
      }
      resolve()
    }
    const onReadable = (): void => {
      for (let chunk: unknown = stdin.read(); chunk !== null; chunk = stdin.read()) {
        const keys = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('latin1')
        if (keys === '\x1b' || /[\r\n\x03\x04]/.test(keys)) {
          done()
          return
        }
      }
    }
    try {
      stdin.setRawMode(true)
    } catch (error) {
      passedOver(error)
    }
    stdin.on('readable', onReadable)
  })
}

export async function showSignInAddressLine(address: string, streams: LentStreams = {}): Promise<boolean> {
  const shown = await lendTerminal(async (stdout, stdin) => {
    stdout.write(`\n${address}\n\n${RETURN_TO_MERCURY_WORDS} `)
    await returnPressed(stdin)
  }, streams)
  return shown !== null
}
