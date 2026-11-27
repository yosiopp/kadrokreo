import { describe, expect, it } from 'vitest'
import { applyVariables, cssIdent, cssVariableName, detachEditedBindings, modesAt, resolveVariable, variableIndex } from './variables.ts'
import { docOf, frame, rect, sceneOf } from './testNodes.ts'
import type { DesignDocument, Paint, VariableCollection } from './types.ts'

const theme: VariableCollection = {
  id: 'c1',
  name: 'Theme',
  modes: [
    { id: 'light', name: 'Light' },
    { id: 'dark', name: 'Dark' },
  ],
  variables: [
    { id: 'primary', name: 'color/primary', type: 'color', values: { light: '#111111', dark: '#eeeeee' } },
    { id: 'link', name: 'color/link', type: 'color', values: { light: { alias: 'primary' }, dark: { alias: 'brand' } } },
  ],
}
const brand: VariableCollection = {
  id: 'c2',
  name: 'Brand',
  modes: [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ],
  variables: [{ id: 'brand', name: 'color/primary', type: 'color', values: { a: '#aa0000', b: '#bb0000' } }],
}

const fill = (variable: string): Paint => ({ type: 'solid', color: '#000000', variable, opacity: 1, visible: true, blendMode: 'normal' })

function doc(collections: VariableCollection[] = [theme, brand]): DesignDocument {
  const scene = sceneOf(
    frame({ id: 'outer', children: ['inner', 'r1'], modes: { c1: 'dark' } }),
    frame({ id: 'inner', parentId: 'outer', children: ['r2'], modes: { c1: 'light', c2: 'b' } }),
    rect({ id: 'r1', parentId: 'outer', fills: [fill('primary')] }),
    rect({ id: 'r2', parentId: 'inner', fills: [fill('link')] }),
    rect({ id: 'r3', fills: [fill('link')] }),
  )
  return { ...docOf(scene), collections }
}

describe('変数の解決', () => {
  it('モードは近いフレーム → ページ → 最初のモードの順に決まり、無いモードの指定は飛ばす', () => {
    const page = { ...doc().pages[0], modes: { c2: 'b', c1: 'missing' } }
    expect(modesAt(page, 'r1')(theme)).toBe('dark')
    expect(modesAt(page, 'r2')(theme)).toBe('light')
    expect(modesAt(page, 'r3')(theme)).toBe('light')
    expect(modesAt(page, 'r3')(brand)).toBe('b')
    // viewer の切り替えはページの指定の代わりで、フレームの指定のほうが強い
    expect(modesAt(page, 'r3', { c1: 'dark' })(theme)).toBe('dark')
    expect(modesAt(page, 'r2', { c1: 'dark' })(theme)).toBe('light')
  })

  it('別名をたどり、別のコレクションの先はそのコレクションのモードで決める', () => {
    const index = variableIndex([theme, brand])
    expect(resolveVariable(index, 'link', () => 'light')).toBe('#111111')
    expect(resolveVariable(index, 'link', (c) => (c.id === 'c1' ? 'dark' : 'b'))).toBe('#bb0000')
    expect(resolveVariable(index, 'nope', () => 'light')).toBeUndefined()
    // 循環していても止まる
    const loop: VariableCollection = { ...theme, variables: [{ id: 'x', name: 'x', type: 'color', values: { light: { alias: 'x' }, dark: '#000000' } }] }
    expect(resolveVariable(variableIndex([loop]), 'x', () => 'light')).toBeUndefined()
  })

  it('applyVariables はつないだ色を位置のモードで直し、変わらなければ同じ参照を返す', () => {
    const resolved = applyVariables(doc())
    const nodes = resolved.pages[0].nodes
    expect(nodes.r1).toMatchObject({ fills: [{ color: '#eeeeee' }] })
    expect(nodes.r2).toMatchObject({ fills: [{ color: '#111111' }] })
    expect(nodes.r3).toMatchObject({ fills: [{ color: '#111111' }] })
    expect(applyVariables(resolved)).toBe(resolved)
    expect(nodes.outer).toBe(resolved.pages[0].nodes.outer)
    // 変数がなければ何もしない
    const plain = doc([])
    expect(applyVariables(plain)).toBe(plain)
    // viewer の切り替え
    expect(applyVariables(resolved, undefined, { c1: 'dark' }).pages[0].nodes.r3).toMatchObject({ fills: [{ color: '#aa0000' }] })
  })

  it('グラデーションの色・影・インスタンスの上書きの塗りも直す', () => {
    const base = doc()
    const page = base.pages[0]
    const gradient: Paint = {
      type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, opacity: 1, visible: true, blendMode: 'normal',
      stops: [{ offset: 0, color: '#000000', opacity: 1, variable: 'primary' }, { offset: 1, color: '#ffffff', opacity: 1 }],
    }
    const nodes = {
      ...page.nodes,
      r3: rect({ id: 'r3', fills: [gradient], effects: [{ type: 'drop-shadow', x: 0, y: 0, blur: 0, spread: 0, color: '#000000', variable: 'primary', opacity: 1, visible: true, blendMode: 'normal' }] }),
      i1: frame({ id: 'i1', component: { id: 'm', role: 'instance', overrides: { n1: { fills: [fill('primary')] } }, flipX: false, flipY: false } }),
    }
    const resolved = applyVariables({ ...base, pages: [{ ...page, nodes, rootIds: [...page.rootIds, 'i1'] }] }).pages[0].nodes
    expect(resolved.r3).toMatchObject({ fills: [{ stops: [{ color: '#111111' }, { color: '#ffffff' }] }], effects: [{ color: '#111111' }] })
    expect(resolved.i1).toMatchObject({ component: { overrides: { n1: { fills: [{ color: '#111111' }] } } } })
  })
})

