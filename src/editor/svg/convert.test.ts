import { describe, expect, it } from 'vitest'
import { kdrFile, parseKdr } from '../../document/kdr.ts'
import { pathPoints } from '../../document/path.ts'
import type { FrameNode, ImageNode, PathNode, RectNode, SceneNode, TextNode } from '../../document/types.ts'
import { createDocument, pasteIntoPage } from '../operations/document.ts'
import { type SvgImport, convertSvg } from './convert.ts'
import { parseTransform } from './values.ts'
import { SvgParseError, parseSvgXml } from './xml.ts'

// テキストの大きさの見積もり（Canvas がないので仮のもの）
const measureText = (node: TextNode) => ({
  width: Math.ceil(Math.max(...node.text.split('\n').map((line) => line.length)) * node.fontSize * 0.5),
  height: Math.ceil(node.text.split('\n').length * node.fontSize * node.lineHeight),
})

function convert(source: string): SvgImport {
  return convertSvg(parseSvgXml(source), { name: 'drawing', measureText })
}

function rootOf(result: SvgImport): FrameNode {
  return result.fragment.nodes[result.fragment.rootIds[0]] as FrameNode
}

/** 根のフレームの子（重なり順） */
function children(result: SvgImport, parent: FrameNode = rootOf(result)): SceneNode[] {
  return parent.children.map((id) => result.fragment.nodes[id])
}

function labels(result: SvgImport): string[] {
  return result.warnings.map((warning) => warning.label)
}

const close = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 4)

describe('根のフレーム', () => {
  it('stroke-linecap の round / square は開いたパスの両端の形になる。閉じた形と butt はそのまま', () => {
    const result = convert(
      '<svg width="100" height="100"><g stroke="#000" stroke-linecap="round"><line x1="0" y1="0" x2="50" y2="0"/>' +
        '<polyline points="0,10 20,30 40,10" stroke-linecap="square" fill="none"/><polygon points="0,50 20,50 10,60"/>' +
        '<line x1="0" y1="90" x2="50" y2="90" stroke-linecap="butt"/></g></svg>',
    )
    const [line, polyline, polygon, butt] = children(result).flatMap((node) => (node.type === 'frame' ? children(result, node) : [node]))
    expect(line).toMatchObject({ type: 'path', startCap: 'round', endCap: 'round' })
    expect(polyline).toMatchObject({ startCap: 'square', endCap: 'square' })
    expect(polygon).toMatchObject({ closed: true, startCap: 'none', endCap: 'none' })
    expect(butt).toMatchObject({ startCap: 'none', endCap: 'none' })
  })

  it('width / height と viewBox から大きさと縮尺を決める', () => {
    const result = convert('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 50"><rect x="10" y="10" width="20" height="10"/></svg>')
    const root = rootOf(result)
    expect(root).toMatchObject({ type: 'frame', name: 'drawing', x: 0, y: 0, width: 200, height: 100, clipContent: true, fills: [] })
    expect(children(result)[0]).toMatchObject({ type: 'rect', x: 20, y: 20, width: 40, height: 20 })
  })

  it('大きさの指定がなければ viewBox の大きさ、どちらもなければ 300 × 150', () => {
    expect(rootOf(convert('<svg viewBox="5 5 40 30"/>'))).toMatchObject({ width: 40, height: 30 })
    expect(rootOf(convert('<svg/>'))).toMatchObject({ width: 300, height: 150 })
  })

  it('縦横比の違う viewBox は、既定（xMidYMid meet）どおり中央に収める', () => {
    const result = convert('<svg width="200" height="100" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
    expect(children(result)[0]).toMatchObject({ x: 50, y: 0, width: 100, height: 100 })
  })
})

describe('path の d', () => {
  it('曲線のコマンドを、制御点つきの頂点にする', () => {
    const result = convert('<svg><path id="wave" d="M0 0 C10 -10 20 -10 30 0 S50 10 60 0" fill="none" stroke="#ff0000"/></svg>')
    const path = children(result)[0] as PathNode
    expect(path).toMatchObject({ type: 'path', name: 'wave', closed: false, fills: [], strokes: [{ type: 'solid', color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const }] })
    const points = pathPoints(path).map((p) => ({ ...p, x: p.x + path.x, y: p.y + path.y }))
    expect(points).toHaveLength(3)
    // S の 1 つ目の制御点は、前の曲線の 2 つ目の制御点を折り返したもの
    close(points[1].x, 30)
    close(points[1].out!.x + path.x, 40)
    close(points[1].out!.y + path.y, 10)
  })

  it('相対コマンドは絶対コマンドと同じ形になる', () => {
    const absolute = children(convert('<svg><path d="M10 10 C20 0 30 0 40 10 Q50 20 60 10 L60 40 Z"/></svg>'))[0] as PathNode
    const relative = children(convert('<svg><path d="m10 10 c10 -10 20 -10 30 0 q10 10 20 0 l0 30 z"/></svg>'))[0] as PathNode
    expect(relative.x).toBeCloseTo(absolute.x)
    expect(relative.width).toBeCloseTo(absolute.width)
    expect(relative.points).toHaveLength(absolute.points.length)
    relative.points.forEach((point, i) => {
      close(point.x, absolute.points[i].x)
      close(point.y, absolute.points[i].y)
    })
    expect(relative.closed).toBe(true)
  })

  it('Q は 3 次の曲線に、A は 90° 以下に分けた 3 次の曲線に直す', () => {
    const quad = children(convert('<svg><path d="M0 0 Q50 100 100 0"/></svg>'))[0] as PathNode
    expect(quad.points[0].out).toBeDefined()
    expect(quad.points[1].in).toBeDefined()
    // 半円の弧は 2 つの曲線（頂点 3 つ）
    const arc = children(convert('<svg><path d="M0 50 A50 50 0 0 1 100 50"/></svg>'))[0] as PathNode
    expect(arc.points).toHaveLength(3)
    expect(arc).toMatchObject({ width: 100 })
    close(arc.height, 50)
  })

  it('輪郭が複数なら 1 つのパスの輪郭（contours）にし、fill-rule を写す', () => {
    const result = convert(
      '<svg><path id="ring" fill-rule="evenodd" d="M0 0 H100 V100 H0 Z M25 25 H75 V75 H25 Z"/>' +
        '<path d="M0 0 H10 V10 Z m20 0 h10 v10 z"/></svg>',
    )
    const [ring, two] = children(result) as PathNode[]
    expect(ring).toMatchObject({ type: 'path', name: 'ring', x: 0, y: 0, width: 100, height: 100, closed: true, fillRule: 'evenodd' })
    expect(ring.contours).toEqual([
      { points: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 }], closed: true },
    ])
    // fill-rule の既定は nonzero（向きの同じ輪郭は塗りつぶされ、逆向きなら穴になる）
    expect(two).toMatchObject({ fillRule: 'nonzero', x: 0, width: 30 })
    expect(two.contours).toHaveLength(1)
    expect(labels(result)).toEqual([])
  })

  it('1 つの輪郭の polygon も fill-rule を写す（自分と交わる星形の真ん中が抜ける）', () => {
    const result = convert('<svg><polygon fill-rule="evenodd" points="50,0 79,90 2,35 98,35 21,90"/></svg>')
    expect(children(result)[0]).toMatchObject({ type: 'path', fillRule: 'evenodd', contours: [] })
  })

  it('読めない d は読み飛ばして知らせる', () => {
    const result = convert('<svg><path d="M0 0 X10"/><rect width="10" height="10"/></svg>')
    expect(children(result).map((node) => node.type)).toEqual(['rect'])
    expect(labels(result)).toContain('読めない path の d（読み飛ばした）')
  })
})

