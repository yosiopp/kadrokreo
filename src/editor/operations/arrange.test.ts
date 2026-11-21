import { describe, expect, it } from 'vitest'
import type { FrameNode } from '../../document/types.ts'
import { createFrame, createRect } from '../nodes.ts'
import { alignNodes, distributeNodes, placeNodes, reorderNodes } from './arrange.ts'
import { createPage } from './document.ts'
import { insertNode } from './tree.ts'

const bounds = { x: 0, y: 0, width: 100, height: 100 }

function fixture() {
  const frame = createFrame({ x: 100, y: 50, width: 400, height: 300 })
  const inner = createFrame({ x: 20, y: 10, width: 200, height: 100 })
  const rect = createRect({ x: 5, y: 5, width: 10, height: 10 })
  const loose = createRect({ ...bounds, x: 900 })
  let doc = createPage()
  doc = insertNode(doc, frame)
  doc = insertNode(doc, inner, frame.id)
  doc = insertNode(doc, rect, inner.id)
  doc = insertNode(doc, loose)
  return { doc, frame, inner, rect, loose }
}

describe('placeNodes', () => {
  function flat() {
    const nodes = ['a', 'b', 'c', 'd'].map((name) => ({ ...createRect(bounds), name }))
    const doc = nodes.reduce((next, node) => insertNode(next, node), createPage())
    const names = (d: typeof doc) => d.rootIds.map((id) => d.nodes[id].name).join('')
    return { doc, ids: nodes.map((node) => node.id), names }
  }

  it('複数ノードを互いの順序を保ったまま target の手前・奥へ移す', () => {
    const { doc, ids, names } = flat()
    const [a, b, c, d] = ids
    expect(names(placeNodes(doc, [a, b], d, 'above'))).toBe('cdab')
    expect(names(placeNodes(doc, [b, a], d, 'below'))).toBe('cabd')
    expect(names(placeNodes(doc, [c, d], a, 'below'))).toBe('cdab')
    expect(names(placeNodes(doc, [d], b, 'above'))).toBe('abdc')
  })

  it('フレームの中へ入れる', () => {
    const { doc, frame, inner, loose } = fixture()
    const next = placeNodes(doc, [loose.id], frame.id, 'inside')
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([inner.id, loose.id])
  })

  it('自分自身や子孫を基準にした移動、フレーム以外の中への移動は何もしない', () => {
    const { doc, frame, inner, rect, loose } = fixture()
    expect(placeNodes(doc, [frame.id], inner.id, 'inside')).toBe(doc)
    expect(placeNodes(doc, [frame.id], rect.id, 'above')).toBe(doc)
    expect(placeNodes(doc, [rect.id], loose.id, 'inside')).toBe(doc)
  })

  it('重なり順を 1 つずつ、または端まで動かす', () => {
    const { doc, ids, names } = flat()
    const [a, b, c, d] = ids
    expect(names(reorderNodes(doc, [a, c], 'front'))).toBe('bdac')
    expect(names(reorderNodes(doc, [b, d], 'back'))).toBe('bdac')
    expect(names(reorderNodes(doc, [a, b], 'forward'))).toBe('cabd')
    expect(names(reorderNodes(doc, [c, d], 'forward'))).toBe('abcd')
    expect(names(reorderNodes(doc, [b], 'backward'))).toBe('bacd')
    expect(reorderNodes(doc, [a], 'backward')).toBe(doc)
  })
})

describe('alignNodes', () => {
  function three() {
    const nodes = [
      createRect({ x: 0, y: 0, width: 20, height: 20 }),
      createRect({ x: 50, y: 30, width: 40, height: 10 }),
      createRect({ x: 200, y: 80, width: 100, height: 20 }),
    ]
    const doc = nodes.reduce((next, node) => insertNode(next, node), createPage())
    const ids = nodes.map((node) => node.id)
    const xs = (d: typeof doc) => ids.map((id) => d.nodes[id].x)
    const ys = (d: typeof doc) => ids.map((id) => d.nodes[id].y)
    return { doc, ids, xs, ys }
  }

  it('複数選択は選択範囲に揃える', () => {
    const { doc, ids, xs, ys } = three()
    expect(xs(alignNodes(doc, ids, 'left'))).toEqual([0, 0, 0])
    expect(xs(alignNodes(doc, ids, 'right'))).toEqual([280, 260, 200])
    expect(xs(alignNodes(doc, ids, 'center'))).toEqual([140, 130, 100])
    expect(ys(alignNodes(doc, ids, 'top'))).toEqual([0, 0, 0])
    expect(ys(alignNodes(doc, ids, 'bottom'))).toEqual([80, 90, 80])
    expect(ys(alignNodes(doc, ids, 'middle'))).toEqual([40, 45, 40])
  })

  it('1 つだけなら親フレームに揃え、ページ直下では何もしない', () => {
    const { doc, frame, inner, loose } = fixture()
    expect(alignNodes(doc, [inner.id], 'right').nodes[inner.id]).toMatchObject({ x: 200, y: 10 })
    expect(alignNodes(doc, [inner.id], 'middle').nodes[inner.id]).toMatchObject({ x: 20, y: 100 })
    expect(alignNodes(doc, [loose.id], 'left')).toBe(doc)
    expect(alignNodes(doc, [frame.id], 'left')).toBe(doc)
  })

  it('等間隔に並べる', () => {
    const { doc, ids, xs, ys } = three()
    // 幅 20 + 40 + 100、全体 300 なので間隔は 70
    expect(xs(distributeNodes(doc, ids, 'x'))).toEqual([0, 90, 200])
    expect(ys(distributeNodes(doc, ids, 'y'))).toEqual([0, 45, 80])
    expect(distributeNodes(doc, ids.slice(0, 2), 'x')).toBe(doc)
  })
})