describe('CSS 変数の名前', () => {
  it('/ の区切りを - でつなぎ、ぶつかるときだけコレクションの名前を前に付ける', () => {
    expect(cssVariableName([theme, brand], 'link')).toBe('--color-link')
    expect(cssVariableName([theme, brand], 'primary')).toBe('--theme-color-primary')
    expect(cssVariableName([theme, brand], 'brand')).toBe('--brand-color-primary')
    expect(cssVariableName([theme], 'primary')).toBe('--color-primary')
  })

  it('使えない文字は - にし、日本語はそのまま残す', () => {
    expect(cssIdent(' Brand Color ')).toBe('brand-color')
    expect(cssIdent('a.b:c(d)')).toBe('a-b-c-d')
    expect(cssIdent('ボタン/主')).toBe('ボタン-主')
    expect(cssIdent('snake_case-ok')).toBe('snake_case-ok')
  })
})

describe('数値・文字・真偽のつながり', () => {
  const numbers: VariableCollection = {
    id: 'c',
    name: 'N',
    modes: [{ id: 'm', name: 'M' }],
    variables: [
      { id: 'n', name: 'n', type: 'number', values: { m: 12 } },
      { id: 'big', name: 'big', type: 'number', values: { m: 450 } },
    ],
  }

  it('入れられない値は解決しない（太さは 100 刻み）', () => {
    const base = { ...docOf(sceneOf(rect({ id: 'r', cornerRadius: 0, bindings: { cornerRadius: 'n', opacity: 'big' } }))), collections: [numbers] }
    expect(applyVariables(base).pages[0].nodes.r).toMatchObject({ cornerRadius: 12, opacity: 1 })
  })

  it('つながりは同じまま値だけ変えた項目は、つながりを外す', () => {
    const before = { ...docOf(sceneOf(rect({ id: 'r', cornerRadius: 12, strokeWidth: 12, bindings: { cornerRadius: 'n', strokeWidth: 'n' } }))), collections: [numbers] }
    const page = before.pages[0]
    const edited = { ...before, pages: [{ ...page, nodes: { r: { ...page.nodes.r, cornerRadius: 4 } } }] }
    expect(detachEditedBindings(before, edited).pages[0].nodes.r.bindings).toEqual({ strokeWidth: 'n' })
    const rebound = { ...before, pages: [{ ...page, nodes: { r: { ...page.nodes.r, cornerRadius: 4, bindings: { cornerRadius: 'big', strokeWidth: 'n' } } } }] }
    expect(detachEditedBindings(before, rebound)).toBe(rebound)
  })
})