describe('transform の合成', () => {
  it('transform 属性の関数を左から外側として合成する', () => {
    const m = parseTransform('translate(10, 20) scale(2)')!
    expect([...m]).toEqual([2, 0, 0, 2, 10, 20])
    const rotated = parseTransform('rotate(90 10 10)')!
    close(rotated[4], 20)
    close(rotated[5], 0)
    expect(parseTransform('translate(10) bogus(1)')).toBeNull()
  })

  it('g の transform と図形の transform を重ねて、図形の位置と大きさに焼き込む', () => {
    const result = convert(
      '<svg><g id="layer" transform="translate(10 20)"><rect transform="scale(2)" x="5" y="5" width="10" height="10"/></g></svg>',
    )
    const group = children(result)[0] as FrameNode
    expect(group).toMatchObject({ type: 'frame', name: 'layer', x: 20, y: 30, width: 20, height: 20, clipContent: false, fills: [] })
    expect(children(result, group)[0]).toMatchObject({ type: 'rect', x: 0, y: 0, width: 20, height: 20, parentId: group.id })
  })

  it('回転は矩形や楕円の rotation になる', () => {
    const result = convert('<svg><rect transform="rotate(45 50 50)" x="40" y="45" width="20" height="10"/><ellipse transform="rotate(-30)" cx="10" cy="0" rx="5" ry="3"/></svg>')
    const [rect, ellipse] = children(result)
    expect(rect).toMatchObject({ type: 'rect', x: 40, y: 45, width: 20, height: 10, rotation: 45 })
    expect(ellipse).toMatchObject({ type: 'ellipse', width: 10, height: 6, rotation: -30 })
  })

  it('歪めた矩形や円はパスにする', () => {
    const result = convert('<svg><rect transform="skewX(30)" width="10" height="10"/><circle transform="scale(-1 1)" cx="-10" cy="10" r="5"/></svg>')
    const [rect, circle] = children(result)
    expect(rect).toMatchObject({ type: 'path', closed: true, name: 'Rectangle' })
    expect((rect as PathNode).points).toHaveLength(4)
    expect(circle).toMatchObject({ type: 'path', closed: true, x: 5, y: 5, width: 10, height: 10 })
  })

  it('線の太さと文字の大きさに拡大をかける', () => {
    const result = convert('<svg><g transform="scale(3)"><line x1="0" y1="0" x2="10" y2="0" stroke="black" stroke-width="2"/><text x="0" y="20" font-size="10">Hi</text></g></svg>')
    const [line, text] = children(result, children(result)[0] as FrameNode)
    expect(line).toMatchObject({ type: 'path', strokeWidth: 6, fills: [] })
    expect(text).toMatchObject({ type: 'text', fontSize: 30, text: 'Hi' })
  })
})

