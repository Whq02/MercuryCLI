const http = require('node:http')
const https = require('node:https')
const { syncBuiltinESMExports } = require('node:module')
const request = http.request
const port = Number(process.env.AUTH_RETRY_FIXTURE_PORT)
if (!port) throw new Error('authentication fixture port missing')
function redirected(input, options, callback) {
  let target
  if (typeof input === 'string' || input instanceof URL) {
    const url = new URL(input)
    target = { method: 'GET', path: url.pathname + url.search, ...(typeof options === 'object' ? options : {}) }
  } else {
    target = { ...input }
  }
  const done = typeof options === 'function' ? options : callback
  return request({ ...target, protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1', port, agent: http.globalAgent, _defaultAgent: http.globalAgent }, done)
}
http.request = redirected
https.request = redirected
http.get = https.get = (...args) => { const req = redirected(...args); req.end(); return req }
syncBuiltinESMExports()
