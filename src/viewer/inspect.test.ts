import { describe, expect, it } from 'vitest'
import { derivedId } from '../document/component.ts'
import type { EllipseNode, ImageNode, LineNode, PathNode, Scene } from '../document/types.ts'
import { inspectNode, inspectSelection, nodeCss } from './inspect.ts'
import { base, docOf, frame, paint, rect, sceneOf, text } from '../document/testNodes.ts'

const css = (scene: Scene, id: string) => nodeCss(scene, id).split('\n')
const rowsOf = (scene: Scene, id: string, title: string) =>
  inspectNode(docOf(scene), scene, id)
    .find((section) => section.title === title)
    ?.rows.map((row) => `${row.label}=${row.value}`)

describe('nodeCss', () => {
  it('ページ直下の長方形は、大きさと塗りだけ', () => {
    expect(css(sceneOf(rect()), 'rect')).toEqual(['width: 100px;', 'height: 50px;', 'background: #ff0000;'])
  })

  it('ふつうのフレームの子は absolute で置き、フレームはその基準になる', () => {
    const parent = frame({ children: ['rect'] })
    const child = rect({ parentId: 'frame', x: 12.5, y: 0 })
    const scene = sceneOf(parent, child)
    expect(css(scene, 'rect').slice(0, 3)).toEqual(['position: absolute;', 'left: 12.5px;', 'top: 0;'])
    expect(css(scene, 'frame')).toEqual([
      'position: relative;',
      'width: 100px;',
      'height: 50px;',
      'background: #ff0000;',
      'overflow: hidden;',
    ])
  })

  it('自動で並べるフレームは flex になり、中身に合わせる向きの大きさと、子の位置は書かない', () => {
    const parent = frame({
      children: ['rect'],
      clipContent: false,
      layout: {
        direction: 'vertical',
        gap: 8,
        paddingX: 16,
        paddingY: 0,
        align: 'center',
        justify: 'space-between',
        widthMode: 'hug',
        heightMode: 'fixed',
      },
    })
    const scene = sceneOf(parent, rect({ parentId: 'frame', x: 16, y: 0 }))
    expect(css(scene, 'frame')).toEqual([
      'display: flex;',
      'flex-direction: column;',
      'align-items: center;',
      'justify-content: space-between;',
      'gap: 8px;',
      'padding: 0 16px;',
      'height: 50px;',
      'background: #ff0000;',
    ])
    expect(css(scene, 'rect')).toEqual(['width: 100px;', 'height: 50px;', 'background: #ff0000;'])
  })

  it('線・角丸・影・回転・不透明度', () => {
    const node = rect({
      stroke: '#000000',
      strokeWidth: 2,
      cornerRadius: 8,
      rotation: -30,
      opacity: 0.5,
      shadow: { x: 0, y: 4, blur: 12, color: '#102030', opacity: 0.25 },
    })
    expect(css(sceneOf(node), 'rect').slice(2)).toEqual([
      'transform: rotate(-30deg);',
      'opacity: 0.5;',
      'background: #ff0000;',
      'outline: 2px solid #000000;',
      'outline-offset: -1px;',
      'border-radius: 8px;',
      'box-shadow: 0 4px 12px rgba(16, 32, 48, 0.25);',
    ])
  })

  it('グラデーションの角度は、CSS の向き（0deg が上向き）に直す', () => {
    const stops = [
      { offset: 0, color: '#000000' },
      { offset: 1, color: '#ffffff' },
    ]
    const gradient = (angle: number) => css(sceneOf(rect({ fillGradient: { angle, stops } })), 'rect').at(-1)
    // 0° は左から右、90° は上から下
    expect(gradient(0)).toBe('background: linear-gradient(90deg, #000000 0%, #ffffff 100%);')
    expect(gradient(90)).toBe('background: linear-gradient(180deg, #000000 0%, #ffffff 100%);')
    expect(gradient(-135)).toBe('background: linear-gradient(315deg, #000000 0%, #ffffff 100%);')
  })

  it('テキストは文字の設定を出し、中身で決まる大きさは書かない', () => {
    expect(css(sceneOf(text()), 'text')).toEqual([
      'color: #111111;',
      'font-family: sans-serif;',
      'font-size: 16px;',
      'font-weight: 400;',
      'line-height: 1.5;',
      'white-space: nowrap;',
    ])
    const wrapped = text({ autoWidth: false, width: 200, fontWeight: 700, textAlign: 'center' })
    expect(css(sceneOf(wrapped), 'text')).toEqual([
      'width: 200px;',
      'color: #111111;',
      'font-family: sans-serif;',
      'font-size: 16px;',
      'font-weight: 700;',
      'line-height: 1.5;',
      'text-align: center;',
    ])
  })

  it('楕円・画像・直線・パス', () => {
    const ellipse: EllipseNode = { ...base, ...paint, id: 'ellipse', type: 'ellipse' }
    expect(css(sceneOf(ellipse), 'ellipse').at(-1)).toBe('border-radius: 50%;')

    const image: ImageNode = {
      ...base,
      id: 'image',
      type: 'image',
      assetId: 'a1',
      cornerRadius: 4,
      fit: 'stretch',
    }
    expect(css(sceneOf(image), 'image').slice(2)).toEqual(['object-fit: fill;', 'border-radius: 4px;'])

    const line: LineNode = {
      ...base,
      id: 'line',
      type: 'line',
      stroke: '#00ff00',
      strokeWidth: 3,
      direction: 'down',
      flipped: false,
      startCap: 'none',
      endCap: 'arrow',
    }
    expect(css(sceneOf(line), 'line').slice(2)).toEqual(['stroke: #00ff00;', 'stroke-width: 3px;'])

    const path: PathNode = {
      ...base,
      ...paint,
      id: 'path',
      type: 'path',
      fill: null,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      closed: false,
      startCap: 'none',
      endCap: 'none',
      shadow: { x: 1, y: 2, blur: 0, color: '#000000', opacity: 1 },
    }
    expect(css(sceneOf(path), 'path').slice(2)).toEqual([
      'fill: none;',
      'stroke: none;',
      'filter: drop-shadow(1px 2px 0 rgba(0, 0, 0, 1));',
    ])
  })

  it('単位を rem にすると、長さを 16px = 1rem で換算する', () => {
    const parent = frame({ children: ['rect', 'text'] })
    const child = rect({
      parentId: 'frame',
      x: 24,
      y: 0,
      width: 100,
      height: 50,
      cornerRadius: 6,
      stroke: '#000000',
      strokeWidth: 1,
      shadow: { x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25 },
    })
    const label = text({ parentId: 'frame', fontSize: 14 })
    const scene = sceneOf(parent, child, label)
    expect(nodeCss(scene, 'rect', { unit: 'rem' }).split('\n')).toEqual([
      'position: absolute;',
      'left: 1.5rem;',
      'top: 0;',
      'width: 6.25rem;',
      'height: 3.125rem;',
      'background: #ff0000;',
      'outline: 0.0625rem solid #000000;',
      'outline-offset: -0.0312rem;',
      'border-radius: 0.375rem;',
      'box-shadow: 0 0.25rem 0.75rem rgba(0, 0, 0, 0.25);',
    ])
    expect(nodeCss(scene, 'text', { unit: 'rem' })).toContain('font-size: 0.875rem;')
    // 行の高さは倍率なので変わらない
    expect(nodeCss(scene, 'text', { unit: 'rem' })).toContain('line-height: 1.5;')
  })
})

