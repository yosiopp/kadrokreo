import { describe, expect, it } from 'vitest'
import { type TextStyle, breakUnits, layoutText, measureText, wrapLine } from './text.ts'

// 半角は幅 1、全角は幅 2 として数える
const measure = (text: string) =>
  [...text].reduce((width, char) => width + (char.charCodeAt(0) > 0xff ? 2 : 1), 0)

describe('wrapLine', () => {
  it('収まるなら 1 行のまま', () => {
    expect(wrapLine('hello world', 11, measure)).toEqual(['hello world'])
    expect(wrapLine('', 10, measure)).toEqual([''])
  })

  it('英単語は語の区切りで折り返し、行末の空白は前の行に残す', () => {
    expect(wrapLine('the quick brown fox', 10, measure)).toEqual(['the quick ', 'brown fox'])
    expect(wrapLine('aaa bbb ccc', 3, measure)).toEqual(['aaa ', 'bbb ', 'ccc'])
  })

  it('行末の空白だけでは折り返さない', () => {
    expect(wrapLine('abcde     ', 5, measure)).toEqual(['abcde     '])
  })

  it('かな・漢字はどこでも折り返せる', () => {
    expect(wrapLine('あいうえおかきく', 6, measure)).toEqual(['あいう', 'えおか', 'きく'])
  })

  it('和文と英単語が混ざっていても、英単語の途中では切らない', () => {
    expect(wrapLine('これはtestです', 8, measure)).toEqual(['これは', 'testです'])
  })

  it('幅に収まらない 1 語は途中で切る', () => {
    expect(wrapLine('abcdefghij', 4, measure)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapLine('ab cdefghij', 4, measure)).toEqual(['ab ', 'cdef', 'ghij'])
  })

  it('幅が極端に狭くても 1 文字ずつは置く', () => {
    expect(wrapLine('abc', 0, measure)).toEqual(['a', 'b', 'c'])
  })

  it('禁則処理: 句読点・閉じ括弧・小書きのかなを行頭に置かず、前の文字ごと次の行へ追い出す', () => {
    expect(wrapLine('あいう。えお', 6, measure)).toEqual(['あい', 'う。え', 'お'])
    expect(wrapLine('あいう」。え', 6, measure)).toEqual(['あい', 'う」。', 'え'])
    expect(wrapLine('あいっぱい', 4, measure)).toEqual(['あ', 'いっ', 'ぱい'])
    expect(wrapLine('あいうー', 6, measure)).toEqual(['あい', 'うー'])
  })

  it('禁則処理: 開き括弧を行末に置かず、次の文字と一緒に次の行へ送る', () => {
    expect(wrapLine('あい「うえ」', 6, measure)).toEqual(['あい', '「う', 'え」'])
    expect(wrapLine('あい（う', 6, measure)).toEqual(['あい', '（う'])
  })

  it('禁則の単位でも幅に収まらなければ途中で切る', () => {
    expect(wrapLine('「あ」', 2, measure)).toEqual(['「', 'あ', '」'])
  })
})

describe('wrapLine の幅の見積もり', () => {
  // 境目の詰め: "AV" が隣り合うと 0.3 狭くなる（足し算の見積もりと実際の幅がずれる）
  const kerned = (text: string) => measure(text) - 0.3 * (text.match(/AV/g)?.length ?? 0)
  // 毎回行全体を測る、もとの書き方
  function naive(text: string, maxWidth: number, m: (text: string) => number): string[] {
    const lines: string[] = []
    let line = ''
    for (const token of breakUnits(text)) {
      if (token.trim() === '' || m(line + token) <= maxWidth) line += token
      else if (line.trim() !== '' && m(token) <= maxWidth) {
        lines.push(line)
        line = token
      } else {
        if (line.trim() !== '') {
          lines.push(line)
          line = ''
        }
        for (const char of token) {
          if (line !== '' && m(line + char) > maxWidth) {
            lines.push(line)
            line = ''
          }
          line += char
        }
      }
    }
    lines.push(line)
    return lines
  }

  it('詰めでずれても、余裕を取れば毎回測り直すのと同じ結果になる', () => {
    const text = 'A VA V AVAVAV xA Vx あAVい AV AAAAVVVV VAVAVA A V'.repeat(5)
    for (let maxWidth = 1; maxWidth < 40; maxWidth += 0.5) {
      expect(wrapLine(text, maxWidth, kerned, 2)).toEqual(naive(text, maxWidth, kerned))
    }
  })

  it('長い段落でも測る文字数は段落の長さに比例する', () => {
    let measured = 0
    const counting = (text: string) => {
      measured += text.length
      return measure(text)
    }
    const words = Array.from({ length: 20000 }, (_, i) => `w${i % 97}`).join(' ')
    const lines = wrapLine(words, 100000, counting, 2)
    expect(lines).toHaveLength(1)
    expect(measured).toBeLessThan(words.length * 4)
    measured = 0
    const kana = 'あ'.repeat(20000)
    expect(wrapLine(kana, 100000, counting, 2)).toEqual([kana])
    expect(measured).toBeLessThan(kana.length * 4)
  })
})

