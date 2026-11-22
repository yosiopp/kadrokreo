import { describe, expect, it } from 'vitest'
import { DEFAULT_DASHES, evenDashes, formatDashes, parseDashes, validDashes, withDashAt } from './dashes.ts'

describe('破線の並び', () => {
  it('evenDashes は奇数個を 2 回繰り返す', () => {
    expect(evenDashes([4])).toEqual([4, 4])
    expect(evenDashes([4, 2, 1])).toEqual([4, 2, 1, 4, 2, 1])
    expect(evenDashes([4, 2])).toEqual([4, 2])
  })

  it('withDashAt は線の長さ・間隔を変える。実線からなら既定の並びに対して変え、すべて 0 なら実線', () => {
    expect(withDashAt([], 0, 10)).toEqual([10, DEFAULT_DASHES[1]])
    expect(withDashAt([4, 2], 1, 6)).toEqual([4, 6])
    expect(withDashAt([3], 1, 1)).toEqual([3, 1])
    expect(withDashAt([0, 2], 1, 0)).toEqual([])
    expect(withDashAt([4, 2], 0, -3)).toEqual([0, 2])
  })

  it('parseDashes は空白・カンマ区切りを読み、空や 0 は実線、読めなければ null', () => {
    expect(parseDashes('4, 2')).toEqual([4, 2])
    expect(parseDashes('4 2 1')).toEqual([4, 2, 1])
    expect(parseDashes('')).toEqual([])
    expect(parseDashes('none')).toEqual([])
    expect(parseDashes('0')).toEqual([])
    expect(parseDashes('4, x')).toBeNull()
    expect(parseDashes('-1')).toBeNull()
    expect(formatDashes([4, 2])).toBe('4, 2')
    expect(validDashes([Number.NaN])).toEqual([])
  })
})
