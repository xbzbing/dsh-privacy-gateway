import type { Hit } from './redact/mask.ts'
import type { Stats, Totals } from './records.ts'

/**
 * `/privacy`: status, on, off and test (design §7.4, §10). No answer ever has
 * a value in it: status is counts, test is the text as it would go, with the
 * placeholders in it and a hint per value (its head and length).
 */

export type Lang = 'zh' | 'en'

/** What the command needs from the plugin. */
export interface PrivacyFace {
  /** Masking on or off for this run; the config is not written. */
  active: boolean
  readonly secrets: boolean
  readonly personal: boolean
  /** Values the table holds. */
  readonly values: number
  stats(): Stats
  preview(text: string): { text: string; hits: Hit[] }
}

export type CommandAnswer = { kind: 'success'; text: string } | { kind: 'error'; text: string }

const TEXT = {
  zh: {
    usage: '用法：/privacy [status | on | off | test <文本>]',
    on: '脱敏已开启。',
    off: '脱敏已关闭：模型请求按原文发出，直到 /privacy on 或重启。配置未改动。',
    already: (on: boolean) => (on ? '脱敏本来就是开启的。' : '脱敏本来就是关闭的。'),
    testEmpty: '用法：/privacy test <文本>',
    nothing: '这段文本里没有要遮的值。',
    wouldGo: '会发出：',
    values: (n: number) => `${n} 个值：`,
    state: (on: boolean) => `状态：${on ? '开启' : '已关闭（/privacy on 恢复）'}`,
    covers: (secrets: boolean, personal: boolean) => `范围：密钥 ${secrets ? '开' : '关'}，个人信息 ${personal ? '开' : '关'}`,
    table: (n: number) => `值表：${n} 个值`,
    line: (label: string, t: Totals) => `${label}：记录 ${t.requests} 次请求，${t.masked} 次有遮蔽，替换 ${t.n} 处，还原 ${t.restored} 处${t.restoredInTools > 0 ? `（工具参数里 ${t.restoredInTools} 处）` : ''}`,
    today: '今日',
    week: '7 天',
    month: '30 天',
    kinds: '今日按 kind：',
    finders: '今日按 finder：',
    failed: (n: number) => `⚠ 连续 ${n} 次遮蔽失败，请求未发出。止血：/privacy off`,
    failedToday: (n: number) => `今日遮蔽失败 ${n} 次`,
    unmapped: (n: number) => `⚠ 今日回复里有 ${n} 个值表里没有的占位符（可能被模型改坏）`,
    took: (avg: number, max: number) => `遮蔽耗时：平均 ${avg} ms，最长 ${max} ms`,
    action: { warn: '（warn：会按原文发出并记一条）', block: '（block：整个请求不会发出）' },
    actedToday: (warned: number, blocked: number) => `今日 warn 放行 ${warned} 处，block 拦下 ${blocked} 次请求`,
  },
  en: {
    usage: 'Usage: /privacy [status | on | off | test <text>]',
    on: 'Masking is on.',
    off: 'Masking is off: model requests go as written until /privacy on or a restart. The config is unchanged.',
    already: (on: boolean) => (on ? 'Masking was already on.' : 'Masking was already off.'),
    testEmpty: 'Usage: /privacy test <text>',
    nothing: 'Nothing in this text would be masked.',
    wouldGo: 'Would go as:',
    values: (n: number) => `${n} value${n === 1 ? '' : 's'}:`,
    state: (on: boolean) => `State: ${on ? 'on' : 'off (/privacy on turns it back on)'}`,
    covers: (secrets: boolean, personal: boolean) => `Masks: secrets ${secrets ? 'on' : 'off'}, personal data ${personal ? 'on' : 'off'}`,
    table: (n: number) => `Value table: ${n} values`,
    line: (label: string, t: Totals) => `${label}: ${t.requests} requests recorded, ${t.masked} masked, ${t.n} places replaced, ${t.restored} restored${t.restoredInTools > 0 ? ` (${t.restoredInTools} in tool arguments)` : ''}`,
    today: 'Today',
    week: '7 days',
    month: '30 days',
    kinds: 'Today by kind: ',
    finders: 'Today by finder: ',
    failed: (n: number) => `⚠ Masking failed ${n} times in a row; those requests were not sent. To stop it: /privacy off`,
    failedToday: (n: number) => `Masking failures today: ${n}`,
    unmapped: (n: number) => `⚠ Replies today had ${n} placeholders the table has no value for (a model may have changed them)`,
    took: (avg: number, max: number) => `Masking time: ${avg} ms on average, ${max} ms at most`,
    action: { warn: ' (warn: goes as written, and is recorded)', block: ' (block: the request would not be sent)' },
    actedToday: (warned: number, blocked: number) => `Today warn let ${warned} places through and block stopped ${blocked} requests`,
  },
} as const

