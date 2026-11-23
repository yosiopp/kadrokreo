import { describe, expect, it } from 'vitest'
import { derivedId } from '../document/component.ts'
import { linearFromAngle, solid } from '../document/paint.ts'
import type { EllipseNode, ImageNode, Paint, PathNode, Scene, SceneNode } from '../document/types.ts'
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
      sizing: { width: 'hug', height: 'fixed' },
      layout: {
        direction: 'vertical',
        gap: 8,
        paddingTop: 0,
        paddingRight: 16,
        paddingBottom: 0,
        paddingLeft: 16,
        align: 'center',
        justify: 'space-between',
        wrap: false,
        crossGap: 0, alignContent: 'auto' as const,
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

  it('親いっぱいに伸ばす子は、大きさの代わりに flex と align-self を書く。余白は 4 辺ばらばらにも書ける', () => {
    const layout = {
      direction: 'horizontal' as const,
      gap: 0,
      paddingTop: 1,
      paddingRight: 2,
      paddingBottom: 3,
      paddingLeft: 4,
      align: 'start' as const,
      justify: 'start' as const,
      wrap: false,
      crossGap: 0, alignContent: 'auto' as const,
    }
    const scene = sceneOf(
      frame({ children: ['rect'], clipContent: false, layout }),
      rect({ parentId: 'frame', sizing: { width: 'fill', height: 'fill' } }),
    )
    expect(css(scene, 'frame')).toContain('padding: 1px 2px 3px 4px;')
    expect(css(scene, 'rect')).toEqual(['flex: 1 0 0;', 'align-self: stretch;', 'background: #ff0000;'])
    // 並びから外した子は、親を基準に置く
    const outside = sceneOf(
      frame({ children: ['rect'], clipContent: false, layout }),
      rect({ parentId: 'frame', x: 7, y: 8, layoutPositioning: 'absolute' }),
    )
    expect(css(outside, 'frame')).toContain('position: relative;')
    expect(css(outside, 'rect').slice(0, 3)).toEqual(['position: absolute;', 'left: 7px;', 'top: 8px;'])
    // 親が自動で並べていなければ、伸ばす指定は意味がない
    const plain = sceneOf(frame({ children: ['rect'] }), rect({ parentId: 'frame', sizing: { width: 'fill', height: 'fill' } }))
    expect(css(plain, 'rect')).toContain('width: 100px;')
  })

  it('親の辺への追従は、left / right / top / bottom と割合で書く', () => {
    // 親は 100 × 50。子は x 10, y 5, 30 × 20
    const sceneWith = (horizontal: string, vertical: string) =>
      sceneOf(
        frame({ children: ['rect'] }),
        rect({ parentId: 'frame', x: 10, y: 5, width: 30, height: 20, constraints: { horizontal, vertical } as never }),
      )
    expect(css(sceneWith('end', 'end', ), 'rect').slice(0, 5)).toEqual([
      'position: absolute;', 'right: 60px;', 'bottom: 25px;', 'width: 30px;', 'height: 20px;',
    ])
    expect(css(sceneWith('stretch', 'center'), 'rect').slice(0, 5)).toEqual([
      'position: absolute;', 'left: 10px;', 'right: 60px;', 'top: calc(50% - 20px);', 'height: 20px;',
    ])
    expect(css(sceneWith('scale', 'scale'), 'rect').slice(0, 5)).toEqual([
      'position: absolute;', 'left: 10%;', 'width: 30%;', 'top: 10%;', 'height: 40%;',
    ])
    expect(rowsOf(sceneWith('stretch', 'end'), 'rect', '位置とサイズ')).toContain('親の辺に固定=横 左右・縦 下')
    expect(rowsOf(sceneWith('start', 'start'), 'rect', '位置とサイズ')?.join()).not.toContain('親の辺に固定')
  })

  it('回した子の左右・拡大縮小は、大きさを書いたまま中心が追従する位置で書く', () => {
    // 親は 100 × 50。子は x 10, y 5, 30 × 20 を 90° 回したもの（中心 25, 15）
    const sceneWith = (horizontal: string, vertical: string) =>
      sceneOf(
        frame({ children: ['rect'] }),
        rect({ parentId: 'frame', x: 10, y: 5, width: 30, height: 20, rotation: 90, constraints: { horizontal, vertical } as never }),
      )
    expect(css(sceneWith('stretch', 'scale'), 'rect').slice(0, 5)).toEqual([
      'position: absolute;', 'left: calc(50% - 40px);', 'top: calc(30% - 10px);', 'width: 30px;', 'height: 20px;',
    ])
  })

  it('折り返した行を均等に配るなら align-content: space-between', () => {
    const layout = {
      direction: 'horizontal' as const, gap: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      align: 'center' as const, justify: 'start' as const, wrap: true, crossGap: 0, alignContent: 'space-between' as const,
    }
    const scene = sceneOf(frame({ children: [], layout, sizing: { width: 'fixed', height: 'fixed' } }))
    expect(css(scene, 'frame')).toContain('align-content: space-between;')
    expect(rowsOf(scene, 'frame', 'オートレイアウト')).toContain('行の配置=均等に配る')
  })

  it('折り返しと、大きさの下限・上限', () => {
    const layout = {
      direction: 'horizontal' as const,
      gap: 8,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      align: 'center' as const,
      justify: 'start' as const,
      wrap: true,
      crossGap: 4, alignContent: 'auto' as const,
    }
    const scene = sceneOf(
      frame({ children: ['rect'], clipContent: false, layout, sizing: { width: 'fixed', height: 'hug' }, minHeight: 40, maxWidth: 500 }),
      rect({ parentId: 'frame', sizing: { width: 'fill', height: 'fixed' }, minWidth: 60, maxHeight: 99 }),
    )
    expect(css(scene, 'frame')).toEqual([
      'display: flex;',
      'flex-direction: row;',
      'flex-wrap: wrap;',
      'align-items: center;',
      'align-content: center;',
      'gap: 4px 8px;',
      'width: 100px;',
      // 幅は固定なので上限は書かない。高さは中身に合わせるので下限を書く
      'min-height: 40px;',
      'background: #ff0000;',
    ])
    // 横に伸ばす子の幅の下限だけ。高さは固定なので上限は書かない
    expect(css(scene, 'rect')).toEqual(['flex: 1 0 0;', 'height: 50px;', 'min-width: 60px;', 'background: #ff0000;'])
    expect(rowsOf(scene, 'frame', 'オートレイアウト')).toContain('折り返し=する（行の間隔 4）')
    expect(rowsOf(scene, 'frame', '位置とサイズ')).toContain('最小の高さ=40')
    expect(rowsOf(scene, 'frame', '位置とサイズ')).not.toContain('最大の幅=500')
    expect(rowsOf(scene, 'rect', '位置とサイズ')).toContain('最小の幅=60')
    // 並べる向きを中身に合わせていれば折り返さない
    const hug = sceneOf(frame({ children: [], layout: { ...layout, gap: 4 }, sizing: { width: 'hug', height: 'hug' } }))
    expect(css(hug, 'frame')).not.toContain('flex-wrap: wrap;')
    expect(css(hug, 'frame')).toContain('gap: 4px;')
  })

  it('線・角丸・影・回転・不透明度', () => {
    const node = rect({
      strokes: solid('#000000'),
      strokeWidth: 2,
      cornerRadius: 8,
      rotation: -30,
      opacity: 0.5,
      effects: [{ type: 'drop-shadow', x: 0, y: 4, blur: 12, color: '#102030', opacity: 0.25, visible: true, spread: 0, blendMode: 'normal' }],
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
      { offset: 0, color: '#000000', opacity: 1 },
      { offset: 1, color: '#ffffff', opacity: 1 },
    ]
    const gradient = (angle: number) => css(sceneOf(rect({ fills: [{ type: 'linear', ...linearFromAngle(angle, rect()), stops, opacity: 1, visible: true, blendMode: 'normal' as const }] })), 'rect').at(-1)
    // 0° は左から右、90° は上から下
    expect(gradient(0)).toBe('background: linear-gradient(90deg, #000000 0%, #ffffff 100%);')
    expect(gradient(90)).toBe('background: linear-gradient(180deg, #000000 0%, #ffffff 100%);')
    expect(gradient(-135)).toBe('background: linear-gradient(315deg, #000000 0%, #ffffff 100%);')
  })

  it('グラデーションの色ごとの不透明度は、塗りの不透明度と掛け合わせて CSS の色の透明度にし、パネルにも出す', () => {
    const stops = [
      { offset: 0, color: '#ff0000', opacity: 1 },
      { offset: 1, color: '#ff0000', opacity: 0.5 },
    ]
    const fill = { type: 'linear' as const, ...linearFromAngle(0, rect()), stops, opacity: 0.5, visible: true, blendMode: 'normal' as const }
    const scene = sceneOf(rect({ fills: [fill] }))
    expect(css(scene, 'rect').at(-1)).toBe('background: linear-gradient(90deg, rgba(255, 0, 0, 0.5) 0%, rgba(255, 0, 0, 0.25) 100%);')
    expect(rowsOf(scene, 'rect', '塗り')).toContain('100%=#FF0000・不透明度 50%')
  })

  it('塗りが重なっていれば background を手前から並べ、重ねる単色は同じ色のグラデーションにする。影はカンマでつなぐ', () => {
    const stops = [
      { offset: 0, color: '#000000', opacity: 1 },
      { offset: 1, color: '#ffffff', opacity: 1 },
    ]
    const node = rect({
      fills: [{ type: 'solid', color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const }, { type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops, opacity: 1, visible: true, blendMode: 'normal' as const }, { type: 'solid', color: '#00ff00', opacity: 1, visible: true, blendMode: 'normal' as const }],
      effects: [
        { type: 'drop-shadow', x: 0, y: 1, blur: 2, color: '#000000', opacity: 0.5, visible: true, spread: 0, blendMode: 'normal' },
        { type: 'drop-shadow', x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25, visible: true, spread: 0, blendMode: 'normal' },
      ],
    })
    const lines = css(sceneOf(node), 'rect')
    expect(lines).toContain(
      'background: linear-gradient(#00ff00, #00ff00), linear-gradient(90deg, #000000 0%, #ffffff 100%), #ff0000;',
    )
    // CSS は先に書いた影が手前。効果は先頭が奥
    expect(lines).toContain('box-shadow: 0 4px 8px rgba(0, 0, 0, 0.25), 0 1px 2px rgba(0, 0, 0, 0.5);')
    const section = inspectNode(docOf(sceneOf(node)), sceneOf(node), 'rect').find((item) => item.title === '塗り')
    expect(section?.rows.map((row) => row.value)).toEqual(['#00FF00', '0°', '#000000', '#FFFFFF', '#FF0000'])
  })

  it('円形のグラデーションは、枠に対する % の楕円の radial-gradient にする', () => {
    const stops = [
      { offset: 0, color: '#ffffff', opacity: 1 },
      { offset: 0.5, color: '#ff0000', opacity: 1 },
      { offset: 1, color: '#000000', opacity: 1 },
    ]
    const lines = css(sceneOf(rect({ fills: [{ type: 'radial', cx: 0.25, cy: 0.5, rx: 0.5, ry: 1, stops, opacity: 1, visible: true, angle: 0, fx: 0, fy: 0, blendMode: 'normal' as const }] })), 'rect')
    expect(lines).toContain('background: radial-gradient(50% 100% at 25% 50%, #ffffff 0%, #ff0000 50%, #000000 100%);')
  })

  it('直線の始点・終点を自由に置いたら、CSS の線に写した位置へ色の位置を移す', () => {
    const stops = [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }]
    // 枠（100 × 50）の左から 1/4 〜 3/4 で、横向き
    const scene = sceneOf(rect({ fills: [{ type: 'linear', x1: 0.25, y1: 0.2, x2: 0.75, y2: 0.2, stops, opacity: 1, visible: true, blendMode: 'normal' as const }] }))
    expect(css(scene, 'rect')).toContain('background: linear-gradient(90deg, #000000 25%, #ffffff 75%);')
    expect(rowsOf(scene, 'rect', '塗り')?.[0]).toBe('グラデーション=0°・25% 20% → 75% 20%')
    // 枠の外へはみ出す線は、0% より前・100% より後ろになる
    const wide = sceneOf(rect({ fills: [{ type: 'linear', x1: -0.5, y1: 0.5, x2: 1.5, y2: 0.5, stops, opacity: 1, visible: true, blendMode: 'normal' as const }] }))
    expect(css(wide, 'rect')).toContain('background: linear-gradient(90deg, #000000 -50%, #ffffff 150%);')
  })

  it('角度のグラデーションは conic-gradient にする（CSS の from は 0deg が真上）', () => {
    const stops = [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }]
    const scene = sceneOf(rect({ fills: [{ type: 'conic', cx: 0.25, cy: 0.5, angle: 0, stops, opacity: 1, visible: true, blendMode: 'normal' as const }] }))
    expect(css(scene, 'rect')).toContain('background: conic-gradient(from 90deg at 25% 50%, #ff0000 0%, #0000ff 100%);')
    expect(rowsOf(scene, 'rect', '塗り')).toEqual(['角度のグラデーション=中心 25% 50%・0°から', '0%=#FF0000', '100%=#0000FF'])
  })

  it('内側の影は box-shadow の inset。パスの filter には書けないので省き、インスペクトで知らせる', () => {
    const effects = [
      { type: 'drop-shadow' as const, x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25, visible: true, spread: 0 , blendMode: 'normal' as const},
      { type: 'inner-shadow' as const, x: 1, y: 2, blur: 3, color: '#000000', opacity: 0.5, visible: true, spread: 0 , blendMode: 'normal' as const},
    ]
    expect(css(sceneOf(rect({ effects })), 'rect')).toContain('box-shadow: inset 1px 2px 3px rgba(0, 0, 0, 0.5), 0 4px 8px rgba(0, 0, 0, 0.25);')
    const path: PathNode = {
      ...base,
      ...paint,
      id: 'path',
      name: 'Path',
      type: 'path',
      effects,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }],
      closed: true,
      startCap: 'none',
      endCap: 'none',
      capSize: 0,
      contours: [],
      fillRule: 'nonzero',
      isMask: false,
      maskType: 'vector',
    }
    expect(css(sceneOf(path), 'path')).toContain('filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.25));')
    expect(rowsOf(sceneOf(path), 'path', '効果')).toContain('CSS=filter で表せないので、コードに含めていない')
    expect(rowsOf(sceneOf(path), 'path', '効果')).toContain('種類=内側の影')
  })

  it('描画モードは mix-blend-mode。塗りが 1 つなら塗りの描画モードも、2 つ以上なら background-blend-mode に', () => {
    const red = { type: 'solid' as const, color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const }
    const multiplied = sceneOf(rect({ blendMode: 'multiply' }))
    expect(css(multiplied, 'rect')).toContain('mix-blend-mode: multiply;')
    expect(rowsOf(multiplied, 'rect', '位置とサイズ')).toContain('描画モード=乗算')
    const single = sceneOf(rect({ fills: [{ ...red, blendMode: 'screen' }] }))
    expect(css(single, 'rect')).toContain('mix-blend-mode: screen;')
    expect(rowsOf(single, 'rect', '塗り')).toContain('描画モード=スクリーン')
    const layered = sceneOf(rect({ fills: [red, { ...red, color: '#0000ff', blendMode: 'overlay' }] }))
    expect(css(layered, 'rect')).toContain('background-blend-mode: overlay, normal;')
    expect(css(layered, 'rect').some((line) => line.startsWith('mix-blend-mode'))).toBe(false)
    expect(css(sceneOf(rect()), 'rect').some((line) => line.includes('blend'))).toBe(false)
  })

  it('影の広がりは box-shadow の 4 つ目の長さ。テキストの影は text-shadow（広がりと内側の影は書けないと知らせる）', () => {
    const shadow = { type: 'drop-shadow' as const, x: 0, y: 4, blur: 8, spread: 2, blendMode: 'normal' as const, color: '#000000', opacity: 0.25, visible: true }
    const scene = sceneOf(rect({ effects: [shadow] }))
    expect(css(scene, 'rect')).toContain('box-shadow: 0 4px 8px 2px rgba(0, 0, 0, 0.25);')
    expect(rowsOf(scene, 'rect', '効果')).toContain('広がり=2')
    const inner = { ...shadow, type: 'inner-shadow' as const, spread: 0, blendMode: 'normal' as const }
    const label = sceneOf(text({ effects: [shadow, inner] }))
    expect(css(label, 'text')).toContain('text-shadow: 0 4px 8px rgba(0, 0, 0, 0.25);')
    expect(css(label, 'text').some((line) => line.startsWith('box-shadow'))).toBe(false)
    expect(rowsOf(label, 'text', '効果')).toContain('CSS=text-shadow は広がりを表せないので、広がりなしで書いている')
    expect(rowsOf(label, 'text', '効果')).toContain('CSS=text-shadow で表せないので、コードに含めていない')
  })

  it('影の描画モードはインスペクトに出し、CSS ではふつうに重ねると知らせる', () => {
    const shadow = { type: 'drop-shadow' as const, x: 0, y: 4, blur: 8, spread: 0, blendMode: 'multiply' as const, color: '#000000', opacity: 0.25, visible: true }
    const scene = sceneOf(rect({ effects: [shadow] }))
    expect(css(scene, 'rect')).toContain('box-shadow: 0 4px 8px rgba(0, 0, 0, 0.25);')
    expect(rowsOf(scene, 'rect', '効果')).toContain('描画モード=乗算')
    expect(rowsOf(scene, 'rect', '効果')).toContain('CSS=影ごとの描画モードは CSS で表せないので、ふつうに重ねて書いている')
  })

  it('通過のフレームは描画モードに出し、半透明なら CSS で表せないと知らせる', () => {
    const child = rect({ parentId: 'frame' })
    const opaque = sceneOf(frame({ passThrough: true, children: ['rect'] }), child)
    expect(rowsOf(opaque, 'frame', '位置とサイズ')).toContain('描画モード=通過')
    expect(rowsOf(opaque, 'frame', '位置とサイズ')?.some((row) => row.startsWith('CSS='))).toBe(false)
    const faded = sceneOf(frame({ passThrough: true, opacity: 0.5, children: ['rect'] }), child)
    expect(rowsOf(faded, 'frame', '位置とサイズ')).toContain('CSS=opacity は中身をまとめてから混ぜるので、通過（子が後ろと直接混ざる）は表せない')
    // 描画モードがあれば通過は意味がない
    const blended = sceneOf(frame({ passThrough: true, blendMode: 'multiply', children: ['rect'] }), child)
    expect(rowsOf(blended, 'frame', '位置とサイズ')).not.toContain('描画モード=通過')
  })

  it('レイヤーのぼかしは filter の blur（半径の半分）、背景のぼかしは backdrop-filter', () => {
    const scene = sceneOf(rect({ effects: [{ type: 'layer-blur', blur: 8, visible: true }, { type: 'background-blur', blur: 20, visible: true }] }))
    expect(css(scene, 'rect')).toContain('filter: blur(4px);')
    expect(css(scene, 'rect')).toContain('backdrop-filter: blur(10px);')
    expect(rowsOf(scene, 'rect', '効果')).toEqual(['種類=レイヤーのぼかし', 'ぼかし=8', '種類=背景のぼかし', 'ぼかし=20'])
    // パスは影と同じ filter に並べる
    const path: PathNode = {
      ...base,
      ...paint,
      id: 'path',
      name: 'Path',
      type: 'path',
      effects: [
        { type: 'drop-shadow', x: 0, y: 4, blur: 8, spread: 0, blendMode: 'normal', color: '#000000', opacity: 0.25, visible: true },
        { type: 'layer-blur', blur: 2, visible: true },
      ],
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }],
      closed: true,
      startCap: 'none',
      endCap: 'none',
      capSize: 0,
      contours: [],
      fillRule: 'nonzero',
      isMask: false,
      maskType: 'vector',
    }
    expect(css(sceneOf(path), 'path')).toContain('filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.25)) blur(1px);')
  })

  it('回した円形のグラデーション。90° なら半径を入れ替えて同じ形に、ほかの角度は回さずに書いて知らせる', () => {
    const stops = [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }]
    const radial = (angle: number) => ({ type: 'radial' as const, fx: 0, fy: 0, cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.25, angle, stops, opacity: 1, visible: true, blendMode: 'normal' as const })
    // 100 × 50 の枠。横の半径 50px・縦の半径 12.5px を 90° 回すと、横 12.5px（12.5%）・縦 50px（100%）
    const turned = sceneOf(rect({ fills: [radial(90)] }))
    expect(css(turned, 'rect')).toContain('background: radial-gradient(12.5% 100% at 50% 50%, #ff0000 0%, #0000ff 100%);')
    expect(rowsOf(turned, 'rect', '塗り')).toContain('円形のグラデーション=中心 50% 50%・半径 50% 25%・90° 回す')
    expect((rowsOf(turned, 'rect', '塗り') ?? []).some((row) => row.startsWith('CSS='))).toBe(false)
    const tilted = sceneOf(rect({ fills: [radial(30)] }))
    expect(css(tilted, 'rect')).toContain('background: radial-gradient(50% 25% at 50% 50%, #ff0000 0%, #0000ff 100%);')
    expect(rowsOf(tilted, 'rect', '塗り')).toContain('CSS=回した楕円は表せないので、回さない楕円で書いている')
  })

  it('円形のグラデーションの焦点はパネルに出し、CSS では中心から始めて知らせる', () => {
    const stops = [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }]
    const focal = sceneOf(rect({ fills: [{ type: 'radial' as const, cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, angle: 0, fx: 0.3, fy: -0.2, stops, opacity: 1, visible: true, blendMode: 'normal' as const }] }))
    expect(css(focal, 'rect')).toContain('background: radial-gradient(50% 50% at 50% 50%, #ff0000 0%, #0000ff 100%);')
    expect(rowsOf(focal, 'rect', '塗り')).toContain('円形のグラデーション=中心 50% 50%・半径 50% 50%・焦点 30% -20%')
    expect(rowsOf(focal, 'rect', '塗り')).toContain('CSS=焦点は表せないので、中心から始まるグラデーションで書いている')
  })

  it('隠した塗り・線・効果は CSS にもインスペクトにも出さない', () => {
    const scene = sceneOf(
      rect({
        fills: [...solid('#ff0000'), { type: 'solid', color: '#00ff00', opacity: 1, visible: false, blendMode: 'normal' as const }],
        strokes: [{ type: 'solid', color: '#0000ff', opacity: 1, visible: false, blendMode: 'normal' as const }],
        strokeWidth: 2,
        effects: [{ type: 'drop-shadow', x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25, visible: false, spread: 0, blendMode: 'normal' }],
      }),
    )
    const lines = css(scene, 'rect')
    expect(lines).toContain('background: #ff0000;')
    expect(lines.join('\n')).not.toMatch(/outline|box-shadow|#00ff00/)
    expect(rowsOf(scene, 'rect', '塗り')).toEqual(['色=#FF0000'])
    expect(rowsOf(scene, 'rect', '線')).toBeUndefined()
    expect(rowsOf(scene, 'rect', '効果')).toBeUndefined()
  })

  it('4 隅の角丸は左上から時計回りに並べる', () => {
    expect(css(sceneOf(rect({ cornerRadius: [0, 8, 16, 0] })), 'rect')).toContain('border-radius: 0 8px 16px 0;')
    expect(rowsOf(sceneOf(rect({ cornerRadius: [0, 8, 16, 0] })), 'rect', '位置とサイズ')).toContain('角丸=0 8 16 0')
  })

  it('テキストに重ねた塗りも、背景を文字の形で切り抜いて表す', () => {
    const radial = { type: 'radial' as const, cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }], opacity: 1, visible: true, angle: 0, fx: 0, fy: 0, blendMode: 'normal' as const }
    const lines = css(sceneOf(text({ fills: [...solid('#00ff00'), radial] })), 'text')
    expect(lines.slice(0, 2)).toEqual([
      'background: radial-gradient(50% 50% at 50% 50%, #ff0000 0%, #0000ff 100%), #00ff00;',
      'background-clip: text;',
    ])
  })

  it('テキストのグラデーションは、背景を文字の形で切り抜いて表す', () => {
    const stops = [
      { offset: 0, color: '#ff0000', opacity: 1 },
      { offset: 1, color: '#0000ff', opacity: 1 },
    ]
    const lines = css(sceneOf(text({ fills: [{ type: 'linear', x1: 0.5, y1: 0, x2: 0.5, y2: 1, stops, opacity: 1, visible: true, blendMode: 'normal' as const }] })), 'text')
    expect(lines.slice(0, 3)).toEqual([
      'background: linear-gradient(180deg, #ff0000 0%, #0000ff 100%);',
      'background-clip: text;',
      'color: transparent;',
    ])
  })

  it('書体名は引用符で囲み、総称名はそのまま書く', () => {
    expect(css(sceneOf(text({ fontFamily: 'Noto Sans JP, sans-serif' })), 'text')).toContain('font-family: "Noto Sans JP", sans-serif;')
    expect(css(sceneOf(text({ fontFamily: 'a}b' })), 'text')).toContain('font-family: "a\\7d b";')
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
    // 中身に合わせる幅に上限があれば、そこで折り返す
    const limited = css(sceneOf(text({ maxWidth: 240, minWidth: 20 })), 'text')
    expect(limited).toContain('max-width: 240px;')
    expect(limited).toContain('min-width: 20px;')
    expect(limited).toContain('width: max-content;')
    expect(limited).not.toContain('white-space: nowrap;')
    expect(rowsOf(sceneOf(text({ maxWidth: 240 })), 'text', 'テキスト')).toContain('折り返し=最大の幅（240）で')
    // 高さはいつも中身で決まるので、下限・上限をいつも書く
    const tall = sceneOf(text({ minHeight: 40, maxHeight: 80 }))
    expect(css(tall, 'text')).toEqual(expect.arrayContaining(['min-height: 40px;', 'max-height: 80px;']))
    expect(rowsOf(tall, 'text', '位置とサイズ')).toEqual(expect.arrayContaining(['最小の高さ=40', '最大の高さ=80']))
    const wrapped = text({ sizing: { width: 'fixed', height: 'hug' }, width: 200, fontWeight: 700, textAlign: 'center' })
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
    const ellipse: EllipseNode = { ...base, ...paint, id: 'ellipse', type: 'ellipse', isMask: false, maskType: 'vector' }
    expect(css(sceneOf(ellipse), 'ellipse').at(-1)).toBe('border-radius: 50%;')

    const image: ImageNode = {
      ...base,
      id: 'image',
      type: 'image',
      effects: [],
      assetId: 'a1',
      cornerRadius: 4,
      fit: 'stretch', positionX: 0.5, positionY: 0.5, scale: 1,
    }
    expect(css(sceneOf(image), 'image').slice(2)).toEqual(['object-fit: fill;', 'border-radius: 4px;'])
    // 切り抜く位置を寄せていれば object-position
    expect(css(sceneOf({ ...image, fit: 'cover', positionX: 0, positionY: 0.25, scale: 1 }), 'image').slice(2)).toEqual([
      'object-fit: cover;',
      'object-position: 0% 25%;',
      'border-radius: 4px;',
    ])

    const line: PathNode = {
      ...base,
      id: 'line',
      type: 'path',
      fills: [],
      strokes: solid('#00ff00'),
      strokeWidth: 3,
      strokeDashes: [],
      strokeDashOffset: 0,
      strokeJoin: 'miter',
      effects: [],
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      closed: false,
      startCap: 'none',
      endCap: 'arrow',
      capSize: 0,
      contours: [],
      fillRule: 'nonzero',
      isMask: false,
      maskType: 'vector',
    }
    expect(css(sceneOf(line), 'line').slice(2)).toEqual(['stroke: #00ff00;', 'stroke-width: 3px;'])
    // 破線のずれ（破線のときだけ）と角の形（既定の miter 以外）
    expect(css(sceneOf({ ...line, strokeDashes: [4, 2], strokeDashOffset: 1, strokeJoin: 'round' }), 'line').slice(2)).toEqual([
      'stroke: #00ff00;',
      'stroke-width: 3px;',
      'stroke-dasharray: 4px 2px;',
      'stroke-dashoffset: 1px;',
      'stroke-linejoin: round;',
    ])
    expect(css(sceneOf({ ...line, strokeDashOffset: 1 }), 'line').slice(2)).toEqual(['stroke: #00ff00;', 'stroke-width: 3px;'])
    // 両端が同じ丸・四角なら stroke-linecap（破線の切れ目の端も同じ形になる）。両端が違えば書かない
    expect(css(sceneOf({ ...line, strokeDashes: [4, 2], startCap: 'round', endCap: 'round' }), 'line').slice(2)).toEqual([
      'stroke: #00ff00;',
      'stroke-width: 3px;',
      'stroke-dasharray: 4px 2px;',
      'stroke-linecap: round;',
    ])
    expect(css(sceneOf({ ...line, startCap: 'square', endCap: 'square' }), 'line')).toContain('stroke-linecap: square;')
    expect(css(sceneOf({ ...line, startCap: 'round', endCap: 'square' }), 'line').join('')).not.toContain('stroke-linecap')

    const path: PathNode = {
      ...base,
      ...paint,
      id: 'path',
      type: 'path',
      fills: [],
      // 2 頂点の開いたパスは直線になるので、頂点を 3 つにする
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      closed: false,
      startCap: 'none',
      endCap: 'none',
      capSize: 0,
      contours: [],
      fillRule: 'nonzero',
      isMask: false,
      maskType: 'vector',
      effects: [{ type: 'drop-shadow', x: 1, y: 2, blur: 0, color: '#000000', opacity: 1, visible: true, spread: 0, blendMode: 'normal' }],
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
      strokes: solid('#000000'),
      strokeWidth: 1,
      effects: [{ type: 'drop-shadow', x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25, visible: true, spread: 0, blendMode: 'normal' }],
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
      { offset: 0, color: '#4f46e5', opacity: 1 },
      { offset: 1, color: '#c026d3', opacity: 1 },
    ]
    const scene = sceneOf(rect({ fills: [{ type: 'linear', ...linearFromAngle(30, rect()), stops, opacity: 1, visible: true, blendMode: 'normal' as const }] }))
    const section = inspectNode(docOf(scene), scene, 'rect').find((item) => item.title === '塗り')
    expect(section?.rows).toEqual([
      { label: 'グラデーション', value: '30°' },
      { label: '0%', value: '#4F46E5', color: '#4f46e5' },
      { label: '100%', value: '#C026D3', color: '#c026d3' },
    ])
    expect(rowsOf(sceneOf(rect({ fills: [] })), 'rect', '塗り')).toBeUndefined()
    const radial = { type: 'radial' as const, cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.75, stops, opacity: 1, visible: true, angle: 0, fx: 0, fy: 0, blendMode: 'normal' as const }
    expect(rowsOf(sceneOf(rect({ fills: [radial] })), 'rect', '塗り')?.[0]).toBe('円形のグラデーション=中心 50% 50%・半径 50% 75%')
  })

  it('線は、色があって太さが 0 でないときだけ出す。影は濃さも出す', () => {
    expect(rowsOf(sceneOf(rect({ strokes: solid('#000000'), strokeWidth: 0 })), 'rect', '線')).toBeUndefined()
    const shadow = { type: 'drop-shadow' as const, x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25, visible: true, spread: 0 , blendMode: 'normal' as const}
    const scene = sceneOf(rect({ strokes: solid('#0000ff'), strokeWidth: 2, effects: [shadow] }))
    expect(rowsOf(scene, 'rect', '線')).toEqual(['色=#0000FF', '太さ=2'])
    const dashed = sceneOf(rect({ strokes: solid('#0000ff'), strokeWidth: 2, strokeDashes: [4, 2], strokeDashOffset: 3, strokeJoin: 'bevel' }))
    expect(rowsOf(dashed, 'rect', '線')).toEqual(['色=#0000FF', '太さ=2', '破線=4, 2', '破線のずれ=3', '角の形=切り落とす'])
    expect(rowsOf(scene, 'rect', '効果')).toEqual(['種類=落ち影', '横=0', '縦=4', 'ぼかし=12', '色=#000000 25%'])
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
      component: { id: 'c1', role: 'main', description: '', properties: [] },
      sizing: { width: 'hug', height: 'fixed' },
      layout: {
        direction: 'horizontal',
        gap: 8,
        paddingTop: 10,
        paddingRight: 20,
        paddingBottom: 10,
        paddingLeft: 20,
        align: 'end',
        justify: 'start',
        wrap: false,
        crossGap: 0, alignContent: 'auto' as const,
      },
    })
    const instance = frame({ id: 'instance', component: { id: 'c1', role: 'instance', overrides: {} } })
    const orphan = frame({ id: 'orphan', component: { id: 'gone', role: 'instance', overrides: {} } })
    const scene = sceneOf(main, instance, orphan)
    expect(rowsOf(scene, 'main', 'オートレイアウト')).toEqual([
      '向き=横',
      '間隔=8',
      '余白=10 20',
      '揃え=下',
      '寄せ=先頭',
      '幅=中身に合わせる',
      '高さ=固定',
    ])
    expect(rowsOf(scene, 'main', 'コンポーネント')).toEqual(['種類=元'])
    expect(rowsOf(scene, 'instance', 'コンポーネント')).toEqual(['種類=インスタンス', '元の名前=ボタン'])
    expect(rowsOf(scene, 'orphan', 'コンポーネント')).toEqual(['種類=インスタンス'])
  })

  it('コンポーネントの説明文とプロパティを、元とインスタンスに出す', () => {
    const copy = derivedId('instance', 'label')
    const scene = sceneOf(
      frame({
        id: 'main',
        name: 'ボタン',
        children: ['label'],
        component: {
          id: 'c1',
          role: 'main',
          description: '主な操作に使う',
          properties: [
            { name: '文言', type: 'text', targets: ['label'], preferred: [] },
            { name: '印', type: 'boolean', targets: ['label', 'gone'], preferred: [] },
            { name: 'アイコン', type: 'instance', targets: [], preferred: ['c1', 'gone'] },
          ],
        },
      }),
      text({ id: 'label', parentId: 'main', text: 'OK' }),
      frame({ id: 'instance', children: [copy], component: { id: 'c1', role: 'instance', overrides: { label: { text: '送信' } } } }),
      text({ id: copy, parentId: 'instance', text: '送信' }),
    )
    expect(rowsOf(scene, 'main', 'コンポーネント')).toContain('説明=主な操作に使う')
    expect(rowsOf(scene, 'main', 'プロパティ')).toEqual(['文言=文言（1 か所）', '印=表示の切り替え（1 か所）', "アイコン=インスタンスの差し替え（0 か所）・候補: ボタン"])
    expect(rowsOf(scene, 'instance', 'コンポーネント')).toContain('説明=主な操作に使う')
    expect(rowsOf(scene, 'instance', 'プロパティ')).toEqual(['文言（上書き）=送信', '印=表示'])
  })

  it('バリアントのまとまり・バリアント・そのインスタンスには、プロパティを出す', () => {
    const scene = sceneOf(
      frame({ id: 'set', name: 'ボタン', children: ['small', 'large'] }),
      frame({ id: 'small', name: 'サイズ=小, 状態=標準', parentId: 'set', component: { id: 'c1', role: 'main', description: '', properties: [] } }),
      frame({ id: 'large', name: 'サイズ=大, 状態=標準', parentId: 'set', component: { id: 'c2', role: 'main', description: '', properties: [] } }),
      frame({ id: 'instance', name: 'ボタン', component: { id: 'c2', role: 'instance', overrides: {} } }),
    )
    expect(rowsOf(scene, 'set', 'コンポーネント')).toEqual(['種類=バリアントのまとまり', 'サイズ=小 / 大', '状態=標準'])
    expect(rowsOf(scene, 'large', 'コンポーネント')).toEqual(['種類=バリアント', 'まとまり=ボタン', 'サイズ=大', '状態=標準'])
    expect(rowsOf(scene, 'instance', 'コンポーネント')).toEqual([
      '種類=インスタンス',
      'コンポーネント=ボタン',
      'サイズ=大',
      '状態=標準',
    ])
  })

  it('まとまりには、バリアントで共有するプロパティを出す（揃っていなければ数を添える）', () => {
    const props = (names: string[]) => names.map((name) => ({ name, type: 'text' as const, targets: [], preferred: [] }))
    const scene = sceneOf(
      frame({ id: 'set', name: 'ボタン', children: ['small', 'large'] }),
      frame({ id: 'small', name: 'サイズ=小', parentId: 'set', component: { id: 'c1', role: 'main', description: '', properties: props(['文言', '補足']) } }),
      frame({ id: 'large', name: 'サイズ=大', parentId: 'set', component: { id: 'c2', role: 'main', description: '', properties: props(['文言']) } }),
    )
    expect(rowsOf(scene, 'set', 'プロパティ')).toEqual(['文言=文言', '補足=文言（2 個のうち 1 個のバリアント）'])
  })

  it('入れ子の中の入れ子のインスタンスに結んだ差し替えのプロパティは、写しをたどって値を出す', () => {
    // 丸・四角（アイコン）、ボタン（中に丸のインスタンス）、カード（中にボタンのインスタンス）、カードのインスタンス
    const iconInButton = derivedId('nested', 'icon')
    const cardCopy = derivedId('cardInstance', 'nested')
    const iconInCard = derivedId('cardInstance', iconInButton)
    const scene = sceneOf(
      frame({ id: 'circle', name: '丸', component: { id: 'cCircle', role: 'main', description: '', properties: [] } }),
      frame({ id: 'square', name: '四角', component: { id: 'cSquare', role: 'main', description: '', properties: [] } }),
      frame({ id: 'button', name: 'ボタン', children: ['icon'], component: { id: 'cButton', role: 'main', description: '', properties: [] } }),
      frame({ id: 'icon', name: '丸', parentId: 'button', component: { id: 'cCircle', role: 'instance', overrides: {} } }),
      frame({
        id: 'card',
        name: 'カード',
        children: ['nested'],
        component: { id: 'cCard', role: 'main', description: '', properties: [{ name: 'アイコン', type: 'instance', targets: [iconInButton], preferred: [] }] },
      }),
      frame({ id: 'nested', name: 'ボタン', parentId: 'card', children: [iconInButton], component: { id: 'cButton', role: 'instance', overrides: {} } }),
      frame({ id: iconInButton, name: '丸', parentId: 'nested' }),
      frame({ id: 'cardInstance', name: 'カード', children: [cardCopy], component: { id: 'cCard', role: 'instance', overrides: {} } }),
      frame({ id: cardCopy, name: 'ボタン', parentId: 'cardInstance', children: [iconInCard] }),
      frame({ id: iconInCard, name: '丸', parentId: cardCopy }),
    )
    expect(rowsOf(scene, 'card', 'プロパティ')).toEqual(['アイコン=インスタンスの差し替え（1 か所）'])
    expect(rowsOf(scene, 'cardInstance', 'プロパティ')).toEqual(['アイコン=丸'])
  })

  it('インスタンスには、元と違えている項目を、当たっているノードごとに出す', () => {
    const main = frame({ id: 'main', name: 'ボタン', component: { id: 'c1', role: 'main', description: '', properties: [] }, children: ['label', 'icon'] })
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
          main: { fills: solid('#000000') },
          label: { text: '保存', fills: solid('#ffffff') },
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

  it('入れ子のインスタンスを差し替えた写しには、差し替えた元を出す', () => {
    const icon = frame({ id: 'icon', name: 'Icon', component: { id: 'c2', role: 'main', description: '', properties: [] } })
    const card = frame({ id: 'card', name: 'Card', component: { id: 'c1', role: 'main', description: '', properties: [] }, children: ['nested'] })
    const nested = frame({ id: 'nested', name: 'Button', parentId: 'card', component: { id: 'c3', role: 'instance', overrides: {} } })
    const copy = derivedId('instance', 'nested')
    const instance = frame({
      id: 'instance',
      name: 'Card',
      children: [copy],
      component: { id: 'c1', role: 'instance', overrides: { nested: { componentId: 'c2' } } },
    })
    const scene = sceneOf(icon, card, nested, instance, frame({ id: copy, name: 'Icon', parentId: 'instance' }))
    expect(rowsOf(scene, copy, 'コンポーネント')).toEqual([
      '種類=インスタンスの中身',
      'インスタンス=Card',
      '元の名前=Card',
      '上書き=入れ子のインスタンスの元',
      '差し替えた元=Icon',
    ])
  })

  it('画像は収め方と形式を出す', () => {
    const image: ImageNode = { ...base, id: 'image', type: 'image',
      effects: [], assetId: 'a1', cornerRadius: 0, fit: 'cover', positionX: 0.5, positionY: 0.5, scale: 1 }
    expect(rowsOf(sceneOf(image), 'image', '画像')).toEqual(['収め方=枠を埋めて切り抜く', '形式=PNG'])
    // 寄せる位置と切り抜きの拡大は、既定でなければ出す
    expect(rowsOf(sceneOf({ ...image, positionX: 0, scale: 2 }), 'image', '画像')).toEqual([
      '収め方=枠を埋めて切り抜く',
      '寄せる位置=0% 50%',
      '拡大=200%',
      '形式=PNG',
    ])
  })

  it('塗りごとの不透明度は、塗りの節に出し、CSS では色の alpha にする', () => {
    const half = { type: 'solid' as const, color: '#ff0000', opacity: 0.5, visible: true, blendMode: 'normal' as const }
    const fade = { type: 'linear' as const, x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }], opacity: 0.25, visible: true, blendMode: 'normal' as const }
    const scene = sceneOf(rect({ fills: [half] }), rect({ id: 'g', fills: [fade], strokes: [{ ...half, color: '#00ff00' }], strokeWidth: 2 }))
    expect(rowsOf(scene, 'rect', '塗り')).toEqual(['色=#FF0000', '不透明度=50%'])
    expect(css(scene, 'rect')).toContain('background: rgba(255, 0, 0, 0.5);')
    expect(css(scene, 'g')).toContain('background: linear-gradient(90deg, rgba(0, 0, 0, 0.25) 0%, rgba(255, 255, 255, 0.25) 100%);')
    expect(css(scene, 'g')).toContain('outline: 2px solid rgba(0, 255, 0, 0.5);')
    const label = text({ fills: [half] })
    expect(css(sceneOf(label), label.id)).toContain('color: rgba(255, 0, 0, 0.5);')
  })

  it('切り抜きの拡大は object-view-box で、拡大した画像の寄せる位置まで描画と同じにする', () => {
    const image: ImageNode = { ...base, id: 'image', type: 'image',
      effects: [], assetId: 'a1', cornerRadius: 0, fit: 'cover', positionX: 0.5, positionY: 0.5, scale: 2 }
    expect(css(sceneOf(image), 'image')).toContain('object-view-box: inset(25% 25% 25% 25%);')
    expect(css(sceneOf({ ...image, positionX: 0, positionY: 1, scale: 4 }), 'image')).toContain('object-view-box: inset(75% 75% 0% 0%);')
    expect(css(sceneOf({ ...image, scale: 1 }), 'image').join('\n')).not.toContain('object-view-box')
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

  it('同じ向きに回った 2 つは、辺に沿った間隔と、測った向きを出す', () => {
    // 100 × 50 の 2 つを縦に並べ、それぞれ 90° 回す（回すと縦 100 になり、間は 30）
    const scene = sceneOf(rect({ id: 'a', rotation: 90 }), rect({ id: 'b', x: 0, y: 130, rotation: 90 }))
    // 90° は回っていないのと同じ向き。ページの縦で測る
    expect(rowsOfSelection(scene, ['a', 'b'])[1]).toBe('間隔:縦=30')
    const tilted = sceneOf(rect({ id: 'a', rotation: 30 }), rect({ id: 'b', x: 0, y: 130, rotation: 30 }))
    expect(rowsOfSelection(tilted, ['a', 'b'])[1]).toMatch(/測る向き=辺に沿う（30°）$/)
  })

  it('向きが違えば、囲む矩形で測ったことを書き添える', () => {
    const scene = sceneOf(rect({ id: 'a', rotation: 45 }), rect({ id: 'b', x: 300 }))
    expect(rowsOfSelection(scene, ['a', 'b'])[1]).toMatch(/測る向き=回した図形は囲む矩形で$/)
  })

  it('3 つ以上なら、全体の矩形だけ', () => {
    const scene = sceneOf(rect({ id: 'a' }), rect({ id: 'b', x: 200 }), rect({ id: 'c', y: 100 }))
    expect(rowsOfSelection(scene, ['a', 'b', 'c'])).toEqual(['全体:X=0,Y=0,幅=300,高さ=150'])
  })
})

