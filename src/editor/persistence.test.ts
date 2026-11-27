import { describe, expect, it } from 'vitest'
import { KDR_MIN_VERSION, KDR_VERSION } from '../document/kdr.ts'
import { canOverwrite, revisionOf, savedVersionKind } from './persistence.ts'

// IndexedDB を使う読み書きはブラウザでの確認（e2e）で見る。ここは、上書きしてよいかの判断だけ。

describe('自動保存の保存データの見分け', () => {
  it('version が読み替えて読める範囲のものだけが読める', () => {
    expect(savedVersionKind({ version: KDR_VERSION })).toBe('current')
    expect(savedVersionKind({ version: KDR_MIN_VERSION })).toBe('current')
    expect(savedVersionKind({ version: KDR_MIN_VERSION - 1 })).toBe('older')
    expect(savedVersionKind({ version: 1 })).toBe('older')
    expect(savedVersionKind({ version: KDR_VERSION + 1 })).toBe('newer')
  })

  it('version が数でないもの・レコードの形でないものは、壊れたものとして扱う', () => {
    for (const file of [{}, { version: '16' }, { version: Number.NaN }, { version: null }, null, 'x', 0]) {
      expect(savedVersionKind(file)).toBe('broken')
    }
  })

  it('印は文字列だけ。無ければ null', () => {
    expect(revisionOf({ revision: 'r1' })).toBe('r1')
    expect(revisionOf({ version: KDR_VERSION })).toBeNull()
    expect(revisionOf({ revision: 1 })).toBeNull()
    expect(revisionOf(undefined)).toBeNull()
    expect(revisionOf(null)).toBeNull()
  })
})

describe('保存先を上書きしてよいか', () => {
  const current = (revision?: string) => ({ version: KDR_VERSION, ...(revision === undefined ? {} : { revision }) })

  it('自分が最後に読んだ・書いた印のままなら書いてよい', () => {
    expect(canOverwrite(current('r1'), 'r1')).toBe(true)
  })

  it('印が変わっていたら（ほかのタブが書いていたら）書かない', () => {
    expect(canOverwrite(current('r2'), 'r1')).toBe(false)
    // 何も無い状態から始めた 2 つのタブの、あとから書くほう
    expect(canOverwrite(current('r1'), null)).toBe(false)
    // 印を書かない前の版の editor が、あとから書いた
    expect(canOverwrite(current(), 'r1')).toBe(false)
  })

  it('印の無い保存データ（前の版が保存したもの）を読んだあとは、そのまま書いてよい', () => {
    expect(canOverwrite(current(), null)).toBe(true)
  })

  it('保存先に何も無ければ（消されていれば）書いてよい', () => {
    expect(canOverwrite(undefined, null)).toBe(true)
    expect(canOverwrite(undefined, 'r1')).toBe(true)
  })

  it('version の違う保存データは、印が合っていても書かない', () => {
    expect(canOverwrite({ version: KDR_MIN_VERSION - 1 }, null)).toBe(false)
    expect(canOverwrite({ version: KDR_VERSION + 1, revision: 'r1' }, 'r1')).toBe(false)
    expect(canOverwrite({}, null)).toBe(false)
  })
})
