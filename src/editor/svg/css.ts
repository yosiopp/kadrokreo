import type { SvgElement } from './xml.ts'

// SVG の <style> の CSS を読む。読むのは単純なセレクタ（要素名・#id・.class・* と、それらをつないだもの、カンマ区切り）だけ。
// 子孫や子の結合子（空白・>・+・~）、属性セレクタ、疑似クラスを含むセレクタは読み飛ばして数える。
// @media などの @ で始まる規則は中身ごと読み飛ばす（@import は外部を読まない）。

/** 1 つのセレクタ（結合子なし） */
type Selector = { tag: string | null; id: string | null; classes: string[]; specificity: number }

type Rule = { selectors: Selector[]; declarations: Record<string, string>; important: Record<string, string>; order: number }

export type StyleSheet = {
  rules: Rule[]
  /** 読み飛ばしたセレクタの数 */
  skippedSelectors: number
  /** 読み飛ばした @ の規則の数 */
  skippedAtRules: number
}

/** 規則の数の上限（細工された大きな CSS で、要素ごとの照合が重くならないように） */
const MAX_RULES = 10_000

const SIMPLE = /^(\*|[A-Za-z_][\w-]*)?((?:[.#][A-Za-z_\-\\][\w-]*)*)$/

export function parseStyleSheet(source: string): StyleSheet {
  const sheet: StyleSheet = { rules: [], skippedSelectors: 0, skippedAtRules: 0 }
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->/g, '')
  let i = 0
  while (i < text.length && sheet.rules.length < MAX_RULES) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (i >= text.length) break
    if (text[i] === '@') {
      sheet.skippedAtRules++
      // ; で終わる規則（@import・@charset）か、{ } の塊（@media・@font-face）を読み飛ばす
      const semicolon = text.indexOf(';', i)
      const brace = text.indexOf('{', i)
      if (brace < 0 || (semicolon >= 0 && semicolon < brace)) {
        i = semicolon < 0 ? text.length : semicolon + 1
      } else {
        i = skipBlock(text, brace)
      }
      continue
    }
    const open = text.indexOf('{', i)
    if (open < 0) break
    const close = text.indexOf('}', open)
    const end = close < 0 ? text.length : close
    const selectorText = text.slice(i, open)
    const body = text.slice(open + 1, end)
    i = end + 1
    const selectors: Selector[] = []
    for (const raw of selectorText.split(',')) {
      const selector = parseSelector(raw.trim())
      if (selector) selectors.push(selector)
      else if (raw.trim() !== '') sheet.skippedSelectors++
    }
    if (selectors.length === 0) continue
    const { declarations, important } = parseDeclarations(body)
    sheet.rules.push({ selectors, declarations, important, order: sheet.rules.length })
  }
  return sheet
}

/** { から対応する } の次まで（入れ子の { } も数える） */
function skipBlock(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i + 1
  }
  return text.length
}

function parseSelector(raw: string): Selector | null {
  const match = SIMPLE.exec(raw)
  if (!match || raw === '') return null
  const tag = match[1] && match[1] !== '*' ? match[1] : null
  let id: string | null = null
  const classes: string[] = []
  for (const part of match[2].match(/[.#][^.#]+/g) ?? []) {
    if (part[0] === '#') {
      // #a#b は何にも当たらない
      if (id !== null && id !== part.slice(1)) return null
      id = part.slice(1)
    } else classes.push(part.slice(1))
  }
  return { tag, id, classes, specificity: (id ? 100 : 0) + classes.length * 10 + (tag ? 1 : 0) }
}

/** 宣言の並び。名前は小文字にし、!important は別に持つ */
export function parseDeclarations(body: string): { declarations: Record<string, string>; important: Record<string, string> } {
  const declarations: Record<string, string> = {}
  const important: Record<string, string> = {}
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const name = declaration.slice(0, colon).trim().toLowerCase()
    let value = declaration.slice(colon + 1).trim()
    const isImportant = /!\s*important\s*$/i.test(value)
    if (isImportant) value = value.replace(/!\s*important\s*$/i, '').trim()
    if (name === '' || value === '') continue
    if (isImportant) important[name] = value
    else declarations[name] = value
  }
  return { declarations, important }
}

function matches(selector: Selector, element: SvgElement): boolean {
  if (selector.tag !== null && selector.tag !== element.name) return false
  if (selector.id !== null && selector.id !== element.attributes.id) return false
  if (selector.classes.length > 0) {
    const own = (element.attributes.class ?? '').split(/\s+/)
    if (!selector.classes.every((name) => own.includes(name))) return false
  }
  return true
}

/**
 * 要素に当たる CSS の宣言。詳細度の低い順・書いた順に重ねる。normal は style 属性より弱く、important は style 属性より強い
 * （呼び出し側が「属性 < normal < style 属性 < important」の順に重ねる）
 */
export function matchedDeclarations(
  sheet: StyleSheet,
  element: SvgElement,
): { normal: Record<string, string>; important: Record<string, string> } {
  const hits: { specificity: number; order: number; rule: Rule }[] = []
  for (const rule of sheet.rules) {
    let best = -1
    for (const selector of rule.selectors) {
      if (selector.specificity > best && matches(selector, element)) best = selector.specificity
    }
    if (best >= 0) hits.push({ specificity: best, order: rule.order, rule })
  }
  hits.sort((a, b) => a.specificity - b.specificity || a.order - b.order)
  const normal: Record<string, string> = {}
  const important: Record<string, string> = {}
  for (const { rule } of hits) {
    Object.assign(normal, rule.declarations)
    Object.assign(important, rule.important)
  }
  return { normal, important }
}