describe('塗りと線', () => {
  it('fill / stroke / opacity を属性と style 属性から読み、style 属性を優先する', () => {
    const result = convert(
      '<svg><g fill="red"><rect width="10" height="10" style="fill: #00f; stroke: rgb(0, 128, 0); stroke-width: 3" opacity="0.5"/><circle r="5" cx="5" cy="5"/></g></svg>',
    )
    const [rect, circle] = children(result, children(result)[0] as FrameNode)
    expect(rect).toMatchObject({ fills: [{ type: 'solid', color: '#0000ff' }], strokes: [{ type: 'solid', color: '#008000' }], strokeWidth: 3, opacity: 0.5, visible: true, blendMode: 'normal' as const })
    // 塗りは親から受け継ぐ。何も指定しなければ黒
    expect(circle).toMatchObject({ fills: [{ type: 'solid', color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const }], strokes: [] })
    expect(children(convert('<svg><rect width="1" height="1"/></svg>'))[0]).toMatchObject({ fills: [{ type: 'solid', color: '#000000', opacity: 1, visible: true, blendMode: 'normal' as const }] })
  })

  it('fill-opacity・stroke-opacity・半透明の色・揃った stop-opacity は塗りごとの不透明度に写す（ノードの opacity は 1 のまま）', () => {
    const result = convert(`<svg>
      <defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000" stop-opacity="0.5"/><stop offset="1" stop-color="#0000ff" stop-opacity="0.5"/></linearGradient></defs>
      <rect width="10" height="10" fill="#ff000080"/>
      <rect width="10" height="10" fill="blue" fill-opacity="0.25" stroke="red" stroke-opacity="0.5"/>
      <rect width="10" height="10" fill="url(#g)"/>
    </svg>`)
    const [a, b, c] = children(result) as RectNode[]
    expect(a.opacity).toBe(1)
    expect(a.fills[0].opacity).toBeCloseTo(128 / 255, 3)
    expect(b.opacity).toBe(1)
    expect(b.fills[0].opacity).toBe(0.25)
    expect(b.strokes[0].opacity).toBe(0.5)
    expect(c.fills[0]).toMatchObject({ type: 'linear', opacity: 0.5 })
    expect(result.warnings).toEqual([])
  })

  it('linearGradient を直線状のグラデーションにし、始点と終点を枠に対する割合にする', () => {
    const result = convert(`<svg>
      <defs>
        <linearGradient id="g1"><stop offset="0" stop-color="#ff0000"/><stop offset="1" style="stop-color: #0000ff"/></linearGradient>
        <linearGradient id="g2" href="#g1" x1="25%" x2="75%"/>
        <linearGradient id="g3" xlink:href="#g1" x1="0" y1="0" x2="0" y2="1"/>
      </defs>
      <rect width="100" height="50" fill="url(#g1)"/>
      <rect width="100" height="50" fill="url('#g2')"/>
      <rect width="100" height="50" fill="url(#g3)"/>
    </svg>`)
    const [a, b, c] = children(result) as Extract<SceneNode, { fills: unknown }>[]
    const stops = [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }]
    expect(a.fills).toEqual([{ type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops, opacity: 1, visible: true, blendMode: 'normal' as const }])
    expect(b.fills).toEqual([{ type: 'linear', x1: 0.25, y1: 0, x2: 0.75, y2: 0, stops, opacity: 1, visible: true, blendMode: 'normal' as const }])
    expect(c.fills).toEqual([{ type: 'linear', x1: 0, y1: 0, x2: 0, y2: 1, stops, opacity: 1, visible: true, blendMode: 'normal' as const }])
  })

  it('円形のグラデーションは、中心と半径を枠に対する割合にする', () => {
    const result = convert(`<svg>
      <radialGradient id="r"><stop offset="0" stop-color="gold"/><stop offset="1" stop-color="black"/></radialGradient>
      <radialGradient id="u" gradientUnits="userSpaceOnUse" cx="25" cy="10" r="20" href="#r"/>
      <radialGradient id="f" fx="0.2" href="#r"/>
      <circle r="5" fill="url(#r)"/>
      <rect width="100" height="50" fill="url(#u)"/>
      <rect width="100" height="50" fill="url(#f)"/>
    </svg>`)
    const [circle, rect, focal] = children(result) as Extract<SceneNode, { fills: unknown }>[]
    const stops = [{ offset: 0, color: '#ffd700' }, { offset: 1, color: '#000000' }]
    expect(circle.fills).toEqual([{ type: 'radial', cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops, opacity: 1, visible: true, angle: 0, blendMode: 'normal' as const }])
    expect(rect.fills).toEqual([{ type: 'radial', cx: 0.25, cy: 0.2, rx: 0.2, ry: 0.4, stops, opacity: 1, visible: true, angle: 0, blendMode: 'normal' as const }])
    expect(focal.fills).toEqual([{ type: 'radial', cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops, opacity: 1, visible: true, angle: 0, blendMode: 'normal' as const }])
    expect(labels(result)).toContain('円形のグラデーションの焦点（中心に寄せた）')
  })
})

describe('危険なもの・表せないもの', () => {
  it('スクリプト・foreignObject・外部参照は読まずに知らせる', () => {
    const result = convert(`<svg xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">
      <script>alert(1)</script>
      <script><![CDATA[ if (a < b) alert(2) ]]></script>
      <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><rect width="9" height="9"/></div></foreignObject>
      <image href="https://example.com/a.png" width="10" height="10"/>
      <use xlink:href="https://example.com/sprite.svg#icon"/>
      <rect width="10" height="10" fill="url(https://example.com/x.svg#g) #00ff00" onclick="alert(3)"/>
      <rect width="10" height="10" fill="url(other.svg#g)"/>
    </svg>`)
    const nodes = Object.values(result.fragment.nodes)
    // 根のフレームと、外部の塗りの代わりの色を付けた矩形と、塗りのない矩形だけ
    expect(nodes.map((node) => node.type).sort()).toEqual(['frame', 'rect', 'rect'])
    const [fallback, empty] = children(result)
    expect(fallback).toMatchObject({ fills: [{ type: 'solid', color: '#00ff00', opacity: 1, visible: true, blendMode: 'normal' as const }] })
    expect(empty).toMatchObject({ fills: [] })
    expect(labels(result)).toEqual(
      expect.arrayContaining(['スクリプト（<script>）', '埋め込み HTML（<foreignObject>）', '外部の画像（<image>。読まなかった）', '外部への参照（読まなかった）']),
    )
    expect(result.warnings.find((warning) => warning.label === 'スクリプト（<script>）')?.count).toBe(2)
    // SVG の文字そのものはどこにも残らない
    expect(JSON.stringify(result.fragment)).not.toMatch(/alert|example\.com|onload|onclick/)
  })

  it('外部を href で参照するグラデーションは、1 つにつき 1 回だけ知らせる', () => {
    const result = convert(`<svg width="10" height="10">
      <defs><linearGradient id="g" href="other.svg#base"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>
      <rect width="10" height="10" fill="url(#g)"/>
    </svg>`)
    expect(result.warnings.find((warning) => warning.label === '外部への参照（読まなかった）')?.count).toBe(1)
    expect(children(result)[0]).toMatchObject({ fills: [{ type: 'linear' }] })
  })

  it('図形の数が上限（20000）に達したら、後の要素は読まない。超える分は読みかけの図形と入れ子のフレームだけ', () => {
    const rects = Array.from({ length: 20_010 }, (_, i) => `<rect x="${i % 100}" width="1" height="1"/>`).join('')
    const result = convert(`<svg width="100" height="100"><g opacity="0.5"><g opacity="0.5">${rects}</g></g></svg>`)
    // 読みかけの矩形 1 つ、グループのフレーム 2 つ、根のフレーム 1 つ
    expect(Object.keys(result.fragment.nodes).length).toBe(20_004)
    expect(result.warnings.find((warning) => warning.label.startsWith('20000 個を超えた分'))?.count).toBe(1)
    // 親子のつながりは切れていない
    for (const node of Object.values(result.fragment.nodes)) {
      if (node.parentId !== null) expect(result.fragment.nodes[node.parentId]).toBeDefined()
      if (node.type === 'frame') for (const child of node.children) expect(result.fragment.nodes[child]?.parentId).toBe(node.id)
    }
  })

  it('ENTITY を定義した SVG は読まない', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><svg><text>&b;</text></svg>'
    expect(() => parseSvgXml(bomb)).toThrow(SvgParseError)
  })

  it('フィルタ・マスク・クリップパス・パターン・知らない要素は、図形を残して知らせる', () => {
    const result = convert(`<svg>
      <defs><filter id="f"/><mask id="m"/><clipPath id="c"/><pattern id="p"/></defs>
      <rect width="10" height="10" filter="url(#f)" mask="url(#m)" style="clip-path: url(#c)"/>
      <rect width="10" height="10" fill="url(#p) red"/>
      <circle r="4" fill="url(#missing)"/>
      <textPath/>
    </svg>`)
    expect(children(result).map((node) => node.type)).toEqual(['rect', 'rect', 'ellipse'])
    expect(children(result)[1]).toMatchObject({ fills: [{ type: 'solid', color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const }] })
    expect(children(result)[2]).toMatchObject({ fills: [] })
    expect(labels(result)).toEqual([
      'フィルタ',
      'クリップパス（読めない中身。かけなかった）',
      'マスク（読めない中身。かけなかった）',
      'パターンの塗り',
      'たどれない塗りの参照',
      '線に沿った文字（<textPath>）',
    ])
  })

  it('use は中の参照をたどって複製し、循環する参照は止める', () => {
    const result = convert(`<svg>
      <defs><symbol id="dot" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></symbol></defs>
      <use href="#dot" x="20" y="0" width="20" height="20"/>
      <g id="loop"><use href="#loop"/><rect width="1" height="1"/></g>
    </svg>`)
    const [dot, loop] = children(result) as FrameNode[]
    expect(dot).toMatchObject({ type: 'frame', name: 'dot', x: 20, y: 0, width: 20, height: 20 })
    expect(children(result, dot)[0]).toMatchObject({ type: 'ellipse', x: 0, y: 0, width: 20, height: 20 })
    expect(loop).toMatchObject({ name: 'loop' })
    expect(labels(result)).toContain('たどれない <use> の参照')
  })

  it('display: none は読み飛ばし、visibility: hidden は非表示のノードにする', () => {
    const result = convert('<svg><rect width="1" height="1" display="none"/><rect width="1" height="1" style="visibility:hidden"/></svg>')
    expect(children(result)).toHaveLength(1)
    expect(children(result)[0].visible).toBe(false)
  })
})

