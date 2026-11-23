import { describe, expect, it } from 'vitest'
import { solid } from '../document/paint.ts'
import type { PathNode } from '../document/types.ts'
import { inspectPage, summarizePage, visiblePaints } from './summary.ts'
import { base, frame, rect, sceneOf, text } from '../document/testNodes.ts'

describe('summarizePage', () => {
  it('塗りと線の色を、使われている数の多い順に数える', () => {
    const scene = sceneOf(
      rect({ id: 'a', fills: solid('#FF0000') }),
      rect({ id: 'b', fills: solid('#ff0000'), strokes: solid('#0000ff'), strokeWidth: 2 }),
      rect({ id: 'c', fills: [], strokes: solid('#00ff00'), strokeWidth: 1 }),
      text({ id: 't', fills: solid('#0000ff') }),
    )
    expect(summarizePage(scene).colors).toEqual([
      { color: '#0000ff', count: 2, nodes: ['b', 't'] },
      { color: '#ff0000', count: 2, nodes: ['a', 'b'] },
      { color: '#00ff00', count: 1, nodes: ['c'] },
    ])
  })

  it('グラデーションは各色を数える。太さ 0 の線は数えない', () => {
    const gradient = { type: 'linear' as const, x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#111111' }, { offset: 1, color: '#222222' }], opacity: 1, visible: true, blendMode: 'normal' as const }
    const scene = sceneOf(rect({ fills: [gradient], strokes: solid('#333333'), strokeWidth: 0 }))
    expect(summarizePage(scene).colors.map((use) => use.color)).toEqual(['#111111', '#222222'])
  })

  it('直線の色を数える。画像には色がない', () => {
    const line: PathNode = {
      ...base,
      id: 'line',
      type: 'path',
      fills: [],
      strokes: solid('#abcdef'),
      strokeWidth: 2,
      strokeDashes: [],
      strokeDashOffset: 0,
      strokeJoin: 'miter',
      effects: [],
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      closed: false,
      startCap: 'none',
      endCap: 'none',
      capSize: 0,
      contours: [],
      fillRule: 'nonzero',
      isMask: false,
      maskType: 'vector',
    }
    const image = { ...base, id: 'image', type: 'image', effects: [] as never[], assetId: 'a1', cornerRadius: 0, fit: 'cover', positionX: 0.5, positionY: 0.5, scale: 1 } as const
    expect(summarizePage(sceneOf(line, image)).colors).toEqual([{ color: '#abcdef', count: 1, nodes: ['line'] }])
  })

  it('塗りと線に同じ色を使ったノードは、2 か所と数えるが、ノードは 1 つ', () => {
    const scene = sceneOf(rect({ fills: solid('#123456'), strokes: solid('#123456'), strokeWidth: 1 }))
    expect(summarizePage(scene).colors).toEqual([{ color: '#123456', count: 2, nodes: ['rect'] }])
  })

  it('非表示のものと、その中身は数えない', () => {
    const scene = sceneOf(
      frame({ fills: solid('#ffffff'), visible: false, children: ['rect'] }),
      rect({ parentId: 'frame' }),
      text({ visible: false }),
    )
    expect(summarizePage(scene)).toEqual({ colors: [], textStyles: [], shadows: [] })
  })

  it('不透明な塗りの下に重ねて隠れた色は数えない。線とテキストも同じ', () => {
    const gradient = { type: 'linear' as const, x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#111111' }, { offset: 1, color: '#222222' }], opacity: 1, visible: true, blendMode: 'normal' as const }
    const scene = sceneOf(
      // 塗りは下から順。いちばん上の #ff0000 が全体を覆う
      rect({ id: 'a', fills: [...solid('#00ff00'), gradient, ...solid('#ff0000')], strokes: [...solid('#0000ff'), ...solid('#000000')], strokeWidth: 1 }),
      // いちばん上がグラデーションでも、どの色も不透明なら下を隠す
      rect({ id: 'b', fills: [...solid('#00ff00'), gradient] }),
      text({ id: 't', fills: [...solid('#00ff00'), ...solid('#333333')] }),
    )
    expect(summarizePage(scene).colors).toEqual([
      { color: '#000000', count: 1, nodes: ['a'] },
      { color: '#111111', count: 1, nodes: ['b'] },
      { color: '#222222', count: 1, nodes: ['b'] },
      { color: '#333333', count: 1, nodes: ['t'] },
      { color: '#ff0000', count: 1, nodes: ['a'] },
    ])
  })

  it('半透明のノードは塗りを 1 枚ずつ透かして描くので、下の色も数える。中身のあるフレームは 1 枚にまとめて透かすので数えない', () => {
    const scene = sceneOf(
      rect({ id: 'r', opacity: 0.5, fills: [...solid('#00ff00'), ...solid('#ff0000')] }),
      frame({ id: 'f', opacity: 0.5, fills: [...solid('#0000ff'), ...solid('#ffffff')], children: ['child'] }),
      rect({ id: 'child', parentId: 'f', fills: solid('#ffffff') }),
      frame({ id: 'empty', opacity: 0.5, fills: [...solid('#abcdef'), ...solid('#ffffff')] }),
      // 不透明度 0 は描かれないので数えない
      rect({ id: 'z', opacity: 0, fills: solid('#999999') }),
    )
    expect(summarizePage(scene).colors).toEqual([
      { color: '#ffffff', count: 3, nodes: ['f', 'child', 'empty'] },
      { color: '#00ff00', count: 1, nodes: ['r'] },
      { color: '#abcdef', count: 1, nodes: ['empty'] },
      { color: '#ff0000', count: 1, nodes: ['r'] },
    ])
  })

  it('上の塗りが半透明（#rrggbbaa、グラデーションの止めに半透明）なら、その下も見える', () => {
    const fade = { type: 'linear' as const, x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#00000080' }], opacity: 1, visible: true, blendMode: 'normal' as const }
    expect(visiblePaints([...solid('#111111'), ...solid('#222222'), ...solid('#33333380')])).toEqual([...solid('#222222'), ...solid('#33333380')])
    expect(visiblePaints([...solid('#111111'), fade])).toEqual([...solid('#111111'), fade])
    expect(visiblePaints([...solid('#11111180'), ...solid('#22222280')])).toHaveLength(2)
    expect(visiblePaints([...solid('#111111'), ...solid('#222222')], true)).toHaveLength(2)
    expect(visiblePaints([])).toEqual([])
  })

  it('塗りごとの不透明度が 1 未満の塗りは、下を隠さない', () => {
    const half = { type: 'solid' as const, color: '#333333', opacity: 0.5, visible: true, blendMode: 'normal' as const }
    expect(visiblePaints([...solid('#111111'), ...solid('#222222'), half])).toEqual([...solid('#222222'), half])
    const fade = { type: 'linear' as const, x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], opacity: 0.9, visible: true, blendMode: 'normal' as const }
    expect(visiblePaints([...solid('#111111'), fade])).toHaveLength(2)
  })

  it('隠した塗りは数えず、下の塗りを隠さない。隠した影も数えない', () => {
    const hidden = { type: 'solid' as const, color: '#333333', opacity: 1, visible: false, blendMode: 'normal' as const }
    expect(visiblePaints([...solid('#111111'), hidden])).toEqual(solid('#111111'))
    const shadow = { type: 'drop-shadow' as const, x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25, visible: false, spread: 0 , blendMode: 'normal' as const}
    const summary = summarizePage(sceneOf(rect({ fills: [...solid('#111111'), hidden], effects: [shadow] })))
    expect(summary.colors.map((use) => use.color)).toEqual(['#111111'])
    expect(summary.shadows).toEqual([])
  })

  it('文字の設定は、同じものをまとめて大きい順に並べる', () => {
    const scene = sceneOf(
      text({ id: 'a', fontSize: 14 }),
      text({ id: 'b', fontSize: 14, text: '別の文言' }),
      text({ id: 'c', fontSize: 32, fontWeight: 700, lineHeight: 1.2 }),
      text({ id: 'd', fontSize: 14, fontWeight: 700 }),
    )
    expect(summarizePage(scene).textStyles).toEqual([
      { fontFamily: 'sans-serif', fontSize: 32, fontWeight: 700, lineHeight: 1.2, count: 1, nodes: ['c'] },
      { fontFamily: 'sans-serif', fontSize: 14, fontWeight: 700, lineHeight: 1.5, count: 1, nodes: ['d'] },
      { fontFamily: 'sans-serif', fontSize: 14, fontWeight: 400, lineHeight: 1.5, count: 2, nodes: ['a', 'b'] },
    ])
  })
})

describe('inspectPage', () => {
  it('色は大文字の 16 進数、文字は CSS の font の形で出す', () => {
    const scene = sceneOf(rect(), text({ fontSize: 14, fontWeight: 700 }))
    expect(inspectPage(scene)).toEqual([
      {
        title: 'このページの色',
        rows: [
          { label: '1 か所', value: '#111111', color: '#111111', nodes: ['text'] },
          { label: '1 か所', value: '#FF0000', color: '#ff0000', nodes: ['rect'] },
        ],
      },
      { title: 'このページの文字', rows: [{ label: '1 か所', value: '700 14px/1.5 sans-serif', nodes: ['text'] }] },
    ])
  })

  it('影は、同じものをまとめて CSS の値で出す。単位と色の書き方に従う', () => {
    const shadow = { type: 'drop-shadow' as const, x: 0, y: 2, blur: 4, color: '#000000', opacity: 0.25, visible: true, spread: 0 , blendMode: 'normal' as const}
    const scene = sceneOf(
      rect({ id: 'a', fills: [], effects: [shadow] }),
      rect({ id: 'b', fills: [], effects: [{ ...shadow }] }),
      rect({ id: 'c', fills: [], effects: [{ ...shadow, blur: 16 }] }),
    )
    expect(inspectPage(scene)).toEqual([
      {
        title: 'このページの影',
        rows: [
          { label: '2 か所', value: '0 2px 4px rgba(0, 0, 0, 0.25)', color: '#000000', nodes: ['a', 'b'] },
          { label: '1 か所', value: '0 2px 16px rgba(0, 0, 0, 0.25)', color: '#000000', nodes: ['c'] },
        ],
      },
    ])
    const rem = inspectPage(scene, { unit: 'rem', remBase: 16, color: 'hsl', format: 'html' })
    expect(rem[0].rows[0].value).toBe('0 0.125rem 0.25rem hsla(0, 0%, 0%, 0.25)')
  })

  it('何もなければ、見出しも出さない', () => {
    expect(inspectPage(sceneOf())).toEqual([])
  })
})
