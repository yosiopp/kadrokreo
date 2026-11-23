// SVG の文字列を、変換に使う小さな木（SvgElement）にする。
// ブラウザ（editor）では DOMParser で解析し（parseSvgDom）、DOMParser のない Node（CLI と単体テスト）では
// 自前の小さな XML の読み取り（parseSvgXml）を使う。どちらも同じ形の木を返し、変換（convert.ts）はこの木だけを読む。
// 解析した結果を DOM に挿入したり表示したりはしない。スクリプトや foreignObject の中身は木に写さない（変換で落としたと知らせるため、要素の名前だけ残す）。
// foreignObject は、中の要素の style 属性から backdrop-filter と conic-gradient の背景の値だけを文字として拾う
// （背景のぼかしや角度のグラデーションを書き出したツールがこの形を使う）。HTML は解釈しない。
// style の中身（CSS）は文字として写し、変換が単純なセレクタだけを読む。

export type SvgNode = SvgElement | string

export type SvgElement = {
  /** 名前空間の接頭辞を除いた要素名（svg:rect なら rect） */
  name: string
  /** 属性はそのままの名前で持つ（xlink:href など） */
  attributes: Record<string, string>
  /** 子要素と文字 */
  children: SvgNode[]
  /** foreignObject だけ: 中身から拾ったもの（中身そのものは写さない） */
  foreign?: ForeignContent
}

/**
 * foreignObject の中身から拾うもの。backdropFilter は中の要素の style 属性にあった backdrop-filter の値（最初の 1 つ）、
 * conic は background / background-image にあった conic-gradient(…) の値（最初の 1 つ）、conicOpacity はその要素の opacity の値、
 * other は backdrop-filter・conic-gradient だけの空の要素のほかに中身（文字や、ほかの宣言を持つ要素）があったか
 */
export type ForeignContent = { backdropFilter: string | null; conic: string | null; conicOpacity: string | null; other: boolean }

/** foreignObject の拾い物の初めの値 */
export function emptyForeign(): ForeignContent {
  return { backdropFilter: null, conic: null, conicOpacity: null, other: false }
}

export class SvgParseError extends Error {
  override name = 'SvgParseError'
}

/** 取り込める SVG の大きさ（文字数）。要素の数も抑える */
export const MAX_SVG_LENGTH = 16 * 1024 * 1024
const MAX_ELEMENTS = 100_000
const MAX_DEPTH = 256
/** foreignObject の中で style 属性を見る要素の数（超えた分は見ずに「ほかの中身がある」とする） */
const MAX_FOREIGN_ELEMENTS = 64

/** 中身を写さない要素。変換では「読み飛ばした」と知らせる */
const OPAQUE = new Set(['script', 'foreignObject'])

/** style 属性の中で、背景のぼかしの書き出しに使われる宣言（大きさと切り取りは foreignObject 側で決まる） */
const BACKDROP_SIDE = /^(?:width|height|clip-path|-webkit-clip-path)$/

/** 拾う conic-gradient の値の長さ（超えたものは拾わずに「ほかの中身がある」とする） */
const MAX_CONIC_LENGTH = 4000

/** foreignObject の中の要素 1 つの style 属性を見て、拾ったものを content に足す */
function readForeignStyle(content: ForeignContent, style: string | undefined): void {
  const declarations: [string, string][] = []
  let conic: string | null = null
  for (const declaration of (style ?? '').slice(0, 10_000).split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) {
      if (declaration.trim() !== '') content.other = true
      continue
    }
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).trim()
    declarations.push([property, value])
    if ((property === 'background' || property === 'background-image') && /^conic-gradient\(/i.test(value) && value.length <= MAX_CONIC_LENGTH) {
      conic ??= value
    }
  }
  for (const [property, value] of declarations) {
    if (property === 'backdrop-filter' || property === '-webkit-backdrop-filter') {
      if (content.backdropFilter === null) content.backdropFilter = value.slice(0, 200)
    } else if (conic !== null && (property === 'background' || property === 'background-image')) {
      // 同じ要素の背景が conic-gradient のほかにもあれば、重なり方が読めないので「ほかの中身」とする
      if (value !== conic) content.other = true
    } else if (conic !== null && property === 'opacity') {
      content.conicOpacity = value.slice(0, 50)
    } else if (!BACKDROP_SIDE.test(property)) content.other = true
  }
  if (conic !== null) {
    if (content.conic === null) content.conic = conic
    else content.other = true
  }
}

/**
 * 解析の前に確かめる。DOCTYPE の内部サブセット（ENTITY の定義）は、展開で大きくなる細工（billion laughs）や
 * 外部の実体の参照に使えるので、受け付けない
 */
