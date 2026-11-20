import { describe, expect, it } from 'vitest'
import { wrapLine } from './text.ts'

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
})
