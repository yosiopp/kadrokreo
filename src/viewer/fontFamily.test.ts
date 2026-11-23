import { describe, expect, it } from 'vitest'
import { cssFontFamily } from './fontFamily.ts'

describe('cssFontFamily', () => {
  it('総称名はそのまま、ほかの書体名は引用符で囲む', () => {
    expect(cssFontFamily('sans-serif')).toBe('sans-serif')
    expect(cssFontFamily('Serif')).toBe('serif')
    expect(cssFontFamily('Inter')).toBe('"Inter"')
    expect(cssFontFamily('Noto Sans JP, sans-serif')).toBe('"Noto Sans JP", sans-serif')
    expect(cssFontFamily('ヒラギノ角ゴ ProN')).toBe('"ヒラギノ角ゴ ProN"')
  })

  it('すでに囲んである書体名は囲み直す', () => {
    expect(cssFontFamily(`"Noto Sans JP", 'Helvetica Neue', monospace`)).toBe('"Noto Sans JP", "Helvetica Neue", monospace')
  })

  it('引用符・\\・改行・区切りの記号はエスケープして、引用符の外に出さない', () => {
    expect(cssFontFamily('a"b')).toBe('"a\\22 b"')
    expect(cssFontFamily("Rock 'n' Roll")).toBe('"Rock \\27 n\\27  Roll"')
    expect(cssFontFamily('a\\b')).toBe('"a\\5c b"')
    expect(cssFontFamily('a\nb')).toBe('"a\\a b"')
    expect(cssFontFamily('a;b{c}d(e)<f>')).toBe('"a\\3b b\\7b c\\7d d\\28 e\\29 \\3c f\\3e "')
    // 値の中に、引用符の外へ出る " ; { } < が残らない
    for (const name of ['x"; } y { z', "x'; y 'z", 'x</y>', 'x\u2028y']) {
      const value = cssFontFamily(name)
      expect(value.slice(1, -1)).not.toMatch(/["';{}<>\n\u2028]/)
    }
  })

  it('空の書体名は空の文字列にする', () => {
    expect(cssFontFamily('')).toBe('""')
    expect(cssFontFamily(' , ')).toBe('""')
  })
})
