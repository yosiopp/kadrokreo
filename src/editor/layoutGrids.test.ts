import { describe, expect, it } from 'vitest'
import { createFrame } from './nodes.ts'
import { createPage } from './operations/document.ts'
import { insertNode, updateNode } from './operations/tree.ts'
import { frameGridLines, gridBands, gridSteps, layoutGridSnapLines } from './layoutGrids.ts'

describe('レイアウトグリッド', () => {
  it('カラムは余白の内側に溝を挟んで均等に並ぶ', () => {
    // 幅 400、余白 20、溝 20、3 本 → 帯は (400 - 40 - 40) / 3
    const bands = gridBands({ type: 'columns', count: 3, gutter: 20, margin: 20 }, 400)
    expect(bands.map((band) => band.start)).toEqual([20, 20 + 320 / 3 + 20, 20 + (320 / 3 + 20) * 2])
    expect(bands[0].size).toBeCloseTo(320 / 3)
    // 詰まりすぎて帯の幅が 0 以下なら空
    expect(gridBands({ type: 'columns', count: 10, gutter: 50, margin: 0 }, 400)).toEqual([])
  })

  it('方眼の線は 0 から端まで（本数は上限まで）', () => {
    expect(gridSteps(100, 250)).toEqual([0, 100, 200])
    expect(gridSteps(100, 300)).toEqual([0, 100, 200, 300])
    // 範囲を渡すと、その中のものだけ（大きなフレームの細かい方眼でも、先のほうまで届く）
    expect(gridSteps(8, 12000, 11990, 12000)).toEqual([11992, 12000])
    expect(gridSteps(100, 300, -50, 120)).toEqual([0, 100])
    // 細工したファイルでも本数は上限まで
    expect(gridSteps(1, 1_000_000)).toHaveLength(2000)
  })

  it('吸着の線は、動かしているものの近くの方眼だけ（ページ座標の範囲をフレームの座標に直して）', () => {
    const frame = { ...createFrame({ x: 100, y: 0, width: 1440, height: 12000 }), layoutGrids: [{ type: 'grid' as const, size: 8 }] }
    const page = insertNode(createPage(), frame)
    const lines = layoutGridSnapLines(page, frame.id, { x: 100 + 500, y: 11000, width: 20, height: 20 })
    expect(lines.filter((line) => line.axis === 'x').map((line) => line.position)).toEqual([604, 612, 620])
    expect(lines.filter((line) => line.axis === 'y').map((line) => line.position)).toEqual([11000, 11008, 11016])
  })

  it('吸着の線は帯の両端と方眼の線（フレームの座標）', () => {
    const lines = frameGridLines({ width: 200, height: 100, layoutGrids: [{ type: 'columns', count: 2, gutter: 20, margin: 10 }, { type: 'grid', size: 50 }] })
    expect(lines.filter((line) => line.axis === 'x').map((line) => line.position)).toEqual([10, 90, 110, 190, 0, 50, 100, 150, 200])
    expect(lines.filter((line) => line.axis === 'y').map((line) => line.position)).toEqual([0, 50, 100])
    expect(lines[0]).toEqual({ axis: 'x', position: 10, from: 0, to: 100 })
  })

  it('ページ座標の線にする。回っていないフレームは位置をずらし、90° なら縦横を入れ替え、斜めなら空', () => {
    const frame = { ...createFrame({ x: 100, y: 50, width: 200, height: 100 }), layoutGrids: [{ type: 'rows' as const, count: 1, gutter: 0, margin: 10 }] }
    let page = insertNode(createPage(), frame)
    expect(layoutGridSnapLines(page, frame.id)).toEqual([
      { axis: 'y', position: 60, from: 100, to: 300 },
      { axis: 'y', position: 140, from: 100, to: 300 },
    ])
    page = updateNode(page, frame.id, { rotation: 90 })
    const turned = layoutGridSnapLines(page, frame.id)
    expect(turned.every((line) => line.axis === 'x')).toBe(true)
    page = updateNode(page, frame.id, { rotation: 30 })
    expect(layoutGridSnapLines(page, frame.id)).toEqual([])
    expect(layoutGridSnapLines(page, null)).toEqual([])
  })
})
