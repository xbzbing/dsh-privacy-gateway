import { zh, type Key } from './locales/zh.ts'
import { en } from './locales/en.ts'

/** `privacyGateway` namespace dictionaries; zh is the key set's source. The dictionaries live one file per language under `locales/`. */
export const NS = 'privacyGateway'

export { zh, en }
export type { Key }

export const DICTIONARIES: Record<string, Record<Key, string>> = { zh, en }

export type T = (key: Key, params?: Record<string, string | number>) => string
