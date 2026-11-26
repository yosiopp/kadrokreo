import type { TextNode } from './types.ts'

// テキストの行分けの、書体の測り方によらない部分（折り返す幅・中身に合わせる大きさ・禁則処理・折り返し）。
// 描画（canvas/text.ts、Canvas で測る）と、アウトライン化・ブーリアン演算の文字の並び（textOutline.ts、書体ファイルの送り幅で測る）が共有する。

/**
 * 折り返す幅。幅を決めているなら width、中身に合わせる（hug）なら上限の maxWidth（なければ折り返さないので null）。
 * 中身に合わせていても、上限を超える行は上限で折り返す（CSS の width: max-content と max-width の組み合わせと同じ）
 */
export function wrapWidth(style: Pick<TextNode, 'sizing' | 'width' | 'maxWidth'>): number | null {
  return style.sizing.width === 'hug' ? style.maxWidth : style.width
}

/** 中身に合わせる幅を、下限・上限に収める。上限より長い 1 語ははみ出す（CSS と同じく幅は上限のまま） */
export function hugWidth(style: Pick<TextNode, 'minWidth' | 'maxWidth'>, content: number): number {
  return Math.max(style.minWidth ?? 0, Math.min(style.maxWidth ?? Infinity, content))
}

/**
 * 中身で決まる高さを、下限・上限に収める。上限より多い行は枠の外へはみ出して描く（CSS の max-height と overflow: visible と同じ）。
 * 下限と上限が食い違えば下限を優先する
 */
export function hugHeight(style: Pick<TextNode, 'minHeight' | 'maxHeight'>, content: number): number {
  return Math.max(style.minHeight ?? 0, Math.min(style.maxHeight ?? Infinity, content))
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** 文字のまとまり（書記素。結合文字や絵文字の並びを分けない）。字間はこの単位ごとに足し、線に沿う文字はこの単位で置く */
export function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text)
}

/** 文字のまとまりの数。ASCII の印字できる文字だけなら数えるだけ（行分けで何度も呼ぶので、分けずに済ませる） */
export function graphemeCount(text: string): number {
  return /^[\x20-\x7e]*$/.test(text) ? text.length : graphemes(text).length
}

/**
 * 字間（letterSpacing）を含めて測る関数。文字のまとまりごとに、その後ろへ字間を足す（CSS の letter-spacing と同じく最後の文字の後ろにも）。
 * まとまりの数は足し算になるので、行分け（wrapLine）の幅の見積もりもそのまま使える
 */
export function spacedMeasure(measure: (text: string) => number, letterSpacing: number): (text: string) => number {
  return letterSpacing === 0 ? measure : (text) => measure(text) + letterSpacing * graphemeCount(text)
}

/** 文字の装飾の線の位置と太さ。offset は基線から線の中心までの下向きの距離（取り消し線は負）、thickness は線の太さ（px） */
export type DecorationLine = { offset: number; thickness: number }

/** 下線の中心の、基線から下への距離（文字の大きさに対する割合。よく使う書体の下線の位置のおおよそ） */
const UNDERLINE_OFFSET = 0.11
/** 取り消し線の中心の、基線から上への距離（文字の大きさに対する割合。欧文の小文字の真ん中くらい） */
const LINE_THROUGH_OFFSET = 0.28
/** 線の太さ（文字の大きさに対する割合）。細くても 1px は引く */
const DECORATION_THICKNESS = 0.06

/**
 * 装飾の線（描画・文字のアウトライン化が同じ値を使う）。装飾がなければ null。
 * 位置と太さは書体によらず文字の大きさから決める（書体の下線の情報は、Canvas からも OS の書体からも読めないため）
 */
export function decorationLine(node: Pick<TextNode, 'fontSize' | 'textDecoration'>): DecorationLine | null {
  if (node.textDecoration === 'none') return null
  const thickness = Math.max(1, node.fontSize * DECORATION_THICKNESS)
  const offset = node.fontSize * (node.textDecoration === 'underline' ? UNDERLINE_OFFSET : -LINE_THROUGH_OFFSET)
  return { offset, thickness }
}

