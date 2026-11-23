import type { SvgElement } from './xml.ts'

// SVG の <style> の CSS を読む。セレクタは Selectors Level 4 のうち、静的な文書で決まるものを読む:
// 要素名・*・#id・.class・属性（[a] [a=v] [a~=v] [a|=v] [a^=v] [a$=v] [a*=v]、i / s の指定）、
// 結合子（子孫の空白・子の >・隣の +・後ろの兄弟の ~）、疑似クラス（:root :empty :first-child :last-child :only-child
// :first-of-type :last-of-type :only-of-type :nth-child() :nth-last-child() :nth-of-type() :nth-last-of-type()
// :not() :is() :where() :link :any-link）。:not() などの中は結合子のない並びだけ。
// 操作で変わる疑似クラス（:hover・:focus など）は取り込む時点では当たらないので、その規則は黙って使わない。
// それ以外（知らない疑似クラス、::before などの疑似要素、:has() など）を含むセレクタは読み飛ばして数える。
// @media などの @ で始まる規則は中身ごと読み飛ばす（@import は外部を読まない）。

type AttributeTest = { name: string; operator: string | null; value: string; insensitive: boolean }

type Pseudo =
  | { kind: 'root' | 'empty' | 'link' }
  | { kind: 'nth'; a: number; b: number; last: boolean; ofType: boolean }
  | { kind: 'only'; ofType: boolean }
  | { kind: 'not' | 'is'; list: Compound[] }

/** 結合子を含まない 1 つの並び（a.b[c]:first-child など） */
type Compound = { tag: string | null; id: string | null; classes: string[]; attributes: AttributeTest[]; pseudos: Pseudo[] }

type Combinator = ' ' | '>' | '+' | '~'

/** 1 つのセレクタ。compounds[i] と compounds[i + 1] の間が combinators[i] */
type Selector = { compounds: Compound[]; combinators: Combinator[]; specificity: number }

type Rule = { selectors: Selector[]; declarations: Record<string, string>; important: Record<string, string>; order: number }

/** 兄弟の中の位置（:nth-child などに使う）。番号は 1 から */
type Position = { index: number; count: number; typeIndex: number; typeCount: number; previous: SvgElement[] }

export type StyleSheet = {
  rules: Rule[]
  /** 読み飛ばしたセレクタの数 */
  skippedSelectors: number
  /** 読み飛ばした @ の規則の数 */
  skippedAtRules: number
  /** 照合の手数（細工された CSS と木で重くならないよう、上限で打ち切る）。打ち切ったら exhausted */
  steps: number
  exhausted: boolean
  positions: WeakMap<SvgElement, Position>
}

/** 規則の数の上限（細工された大きな CSS で、要素ごとの照合が重くならないように） */
const MAX_RULES = 10_000
/** 1 つのセレクタの並びの数の上限 */
const MAX_COMPOUNDS = 32
/** 結合子でたどる照合の手数の上限（要素 × 規則 × 祖先や兄弟をたどる数）。超えたら、それより後の結合子つきのセレクタは当たらないものとして知らせる */
const MAX_STEPS = 2_000_000

const IDENT = /^-?(?:[A-Za-z_\u00a0-\uffff]|\\.)(?:[\w\u00a0-\uffff-]|\\.)*/
/** 操作で変わる疑似クラス。取り込む時点では当たらない */
const DYNAMIC = new Set(['hover', 'active', 'focus', 'focus-within', 'focus-visible', 'visited', 'target', 'target-within', 'checked', 'disabled', 'enabled'])

