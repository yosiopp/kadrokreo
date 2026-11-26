// 依存なしの小さな XML の読み取り。要素・属性・文字・CDATA・コメント・処理命令を読み、
// 定義済みの 5 つの実体と文字参照だけを展開する（ENTITY の定義は読まないので、展開で大きくなる細工が効かない）。
// 木は作らず、読んだ順に handler を呼ぶ。入れ子の確かめ（閉じタグが合うか）と木の組み立ては使う側がする
// （SVG の取り込み svg/xml.ts と、コマンドラインのマークアップ cli/markup.ts）。

export type XmlTag = {
  /** 書かれたままの要素名（svg:rect なら svg:rect） */
  name: string
  attributes: Record<string, string>
  /** <a/> の形か。そのときは close を呼ばない */
  selfClosing: boolean
  /** 「<」の位置（文字数）。行番号は lineCounter で出す */
  offset: number
  /** 属性の名前の位置。positions を指定したときだけ */
  attributeOffsets: Record<string, number> | null
}

export type XmlHandler = {
  open(tag: XmlTag): void
  /** name は閉じタグに書かれたままの名前 */
  close(name: string, offset: number): void
  /** 要素の外・中の文字（実体は展開済み）と CDATA の中身。空のものは呼ばない */
  text(value: string, offset: number): void
}

export type XmlOptions = {
  /** 読めないときに投げるものを作る */
  fail: (message: string, offset: number) => Error
  /** 属性の位置も覚える */
  positions?: boolean
  /** 同じ名前の属性が 2 つあればエラーにする（指定しなければ後のものが勝つ） */
  strict?: boolean
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y
const NAME = /[^\s/>]+/y

export function readXml(text: string, handler: XmlHandler, options: XmlOptions): void {
  const { fail } = options
  let i = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      handler.text(decode(text.slice(i)), i)
      break
    }
    if (lt > i) handler.text(decode(text.slice(i, lt)), i)
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      if (end < 0) throw fail('コメントが閉じていません', lt)
      i = end + 3
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9)
      if (end < 0) throw fail('CDATA が閉じていません', lt)
      if (end > lt + 9) handler.text(text.slice(lt + 9, end), lt + 9)
      i = end + 3
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2)
      if (end < 0) throw fail('処理命令が閉じていません', lt)
      i = end + 2
    } else if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2)
      if (end < 0) throw fail('宣言が閉じていません', lt)
      i = end + 1
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt + 2)
      if (end < 0) throw fail('閉じタグが閉じていません', lt)
      handler.close(text.slice(lt + 2, end).trim(), lt)
      i = end + 1
    } else {
      NAME.lastIndex = lt + 1
      const found = NAME.exec(text)
      if (!found) throw fail('要素の名前がありません', lt)
      const name = found[0]
      let j = NAME.lastIndex
      const attributes: Record<string, string> = {}
      const attributeOffsets: Record<string, number> | null = options.positions ? {} : null
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++
        if (text[j] === '>' || text.startsWith('/>', j)) break
        ATTRIBUTE.lastIndex = j
        const attribute = ATTRIBUTE.exec(text)
        if (!attribute) throw fail(`属性が読めません: <${name}>`, j < text.length ? j : lt)
        if (options.strict && Object.hasOwn(attributes, attribute[1])) throw fail(`属性が重複しています: ${attribute[1]}`, j)
        attributes[attribute[1]] = decode(attribute[2] ?? attribute[3])
        if (attributeOffsets) attributeOffsets[attribute[1]] = j
        j = ATTRIBUTE.lastIndex
      }
      const selfClosing = text.startsWith('/>', j)
      i = j + (selfClosing ? 2 : 1)
      handler.open({ name, attributes, selfClosing, offset: lt, attributeOffsets })
    }
  }
}

/** 文字の位置（offset）から、1 から数えた行番号を出す関数を作る */
export function lineCounter(text: string): (offset: number) => number {
  const starts = [0]
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (starts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }
}
