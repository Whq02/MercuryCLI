#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const name of Object.keys(process.env)) {
  if (ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name) || /proxy/i.test(name)) delete process.env[name]
}

const FIX = 'the listener and its address are beginOpenrouterConnect in src/models/roads/openrouter/openrouterAccounts.ts (listen on a free port of 127.0.0.1, then build the address from the port that was bound); each sign-in here is scripts/provauth/lib/openrouter-connect-child.ts in its own home, and the stand-in OpenRouter is the Bun.serve block of scripts/provauth/prove-openrouter-two-signins.ts'
let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail} — ` : ''}${FIX}`}`)
}

const challenges = new Map<string, string>()
const exchanges: Array<{ code: string; accepted: boolean }> = []
const keyOf = (code: string): string => `sk-or-v1-fixture-${code}`
const standIn = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/v1/auth/keys') return new Response(null, { status: 404 })
    const body = (await request.json()) as { code?: string; code_verifier?: string }
    const code = body.code ?? ''
    const accepted = challenges.has(code) && createHash('sha256').update(body.code_verifier ?? '').digest('base64url') === challenges.get(code)
    exchanges.push({ code, accepted })
    return accepted ? Response.json({ key: keyOf(code) }) : Response.json({ error: { code: 403, message: 'Invalid code or code_verifier' } }, { status: 403 })
  },
})
const base = `http://127.0.0.1:${standIn.port}`

type Begun = { authorizeUrl: string; port: number | null }
type Ended = { ok: boolean; words: string; minted: string | null; issues: string[] }
type SignIn = { begun: Promise<Begun>; ended: Promise<Ended>; proc: ChildProcess }
const CHILD_WAIT_MS = 6_000
function signIn(profile: string): SignIn {
  const home = join(proofHome, profile)
  mkdirSync(home, { recursive: true })
  const proc = spawn(process.execPath, ['run', join(import.meta.dir, 'lib', 'openrouter-connect-child.ts'), String(CHILD_WAIT_MS)], {
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_OPENROUTER_API_BASE: `${base}/api/v1`, MERCURY_OPENROUTER_AUTH_BASE: `${base}/auth` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  let begun: (value: Begun) => void = () => {}
  let ended: (value: Ended) => void = () => {}
  let lost: (error: Error) => void = () => {}
  const begunSaid = new Promise<Begun>((resolve, reject) => { begun = resolve; lost = reject })
  const endedSaid = new Promise<Ended>(resolve => { ended = resolve })
  proc.stdout!.on('data', chunk => {
    out += String(chunk)
    for (const line of out.split('\n').slice(0, -1)) {
      if (line.startsWith('{"about":"begun"')) begun(JSON.parse(line) as Begun)
      if (line.startsWith('{"about":"ended"')) ended(JSON.parse(line) as Ended)
    }
  })
  proc.stderr!.on('data', chunk => { err += String(chunk) })
  proc.on('close', code => {
    lost(new Error(`the sign-in of ${profile} ended (exit ${code}) before it began: ${out.slice(-300)} ${err.slice(-300)}`))
    ended({ ok: false, words: `the process ended (exit ${code}): ${err.slice(-300)}`, minted: null, issues: [] })
  })
  return { begun: begunSaid, ended: endedSaid, proc }
}

type Redirect = { status: number; text: string }
async function browserRedirect(begun: Begun, code: string, ours: ReadonlySet<number>): Promise<Redirect | 'a listener that is not this proof\'s' | 'no callback address'> {
  const address = new URL(begun.authorizeUrl)
  const callback = address.searchParams.get('callback_url')
  if (callback === null) return 'no callback address'
  if (!ours.has(Number(new URL(callback).port))) return 'a listener that is not this proof\'s'
  challenges.set(code, address.searchParams.get('code_challenge') ?? '')
  try {
    const response = await fetch(`${callback}?code=${code}`)
    return { status: response.status, text: await response.text() }
  } catch (error) {
    return { status: 0, text: `no listener answered at ${callback}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const signIns: SignIn[] = []
try {
  console.log('── two profiles, each in its own process and home, begin an OpenRouter browser sign-in while the other is still open ──')
  const first = signIn('profile-1')
  signIns.push(first)
  const one = await first.begun
  const second = signIn('profile-2')
  signIns.push(second)
  const two = await second.begun
  const ours = new Set([one.port, two.port].filter((port): port is number => port !== null))
  const callbackOf = (begun: Begun): string => new URL(begun.authorizeUrl).searchParams.get('callback_url') ?? ''
  check('each sign-in listens on a port of its own', one.port !== null && two.port !== null && one.port !== two.port, JSON.stringify({ first: one.port, second: two.port }))
  check('the address each sign-in opens the browser at names its own listener on 127.0.0.1, with the path it always had', callbackOf(one) === `http://127.0.0.1:${one.port}/auth/callback` && callbackOf(two) === `http://127.0.0.1:${two.port}/auth/callback`, JSON.stringify({ first: callbackOf(one), second: callbackOf(two) }))
  check('each address carries the key label, so the key is not named after a port', [one, two].every(begun => new URL(begun.authorizeUrl).searchParams.get('key_label') === 'Mercury'), JSON.stringify([one, two].map(begun => new URL(begun.authorizeUrl).searchParams.get('key_label'))))

  console.log('── each browser is sent back to the address its own sign-in gave it: the second profile first ──')
  const secondBack = await browserRedirect(two, 'code-of-profile-2', ours)
  const firstBack = await browserRedirect(one, 'code-of-profile-1', ours)
  check('the second profile\'s browser reaches the second profile\'s listener, which connects', typeof secondBack === 'object' && secondBack.status === 200 && secondBack.text.includes('OpenRouter connected'), JSON.stringify(secondBack))
  check('the first profile\'s browser reaches the first profile\'s listener, which connects', typeof firstBack === 'object' && firstBack.status === 200 && firstBack.text.includes('OpenRouter connected'), JSON.stringify(firstBack))
  const oneEnded = await first.ended
  const twoEnded = await second.ended
  check('both sign-ins end signed in', oneEnded.ok && twoEnded.ok, JSON.stringify({ first: oneEnded.words, second: twoEnded.words }))
  check('each home holds the key minted for its own code', oneEnded.minted === keyOf('code-of-profile-1') && twoEnded.minted === keyOf('code-of-profile-2'), JSON.stringify({ first: oneEnded.minted, second: twoEnded.minted }))
  check('neither sign-in was told its listener could not be had, or that a code was refused', oneEnded.issues.length === 0 && twoEnded.issues.length === 0, JSON.stringify({ first: oneEnded.issues, second: twoEnded.issues }))
  check('the stand-in saw two exchanges, each code with the verifier of the sign-in that asked for it', exchanges.length === 2 && exchanges.every(exchange => exchange.accepted) && exchanges.map(exchange => exchange.code).join(',') === 'code-of-profile-2,code-of-profile-1', JSON.stringify(exchanges))
} finally {
  for (const each of signIns) each.proc.kill()
  void standIn.stop(true)
}
console.log(failures === 0 ? `\nTWO OPENROUTER SIGN-INS, EACH ITS OWN LISTENER (${passes} checks; two processes, loopback stand-in, no live host)` : `\n${failures} FAILURE(S) of ${passes + failures}`)
process.exit(failures === 0 ? 0 : 1)
