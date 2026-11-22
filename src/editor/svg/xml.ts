// SVG の文字列を、変換に使う小さな木（SvgElement）にする。
// ブラウザ（editor）では DOMParser で解析し（parseSvgDom）、DOMParser のない Node（CLI と単体テスト）では
// 自前の小さな XML の読み取り（parseSvgXml）を使う。どちらも同じ形の木を返し、変換（convert.ts）はこの木だけを読む。
// 解析した結果を DOM に挿入したり表示したりはしない。スクリプトや foreignObject の中身は木に写さない（変換で落としたと知らせるため、要素の名前だけ残す）。
// style の中身（CSS）は文字として写し、変換が単純なセレクタだけを読む。

export type SvgNode = SvgElement | string

export type SvgElement = {
  /** 名前空間の接頭辞を除いた要素名（svg:rect なら rect） */
  name: string
  /** 属性はそのままの名前で持つ（xlink:href など） */
  attributes: Record<string, string>
  /** 子要素と文字 */
  children: SvgNode[]
}

export class SvgParseError extends Error {
  override name = 'SvgParseError'
}

/** 取り込める SVG の大きさ（文字数）。要素の数も抑える */
export const MAX_SVG_LENGTH = 16 * 1024 * 1024
const MAX_ELEMENTS = 100_000
const MAX_DEPTH = 256

/** 中身を写さない要素。変換では「読み飛ばした」と知らせる */
const OPAQUE = new Set(['script', 'foreignObject'])

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
  let count = 0
  let i = 0
  const current = () => stack[stack.length - 1]
  const pushText = (value: string) => {
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
        if (opaque === 0) stack.pop()
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
        if (!selfClosing) opaque++
        continue
      }
      if (++count > MAX_ELEMENTS) throw new SvgParseError('SVG の要素が多すぎます')
      if (stack.length > MAX_DEPTH) throw new SvgParseError('SVG の入れ子が深すぎます')
      if (stack.length === 1 && top.children.length > 0) throw new SvgParseError('最上位の要素が 2 つあります')
      const element: SvgElement = { name: localName(rawName), attributes, children: [] }
      current().children.push(element)
      if (!selfClosing) {
        stack.push(element)
        if (OPAQUE.has(element.name)) opaque = 1
      }
    }
  }
  if (stack.length > 1) throw new SvgParseError(`閉じていない要素があります: ${current().name}`)
  const root = top.children.find((child): child is SvgElement => typeof child !== 'string')
  if (!root || root.name !== 'svg') throw new SvgParseError('svg 要素がありません')
  return root
}