// 空白の並び / 途中で切らない語（英単語など）/ どこでも切れる 1 文字（かな・漢字・全角記号など）
const TOKENS = /\s+|[^\s　-ヿ㐀-鿿豈-﫿＀-￯]+|./gsu

// 禁則処理: 行頭に来てはいけない文字（閉じ括弧・句読点・小書きのかな・長音など）と、行末に来てはいけない文字（開き括弧など）
const NO_LINE_START = new Set([...'、。，．,.:;?!！？：；・…‥ー〜～)]}）］｝〕〉》」』】〙〗〟’”»ゝゞヽヾ々〻ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ゠–'])
const NO_LINE_END = new Set([...'([{（［｛〔〈《「『【〘〖〝‘“«'])

const firstChar = (text: string) => String.fromCodePoint(text.codePointAt(0)!)
function lastChar(text: string): string {
  const low = text.charCodeAt(text.length - 1)
  return low >= 0xdc00 && low <= 0xdfff && text.length >= 2 ? text.slice(-2) : text.slice(-1)
}

/**
 * 折り返してよい単位に分ける。TOKENS の区切りのうち、禁則に当たるもの（行頭禁則の文字の前・行末禁則の文字の後）では切らず、
 * 前後の単位とつなげる（「う。」「「あ」が 1 つの単位になる）。収まらないときは、つないだ単位ごと次の行へ追い出す
 */
export function breakUnits(text: string): string[] {
  const units: string[] = []
  for (const token of text.match(TOKENS) ?? []) {
    const prev = units[units.length - 1]
    // つないだ単位は長くなりうるので、[...prev] で全部を分けずに端の 1 文字だけを見る（分けると長さの 2 乗かかる）
    const joins = prev !== undefined && prev.trim() !== '' && token.trim() !== ''
      && (NO_LINE_START.has(firstChar(token)) || NO_LINE_END.has(lastChar(prev)))
    if (joins) units[units.length - 1] = prev + token
    else units.push(token)
  }
  return units
}

/**
 * 1 段落を maxWidth に収まる行に分ける。CSS の折り返しに合わせて、
 * 行末の空白ははみ出してよく、1 語が幅に収まらないときだけ語の途中で切る。禁則処理は breakUnits。
 *
 * 行の幅は、足した単位の幅の足し算で見積もる（行全体を測り直すと、行の長さの 2 乗かかる）。
 * 足し算は単位の境目の詰め（カーニング）の分だけ実際の幅とずれうるので、見積もりが maxWidth の前後 slack 以内に入ったときだけ
 * 行全体を測り直して決め、見積もりもその値に合わせる。slack を詰めのずれより大きく取っておけば、毎回測り直すのと同じ結果になる
 */
export function wrapLine(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
  slack = 0,
): string[] {
  const lines: string[] = []
  let line = ''
  let width = 0

  // line に next（幅 nextWidth）を足して収まるなら足した後の幅、収まらなければ null
  const fitsWith = (next: string, nextWidth: number): number | null => {
    const estimate = width + nextWidth
    if (estimate <= maxWidth - slack) return estimate
    if (estimate > maxWidth + slack) return null
    const exact = measure(line + next)
    return exact <= maxWidth ? exact : null
  }
  const push = () => {
    lines.push(line)
    line = ''
    width = 0
  }

  for (const token of breakUnits(text)) {
    const tokenWidth = measure(token)
    if (token.trim() === '') {
      line += token
      width += tokenWidth
      continue
    }
    const joined = fitsWith(token, tokenWidth)
    if (joined !== null) {
      line += token
      width = joined
      continue
    }
    if (line.trim() !== '') {
      push()
      if (tokenWidth <= maxWidth) {
        line = token
        width = tokenWidth
        continue
      }
    }
    for (const char of token) {
      const charWidth = measure(char)
      if (line !== '') {
        const next = fitsWith(char, charWidth)
        if (next === null) push()
        else {
          line += char
          width = next
          continue
        }
      }
      line += char
      width += charWidth
    }
  }

  lines.push(line)
  return lines
}