describe('inspectNode', () => {
  it('位置とサイズは常に出し、既定のままの項目は出さない', () => {
    const scene = sceneOf(rect({ x: 10.004, y: 20 }))
    expect(rowsOf(scene, 'rect', '位置とサイズ')).toEqual(['X=10', 'Y=20', '幅=100', '高さ=50'])
    expect(rowsOf(scene, 'rect', '塗り')).toEqual(['色=#FF0000'])
    expect(inspectNode(docOf(scene), scene, 'rect').map((section) => section.title)).toEqual(['位置とサイズ', '塗り'])

    const styled = sceneOf(rect({ rotation: 15, cornerRadius: 6, opacity: 0.4 }))
    expect(rowsOf(styled, 'rect', '位置とサイズ')?.slice(4)).toEqual(['回転=15°', '角丸=6', '不透明度=40%'])
  })

  it('塗りの色には色見本を付ける。グラデーションは色ごとに出す', () => {
    const stops = [
      { offset: 0, color: '#4f46e5' },
      { offset: 1, color: '#c026d3' },
    ]
    const scene = sceneOf(rect({ fillGradient: { angle: 30, stops } }))
    const section = inspectNode(docOf(scene), scene, 'rect').find((item) => item.title === '塗り')
    expect(section?.rows).toEqual([
      { label: 'グラデーション', value: '30°' },
      { label: '0%', value: '#4F46E5', color: '#4f46e5' },
      { label: '100%', value: '#C026D3', color: '#c026d3' },
    ])
    expect(rowsOf(sceneOf(rect({ fill: null })), 'rect', '塗り')).toBeUndefined()
  })

  it('線は、色があって太さが 0 でないときだけ出す。影は濃さも出す', () => {
    expect(rowsOf(sceneOf(rect({ stroke: '#000000', strokeWidth: 0 })), 'rect', '線')).toBeUndefined()
    const shadow = { x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25 }
    const scene = sceneOf(rect({ stroke: '#0000ff', strokeWidth: 2, shadow }))
    expect(rowsOf(scene, 'rect', '線')).toEqual(['色=#0000FF', '太さ=2'])
    expect(rowsOf(scene, 'rect', '影')).toEqual(['横=0', '縦=4', 'ぼかし=12', '色=#000000 25%'])
  })

  it('テキストは内容と文字の設定を出す', () => {
    expect(rowsOf(sceneOf(text()), 'text', 'テキスト')).toEqual([
      '内容=こんにちは',
      '書体=sans-serif',
      'サイズ=16',
      '太さ=400',
      '行の高さ=1.5（24px）',
      '行揃え=左',
      '折り返し=しない',
    ])
  })

  it('オートレイアウトの設定と、コンポーネントとのつながりを出す', () => {
    const main = frame({
      id: 'main',
      name: 'ボタン',
      component: { id: 'c1', role: 'main' },
      layout: {
        direction: 'horizontal',
        gap: 8,
        paddingX: 20,
        paddingY: 10,
        align: 'end',
        justify: 'start',
        widthMode: 'hug',
        heightMode: 'fixed',
      },
    })
    const instance = frame({ id: 'instance', component: { id: 'c1', role: 'instance', overrides: {} } })
    const orphan = frame({ id: 'orphan', component: { id: 'gone', role: 'instance', overrides: {} } })
    const scene = sceneOf(main, instance, orphan)
    expect(rowsOf(scene, 'main', 'オートレイアウト')).toEqual([
      '向き=横',
      '間隔=8',
      '余白（左右）=20',
      '余白（上下）=10',
      '揃え=下',
      '寄せ=先頭',
      '幅=中身に合わせる',
      '高さ=固定',
    ])
    expect(rowsOf(scene, 'main', 'コンポーネント')).toEqual(['種類=元'])
    expect(rowsOf(scene, 'instance', 'コンポーネント')).toEqual(['種類=インスタンス', '元の名前=ボタン'])
    expect(rowsOf(scene, 'orphan', 'コンポーネント')).toEqual(['種類=インスタンス'])
  })

  it('インスタンスには、元と違えている項目を、当たっているノードごとに出す', () => {
    const main = frame({ id: 'main', name: 'ボタン', component: { id: 'c1', role: 'main' }, children: ['label', 'icon'] })
    const label = text({ id: 'label', name: 'Label', parentId: 'main' })
    const icon = rect({ id: 'icon', name: 'Icon', parentId: 'main' })
    const labelCopy = derivedId('instance', 'label')
    const iconCopy = derivedId('instance', 'icon')
    const instance = frame({
      id: 'instance',
      name: '保存ボタン',
      children: [labelCopy, iconCopy],
      component: {
        id: 'c1',
        role: 'instance',
        overrides: {
          main: { fill: '#000000' },
          label: { text: '保存', fill: '#ffffff' },
          // 元から消えたノードへの上書きは出さない
          gone: { visible: false },
        },
      },
    })
    const scene = sceneOf(
      main,
      label,
      icon,
      instance,
      text({ id: labelCopy, name: 'Label', parentId: 'instance', text: '保存' }),
      rect({ id: iconCopy, name: 'Icon', parentId: 'instance' }),
    )
    expect(rowsOf(scene, 'instance', '上書き')).toEqual(['保存ボタン=塗り', 'Label=文言・塗り'])
    expect(rowsOf(scene, labelCopy, 'コンポーネント')).toEqual([
      '種類=インスタンスの中身',
      'インスタンス=保存ボタン',
      '元の名前=ボタン',
      '上書き=文言・塗り',
    ])
    expect(rowsOf(scene, iconCopy, 'コンポーネント')).toEqual([
      '種類=インスタンスの中身',
      'インスタンス=保存ボタン',
      '元の名前=ボタン',
    ])
    // 元の側には、上書きの話は出ない
    expect(rowsOf(scene, 'label', 'コンポーネント')).toBeUndefined()
    expect(rowsOf(scene, 'main', '上書き')).toBeUndefined()
  })

  it('画像は収め方と形式を出す', () => {
    const image: ImageNode = { ...base, id: 'image', type: 'image', assetId: 'a1', cornerRadius: 0, fit: 'cover' }
    expect(rowsOf(sceneOf(image), 'image', '画像')).toEqual(['収め方=枠を埋めて切り抜く', '形式=PNG'])
  })
})

