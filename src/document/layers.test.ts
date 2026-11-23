import { describe, expect, it } from 'vitest'
import { type Folding, isOpen, layerOrder, layerRows, paintOrder, toggleFolding } from './layers.ts'
import { frame, rect, sceneOf } from './testNodes.ts'

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
  heightMode: 'hug', wrap: false, crossGap: 0, alignContent: 'auto',
} as const

// ページ直下に back, card, button（インスタンス）。card の中に a と row。row（自動で並べる）の中に x, y
const scene = sceneOf(
  rect({ id: 'back' }),
  frame({ id: 'card', children: ['a', 'row'] }),
  rect({ id: 'a', parentId: 'card' }),
  frame({ id: 'row', parentId: 'card', children: ['x', 'y'], layout }),
  rect({ id: 'x', parentId: 'row' }),
  rect({ id: 'y', parentId: 'row' }),
  frame({ id: 'button', children: ['label'], component: { id: 'c1', role: 'instance', overrides: {}, flipX: false, flipY: false } }),
  rect({ id: 'label', parentId: 'button' }),
)
const folding = (toggled: string[] = [], held: string[] = []): Folding => ({
  toggled: new Set(toggled),
  held: new Set(held),
})
const ids = (rows: ReturnType<typeof layerRows>) => rows.map((row) => `${row.depth}:${row.node.id}`)

describe('layerOrder', () => {
  it('手前にあるものほど先に並べる', () => {
    expect(layerOrder(scene, null)).toEqual(['button', 'card', 'back'])
    expect(layerOrder(scene, 'card')).toEqual(['row', 'a'])
  })

  it('自動で並べるフレームの中は、並び順のまま', () => {
    expect(layerOrder(scene, 'row')).toEqual(['x', 'y'])
  })

  it('フレームでなければ、子はない', () => {
    expect(layerOrder(scene, 'a')).toEqual([])
  })
})

describe('layerRows', () => {
  it('ふつうのフレームは開いた状態、インスタンスは閉じた状態から始まる', () => {
    expect(ids(layerRows(scene, folding()))).toEqual(['0:button', '0:card', '1:row', '2:x', '2:y', '1:a', '0:back'])
  })

  it('切り替えたものは、その逆になる', () => {
    const rows = layerRows(scene, folding(['button', 'row']))
    expect(ids(rows)).toEqual(['0:button', '1:label', '0:card', '1:row', '1:a', '0:back'])
  })

  it('held に入っているものは、閉じてあっても開く', () => {
    expect(ids(layerRows(scene, folding(['card'], ['card'])))).toContain('1:row')
    expect(isOpen(scene.nodes.button, folding([], ['button']))).toBe(true)
  })

  it('インスタンスの中身には、写しの印が付く', () => {
    const rows = layerRows(scene, folding(['button']))
    expect(rows.filter((row) => row.copy).map((row) => row.node.id)).toEqual(['label'])
  })
})

describe('toggleFolding', () => {
  it('入っていなければ足し、入っていれば外す。元の集合は変えない', () => {
    const before = new Set(['a'])
    expect([...toggleFolding(before, 'b')]).toEqual(['a', 'b'])
    expect([...toggleFolding(before, 'a')]).toEqual([])
    expect([...before]).toEqual(['a'])
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
