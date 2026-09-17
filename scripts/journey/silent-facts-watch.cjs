'use strict'
const fs = require('fs')
const target = process.env.PROOF_SILENCE_FACTS_WATCH
if (target) {
  const realWatch = fs.watch
  const EventEmitter = require('events')
  fs.watch = function (p, ...rest) {
    if (String(p).includes(target)) {
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