describe('inspectSelection', () => {
  const rowsOfSelection = (scene: Scene, ids: string[]) =>
    inspectSelection(scene, ids).map((section) => `${section.title}:${section.rows.map((row) => `${row.label}=${row.value}`).join(',')}`)

  it('離れた 2 つは、全体の矩形と、向かい合う辺の間隔', () => {
    const scene = sceneOf(rect({ id: 'a' }), rect({ id: 'b', x: 130, y: 0 }))
    expect(rowsOfSelection(scene, ['a', 'b'])).toEqual(['全体:X=0,Y=0,幅=230,高さ=50', '間隔:横=30'])
  })

  it('重なっていれば、同じ側の辺どうしの間隔を出す', () => {
    const scene = sceneOf(rect({ id: 'outer', width: 200, height: 100 }), rect({ id: 'inner', x: 10, y: 20, width: 100, height: 50 }))
    expect(rowsOfSelection(scene, ['inner', 'outer'])[1]).toBe('間隔:横（左）=10,横（右）=90,縦（上）=20,縦（下）=30')
  })

  it('3 つ以上なら、全体の矩形だけ', () => {
    const scene = sceneOf(rect({ id: 'a' }), rect({ id: 'b', x: 200 }), rect({ id: 'c', y: 100 }))
    expect(rowsOfSelection(scene, ['a', 'b', 'c'])).toEqual(['全体:X=0,Y=0,幅=300,高さ=150'])
  })
})

