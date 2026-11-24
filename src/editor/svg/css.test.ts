import { describe, expect, it } from 'vitest'
import { parseDeclarations, parseStyle } from './css.ts'

describe('宣言の読み方', () => {
  it('style 属性は !important を外し、同じ名前は後のものを使う', () => {
    expect(parseStyle('Fill: red !important; fill: blue; stroke:  ; :x; opacity: .5')).toEqual({ fill: 'blue', opacity: '.5' })
    expect(parseStyle(undefined)).toEqual({})
  })

  it('! と important の間の空白も読む（スタイルシートと同じ）', () => {
    expect(parseStyle('fill: red ! important')).toEqual({ fill: 'red' })
    expect(parseDeclarations('fill: red ! important; stroke: blue')).toEqual({ declarations: { stroke: 'blue' }, important: { fill: 'red' } })
  })
})
