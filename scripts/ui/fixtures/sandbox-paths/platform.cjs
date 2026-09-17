'use strict'
const forced = process.env.SANDBOX_PATHS_PLATFORM
if (forced) Object.defineProperty(process, 'platform', { value: forced })
