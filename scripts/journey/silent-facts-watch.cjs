'use strict'
const fs = require('fs')
const target = process.env.PROOF_SILENCE_FACTS_WATCH
if (target) {
  const realWatch = fs.watch
  const EventEmitter = require('events')
  const countFile = process.env.PROOF_SILENCE_FACTS_WATCH_LOG
  let wrapped = 0
  fs.watch = function (p, ...rest) {
    if (String(p).includes(target)) {
      wrapped++
      if (countFile) {
        try {
          fs.writeFileSync(countFile, String(wrapped))
        } catch (e) {
          void e
        }
      }
      const ee = new EventEmitter()
      ee.close = () => {}
      return ee
    }
    return realWatch.call(this, p, ...rest)
  }
  try {
    require('module').syncBuiltinESMExports()
  } catch (e) {
    void e
  }
}