describe('色の書き方と rem の基準', () => {
  const shadow = { x: 0, y: 2, blur: 4, color: '#000000', opacity: 0.25 }
  const gradient = { angle: 0, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] }

  it('CSS の色を RGB や HSL で書ける。影は透明度つき', () => {
    const scene = sceneOf(rect({ fill: '#4f46e5', stroke: '#ffffff', strokeWidth: 2, shadow }))
    expect(nodeCss(scene, 'rect', { color: 'rgb' })).toContain('background: rgb(79, 70, 229);')
    expect(nodeCss(scene, 'rect', { color: 'rgb' })).toContain('outline: 2px solid rgb(255, 255, 255);')
    expect(nodeCss(scene, 'rect', { color: 'hsl' })).toContain('box-shadow: 0 2px 4px hsla(0, 0%, 0%, 0.25);')
    expect(nodeCss(scene, 'rect')).toContain('box-shadow: 0 2px 4px rgba(0, 0, 0, 0.25);')
  })

  it('グラデーションとテキストの色も書き方に従う', () => {
    const scene = sceneOf(rect({ fillGradient: gradient }), text({ fill: '#ff0000' }))
    expect(nodeCss(scene, 'rect', { color: 'hsl' })).toContain(
      'background: linear-gradient(90deg, hsl(0, 100%, 50%) 0%, hsl(240, 100%, 50%) 100%);',
    )
    expect(nodeCss(scene, 'text', { color: 'rgb' })).toContain('color: rgb(255, 0, 0);')
  })

  it('rem の基準を変えられる', () => {
    const scene = sceneOf(rect())
    expect(nodeCss(scene, 'rect', { unit: 'rem', remBase: 10 })).toContain('width: 10rem;')
  })

  it('設定の一覧の色も書き方に従う。影は、HEX なら色と濃さを分け、それ以外は透明度つき', () => {
    const scene = sceneOf(rect({ fill: '#4f46e5', shadow }))
    const doc = docOf(scene)
    const color = (format: 'hex' | 'rgb' | 'hsl', title: string) =>
      inspectNode(doc, scene, 'rect', format).find((section) => section.title === title)?.rows.at(-1)?.value
    expect(color('hex', '塗り')).toBe('#4F46E5')
    expect(color('rgb', '塗り')).toBe('rgb(79, 70, 229)')
    expect(color('hex', '影')).toBe('#000000 25%')
    expect(color('rgb', '影')).toBe('rgba(0, 0, 0, 0.25)')
  })
})
