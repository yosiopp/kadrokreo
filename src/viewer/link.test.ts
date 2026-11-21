import { describe, expect, it } from 'vitest'
import { docOf, rect, sceneOf } from '../document/testNodes.ts'
import { formatViewLink, parseViewLink, resolveViewLink } from './link.ts'

describe('formatViewLink / parseViewLink', () => {
  it('ページと選択をハッシュにして、読み戻せる', () => {
    const hash = formatViewLink({ pageId: 'p 1', selection: ['a', 'b'] })
    expect(hash).toBe('#page=p+1&select=a%2Cb')
    expect(parseViewLink(hash)).toEqual({ pageId: 'p 1', selection: ['a', 'b'] })
  })

  it('何もなければ空。壊れた値や知らない項目は無視する', () => {
    expect(formatViewLink({ pageId: null, selection: [] })).toBe('')
    expect(parseViewLink('')).toEqual({ pageId: null, selection: [] })
    expect(parseViewLink('#select=,a,,&zoom=3&page=')).toEqual({ pageId: null, selection: ['a'] })
  })
})

describe('resolveViewLink', () => {
  const doc = docOf(sceneOf(rect({ id: 'a' }), rect({ id: 'b' })))

  it('ページにあるものだけを選ぶ', () => {
    expect(resolveViewLink(doc, { pageId: 'p1', selection: ['b', 'zzz', 'b'] })).toEqual({ pageId: 'p1', selection: ['b'] })
  })

  it('ページがなければ最初のページで、選択も捨てる（別のページの id は当てにならない）', () => {
    expect(resolveViewLink(doc, { pageId: 'missing', selection: ['a'] })).toEqual({ pageId: 'p1', selection: [] })
    expect(resolveViewLink(doc, { pageId: null, selection: ['a'] })).toEqual({ pageId: 'p1', selection: ['a'] })
  })
})
