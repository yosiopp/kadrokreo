import { describe, expect, it } from 'vitest'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { KDR_VERSION, decodeKdr, readKdrArchive } from '../src/document/kdr.ts'
import type { DesignDocument, FrameNode, PathNode, RectNode, TextNode } from '../src/document/types.ts'
import { type IO, run } from './run.ts'
import { testFontBytes, toWoff } from '../src/document/testFont.ts'

/** メモリ上のファイルで run を動かす */
function harness(files: Record<string, Uint8Array> = {}, options: { stdin?: Uint8Array; tty?: boolean } = {}) {
  const fs = new Map(Object.entries(files))
  let stdout = ''
  let stdoutBytes: Uint8Array | null = null
  let stderr = ''
  const io: IO = {
    readFile: async (path) => {
      const data = fs.get(path)
      if (!data) throw new Error(`ENOENT: ${path}`)
      return new Uint8Array(data)
    },
    writeFile: async (path, data) => {
      fs.set(path, data)
    },
    readStdin: async () => new Uint8Array(options.stdin ?? new Uint8Array()),
    stdinIsTTY: options.stdin === undefined && options.tty !== false,
    stdoutIsTTY: options.tty ?? false,
    stdout: (data) => {
      if (typeof data === 'string') stdout += data
      else stdoutBytes = data
    },
    stderr: (text) => {
      stderr += text
    },
  }
  return {
    fs,
    run: (argv: string[]) => run(argv, io),
    get stdout() {
      return stdout
    },
    get stdoutBytes() {
      return stdoutBytes
    },
    get stderr() {
      return stderr
    },
    async doc(path: string): Promise<DesignDocument> {
      return decodeKdr(new Blob([new Uint8Array(fs.get(path)!)]))
    },
  }
}

/** 名前=値 などを空白で区切って argv にする（引用符は使わないテスト用） */
const argv = (line: string) => line.split(' ')

const nodeByName = (doc: DesignDocument, name: string, page = 0) =>
  Object.values(doc.pages[page].nodes).find((node) => node.name === name)!

