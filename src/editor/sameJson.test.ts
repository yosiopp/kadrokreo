import { describe, expect, it } from 'vitest'
import { sameJson } from './components.ts'

// 同期が写しを比べるときの sameJson は、JSON.stringify で比べたときと同じ答えを出す（文字列を作らないだけ）

const values: unknown[] = [
  undefined,
  null,
  0,
  -0,
  1,
  1.5,
  NaN,
  Infinity,
  -Infinity,
  '',
  '0',
  'a',
  'null',
  true,
  false,
  [],
  [undefined],
  [null],
  [NaN],
  [1, 2],
  [2, 1],
  [[1], { a: 1 }],
  {},
  { a: undefined },
  { a: 1 },
  { a: 1, b: undefined },
  { b: undefined, a: 1 },
  { a: 1, b: 2 },
  { b: 2, a: 1 },
  { a: [1, { c: null }] },
  { a: [1, { c: NaN }] },
  { a: [1, { c: undefined }] },
  { a: [1, {}] },
  { a: () => 1 },
  { type: 'solid', color: '#ffffff', opacity: 1, visible: true, blendMode: 'normal' },
  { type: 'solid', color: '#fffffe', opacity: 1, visible: true, blendMode: 'normal' },
]

describe('sameJson', () => {
  it('どの組み合わせでも JSON.stringify で比べたときと同じ答え', () => {
    for (const a of values) {
      for (const b of values) {
        expect(sameJson(a, b), `${JSON.stringify(a)} と ${JSON.stringify(b)}`).toBe(JSON.stringify(a) === JSON.stringify(b))
      }
    }
  })
})
