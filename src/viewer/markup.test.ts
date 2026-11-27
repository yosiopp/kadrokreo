import { describe, expect, it } from 'vitest'
import { solid } from '../document/paint.ts'
import type { CodeComponent, FrameNode, ImageNode, PathNode } from '../document/types.ts'
import { derivedId } from '../document/component.ts'
import { base, docOf, frame, paint, rect, sceneOf, text } from '../document/testNodes.ts'
import { nodeCode, nodeFontFaces, nodeMarkup, slug, standaloneHtml } from './markup.ts'

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
    const line: PathNode = {
      ...base,
      id: 'line',
      name: 'Line',
      parentId: 'frame',
      type: 'path',
      fills: [],
      strokes: solid('#000000'),
      strokeWidth: 2,
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
      endCap: 'none',
      capSize: 0,
      contours: [],
      fillRule: 'nonzero',
      isMask: false,
      maskType: 'vector',
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
      capSize: 0,
      contours: [],
      fillRule: 'nonzero',
      isMask: false,
      maskType: 'vector',
    }
    const image: ImageNode = {
      ...base,
      id: 'image',
      name: 'Photo',
      parentId: 'frame',
      type: 'image',
      effects: [],
      assetId: 'a1',
      cornerRadius: 0,
      fit: 'cover', positionX: 0.5, positionY: 0.5, scale: 1, flipX: false, flipY: false,
    }
    const scene = sceneOf(frame({ children: ['line', 'path', 'image'] }), line, path, image)
    const assets = { a1: { mime: 'image/jpeg', bytes: new Uint8Array([0, 0, 0]) } }
    const lines = nodeMarkup(scene, 'frame', { assets }).html.split('\n')
    expect(lines[1]).toBe('  <svg class="line" viewBox="0 0 100 50"><line x1="0" y1="0" x2="100" y2="50"/></svg>')
    expect(lines[2]).toBe('  <svg class="shape" viewBox="0 0 100 50"><path d="M0 0 L100 0 L50 50 Z"/></svg>')
    expect(lines[3]).toBe('  <img class="photo" src="photo.jpg" alt="Photo">')
    const embedded = nodeMarkup(scene, 'image', { assets, images: 'embed' }).html
    expect(embedded).toBe('<img class="photo" src="data:image/jpeg;base64,AAAA" alt="Photo">')
  })

  it('頂点の角の丸めは曲線（C）にして書く', () => {
    const path: PathNode = {
      ...base,
      id: 'path',
      name: 'Round',
      type: 'path',
      width: 100,
      height: 100,
      fills: solid('#000000'),
      strokes: [],
      strokeWidth: 1,
      strokeDashes: [],
      strokeDashOffset: 0,
      strokeJoin: 'miter',
      effects: [],
      points: [
        { x: 0, y: 0, radius: 10 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      closed: true,
      startCap: 'none',
      endCap: 'none',
      capSize: 0,
      contours: [],
      fillRule: 'nonzero',
      isMask: false,
      maskType: 'vector',
    }
    const html = nodeMarkup(sceneOf(path), 'path').html
    expect(html).toMatch(/<path d="M17\.07 17\.07 C[^"]* 24\.14 0 L100 0 L100 100 Z"\/>/)
  })

  it('端の矢印は、線を矢印の分だけ短くし、線の色で塗った三角形にする', () => {
    const line: PathNode = {
      ...base,
      id: 'line',
      name: 'Arrow',
      type: 'path',
      width: 100,
      height: 0,
      fills: [],
      strokes: solid('#ff0000'),
      strokeWidth: 2,
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
    // 矢印の長さは max(2 × 4, 10) = 10。線は 10 × 0.8 = 8 手前で止める
    expect(nodeMarkup(sceneOf(line), 'line').html).toBe(
      '<svg class="arrow" viewBox="0 0 100 0"><line x1="0" y1="0" x2="92" y2="0"/>' +
        '<polygon points="100,0 90,4 90,-4" fill="#ff0000" stroke="none"/></svg>',
    )
    // 丸の印は円、大きさを指定すればその大きさ（半径は 0.4 倍）。四角の端は線の外へ太さの半分だけ出る
    const marked = nodeMarkup(sceneOf({ ...line, startCap: 'square', endCap: 'circle', capSize: 20 }), 'line').html
    expect(marked).toContain('<line x1="0" y1="0" x2="100" y2="0"/>')
    expect(marked).toContain('<circle cx="100" cy="0" r="8" fill="#ff0000" stroke="none"/>')
    expect(marked).toContain('<polygon points="0,1 -1,1 -1,-1 0,-1" fill="#ff0000" stroke="none"/>')
    // 両端が同じ丸なら、端の図形は描かず CSS の stroke-linecap に任せる（破線の切れ目の端にも同じ形が付く）
    const rounded = nodeMarkup(sceneOf({ ...line, startCap: 'round', endCap: 'round', strokeDashes: [4, 4] }), 'line')
    expect(rounded.html).toBe('<svg class="arrow" viewBox="0 0 100 0"><line x1="0" y1="0" x2="100" y2="0"/></svg>')
    expect(rounded.css).toContain('stroke-linecap: round;')
    const path: PathNode = {
      ...base,
      ...paint,
      id: 'path',
      name: 'Bend',
      type: 'path',
      strokes: solid('#000000'),
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
      capSize: 0,
      contours: [],
      fillRule: 'nonzero',
      isMask: false,
      maskType: 'vector',
    }
    const html = nodeMarkup(sceneOf(path), 'path', { style: { color: 'rgb' } }).html
    // 塗りは元の形のまま、線は始点側を短くする
    expect(html).toContain('<path d="M0 0 L100 0 L100 100" stroke="none"/>')
    expect(html).toContain('<path d="M8 0 L100 0 L100 100" fill="none"/>')
    expect(html).toContain('<polygon points="0,0 10,-4 10,4" fill="rgb(0, 0, 0)" stroke="none"/>')
  })

  it('曲線は path の d の C で書き、終点の矢印は曲線の接線の向きに向ける', () => {
    const path: PathNode = {
      ...base,
      ...paint,
      id: 'path',
      name: 'Curve',
      type: 'path',
      strokes: solid('#000000'),
      strokeWidth: 1,
      width: 100,
      height: 100,
      // 始点から右へ出て、終点には真下へ入る
      points: [
        { x: 0, y: 0, out: { x: 1, y: 0 } },
        { x: 1, y: 1, in: { x: 0, y: -1 } },
      ],
      closed: false,
      startCap: 'none',
      endCap: 'none',
      capSize: 0,
      contours: [],
      fillRule: 'nonzero',
      isMask: false,
      maskType: 'vector',
    }
    expect(nodeMarkup(sceneOf(path), 'path').html).toBe(
      '<svg class="curve" viewBox="0 0 100 100"><path d="M0 0 C100 0 100 0 100 100"/></svg>',
    )
    const html = nodeMarkup(sceneOf({ ...path, endCap: 'arrow' }), 'path', { style: { color: 'rgb' } }).html
    // 矢印は真下を向く（先が 100,100、根元は 10 上）
    expect(html).toContain('<polygon points="100,100 96,90 104,90" fill="rgb(0, 0, 0)" stroke="none"/>')
    // 線は曲線のまま、先の 8 手前で止まる
    expect(html).toMatch(/<path d="M0 0 C[\d. ]+ 100 92" fill="none"\/>/)
  })

  it('グラデーションの塗りと線は linearGradient で書き、要素の fill / stroke で指す', () => {
    const gradient = {
      type: 'linear' as const,
      x1: 0,
      y1: 0.5,
      x2: 1,
      y2: 0.5,
      stops: [
        { offset: 0, color: '#ff0000', opacity: 1 },
        { offset: 1, color: '#0000ff', opacity: 1 },
      ],
      opacity: 1,
      visible: true,
      blendMode: 'normal' as const,
    }
    const path: PathNode = {
      ...base,
      ...paint,
      id: 'path',
      name: 'Blob',
      type: 'path',
      fills: [gradient],
      strokes: [gradient],
      width: 100,
      height: 50,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.5, y: 1 },
      ],
      closed: true,
      startCap: 'none',
      endCap: 'none',
      capSize: 0,
      contours: [],
      fillRule: 'nonzero',
      isMask: false,
      maskType: 'vector',
    }
    const html = nodeMarkup(sceneOf(path), 'path').html
    expect(html).toContain(
      '<defs><linearGradient id="blob-fill" gradientUnits="userSpaceOnUse" x1="0" y1="25" x2="100" y2="25">' +
        '<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>',
    )
    expect(html).toContain('<linearGradient id="blob-stroke"')
    expect(html).toContain('<path d="M0 0 L100 0 L50 50 Z" fill="url(#blob-fill)" stroke="url(#blob-stroke)"/>')
    // 塗りの不透明度は、どの色にも stop-opacity で付ける
    expect(nodeMarkup(sceneOf({ ...path, fills: [{ ...gradient, opacity: 0.5 }] }), 'path').html).toContain(
      '<stop offset="0" stop-color="#ff0000" stop-opacity="0.5"/><stop offset="1" stop-color="#0000ff" stop-opacity="0.5"/>',
    )
    // 円形のグラデーションは、半径 1 の円を変換で枠に合わせた楕円にする
    const radial = { type: 'radial' as const, cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops: gradient.stops, opacity: 1, visible: true, angle: 0, fx: 0, fy: 0, blendMode: 'normal' as const }
    expect(nodeMarkup(sceneOf({ ...path, fills: [radial] }), 'path').html).toContain(
      '<radialGradient id="blob-fill" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(50 0 0 25 50 25)">',
    )
    // React の形式では stop の属性名を JSX の書き方にする
    expect(nodeMarkup(sceneOf(path), 'path', { style: { format: 'react' } }).html).toContain('stopColor="#ff0000"')
  })

  it('線に沿う文字の装飾は、svg の中の text の属性に書く', () => {
    const along = text({ textDecoration: 'line-through', textPath: { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false, startOffset: 0 } })
    expect(nodeMarkup(sceneOf(along), 'text').html).toContain('<text fill="currentColor" text-decoration="line-through"><textPath')
    expect(nodeMarkup(sceneOf(along), 'text', { style: { format: 'react' } }).html).toContain('textDecoration="line-through"')
    expect(nodeMarkup(sceneOf({ ...along, textDecoration: 'none' }), 'text').html).not.toContain('decoration')
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

describe('nodeMarkup の出力形式', () => {
  const card = () =>
    sceneOf(
      frame({ name: 'Card', children: ['icon', 'label', 'shape'] }),
      rect({ id: 'icon', name: 'Icon', parentId: 'frame', x: 10, y: 0, width: 20, height: 20 }),
      text({ id: 'label', name: 'Label', parentId: 'frame', text: '{a}\nb' }),
      {
        ...base,
        ...paint,
        id: 'shape',
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
        capSize: 0,
        contours: [],
        fillRule: 'nonzero',
        isMask: false,
        maskType: 'vector',
      } satisfies PathNode,
    )

  it('React（style）は、style を付けた JSX のコンポーネントにし、CSS は出さない', () => {
    const { html, css } = nodeMarkup(card(), 'frame', { style: { format: 'react' } })
    const lines = html.split('\n')
    expect(lines[0]).toBe('export function Card() {')
    expect(lines[1]).toBe('  return (')
    expect(lines[2]).toMatch(/^ {4}<div style=\{\{ position: 'relative', width: 100, height: 50/)
    expect(lines[3]).toBe("      <div style={{ position: 'absolute', left: 10, top: 0, width: 20, height: 20, background: '#ff0000' }}></div>")
    // 文字の { } は式と読まれないようにし、改行は <br />
    expect(lines[4]).toMatch(/>&#123;a&#125;<br \/>b<\/div>$/)
    // パスは HTML と同じ SVG を包む
    expect(lines[5]).toContain('viewBox="0 0 100 50"><path d="M0 0 L100 0 L50 50 Z"/></svg>')
    expect(lines.at(-1)).toBe('}')
    expect(css).toBe('')
  })

  it('React（CSS Modules）は、styles.名前 を付けた JSX と、同じ名前のクラスの CSS', () => {
    const scene = sceneOf(
      frame({ name: 'Card', children: ['a', 'b'] }),
      rect({ id: 'a', name: 'Icon', parentId: 'frame' }),
      rect({ id: 'b', name: 'Icon', parentId: 'frame' }),
    )
    const { html, css } = nodeMarkup(scene, 'frame', { style: { format: 'css-modules' } })
    expect(html.split('\n')).toEqual([
      "import styles from './Card.module.css'",
      '',
      'export function Card() {',
      '  return (',
      '    <div className={styles.card}>',
      '      <div className={styles.icon}></div>',
      '      <div className={styles.icon2}></div>',
      '    </div>',
      '  )',
      '}',
    ])
    expect(css).toContain('.icon2 {\n  position: absolute;')
  })

  it('React（Tailwind）は、クラスを並べた JSX にし、CSS は出さない', () => {
    const { html, css } = nodeMarkup(card(), 'frame', { style: { format: 'tailwind' } })
    expect(html).toContain('<div className="absolute left-[10px] top-[0] w-[20px] h-[20px] bg-[#ff0000]"></div>')
    expect(html).toContain('w-[100px] h-[50px] [fill:#ff0000] [stroke:none] overflow-visible" viewBox')
    expect(css).toBe('')
  })

  it('Vue（SFC）は、HTML と同じ木を <template> に、CSS を <style scoped> に入れた 1 つのファイルにする', () => {
    const html = nodeMarkup(card(), 'frame').html
    const plain = nodeMarkup(card(), 'frame')
    const { html: vue, css } = nodeMarkup(card(), 'frame', { style: { format: 'vue' } })
    const lines = vue.split('\n')
    expect(lines[0]).toBe('<template>')
    expect(lines[1]).toBe('  <div class="card">')
    expect(lines[2]).toBe('    <div class="icon"></div>')
    // {{ }} を式と読まれないように { } は文字参照、改行は <br>
    expect(lines[3]).toBe('    <div class="label">&#123;a&#125;<br>b</div>')
    // 中身は HTML + CSS と同じ（字下げと文字の { } だけが違う）
    expect(vue).toContain(html.split('\n')[3].trim())
    expect(vue).toContain(`</template>\n\n<style scoped>\n${plain.css}\n</style>`)
    expect(css).toBe('')
  })

  it('Vue の <style> は中身から閉じられない', () => {
    const scene = sceneOf(frame({ name: 'Card', children: ['label'] }), text({ id: 'label', parentId: 'frame', fontFamily: 'a</style><script>' }))
    expect(nodeMarkup(scene, 'frame', { style: { format: 'vue' } }).html).not.toContain('</style><script>')
  })

  it('画像は JSX では閉じた img にする', () => {
    const image: ImageNode = { ...base, id: 'image', name: 'Photo', type: 'image',
      effects: [], assetId: 'a1', cornerRadius: 0, fit: 'cover', positionX: 0.5, positionY: 0.5, scale: 1, flipX: false, flipY: false }
    const { html } = nodeMarkup(sceneOf(image), 'image', { style: { format: 'react' } })
    expect(html).toContain(`<img style={{ width: 100, height: 50, objectFit: 'cover' }} src="photo.png" alt="Photo" />`)
  })
})

describe('nodeCode', () => {
  const scene = () => sceneOf(frame({ children: ['rect'] }), rect({ parentId: 'frame', x: 10, cornerRadius: 4 }))

  it('HTML + CSS と CSS Modules と Vue は CSS', () => {
    expect(nodeCode(scene(), 'rect').title).toBe('CSS')
    expect(nodeCode(scene(), 'rect', { format: 'css-modules' }).code).toBe(nodeCode(scene(), 'rect').code)
    expect(nodeCode(scene(), 'rect', { format: 'vue' })).toEqual(nodeCode(scene(), 'rect'))
  })

  it('React は style のオブジェクト、Tailwind はクラスの並び', () => {
    expect(nodeCode(scene(), 'rect', { format: 'react' }).code).toBe(
      ['{', "  position: 'absolute',", '  left: 10,', '  top: 0,', '  width: 100,', '  height: 50,', "  background: '#ff0000',", '  borderRadius: 4,', '}'].join('\n'),
    )
    expect(nodeCode(scene(), 'rect', { format: 'tailwind', unit: 'rem' }).code).toBe(
      'absolute left-[0.625rem] top-[0] w-[6.25rem] h-[3.125rem] bg-[#ff0000] rounded-[0.25rem]',
    )
  })
})

describe('マスク', () => {
  it('マスクは要素にせず、かかっている子に clip-path を付ける', () => {
    const scene = sceneOf(
      frame({ name: 'Card', children: ['mask', 'photo'] }),
      rect({ id: 'mask', name: 'Window', parentId: 'frame', isMask: true }),
      rect({ id: 'photo', name: 'Photo', parentId: 'frame' }),
    )
    const { html, css } = nodeMarkup(scene, 'frame')
    expect(html).not.toContain('window')
    expect(html).toContain('class="photo"')
    expect(css).toContain("clip-path: path('M0 0 L100 0 L100 50 L0 50 Z');")
  })
})

describe('nodeMarkup の書体', () => {
  const fontAsset = { mime: 'font/ttf', bytes: new Uint8Array([0, 1, 0, 0]) }
  const assets = { f: fontAsset }
  const fonts = [{ assetId: 'f', family: 'Brand', weight: 400, style: 'normal' as const }]
  const scene = sceneOf(
    frame({ name: 'Card', children: ['label', 'plain'] }),
    text({ id: 'label', name: 'Label', parentId: 'frame', fontFamily: 'Brand' }),
    text({ id: 'plain', name: 'Plain', parentId: 'frame', fontFamily: 'sans-serif' }),
  )

  it('埋め込んだ書体を使うテキストがあれば、CSS の先頭に @font-face を置く（コピー用はファイル名、保存用は data URI）', () => {
    const { css } = nodeMarkup(scene, 'frame', { assets, fonts })
    expect(css.startsWith('@font-face {\n  font-family: "Brand";\n  src: url("Brand-400.ttf") format("truetype");')).toBe(true)
    expect(css.match(/@font-face/g)).toHaveLength(1)
    const embedded = nodeMarkup(scene, 'frame', { assets, fonts, images: 'embed' })
    expect(embedded.css).toContain('src: url("data:font/ttf;base64,AAEAAA==") format("truetype");')
    expect(standaloneHtml('Card', embedded)).toContain('data:font/ttf;base64,AAEAAA==')
  })

  it('React の style でも @font-face だけを CSS に出す。使わなければ出さない', () => {
    expect(nodeMarkup(scene, 'frame', { assets, fonts, style: { format: 'react' } }).css).toMatch(/^@font-face \{[^}]*\}$/)
    expect(nodeMarkup(scene, 'frame', { assets, fonts: [], style: { format: 'react' } }).css).toBe('')
    expect(nodeFontFaces(scene, 'plain', fonts, assets)).toEqual([])
    expect(nodeFontFaces(scene, 'frame', fonts, assets)).toEqual(fonts)
  })
})

describe('nodeMarkup の実装側の部品', () => {
  const code = (name: string, patch: Partial<CodeComponent> = {}): CodeComponent => ({ name, from: '@/ui', defaultExport: false, props: [], ...patch })
  const main = (id: string, name: string, componentId: string, patch: Partial<FrameNode> = {}) =>
    frame({ id, name, parentId: 'set', children: [`${id}-label`], component: { id: componentId, role: 'main', description: '', properties: [{ name: 'Label', type: 'text', targets: [`${id}-label`], preferred: [] }], code: null }, ...patch })
  /** まとまり（Button）に 2 つのバリアント、画面に小さい方のインスタンス */
  function buttonScene(setCode: CodeComponent | null) {
    const copy = derivedId('instance', 'small-label')
    return sceneOf(
      frame({ id: 'set', name: 'Button', children: ['large', 'small'], setCode }),
      main('large', 'Size=Large, Disabled=false', 'cLarge'),
      text({ id: 'large-label', parentId: 'large', text: 'OK' }),
      main('small', 'Size=Small, Disabled=true', 'cSmall'),
      text({ id: 'small-label', parentId: 'small', text: 'OK' }),
      frame({ id: 'screen', name: 'Screen', children: ['instance'] }),
      frame({ id: 'instance', name: 'Button', parentId: 'screen', x: 10, y: 20, children: [copy], component: { id: 'cSmall', role: 'instance', overrides: { 'small-label': { text: '予約する' } }, flipX: false, flipY: false } }),
      text({ id: copy, parentId: 'instance', text: '予約する' }),
    )
  }

  it('対応のあるインスタンスを、部品の呼び出しと import にする（置き方は div で包む）', () => {
    const scene = buttonScene(code('Button', { props: [{ property: 'Size', prop: 'size', values: { Small: 'sm' } }, { property: 'Label', prop: 'children', values: {} }] }))
    const { html } = nodeMarkup(scene, 'screen', { style: { format: 'react' }, document: docOf(scene) })
    expect(html).toBe(
      [
        "import { Button } from '@/ui'",
        '',
        'export function Screen() {',
        '  return (',
        "    <div style={{ position: 'relative', width: 100, height: 50, background: '#ff0000', overflow: 'hidden' }}>",
        "      <div style={{ position: 'absolute', left: 10, top: 20 }}>",
        '        <Button size="sm" disabled>',
        '          予約する',
        '        </Button>',
        '      </div>',
        '    </div>',
        '  )',
        '}',
      ].join('\n'),
    )
  })

  it('Vue は <script setup> に既定の export の import を書き、真偽値の false は :prop にする', () => {
    const scene = buttonScene(code('Button', { from: './Button.vue', defaultExport: true }))
    const large = scene.nodes.instance as FrameNode
    scene.nodes.instance = { ...large, component: { id: 'cLarge', role: 'instance', overrides: {}, flipX: false, flipY: false } }
    const { html } = nodeMarkup(scene, 'instance', { style: { format: 'vue' }, document: docOf(scene) })
    expect(html.split('\n').slice(0, 6)).toEqual([
      '<script setup>',
      "import Button from './Button.vue'",
      '</script>',
      '',
      '<template>',
      '  <Button size="Large" :disabled="false" label="OK" />',
    ])
  })

  it('インスタンスを選ぶと、生成する関数の名前を読み込んだ部品と違える。同じ名前の別の部品は別名で読み込む。import の場所の < は書かない', () => {
    const scene = buttonScene(code('Button'))
    expect(nodeMarkup(scene, 'instance', { style: { format: 'react' }, document: docOf(scene) }).html).toContain('export function ButtonView() {')
    expect(nodeMarkup(scene, 'instance', { style: { format: 'css-modules' }, document: docOf(scene) }).html).toContain('export function ButtonView() {')
    // 小さい方だけ別の場所の Button にする（まとまりは 1 つなので、もう 1 つまとまりを作る代わりに対応のある元をもう 1 つ置く）
    const other = { ...scene }
    other.nodes = {
      ...scene.nodes,
      lone: frame({ id: 'lone', name: 'Lone', component: { id: 'cLone', role: 'main', description: '', properties: [], code: code('Button', { from: '</script>x' }) } }),
      i2: frame({ id: 'i2', name: 'Lone', parentId: 'screen', component: { id: 'cLone', role: 'instance', overrides: {}, flipX: false, flipY: false } }),
      screen: { ...(scene.nodes.screen as FrameNode), children: ['instance', 'i2'] },
    }
    const react = nodeMarkup(other, 'screen', { style: { format: 'react' }, document: docOf(other) }).html
    expect(react).toContain("import { Button } from '@/ui'\nimport { Button as Button2 } from '\\x3c/script>x'")
    expect(react).toContain('<Button2 />')
    const vue = nodeMarkup(other, 'screen', { style: { format: 'vue' }, document: docOf(other) }).html
    expect(vue.match(/<\/script>/g)).toHaveLength(1)
  })

  it('対応がなければ今までどおり中身を書く。HTML の形式と document なしでも中身を書く', () => {
    const scene = buttonScene(null)
    expect(nodeMarkup(scene, 'instance', { style: { format: 'react' }, document: docOf(scene) }).html).toContain('予約する</div>')
    const linked = buttonScene(code('Button'))
    expect(nodeMarkup(linked, 'instance', { style: { format: 'html' }, document: docOf(linked) }).html).not.toContain('<Button')
    expect(nodeMarkup(linked, 'instance', { style: { format: 'react' } }).html).not.toContain('<Button')
  })

  it('文字列に " や { } を含めば式で書き、差し替えのプロパティは部品の要素にする。名前を作れないプロパティは書かない', () => {
    const iconCopy = derivedId('card', 'icon')
    const scene = sceneOf(
      frame({ id: 'star', name: 'Star', component: { id: 'cStar', role: 'main', description: '', properties: [], code: code('StarIcon', { from: '@/icons' }) } }),
      frame({ id: 'dot', name: 'Dot', component: { id: 'cDot', role: 'main', description: '', properties: [], code: null } }),
      frame({
        id: 'main',
        name: 'Card',
        children: ['icon', 'title'],
        component: {
          id: 'cCard',
          role: 'main',
          description: '',
          properties: [
            { name: 'Icon', type: 'instance', targets: ['icon'], preferred: [] },
            { name: 'Title', type: 'text', targets: ['title'], preferred: [] },
            { name: '強調', type: 'boolean', targets: ['title'], preferred: [] },
          ],
          code: code('Card'),
        },
      }),
      frame({ id: 'icon', name: 'Star', parentId: 'main', component: { id: 'cDot', role: 'instance', overrides: {}, flipX: false, flipY: false } }),
      text({ id: 'title', parentId: 'main', text: 'a "b" {c}' }),
      frame({ id: 'card', name: 'Card', children: [iconCopy], component: { id: 'cCard', role: 'instance', overrides: { icon: { componentId: 'cStar' } }, flipX: false, flipY: false } }),
      frame({ id: iconCopy, name: 'Star', parentId: 'card' }),
    )
    const { html } = nodeMarkup(scene, 'card', { style: { format: 'tailwind' }, document: docOf(scene) })
    expect(html).toContain("import { Card } from '@/ui'\nimport { StarIcon } from '@/icons'")
    expect(html).toContain('<Card icon={<StarIcon />} title={"a \\"b\\" {c}"} />')
    // 差し替え先に対応がなければ、その props は書かない
    scene.nodes.card = { ...(scene.nodes.card as FrameNode), component: { id: 'cCard', role: 'instance', overrides: {}, flipX: false, flipY: false } }
    expect(nodeMarkup(scene, 'card', { style: { format: 'react' }, document: docOf(scene) }).html).toContain('<Card title=')
    // Vue では差し替えの部品を名前付きスロットにする
    scene.nodes.card = { ...(scene.nodes.card as FrameNode), component: { id: 'cCard', role: 'instance', overrides: { icon: { componentId: 'cStar' } }, flipX: false, flipY: false } }
    expect(nodeMarkup(scene, 'card', { style: { format: 'vue' }, document: docOf(scene) }).html).toContain(
      '  <Card title="a &quot;b&quot; {c}">\n    <template #icon><StarIcon /></template>\n  </Card>',
    )
  })
})
