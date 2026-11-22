import { describe, expect, it } from 'vitest'
import { visibleRows } from './virtualRows.ts'

describe('visibleRows', () => {
  it('見えている行と前後の余分を作る', () => {
    expect(visibleRows(0, 100, 1000, 10, 5)).toEqual({ start: 0, end: 15 })
    expect(visibleRows(205, 300, 1000, 10, 5)).toEqual({ start: 15, end: 35 })
  })

  it('一覧が見えている範囲より下にあっても、先頭の行は作る', () => {
    expect(visibleRows(-500, -100, 1000, 10, 5)).toEqual({ start: 0, end: 5 })
  })

  it('末尾を越えない', () => {
    expect(visibleRows(9950, 10200, 1000, 10, 5)).toEqual({ start: 990, end: 1000 })
    expect(visibleRows(20000, 21000, 1000, 10, 5)).toEqual({ start: 995, end: 1000 })
    expect(visibleRows(0, 100, 3, 10, 5)).toEqual({ start: 0, end: 3 })
  })
})
