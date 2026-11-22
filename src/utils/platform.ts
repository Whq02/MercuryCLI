import { unbuilt, type Unbuilt } from '../pi/holes.js'

export type Platform = Unbuilt

export const getPlatform: Unbuilt = unbuilt('src/utils/platform.ts:13')

export const getWslVersion: Unbuilt = unbuilt('src/utils/platform.ts:33')

export const getLinuxDistroInfo: Unbuilt = unbuilt('src/utils/platform.ts:53')
