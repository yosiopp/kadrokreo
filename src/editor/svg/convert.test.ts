import { describe, expect, it } from 'vitest'
import { kdrFile, parseKdr } from '../../document/kdr.ts'
import { pathPoints } from '../../document/path.ts'
import type { FrameNode, PathNode, SceneNode, TextNode } from '../../document/types.ts'
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
    expect(path).toMatchObject({ type: 'path', name: 'wave', closed: false, fills: [], strokes: [{ type: 'solid', color: '#ff0000' }] })
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

  it('輪郭が複数ならパスに分けてフレームにまとめ、穴が塗りつぶされることを知らせる', () => {
    const result = convert('<svg><path id="ring" d="M0 0 H100 V100 H0 Z M25 25 H75 V75 H25 Z"/></svg>')
    const group = children(result)[0] as FrameNode
    expect(group).toMatchObject({ type: 'frame', name: 'ring', x: 0, y: 0, width: 100, height: 100 })
    expect(children(result, group).map((node) => node.name)).toEqual(['ring 1', 'ring 2'])
    expect(labels(result).some((label) => label.includes('輪郭が複数'))).toBe(true)
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
    expect(rect).toMatchObject({ fills: [{ type: 'solid', color: '#0000ff' }], strokes: [{ type: 'solid', color: '#008000' }], strokeWidth: 3, opacity: 0.5 })
    // 塗りは親から受け継ぐ。何も指定しなければ黒
    expect(circle).toMatchObject({ fills: [{ type: 'solid', color: '#ff0000' }], strokes: [] })
    expect(children(convert('<svg><rect width="1" height="1"/></svg>'))[0]).toMatchObject({ fills: [{ type: 'solid', color: '#000000' }] })
  })

  it('fill-opacity と半透明の色はノードの opacity に寄せる', () => {
    const result = convert('<svg><rect width="10" height="10" fill="#ff000080"/><rect width="10" height="10" fill="blue" fill-opacity="0.25"/></svg>')
    const [a, b] = children(result)
    expect(a.opacity).toBeCloseTo(128 / 255)
    expect(b.opacity).toBeCloseTo(0.25)
  })

  it('linearGradient を直線状のグラデーションにし、始点と終点を色の位置に写す', () => {
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
    expect(a.fills).toEqual([{ type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] }])
    expect(b.fills).toEqual([{ type: 'linear', angle: 0, stops: [{ offset: 0.25, color: '#ff0000' }, { offset: 0.75, color: '#0000ff' }] }])
    expect(c.fills).toEqual([{ type: 'linear', angle: 90, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] }])
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
    expect(circle.fills).toEqual([{ type: 'radial', cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops }])
    expect(rect.fills).toEqual([{ type: 'radial', cx: 0.25, cy: 0.2, rx: 0.2, ry: 0.4, stops }])
    expect(focal.fills).toEqual([{ type: 'radial', cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops }])
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
    expect(fallback).toMatchObject({ fills: [{ type: 'solid', color: '#00ff00' }] })
    expect(empty).toMatchObject({ fills: [] })
    expect(labels(result)).toEqual(
      expect.arrayContaining(['スクリプト（<script>）', '埋め込み HTML（<foreignObject>）', '画像（<image>）', '外部への参照（読まなかった）']),
    )
    expect(result.warnings.find((warning) => warning.label === 'スクリプト（<script>）')?.count).toBe(2)
    // SVG の文字そのものはどこにも残らない
    expect(JSON.stringify(result.fragment)).not.toMatch(/alert|example\.com|onload|onclick/)
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
    expect(children(result)[1]).toMatchObject({ fills: [{ type: 'solid', color: '#ff0000' }] })
    expect(children(result)[2]).toMatchObject({ fills: [] })
    expect(labels(result)).toEqual([
      'フィルタ',
      'マスク',
      'クリップパス',
      'パターンの塗り',
      'たどれない塗りの参照',
      '対応していない要素（<textPath>）',
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

describe('テキスト', () => {
  it('基線と text-anchor から枠の位置を決め、tspan の改行を行にする', () => {
    const result = convert(
      '<svg><text x="100" y="50" font-size="20" font-family="Inter" font-weight="bold" text-anchor="middle" fill="#333">Hello <tspan x="100" dy="24">World</tspan></text></svg>',
    )
    const text = children(result)[0] as TextNode
    expect(text).toMatchObject({ type: 'text', text: 'Hello\nWorld', fontSize: 20, fontFamily: 'Inter', fontWeight: 700, textAlign: 'center', name: 'Hello' })
    expect(text.fills).toEqual([{ type: 'solid', color: '#333333' }])
    // 幅 50（5 文字 × 20 × 0.5）の中央が x = 100
    close(text.x + text.width / 2, 100)
    expect(text.y).toBeLessThan(50 - 20 * 0.8)
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
