import { describe, expect, it } from 'vitest'
import { docOf, sceneOf } from '../../document/testNodes.ts'
import type { DesignDocument, VariableCollection } from '../../document/types.ts'
import { TokensError, variablesJson } from '../../viewer/tokens.ts'
import { TokensImportError, importTokens } from './importTokens.ts'

const empty = (): DesignDocument => docOf(sceneOf())

const theme: VariableCollection = {
  id: 'c1',
  name: 'Theme',
  modes: [
    { id: 'l', name: 'Light' },
    { id: 'd', name: 'Dark' },
  ],
  variables: [
    { id: 'p', name: 'color/primary', type: 'color', values: { l: '#5b4cf5', d: '#a99fff' } },
    { id: 'k', name: 'color/link', type: 'color', values: { l: { alias: 'p' }, d: { alias: 'b' } } },
    { id: 's', name: 'space/md', type: 'number', values: { l: 16, d: 20 } },
    { id: 'f', name: 'font', type: 'string', values: { l: 'Inter', d: 'Inter' } },
    { id: 'v', name: 'show', type: 'boolean', values: { l: true, d: false } },
  ],
}
const brand: VariableCollection = { id: 'c2', name: 'Brand', modes: [{ id: 'm', name: 'Mode 1' }], variables: [{ id: 'b', name: 'accent', type: 'color', values: { m: '#ff3366' } }] }

/** 比べるための形（id を名前に直す） */
function shape(doc: DesignDocument) {
  const names = new Map(doc.collections.flatMap((c) => c.variables.map((v) => [v.id, `${c.name}:${v.name}`] as const)))
  return doc.collections.map((c) => ({
    name: c.name,
    modes: c.modes.map((m) => m.name),
    variables: c.variables.map((v) => ({
      name: v.name,
      type: v.type,
      values: c.modes.map((m) => {
        const value = v.values[m.id]
        return typeof value === 'object' ? `→${names.get(value.alias)}` : value
      }),
    })),
  }))
}

describe('変数の JSON', () => {
  it('書き出した JSON を取り込むと、モード・別名ごと同じ変数に戻る', () => {
    const json = JSON.parse(variablesJson([theme, brand]))
    expect(json.Theme.color.primary).toEqual({ $type: 'color', $value: '#5b4cf5', $extensions: { kadrokreo: { modes: { Dark: '#a99fff' } } } })
    expect(json.Theme.color.link).toMatchObject({ $value: '{Theme.color.primary}', $extensions: { kadrokreo: { modes: { Dark: '{Brand.accent}' } } } })
    const result = importTokens(empty(), json)
    expect(result).toMatchObject({ added: 6, updated: 0, warnings: [] })
    expect(shape(result.document)).toEqual(shape({ ...empty(), collections: [theme, brand] }))
    // もう一度取り込むと書き換えになる
    expect(importTokens(result.document, json)).toMatchObject({ added: 0, updated: 6 })
  })

  it('JSON に書けない名前は TokensError', () => {
    expect(() => variablesJson([{ ...brand, variables: [{ ...brand.variables[0], name: 'a.b' }] }])).toThrow(TokensError)
    expect(() =>
      variablesJson([{ ...brand, variables: [brand.variables[0], { ...brand.variables[0], id: 'x', name: 'accent/strong' }] }]),
    ).toThrow('グループと同じ名前')
  })

  it('ほかの道具の JSON は Tokens の 1 つのモードとして読み、読めないものは知らせて飛ばす', () => {
    const json = {
      color: { $type: 'color', brand: { $value: '#f36' }, overlay: { $value: '#00000080' }, srgb: { $value: { colorSpace: 'srgb', components: [1, 0, 0] } } },
      size: { sm: { $type: 'dimension', $value: '8px' }, lg: { $type: 'dimension', $value: { value: 1.5, unit: 'rem' } } },
      font: { body: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] }, bold: { $type: 'fontWeight', $value: 'bold' } },
      alias: { $value: '{color.brand}', $type: 'color' },
      shadow: { $type: 'shadow', $value: { color: '#000000' } },
      broken: { $type: 'color', $value: 'red' },
    }
    const result = importTokens(empty(), json)
    expect(shape(result.document)).toEqual([
      {
        name: 'Tokens',
        modes: ['Mode 1'],
        variables: [
          { name: 'color/brand', type: 'color', values: ['#ff3366'] },
          { name: 'color/overlay', type: 'color', values: ['#000000'] },
          { name: 'color/srgb', type: 'color', values: ['#ff0000'] },
          { name: 'size/sm', type: 'number', values: [8] },
          { name: 'size/lg', type: 'number', values: [24] },
          { name: 'font/body', type: 'string', values: ['Inter, sans-serif'] },
          { name: 'font/bold', type: 'number', values: [700] },
          { name: 'alias', type: 'color', values: ['→Tokens:color/brand'] },
        ],
      },
    ])
    expect(result.warnings.join('\n')).toContain('shadow')
    expect(result.warnings.join('\n')).toContain('broken')
    expect(() => importTokens(empty(), [])).toThrow(TokensImportError)
  })

  it('同じ名前で種類の違う変数は書き換えずに知らせる', () => {
    const base = { ...empty(), collections: [{ id: 'c', name: 'Tokens', modes: [{ id: 'm', name: 'Mode 1' }], variables: [{ id: 'x', name: 'gap', type: 'number' as const, values: { m: 4 } }] }] }
    const result = importTokens(base, { gap: { $type: 'color', $value: '#000000' } })
    expect(result.updated).toBe(0)
    expect(result.warnings[0]).toContain('同じ名前の number の変数')
  })
})

