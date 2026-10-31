/**
 * Checks for the PASSWORD rule's URLs and for personal data (EMAIL, PHONE,
 * ID_CARD, BANK_CARD), by magpie's semantics (redact.go, phone.go).
 */
import { ALNUM, TOKEN_CH, nameWords, trimEnd } from './checks.ts'

const isAlpha = (c: string | undefined): boolean => c !== undefined && /[A-Za-z]/.test(c)
const isAlnum = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c)

/**
 * The password at s[a:b], in a URL's user:password@, is hidden by masking
 * it: it is not also written elsewhere in the same URL, as its user name or
 * a part of its host or path (postgres:postgres@…, a test database whose
 * one word is the user, the password and the database). Masked, that word
 * became known and went masked everywhere else for the rest of the run.
 */
export function hiddenInURL(s: string, a: number, b: number): boolean {
  const pw = s.slice(a, b)
  const i = s.lastIndexOf('//', a)
  if (i < 0 || s[a - 1] !== ':') return true
  if (s.slice(i + 2, a - 1) === pw) return false
  let end = b + 1
  while (end < s.length && !' \t\r\n"\'<>`\\)]}'.includes(s[end] as string)) end++
  if (b + 1 > end) return true
  return !s
    .slice(b + 1, end)
    .split(/[/:.?#&=;,@]/)
    .some((part) => part === pw)
}

/** s[a] is inside a URL's authority, after its scheme:// and before the host. */
export function inUserinfo(s: string, a: number): boolean {
  let i = a
  while (i > 0 && !' \t\r\n/?#"\'<>@`'.includes(s[i - 1] as string)) i--
  if (i < 3 || s[i - 1] !== '/' || s[i - 2] !== '/' || s[i - 3] !== ':') return false
  const j = i - 3
  let k = j
  while (k > 0 && (isAlnum(s[k - 1]) || '+.-'.includes(s[k - 1] as string))) k--
  while (k < j && !isAlpha(s[k])) k++
  return k < j
}

/** Where an email can be: not in a URL's userinfo, and with no dot touching it that makes it part of a longer name. */
export function emailAt(s: string, a: number, b: number): boolean {
  if (a > 0 && s[a - 1] === '.') return false
  if (b + 1 < s.length && s[b] === '.' && TOKEN_CH.includes(s[b + 1] as string)) return false
  return !inUserinfo(s, a)
}

const LINKER_WORDS = new Set(['plt', 'got', 'sec', 'iplt', 'igot'])
const DOC_FILES = new Set(
  'agents.md claude.md gemini.md readme.md skill.md changelog.md contributing.md license.md lessons.md todo.md copilot-instructions.md crush.md qwen.md iflow.md warp.md'.split(' '),
)
const LOCAL_TLDS = new Set(['local', 'internal', 'lan', 'corp', 'home', 'intranet', 'localdomain'])
/**
 * Generic top-level domains mail is commonly sent to. magpie asks the public
 * suffix list; this gateway carries no copy of it, so a two-letter country
 * code, one of these, or a label in another script counts. A module's
 * attribute after a name (x@pytest.fixture) ends in none of them.
 */
const MAIL_TLDS = new Set(
  ('com net org edu gov mil int info biz name pro mobi asia tel travel jobs museum coop aero cat io ai dev app co me tv cc xyz top site online ' +
    'tech cloud email mail store shop blog live news life world today space website club vip work ltd group team company network page link ' +
    'digital agency studio design media global solutions services center zone one fun icu wang ren art bot inc law llc gmbh family games').split(' '),
)
const FILE_EXT = new Set(
  ('jpg jpeg png gif webp svg heic heif avif bmp tif tiff ico icns pdf svgz apng jxl psd eps lottie mp4 m4v webm mkv avi mp3 m4a wav ogg flac aac ' +
    'ttf otf woff woff2 eot json yaml yml toml xml txt csv tsv log html htm css scss less js mjs cjs jsx ts tsx doc docx xls xlsx ppt pptx gz tgz tar rar 7z dmg').split(' '),
)
const SCALE_EXT = new Set(['zip', 'mov', 'md', 'map'])

function mailTLD(tld: string): boolean {
  if (LOCAL_TLDS.has(tld) || MAIL_TLDS.has(tld)) return true
  if (/^[a-z]{2}$/.test(tld)) return true
  return /[^\x00-\x7f]/.test(tld)
}

function mailHost(local: string, host: string): boolean {
  if (local.endsWith('@') || !host.includes('.') || host.replace(/^\.+|\.+$/g, '') !== host) return false
  let linker = true
  for (const l of host.split('.')) {
    if (l === '' || /[\x00-\x2c\x2e-\x2f\x3a-\x60\x7b-\x7f]/.test(l)) return false
    if (!LINKER_WORDS.has(l)) linker = false
  }
  return !linker
}

function fileHost(host: string): boolean {
  const dot = host.lastIndexOf('.')
  const ext = host.slice(dot + 1)
  return FILE_EXT.has(ext) || (dot > 0 && SCALE_EXT.has(ext) && /^[0-9]+(?:\.[0-9]+)?x$/.test(host.slice(0, dot)))
}

/** Whether v, matched as an address, is someone's: not git@ (a host's SSH user), a file (icon@2x.png), a doc's name or an example domain. */
export function realEmail(v: string): boolean {
  const at = v.lastIndexOf('@')
  if (v.slice(0, at).toLowerCase() === 'git') return false
  const host = v.slice(at + 1).toLowerCase()
  if (!mailHost(v.slice(0, at), host)) return false
  if (fileHost(host) || DOC_FILES.has(host) || !mailTLD(host.slice(host.lastIndexOf('.') + 1))) return false
  for (const fake of ['example.com', 'example.org', 'example.net', 'localhost', '.test', '.invalid', '.example']) {
    if (host === fake.replace(/^\./, '') || host.endsWith(fake)) return false
  }
  return !host.startsWith('noreply') && !v.includes('noreply@')
}

/** A mainland resident ID's check digit. */
export function chineseID(v: string): boolean {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  let sum = 0
  for (let i = 0; i < 17; i++) sum += (v.charCodeAt(i) - 48) * (w[i] as number)
  return v.slice(17).toUpperCase() === '10X98765432'[sum % 11]
}

/** A card number's Luhn check, over 15 to 19 digits. */
export function luhn(v: string): boolean {
  const ds = [...v].filter((c) => c >= '0' && c <= '9').map(Number)
  if (ds.length < 15 || ds.length > 19) return false
  let sum = 0
  for (let i = 0; i < ds.length; i++) {
    let d = ds[ds.length - 1 - i] as number
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

const PHONE_WORDS = new Set(['phone', 'phones', 'mobile', 'mobiles', 'tel', 'telephone', 'cell', 'cellphone', 'contact', 'contacts', 'whatsapp', 'sms', 'msisdn', 'fax'])
const PHONE_MARKS = ['手机', '电话', '電話', '联系', '聯繫', '联络']
const ID_WORDS = ['order', 'id', 'uid', 'no', 'no.', '#', 'number', 'ticket', 'invoice', '订单', '订单号', '单号', '编号', '流水号', '工单', '工单号', '运单号', '快递单号', '订单编号', '交易号', '序号', '账单号', 'id号']

const isCJK = (c: string): boolean => c >= '\u4e00' && c <= '\u9fff'

function nameStart(s: string, i: number): number {
  let j = i
  while (j > 0) {
    const c = s[j - 1] as string
    if (!((ALNUM + '_.-').includes(c) || isCJK(c))) break
    j--
  }
  return j
}

function phoneName(name: string): boolean {
  return nameWords(name).some((w) => PHONE_WORDS.has(w)) || PHONE_MARKS.some((m) => name.includes(m))
}

/** The name of the field whose value starts at s[a] (JSON, k=v, YAML, SQL, an XML element), and the word before it. */
function fieldName(s: string, a: number): { name: string; prev: string } | undefined {
  let i = a
  while (i > 0 && ' \t"\''.includes(s[i - 1] as string)) i--
  if (i > 0 && s[i - 1] === '>') {
    const from = Math.max(0, i - 65)
    const k = s.slice(from, i - 1).lastIndexOf('<')
    if (k < 0) return undefined
    let tag = s.slice(from + k + 1, i - 1)
    const sp = tag.search(/[ \t]/)
    if (sp >= 0) tag = tag.slice(0, sp)
    if (tag === '' || [...tag].some((c) => !(ALNUM + '_.:-').includes(c))) return undefined
    return { name: tag, prev: '' }
  }
  if (i > 0 && (s[i - 1] === ':' || s[i - 1] === '=' || s[i - 1] === '：')) i--
  else return undefined
  while (i > 0 && ' \t"\''.includes(s[i - 1] as string)) i--
  const j = nameStart(s, i)
  if (j === i) return undefined
  let name = s.slice(j, i)
  const chars = [...name]
  if (chars.length > 6 && chars.some(isCJK)) name = chars.slice(-6).join('')
  let prev = ''
  if (j >= 2 && s[j - 1] === ' ' && s[j - 2] !== ' ') prev = s.slice(nameStart(s, j - 1), j - 1)
  return { name, prev }
}

/**
 * The PHONE rule's s[a:b] is a phone, not an id of the same form (order_id
 * 13800138000, 订单号 13912345678): with +86 it is one anywhere; as a field's
 * value only under a phone's name; in prose unless an id's word is right
 * before it.
 */
export function phoneAt(s: string, a: number, b: number): boolean {
  if (b - a > 11) return true
  const f = fieldName(s, a)
  if (f) return phoneName(f.name) || (f.prev !== '' && phoneName(f.prev)) || f.name.toLowerCase() === 'number'
  if (a > 0 && s[a - 1] === '#') return false
  let before = trimEnd(s.slice(Math.max(0, a - 32), a), ' \t("\'“「').toLowerCase()
  for (const c of ['是', '为', '為']) {
    if (before.endsWith(c)) before = trimEnd(before.slice(0, -c.length), ' \t')
  }
  for (const w of ID_WORDS) {
    if (!before.endsWith(w)) continue
    let rest = before.slice(0, before.length - w.length)
    if (rest !== '' && w.charCodeAt(0) < 0x80 && /[a-z0-9_]/.test(rest[rest.length - 1] as string)) continue
    if (w === 'no' || w === 'no.' || w === 'number') {
      rest = trimEnd(rest, ' ')
      if (phoneName(rest.slice(nameStart(rest, rest.length)))) return true
    }
    return false
  }
  return true
}
