import { digitaloceanFixture } from './digitaloceanFixture.mjs'
import { vmVendorDrive } from './vmVendorDrive.ts'
await vmVendorDrive('digitalocean', digitaloceanFixture)
