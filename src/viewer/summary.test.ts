import { describe, expect, it } from 'vitest'
import type { LineNode } from '../document/types.ts'
import { inspectPage, summarizePage } from './summary.ts'
import { base, frame, rect, sceneOf, text } from '../document/testNodes.ts'

describe('summarizePage', () => {
  it('塗りと線の色を、使われている数の多い順に数える', () => {
    const scene = sceneOf(
      rect({ id: 'a', fill: '#FF0000' }),
      rect({ id: 'b', fill: '#ff0000', stroke: '#0000ff', strokeWidth: 2 }),
      rect({ id: 'c', fill: null, stroke: '#00ff00', strokeWidth: 1 }),
      text({ id: 't', fill: '#0000ff' }),
    )
    expect(summarizePage(scene).colors).toEqual([
      { color: '#0000ff', count: 2, nodes: ['b', 't'] },
      { color: '#ff0000', count: 2, nodes: ['a', 'b'] },
      { color: '#00ff00', count: 1, nodes: ['c'] },
    ])
  })

  it('グラデーションは各色を数え、隠れている塗りの色は数えない。太さ 0 の線も数えない', () => {
    const gradient = { angle: 0, stops: [{ offset: 0, color: '#111111' }, { offset: 1, color: '#222222' }] }
    const scene = sceneOf(rect({ fill: '#ff0000', fillGradient: gradient, stroke: '#333333', strokeWidth: 0 }))
    expect(summarizePage(scene).colors.map((use) => use.color)).toEqual(['#111111', '#222222'])
  })

  it('直線の色を数える。画像には色がない', () => {
    const line: LineNode = {
      ...base,
      id: 'line',
      type: 'line',
      stroke: '#abcdef',
      strokeWidth: 2,
      direction: 'down',
      flipped: false,
      startCap: 'none',
      endCap: 'none',
    }
    const image = { ...base, id: 'image', type: 'image', assetId: 'a1', cornerRadius: 0, fit: 'cover' } as const
    expect(summarizePage(sceneOf(line, image)).colors).toEqual([{ color: '#abcdef', count: 1, nodes: ['line'] }])
  })

  it('塗りと線に同じ色を使ったノードは、2 か所と数えるが、ノードは 1 つ', () => {
    const scene = sceneOf(rect({ fill: '#123456', stroke: '#123456', strokeWidth: 1 }))
    expect(summarizePage(scene).colors).toEqual([{ color: '#123456', count: 2, nodes: ['rect'] }])
  })

  it('非表示のものと、その中身は数えない', () => {
    const scene = sceneOf(
      frame({ fill: '#ffffff', visible: false, children: ['rect'] }),
      rect({ parentId: 'frame' }),
      text({ visible: false }),
    )
    expect(summarizePage(scene)).toEqual({ colors: [], textStyles: [], shadows: [] })
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
    const shadow = { x: 0, y: 2, blur: 4, color: '#000000', opacity: 0.25 }
    const scene = sceneOf(
      rect({ id: 'a', fill: null, shadow }),
      rect({ id: 'b', fill: null, shadow: { ...shadow } }),
      rect({ id: 'c', fill: null, shadow: { ...shadow, blur: 16 } }),
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
    const rem = inspectPage(scene, { unit: 'rem', remBase: 16, color: 'hsl' })
    expect(rem[0].rows[0].value).toBe('0 0.125rem 0.25rem hsla(0, 0%, 0%, 0.25)')
  })

  it('何もなければ、見出しも出さない', () => {
    expect(inspectPage(sceneOf())).toEqual([])
  })
})