describe('色の書き方と rem の基準', () => {
  const shadow = { type: 'drop-shadow' as const, x: 0, y: 2, blur: 4, color: '#000000', opacity: 0.25, visible: true, spread: 0 , blendMode: 'normal' as const}
  const gradient = { type: 'linear' as const, x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }], opacity: 1, visible: true, blendMode: 'normal' as const }

  it('CSS の色を RGB や HSL で書ける。影は透明度つき', () => {
    const scene = sceneOf(rect({ fills: solid('#4f46e5'), strokes: solid('#ffffff'), strokeWidth: 2, effects: [shadow] }))
    expect(nodeCss(scene, 'rect', { color: 'rgb' })).toContain('background: rgb(79, 70, 229);')
    expect(nodeCss(scene, 'rect', { color: 'rgb' })).toContain('outline: 2px solid rgb(255, 255, 255);')
    expect(nodeCss(scene, 'rect', { color: 'hsl' })).toContain('box-shadow: 0 2px 4px hsla(0, 0%, 0%, 0.25);')
    expect(nodeCss(scene, 'rect')).toContain('box-shadow: 0 2px 4px rgba(0, 0, 0, 0.25);')
  })

  it('グラデーションとテキストの色も書き方に従う', () => {
    const scene = sceneOf(rect({ fills: [gradient] }), text({ fills: solid('#ff0000') }))
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
    const scene = sceneOf(rect({ fills: solid('#4f46e5'), effects: [shadow] }))
    const doc = docOf(scene)
    const color = (format: 'hex' | 'rgb' | 'hsl', title: string) =>
      inspectNode(doc, scene, 'rect', format).find((section) => section.title === title)?.rows.at(-1)?.value
    expect(color('hex', '塗り')).toBe('#4F46E5')
    expect(color('rgb', '塗り')).toBe('rgb(79, 70, 229)')
    expect(color('hex', '効果')).toBe('#000000 25%')
    expect(color('rgb', '効果')).toBe('rgba(0, 0, 0, 0.25)')
  })
})

