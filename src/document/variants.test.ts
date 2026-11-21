import { describe, expect, it } from 'vitest'
import { frame, rect, sceneOf } from './testNodes.ts'
import type { MainNode } from './component.ts'
import {
  formatVariantName,
  isComponentPart,
  isVariantSet,
  parseVariantName,
  pickVariant,
  variantProperties,
  variantSetOf,
  variantsIn,
} from './variants.ts'

const main = (id: string, name: string, componentId = id) =>
  frame({ id, name, parentId: 'set', component: { id: componentId, role: 'main' } }) as MainNode

/** まとまり set の中に、サイズ（小・大）× 状態（標準・押下）のうち 3 つと、ふつうの長方形 */
function fixture() {
  const variants = [
    main('a', 'サイズ=小, 状態=標準'),
    main('b', 'サイズ=大, 状態=標準'),
    main('c', 'サイズ=大, 状態=押下'),
  ]
  const other = rect({ id: 'r', parentId: 'set' })
  const set = frame({ id: 'set', name: 'ボタン', children: ['a', 'b', 'c', 'r'] })
  return { scene: sceneOf(set, ...variants, other), variants }
}

describe('バリアントの名前', () => {
  it('「プロパティ=値」をカンマでつないだ形を読む', () => {
    expect(parseVariantName('サイズ=大, 状態 = 押下')).toEqual([
      ['サイズ', '大'],
      ['状態', '押下'],
    ])
    expect(parseVariantName('ボタン')).toBeNull()
    expect(parseVariantName('サイズ=')).toBeNull()
    expect(parseVariantName('=大')).toBeNull()
    expect(parseVariantName('サイズ=大, サイズ=小')).toBeNull()
    expect(formatVariantName([['サイズ', '大'], ['状態', '押下']])).toBe('サイズ=大, 状態=押下')
  })
})

describe('バリアントのまとまり', () => {
  it('プロパティの形の名前を持つ元を子に持つフレームが、まとまりになる', () => {
    const { scene } = fixture()
    expect(isVariantSet(scene, 'set')).toBe(true)
    expect(variantsIn(scene, 'set').map((node) => node.id)).toEqual(['a', 'b', 'c'])
    expect(variantSetOf(scene, 'b')?.id).toBe('set')
    expect(isComponentPart(scene, 'set')).toBe(true)
    expect(isComponentPart(scene, 'r')).toBe(false)
    // 名前がプロパティの形でない元は、バリアントではない
    const plain = sceneOf(frame({ id: 'set', children: ['a'] }), main('a', 'ボタン'))
    expect(isVariantSet(plain, 'set')).toBe(false)
    expect(variantSetOf(plain, 'a')).toBeNull()
  })

  it('プロパティと値を、出てきた順に集める', () => {
    expect(variantProperties(fixture().scene, 'set')).toEqual([
      { name: 'サイズ', values: ['小', '大'] },
      { name: '状態', values: ['標準', '押下'] },
    ])
  })

  it('値を変えたときは、ほかのプロパティがいまと多く一致するものを選ぶ', () => {
    const { variants } = fixture()
    const current = parseVariantName('サイズ=大, 状態=押下')!
    expect(pickVariant(variants, current, 'サイズ', '小')?.id).toBe('a')
    expect(pickVariant(variants, current, '状態', '標準')?.id).toBe('b')
    expect(pickVariant(variants, parseVariantName('サイズ=小, 状態=標準')!, '状態', '押下')?.id).toBe('c')
    expect(pickVariant(variants, current, 'サイズ', '中')).toBeNull()
  })
})
