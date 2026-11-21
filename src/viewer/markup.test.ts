import { describe, expect, it } from 'vitest'
import type { ImageNode, LineNode, PathNode } from '../document/types.ts'
import { base, frame, paint, rect, sceneOf, text } from '../document/testNodes.ts'
import { nodeMarkup, slug, standaloneHtml } from './markup.ts'

describe('nodeMarkup', () => {
  it('子孫を入れ子の要素にし、レイヤー名からクラス名を付ける。同じ名前には番号を付ける', () => {
    const card = frame({ name: 'Card', children: ['a', 'b', 'label'] })
    const scene = sceneOf(
      card,
      rect({ id: 'a', name: 'Icon', parentId: 'frame' }),
      rect({ id: 'b', name: 'Icon', parentId: 'frame', x: 10 }),
      text({ id: 'label', name: 'ラベル', parentId: 'frame', text: 'a < b\n次の行' }),
    )
    const { html, css } = nodeMarkup(scene, 'frame')
    expect(html).toBe(
      [
        '<div class="card">',
        '  <div class="icon"></div>',
        '  <div class="icon-2"></div>',
        '  <div class="text">a &lt; b<br>次の行</div>',
        '</div>',
      ].join('\n'),
    )
    expect(css).toContain('.card {\n  position: relative;\n  width: 100px;')
    expect(css).toContain('.icon-2 {\n  position: absolute;\n  left: 10px;')
  })

  it('選んだノードは、もとの親の中での置き方を外して書く', () => {
    const scene = sceneOf(
      frame({ children: ['inner'] }),
      frame({ id: 'inner', name: 'Inner', parentId: 'frame', x: 20, y: 30, children: [] }),
    )
    const { css } = nodeMarkup(scene, 'inner')
    expect(css).not.toContain('absolute')
    expect(css).not.toContain('left')
  })

  it('表示していない子は書かない', () => {
    const scene = sceneOf(
      frame({ name: 'Box', children: ['rect'] }),
      rect({ name: 'Hidden', parentId: 'frame', visible: false }),
    )
    expect(nodeMarkup(scene, 'frame').html).toBe('<div class="box"></div>')
  })

  it('直線とパスは SVG、画像は img にする', () => {
    const line: LineNode = {
      ...base,
      id: 'line',
      name: 'Line',
      parentId: 'frame',
      type: 'line',
      stroke: '#000000',
      strokeWidth: 2,
      direction: 'down',
      flipped: false,
      startCap: 'none',
      endCap: 'none',
    }
    const path: PathNode = {
      ...base,
      ...paint,
      id: 'path',
      name: 'Shape',
      parentId: 'frame',
      type: 'path',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.5, y: 1 },
      ],
      closed: true,
      startCap: 'none',
      endCap: 'none',
    }
    const image: ImageNode = {
      ...base,
      id: 'image',
      name: 'Photo',
      parentId: 'frame',
      type: 'image',
      assetId: 'a1',
      cornerRadius: 0,
      fit: 'cover',
    }
    const scene = sceneOf(frame({ children: ['line', 'path', 'image'] }), line, path, image)
    const assets = { a1: { mime: 'image/jpeg', data: 'AAAA' } }
    const lines = nodeMarkup(scene, 'frame', { assets }).html.split('\n')
    expect(lines[1]).toBe('  <svg class="line" viewBox="0 0 100 50"><line x1="0" y1="0" x2="100" y2="50"/></svg>')
    expect(lines[2]).toBe('  <svg class="shape" viewBox="0 0 100 50"><polygon points="0,0 100,0 50,50"/></svg>')
    expect(lines[3]).toBe('  <img class="photo" src="photo.jpg" alt="Photo">')
    const embedded = nodeMarkup(scene, 'image', { assets, images: 'embed' }).html
    expect(embedded).toBe('<img class="photo" src="data:image/jpeg;base64,AAAA" alt="Photo">')
  })

  it('端の矢印は、線を矢印の分だけ短くし、線の色で塗った三角形にする', () => {
    const line: LineNode = {
      ...base,
      id: 'line',
      name: 'Arrow',
      type: 'line',
      width: 100,
      height: 0,
      stroke: '#ff0000',
      strokeWidth: 2,
      direction: 'down',
      flipped: false,
      startCap: 'none',
      endCap: 'arrow',
    }
    // 矢印の長さは max(2 × 4, 10) = 10。線は 10 × 0.8 = 8 手前で止める
    expect(nodeMarkup(sceneOf(line), 'line').html).toBe(
      '<svg class="arrow" viewBox="0 0 100 0"><line x1="0" y1="0" x2="92" y2="0"/>' +
        '<polygon points="100,0 90,4 90,-4" fill="#ff0000" stroke="none"/></svg>',
    )
    const path: PathNode = {
      ...base,
      ...paint,
      id: 'path',
      name: 'Bend',
      type: 'path',
      stroke: '#000000',
      strokeWidth: 2,
      width: 100,
      height: 100,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      closed: false,
      startCap: 'arrow',
      endCap: 'none',
    }
    const html = nodeMarkup(sceneOf(path), 'path', { style: { color: 'rgb' } }).html
    // 塗りは元の形のまま、線は始点側を短くする
    expect(html).toContain('<polyline points="0,0 100,0 100,100" stroke="none"/>')
    expect(html).toContain('<polyline points="8,0 100,0 100,100" fill="none"/>')
    expect(html).toContain('<polygon points="0,0 10,-4 10,4" fill="rgb(0, 0, 0)" stroke="none"/>')
  })

  it('単位を rem にできる', () => {
    expect(nodeMarkup(sceneOf(rect()), 'rect', { style: { unit: 'rem' } }).css).toContain('width: 6.25rem;')
  })
})

describe('slug', () => {
  it('英数字だけを残して小文字の - つなぎにする', () => {
    expect(slug('Primary Button')).toBe('primary-button')
    expect(slug('iconLeft')).toBe('icon-left')
    expect(slug('ボタン')).toBe('')
    expect(slug('2 columns')).toBe('n-2-columns')
  })
})

describe('standaloneHtml', () => {
  it('CSS の中で <style> を閉じられないようにする', () => {
    const file = standaloneHtml('a<b', { html: '<div></div>', css: '.x { font-family: </style><script>; }' })
    expect(file).not.toContain('</style><script>')
    expect(file).toContain('<title>a&lt;b</title>')
  })
})
