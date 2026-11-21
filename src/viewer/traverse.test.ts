import { describe, expect, it } from 'vitest'
import { frame, rect, sceneOf, text } from '../document/testNodes.ts'
import { paintOrder, searchLayers, stepFrom } from './traverse.ts'

const layout = {
  direction: 'horizontal',
  gap: 0,
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  align: 'start',
  justify: 'start',
  widthMode: 'hug',
  heightMode: 'hug', wrap: false, crossGap: 0,
} as const

// ページ直下に card と back。card の中に a, b, row。row（自動で並べる）の中に x, y
const scene = sceneOf(
  rect({ id: 'back', name: 'Background' }),
  frame({ id: 'card', name: 'Card', children: ['a', 'b', 'row'] }),
  rect({ id: 'a', name: 'Icon', parentId: 'card' }),
  text({ id: 'b', name: 'Text 1', parentId: 'card', text: '保存する' }),
  frame({ id: 'row', name: 'Row', parentId: 'card', children: ['x', 'y'], layout }),
  rect({ id: 'x', name: 'First', parentId: 'row' }),
  rect({ id: 'y', name: 'Second', parentId: 'row' }),
)

describe('stepFrom', () => {
  it('親へ進む。ページ直下なら進めない', () => {
    expect(stepFrom(scene, 'x', 'parent')).toBe('row')
    expect(stepFrom(scene, 'card', 'parent')).toBeNull()
  })

  it('子へ進むと、一覧でいちばん上の子になる', () => {
    expect(stepFrom(scene, 'card', 'child')).toBe('row')
    expect(stepFrom(scene, 'row', 'child')).toBe('x')
    expect(stepFrom(scene, 'a', 'child')).toBeNull()
  })

  it('きょうだいへは一覧の順に進み、端では反対の端へ回る', () => {
    expect(stepFrom(scene, 'row', 'next')).toBe('b')
    expect(stepFrom(scene, 'a', 'next')).toBe('row')
    expect(stepFrom(scene, 'row', 'previous')).toBe('a')
    expect(stepFrom(scene, 'card', 'next')).toBe('back')
  })

  it('きょうだいがいなければ進めない', () => {
    const alone = sceneOf(frame({ children: ['rect'] }), rect({ parentId: 'frame' }))
    expect(stepFrom(alone, 'rect', 'next')).toBeNull()
    expect(stepFrom(alone, 'missing', 'next')).toBeNull()
  })
})

describe('searchLayers', () => {
  it('名前に含むものを、一覧の順に集める。大文字と小文字は区別しない', () => {
    expect(searchLayers(scene, 'r')).toEqual(['card', 'row', 'x', 'back'])
    expect(searchLayers(scene, 'SECOND')).toEqual(['y'])
  })

  it('テキストは内容でも見つかる', () => {
    expect(searchLayers(scene, '保存')).toEqual(['b'])
  })

  it('見つからなければ空', () => {
    expect(searchLayers(scene, 'zzz')).toEqual([])
  })
})

describe('paintOrder', () => {
  it('奥から手前の順に並べ、選んだものの中にあるものは除く', () => {
    const scene = sceneOf(
      frame({ children: ['a', 'b'] }),
      rect({ id: 'a', parentId: 'frame' }),
      rect({ id: 'b', parentId: 'frame' }),
      rect({ id: 'c' }),
    )
    expect(paintOrder(scene, ['c', 'b', 'a'])).toEqual(['a', 'b', 'c'])
    expect(paintOrder(scene, ['a', 'frame', 'c'])).toEqual(['frame', 'c'])
  })
})
