import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { booleanResult, isBooleanNode } from '../../document/booleanNode.ts'
import { testFontBytes } from '../../document/testFont.ts'
import { rect, sceneOf, text } from '../../document/testNodes.ts'
import { setOutlineFonts } from '../../document/textOutline.ts'
import type { PathNode } from '../../document/types.ts'
import { canCreateBooleanNode, createBooleanNode } from './booleanNodes.ts'
import { canOutlineText, outlineTexts } from './outline.ts'
import { booleanPaths, canBooleanPaths } from './paths.ts'

const FONT_ID = 'f'.repeat(64)

beforeEach(() => setOutlineFonts([{ assetId: FONT_ID, family: 'Kdr Test', weight: 400, style: 'normal' }], { [FONT_ID]: { mime: 'font/ttf', bytes: testFontBytes() } }))
afterEach(() => setOutlineFonts([], {}))

const red = [{ type: 'solid' as const, color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const }]
const title = (patch = {}) => text({ id: 't', name: 'Title', fontFamily: 'Kdr Test', text: 'AA', fontSize: 100, lineHeight: 1, x: 10, y: 20, width: 120, height: 100, fills: red, ...patch })

describe('outlineTexts', () => {
  it('テキストを同じ id・名前・塗りのまま、文字の形のパスにする', () => {
    const scene = sceneOf(title(), text({ id: 'plain', fontFamily: 'sans-serif', text: 'x' }))
    expect(canOutlineText(scene.nodes.t)).toBe(true)
    expect(canOutlineText(scene.nodes.plain)).toBe(false)
    const result = outlineTexts(scene, ['t', 'plain'])
    expect(result.ids).toEqual(['t'])
    expect(result.unembedded).toEqual(['plain'])
    const path = result.scene.nodes.t as PathNode
    expect(path.type).toBe('path')
    expect(path.name).toBe('Title')
    expect(path.fills).toBe(red)
    expect(path.fillRule).toBe('nonzero')
    expect(path.contours).toHaveLength(1)
    // 2 つの四角（親の座標系）: x は 10 + 5 〜 10 + 115、y は 20 + 10 〜 20 + 80
    expect([path.x, path.y, path.width, path.height].map(Math.round)).toEqual([15, 30, 110, 70])
    expect(result.scene.nodes.plain).toBe(scene.nodes.plain)
  })

  it('空のテキストと、テキストでないものはそのまま', () => {
    const scene = sceneOf(title({ text: '  ' }), rect({ id: 'r' }))
    const result = outlineTexts(scene, ['t', 'r'])
    expect(result.scene).toBe(scene)
    expect(result.ids).toEqual([])
  })
})

describe('ブーリアン演算にテキストを入れる', () => {
  it('焼き込む演算は、テキストを文字の形にして入れる', () => {
    const scene = sceneOf(rect({ id: 'r', width: 200, height: 200 }), title())
    expect(canBooleanPaths(scene, ['r', 't'])).toBe(true)
    const { scene: next, id, error } = booleanPaths(scene, ['r', 't'], 'subtract')
    expect(error).toBeUndefined()
    expect(id).toBe('r')
    expect(next.nodes.t).toBeUndefined()
    expect((next.nodes.r as PathNode).contours).toHaveLength(2)
  })

  it('最も背面のテキストの塗りを引き継ぐ。埋め込んでいない書体のテキストは入らない', () => {
    const scene = sceneOf(title(), rect({ id: 'r', width: 50, height: 50 }), text({ id: 'plain', fontFamily: 'sans-serif' }))
    expect(canBooleanPaths(scene, ['plain', 'r'])).toBe(false)
    expect(canCreateBooleanNode(scene, ['plain', 'r'])).toBe(false)
    const { scene: next, id } = createBooleanNode(scene, ['t', 'r', 'plain'], 'union')
    const node = next.nodes[id!]
    expect(isBooleanNode(node)).toBe(true)
    if (!isBooleanNode(node)) return
    expect(node.children).toEqual(['t', 'r'])
    expect(node.fills).toBe(red)
    expect(booleanResult(next, node).length).toBeGreaterThan(0)
  })
})