describe('マスク', () => {
  // 回した子にも、自分の枠の座標に直した形をかける
  const scene = sceneOf(
    frame({ id: 'frame', name: 'Card', width: 200, height: 200, children: ['mask', 'photo', 'turned'] }),
    rect({ id: 'mask', name: 'Window', parentId: 'frame', x: 10, y: 10, width: 50, height: 40, isMask: true }),
    rect({ id: 'photo', name: 'Photo', parentId: 'frame', x: 0, y: 0, width: 100, height: 100 }),
    rect({ id: 'turned', name: 'Turned', parentId: 'frame', x: 0, y: 0, width: 100, height: 100, rotation: 90 }),
  )

  it('かかっている子は clip-path: path() で、マスクの形を自分の枠の座標に直す', () => {
    expect(css(scene, 'photo')).toContain("clip-path: path('M10 10 L60 10 L60 50 L10 50 Z');")
    // 中心 (50, 50) で 90° 回した枠の座標では、マスクの左上 (10, 10) は (10, 90) に来る
    expect(css(scene, 'turned').find((line) => line.startsWith('clip-path'))).toContain('M10 90')
    expect(css(scene, 'mask').some((line) => line.startsWith('clip-path'))).toBe(false)
  })

  it('インスペクトに、マスクであることと、かかっているマスクの名前を出す', () => {
    const doc = docOf(scene)
    expect(inspectNode(doc, scene, 'mask').find((section) => section.title === 'マスク')?.rows).toEqual([
      { label: '使い方', value: 'マスクとして使う（描かない）' },
    ])
    expect(inspectNode(doc, scene, 'photo').find((section) => section.title === 'マスク')?.rows).toEqual([
      { label: 'かかるマスク', value: 'Window' },
    ])
  })
})

