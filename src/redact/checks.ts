/**
 * The checks the rules hold a match to before it is taken for a value, by
 * magpie's semantics (internal/redact/redact.go, fieldvalue.go, phone.go).
 * Each one is a lesson magpie learned from a user's report; the comments
 * say what it lets go and why.
 */

export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const TOKEN_CH = ALNUM + '_-'
export const DIGITS = '0123456789'

const hasLetter = (v: string): boolean => /[A-Za-z]/.test(v)
const hasDigit = (v: string): boolean => /[0-9]/.test(v)
const onlyOf = (v: string, set: string): boolean => [...v].every((c) => set.includes(c))
const trimEnd = (s: string, set: string): string => {
  let i = s.length
  while (i > 0 && set.includes(s[i - 1] as string)) i--
  return s.slice(0, i)
}
const trimStart = (s: string, set: string): string => {
  let i = 0
  while (i < s.length && set.includes(s[i] as string)) i++
  return s.slice(i)
}

/**
 * False for words in lower case joined by hyphens: a page's address names
 * an article about SK hynix (…/sk-hynix-third-quarter-profit.html), which is
 * no key. A key's characters are random: it has a capital, or a run of 16 or
 * more with no hyphen, or is hex digits alone (sk- and a UUID in lower case).
 */
export function notASlug(v: string): boolean {
  if (/[A-Z]/.test(v)) return true
  if (!/[^-_0-9a-f]/.test(v.startsWith('sk-') ? v.slice(3) : v)) return true
  return v.split(/[-_]/).some((w) => w.length >= 16)
}

/** A run of one character, which a real key of random characters does not have: 62^-6 is one in 5.7e10. */
const TEMPLATE_RUN = /([a-z0-9])\1{7,}/

/** The words a stand-in for a key is made of, and a random key is not (a vendor's real test key is a key, so test is no such word). */
const TEMPLATE_WORDS = /(?:your[-_]?(?:api[-_]?key|key|token|secret)|example|placeholder|changeme|redacted|dummy|\*{3,})/

/**
 * How much of a long value is read for either: a stand-in shows itself at its
 * start (AKIA0000…, sk-proj-xxxx…, YOUR_API_KEY…) or at its end, and reading
 * a whole long value would spend the masking time a request has on text no
 * template is made of.
 */
const TEMPLATE_WINDOW = 128

/**
 * False for a value typed to stand for a key rather than a key: a long run of
 * one character (sk-proj-xxxxxxxx…, AKIA0000…0000), or a word that says what
 * it is (your-api-key, changeme, example). Masking one of these hides nothing
 * a reader would not write anyway, and counting it inflates what the gateway
 * appears to have protected (docs/adr/0031).
 */
export function notATemplate(v: string): boolean {
  // the two ends, with a character no template holds between them, so no run spans the join
  const low = (v.length <= TEMPLATE_WINDOW * 2 ? v : `${v.slice(0, TEMPLATE_WINDOW)}\u0000${v.slice(-TEMPLATE_WINDOW)}`).toLowerCase()
  if (TEMPLATE_WORDS.test(low)) return false
  return !TEMPLATE_RUN.test(low)
}

/** Turns away what stands in for a value: ${PASS}, <password>, ****. */
export function notAVariable(v: string): boolean {
  if (v === '' || '$%{<[*'.includes(v[0] as string)) return false
  return v.replace(/^[*xX.]+|[*xX.]+$/g, '') !== ''
}

/**
 * A key's or a token's value, not a word or a number: letters and digits
 * both, or 16 characters or more that aren't all digits. token 是 expired,
 * key 是 value and 密钥为 2048 are left.
 */
export function keyValue(v: string): boolean {
  if (!notAVariable(v)) return false
  return hasLetter(v) && (hasDigit(v) || v.length >= 16)
}

const KEY_SEPARATORS = ['为', '為', '是', '：', ':', '=', 'は', '는']
const QUANTITY_UNITS = ['位', '比特', '字节', '字節', '个', '個', '次', '秒', '毫秒', '分钟', '分鐘', '小时', '小時', '天', '年', 'bit', 'byte', 'ms', 'sec', 'min', 'ビット', 'バイト', '비트', '바이트']

/**
 * keyValue for s[a:b], or six digits or more right after a separator that
 * count nothing: 密钥为12231241 is a key, 密钥为 2048 位 and 令牌 300000 毫秒
 * are a size and a time.
 */
