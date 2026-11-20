import { describe, expect, it } from 'vitest'
import type {
  DesignDocument,
  EllipseNode,
  FrameNode,
  ImageNode,
  LineNode,
  PathNode,
  RectNode,
  Scene,
  SceneNode,
  TextNode,
} from '../document/types.ts'
import { inspectNode, nodeCss } from './inspect.ts'

// editor の側にあるノードの生成（nodes.ts）は使えないので、ここで組み立てる
const base = {
  name: 'Node',
  parentId: null,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  rotation: 0,
  visible: true,
  locked: false,
  opacity: 1,
}
const paint = { fill: '#ff0000', fillGradient: null, stroke: null, strokeWidth: 1, shadow: null }

const rect = (patch: Partial<RectNode> = {}): RectNode => ({
  ...base,
  ...paint,
  id: 'rect',
  type: 'rect',
  cornerRadius: 0,
  ...patch,
})
const frame = (patch: Partial<FrameNode> = {}): FrameNode => ({
  ...base,
  ...paint,
  id: 'frame',
  type: 'frame',
  children: [],
  clipContent: true,
  cornerRadius: 0,
  layout: null,
  component: null,
  ...patch,
})
const text = (patch: Partial<TextNode> = {}): TextNode => ({
  ...base,
  id: 'text',
  type: 'text',
  text: 'こんにちは',
  fontSize: 16,
  fontFamily: 'sans-serif',
  fill: '#111111',
  autoWidth: true,
  fontWeight: 400,
  textAlign: 'left',
  lineHeight: 1.5,
  ...patch,
})

function sceneOf(...nodes: SceneNode[]): Scene {
  return {
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    rootIds: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  }
}

function docOf(scene: Scene): DesignDocument {
  return {
    name: 'x',
    pages: [{ id: 'p1', name: 'Page 1', ...scene }],
    assets: { a1: { mime: 'image/png', data: '' } },
  }
}

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
      'border: 2px solid #000000;',
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

  it('画像は収め方と形式を出す', () => {
    const image: ImageNode = { ...base, id: 'image', type: 'image', assetId: 'a1', cornerRadius: 0, fit: 'cover' }
    expect(rowsOf(sceneOf(image), 'image', '画像')).toEqual(['収め方=枠を埋めて切り抜く', '形式=PNG'])
  })
})