function counts(m: Record<string, number>): string {
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')
}

/** A value as an answer may show it: kind, finder, head and length. */
function hintOf(h: Hit, lang: Lang): string {
  return `${h.placeholder}  ${h.kind} · ${h.by} · ${h.head ? `${h.head}… ` : ''}${h.len}${h.action ? TEXT[lang].action[h.action] : ''}`
}

function status(face: PrivacyFace, lang: Lang): string {
  const T = TEXT[lang]
  const s = face.stats()
  const out = [T.state(face.active), T.covers(face.secrets, face.personal), T.table(face.values), '', T.line(T.today, s.today), T.line(T.week, s.week), T.line(T.month, s.month)]
  if (Object.keys(s.today.kinds).length > 0) out.push(T.kinds + counts(s.today.kinds))
  if (Object.keys(s.today.finders).length > 0) out.push(T.finders + counts(s.today.finders))
  if (s.today.warned > 0 || s.today.blocked > 0) out.push(T.actedToday(s.today.warned, s.today.blocked))
  if (s.today.requests > 0) out.push(T.took(Math.round((s.today.tookMs.sum / s.today.requests) * 100) / 100, s.today.tookMs.max))
  const warn: string[] = []
  if (s.failStreak > 0) warn.push(T.failed(s.failStreak))
  else if (s.today.failed > 0) warn.push(T.failedToday(s.today.failed))
  if (s.today.unmapped > 0) warn.push(T.unmapped(s.today.unmapped))
  if (warn.length > 0) out.push('', ...warn)
  return out.join('\n')
}

/** Runs `/privacy <rawInput>`. */
export function runPrivacyCommand(face: PrivacyFace, rawInput: string, lang: Lang): CommandAnswer {
  const T = TEXT[lang]
  const input = rawInput.replace(/^\s+/, '')
  const sub = /^\S*/.exec(input)?.[0].toLowerCase() ?? ''
  const rest = input.slice(sub.length).replace(/^\s/, '')
  switch (sub) {
    case '':
    case 'status':
      return { kind: 'success', text: status(face, lang) }
    case 'on':
    case 'off': {
      const on = sub === 'on'
      if (face.active === on) return { kind: 'success', text: T.already(on) }
      // `off` is a flag the masker never sees: it works while masking fails (design §6)
      face.active = on
      return { kind: 'success', text: on ? T.on : T.off }
    }
    case 'test': {
      if (rest.trim() === '') return { kind: 'error', text: T.testEmpty }
      const r = face.preview(rest)
      if (r.hits.length === 0) return { kind: 'success', text: T.nothing }
      const seen = new Set<string>()
      const values = r.hits.filter((h) => !seen.has(h.placeholder) && seen.add(h.placeholder))
      return { kind: 'success', text: [T.wouldGo, r.text, '', T.values(values.length), ...values.map((h) => hintOf(h, lang))].join('\n') }
    }
    default:
      return { kind: 'error', text: T.usage }
  }
}

/** The answer language for a locale preference: zh for any Chinese, English otherwise. */
export function langOf(preference: unknown): Lang {
  return typeof preference === 'string' && preference.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