describe('変数の JSON（レビューで見つけた所）', () => {
  it('__proto__ や constructor という名前も書き出して戻せる', () => {
    const odd: VariableCollection = {
      id: 'c',
      name: '__proto__',
      modes: [{ id: 'm', name: 'Mode 1' }],
      variables: [
        { id: 'a', name: '__proto__/x', type: 'number', values: { m: 1 } },
        { id: 'b', name: 'constructor', type: 'number', values: { m: 2 } },
      ],
    }
    const text = variablesJson([odd])
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect(shape(importTokens(empty(), JSON.parse(text)).document)).toEqual(shape({ ...empty(), collections: [odd] }))
  })

  it('文字の変数の「{…}」は、別名の先が無ければ文字のまま戻る', () => {
    const text: VariableCollection = { id: 'c', name: 'T', modes: [{ id: 'm', name: 'M' }], variables: [{ id: 's', name: 'tpl', type: 'string', values: { m: '{name}' } }] }
    expect(shape(importTokens(empty(), JSON.parse(variablesJson([text]))).document)[0].variables[0].values).toEqual(['{name}'])
  })

  it('名前を変えた Tokens の最初のモードに入れ、名前の前後の空白は除き、空の名前は飛ばす', () => {
    const base = { ...empty(), collections: [{ id: 'c', name: 'Tokens', modes: [{ id: 'm', name: 'Light' }], variables: [] }] }
    const result = importTokens(base, { ' gap ': { $value: 4 }, '': { $value: 1 } })
    expect(shape(result.document)).toEqual([{ name: 'Tokens', modes: ['Light'], variables: [{ name: 'gap', type: 'number', values: [4] }] }])
    expect(importTokens(result.document, { gap: { $value: 8 } })).toMatchObject({ added: 0, updated: 1 })
    expect(result.warnings.join()).toContain('名前にできない')
  })

  it('別名の入れ替えを、順番によらず循環と見誤らない。種類の無い別名は先の種類を受け継ぐ', () => {
    const json = JSON.parse(variablesJson([{ id: 'c', name: 'T', modes: [{ id: 'm', name: 'M' }], variables: [
      { id: 'a', name: 'a', type: 'color', values: { m: { alias: 'b' } } },
      { id: 'b', name: 'b', type: 'color', values: { m: '#ffffff' } },
    ] }]))
    const first = importTokens(empty(), json).document
    const swapped = { T: { ...json.T, b: { $type: 'color', $value: '{T.a}' }, a: { $type: 'color', $value: '#000000' } } }
    const result = importTokens(first, swapped)
    expect(result.warnings).toEqual([])
    expect(shape(result.document)[0].variables).toEqual([
      { name: 'a', type: 'color', values: ['#000000'] },
      { name: 'b', type: 'color', values: ['→T:a'] },
    ])
    const untyped = importTokens(empty(), { brand: { $type: 'color', $value: '#ff0000' }, link: { $value: '{brand}' } })
    expect(shape(untyped.document)[0].variables[1]).toEqual({ name: 'link', type: 'color', values: ['→Tokens:brand'] })
  })

  it('1 万近い変数も速く取り込める', () => {
    const json: Record<string, unknown> = {}
    for (let i = 0; i < 5000; i++) json[`n${i}`] = { $type: 'number', $value: i }
    const started = performance.now()
    const result = importTokens(empty(), json)
    expect(result.added).toBe(5000)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