describe('不透明度・明るさのマスクの CSS', () => {
  const gradient: Paint = {
    type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, opacity: 1, visible: true, blendMode: 'normal',
    stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#000000', opacity: 1 }],
  }
  const scene = sceneOf(
    frame({ id: 'frame', name: 'Card', width: 200, height: 200, children: ['mask', 'photo'] }),
    rect({ id: 'mask', name: 'Fade', parentId: 'frame', x: 10, y: 10, width: 50, height: 40, isMask: true, maskType: 'luminance', fills: [gradient] }),
    rect({ id: 'photo', name: 'Photo', parentId: 'frame', x: 0, y: 0, width: 100, height: 100 }),
  )

  it('マスクの絵を自分の枠に合わせた SVG の mask-image にし、mask-mode で種類を書く', () => {
    const lines = css(scene, 'photo')
    const image = lines.find((line) => line.startsWith('mask-image'))
    expect(image).toMatch(/^mask-image: url\("data:image\/svg\+xml,/)
    const svg = decodeURIComponent(image!.slice('mask-image: url("data:image/svg+xml,'.length, -'");'.length))
    expect(svg).toContain("viewBox='0 0 100 100'")
    expect(svg).toContain('linearGradient')
    expect(svg).toContain("<rect transform='translate(10 10)' width='50' height='40'")
    expect(lines).toContain('mask-mode: luminance;')
    expect(lines.some((line) => line.startsWith('clip-path'))).toBe(false)
    const alpha = { ...scene, nodes: { ...scene.nodes, mask: { ...scene.nodes.mask, maskType: 'alpha' } as SceneNode } }
    expect(css(alpha, 'photo')).toContain('mask-mode: alpha;')
  })
})

describe('ブーリアン演算の元の図形の数', () => {
  it('演算に入る子（見えていて、テキストでないもの。入れ子の演算も 1 個）だけを数える', () => {
    const op = frame({ id: 'op', children: ['a', 'hidden', 'label', 'inner', 'gone'], booleanOperation: 'union' })
    const inner = frame({ id: 'inner', parentId: 'op', children: ['b'], booleanOperation: 'subtract' })
    const scene = sceneOf(
      op,
      rect({ id: 'a', parentId: 'op' }),
      rect({ id: 'hidden', parentId: 'op', visible: false }),
      text({ id: 'label', parentId: 'op' }),
      inner,
      rect({ id: 'b', parentId: 'inner' }),
    )
    expect(rowsOf(scene, 'op', 'ブーリアン演算')).toEqual(['演算=合体', '元の図形=2 個'])
  })
})
