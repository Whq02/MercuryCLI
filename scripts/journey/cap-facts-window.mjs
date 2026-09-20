import fs from 'node:fs'
import promises from 'node:fs/promises'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'

const home = process.env.MERCURY_CONFIG_DIR
const read = fs.readFileSync.bind(fs)
const append = fs.appendFileSync.bind(fs)
const write = fs.writeFileSync.bind(fs)
const rename = promises.rename.bind(promises)
const stdout = process.stdout.write.bind(process.stdout)
const configPath = home && join(home, 'facts-window.json')
if (configPath && fs.existsSync(configPath)) {
  const config = JSON.parse(read(configPath, 'utf8'))
  const events = join(home, 'facts-events.jsonl')
  const acknowledged = join(home, 'facts-ack.json')
  const observed = join(home, 'facts-observed.json')
  const wire = join(home, 'wire.jsonl')
  const cockpit = !process.argv.includes('-p') && !process.argv.includes('daemon')
  const factsPath = file => String(file).startsWith(join(home, 'daemon', 'session-facts') + '/') && String(file).endsWith('.json')
  const record = (event, facts = {}) => append(events, JSON.stringify({ at: Date.now(), pid: process.pid, event, ...facts }) + '\n')
  const factsOf = raw => {
    const facts = JSON.parse(String(raw))
    return { sid: facts.sessionId, atMs: facts.atMs, model: facts.model, pendingModel: facts.pendingModel, busy: facts.busy }
  }
  record('process', { cockpit })
  promises.rename = async function (from, to) {
    const facts = factsPath(to) ? factsOf(read(from, 'utf8')) : null
    const result = await rename(from, to)
    if (facts !== null) record('facts-write', facts)
    return result
  }
  let readObserved = false
  fs.readFileSync = function (file, ...args) {
    const result = read(file, ...args)
    if (cockpit && factsPath(file)) {
      const facts = factsOf(result)
      record('facts-read', facts)
      if (!readObserved && fs.existsSync(acknowledged)) {
        readObserved = true
        record('read-after-ack', facts)
        write(observed, JSON.stringify(facts))
      }
    }
    return result
  }
  let armed = false
  let spent = false
  let timer
  let watcher
  const held = []
  const flush = reason => {
    if (spent) return
    spent = true
    clearTimeout(timer)
    watcher?.close()
    record('facts-release', { reason, count: held.length })
    for (const entry of held.splice(0)) {
      record('facts-forward', { requestId: entry.requestId, hash: createHash('sha256').update(String(entry.args[0])).digest('hex') })
      stdout(...entry.args)
    }
  }
  const maybeRelease = () => {
    if (!fs.existsSync(observed)) return
    const pickup = read(wire, 'utf8').split('\n').filter(Boolean).some(line => {
      try {
        const row = JSON.parse(line)
        return row.kind === 'anthropic' && JSON.stringify(row.body).includes('pick up from gpt pls')
      } catch { return false }
    })
    if (pickup) flush('facts-read-and-pickup')
  }
  process.stdout.write = function (...args) {
    const raw = String(args[0])
    if (raw.startsWith('{') && raw.includes('"control_response"')) {
      let frame
      try { frame = JSON.parse(raw) } catch {}
      const response = frame?.response
      if (!armed && response?.subtype === 'success' && response.request_id?.startsWith('mercury-seat-set-model-') && response.response?.at === 'now') {
        armed = true
        record('model-ack', { response: response.response, requestId: response.request_id })
        write(acknowledged, JSON.stringify({ at: Date.now(), response: response.response }))
        if (config.enabled) {
          watcher = fs.watch(home, (_event, name) => {
            if (String(name) === 'facts-observed.json' || String(name) === 'wire.jsonl') maybeRelease()
          })
          timer = setTimeout(() => flush('watchdog'), config.budgetMs)
          timer.unref()
        }
      }
      if (response?.subtype === 'success' && response.request_id?.startsWith('mercury-session-facts-')) {
        const hash = createHash('sha256').update(raw).digest('hex')
        const delaying = armed && config.enabled && !spent
        record('facts-answer', { requestId: response.request_id, model: response.response?.model, held: delaying, hash })
        if (delaying) {
          held.push({ args, requestId: response.request_id, hash })
          maybeRelease()
          return true
        }
      }
    }
    return stdout(...args)
  }
  syncBuiltinESMExports()
}
