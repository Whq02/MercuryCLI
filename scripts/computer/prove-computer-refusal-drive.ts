#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { check, drive, endLeg, finish, joined, netlines, nonLoopback, OPENING, printFrame, requireCaptureDriver, rowsHaving, section, sessionFiles, SIZES, startLeg } from './computerDriveKit.ts'

const persistedText = (home: string): string => sessionFiles(join(home, 'projects')).map(f => readFileSync(f, 'utf8')).join('\n')

const driver = requireCaptureDriver('computer-drives')
const CARD_NEEDLE = 'first act in this application'
const TURNS = [
  { kind: 'tool_use' as const, preText: 'Looking at the screen.\n', name: 'Computer', input: { action: 'screenshot' } },
  { kind: 'text' as const, text: 'Done.' },
]

for (const size of SIZES) {
  section(`the flag off at ${size.cols}×${size.rows}: the harness refuses the unknown tool`)
  const off = await startLeg(`off-${size.cols}`, TURNS, null)
  const res = await drive(driver, off, size, [...OPENING('take a screenshot'), { requireAwait: true, awaitText: 'Done.', awaitStableTicks: 3, mark: 'done', data: '' }], 160, { MERCURY_COMPUTER_USE: '0' })
  await endLeg(off)
  const done = res.marks.done ?? []
  printFrame(`${size.cols}×${size.rows} flag off`, done)
  check(`${size.cols}: the drive delivered`, res.status === 0, `vshot ${res.status} · ${res.endReason} · ${res.stderr.slice(-300)}`)
  const offWords = joined(done).includes('No such tool available') ? 'frame' : persistedText(off.home).includes('No such tool available') ? 'session file' : 'nowhere'
  check(`${size.cols}: the refusal names the tool as not available (read on the ${offWords})`, offWords !== 'nowhere' && (joined(done).includes('Computer') || persistedText(off.home).includes('Computer')), joined(done).slice(0, 500))
  check(`${size.cols}: no card, no footer`, !rowsHaving(done, CARD_NEEDLE) && !rowsHaving(done, 'hands off'))
  check(`${size.cols}: the fake log was never created`, !existsSync(off.log))
  check(`${size.cols}: nothing left loopback`, nonLoopback(netlines(off.netlog)).length === 0)

  section(`the driver switched off at ${size.cols}×${size.rows}: the tool is not offered`)
  const none = await startLeg(`none-${size.cols}`, TURNS, null)
  const resNone = await drive(driver, none, size, [...OPENING('take a screenshot'), { requireAwait: true, awaitText: 'Done.', awaitStableTicks: 3, mark: 'done', data: '' }], 160, { MERCURY_DESKTOP_DRIVER: 'none' })
  await endLeg(none)
  const doneNone = resNone.marks.done ?? []
  printFrame(`${size.cols}×${size.rows} driver none`, doneNone)
  check(`${size.cols}: the drive delivered`, resNone.status === 0, `vshot ${resNone.status} · ${resNone.endReason} · ${resNone.stderr.slice(-300)}`)
  const noneWords = joined(doneNone).includes('No such tool available') ? 'frame' : persistedText(none.home).includes('No such tool available') ? 'session file' : 'nowhere'
  check(`${size.cols}: the tool is not offered with the driver switched off — the refusal names it as not available (read on the ${noneWords})`, noneWords !== 'nowhere' && (joined(doneNone).includes('Computer') || persistedText(none.home).includes('Computer')), joined(doneNone).slice(0, 500))
  check(`${size.cols}: no card, no footer`, !rowsHaving(doneNone, CARD_NEEDLE) && !rowsHaving(doneNone, 'hands off'))
  check(`${size.cols}: the fake log was never created`, !existsSync(none.log))
  check(`${size.cols}: nothing left loopback`, nonLoopback(netlines(none.netlog)).length === 0)

  section(`a catalogue-declared text-only local model at ${size.cols}×${size.rows}`)
  const local = await startLeg(`text-only-${size.cols}`, [], null)
  const wireModel = 'fixture-text-only'
  const model = `local/${wireModel}`
  const requests: Array<{ model?: string; messages?: Array<{ role?: string; tool_call_id?: string; content?: unknown }> }> = []
  let catalogueReads = 0
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/models') {
      catalogueReads++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ type: 'llm', key: wireModel, display_name: 'Fixture text only', max_context_length: 1_000_000, loaded_instances: [{ config: { context_length: 1_000_000 } }], capabilities: { vision: false, trained_for_tool_use: true } }] }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      const request = JSON.parse(body) as typeof requests[number]
      requests.push(request)
      const returned = request.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'call_text_only') === true
      const delta = returned
        ? { role: 'assistant', content: 'Text-only check finished.' }
        : { role: 'assistant', content: 'Checking the text-only route.\n', tool_calls: [{ index: 0, id: 'call_text_only', type: 'function', function: { name: 'Computer', arguments: JSON.stringify({ action: 'screenshot' }) } }] }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl_text_only', object: 'chat.completion.chunk', created: 1, model: wireModel, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl_text_only', object: 'chat.completion.chunk', created: 1, model: wireModel, choices: [{ index: 0, delta: {}, finish_reason: returned ? 'stop' : 'tool_calls' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind a loopback port')
  try {
    const resLocal = await drive(driver, local, size, [...OPENING(`/model ${model}`), { requireAwait: true, awaitText: wireModel, awaitSettleTicks: 3, mark: 'local-model', data: 'take a screenshot with the text-only model' }, { afterPrevTicks: 3, data: '\r' }, { requireAwait: true, awaitText: 'Text-only check finished.', awaitStableTicks: 3, mark: 'done', data: '' }], 190, {
      MERCURY_LOCAL_PROBE_TARGETS: `lmstudio=http://127.0.0.1:${address.port}`,
      MERCURY_LOCAL_BASE_URL: undefined,
      MERCURY_LOCAL_API_KEY: undefined,
    })
    const doneLocal = resLocal.marks.done ?? []
    printFrame(`${size.cols}×${size.rows} text-only local model`, doneLocal)
    check(`${size.cols}: the text-only drive delivered`, resLocal.status === 0, `vshot ${resLocal.status} · ${resLocal.endReason} · ${resLocal.stderr.slice(-300)}`)
    check(`${size.cols}: the product read the local capability catalogue and used its model`, catalogueReads > 0 && requests.length >= 2 && requests.every(request => request.model === wireModel), `catalogue=${catalogueReads} · models=${requests.map(request => request.model).join(',')}`)
    const returned = requests.flatMap(request => request.messages ?? []).find(message => message.role === 'tool' && message.tool_call_id === 'call_text_only')
    const refusal = typeof returned?.content === 'string' ? returned.content : JSON.stringify(returned?.content ?? '')
    check(`${size.cols}: the actual Computer tool result refuses text-only input and names the local route and remedy`, refusal.includes('receives text only in this release') && refusal.includes(model) && refusal.includes('Local models') && refusal.includes('/model'), refusal)
    check(`${size.cols}: the refusal is retained in the product transcript`, persistedText(local.home).includes('receives text only in this release'))
    check(`${size.cols}: no text-only permission card or driving footer`, !rowsHaving(doneLocal, CARD_NEEDLE) && !rowsHaving(doneLocal, 'hands off'))
    check(`${size.cols}: text-only input never creates a desktop act log`, !existsSync(local.log))
    check(`${size.cols}: the text-only drive stays on loopback`, nonLoopback(netlines(local.netlog)).length === 0)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await endLeg(local)
  }
}

finish('prove-computer-refusal-drive')
