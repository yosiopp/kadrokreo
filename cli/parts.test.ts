import { describe, expect, it } from 'vitest'
import { createRect, createText } from '../src/editor/nodes.ts'
import { UsageError, parseArgs } from './args.ts'
import { readImageInfo } from './image.ts'
import { estimateTextSize, estimateTextWidth } from './textMeasure.ts'
import { buildPatch, parseValue } from './values.ts'

const noFlags = () => ({ flags: new Set<string>(), assignments: false })

describe('parseArgs', () => {
  it('+ で区切り、グローバルなオプションはどこにあってもよい', () => {
    const { global, steps } = parseArgs(
      ['-f', 'in.kdr', 'add', 'rect', '--x', '10', '--closed', 'fill=#fff', '+', 'ls', '-o', 'out.kdr'],
      (name) => ({ flags: new Set(name === 'add' ? ['closed'] : []), assignments: name === 'add' }),
    )
    expect(global).toMatchObject({ file: 'in.kdr', out: 'out.kdr', write: false })
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ name: 'add', positionals: ['rect'], assignments: [['fill', '#fff']] })
    expect([...steps[0].options]).toEqual([['x', '10'], ['closed', true]])
    expect(steps[1].name).toBe('ls')
  })

  it('--名前=値 の形と、= を含む位置引数', () => {
    const { steps } = parseArgs(['find', 'a=b c', '--text=x=y'], noFlags)
    expect(steps[0].options.get('text')).toBe('x=y')
    expect(steps[0].positionals).toEqual(['a=b c'])
  })

  it('空のコマンドや値のないオプションはエラー', () => {
    expect(() => parseArgs(['ls', '+'], noFlags)).toThrow(UsageError)
    expect(() => parseArgs(['add', 'rect', '--x'], noFlags)).toThrow(/--x の値/)
    expect(() => parseArgs(['-o'], noFlags)).toThrow(UsageError)
  })
})

describe('values', () => {
  it('いまの値の型に合わせて読む', () => {
    expect(parseValue('12', 0, 'x')).toBe(12)
    expect(parseValue('true', false, 'visible')).toBe(true)
    expect(parseValue('123', 'abc', 'text')).toBe('123')
    expect(parseValue('null', '#fff', 'fill')).toBeNull()
    expect(parseValue('{"a":1}', null, 'shadow')).toEqual({ a: 1 })
    expect(() => parseValue('x', 0, 'x')).toThrow(/数値/)
    expect(() => parseValue('yes', true, 'visible')).toThrow(/true か false/)
  })

  it('入れ子の項目と、塗り・線・影の略記', () => {
    const rect = createRect({ x: 0, y: 0, width: 10, height: 10 })
    expect(buildPatch(rect, [['shadow.blur', '4'], ['sizing.width', 'fill']])).toEqual({
      effects: [{ type: 'drop-shadow', x: 0, y: 4, blur: 4, color: '#000000', opacity: 0.25 }],
      sizing: { width: 'fill', height: 'fixed' },
    })
    expect(buildPatch(rect, [['fill', '#ff0000'], ['stroke', 'null']])).toEqual({
      fills: [{ type: 'solid', color: '#ff0000' }],
      strokes: [],
    })
    expect(buildPatch(rect, [['fills.0.color', '#00ff00']])).toEqual({ fills: [{ type: 'solid', color: '#00ff00' }] })
    expect(() => buildPatch(rect, [['text', 'a']])).toThrow(/rect には text がありません/)
    expect(() => buildPatch(rect, [['id', 'a']])).toThrow(/変えられません/)
    expect(() => buildPatch(rect, [['shadow.nope', '1']])).toThrow(/nope/)
  })
})

describe('readImageInfo', () => {
  it('PNG・GIF・JPEG の大きさ', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 0, 2])
    expect(readImageInfo(png)).toEqual({ mime: 'image/png', width: 256, height: 2 })
    const gif = new Uint8Array([...new TextEncoder().encode('GIF89a'), 3, 0, 5, 0])
    expect(readImageInfo(gif)).toEqual({ mime: 'image/gif', width: 3, height: 5 })
    // SOI, APP0（長さ 4）, SOF0
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 7, 0, 9, 3, 0, 0])
    expect(readImageInfo(jpeg)).toEqual({ mime: 'image/jpeg', width: 9, height: 7 })
    expect(readImageInfo(new TextEncoder().encode('<svg></svg>'))).toBeNull()
  })
})

describe('estimateTextSize', () => {
  it('全角は 1 文字 1em、複数行は行数ぶんの高さ', () => {
    const text = { ...createText({ x: 0, y: 0, width: 0, height: 0 }, 'あい\nう'), fontSize: 10 }
    expect(estimateTextSize(text)).toEqual({ width: 20, height: 24 })
  })

  it('英数字は sans-serif の字幅の表で見積もる（ブラウザで測った値とほぼ同じ）', () => {
    // Chrome（macOS）で測ると 91.30 と 316.60
    expect(estimateTextWidth('Hello, World!', 16, 400)).toBeCloseTo(91.3, 0)
    expect(estimateTextWidth('The quick brown fox jumps over the lazy dog', 16, 400)).toBeCloseTo(316.6, 0)
    expect(estimateTextWidth('abc', 10, 400, 'monospace')).toBeCloseTo(18)
  })
})