export function keyAt(s: string, a: number, b: number): boolean {
  const v = s.slice(a, b)
  if (pathValue(v) || versionValue(v)) return false
  if (keyValue(v)) return true
  if (v.length < 6 || !onlyOf(v, DIGITS)) return false
  const before = trimEnd(s.slice(0, a), ' \t"\'“「\\')
  const after = trimStart(s.slice(b), ' \t')
  return KEY_SEPARATORS.some((c) => before.endsWith(c)) && !QUANTITY_UNITS.some((u) => after.startsWith(u))
}

/**
 * An opaque token after Bearer: letters and digits both, and not a stand-in
 * (YOUR_ACCESS_TOKEN, ${TOKEN} never get this far, as $ and { are no token's).
 */
export function bearerValue(v: string): boolean {
  return notAVariable(v) && !/^[A-Z0-9_]+$/.test(v) && hasLetter(v) && hasDigit(v)
}

/** Basic's credential: base64 of user:password in printable text, so a word after Basic is none. */
export function basicValue(v: string): boolean {
  const t = Buffer.from(v, 'base64').toString('latin1')
  const colon = t.indexOf(':')
  return /^[\x20-\x7e]+$/.test(t) && colon >= 0 && colon < t.length - 1
}

/** A PEM key cut off before its END line: enough base64 after its BEGIN line to be a key's, not a few words of code. */
export function pemBody(v: string): boolean {
  const body = v.slice(v.indexOf('-----', 5) + 5)
  return (body.match(/[A-Za-z0-9+/]/g)?.length ?? 0) >= 64
}

/** A value that looks like a secret, not code: letters and digits both, and not a call, a reference or a placeholder of its own. */
export function secretValue(v: string): boolean {
  if (!notAVariable(v) || v.startsWith('process.env') || v.startsWith('os.')) return false
  return hasDigit(v) && hasLetter(v)
}

const IDENT_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/

/**
 * Turns away a value that is code naming a secret, not the secret: a call
 * (privateKey: toBase64Url(…)), or, unquoted after a colon, a type or a
 * read that code goes on from (secretKey: Uint8Array;).
 */
export function notCode(s: string, a: number, b: number): boolean {
  if (!IDENT_PATH.test(s.slice(a, b))) return true
  const rest = trimStart(s.slice(b), ' \t')
  if (rest.startsWith('(')) return false
  if ((a > 0 && (s[a - 1] === '"' || s[a - 1] === "'")) || !trimEnd(s.slice(0, a), ' \t').endsWith(':')) return true
  return rest === '' || !';,)}]|?&<>'.includes(rest[0] as string)
}