// 1x1 の透明な PNG
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('CSS（<style>）', () => {
  it('要素名・.class・#id のセレクタを詳細度と書いた順で重ね、style 属性と !important の優先を守る', () => {
    const result = convert(`<svg>
      <style><![CDATA[
        /* Illustrator の書き出しの形 */
        .st0 { fill: #ff0000; stroke: #000; stroke-width: 2 }
        rect { fill: #00ff00 }
        .st1, #special { fill: #0000ff }
        rect.st0.big { stroke-width: 4 }
        .strong { fill: #123456 !important }
        g .nested { fill: #ffffff }
        @media print { rect { fill: #999999 } }
      ]]></style>
      <rect class="st0" width="10" height="10"/>
      <rect width="10" height="10" fill="#abcdef"/>
      <rect id="special" class="st0" width="10" height="10"/>
      <rect class="st0 big" width="10" height="10"/>
      <rect class="st1" width="10" height="10" style="fill: #fedcba"/>
      <rect class="strong" width="10" height="10" style="fill: #fedcba"/>
    </svg>`)
    const [st0, attribute, special, big, styled, strong] = children(result) as PathNode[]
    // クラスは要素名より強い
    expect(st0).toMatchObject({ fills: [{ type: 'solid', color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const }], strokes: [{ type: 'solid', color: '#000000', opacity: 1, visible: true, blendMode: 'normal' as const }], strokeWidth: 2 })
    // CSS は属性より強い
    expect(attribute.fills).toEqual([{ type: 'solid', color: '#00ff00', opacity: 1, visible: true, blendMode: 'normal' as const }])
    // #id はクラスより強い
    expect(special.fills).toEqual([{ type: 'solid', color: '#0000ff', opacity: 1, visible: true, blendMode: 'normal' as const }])
    expect(big.strokeWidth).toBe(4)
    // style 属性は CSS より強く、!important は style 属性より強い
    expect(styled.fills).toEqual([{ type: 'solid', color: '#fedcba', opacity: 1, visible: true, blendMode: 'normal' as const }])
    expect(strong.fills).toEqual([{ type: 'solid', color: '#123456', opacity: 1, visible: true, blendMode: 'normal' as const }])
    expect(labels(result)).toEqual(['CSS の @ で始まる規則（読み飛ばした）'])
  })

  it('子孫・子・隣・兄弟の結合子と、属性のセレクタを読む', () => {
    const result = convert(`<svg>
      <style>
        g rect { fill: #110000 }
        #outer > rect { fill: #220000 }
        .first + rect { fill: #330000 }
        .first ~ circle { fill: #440000 }
        [data-kind] { stroke: #000000 }
        [data-kind="b" i] { stroke-width: 3 }
        [class~="tag"] { fill: #550000 }
        [id^="pre"][id$="post"] { fill: #660000 }
        [lang|="ja"] { fill: #770000 }
        [data-kind*="xx"] { opacity: 0.5 }
      </style>
      <g id="outer">
        <rect width="1" height="1"/>
        <g><rect width="1" height="1"/></g>
      </g>
      <rect class="first" width="1" height="1"/>
      <rect width="1" height="1"/>
      <circle r="1"/>
      <rect data-kind="a" width="1" height="1"/>
      <rect data-kind="B" width="1" height="1"/>
      <rect class="one tag" width="1" height="1"/>
      <rect id="pre-mid-post" width="1" height="1"/>
      <rect lang="ja-JP" width="1" height="1"/>
      <rect data-kind="axxb" width="1" height="1"/>
    </svg>`)
    const [outer, first, adjacent, sibling, kindA, kindB, tag, affix, lang, contains] = children(result) as PathNode[]
    const color = (node: SceneNode) => ('fills' in node ? node.fills[0] : undefined)
    const [direct, group] = children(result, outer as unknown as FrameNode)
    // 子の結合子（#outer > rect）は子孫（g rect）より詳細度が高い
    expect(color(direct)).toMatchObject({ color: '#220000' })
    expect(color(children(result, group as FrameNode)[0])).toMatchObject({ color: '#110000' })
    expect(color(first)).toMatchObject({ color: '#000000' })
    expect(color(adjacent)).toMatchObject({ color: '#330000' })
    expect(color(sibling)).toMatchObject({ color: '#440000' })
    expect(kindA).toMatchObject({ strokes: [{ color: '#000000' }], strokeWidth: 1 })
    expect(kindB).toMatchObject({ strokes: [{ color: '#000000' }], strokeWidth: 3 })
    expect(color(tag)).toMatchObject({ color: '#550000' })
    expect(color(affix)).toMatchObject({ color: '#660000' })
    expect(color(lang)).toMatchObject({ color: '#770000' })
    expect(contains.opacity).toBe(0.5)
    expect(result.warnings).toEqual([])
  })

  it('静的に決まる疑似クラスを読み、:hover の規則は当てず、読めないセレクタだけを数える', () => {
    const result = convert(`<svg>
      <style>
        rect:first-child { fill: #010000 }
        rect:nth-child(2n+4) { fill: #020000 }
        rect:nth-last-child(1) { fill: #030000 }
        circle:first-of-type { fill: #040000 }
        circle:only-of-type { stroke: #050000 }
        rect:not(.keep, #keep2) { opacity: 0.5 }
        :is(.x, .y) { stroke: #070000 }
        :root { fill: #060000 }
        rect:hover { fill: #ff0000 }
        rect::before { fill: #ff0000 }
        g:has(rect) { fill: #ff0000 }
      </style>
      <g>
        <rect class="keep" width="1" height="1"/>
        <rect id="keep2" width="1" height="1"/>
        <circle r="1"/>
        <rect class="x" width="1" height="1"/>
        <path class="y" d="M0 0 L1 1"/>
        <rect width="1" height="1"/>
      </g>
    </svg>`)
    // <style> も兄弟に数えるので、図形は g の中に置く
    const [group] = children(result) as FrameNode[]
    const [first, second, circle, fourth, path, last] = children(result, group) as PathNode[]
    expect(first).toMatchObject({ fills: [{ color: '#010000' }], opacity: 1 })
    // 根の :root の塗りを受け継ぐ
    expect(second).toMatchObject({ fills: [{ color: '#060000' }], opacity: 1 })
    expect(circle).toMatchObject({ fills: [{ color: '#040000' }], strokes: [{ color: '#050000' }] })
    expect(fourth).toMatchObject({ fills: [{ color: '#020000' }], strokes: [{ color: '#070000' }], opacity: 0.5 })
    expect(path.strokes).toMatchObject([{ color: '#070000' }])
    expect(last).toMatchObject({ fills: [{ color: '#030000' }], opacity: 0.5 })
    expect(result.warnings).toEqual([{ label: 'CSS の複雑なセレクタ（読み飛ばした）', count: 2 }])
  })

  it('子孫の結合子が続く長いセレクタも、深い入れ子ですぐに照合できる', () => {
    const depth = 40
    const source = `<svg><style>${'g '.repeat(30)}rect { fill: #123456 } ${'g '.repeat(depth + 1)}rect { fill: #ff0000 }</style>${'<g>'.repeat(depth)}<rect width="1" height="1"/>${'</g>'.repeat(depth)}</svg>`
    const started = performance.now()
    const result = convert(source)
    expect(performance.now() - started).toBeLessThan(2000)
    const rect = Object.values(result.fragment.nodes).find((node) => node.type === 'rect') as RectNode
    expect(rect.fills).toMatchObject([{ color: '#123456' }])
  })

  it('CSS の値は受け継がれ、グラデーションの色や不透明度・表示にも効く', () => {
    const result = convert(`<svg>
      <style>.parent { fill: #00ff00 } .s1 { stop-color: #ff0000 } .s2 { stop-color: #0000ff } .half { opacity: .5 } .gone { display: none }</style>
      <linearGradient id="g"><stop class="s1" offset="0"/><stop class="s2" offset="1"/></linearGradient>
      <g class="parent"><rect width="10" height="10"/></g>
      <rect width="10" height="10" fill="url(#g)" class="half"/>
      <rect width="10" height="10" class="gone"/>
    </svg>`)
    const [group, gradient] = children(result)
    expect(children(result, group as FrameNode)[0]).toMatchObject({ fills: [{ type: 'solid', color: '#00ff00', opacity: 1, visible: true, blendMode: 'normal' as const }] })
    expect(gradient).toMatchObject({ opacity: 0.5 })
    expect((gradient as PathNode).fills[0]).toMatchObject({ type: 'linear', stops: [{ color: '#ff0000' }, { color: '#0000ff' }] })
    expect(children(result)).toHaveLength(2)
  })
})