describe('kadrokreo CLI', () => {
  it('new から + でつないだコマンドを順に実行し、-o に書き出す', async () => {
    const h = harness()
    const code = await h.run(
      argv(
        'new Demo + add frame --name Card --id card --width 320 --height 200 fill=#f5f5ff cornerRadius=12' +
          ' + add rect --parent card --x 16 --y 60 --width 100 --height 40 fill=#5b4cf5 --name Btn -o out.kdr',
      ),
    )
    expect(h.stderr).toBe('')
    expect(code).toBe(0)
    const doc = await h.doc('out.kdr')
    expect(doc.name).toBe('Demo')
    const card = doc.pages[0].nodes.card as FrameNode
    expect(card).toMatchObject({ type: 'frame', width: 320, fills: [{ type: 'solid', color: '#f5f5ff', opacity: 1, visible: true, blendMode: 'normal' as const }], cornerRadius: 12 })
    const btn = nodeByName(doc, 'Btn')
    expect(btn).toMatchObject({ parentId: 'card', x: 16, y: 60, fills: [{ type: 'solid', color: '#5b4cf5', opacity: 1, visible: true, blendMode: 'normal' as const }] })
    expect(card.children).toEqual([btn.id])
  })

  it('パイプでつなげる（標準入力から読み、変えたら標準出力へ kdr を出す）', async () => {
    const first = harness()
    await first.run(argv('new Piped + add rect --name Box'))
    const piped = first.stdoutBytes!
    expect(gunzipSync(piped).toString()).toContain('"Box"')

    const second = harness({}, { stdin: piped })
    expect(await second.run(argv('set Box fill=#ff0000 width=50'))).toBe(0)
    const third = harness({}, { stdin: second.stdoutBytes! })
    expect(await third.run(argv('get Box fills.0.color'))).toBe(0)
    expect(third.stdout).toBe('#ff0000\n')
    // 調べるだけなら kdr は出さない
    expect(third.stdoutBytes).toBeNull()
  })

  it('-w で入力のファイルへ上書きする', async () => {
    const h = harness()
    await h.run(argv('new + add ellipse --name Dot -o a.kdr'))
    expect(await h.run(argv('-f a.kdr -w set Dot opacity=0.5'))).toBe(0)
    expect(nodeByName(await h.doc('a.kdr'), 'Dot').opacity).toBe(0.5)
  })

  it('ls・info・find・bounds・css・html・json を出す', async () => {
    const h = harness()
    await h.run(argv('new Doc + add frame --id f --name Card --x 10 --y 20 + add rect --parent f --name Box --x 5 --y 5 --width 10 --height 10 -o a.kdr'))
    await h.run(argv('-f a.kdr info + ls + find box + bounds Card/Box + css Box'))
    const out = h.stdout
    expect(out).toContain('name: Doc')
    expect(out).toMatch(/frame {2}"Card" {2}f {2}10,20 100×100/)
    expect(out).toMatch(/\n {2}rect {2}"Box"/)
    expect(out).toMatch(/\trect\tCard\/Box\n/)
    expect(out).toContain('15 25 10 10')
    expect(out).toContain('width: 10px;')

    const html = harness(Object.fromEntries(h.fs))
    await html.run(argv('-f a.kdr html Card --standalone'))
    expect(html.stdout).toMatch(/^<!doctype html>/)
    const json = harness(Object.fromEntries(h.fs))
    await json.run(argv('-f a.kdr json'))
    expect(JSON.parse(json.stdout)).toMatchObject({ format: 'kadrokreo', version: KDR_VERSION, document: { name: 'Doc' } })
  })

  it('テキストは大きさを見積もり、幅を指定すると折り返す', async () => {
    const h = harness()
    await h.run(['new', '+', 'add', 'text', '--text', 'あいう', 'fontSize=20', '+', 'add', 'text', '--name', 'Wrap', '--width', '50', '--text', 'あいうえおかきくけこ', '-o', 'a.kdr'])
    const doc = await h.doc('a.kdr')
    expect(nodeByName(doc, 'Text')).toMatchObject({ sizing: { width: 'hug' }, width: 60, height: 24 })
    // 1 行に 3 文字（16px × 3 = 48 ≦ 50）で 4 行
    expect(nodeByName(doc, 'Wrap')).toMatchObject({ sizing: { width: 'fixed' }, width: 50, height: Math.ceil(4 * 16 * 1.2) })
    // 文字を変えると測り直す
    await h.run(['-f', 'a.kdr', '-w', 'set', 'Text', 'text=あいうえお'])
    expect(nodeByName(await h.doc('a.kdr'), 'Text').width).toBe(100)
  })

  it('直線・パス・画像を足す', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 20])
    const h = harness({ 'a.png': png })
    const code = await h.run([
      'new', '+', 'add', 'line', '--from', '100,0', '--to', '0,50', 'endCap=arrow',
      '+', 'add', 'path', '--points', '0,0 100,0 50,80', '--closed',
      '+', 'add', 'image', '--src', 'a.png', '--height', '10', '-o', 'a.kdr',
    ])
    expect(h.stderr).toBe('')
    expect(code).toBe(0)
    const doc = await h.doc('a.kdr')
    // 直線は 2 つの頂点の開いたパス。--from が始点
    expect(nodeByName(doc, 'Line')).toMatchObject({ type: 'path', x: 0, y: 0, width: 100, height: 50, points: [{ x: 1, y: 0 }, { x: 0, y: 1 }], endCap: 'arrow' })
    expect(nodeByName(doc, 'Path')).toMatchObject({ width: 100, height: 80, closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] })
    const image = nodeByName(doc, 'Image')
    expect(image).toMatchObject({ width: 20, height: 10 })
    expect(Object.values(doc.assets)).toEqual([{ mime: 'image/png', bytes: new Uint8Array(png) }])
    // アセットの id は中身の SHA-256
    expect(Object.keys(doc.assets)).toEqual([createHash('sha256').update(png).digest('hex')])

    // 同じ画像をもう一度足しても、アセットは 1 つのまま
    await h.run(['-f', 'a.kdr', '-w', 'add', 'image', '--src', 'a.png', '--name', 'Again'])
    const again = await h.doc('a.kdr')
    expect(Object.keys(again.assets)).toEqual(Object.keys(doc.assets))
    expect(nodeByName(again, 'Again')).toMatchObject({ type: 'image', assetId: image.type === 'image' ? image.assetId : '' })
  })

  it('add image は画像のファイルの大きさと画素数の上限を確かめる', async () => {
    const header = (width: number, height: number) => {
      const bytes = new Uint8Array(24)
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
      new DataView(bytes.buffer).setUint32(16, width)
      new DataView(bytes.buffer).setUint32(20, height)
      return bytes
    }
    const big = new Uint8Array(32 * 1024 * 1024 + 1)
    big.set(header(10, 10))
    const h = harness({ 'wide.png': header(8001, 8000), 'big.png': big, 'ok.png': header(8000, 8000) })
    expect(await h.run(['new', '+', 'add', 'image', '--src', 'wide.png', '-o', 'a.kdr'])).not.toBe(0)
    expect(h.stderr).toContain('画素数が多すぎます')
    expect(await h.run(['new', '+', 'add', 'image', '--src', 'big.png', '-o', 'b.kdr'])).not.toBe(0)
    expect(h.stderr).toContain('画像が大きすぎます')
    expect(await h.run(['new', '+', 'add', 'image', '--src', 'ok.png', '-o', 'c.kdr'])).toBe(0)
  })

  it('font-add で書体を埋め込み、info に出し、font-rm で外す。書体でないファイルはエラー', async () => {
    const h = harness({
      'a.ttf': testFontBytes({ family: 'Kdr Test' }),
      'b.ttf': testFontBytes({ family: 'Kdr Test', weight: 700, italic: true }),
      'c.woff': await toWoff(testFontBytes({ family: 'Woff Face' })),
      'x.ttf': new Uint8Array(100),
    })
    expect(await h.run(['new', '+', 'font-add', 'a.ttf', '+', 'font-add', 'b.ttf', '+', 'font-add', 'c.woff', '--family', 'Brand', '-o', 'f.kdr'])).toBe(0)
    expect(h.stderr).toContain('書体を埋め込みました: Kdr Test（太さ 700・斜体）。テキストで使うには fontFamily="Kdr Test"')
    const doc = await h.doc('f.kdr')
    expect(doc.fonts.map(({ family, weight, style }) => [family, weight, style])).toEqual([
      ['Kdr Test', 400, 'normal'],
      ['Kdr Test', 700, 'italic'],
      ['Brand', 400, 'normal'],
    ])
    expect(doc.assets[doc.fonts[2].assetId].mime).toBe('font/woff')
    expect(await h.run(['-f', 'f.kdr', 'info'])).toBe(0)
    expect(h.stdout).toContain('fonts: 3\n  "Kdr Test"  400  ')
    expect(h.stdout).toContain('"Kdr Test"  700 italic  ')
    expect(await h.run(['-f', 'f.kdr', 'font-rm', 'Kdr Test', '--weight', '700', '--italic', '-o', 'g.kdr'])).toBe(0)
    expect((await h.doc('g.kdr')).fonts.map((font) => font.family)).toEqual(['Kdr Test', 'Brand'])
    expect(await h.run(['-f', 'f.kdr', 'font-rm', 'Kdr Test', '-o', 'h.kdr'])).toBe(0)
    expect((await h.doc('h.kdr')).fonts.map((font) => font.family)).toEqual(['Brand'])
    expect(await h.run(['-f', 'f.kdr', 'font-rm', 'Nope'])).toBe(2)
    expect(await h.run(['new', '+', 'font-add', 'x.ttf'])).toBe(2)
    expect(h.stderr).toContain('x.ttf: TTF / OTF / WOFF の書体ファイルとして読めません')
    expect(await h.run(['new', '+', 'font-add', 'a.ttf', '--family', 'a,b'])).toBe(2)
  })

  it('outline-text で埋め込んだ書体のテキストを文字の形のパスにし、boolean にテキストを入れる', async () => {
    const h = harness({ 'a.woff': await toWoff(testFontBytes({ family: 'Kdr Test' })) })
    const setup = 'new + font-add a.woff --family Brand + add text --name Title --text AA fontFamily=Brand fontSize=100 + add text --name Plain --text x'
    expect(await h.run(argv(`${setup} + outline-text Title Plain -o o.kdr`))).toBe(0)
    expect(h.stderr).toContain('outline-text: kdr に埋め込んでいない書体のテキストはそのままにしました')
    const doc = await h.doc('o.kdr')
    expect(nodeByName(doc, 'Title')).toMatchObject({ type: 'path', fillRule: 'nonzero' })
    expect(nodeByName(doc, 'Plain')).toMatchObject({ type: 'text' })
    expect(await h.run(argv(`${setup} + outline-text Plain`))).toBe(2)
    // 元を残すブーリアン演算にテキストが入る（書き出して読み直しても子に残る）
    expect(await h.run(argv(`${setup} + add rect --name Box --width 300 --height 200 + boolean subtract Box Title --keep -o b.kdr`))).toBe(0)
    const kept = await h.doc('b.kdr')
    expect(nodeByName(kept, 'Title').parentId).toBe(nodeByName(kept, '差し引き').id)
    expect(await h.run(argv(`${setup} + add rect --name Box --width 300 --height 200 + boolean subtract Box Plain --keep`))).toBe(2)
  })

  it('破線のずれと線の角の形を set で変え、保存して読み直しても残る。不正な値はエラー', async () => {
    const h = harness()
    expect(await h.run(['new', '+', 'add', 'rect', '--name', 'Box', 'stroke=#000000', 'dash=4,2', 'dashOffset=1.5', 'join=bevel', '-o', 'a.kdr'])).toBe(0)
    expect(h.stderr).toBe('')
    expect(nodeByName(await h.doc('a.kdr'), 'Box')).toMatchObject({ strokeDashes: [4, 2], strokeDashOffset: 1.5, strokeJoin: 'bevel' })
    expect(await h.run(['-f', 'a.kdr', '-w', 'set', 'Box', 'strokeJoin=round', 'strokeDashOffset=-2'])).toBe(0)
    expect(nodeByName(await h.doc('a.kdr'), 'Box')).toMatchObject({ strokeDashOffset: -2, strokeJoin: 'round' })
    expect(await h.run(['-f', 'a.kdr', 'set', 'Box', 'join=arcs'])).not.toBe(0)
    expect(h.stderr).toContain('strokeJoin')
  })

  it('パスの頂点の角の丸め（radius=）と端の形・印の大きさを set で変える', async () => {
    const h = harness()
    const code = await h.run([
      'new', '+', 'add', 'path', '--name', 'Tri', '--points', '0,0 100,0 50,80', '--closed',
      '+', 'add', 'path', '--name', 'Open', '--points', '0,0 50,40 100,0', 'endCap=circle', 'startCap=round', 'capSize=14', '-o', 'a.kdr',
    ])
    expect(h.stderr).toBe('')
    expect(code).toBe(0)
    expect(await h.run(['-f', 'a.kdr', '-w', 'set', 'Tri', 'radius=10'])).toBe(0)
    const doc = await h.doc('a.kdr')
    const tri = nodeByName(doc, 'Tri')
    expect(tri.type === 'path' && tri.points.map((point) => point.radius)).toEqual([10, 10, 10])
    // 枠は丸めた形に合わせ直す（下の頂点を丸めたので、高さが縮む）
    expect(tri.height).toBeLessThan(80)
    expect(nodeByName(doc, 'Open')).toMatchObject({ startCap: 'round', endCap: 'circle', capSize: 14 })

    expect(await h.run(['-f', 'a.kdr', '-w', 'set', 'Tri', 'radius=0,4,0'])).toBe(0)
    const again = nodeByName(await h.doc('a.kdr'), 'Tri')
    expect(again.type === 'path' && again.points.map((point) => point.radius)).toEqual([undefined, 4, undefined])

    // 輪郭が 2 つあるパスでは、radius= は両方の輪郭の頂点に効く。radius.N= ならその輪郭だけ
    const holed = harness()
    const square = 'M0 0 L100 0 L100 100 L0 100 Z M25 25 L75 25 L75 75 L25 75 Z'
    expect(await holed.run(['new', '-o', 'h.kdr', '+', 'add', 'path', '--name', 'Ring', '--d', square, '+', 'set', 'Ring', 'radius=8'])).toBe(0)
    const ring = nodeByName(await holed.doc('h.kdr'), 'Ring')
    expect(ring.type === 'path' && ring.points.map((point) => point.radius)).toEqual([8, 8, 8, 8])
    expect(ring.type === 'path' && ring.contours[0].points.map((point) => point.radius)).toEqual([8, 8, 8, 8])
    expect(await holed.run(['-f', 'h.kdr', '-w', 'set', 'Ring', 'radius.1=4,0,4,0'])).toBe(0)
    const inner = nodeByName(await holed.doc('h.kdr'), 'Ring')
    expect(inner.type === 'path' && inner.points.map((point) => point.radius)).toEqual([8, 8, 8, 8])
    expect(inner.type === 'path' && inner.contours[0].points.map((point) => point.radius)).toEqual([4, undefined, 4, undefined])
    expect(await holed.run(['-f', 'h.kdr', '-w', 'set', 'Ring', 'radius=1,2,3,4,5,6,7,8', '+', 'set', 'Ring', 'radius.0=0'])).toBe(0)
    const each = nodeByName(await holed.doc('h.kdr'), 'Ring')
    expect(each.type === 'path' && each.points.map((point) => point.radius)).toEqual([undefined, undefined, undefined, undefined])
    expect(each.type === 'path' && each.contours[0].points.map((point) => point.radius)).toEqual([5, 6, 7, 8])
    expect(await holed.run(['-f', 'h.kdr', 'set', 'Ring', 'radius=1,2,3,4'])).not.toBe(0)
    expect(holed.stderr).toContain('頂点の数（8）')
    expect(await holed.run(['-f', 'h.kdr', 'set', 'Ring', 'radius.2=4'])).not.toBe(0)
    expect(holed.stderr).toContain('輪郭の番号は 0〜1')

    const bad = harness()
    expect(await bad.run(['new', '+', 'add', 'path', '--points', '0,0 10,0 5,8', 'radius=1,2'])).not.toBe(0)
    expect(bad.stderr).toContain('radius')
    const bad2 = harness()
    expect(await bad2.run(['new', '+', 'add', 'line', '--from', '0,0', '--to', '10,0', 'endCap=dot'])).not.toBe(0)
  })

  it('曲線のパスを SVG の path の d で作り、d で読み出す。制御点は set でも書ける', async () => {
    const h = harness()
    const code = await h.run(['new', '+', 'add', 'path', '--name', 'Arch', '--d', 'M10 110 C10 10 110 10 110 110', '-o', 'a.kdr'])
    expect(h.stderr).toBe('')
    expect(code).toBe(0)
    const doc = await h.doc('a.kdr')
    // 枠は制御点でなく曲線そのもの（いちばん上は y = 35）を囲む
    const arch = nodeByName(doc, 'Arch')
    expect(arch).toMatchObject({ type: 'path', x: 10, y: 35, width: 100, height: 75, closed: false })
    expect(arch.type === 'path' && arch.points[0].out).toEqual({ x: 0, y: -100 / 75 })

    const read = harness({ 'a.kdr': h.fs.get('a.kdr')! })
    await read.run(['-f', 'a.kdr', 'get', 'Arch', 'd'])
    expect(read.stdout.trim()).toBe('M10 110 C10 10 110 10 110 110')

    // 円弧と Z の閉じた形も作れる
    await read.run(['-f', 'a.kdr', '-w', 'add', 'path', '--name', 'Circle', '--d', 'M0 50 A50 50 0 1 1 100 50 A50 50 0 1 1 0 50 Z'])
    const circle = nodeByName(await read.doc('a.kdr'), 'Circle')
    expect(circle).toMatchObject({ closed: true, x: 0, y: 0 })
    expect(circle.width).toBeCloseTo(100, 1)

    // 制御点は頂点からのずれ（枠に対する割合）で、set の . つなぎで書ける
    expect(await read.run(['-f', 'a.kdr', '-w', 'set', 'Arch', 'points.1.in.y=-1'])).toBe(0)
    const edited = nodeByName(await read.doc('a.kdr'), 'Arch')
    expect(edited.type === 'path' && edited.points[1].in).toEqual({ x: 0, y: -1 })

    const bad = harness()
    expect(await bad.run(['new', '+', 'add', 'path', '--d', 'M0 0 C1 1'])).not.toBe(0)
    expect(bad.stderr).toContain('C の数値が足りません')
    expect(await bad.run(['new', '+', 'add', 'path', '--d', 'M0 0 L1 1 M2 2'])).not.toBe(0)
    expect(bad.stderr).toContain('輪郭')

    // M のまとまりが複数あれば、穴のあるパス（2 つ目以降の輪郭）になる。fillRule は set で変えられ、d で同じ形に戻る
    const holed = harness()
    const square = 'M0 0 L100 0 L100 100 L0 100 Z M25 25 L75 25 L75 75 L25 75 Z'
    expect(await holed.run(['new', '-o', 'h.kdr', '+', 'add', 'path', '--name', 'Ring', '--d', square, '+', 'set', 'Ring', 'fillRule=evenodd'])).toBe(0)
    const ring = nodeByName(await holed.doc('h.kdr'), 'Ring')
    expect(ring).toMatchObject({ width: 100, height: 100, closed: true, fillRule: 'evenodd' })
    expect(ring.type === 'path' && ring.contours).toEqual([
      { points: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 }], closed: true },
    ])
    await holed.run(['-f', 'h.kdr', 'get', 'Ring', 'd'])
    expect(holed.stdout.trim()).toBe(square)
    expect(await holed.run(['-f', 'h.kdr', 'set', 'Ring', 'fillRule=odd'])).not.toBe(0)
  })

  it('join で矩形・パスを 1 つのパスにまとめ、split で輪郭ごとに分け、mask でマスクにする', async () => {
    const h = harness()
    expect(await h.run(argv('new -o p.kdr + add rect --name A --width 10 --height 10 + add rect --name B --x 20 --width 10 --height 10 + join A B'))).toBe(0)
    const joined = nodeByName(await h.doc('p.kdr'), 'A')
    expect(joined).toMatchObject({ type: 'path', width: 30, height: 10 })
    expect(joined.type === 'path' && joined.contours).toHaveLength(1)
    expect(await h.run(argv('-f p.kdr -w split A + set @ opacity=0.5'))).toBe(0)
    const split = await h.doc('p.kdr')
    expect(Object.values(split.pages[0].nodes).filter((node) => node.type === 'path' && node.opacity === 0.5)).toHaveLength(2)
    expect(await h.run(argv('new + add rect --name R + split R'))).not.toBe(0)
    expect(h.stderr).toContain('輪郭が 2 つ以上')

    // 1 つならそれをマスクに。いくつもならフレームにまとめる（@ でまとめたフレーム）。set でも外せる
    const m = harness()
    expect(await m.run(argv('new -o m.kdr + add ellipse --name Hole --width 50 --height 50 + add rect --name Photo --width 100 --height 100 + mask Hole Photo --name Clip + set @ opacity=0.9'))).toBe(0)
    const doc = await m.doc('m.kdr')
    expect(nodeByName(doc, 'Hole')).toMatchObject({ isMask: true })
    const clip = nodeByName(doc, 'Clip')
    expect(clip.type === 'frame' && clip.children.map((id) => doc.pages[0].nodes[id].name)).toEqual(['Hole', 'Photo'])
    expect(clip.opacity).toBe(0.9)
    expect(await m.run(argv('-f m.kdr -w set Hole isMask=false'))).toBe(0)
    expect(nodeByName(await m.doc('m.kdr'), 'Hole')).toMatchObject({ isMask: false })
    // テキスト・画像・フレームもマスクにできる
    expect(await m.run(argv('-f m.kdr -w mask Clip --type alpha'))).toBe(0)
    expect(nodeByName(await m.doc('m.kdr'), 'Clip')).toMatchObject({ isMask: true, maskType: 'alpha' })
    expect(await m.run(argv('new -o t.kdr + add text --text Hello --name Label + add rect --name Photo + mask Label Photo'))).toBe(0)
    expect(nodeByName(await m.doc('t.kdr'), 'Label')).toMatchObject({ isMask: true, maskType: 'vector' })
  })

  it('boolean で合体・差し引き・交差・除外をかけ、結果を 1 つのパスにする', async () => {
    const h = harness()
    const base = 'new -o b.kdr + add rect --name A --width 100 --height 100 + add ellipse --name B --x 50 --y 50 --width 100 --height 100'
    expect(await h.run(argv(`${base} + boolean union B A + set @ opacity=0.5`))).toBe(0)
    const union = await h.doc('b.kdr')
    expect(Object.values(union.pages[0].nodes)).toHaveLength(1)
    expect(nodeByName(union, 'A')).toMatchObject({ type: 'path', fillRule: 'evenodd', width: 150, height: 150, opacity: 0.5 })
    expect(await h.run(argv(`${base} + boolean subtract A B`))).toBe(0)
    expect(nodeByName(await h.doc('b.kdr'), 'A')).toMatchObject({ type: 'path', width: 100, height: 100 })
    expect(await h.run(argv(`${base} + boolean intersect A B`))).toBe(0)
    expect(nodeByName(await h.doc('b.kdr'), 'A')).toMatchObject({ x: 50, y: 50, width: 50, height: 50 })
    expect(await h.run(argv(`${base} + boolean exclude A B`))).toBe(0)
    const exclude = nodeByName(await h.doc('b.kdr'), 'A')
    expect(exclude.type === 'path' && exclude.contours.length).toBeGreaterThanOrEqual(1)

    expect(await h.run(argv('new + add rect --name A + add rect --name B --x 500 + boolean intersect A B'))).not.toBe(0)
    expect(h.stderr).toContain('空')
    expect(await h.run(argv('new + add rect --name A + boolean union A'))).not.toBe(0)
    expect(await h.run(argv('new + add rect --name A + add rect --name B + boolean merge A B'))).not.toBe(0)
    expect(h.stderr).toContain('union / subtract')
  })

  it('boolean --keep で元を残すブーリアン演算のノードを作り、set で演算を変え、flatten で焼き込む', async () => {
    const h = harness()
    const base = 'new -o k.kdr + add rect --name A --width 100 --height 100 + add rect --name B --x 50 --y 50 --width 100 --height 100'
    expect(await h.run(argv(`${base} + boolean union A B --keep + set @ name=Shape`))).toBe(0)
    let doc = await h.doc('k.kdr')
    const shape = nodeByName(doc, 'Shape')
    expect(shape).toMatchObject({ type: 'frame', booleanOperation: 'union', width: 150, height: 150 })
    expect(shape.type === 'frame' && shape.children.map((id) => doc.pages[0].nodes[id].name)).toEqual(['A', 'B'])
    // 演算を変えると、枠が結果に合う
    expect(await h.run(argv('-f k.kdr -w set Shape booleanOperation=intersect'))).toBe(0)
    doc = await h.doc('k.kdr')
    expect(nodeByName(doc, 'Shape')).toMatchObject({ x: 50, y: 50, width: 50, height: 50 })
    // 子を動かすと結果が変わる
    expect(await h.run(argv('-f k.kdr -w set B x=-25 y=-25'))).toBe(0)
    expect(nodeByName(await h.doc('k.kdr'), 'Shape')).toMatchObject({ x: 25, y: 25, width: 75, height: 75 })
    expect(await h.run(argv('-f k.kdr -w flatten Shape'))).toBe(0)
    doc = await h.doc('k.kdr')
    expect(nodeByName(doc, 'Shape')).toMatchObject({ type: 'path', fillRule: 'evenodd', width: 75, height: 75 })
    expect(Object.values(doc.pages[0].nodes)).toHaveLength(1)
    expect(await h.run(argv('-f k.kdr flatten Shape'))).not.toBe(0)
    expect(await h.run(argv('new + add rect --name A + add text --name T --text hi + boolean union A T --keep'))).not.toBe(0)
  })

  it('boolean --keep --strokes で、元の図形の線の外形も演算に含める', async () => {
    const h = harness()
    const base = 'new -o s.kdr + add rect --name A --width 100 --height 100 + set A stroke=#000000 strokeWidth=10 + add rect --name B --x 50 --y 50 --width 100 --height 100'
    expect(await h.run(argv(`${base} + boolean union A B --keep --strokes + set @ name=Shape`))).toBe(0)
    let doc = await h.doc('s.kdr')
    expect(nodeByName(doc, 'Shape')).toMatchObject({ booleanIncludeStrokes: true, x: -5, y: -5, width: 155, height: 155 })
    // set で外すと、塗りの形だけに戻る
    expect(await h.run(argv('-f s.kdr -w set Shape booleanIncludeStrokes=false'))).toBe(0)
    doc = await h.doc('s.kdr')
    expect(nodeByName(doc, 'Shape')).toMatchObject({ booleanIncludeStrokes: false, x: 0, y: 0, width: 150, height: 150 })
    expect(await h.run(argv('-f s.kdr -w set Shape booleanIncludeStrokes=maybe'))).not.toBe(0)
    expect(await h.run(argv(`${base} + boolean union A B --strokes`))).not.toBe(0)
  })

  it('outline-stroke で線を線の形のパスにし、mask --type で明るさのマスクにする', async () => {
    const h = harness()
    expect(await h.run(argv('new -o o.kdr + add rect --name Box --width 100 --height 100 + set Box stroke=#ff0000 strokeWidth=10 + outline-stroke Box + set @ name=Edge'))).toBe(0)
    const doc = await h.doc('o.kdr')
    expect(nodeByName(doc, 'Box')).toMatchObject({ strokes: [] })
    expect(nodeByName(doc, 'Edge')).toMatchObject({ type: 'path', x: -5, y: -5, width: 110, height: 110, strokes: [] })
    expect((nodeByName(doc, 'Edge') as PathNode).fills[0]).toMatchObject({ color: '#ff0000' })
    expect(await h.run(argv('new + add rect --name A + set A strokeWidth=0 + outline-stroke A'))).not.toBe(0)

    const m = harness()
    expect(await m.run(argv('new -o m.kdr + add ellipse --name Fade --width 50 --height 50 + add rect --name Photo + mask Fade Photo --type luminance'))).toBe(0)
    expect(nodeByName(await m.doc('m.kdr'), 'Fade')).toMatchObject({ isMask: true, maskType: 'luminance' })
    expect(await m.run(argv('-f m.kdr -w set Fade maskType=alpha'))).toBe(0)
    expect(nodeByName(await m.doc('m.kdr'), 'Fade')).toMatchObject({ maskType: 'alpha' })
    expect(await m.run(argv('-f m.kdr set Fade maskType=shape'))).not.toBe(0)
    expect(await m.run(argv('new + add rect --name A + mask A --type bright'))).not.toBe(0)
  })

  it('svg で SVG を図形のノードに変換して置き、落としたものを標準エラーに出す', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 50 25">' +
        '<script>alert(1)</script><g id="shapes" filter="url(#f)"><rect id="box" width="10" height="10" fill="#ff0000"/>' +
        '<path d="M20 0 Q30 20 40 0"/></g></svg>',
    )
    const h = harness({ 'icons/logo.svg': svg })
    expect(await h.run(argv('new + add frame --id card --width 400 --height 300 + svg icons/logo.svg --parent card --x 10 --y 20 + set @ opacity=0.5 -o out.kdr'))).toBe(0)
    expect(h.stderr).toContain('スクリプト（<script>）')
    expect(h.stderr).toContain('フィルタ')
    const doc = await h.doc('out.kdr')
    const root = nodeByName(doc, 'logo') as FrameNode
    expect(root).toMatchObject({ type: 'frame', parentId: 'card', x: 10, y: 20, width: 100, height: 50, opacity: 0.5 })
    const group = nodeByName(doc, 'shapes') as FrameNode
    expect(group.parentId).toBe(root.id)
    expect(nodeByName(doc, 'box')).toMatchObject({ type: 'rect', width: 20, height: 20, parentId: group.id })
    expect(Object.values(doc.pages[0].nodes).some((node) => node.type === 'path' && node.points[0].out !== undefined)).toBe(true)

    const bad = harness({ 'x.svg': new TextEncoder().encode('<svg><g></svg>') })
    expect(await bad.run(argv('new + svg x.svg -o out.kdr'))).not.toBe(0)
    expect(bad.stderr).toContain('x.svg')
  })

  it('svg の data URI の画像は kdr の画像になり、CSS・破線・穴も写す', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const svg = new TextEncoder().encode(
      '<svg width="100" height="100"><style>.dash { stroke: #000; stroke-dasharray: 4 2 }</style>' +
        `<image id="pic" width="20" height="20" href="data:image/png;base64,${png}"/>` +
        '<path id="ring" class="dash" fill-rule="evenodd" d="M0 0 H100 V100 H0 Z M25 25 H75 V75 H25 Z"/></svg>',
    )
    const h = harness({ 'a.svg': svg })
    const code = await h.run(argv('new + svg a.svg + svg a.svg -o out.kdr'))
    expect(h.stderr).toBe('')
    expect(code).toBe(0)
    const doc = await h.doc('out.kdr')
    expect(Object.keys(doc.assets)).toEqual([createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex')])
    expect(nodeByName(doc, 'pic')).toMatchObject({ type: 'image', width: 20, height: 20 })
    expect(nodeByName(doc, 'ring')).toMatchObject({ type: 'path', fillRule: 'evenodd', strokeDashes: [4, 2] })
  })

  it('オートレイアウトとまとめる操作は editor と同じく並べ直す', async () => {
    const h = harness()
    await h.run(argv(
      'new + add rect --name A --width 40 --height 20 + add rect --name B --x 100 --width 40 --height 20' +
        ' + wrap A B --name Row --id row gap=8 padding=10 -o a.kdr',
    ))
    const doc = await h.doc('a.kdr')
    const row = doc.pages[0].nodes.row as FrameNode
    expect(row.layout).toMatchObject({ direction: 'horizontal', gap: 8, paddingTop: 10, paddingLeft: 10 })
    expect(row).toMatchObject({ width: 10 + 40 + 8 + 40 + 10, height: 40 })
    expect(nodeByName(doc, 'B')).toMatchObject({ x: 58, y: 10 })

    await h.run(argv('-f a.kdr -w set row layout.direction=vertical'))
    expect((await h.doc('a.kdr')).pages[0].nodes.row).toMatchObject({ width: 60, height: 10 + 20 + 8 + 20 + 10 })
  })

  it('インスタンスの中身への set は上書きとして覚え、元を変えるとインスタンスも変わる', async () => {
    const h = harness()
    await h.run(argv(
      'new + add frame --name Button --id btn + component btn + add text --parent btn --name Label --text OK' +
        ' + page-add Second + instance Button --id b2 --x 200 + set b2/Label text=Cancel' +
        ' + page 1 + set btn fill=#123456 -o a.kdr',
    ))
    expect(h.stderr).toBe('')
    const doc = await h.doc('a.kdr')
    const instance = doc.pages[1].nodes.b2 as FrameNode
    expect(instance).toMatchObject({ x: 200, fills: [{ type: 'solid', color: '#123456', opacity: 1, visible: true, blendMode: 'normal' as const }] })
    expect(instance.component?.role).toBe('instance')
    const label = doc.pages[1].nodes[instance.children[0]] as TextNode
    expect(label.text).toBe('Cancel')
    expect(Object.values(instance.component?.role === 'instance' ? instance.component.overrides : {})).toEqual([{ text: 'Cancel' }])
  })

  it('css・html の --format で React・CSS Modules・Tailwind・Vue の形にする', async () => {
    const h = harness()
    await h.run(argv('new + add frame --id f --name Card --width 40 --height 30 + add rect --parent f --name Box --width 10 --height 10 -o a.kdr'))
    const out = async (line: string) => {
      const run = harness(Object.fromEntries(h.fs))
      expect(await run.run(argv(`-f a.kdr ${line}`))).toBe(0)
      return run.stdout
    }
    expect(await out('css Box --format react')).toContain('width: 10,')
    expect(await out('css Box --format tailwind')).toContain('w-[10px]')
    const modules = await out('html Card --format css-modules')
    expect(modules).toContain("import styles from './Card.module.css'")
    expect(modules).toContain('className={styles.box}')
    expect(modules).toContain('/* Card.module.css */\n.card {')
    expect(await out('html Card --format tailwind')).toContain('className="relative w-[40px]')
    const vue = await out('html Card --format vue')
    expect(vue).toMatch(/^<template>/)
    expect(vue).toContain('<style scoped>')
    const bad = harness(Object.fromEntries(h.fs))
    expect(await bad.run(argv('-f a.kdr html Card --format swift'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr html Card --format vue --standalone'))).toBe(2)
  })

  it('align・distribute・rotate は editor の整列・回転と同じく動かす', async () => {
    const h = harness()
    await h.run(argv(
      'new + add rect --id a --x 0 --y 0 --width 10 --height 10 + add rect --id b --x 50 --y 30 --width 20 --height 10' +
        ' + add rect --id c --x 200 --y 5 --width 10 --height 40 + align top a b c + distribute horizontal a b c' +
        ' + add frame --id f --width 100 --height 100 --x 500 + add rect --id d --parent f --width 20 --height 20 + align center d' +
        ' + rotate 90 c --each + add rect --id e --x 0 --y 100 --width 20 --height 10 + rotate 90 e --pivot 0,100 -o a.kdr',
    ))
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    expect([nodes.a.y, nodes.b.y, nodes.c.y]).toEqual([0, 0, 0])
    // 間隔は (210 - 40) / 2 = 85
    expect(nodes.b.x).toBe(95)
    expect(nodes.d.x).toBe(40)
    expect(nodes.c).toMatchObject({ rotation: 90, x: 200 })
    // 左上の角を軸に 90 度回すと、枠の中心 (10, 105) は (-5, 110) に来る
    expect(nodes.e.rotation).toBe(90)
    expect(nodes.e.x + 10).toBeCloseTo(-5)
    expect(nodes.e.y + 5).toBeCloseTo(110)

    const bad = harness(Object.fromEntries(h.fs))
    expect(await bad.run(argv('-f a.kdr align middle a'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr distribute vertical a b'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr rotate x a'))).toBe(2)
  })

  it('flip は editor の反転と同じく裏返す', async () => {
    const h = harness()
    await h.run(argv(
      'new + add rect --id a --x 0 --y 0 --width 10 --height 10 + add rect --id b --x 90 --y 0 --width 10 --height 10 + set b rotation=30' +
        ' + flip horizontal a b -o a.kdr',
    ))
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    expect(nodes.b.rotation).toBe(-30)
    expect(nodes.a.x).toBeGreaterThan(nodes.b.x)
    const bad = harness(Object.fromEntries(h.fs))
    expect(await bad.run(argv('-f a.kdr flip diagonal a'))).toBe(2)
  })

  it('テキストの flip は字そのものを裏返し（flipX / flipY）、set でも変えられる', async () => {
    const h = harness()
    await h.run(argv('new + add text --id t --text Hi + flip horizontal t + add text --id u --text Yo + set u flipY=true -o a.kdr'))
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    expect(nodes.t).toMatchObject({ flipX: true, flipY: false })
    expect(nodes.u).toMatchObject({ flipX: false, flipY: true })
    const bad = harness(Object.fromEntries(h.fs))
    expect(await bad.run(argv('-f a.kdr set t flipX=yes'))).not.toBe(0)
  })

  it('インスタンスの flip は中身の配置も鏡に映し、元を変えても映ったまま追う', async () => {
    const h = harness()
    await h.run(argv(
      'new + add frame --name Button --id btn --width 120 --height 40 + add text --parent btn --name Label --id label --x 10 --text OK + component btn' +
        ' + instance Button --id i1 --y 200 + flip horizontal i1 + set label x=20 -o a.kdr',
    ))
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    const copy = nodes[(nodes.i1 as FrameNode).children[0]] as TextNode
    expect((nodes.i1 as FrameNode).component).toMatchObject({ flipX: true, flipY: false, overrides: {} })
    expect(copy).toMatchObject({ x: 120 - 20 - copy.width, flipX: true })
    expect(nodes.label).toMatchObject({ x: 20, flipX: false })
  })

  it('上書きを元に反映・元に戻す、インスタンスの元の差し替え', async () => {
    const h = harness()
    await h.run(argv(
      'new + add frame --name Button --id btn + add text --parent btn --name Label --text OK + component btn' +
        ' + add frame --name Chip --id chip --x 300 + add text --parent chip --name Label --text Tag + component chip' +
        ' + instance Button --id i1 --y 200 + instance Button --id i2 --x 200 --y 200' +
        ' + set i1/Label text=Push + override-push i1/Label + set i2/Label text=Mine fill=#ff0000 + override-reset i2/Label' +
        ' + set i1/Label text=Moved + swap i1 Chip -o a.kdr',
    ))
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    const label = (id: string) => nodes[(nodes[id] as FrameNode).children[0]] as TextNode
    // 元に書き込んだので、元ともう 1 つのインスタンスも Push になり、上書きは外れる
    expect(label('btn').text).toBe('Push')
    expect(label('i2').text).toBe('Push')
    expect((nodes.i2 as FrameNode).component).toMatchObject({ overrides: {} })
    // 差し替えると元は Chip になり、上書きはレイヤー名が同じ Label へ移る
    const i1 = nodes.i1 as FrameNode
    expect(i1.component).toMatchObject({ role: 'instance', id: (nodes.chip as FrameNode).component!.id })
    expect(i1.name).toBe('Chip')
    expect(label('i1').text).toBe('Moved')

    const bad = harness(Object.fromEntries(h.fs))
    expect(await bad.run(argv('-f a.kdr override-push i2'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr swap btn Chip'))).toBe(2)
  })

  it('swap で入れ子の中の入れ子のインスタンスも差し替えられる', async () => {
    const h = harness()
    await h.run(argv(
      'new + add frame --name Button --id btn + add text --parent btn --name Label --text OK + component btn' +
        ' + add frame --name Icon --id icon --y 200 + component icon' +
        ' + add frame --name Card --id card --x 200 + component card + instance Button --parent card --id b1' +
        ' + add frame --name Panel --id panel --x 500 + component panel + instance Card --parent panel --id c1' +
        ' + instance Panel --id outer --y 400 + swap outer/Card/Button Icon -o a.kdr',
    ))
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    const children = (id: string) => (nodes[id] as FrameNode).children.map((child) => nodes[child])
    expect(children(children('outer')[0].id)[0].name).toBe('Icon')
    // 元のパネルの中は変わらない
    expect(children(children('panel')[0].id)[0].name).toBe('Button')
  })

  it('describe で説明文、prop-add でプロパティを作り、prop でインスタンスの値を決める', async () => {
    const h = harness()
    await h.run([
      ...argv(
        'new + add frame --name Button --id btn + add text --parent btn --name Label --id label --text OK' +
          ' + add rect --parent btn --name Mark --id mark + component btn + describe btn',
      ),
      '主な操作に使う',
      ...argv('+ prop-add btn text label --name 文言 + prop-add btn boolean mark + instance Button --id i1 --y 200 + prop i1 文言=送信 Mark=false -o a.kdr'),
    ])
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    expect((nodes.btn as FrameNode).component).toEqual({
      id: expect.any(String),
      role: 'main',
      description: '主な操作に使う',
      properties: [
        { name: '文言', type: 'text', targets: ['label'], preferred: [] },
        { name: 'Mark', type: 'boolean', targets: ['mark'], preferred: [] },
      ],
    })
    expect((nodes.i1 as FrameNode).component).toMatchObject({ overrides: { label: { text: '送信' }, mark: { visible: false } } })

    const bad = harness(Object.fromEntries(h.fs))
    expect(await bad.run(argv('-f a.kdr prop-add btn text mark'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr prop-add btn color label'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr prop i1 ない=1'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr prop i1 Mark=yes'))).toBe(2)
  })

  it('prop-align で揃っていないバリアントのプロパティを揃え、describe でまとまりに説明文を付ける', async () => {
    const h = harness()
    // 名前をバリアントの形にする前にプロパティを足すと、まとまりで揃っていない状態になる
    await h.run([
      ...argv(
        'new + add frame --name Set --id set + add frame --parent set --name A --id a + add text --parent a --name Label --id la --text OK' +
          ' + component a + add frame --parent set --name B --id b --x 200 + add text --parent b --name Label --id lb --text OK + component b' +
          ' + prop-add a text la --name 文言 + set a',
      ),
      'name=種類=標準',
      ...argv('+ set b'),
      'name=種類=大',
      ...argv('+ prop-align b + describe set'),
      '大きさを選ぶ',
      ...argv('-o a.kdr'),
    ])
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    expect((nodes.b as FrameNode).component).toMatchObject({ properties: [{ name: '文言', type: 'text', targets: ['lb'] }] })
    expect((nodes.set as FrameNode).setDescription).toBe('大きさを選ぶ')
    const bad = harness(Object.fromEntries(h.fs))
    expect(await bad.run(argv('-f a.kdr prop-align la'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr describe la x'))).toBe(2)
  })

  it('prop-rename / prop-order / prop-prefer / prop-rm。バリアントならまとまり全体で揃う', async () => {
    const h = harness()
    await h.run([
      ...argv(
        'new + add frame --name Icon --id icon + component icon + add frame --name Button --id btn' +
          ' + add text --parent btn --name Label --id label --text OK + add rect --parent btn --name Mark --id mark' +
          ' + instance Icon --parent btn --id ic + component btn + variant-add btn --id big',
      ),
      '種類=大',
      ...argv(
        '+ prop-add btn text label --name 文言 + prop-add btn boolean mark --name 印 + prop-add btn instance ic --name アイコン' +
          ' + prop-rename big 文言 ラベル + prop-order btn アイコン 0 + prop-prefer big アイコン Icon + prop-rm btn 印 -o a.kdr',
      ),
    ])
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    const props = (id: string) => (nodes[id] as FrameNode).component as { properties: { name: string; targets: string[]; preferred: string[] }[] }
    const iconComponent = (nodes.icon as FrameNode).component!.id
    for (const id of ['btn', 'big']) {
      expect(props(id).properties.map((property) => property.name)).toEqual(['アイコン', 'ラベル'])
      expect(props(id).properties[0].preferred).toEqual([iconComponent])
    }
    // big の中の同じ名前のレイヤーに結ばれている
    const bigLabel = (nodes.big as FrameNode).children.find((child) => nodes[child].name === 'Label')
    expect(props('big').properties[1].targets).toEqual([bigLabel])

    const bad = harness(Object.fromEntries(h.fs))
    expect(await bad.run(argv('-f a.kdr prop-rename btn ない x'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr prop-rename btn ラベル アイコン'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr prop-order btn ラベル -1'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr prop-prefer btn ラベル Icon'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr prop-rm label ラベル'))).toBe(2)
  })

  it('variant-add でバリアントを増やし、variant でインスタンスのバリアントを選ぶ', async () => {
    const h = harness()
    await h.run([
      ...argv('new + add frame --name Button --id btn + component btn + variant-add btn --id big'),
      'サイズ=大',
      ...argv('+ instance big --id i1 --y 300 + variant i1'),
      '種類=標準',
      '-o',
      'a.kdr',
    ])
    // 元の名前は「種類=標準」になり、増やしたバリアントは最後のプロパティの値を変えたもの
    expect(h.stderr).toContain('サイズ')
    const fixed = harness()
    await fixed.run([
      ...argv('new + add frame --name Button --id btn + component btn + variant-add btn --id big'),
      '種類=大',
      ...argv('+ instance big --id i1 --y 300 + variant i1'),
      '種類=標準',
      '-o',
      'a.kdr',
    ])
    expect(fixed.stderr).toBe('')
    const { nodes } = (await fixed.doc('a.kdr')).pages[0]
    expect(nodes.btn.name).toBe('種類=標準')
    expect(nodes.big.name).toBe('種類=大')
    expect(nodes.btn.parentId).toBe(nodes.big.parentId)
    expect((nodes.i1 as FrameNode).component?.id).toBe((nodes.btn as FrameNode).component?.id)

    const bad = harness(Object.fromEntries(fixed.fs))
    expect(await bad.run(['-f', 'a.kdr', 'variant', 'i1', '種類=ない'])).toBe(2)
    expect(await bad.run(['-f', 'a.kdr', 'variant-add', 'i1'])).toBe(2)
  })

  it('variant-prop-add / -rename / -rm と variant-value-rename でバリアントのプロパティを変える', async () => {
    const h = harness()
    expect(
      await h.run([
        ...argv('new + add frame --name Button --id btn + component btn + variant-add btn --id big'),
        '種類=大',
        ...argv('+ instance big --id i1 --y 300'),
        ...['+', 'variant-prop-add', 'btn', 'サイズ', 'M'],
        ...['+', 'variant-prop-rename', 'big', '種類', 'スタイル'],
        ...['+', 'variant-value-rename', 'btn', 'スタイル', '大', '強調'],
        '-o',
        'a.kdr',
      ]),
    ).toBe(0)
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    expect(nodes.btn.name).toBe('スタイル=標準, サイズ=M')
    expect(nodes.big.name).toBe('スタイル=強調, サイズ=M')
    // まとまりを直接指して消す
    const setId = nodes.btn.parentId!
    const rm = harness(Object.fromEntries(h.fs))
    expect(await rm.run(['-f', 'a.kdr', 'variant-prop-rm', setId, 'サイズ', '-o', 'b.kdr'])).toBe(0)
    const after = (await rm.doc('b.kdr')).pages[0].nodes
    expect(after.btn.name).toBe('スタイル=標準')
    expect(after.big.name).toBe('スタイル=強調')

    const bad = harness(Object.fromEntries(rm.fs))
    expect(await bad.run(['-f', 'b.kdr', 'variant-prop-rm', 'btn', 'スタイル'])).toBe(2) // 1 つもなくなる
    expect(await bad.run(['-f', 'b.kdr', 'variant-prop-rm', 'btn', 'ない'])).toBe(2)
    expect(await bad.run(['-f', 'b.kdr', 'variant-prop-add', 'btn', 'スタイル'])).toBe(2) // もうある
    expect(await bad.run(['-f', 'b.kdr', 'variant-prop-add', 'btn', 'a,b'])).toBe(2)
    expect(await bad.run(['-f', 'b.kdr', 'variant-prop-add', 'i1', '色'])).toBe(2) // インスタンス
    expect(await bad.run(['-f', 'b.kdr', 'variant-prop-rename', 'btn', 'スタイル', 'a=b'])).toBe(2)
    expect(await bad.run(['-f', 'b.kdr', 'variant-value-rename', 'btn', 'スタイル', '強調', '標準'])).toBe(2) // もうある
    expect(await bad.run(['-f', 'b.kdr', 'variant-value-rename', 'btn', 'スタイル', 'ない', 'x'])).toBe(2)
  })

  it('variant-prop-order / variant-value-order でバリアントのプロパティ・値を並べ替える', async () => {
    const h = harness()
    expect(
      await h.run([
        ...argv('new + add frame --name Button --id btn + component btn + variant-add btn --id big'),
        '種類=大',
        ...['+', 'variant-prop-add', 'btn', 'サイズ', 'M'],
        ...['+', 'variant-prop-order', 'big', 'サイズ', '0'],
        '-o',
        'a.kdr',
      ]),
    ).toBe(0)
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    expect(nodes.btn.name).toBe('サイズ=M, 種類=標準')
    expect(nodes.big.name).toBe('サイズ=M, 種類=大')
    const setId = nodes.btn.parentId!
    const before = (nodes[setId] as FrameNode).children
    expect(before.indexOf('btn')).toBeLessThan(before.indexOf('big'))

    // 位置が並びより大きければ最後へ。値は並び（子の順）を入れ替える
    const move = harness(Object.fromEntries(h.fs))
    expect(await move.run(['-f', 'a.kdr', 'variant-value-order', setId, '種類', '大', '0', '+', 'variant-prop-order', 'btn', 'サイズ', '9', '-o', 'b.kdr'])).toBe(0)
    const after = (await move.doc('b.kdr')).pages[0].nodes
    const children = (after[setId] as FrameNode).children
    expect(children.indexOf('big')).toBeLessThan(children.indexOf('btn'))
    expect(after.btn.name).toBe('種類=標準, サイズ=M')
    expect(after.big.x).toBe(nodes.btn.x) // オートレイアウトのまとまりなので、並びに沿って位置も入れ替わる

    const bad = harness(Object.fromEntries(h.fs))
    expect(await bad.run(['-f', 'a.kdr', 'variant-prop-order', 'btn', 'ない', '0'])).toBe(2)
    expect(await bad.run(['-f', 'a.kdr', 'variant-prop-order', 'btn', 'サイズ', '-1'])).toBe(2)
    expect(await bad.run(['-f', 'a.kdr', 'variant-prop-order', 'btn', 'サイズ', '1.5'])).toBe(2)
    expect(await bad.run(['-f', 'a.kdr', 'variant-value-order', 'btn', '種類', 'ない', '0'])).toBe(2)
    expect(await bad.run(['-f', 'a.kdr', 'variant-value-order', 'btn', 'ない', '大', '0'])).toBe(2)
  })

  it('gradient --stop で色を 1 つだけ変え、種類を省くといまの種類のまま変える', async () => {
    const h = harness()
    expect(
      await h.run([
        ...argv('new + add rect --id a + add rect --id b + gradient radial a --colors #000,#888,#fff --center 0.3,0.3'),
        ...argv('+ gradient a --stop 1=#ff000080,-1=@90% + set b fill=#123456'),
        '-o',
        'a.kdr',
      ]),
    ).toBe(0)
    expect(h.stderr).toBe('')
    const paint = ((await h.doc('a.kdr')).pages[0].nodes.a as RectNode).fills[0]
    if (paint.type !== 'radial') throw new Error(`radial ではありません: ${paint.type}`)
    expect(paint.cx).toBe(0.3) // 種類も向きも受け継ぐ
    expect(paint.stops).toEqual([
      { offset: 0, color: '#000000', opacity: 1 },
      { offset: 0.5, color: '#ff0000', opacity: 0.502 },
      { offset: 0.9, color: '#ffffff', opacity: 1 },
    ])

    const edit = harness(Object.fromEntries(h.fs))
    expect(await edit.run(argv('-f a.kdr gradient linear a --stop 0=#00f -o b.kdr'))).toBe(0)
    const linear = ((await edit.doc('b.kdr')).pages[0].nodes.a as RectNode).fills[0]
    expect(linear.type).toBe('linear')
    if (linear.type !== 'linear') return
    expect(linear.stops[0].color).toBe('#0000ff')

    const bad = harness(Object.fromEntries(h.fs))
    expect(await bad.run(argv('-f a.kdr gradient a --stop 3=#f00'))).toBe(2) // 範囲の外
    expect(await bad.run(argv('-f a.kdr gradient a --stop 0=@95%'))).toBe(2) // 位置が戻る
    expect(await bad.run(argv('-f a.kdr gradient a --stop 1'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr gradient a --stop 1='))).toBe(2)
    expect(await bad.run(argv('-f a.kdr gradient a --stop x=#f00'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr gradient a --stop 1=red'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr gradient a --from 0,0'))).toBe(2) // radial に --from
    expect(await bad.run(argv('-f a.kdr gradient b --stop 0=#f00'))).toBe(2) // 単色
    expect(await bad.run(argv('-f a.kdr gradient a --add --colors #000,#fff'))).toBe(2) // --add に種類がない
  })

  it('gradient で直線・円形、3 色以上、塗りごとの不透明度のグラデーションを作る', async () => {
    const h = harness()
    expect(
      await h.run([
        ...argv('new + add rect --id a + add ellipse --id b + add rect --id c'),
        ...argv('+ gradient linear a --colors #f00,#00ff00@25%,#00f,#fff --angle -90 --opacity 0.5'),
        ...argv('+ gradient radial b --colors #000,#fff --center 0.3,40% --radius 0.8 --stroke'),
        ...argv('+ set c fill=#123456 + gradient radial c --add --colors #000@0.2,#fff + gradient linear c --index 0'),
        '-o',
        'a.kdr',
      ]),
    ).toBe(0)
    expect(h.stderr).toBe('')
    const { nodes } = (await h.doc('a.kdr')).pages[0]
    const a = nodes.a as unknown as { fills: unknown[] }
    expect(a.fills).toEqual([
      {
        type: 'linear',
        x1: 0.5,
        y1: 1,
        x2: 0.5,
        y2: 0,
        opacity: 0.5,
        visible: true,
        blendMode: 'normal',
        stops: [
          { offset: 0, color: '#ff0000', opacity: 1 },
          { offset: 0.25, color: '#00ff00', opacity: 1 },
          { offset: 0.625, color: '#0000ff', opacity: 1 },
          { offset: 1, color: '#ffffff', opacity: 1 },
        ],
      },
    ])
    const b = nodes.b as unknown as { strokes: unknown[] }
    expect(b.strokes).toEqual([
      {
        type: 'radial',
        cx: 0.3,
        cy: 0.4,
        rx: 0.8,
        ry: 0.8,
        angle: 0,
        fx: 0,
        fy: 0,
        opacity: 1,
        visible: true,
        blendMode: 'normal',
        stops: [
          { offset: 0, color: '#000000', opacity: 1 },
          { offset: 1, color: '#ffffff', opacity: 1 },
        ],
      },
    ])
    // 下の単色を直線に変え（色は受け継ぐ）、上に円形を重ねた
    const c = nodes.c as unknown as { fills: { type: string; stops?: { color: string; offset: number }[] }[] }
    expect(c.fills.map((paint) => paint.type)).toEqual(['linear', 'radial'])
    expect(c.fills[0].stops?.[0].color).toBe('#123456')
    expect(c.fills[1].stops?.[0].offset).toBe(0.2)

    // 円形の焦点（中心からのずれ。半径に対する割合）
    const focal = harness(Object.fromEntries(h.fs))
    expect(await focal.run(argv('-f a.kdr gradient radial b --stroke --focus -50%,0.25 -o g.kdr'))).toBe(0)
    expect(((await focal.doc('g.kdr')).pages[0].nodes.b as unknown as { strokes: unknown[] }).strokes[0]).toMatchObject({ type: 'radial', fx: -0.5, fy: 0.25 })
    expect(await focal.run(argv('-f a.kdr gradient radial b --focus 1,1'))).toBe(2) // 楕円の外
    expect(await focal.run(argv('-f a.kdr gradient linear a --focus 0,0'))).toBe(2)

    // #rrggbbaa・#rgba の色は、最後の桁を色ごとの不透明度にする
    const alpha = harness(Object.fromEntries(h.fs))
    expect(await alpha.run(argv('-f a.kdr gradient linear a --colors #ff0000,#ff000080,#f000 -o f.kdr'))).toBe(0)
    expect(((await alpha.doc('f.kdr')).pages[0].nodes.a as unknown as { fills: { stops: unknown[] }[] }).fills[0].stops).toEqual([
      { offset: 0, color: '#ff0000', opacity: 1 },
      { offset: 0.5, color: '#ff0000', opacity: 0.502 },
      { offset: 1, color: '#ff0000', opacity: 0 },
    ])

    // --colors を省くと、いまのグラデーションの色のまま種類と向きだけ変える
    const edit = harness(Object.fromEntries(h.fs))
    expect(await edit.run(argv('-f a.kdr gradient radial a --radius 50%,25% -o b.kdr'))).toBe(0)
    const changed = (await edit.doc('b.kdr')).pages[0].nodes.a as unknown as { fills: { type: string; ry: number; stops: unknown[]; opacity: number }[] }
    expect(changed.fills[0].type).toBe('radial')
    expect(changed.fills[0].ry).toBe(0.25)
    expect(changed.fills[0].stops).toHaveLength(4)
    expect(changed.fills[0].opacity).toBe(0.5)

    // 角度のグラデーション: 中心と最初の色の向き。--hidden で隠す（消さずに残す）
    const conic = harness(Object.fromEntries(h.fs))
    expect(await conic.run(argv('-f a.kdr gradient conic a --center 25%,0.75 --angle 450 + gradient linear c --index 0 --hidden -o d.kdr'))).toBe(0)
    const turned = (await conic.doc('d.kdr')).pages[0].nodes
    expect((turned.a as unknown as { fills: unknown[] }).fills[0]).toMatchObject({ type: 'conic', cx: 0.25, cy: 0.75, angle: 90, opacity: 0.5, visible: true, blendMode: 'normal' as const })
    expect((turned.a as unknown as { fills: { stops: unknown[] }[] }).fills[0].stops).toHaveLength(4)
    expect((turned.c as unknown as { fills: unknown[] }).fills[0]).toMatchObject({ type: 'linear', visible: false, blendMode: 'normal' as const })
    // 直線の始点・終点を自由に置く
    expect(await conic.run(argv('-f d.kdr gradient linear c --index 0 --from 10%,0.2 --to 0.9,120% -o e.kdr'))).toBe(0)
    expect(((await conic.doc('e.kdr')).pages[0].nodes.c as unknown as { fills: unknown[] }).fills[0]).toMatchObject({ x1: 0.1, y1: 0.2, x2: 0.9, y2: 1.2 })
    expect(await conic.run(argv('-f d.kdr gradient linear c --angle 45 --from 0,0'))).toBe(2)
    expect(await conic.run(argv('-f d.kdr gradient radial c --to 0,0'))).toBe(2)

    const bad = harness(Object.fromEntries(h.fs))
    expect(await bad.run(argv('-f a.kdr gradient spiral a --colors #000,#fff'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr gradient conic a --radius 0.5'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr gradient linear a --colors #000'))).toBe(2) // 1 色
    expect(await bad.run(argv('-f a.kdr gradient linear a --colors #000@60%,#fff@30%'))).toBe(2) // 位置が戻る
    expect(await bad.run(argv('-f a.kdr gradient linear a --colors red,#fff'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr gradient linear a --colors #00000,#fff'))).toBe(2) // 5 桁
    expect(await bad.run(argv('-f a.kdr gradient linear a --center 0.5,0.5'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr gradient radial a --blend nope'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr gradient linear a --index 3'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr gradient linear a --index 0 --add'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr gradient linear a --opacity 2'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr add text --text hi --id t + gradient linear t --stroke --colors #000,#fff'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr add rect --id e + set e fill=null + gradient linear e'))).toBe(2) // 塗りがなく色もない
  })

  it('dup・mv・order・rm と「@」', async () => {
    const h = harness()
    await h.run(argv(
      'new + add frame --id f --x 100 --y 100 + add rect --id r --x 10 --y 10 --width 10 --height 10' +
        ' + dup r --offset 5 + set @ name=Copy + mv r --parent f + order back Copy + rm Rectangle -o a.kdr',
    ))
    expect(h.stderr).toBe('')
    const page = (await h.doc('a.kdr')).pages[0]
    const copy = nodeByName({ pages: [page] } as DesignDocument, 'Copy')
    expect(copy).toMatchObject({ x: 15, y: 15 })
    expect(page.rootIds).toEqual([copy.id, 'f'])
    // 複製の名前を Copy に変えたので、「Rectangle」で指したのは元の r
    expect(page.nodes.r).toBeUndefined()
  })

  it('折り返し・行の間隔・大きさの決め方・下限と上限を設定でき、editor と同じく並べ直す', async () => {
    const h = harness()
    await h.run(argv(
      'new + add frame --name Tags --id tags --width 100 --height 10' +
        ' + add rect --name A --parent tags --width 40 --height 20' +
        ' + add rect --name B --parent tags --width 40 --height 20' +
        ' + add rect --name C --parent tags --width 40 --height 20' +
        ' + auto-layout tags padding=0 gap=8 wrap=true crossGap=6 sizing.width=fixed + set tags width=100 -o a.kdr',
    ))
    const doc = await h.doc('a.kdr')
    expect(doc.pages[0].nodes.tags).toMatchObject({ width: 100, height: 20 + 6 + 20, layout: { wrap: true, crossGap: 6 } })
    expect(nodeByName(doc, 'C')).toMatchObject({ x: 0, y: 26 })

    // 親いっぱいに伸ばした子と、中身に合わせるフレームに下限・上限を付ける（固定の大きさには効かない）。null で外せる
    await h.run(argv('-f a.kdr -w set tags layout.wrap=false layout.direction=vertical minHeight=100 + layout-fill width A + set A maxWidth=60 minHeight=30'))
    const limited = await h.doc('a.kdr')
    expect(nodeByName(limited, 'A')).toMatchObject({ width: 60, height: 20, maxWidth: 60, minHeight: 30 })
    expect(limited.pages[0].nodes.tags).toMatchObject({ height: 100, minHeight: 100 })
    await h.run(argv('-f a.kdr -w set A maxWidth=null'))
    expect(nodeByName(await h.doc('a.kdr'), 'A')).toMatchObject({ width: 100, maxWidth: null })

    expect(await h.run(argv('-f a.kdr -w set A minWidth=-1'))).toBe(1)
    expect(h.stderr).toMatch(/^kdr: set: .*minWidth/)
  })

  it('親の辺への固定・折り返した行の配置・テキストの幅の上限を設定できる', async () => {
    const h = harness()
    await h.run(argv(
      'new + add frame --name Card --id card --width 200 --height 100' +
        ' + add rect --name Badge --id badge --parent card --x 150 --y 10 --width 30 --height 20' +
        ' + set badge constraints.horizontal=end + set card width=300 -o a.kdr',
    ))
    const doc = await h.doc('a.kdr')
    expect(doc.pages[0].nodes.badge).toMatchObject({ x: 250, constraints: { horizontal: 'end', vertical: 'start' } })
    expect(await h.run(argv('-f a.kdr -w set badge constraints.vertical=bottom'))).toBe(1)
    expect(h.stderr).toMatch(/constraints\.vertical/)

    await h.run(argv('-f a.kdr -w auto-layout card wrap=true alignContent=space-between'))
    expect((await h.doc('a.kdr')).pages[0].nodes.card).toMatchObject({ layout: { wrap: true, alignContent: 'space-between' } })

    // 中身に合わせるテキストは、上限を超えると折り返して高さが増える
    await h.run(argv('-f a.kdr -w add text --name Label --id label --text あいうえおかきくけこさしすせそ + set label maxWidth=60'))
    const label = (await h.doc('a.kdr')).pages[0].nodes.label
    expect(label.width).toBeLessThanOrEqual(60)
    expect(label.height).toBeGreaterThan(30)
    // テキストの高さの下限・上限で、測り直した高さを収める
    await h.run(argv('-f a.kdr -w set label minHeight=200'))
    expect((await h.doc('a.kdr')).pages[0].nodes.label).toMatchObject({ height: 200, minHeight: 200 })
    await h.run(argv('-f a.kdr -w set label minHeight=null maxHeight=20'))
    expect((await h.doc('a.kdr')).pages[0].nodes.label).toMatchObject({ height: 20, maxHeight: 20 })
  })

  it('壊れた値は書き出さず、どのコマンドかを添えてエラーにする', async () => {
    const h = harness()
    await h.run(argv('new + add rect --name Box -o a.kdr'))
    const before = h.fs.get('a.kdr')
    expect(await h.run(argv('-f a.kdr -w set Box fill=red'))).toBe(1)
    expect(h.stderr).toMatch(/^kdr: set: .*#rrggbb/)
    expect(h.fs.get('a.kdr')).toBe(before)
  })

  it('使い方の誤りは終了コード 2', async () => {
    const cases: [string, RegExp][] = [
      ['new + new', /先頭にだけ/],
      ['new + add star', /不明な種類/],
      ['new + set fill=#ffffff', /ノードを指定/],
      ['new + add rect + set Rectangle', /名前=値/],
      ['new + add rect --bogus 1', /不明なオプション/],
      ['new + add rect + set Nothing x=1', /見つかりません/],
      ['new + add rect + add rect + set Rectangle x=1', /2 個あります/],
      ['new + add rect + set @ x=abc', /数値ではありません/],
      ['new + add rect + ls', /どちらも標準出力/],
      ['new + add rect --id bad!', /英数字/],
      ['frobnicate', /不明なコマンド/],
    ]
    for (const [line, message] of cases) {
      const h = harness()
      expect(await h.run(argv(line)), line).toBe(2)
      expect(h.stderr, line).toMatch(message)
    }
  })

  it('入出力の組み合わせを確かめる', async () => {
    const tty = harness({}, { tty: true })
    expect(await tty.run(argv('new'))).toBe(2)
    expect(tty.stderr).toMatch(/端末には出力しません/)
    expect(await tty.run(argv('ls'))).toBe(2)
    expect(tty.stderr).toMatch(/入力の kdr がありません/)
    const h = harness()
    expect(await h.run(argv('-w ls'))).toBe(2)
  })

  it('信頼できない入力（gzip でない・壊れた JSON）はエラーにする', async () => {
    const h = harness({ 'bad.kdr': new TextEncoder().encode('hello'), 'bad2.kdr': gzipSync(`{"format":"kadrokreo","version":${KDR_VERSION}}`) })
    expect(await h.run(argv('-f bad.kdr info'))).toBe(1)
    expect(h.stderr).toMatch(/gzip/)
    expect(await h.run(argv('-f bad2.kdr info'))).toBe(1)
  })

  it('古い版の kdr は読まず、エラーにする', async () => {
    const old = gzipSync(JSON.stringify({ format: 'kadrokreo', version: KDR_VERSION - 1, document: { name: 'x', pages: [], assets: {} } }))
    const h = harness({ 'old.kdr': new Uint8Array(old) })
    expect(await h.run(argv('-f old.kdr -o new.kdr'))).toBe(1)
    expect(h.stderr).toMatch(/古いバージョン/)
    expect(h.fs.has('new.kdr')).toBe(false)
  })

  it('塗り・線・影は略記でも、配列のまま JSON でも書ける。書き出す kdr は既定値を省く', async () => {
    const h = harness()
    await h.run([
      'new', '+', 'add', 'rect', '--name', 'Box', 'stroke=#112233', 'strokeWidth=2', 'shadow.blur=4',
      '+', 'add', 'ellipse', '--name', 'Dot', 'fills=[{"type":"linear","x1":0,"y1":0.5,"x2":1,"y2":0.5,"stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#ffffff"}]}]',
      '-o', 'a.kdr',
    ])
    expect(h.stderr).toBe('')
    const doc = await h.doc('a.kdr')
    expect(nodeByName(doc, 'Box')).toMatchObject({
      strokes: [{ type: 'solid', color: '#112233', opacity: 1, visible: true, blendMode: 'normal' as const }],
      strokeWidth: 2,
      effects: [{ type: 'drop-shadow', x: 0, y: 4, blur: 4, color: '#000000', opacity: 0.25, visible: true, spread: 0 }],
    })
    expect(nodeByName(doc, 'Dot')).toMatchObject({ fills: [{ type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, opacity: 1, visible: true, blendMode: 'normal' as const }] })
    await h.run(argv('-f a.kdr -w set Box fill=null shadow=null'))
    expect(nodeByName(await h.doc('a.kdr'), 'Box')).toMatchObject({ fills: [], effects: [] })
    const file = (await readKdrArchive(new Blob([new Uint8Array(h.fs.get('a.kdr')!)]))).document as { document: { pages: { children: { name: string }[] }[] } }
    const box = file.document.pages[0].children.find((node: { name: string }) => node.name === 'Box')
    expect(box).not.toHaveProperty('fills')
    expect(box).not.toHaveProperty('rotation')
    expect(box).not.toHaveProperty('parentId')
  })

  it('影の広がり・ぼかし・描画モードは略記と set で書け、gradient は円形を回し、塗りの描画モードを選べる', async () => {
    const h = harness()
    await h.run([
      'new', '+', 'add', 'rect', '--name', 'Box', 'blur=6', 'shadow.spread=2', 'backgroundBlur=10', 'blendMode=multiply',
      '+', 'add', 'text', '--text', 'Hi', '--name', 'Label', 'shadow.blur=3',
      '+', 'gradient', 'radial', 'Box', '--colors', '#ffffff,#000000', '--angle', '30', '--blend', 'screen',
      '-o', 'a.kdr',
    ])
    expect(h.stderr).toBe('')
    const doc = await h.doc('a.kdr')
    expect(nodeByName(doc, 'Box')).toMatchObject({
      blendMode: 'multiply',
      // 影の略記は、ぼかしの前に影を足す
      effects: [{ type: 'drop-shadow', spread: 2 }, { type: 'layer-blur', blur: 6 }, { type: 'background-blur', blur: 10 }],
      fills: [{ type: 'radial', angle: 30, fx: 0, fy: 0, blendMode: 'screen' }],
    })
    expect(nodeByName(doc, 'Label')).toMatchObject({ effects: [{ type: 'drop-shadow', blur: 3 }] })
    await h.run(argv('-f a.kdr -w set Box blur=null shadow=null'))
    expect(nodeByName(await h.doc('a.kdr'), 'Box')).toMatchObject({ effects: [{ type: 'background-blur', blur: 10 }] })
    const bad = harness()
    bad.fs.set('a.kdr', h.fs.get('a.kdr')!)
    expect(await bad.run(argv('-f a.kdr set Box blur=-1'))).toBe(2)
    expect(await bad.run(argv('-f a.kdr set Box blendMode=add'))).not.toBe(0)
  })

  it('角丸は 4 隅ばらばらにも書ける。円形のグラデーションや文字の太さも JSON や数値で書ける', async () => {
    const h = harness()
    await h.run([
      'new', '+', 'add', 'rect', '--name', 'Tab', 'cornerRadius=8,8,0,0',
      'fills=[{"type":"radial","cx":0.5,"cy":0.5,"rx":0.5,"ry":0.5,"stops":[{"offset":0,"color":"#ffffff"},{"offset":1,"color":"#000000"}]}]',
      '+', 'add', 'text', '--text', 'Hi', '--name', 'Label', 'fontWeight=300',
      '-o', 'a.kdr',
    ])
    expect(h.stderr).toBe('')
    const doc = await h.doc('a.kdr')
    expect(nodeByName(doc, 'Tab')).toMatchObject({ cornerRadius: [8, 8, 0, 0], fills: [{ type: 'radial', rx: 0.5, opacity: 1, visible: true, angle: 0, fx: 0, fy: 0, blendMode: 'normal' as const }] })
    expect(nodeByName(doc, 'Label')).toMatchObject({ fontWeight: 300 })
    await h.run(argv('-f a.kdr -w set Tab cornerRadius=4'))
    expect(nodeByName(await h.doc('a.kdr'), 'Tab')).toMatchObject({ cornerRadius: 4 })
    expect(await h.run(argv('-f a.kdr -w set Tab cornerRadius=1,2,3'))).toBe(2)
    expect(h.stderr).toMatch(/左上,右上,右下,左下/)
    expect(await h.run(argv('-f a.kdr -w set Label fontWeight=350'))).toBe(1)
    // 塗りごとの不透明度は番号でつないで書く
    expect(await h.run(argv('-f a.kdr -w set Tab fills.0.opacity=0.5'))).toBe(0)
    expect(nodeByName(await h.doc('a.kdr'), 'Tab')).toMatchObject({ fills: [{ opacity: 0.5 }] })
    expect(await h.run(argv('-f a.kdr -w set Tab fills.0.opacity=2'))).toBe(1)
    expect(h.stderr).toMatch(/fills\[0\]\.opacity/)
  })

  it('--help と help コマンド', async () => {
    const h = harness()
    await h.run(['--help'])
    expect(h.stdout).toContain('kdr [-f 入力.kdr]')
    const one = harness()
    await one.run(['help', 'set'])
    expect(one.stdout).toMatch(/^kdr set ノード… 名前=値…/)
  })
})
