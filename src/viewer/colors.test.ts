import { describe, expect, it } from 'vitest'
import { colorAlpha, formatColor } from './colors.ts'

describe('formatColor', () => {
  it('HEX は大文字か小文字で、透明度つきは rgba', () => {
    expect(formatColor('#4f46e5', 'hex', { upper: true })).toBe('#4F46E5')
    expect(formatColor('#4F46E5', 'hex')).toBe('#4f46e5')
    expect(formatColor('#000000', 'hex', { alpha: 0.5 })).toBe('rgba(0, 0, 0, 0.5)')
  })

  it('RGB と、透明度つきの RGBA', () => {
    expect(formatColor('#4f46e5', 'rgb')).toBe('rgb(79, 70, 229)')
    expect(formatColor('#4f46e5', 'rgb', { alpha: 0.25 })).toBe('rgba(79, 70, 229, 0.25)')
  })

  it('HSL は整数に丸める。無彩色は色相と彩度が 0', () => {
    expect(formatColor('#4f46e5', 'hsl')).toBe('hsl(243, 75%, 59%)')
    expect(formatColor('#ff0000', 'hsl')).toBe('hsl(0, 100%, 50%)')
    expect(formatColor('#ff00ff', 'hsl')).toBe('hsl(300, 100%, 50%)')
    expect(formatColor('#808080', 'hsl')).toBe('hsl(0, 0%, 50%)')
    expect(formatColor('#ffffff', 'hsl', { alpha: 1 })).toBe('hsla(0, 0%, 100%, 1)')
  })
})

describe('colorAlpha', () => {
  it('#rrggbb は不透明、#rrggbbaa は末尾の 2 桁が不透明度', () => {
    expect(colorAlpha('#123456')).toBe(1)
    expect(colorAlpha('#123456ff')).toBe(1)
    expect(colorAlpha('#12345680')).toBeCloseTo(0.5, 2)
    expect(colorAlpha('#12345600')).toBe(0)
  })
})