describe('breakUnits', () => {
  it('禁則に当たる区切りだけをつなぐ', () => {
    expect(breakUnits('「これは、test」です。')).toEqual(['「こ', 'れ', 'は、', 'test」', 'で', 'す。'])
    expect(breakUnits('a 。b')).toEqual(['a', ' ', '。', 'b'])
  })
})

describe('measureText（中身に合わせる幅の上限）', () => {
  // 1 文字の幅を 10 として測るだけの、描画しない context
  const ctx = { font: '', measureText: (text: string) => ({ width: text.length * 10 }) } as unknown as CanvasRenderingContext2D
  const style = (patch: Partial<TextStyle> = {}): TextStyle => ({
    text: 'aaa bbb ccc',
    fontSize: 10,
    fontFamily: 'sans-serif',
    fontWeight: 400,
    lineHeight: 1,
    sizing: { width: 'hug', height: 'hug' },
    width: 0,
    minWidth: null,
    maxWidth: null,
    minHeight: null,
    maxHeight: null,
    ...patch,
  })

  it('上限がなければ折り返さない', () => {
    expect(measureText(ctx, style())).toEqual({ width: 110, height: 10 })
  })

  it('上限を超えたら上限で折り返し、幅は折り返した行のいちばん長いもの', () => {
    expect(layoutText(ctx, style({ maxWidth: 80 })).map((line) => line.text)).toEqual(['aaa bbb ', 'ccc'])
    expect(measureText(ctx, style({ maxWidth: 80 }))).toEqual({ width: 70, height: 20 })
    // 収まっていれば、上限があってもそのまま
    expect(measureText(ctx, style({ maxWidth: 200 }))).toEqual({ width: 110, height: 10 })
  })

  it('下限より狭ければ下限まで広げる。上限より長い 1 語ははみ出し、幅は上限のまま', () => {
    expect(measureText(ctx, style({ text: 'ab', minWidth: 50 }))).toEqual({ width: 50, height: 10 })
    expect(measureText(ctx, style({ text: 'abcdefgh', maxWidth: 40 })).width).toBe(40)
  })
})

describe('measureText（高さの下限・上限）', () => {
  const ctx = { font: '', measureText: (text: string) => ({ width: text.length * 10 }) } as unknown as CanvasRenderingContext2D
  const style = (patch: Partial<TextStyle> = {}): TextStyle => ({
    text: 'a\nb\nc',
    fontSize: 10,
    fontFamily: 'sans-serif',
    fontWeight: 400,
    lineHeight: 1,
    sizing: { width: 'hug', height: 'hug' },
    width: 0,
    minWidth: null,
    maxWidth: null,
    minHeight: null,
    maxHeight: null,
    ...patch,
  })

  it('中身の高さを下限まで広げ、上限まで縮める（行は枠の外へはみ出す）', () => {
    expect(measureText(ctx, style()).height).toBe(30)
    expect(measureText(ctx, style({ minHeight: 45 })).height).toBe(45)
    expect(measureText(ctx, style({ maxHeight: 20 })).height).toBe(20)
    expect(layoutText(ctx, style({ maxHeight: 20 }))).toHaveLength(3)
  })

  it('下限と上限が食い違えば下限を優先する', () => {
    expect(measureText(ctx, style({ minHeight: 50, maxHeight: 20 })).height).toBe(50)
  })
})

describe('layoutText（中身で覚える）', () => {
  it('別のノードでも、文字・書体・折り返す幅が同じなら測り直さない', () => {
    let calls = 0
    const ctx = { font: '', measureText: (text: string) => (calls++, { width: text.length * 10 }) } as unknown as CanvasRenderingContext2D
    const style = (patch: Partial<TextStyle> = {}): TextStyle => ({
      text: 'shared layout',
      fontSize: 13,
      fontFamily: 'sans-serif',
      fontWeight: 400,
      lineHeight: 1,
      sizing: { width: 'fixed', height: 'hug' },
      width: 70,
      minWidth: null,
      maxWidth: null,
      minHeight: null,
      maxHeight: null,
      ...patch,
    })
    const first = layoutText(ctx, style())
    const measured = calls
    expect(layoutText(ctx, style({ lineHeight: 2 }))).toBe(first)
    expect(calls).toBe(measured)
    // 折り返す幅が違えば測り直す
    expect(layoutText(ctx, style({ width: 200 })).map((line) => line.text)).toEqual(['shared layout'])
    expect(calls).toBeGreaterThan(measured)
  })
})
