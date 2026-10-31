import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const KEY_BYTES = 32

export interface LoadedKey {
  key: Buffer
  /** False when the key could not be read from or written to `path`: placeholders then change on restart. */
  persisted: boolean
}

/**
 * The HMAC key placeholders are made with. It is kept at `path` (0600, its
 * directory 0700) so a placeholder stays the same across restarts and the
 * vendor's prompt cache of a conversation stays good. A key that can't be
 * kept is made in memory.
 */
export function loadKey(path: string): LoadedKey {
  const existing = readKey(path)
  if (existing) return { key: existing, persisted: true }
  const key = randomBytes(KEY_BYTES)
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // wx: another process that got there first keeps its key, and we read it
    writeFileSync(path, key, { mode: 0o600, flag: 'wx' })
    return { key, persisted: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = readKey(path)
      if (raced) return { key: raced, persisted: true }
    }
    return { key, persisted: false }
  }
}

function readKey(path: string): Buffer | undefined {
  try {
    const b = readFileSync(path)
    return b.length >= KEY_BYTES ? b.subarray(0, KEY_BYTES) : undefined
  } catch {
    return undefined
  }
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** The first 8 characters of RFC 4648 base32 of `bytes` (its first 5 bytes, 40 bits), in lower case. */
function base32Head(bytes: Uint8Array): string {
  let bits = 0n
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(bytes[i] ?? 0)
  let out = ''
  for (let i = 7; i >= 0; i--) out += BASE32[Number((bits >> BigInt(i * 5)) & 31n)]
  return out
}

/**
 * The placeholder a value of `kind` goes as: `{{KIND_xxxxxxxx}}`, the hash
 * part the first 8 base32 characters of HMAC-SHA256(key, kind NUL value).
 * The same value is the same placeholder every time, so a conversation's
 * history reads the same turn after turn and masking it again changes nothing.
 */
export function tagOf(key: Uint8Array, kind: string, value: string): string {
  const mac = createHmac('sha256', key).update(`${kind}\0${value}`, 'utf8').digest()
  return `{{${kind}_${base32Head(mac)}}}`
}