describe('破線', () => {
  it('stroke-dasharray を線の破線にし、奇数個なら繰り返し、拡大に合わせる', () => {
    const result = convert(`<svg>
      <line x2="100" stroke="#000" stroke-dasharray="4 2"/>
      <rect width="10" height="10" stroke="#000" stroke-dasharray="3" transform="scale(2)"/>
      <circle r="5" stroke="#000" style="stroke-dasharray: 1, 2, 3" stroke-dashoffset="2"/>
      <line x2="100" stroke="#000" stroke-dasharray="4 -1"/>
      <rect width="10" height="10" stroke-dasharray="4"/>
    </svg>`)
    const [line, rect, circle, invalid, noStroke] = children(result) as PathNode[]
    expect(line.strokeDashes).toEqual([4, 2])
    expect(rect).toMatchObject({ type: 'rect', strokeDashes: [6, 6] })
    expect(circle.strokeDashes).toEqual([1, 2, 3, 1, 2, 3])
    // 負の数は SVG と同じく実線、線のない図形には付けない
    expect(invalid.strokeDashes).toEqual([])
    expect(noStroke.strokeDashes).toEqual([])
    expect(labels(result)).toEqual(['破線のずれ（stroke-dashoffset。0 にした）'])
  })
})

describe('クリップとマスク', () => {
  it('矩形の clip-path は切り取るフレームに、円は角丸のフレームにする', () => {
    const result = convert(`<svg width="200" height="200">
      <defs>
        <clipPath id="box"><rect x="10" y="10" width="50" height="40" rx="5"/></clipPath>
        <clipPath id="round"><circle cx="100" cy="100" r="20"/></clipPath>
      </defs>
      <g clip-path="url(#box)"><rect width="200" height="200" fill="red"/></g>
      <rect x="50" y="50" width="200" height="200" style="clip-path: url(#round)"/>
    </svg>`)
    const [box, round] = children(result) as FrameNode[]
    expect(box).toMatchObject({ type: 'frame', name: 'box', x: 10, y: 10, width: 50, height: 40, clipContent: true, cornerRadius: 5, fills: [] })
    const group = children(result, box)[0] as FrameNode
    expect(group).toMatchObject({ type: 'frame', x: -10, y: -10 })
    expect(round).toMatchObject({ name: 'round', x: 80, y: 80, width: 40, height: 40, cornerRadius: 20 })
    expect(children(result, round)[0]).toMatchObject({ type: 'rect', x: -30, y: -30 })
    expect(labels(result)).toEqual([])
  })

  it('clip-path は図形の transform のあとの座標で、clipPath の transform も重ねる', () => {
    const result = convert(`<svg>
      <clipPath id="c" transform="translate(5 0)"><rect width="10" height="10"/></clipPath>
      <rect width="100" height="100" transform="translate(20 20) scale(2)" clip-path="url(#c)"/>
    </svg>`)
    expect(children(result)[0]).toMatchObject({ type: 'frame', x: 30, y: 20, width: 20, height: 20 })
  })

  it('白い矩形のマスクは切り取り、灰色なら明るさを不透明度にする。たどれないものはかけずに知らせる', () => {
    const result = convert(`<svg>
      <mask id="white"><rect width="50" height="50" fill="#fff"/></mask>
      <mask id="gray"><rect width="50" height="50" fill="#808080"/></mask>
      <rect width="100" height="100" mask="url(#white)"/>
      <rect width="100" height="100" mask="url(#gray)"/>
      <rect width="100" height="100" clip-path="url(#nothing)"/>
    </svg>`)
    const [white, gray, nothing] = children(result)
    expect(white).toMatchObject({ type: 'frame', name: 'white', width: 50, height: 50, opacity: 1 })
    expect(gray.type).toBe('frame')
    expect(gray.opacity).toBeCloseTo(0.502, 2)
    expect(nothing.type).toBe('rect')
    expect(labels(result)).toEqual(['たどれないクリップパスの参照'])
  })

  it('矩形・円で表せない形は、マスク（isMask）のパスにして中身と一緒にフレームにまとめる', () => {
    const result = convert(`<svg>
      <mask id="tilted"><rect width="50" height="50" fill="#fff" transform="rotate(30)"/></mask>
      <clipPath id="oval"><ellipse rx="20" ry="10"/></clipPath>
      <clipPath id="tri"><path d="M0 0 L100 0 L50 80 Z"/></clipPath>
      <rect width="100" height="100" mask="url(#tilted)"/>
      <rect width="100" height="100" clip-path="url(#oval)"/>
      <rect id="r" width="100" height="100" clip-path="url(#tri)"/>
    </svg>`)
    const [tilted, oval, tri] = children(result) as FrameNode[]
    for (const frame of [tilted, oval, tri]) {
      expect(frame).toMatchObject({ type: 'frame', clipContent: false, fills: [] })
      const [mask, content] = children(result, frame)
      expect(mask).toMatchObject({ type: 'path', isMask: true, strokes: [] })
      expect(content.type).toBe('rect')
    }
    expect(tilted.name).toBe('tilted')
    // 楕円は中心 (0, 0) の半径 20 × 10。フレームは中身（0〜100）を囲み、マスクはその外にはみ出してよい
    const ovalMask = children(result, oval)[0] as PathNode
    expect(oval).toMatchObject({ x: 0, y: 0, width: 100, height: 100 })
    expect(ovalMask).toMatchObject({ x: -20, y: -10, width: 40, height: 20 })
    const triMask = children(result, tri)[0] as PathNode
    expect(triMask).toMatchObject({ name: 'tri', x: 0, y: 0, width: 100, height: 80, closed: true })
    expect(result.warnings).toEqual([])
  })

  it('g の clip-path はグループのフレームの最背面にマスクを入れる。objectBoundingBox は中身の枠の割合', () => {
    const result = convert(`<svg>
      <clipPath id="half" clipPathUnits="objectBoundingBox"><polygon points="0,0 1,0 0,1"/></clipPath>
      <g id="layer" clip-path="url(#half)"><rect x="10" y="10" width="40" height="20"/><rect x="10" y="30" width="40" height="20"/></g>
    </svg>`)
    const [layer] = children(result) as FrameNode[]
    expect(layer).toMatchObject({ type: 'frame', name: 'layer', x: 10, y: 10, width: 40, height: 40 })
    const [mask, a, b] = children(result, layer)
    expect(mask).toMatchObject({ type: 'path', isMask: true, x: 0, y: 0, width: 40, height: 40 })
    expect([a.type, b.type]).toEqual(['rect', 'rect'])
  })

  it('白い形のあとの黒い形はマスクの穴（evenodd）にし、半端な明るさは形だけかけて知らせる', () => {
    const result = convert(`<svg>
      <mask id="ring"><circle cx="50" cy="50" r="40" fill="white"/><circle cx="50" cy="50" r="20" fill="black"/></mask>
      <mask id="mixed"><circle cx="50" cy="50" r="40" fill="white"/><circle cx="20" cy="20" r="10" fill="#808080"/></mask>
      <rect width="100" height="100" mask="url(#ring)"/>
      <rect width="100" height="100" mask="url(#mixed)"/>
    </svg>`)
    const [ring, mixed] = children(result) as FrameNode[]
    const ringMask = children(result, ring)[0] as PathNode
    expect(ringMask).toMatchObject({ isMask: true, fillRule: 'evenodd' })
    expect(ringMask.contours).toHaveLength(1)
    expect(ring.opacity).toBe(1)
    expect(children(result, mixed)[0]).toMatchObject({ isMask: true, fillRule: 'nonzero' })
    expect(labels(result)).toEqual(['明るさが半端なマスク（形だけかけた）'])
  })
})

