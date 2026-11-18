import { isIP } from 'node:net'

const sent = globalThis.fetch
const asked: string[] = []
const member = (process.argv[1] ?? 'this process').replace(/^.*[\\/]scripts[\\/]/, 'scripts/')

function endsRed(): void {
  const exit = process.exit.bind(process)
  process.exit = ((code?: number | string | null) => exit(code ? code : 1)) as typeof process.exit
  process.exitCode = 1
}

globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = input instanceof Request ? input : undefined
  const url = new URL(request ? request.url : String(input))
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || isIP(host) === 4 && host.startsWith('127.')) return sent(input, init)
  const line = (init?.method ?? request?.method ?? 'GET').toUpperCase() + ' ' + url.origin + url.pathname
  if (asked.length === 0) endsRed()
  asked.push(line)
  throw new Error(member + ' asked a host that is not loopback; not sent: ' + line)
}, sent)

process.on('exit', () => {
  if (asked.length > 0) console.error('\nFAIL ' + member + ' asked a host that is not loopback: ' + [...new Set(asked)].join(', '))
})
