import { describe, expect, it } from 'vitest'
import { docOf, frame, rect, sceneOf } from '../document/testNodes.ts'
import { exportTargets } from './exportPng.ts'

describe('書き出す範囲と名前（exportTargets。viewer / editor / CLI で同じ）', () => {
  const doc = docOf(
    sceneOf(
      frame({ name: 'Card', children: ['a', 'b'] }),
      rect({ id: 'a', name: 'A', parentId: 'frame' }),
      rect({ id: 'b', name: 'B', parentId: 'frame' }),
      rect({ id: 'c', name: 'C' }),
    ),
  )
  const page = doc.pages[0]

  it('選んでいなければページ全体で、ドキュメントとページの名前', () => {
    expect(exportTargets(doc, page, null)).toEqual({ targets: ['frame', 'c'], name: 'x - Page 1' })
    expect(exportTargets(doc, page, [])).toEqual({ targets: ['frame', 'c'], name: 'x - Page 1' })
  })

  it('1 つならその名前', () => {
    expect(exportTargets(doc, page, ['b'])).toEqual({ targets: ['b'], name: 'B' })
  })

  it('いくつもなら描く順に並べ、先頭の名前と残りの数', () => {
    expect(exportTargets(doc, page, ['c', 'b', 'a'])).toEqual({ targets: ['a', 'b', 'c'], name: 'A ほか 2 個' })
  })

  it('親と子を一緒に選んだら親だけにする（名前も親で数える）', () => {
    expect(exportTargets(doc, page, ['a', 'frame'])).toEqual({ targets: ['frame'], name: 'Card' })
  })
})