describe('画像（<image>）', () => {
  it('data URI の PNG を画像のノードにし、preserveAspectRatio を収め方にする', () => {
    const result = convert(`<svg xmlns:xlink="http://www.w3.org/1999/xlink">
      <image id="photo" x="10" y="20" width="40" height="30" xlink:href="data:image/png;base64,${PNG_BASE64}"/>
      <image href="data:image/png;base64,${PNG_BASE64}" preserveAspectRatio="xMinYMax slice" transform="scale(3)"/>
      <image href="data:image/png;base64,${PNG_BASE64}" width="10" height="10" preserveAspectRatio="none"/>
    </svg>`)
    const [photo, intrinsic, stretched] = children(result) as ImageNode[]
    expect(photo).toMatchObject({ type: 'image', name: 'photo', x: 10, y: 20, width: 40, height: 30, fit: 'contain', positionX: 0.5, positionY: 0.5 })
    // 大きさの指定がなければ元の大きさ（1 × 1）に拡大がかかる
    expect(intrinsic).toMatchObject({ width: 3, height: 3, fit: 'cover', positionX: 0, positionY: 1 })
    expect(stretched.fit).toBe('stretch')
    // 同じ画像は 1 つのアセットにまとめ、id は中身の SHA-256
    const ids = Object.keys(result.fragment.assets)
    expect(ids).toHaveLength(1)
    expect(ids[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(photo.assetId).toBe(ids[0])
    expect(result.fragment.assets[ids[0]].mime).toBe('image/png')
  })

  it('外部の URL・読めない SVG の画像・壊れた画像は読まずに知らせる', () => {
    const result = convert(`<svg>
      <image href="https://example.com/a.png" width="10" height="10"/>
      <image href="data:image/svg+xml;utf8,not%20svg" width="10" height="10"/>
      <image href="data:image/svg+xml,%3Cg%2F%3E" width="10" height="10"/>
      <image href="data:image/png;base64,AAAA" width="10" height="10"/>
      <image href="data:text/plain,hello" width="10" height="10"/>
    </svg>`)
    expect(children(result)).toHaveLength(0)
    expect(result.warnings).toEqual([
      { label: '外部の画像（<image>。読まなかった）', count: 1 },
      { label: '読めない SVG の画像（<image>。読み飛ばした）', count: 2 },
      { label: 'PNG・JPEG・WebP・GIF でない画像（<image>。読み飛ばした）', count: 2 },
    ])
  })

  it('SVG の画像は別の文書として変換し、<image> の枠に preserveAspectRatio で収めて切り取るフレームにする', () => {
    const inner = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><style>.a { fill: #00ff00 }</style>` +
      `<linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>` +
      `<rect class="a" width="10" height="10"/><rect id="r" x="10" width="10" height="10" fill="url(#g)"/></svg>`
    const base64 = btoa(inner)
    const result = convert(`<svg>
      <style>.a { fill: #ff00ff }</style>
      <linearGradient id="g"><stop offset="0" stop-color="#ffff00"/><stop offset="1" stop-color="#ffff00"/></linearGradient>
      <image id="pic" x="5" y="5" width="40" height="40" opacity="0.5" href="data:image/svg+xml;base64,${base64}"/>
      <image x="100" y="0" href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(inner)}" preserveAspectRatio="xMinYMin slice" width="10" height="10"/>
    </svg>`)
    const [pic, sliced] = children(result) as FrameNode[]
    // 枠は <image> の x・y・width・height。中身は 20 × 10 を 40 × 40 に収める（縦は真ん中に寄せる）
    expect(pic).toMatchObject({ type: 'frame', name: 'pic', x: 5, y: 5, width: 40, height: 40, clipContent: true, opacity: 0.5 })
    const [green, gradient] = children(result, pic) as RectNode[]
    expect(green).toMatchObject({ type: 'rect', x: 0, y: 10, width: 20, height: 20, fills: [{ color: '#00ff00' }] })
    // 中の id は中の文書でたどる（外側の同じ id のグラデーションではない）
    expect(gradient).toMatchObject({ x: 20, y: 10, width: 20, height: 20 })
    expect(gradient.fills[0]).toMatchObject({ type: 'linear', stops: [{ color: '#ff0000' }, { color: '#0000ff' }] })
    // slice は枠を覆うように拡大し、はみ出しはフレームが切り取る
    expect(sliced).toMatchObject({ x: 100, y: 0, width: 10, height: 10, clipContent: true })
    expect(children(result, sliced)[0]).toMatchObject({ x: 0, y: 0, width: 10, height: 10 })
    expect(result.warnings).toEqual([])
  })

  it('SVG の画像の中の外部の参照は読まず、入れ子は深さに上限を置く', () => {
    let source = '<svg width="10" height="10"><image href="https://example.com/x.png" width="1" height="1"/><rect width="10" height="10"/></svg>'
    for (let i = 0; i < 5; i++) {
      source = `<svg width="10" height="10"><image width="10" height="10" href="data:image/svg+xml;base64,${btoa(source)}"/><rect width="1" height="1"/></svg>`
    }
    const result = convert(source)
    expect(labels(result)).toEqual(['入れ子が深すぎる SVG の画像（<image>。読み飛ばした）'])
    let depth = 0
    let node: SceneNode = rootOf(result)
    while (node.type === 'frame' && node.children.length > 0) {
      node = result.fragment.nodes[node.children[0]]
      depth++
    }
    // 根の中に読めた 4 段の画像のフレームがあり、いちばん内側（5 段目）は読み飛ばしたので、4 段目の先頭は矩形
    expect(depth).toBe(5)
    expect(node.type).toBe('rect')
    const nested = convert(`<svg><image width="10" height="10" href="data:image/svg+xml;base64,${btoa('<svg width="10" height="10"><rect width="10" height="10"/><image href="https://example.com/x.png" width="1" height="1"/></svg>')}"/></svg>`)
    expect(labels(nested)).toEqual(['外部の画像（<image>。読まなかった）'])
  })

  it('同じ SVG の画像を何度も使っても、変換する回数に上限を置く', () => {
    const href = `data:image/svg+xml;base64,${btoa('<svg width="1" height="1"><rect width="1" height="1"/></svg>')}`
    const result = convert(`<svg><defs><image id="i" width="1" height="1" href="${href}"/></defs>${'<use href="#i"/>'.repeat(70)}</svg>`)
    expect(children(result)).toHaveLength(64)
    expect(result.warnings).toEqual([{ label: '64 個を超えた SVG の画像（<image>。読み飛ばした）', count: 6 }])
  })

  it('取り込んだ画像は kdr に書き出して読み直せる', () => {
    const result = convert(`<svg><image href="data:image/png;base64,${PNG_BASE64}" width="10" height="10"/></svg>`)
    const doc = createDocument()
    const pasted = pasteIntoPage(doc, doc.pages[0].id, result.fragment).document
    const reread = parseKdr(JSON.parse(JSON.stringify(kdrFile(pasted))), pasted.assets)
    expect(Object.values(reread.pages[0].nodes).some((node) => node.type === 'image')).toBe(true)
  })
})

describe('テキスト', () => {
  it('基線と text-anchor から枠の位置を決め、tspan の改行を行にする', () => {
    const result = convert(
      '<svg><text x="100" y="50" font-size="20" font-family="Inter" font-weight="bold" text-anchor="middle" fill="#333">Hello <tspan x="100" dy="24">World</tspan></text></svg>',
    )
    const text = children(result)[0] as TextNode
    expect(text).toMatchObject({ type: 'text', text: 'Hello\nWorld', fontSize: 20, fontFamily: 'Inter', fontWeight: 700, textAlign: 'center', name: 'Hello' })
    expect(text.fills).toEqual([{ type: 'solid', color: '#333333', opacity: 1, visible: true, blendMode: 'normal' as const }])
    // 幅 50（5 文字 × 20 × 0.5）の中央が x = 100
    close(text.x + text.width / 2, 100)
    expect(text.y).toBeLessThan(50 - 20 * 0.8)
  })
})

describe('textPath', () => {
  it('text の中の textPath は文字だけをまっすぐ並べて知らせる', () => {
    const result = convert('<svg><path id="curve" d="M0 0 C50 -50 100 50 150 0"/><text><textPath href="#curve">Along</textPath></text></svg>')
    expect(children(result)[1]).toMatchObject({ type: 'text', text: 'Along' })
    expect(labels(result)).toEqual(['線に沿った文字（<textPath>。まっすぐ並べた）'])
  })
})

describe('kdr として', () => {
  it('取り込んだノードは kdr に書き出して読み直せる', () => {
    const result = convert(`<svg width="120" height="80" viewBox="0 0 120 80">
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#888"/><stop offset="1" stop-color="#000"/></linearGradient>
      <g id="icon" transform="translate(10 10) rotate(15)">
        <rect width="40" height="20" rx="4" fill="url(#g)" stroke="navy"/>
        <path d="M0 30 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0 z M5 30 h10"/>
        <polygon points="50,0 60,20 40,20"/>
        <polyline points="0,40 10,50 20,40" fill="none" stroke="black"/>
        <text y="70">Label</text>
      </g>
    </svg>`)
    const doc = createDocument()
    const pasted = pasteIntoPage(doc, doc.pages[0].id, result.fragment).document
    const reread = parseKdr(JSON.parse(JSON.stringify(kdrFile(pasted))))
    expect(Object.keys(reread.pages[0].nodes)).toHaveLength(Object.keys(result.fragment.nodes).length)
  })
})

describe('parseSvgXml', () => {
  it('実体参照・CDATA・コメント・名前空間の接頭辞を読む', () => {
    const root = parseSvgXml('﻿<?xml version="1.0"?><!-- c --><svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:text>a &amp; b &#x41;<![CDATA[<c>]]></svg:text></svg:svg>')
    expect(root.name).toBe('svg')
    expect(root.children[0]).toEqual({ name: 'text', attributes: {}, children: ['a & b A', '<c>'] })
  })

  it('閉じタグの食い違いや閉じていない要素はエラー', () => {
    expect(() => parseSvgXml('<svg><g></svg>')).toThrow(SvgParseError)
    expect(() => parseSvgXml('<svg><g>')).toThrow(SvgParseError)
    expect(() => parseSvgXml('<html/>')).toThrow(SvgParseError)
  })
})

describe('既存のデザインツールの書き出しの影', () => {
  it('落ち影・内側の影（広がり・描画モード付き）とレイヤーのぼかしを読む', () => {
    const result = convert(
      '<svg width="200" height="200"><g filter="url(#f)"><rect x="20" y="20" width="100" height="60" fill="#ffffff"/></g><defs>' +
        '<filter id="f" x="0" y="0" width="200" height="200" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">' +
        '<feFlood flood-opacity="0" result="BackgroundImageFix"/>' +
        '<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>' +
        '<feMorphology radius="2" operator="dilate" in="SourceAlpha" result="effect1_dropShadow"/>' +
        '<feOffset dy="4"/><feGaussianBlur stdDeviation="3"/><feComposite in2="hardAlpha" operator="out"/>' +
        '<feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/>' +
        '<feBlend mode="multiply" in2="BackgroundImageFix" result="effect1_dropShadow_1_2"/>' +
        '<feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_1_2" result="shape"/>' +
        '<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>' +
        '<feMorphology radius="1" operator="erode" in="SourceAlpha" result="effect2_innerShadow"/>' +
        '<feOffset dx="2" dy="2"/><feGaussianBlur stdDeviation="1"/><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>' +
        '<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0.5 0"/>' +
        '<feBlend mode="normal" in2="shape" result="effect2_innerShadow_1_2"/>' +
        '<feGaussianBlur stdDeviation="2" result="effect3_foregroundBlur_1_2"/>' +
        '</filter></defs></svg>',
    )
    expect(labels(result)).toEqual([])
    const all = Object.values(result.fragment.nodes).flatMap((node) => ('effects' in node ? node.effects : []))
    expect(all).toEqual([
      { type: 'drop-shadow', x: 0, y: 4, blur: 6, spread: 2, blendMode: 'multiply', color: '#ff0000', opacity: 0.25, visible: true },
      { type: 'inner-shadow', x: 2, y: 2, blur: 2, spread: 1, blendMode: 'normal', color: '#0000ff', opacity: 0.5, visible: true },
      { type: 'layer-blur', blur: 4, visible: true },
    ])
  })

  it('知らない部品があれば読まずに知らせる', () => {
    const result = convert(
      '<svg width="100" height="100"><rect width="10" height="10" filter="url(#f)"/><defs><filter id="f">' +
        '<feFlood flood-opacity="0" result="BackgroundImageFix"/><feTurbulence/></filter></defs></svg>',
    )
    expect(labels(result).length).toBeGreaterThan(0)
  })
})