/** `w` matched in any case, for a pattern that is otherwise case-sensitive (Node 22 has no `(?i:…)`). */
export function anyCase(w: string): string {
  return w.replace(/[a-z]/gi, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`)
}

const RELEASE_WORDS = 'alpha beta rc pre preview post dev canary next nightly snapshot release final ga stable build incubating'.split(' ')

/**
 * A digit run after a release word or a letter needs no separator, but one
 * after another digit run does: one digit run beside another could split it
 * every way there is, and a long one with no match took exponential time.
 */
const VERSION_RANGE = new RegExp(
  '^(?:[~^]|[<>=!~]=?|==)?[vV]?\\d+(?:\\.\\d+)+' +
    `(?:[-+._]?(?:${RELEASE_WORDS.map(anyCase).join('|')})\\d*|[-+._]?[abcmABCM]\\d+|[-+._]\\d+)*$`,
)

/** The longest version looked at: no release's version is longer, and the test stays cheap. */
const MAX_VERSION = 64

/** A release's version (^4.0.0-beta.1, 9.2.0-beta1): published for anyone to read, no secret. */
export function versionValue(v: string): boolean {
  return v.length <= MAX_VERSION && VERSION_RANGE.test(v)
}

const SKILL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)+$/

/** The second half of plugin:skill (design-tokens:generate-v2): slugs on both sides of a colon. */
function skillName(s: string, a: number, b: number): boolean {
  const v = s.slice(a, b)
  if (a < 2 || s[a - 1] !== ':' || !SKILL_SLUG.test(v) || notASlug(v)) return false
  let i = a - 1
  while (i > 0 && 'abcdefghijklmnopqrstuvwxyz0123456789-'.includes(s[i - 1] as string)) i--
  return i < a - 1 && (i === 0 || !(ALNUM + '_.').includes(s[i - 1] as string)) && SKILL_SLUG.test(s.slice(i, a - 1))
}

const LINE_REF = /^L?\d+(?:[-–:]L?\d+)*[.,;:]?$/

const SOURCE_EXT = new Set(
  ('go ts tsx mts cts js jsx mjs cjs py pyi rb rs java kt kts swift c h cc cpp cxx hpp hh m mm cs fs php scala dart lua zig nim ' +
    'ex exs erl hs ml clj r jl sh bash zsh fish ps1 vue svelte astro md mdx rst sql proto graphql gradle html css scss less json jsonc yaml yml toml xml tf ipynb').split(' '),
)

/** The name before the value at s[a] is a file's or a path's last part (token.go:L643-669), not a field's. */
function fileField(s: string, a: number): boolean {
  let i = a
  while (i > 0 && ' \t"\'\\'.includes(s[i - 1] as string)) i--
  if (i === 0 || (s[i - 1] !== ':' && s[i - 1] !== '=')) return false
  i--
  while (i > 0 && ' \t"\'\\'.includes(s[i - 1] as string)) i--
  const end = i
  while (i > 0 && (ALNUM + '_.-').includes(s[i - 1] as string)) i--
  const name = s.slice(i, end)
  if (name === '') return false
  if (i > 0 && (s[i - 1] === '/' || s[i - 1] === '\\')) return true
  const dot = name.lastIndexOf('.')
  return dot > 0 && SOURCE_EXT.has(name.slice(dot + 1).toLowerCase())
}

const PATH_ROOTS = new Set(
  'Users home tmp private var etc run opt usr mnt Volumes root srv data workspace workspaces app Applications Library System proc dev sys nix'.split(' '),
)

/** A file's or a folder's path (~/.ssh/id_ed25519, /Users/…): where a secret is kept, not the secret. */
export function pathValue(v: string): boolean {
  if (/[+=]/.test(v)) return false
  for (const p of ['~/', './', '../']) if (v.startsWith(p) && v.length > p.length) return true
  if (!v.startsWith('/')) return false
  const cut = v.indexOf('/', 1)
  if (cut < 0 || cut === v.length - 1) return false
  return PATH_ROOTS.has(v.slice(1, cut))
}

const FILE_EXT = new Set(
  (
    // the model weights and data a run loads
    'safetensors ckpt pt pth bin gguf ggml onnx sft h5 pb tflite mlmodel npz npy pkl msgpack engine plan trt ' +
    // archives
    'zip tar gz tgz bz2 xz zst 7z rar lz4 whl ' +
    // pictures, sound and video
    'png jpg jpeg webp gif bmp svg ico tif tiff avif heic mp4 mov mkv webm avi m4v wav mp3 flac ogg m4a ' +
    // documents and data
    'txt md pdf doc docx xls xlsx ppt pptx csv tsv json jsonl yaml yml xml html toml ini cfg conf log sqlite db parquet'
  ).split(' '),
)

/**
 * A file's name, not a value: a field called key or password holding a model's
 * file name (ComfyUI's PowerShell dump of a workflow has one after $key for
 * every node it loads, issue #1) names a model a run loads, and no secret is
 * kept in a file of one of these kinds. A file's name has only its name's
 * characters, so a key of its own that merely contains a dot stays masked.
 */
export function fileNameValue(v: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(v)) return false
  const dot = v.lastIndexOf('.')
  return dot > 0 && dot < v.length - 1 && FILE_EXT.has(v.slice(dot + 1).toLowerCase())
}

/**
 * The words a published cryptographic algorithm's name is built from: scram,
 * sha, aes, gcm, pbkdf, with, padding, tls, siv, poly. The list is closed and
 * disjoint from SECRET_WORDS, so a real secret's random characters spell no
 * word of it (docs/adr/0033).
 */
const ALGO_WORDS = new Set(
  (
    'scram sha shake md blake ripemd whirlpool crc xxh siphash ' +
    'hmac hkdf pbkdf argon bcrypt scrypt with ' +
    'aes des desede rc twofish serpent camellia idea chacha cha salsa blowfish aria sm ' +
    'ecb cbc ctr ccm gcm cfb ofb xts siv kw kwr padding pkcs oaep pss no ' +
    'rsa dsa dh ecdsa ecdh ecdhe ed x p ecc curve id ' +
    'tls ssl sasl gssapi jwt jose hs rs es ps poly'
  ).split(' '),
)

/** The words in a value: runs of letters, with the boundary of a camelCase word opened. */
function algorithmWords(v: string): string[] {
  const out: string[] = []
  for (const part of v.split(/[^A-Za-z]+/)) {
    if (part === '') continue
    for (const w of part.match(/[A-Z]+[a-z]*|[a-z]+|[A-Z]+/g) ?? []) out.push(w.toLowerCase())
  }
  return out
}

/**
 * The name of a published cryptographic algorithm, not a value: a Kafka
 * scram_mechanism's SCRAM-SHA-512, PBKDF2WithHmacSHA256,
 * ECDHE-RSA-AES128-GCM-SHA256. A spec publishes these names for anyone to
 * read, so masking one hides nothing — it only mangles a config in a tool's
 * output, and a reader suspects the config was edited. Every word of the
 * value has to be one of ALGO_WORDS and its characters a name's, or it is not
 * one: the words are published vocabulary, and a secret is not spelled out of
 * them (docs/adr/0033).
 */
export function algorithmValue(v: string): boolean {
  if (!hasDigit(v) || !/^[A-Za-z0-9][A-Za-z0-9 ._+/-]*$/.test(v)) return false
  const words = algorithmWords(v)
  return words.length > 0 && words.every((w) => ALGO_WORDS.has(w))
}

const SECRET_WORDS = new Set(['token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'pwd', 'key', 'keys', 'apikey', 'credential', 'credentials'])
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/

function identWords(v: string): string[] {
  const out: string[] = []
  for (const part of v.split(/[_.]/)) {
    if (part === '') continue
    let start = 0
    for (let i = 1; i < part.length; i++) {
      if (/[A-Z]/.test(part[i] as string) && /[a-z]/.test(part[i - 1] as string)) {
        out.push(part.slice(start, i))
        start = i
      }
    }
    out.push(part.slice(start))
  }
  return out
}

/** A name in code for a secret (refreshToken2, generate_token_v2, env.SECRET_V2), not one. */
function namesASecret(v: string): boolean {
  if (!IDENT.test(v)) return false
  if (!/[a-z]/.test(v[0] as string) && !/[_.]/.test(v)) return false
  let words = 0
  let named = false
  for (let w of identWords(v)) {
    if (!/[A-Za-z]/.test(w)) continue
    words++
    const d = w.search(/[0-9]/)
    if (d >= 0) w = w.slice(0, d)
    if (SECRET_WORDS.has(w.toLowerCase())) named = true
  }
  return words >= 2 && named
}

/** Where a value the SECRET rules found can be a secret: not code, a place in a file, a path, a file's name, a name in code or a version. */
export function fieldAt(s: string, a: number, b: number): boolean {
  if (!notCode(s, a, b)) return false
  const v = s.slice(a, b)
  if (v[0] === '=') return false // Go's := with no space after it
  return (
    !fileField(s, a) && !LINE_REF.test(v) && !pathValue(v) && !fileNameValue(v) && !namesASecret(v) && !skillName(s, a, b) && !versionValue(v)
  )
}

export { trimEnd, trimStart }

/** A field's name's words in lower case: next_page_token, nextPageToken and X-Next-Page-Token are next, page, token. */
export function nameWords(name: string): string[] {
  const out: string[] = []
  let w = ''
  const flush = (): void => {
    if (w !== '') out.push(w)
    w = ''
  }
  for (let i = 0; i < name.length; i++) {
    const c = name[i] as string
    if (c === '_' || c === '-' || c === '.') flush()
    else if (c >= 'A' && c <= 'Z') {
      if (i > 0 && /[a-z]/.test(name[i - 1] as string)) flush()
      w += c.toLowerCase()
    } else w += c
  }
  flush()
  return out
}

/** The words of the name of the field whose value starts at s[at]; none where no field's name is before it. */
export function fieldWords(s: string, at: number): string[] {
  let i = at
  while (i > 0 && ' \t"\'\\'.includes(s[i - 1] as string)) i--
  if (i === 0 || (s[i - 1] !== ':' && s[i - 1] !== '=')) return []
  i--
  while (i > 0 && ' \t"\'\\'.includes(s[i - 1] as string)) i--
  let j = i
  while (j > 0 && (ALNUM + '_.-').includes(s[j - 1] as string)) j--
  return nameWords(s.slice(j, i))
}

export function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c)
}