function checkSource(source: string): void {
  if (source.length > MAX_SVG_LENGTH) throw new SvgParseError('SVG が大きすぎます（16MB まで）')
  if (/<!DOCTYPE[^>]*\[/i.test(source) || /<!ENTITY/i.test(source)) {
    throw new SvgParseError('ENTITY を定義している SVG は取り込めません')
  }
}

function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

// ── ブラウザ: DOMParser ──

/** DOMParser で解析する（ブラウザ専用）。image/svg+xml で解析した文書はスクリプトを動かさず、画面にも入れない */
export function parseSvgDom(source: string): SvgElement {
  checkSource(source)
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml')
  if (doc.getElementsByTagName('parsererror').length > 0) throw new SvgParseError('SVG として読めません')
  const root = doc.documentElement
  if (!root || root.localName !== 'svg') throw new SvgParseError('svg 要素がありません')
  let count = 0
  const walk = (element: Element, depth: number): SvgElement => {
    if (++count > MAX_ELEMENTS) throw new SvgParseError('SVG の要素が多すぎます')
    if (depth > MAX_DEPTH) throw new SvgParseError('SVG の入れ子が深すぎます')
    const attributes: Record<string, string> = {}
    for (const attribute of element.attributes) attributes[attribute.name] = attribute.value
    const result: SvgElement = { name: element.localName, attributes, children: [] }
    if (element.localName === 'foreignObject') {
      // 中身は木に写さず、style 属性と文字だけを見る（解析した文書の中を読むだけで、画面の DOM には入れない）
      const content = emptyForeign()
      const inner = element.getElementsByTagName('*')
      if (inner.length > MAX_FOREIGN_ELEMENTS) content.other = true
      for (let k = 0; k < Math.min(inner.length, MAX_FOREIGN_ELEMENTS); k++) readForeignStyle(content, inner[k].getAttribute('style') ?? undefined)
      if ((element.textContent ?? '').trim() !== '') content.other = true
      result.foreign = content
    }
    if (OPAQUE.has(element.localName)) return result
    for (const child of element.childNodes) {
      if (child.nodeType === 1) result.children.push(walk(child as Element, depth + 1))
      else if (child.nodeType === 3 || child.nodeType === 4) result.children.push(child.nodeValue ?? '')
    }
    return result
  }
  return walk(root, 0)
}

// ── Node: 自前の小さな XML の読み取り ──

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y

/**
 * DOMParser のない環境用の、SVG に要る分だけの XML の読み取り。要素・属性・文字・CDATA・コメント・処理命令を読み、
 * 定義済みの 5 つの実体と文字参照だけを展開する。閉じタグの食い違いはエラーにする
 */
export function parseSvgXml(source: string): SvgElement {
  checkSource(source)
  const text = source.replace(/^﻿/, '')
  const top: SvgElement = { name: '#document', attributes: {}, children: [] }
  const stack: SvgElement[] = [top]
  // 中身を写さない要素の中にいる間の深さ（0 なら写す）
  let opaque = 0
  // 今いる foreignObject の拾い物と、中で見た要素の数
  let foreign: ForeignContent | null = null
  let foreignElements = 0
  let count = 0
  let i = 0
  const current = () => stack[stack.length - 1]
  const pushText = (value: string) => {
    if (opaque > 0 && foreign && value.trim() !== '') foreign.other = true
    if (opaque === 0 && stack.length > 1 && value !== '') current().children.push(value)
  }

  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      pushText(decode(text.slice(i)))
      break
    }
    if (lt > i) pushText(decode(text.slice(i, lt)))
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      if (end < 0) throw new SvgParseError('コメントが閉じていません')
      i = end + 3
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9)
      if (end < 0) throw new SvgParseError('CDATA が閉じていません')
      pushText(text.slice(lt + 9, end))
      i = end + 3
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2)
      if (end < 0) throw new SvgParseError('処理命令が閉じていません')
      i = end + 2
    } else if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2)
      if (end < 0) throw new SvgParseError('宣言が閉じていません')
      i = end + 1
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt + 2)
      if (end < 0) throw new SvgParseError('閉じタグが閉じていません')
      const name = text.slice(lt + 2, end).trim()
      if (stack.length <= 1 || (opaque === 0 && current().name !== localName(name))) {
        throw new SvgParseError(`閉じタグが合いません: ${name}`)
      }
      if (opaque > 0) {
        opaque--
        if (opaque === 0) {
          stack.pop()
          foreign = null
        }
      } else stack.pop()
      i = end + 1
    } else {
      const nameMatch = /[^\s/>]+/y
      nameMatch.lastIndex = lt + 1
      const found = nameMatch.exec(text)
      if (!found) throw new SvgParseError('要素の名前がありません')
      const rawName = found[0]
      let j = nameMatch.lastIndex
      const attributes: Record<string, string> = {}
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++
        if (text[j] === '>' || text.startsWith('/>', j)) break
        ATTRIBUTE.lastIndex = j
        const attribute = ATTRIBUTE.exec(text)
        if (!attribute) throw new SvgParseError(`属性が読めません: <${rawName}>`)
        attributes[attribute[1]] = decode(attribute[2] ?? attribute[3])
        j = ATTRIBUTE.lastIndex
      }
      const selfClosing = text.startsWith('/>', j)
      i = j + (selfClosing ? 2 : 1)
      if (opaque > 0) {
        if (foreign) {
          if (++foreignElements > MAX_FOREIGN_ELEMENTS) foreign.other = true
          else readForeignStyle(foreign, attributes.style)
        }
        if (!selfClosing) opaque++
        continue
      }
      if (++count > MAX_ELEMENTS) throw new SvgParseError('SVG の要素が多すぎます')
      if (stack.length > MAX_DEPTH) throw new SvgParseError('SVG の入れ子が深すぎます')
      if (stack.length === 1 && top.children.length > 0) throw new SvgParseError('最上位の要素が 2 つあります')
      const element: SvgElement = { name: localName(rawName), attributes, children: [] }
      if (element.name === 'foreignObject') element.foreign = emptyForeign()
      current().children.push(element)
      if (!selfClosing) {
        stack.push(element)
        if (OPAQUE.has(element.name)) {
          opaque = 1
          foreign = element.foreign ?? null
          foreignElements = 0
        }
      }
    }
  }
  if (stack.length > 1) throw new SvgParseError(`閉じていない要素があります: ${current().name}`)
  const root = top.children.find((child): child is SvgElement => typeof child !== 'string')
  if (!root || root.name !== 'svg') throw new SvgParseError('svg 要素がありません')
  return root
}