export function parseStyleSheet(source: string): StyleSheet {
  const sheet: StyleSheet = { rules: [], skippedSelectors: 0, skippedAtRules: 0, steps: 0, exhausted: false, positions: new WeakMap() }
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
    for (const raw of splitList(selectorText)) {
      const selector = parseSelector(raw.trim())
      if (selector === 'never') continue
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

/** カンマ区切りの並びを分ける。( ) と [ ] と引用符の中のカンマでは分けない */
function splitList(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function unescape(ident: string): string {
  return ident.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex: string | undefined, char: string | undefined) =>
    hex !== undefined ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : char!,
  )
}

/** 読めないセレクタは null、決して当たらないセレクタ（:hover など）は 'never' */
function parseSelector(raw: string): Selector | null | 'never' {
  if (raw === '') return null
  const compounds: Compound[] = []
  const combinators: Combinator[] = []
  let rest = raw
  let never = false
  for (;;) {
    const parsed = parseCompound(rest)
    if (!parsed) return null
    if (parsed.never) never = true
    compounds.push(parsed.compound)
    if (compounds.length > MAX_COMPOUNDS) return null
    rest = parsed.rest
    const combinator = /^\s*([>+~])\s*|^\s+/.exec(rest)
    if (!combinator) break
    rest = rest.slice(combinator[0].length)
    if (rest === '') break
    combinators.push((combinator[1] ?? ' ') as Combinator)
  }
  if (rest.trim() !== '' || combinators.length !== compounds.length - 1) return null
  if (never) return 'never'
  return { compounds, combinators, specificity: compounds.reduce((sum, compound) => sum + specificityOf(compound), 0) }
}

/** 先頭の並びを読む。読めなければ null。never は決して当たらない疑似クラスを含むこと */
function parseCompound(text: string, nested = false): { compound: Compound; rest: string; never: boolean } | null {
  const compound: Compound = { tag: null, id: null, classes: [], attributes: [], pseudos: [] }
  let rest = text
  let never = false
  let empty = true
  const tag = /^(\*|(?:-?(?:[A-Za-z_]|\\.)(?:[\w-]|\\.)*))(?:\|(\*|[A-Za-z_][\w-]*))?/.exec(rest)
  if (tag) {
    // 名前空間つき（svg|rect）は名前だけを見る
    const name = tag[2] ?? tag[1]
    compound.tag = name === '*' ? null : unescape(name)
    rest = rest.slice(tag[0].length)
    empty = false
  }
  for (;;) {
    if (rest[0] === '#' || rest[0] === '.') {
      const ident = IDENT.exec(rest.slice(1))
      if (!ident) return null
      const value = unescape(ident[0])
      if (rest[0] === '#') {
        // #a#b は何にも当たらない
        if (compound.id !== null && compound.id !== value) never = true
        compound.id = value
      } else compound.classes.push(value)
      rest = rest.slice(1 + ident[0].length)
    } else if (rest[0] === '[') {
      const match = /^\[\s*(?:([A-Za-z_*][\w-]*)?\|)?([A-Za-z_][\w.:-]*)\s*(?:([~|^$*]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]"']+))\s*([iIsS])?\s*)?\]/.exec(rest)
      if (!match) return null
      const [, prefix, local, operator, double, single, bare, flag] = match
      const name = prefix && prefix !== '*' ? `${prefix}:${local}` : prefix === '*' ? `*|${local}` : local
      compound.attributes.push({
        name,
        operator: operator ?? null,
        value: unescape(double ?? single ?? bare ?? ''),
        insensitive: flag === 'i' || flag === 'I',
      })
      rest = rest.slice(match[0].length)
    } else if (rest.startsWith('::')) {
      return null
    } else if (rest[0] === ':') {
      const ident = /^:([A-Za-z-]+)(\()?/.exec(rest)
      if (!ident) return null
      const name = ident[1].toLowerCase()
      rest = rest.slice(ident[0].length)
      let argument: string | null = null
      if (ident[2]) {
        const close = closingParen(rest)
        if (close < 0) return null
        argument = rest.slice(0, close)
        rest = rest.slice(close + 1)
      }
      const pseudo = parsePseudo(name, argument, nested)
      if (pseudo === null) return null
      if (pseudo === 'never') never = true
      else if (pseudo !== 'always') compound.pseudos.push(pseudo)
    } else break
    empty = false
  }
  if (empty) return null
  return { compound, rest, never }
}

/** ( の後の文字列で、対応する ) の位置 */
function closingParen(text: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && depth-- === 0) return i
  }
  return -1
}

function parsePseudo(name: string, argument: string | null, nested: boolean): Pseudo | 'never' | 'always' | null {
  if (argument === null) {
    if (DYNAMIC.has(name)) return 'never'
    switch (name) {
      case 'root':
      case 'empty':
        return { kind: name }
      case 'link':
      case 'any-link':
        return { kind: 'link' }
      case 'first-child':
      case 'last-child':
        return { kind: 'nth', a: 0, b: 1, last: name === 'last-child', ofType: false }
      case 'first-of-type':
      case 'last-of-type':
        return { kind: 'nth', a: 0, b: 1, last: name === 'last-of-type', ofType: true }
      case 'only-child':
      case 'only-of-type':
        return { kind: 'only', ofType: name === 'only-of-type' }
      default:
        return null
    }
  }
  switch (name) {
    case 'nth-child':
    case 'nth-last-child':
    case 'nth-of-type':
    case 'nth-last-of-type': {
      // of S（:nth-child(2 of .a)）は読まない
      const nth = parseNth(argument)
      if (!nth) return null
      return { kind: 'nth', ...nth, last: name.includes('last'), ofType: name.endsWith('of-type') }
    }
    case 'not':
    case 'is':
    case 'matches':
    case 'where': {
      if (nested) return null
      const list: Compound[] = []
      for (const part of splitList(argument)) {
        const parsed = parseCompound(part.trim(), true)
        if (!parsed || parsed.rest.trim() !== '') return null
        if (!parsed.never) list.push(parsed.compound)
      }
      if (name === 'not') return list.length === 0 ? 'always' : { kind: 'not', list }
      if (list.length === 0) return 'never'
      // :where は詳細度を持たない。詳細度は specificityOf が kind と一緒に見るので、印として where を list の外に持てないため、ここで区別する
      return name === 'where' ? { kind: 'is', list: list.map(asWhere) } : { kind: 'is', list }
    }
    default:
      return null
  }
}

const WHERE = new WeakSet<Compound>()
function asWhere(compound: Compound): Compound {
  WHERE.add(compound)
  return compound
}

/** an+b。odd・even・n・-n+3・5 など */
function parseNth(text: string): { a: number; b: number } | null {
  const value = text.trim().toLowerCase()
  if (value === 'odd') return { a: 2, b: 1 }
  if (value === 'even') return { a: 2, b: 0 }
  const match = /^([+-]?\d*)n(?:\s*([+-])\s*(\d+))?$|^([+-]?\d+)$/.exec(value)
  if (!match) return null
  if (match[4] !== undefined) return { a: 0, b: Number(match[4]) }
  const a = match[1] === '' || match[1] === '+' ? 1 : match[1] === '-' ? -1 : Number(match[1])
  const b = match[3] === undefined ? 0 : Number(match[3]) * (match[2] === '-' ? -1 : 1)
  return Number.isFinite(a) && Number.isFinite(b) ? { a, b } : null
}

/** 詳細度。id を 10000、class・属性・疑似クラスを 100、要素名を 1 として足す（並びの数を抑えているので桁はあふれない） */
function specificityOf(compound: Compound): number {
  if (WHERE.has(compound)) return 0
  let value = (compound.id ? 10000 : 0) + (compound.classes.length + compound.attributes.length) * 100 + (compound.tag ? 1 : 0)
  for (const pseudo of compound.pseudos) {
    if (pseudo.kind === 'not' || pseudo.kind === 'is') value += Math.max(0, ...pseudo.list.map(specificityOf))
    else value += 100
  }
  return value
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

function attributeValue(element: SvgElement, name: string): string | undefined {
  if (!name.startsWith('*|')) return element.attributes[name]
  const local = name.slice(2)
  for (const [key, value] of Object.entries(element.attributes)) {
    if (key === local || key.endsWith(`:${local}`)) return value
  }
  return undefined
}

function attributeMatches(test: AttributeTest, element: SvgElement): boolean {
  let actual = attributeValue(element, test.name)
  if (actual === undefined) return false
  if (test.operator === null) return true
  let expected = test.value
  if (test.insensitive) {
    actual = actual.toLowerCase()
    expected = expected.toLowerCase()
  }
  switch (test.operator) {
    case '=':
      return actual === expected
    case '~=':
      return expected !== '' && !/\s/.test(expected) && actual.split(/\s+/).includes(expected)
    case '|=':
      return actual === expected || actual.startsWith(`${expected}-`)
    case '^=':
      return expected !== '' && actual.startsWith(expected)
    case '$=':
      return expected !== '' && actual.endsWith(expected)
    case '*=':
      return expected !== '' && actual.includes(expected)
    default:
      return false
  }
}

/** 兄弟の中の位置。親ごとに 1 回だけ数えて覚える */
function positionOf(sheet: StyleSheet, element: SvgElement, parents: ReadonlyMap<SvgElement, SvgElement>): Position {
  const cached = sheet.positions.get(element)
  if (cached) return cached
  const parent = parents.get(element)
  if (!parent) {
    const position = { index: 1, count: 1, typeIndex: 1, typeCount: 1, previous: [] }
    sheet.positions.set(element, position)
    return position
  }
  const siblings = parent.children.filter((child): child is SvgElement => typeof child !== 'string')
  const typeCounts = new Map<string, number>()
  for (const sibling of siblings) typeCounts.set(sibling.name, (typeCounts.get(sibling.name) ?? 0) + 1)
  const seen = new Map<string, number>()
  siblings.forEach((sibling, i) => {
    const typeIndex = (seen.get(sibling.name) ?? 0) + 1
    seen.set(sibling.name, typeIndex)
    // previous は兄弟の配列を共有する（i より前だけを見る）
    sheet.positions.set(sibling, { index: i + 1, count: siblings.length, typeIndex, typeCount: typeCounts.get(sibling.name)!, previous: siblings })
  })
  return sheet.positions.get(element)!
}

function nthMatches(a: number, b: number, index: number): boolean {
  if (a === 0) return index === b
  const n = (index - b) / a
  return Number.isInteger(n) && n >= 0
}

function compoundMatches(sheet: StyleSheet, compound: Compound, element: SvgElement, parents: ReadonlyMap<SvgElement, SvgElement>): boolean {
  if (compound.tag !== null && compound.tag !== element.name) return false
  if (compound.id !== null && compound.id !== element.attributes.id) return false
  if (compound.classes.length > 0) {
    const own = (element.attributes.class ?? '').split(/\s+/)
    if (!compound.classes.every((name) => own.includes(name))) return false
  }
  if (!compound.attributes.every((test) => attributeMatches(test, element))) return false
  for (const pseudo of compound.pseudos) {
    switch (pseudo.kind) {
      case 'root':
        if (parents.has(element)) return false
        break
      case 'empty':
        if (element.children.length > 0) return false
        break
      case 'link':
        if (element.name !== 'a' || attributeValue(element, '*|href') === undefined) return false
        break
      case 'nth': {
        const position = positionOf(sheet, element, parents)
        const index = pseudo.ofType
          ? pseudo.last ? position.typeCount - position.typeIndex + 1 : position.typeIndex
          : pseudo.last ? position.count - position.index + 1 : position.index
        if (!nthMatches(pseudo.a, pseudo.b, index)) return false
        break
      }
      case 'only': {
        const position = positionOf(sheet, element, parents)
        if ((pseudo.ofType ? position.typeCount : position.count) !== 1) return false
        break
      }
      case 'not':
        if (pseudo.list.some((item) => compoundMatches(sheet, item, element, parents))) return false
        break
      case 'is':
        if (!pseudo.list.some((item) => compoundMatches(sheet, item, element, parents))) return false
        break
    }
  }
  return true
}

/**
 * セレクタが要素に当たるか。右の並びから左へ、結合子に従って親や前の兄弟をたどる。
 * (並びの番号, 要素) ごとの結果を覚えるので、子孫の結合子が続いても組み合わせが膨らまない。手数が上限を超えたら当たらないものとする
 */
function selectorMatches(sheet: StyleSheet, selector: Selector, element: SvgElement, parents: ReadonlyMap<SvgElement, SvgElement>): boolean {
  const memo = new Map<SvgElement, (boolean | undefined)[]>()
  const visit = (index: number, current: SvgElement): boolean => {
    let row = memo.get(current)
    const known = row?.[index]
    if (known !== undefined) return known
    // 数えるのは結合子でたどった先の照合だけ（いちばん右の並びの照合は、結合子のないセレクタと同じく打ち切らない）
    if (index < selector.compounds.length - 1 && ++sheet.steps > MAX_STEPS) {
      sheet.exhausted = true
      return false
    }
    let result = compoundMatches(sheet, selector.compounds[index], current, parents)
    if (result && index > 0) {
      const combinator = selector.combinators[index - 1]
      result = false
      if (combinator === '>' || combinator === ' ') {
        for (let ancestor = parents.get(current); ancestor && !sheet.exhausted; ancestor = parents.get(ancestor)) {
          if (visit(index - 1, ancestor)) {
            result = true
            break
          }
          if (combinator === '>') break
        }
      } else if (parents.has(current)) {
        const position = positionOf(sheet, current, parents)
        for (let i = position.index - 2; i >= 0 && !sheet.exhausted; i--) {
          if (visit(index - 1, position.previous[i])) {
            result = true
            break
          }
          if (combinator === '+') break
        }
      }
    }
    if (!row) {
      row = []
      memo.set(current, row)
    }
    row[index] = result
    return result
  }
  if (sheet.exhausted && selector.compounds.length > 1) return false
  return visit(selector.compounds.length - 1, element)
}

/**
 * 要素に当たる CSS の宣言。詳細度の低い順・書いた順に重ねる。normal は style 属性より弱く、important は style 属性より強い
 * （呼び出し側が「属性 < normal < style 属性 < important」の順に重ねる）。parents は要素の親（子孫・兄弟の結合子と疑似クラスに使う）
 */
export function matchedDeclarations(
  sheet: StyleSheet,
  element: SvgElement,
  parents: ReadonlyMap<SvgElement, SvgElement> = new Map(),
): { normal: Record<string, string>; important: Record<string, string> } {
  const hits: { specificity: number; order: number; rule: Rule }[] = []
  for (const rule of sheet.rules) {
    let best = -1
    for (const selector of rule.selectors) {
      if (selector.specificity > best && selectorMatches(sheet, selector, element, parents)) best = selector.specificity
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
