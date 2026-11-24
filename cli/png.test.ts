import { describe, expect, it } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { type IO, run } from './run.ts'
import { testFontBytes } from '../src/document/testFont.ts'

// png コマンド。描画は本体の render.ts を @napi-rs/canvas に描かせているので、画素をいくつか確かめる

function harness(options: { tty?: boolean } = {}) {
  const fs = new Map<string, Uint8Array>()
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
    readStdin: async () => new Uint8Array(),
    stdinIsTTY: true,
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
    run: (line: string) => run(line.split(' '), io),
    get stdout() {
      return stdout
    },
    get stdoutBytes() {
      return stdoutBytes
    },
    get stderr() {
      return stderr
    },
  }
}

/** PNG を読み、大きさと、指定した点の RGBA を返す */
async function pixels(png: Uint8Array) {
  const image = await loadImage(Buffer.from(png))
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  return {
    width: image.width,
    height: image.height,
    at: (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data],
  }
}

/** 色が近い（半透明の合成の丸めで 1〜2 ずれる） */
function near(actual: number[], expected: number[]) {
  actual.forEach((value, i) => expect(Math.abs(value - expected[i])).toBeLessThanOrEqual(3))
}

// 100×60 の赤いカード（左上が 10,10）の中に、青い 20×20 の四角（カードの 10,10）。右に半透明の緑の円
const SETUP =
  'new Demo + add frame --name Card --x 10 --y 10 --width 100 --height 60 fill=#ff0000' +
  ' + add rect --parent Card --name Box --x 10 --y 10 --width 20 --height 20 fill=#0000ff' +
  ' + add ellipse --name Dot --x 130 --y 10 --width 20 --height 20 fill=#00ff00 opacity=0.5 -o in.kdr'

describe('png', () => {
  it('ノードなしならページ全体を、viewer と同じ名前で書き出す。透明な背景と半透明も描ける', async () => {
    const h = harness()
    expect(await h.run(SETUP)).toBe(0)
    expect(await h.run('-f in.kdr png')).toBe(0)
    expect(h.stderr).toBe('kdr: PNG を書き出しました: Demo - Page 1.png\n')
    const image = await pixels(h.fs.get('Demo - Page 1.png')!)
    // カードの左上からドットの右下まで（10,10 から 150,70）
    expect([image.width, image.height]).toEqual([140, 60])
    expect(image.at(2, 2)).toEqual([255, 0, 0, 255])
    expect(image.at(15, 15)).toEqual([0, 0, 255, 255])
    expect(image.at(130, 10)).toEqual([0, 255, 0, 128])
    // カードとドットのあいだは透明
    expect(image.at(110, 30)[3]).toBe(0)
  })

  it('ノードを選ぶとそれを囲む範囲。--scale で倍率をかけ、ファイル名に @2x を付ける', async () => {
    const h = harness()
    await h.run(SETUP)
    expect(await h.run('-f in.kdr png Box --scale 2')).toBe(0)
    const image = await pixels(h.fs.get('Box@2x.png')!)
    expect([image.width, image.height]).toEqual([40, 40])
    expect(image.at(20, 20)).toEqual([0, 0, 255, 255])

    // いくつも選べば「先頭 ほか n 個」。祖先と一緒に選んだものは祖先と一緒に描く
    await h.run('-f in.kdr png Card Box Dot')
    expect([...h.fs.keys()]).toContain('Card ほか 1 個.png')
  })

  it('--each はノードごとのファイル、--to - は標準出力', async () => {
    const h = harness()
    await h.run(SETUP)
    expect(await h.run('-f in.kdr png Card Dot --each --to out')).toBe(0)
    expect([...h.fs.keys()]).toEqual(expect.arrayContaining(['out/Card.png', 'out/Dot.png']))

    expect(await h.run('-f in.kdr png Dot --to -')).toBe(0)
    expect((await pixels(h.stdoutBytes!)).width).toBe(20)
  })

  it('標準出力がぶつかる組み合わせ・端末への出力・空のページはエラー', async () => {
    const h = harness()
    await h.run(SETUP)
    expect(await h.run('-f in.kdr png Dot --to - + ls')).toBe(2)
    expect(h.stderr).toContain('ほかの標準出力への出力と一緒にできません')
    expect(await h.run('-f in.kdr set Dot opacity=1 + png Dot --to -')).toBe(2)
    expect(await h.run('-f in.kdr png --each')).toBe(2)
    expect(await h.run('-f in.kdr png --scale 0')).toBe(2)
    expect(await h.run('new Empty + png -o e.kdr')).toBe(2)
    expect(h.stderr).toContain('ページが空です')

    const tty = harness({ tty: true })
    await tty.run(SETUP)
    expect(await tty.run('-f in.kdr png Dot --to -')).toBe(2)
  })

  it('--background で範囲全体に背景を敷く（半透明はその上に混ざる）。範囲に線の太さのはみ出しを含める', async () => {
    const h = harness()
    await h.run(SETUP)
    expect(await h.run('-f in.kdr png Dot --background #000 --to dot.png')).toBe(0)
    const image = await pixels(h.fs.get('dot.png')!)
    expect(image.at(0, 0)).toEqual([0, 0, 0, 255])
    expect(image.at(10, 10)).toEqual([0, 128, 0, 255])
    expect(await h.run('-f in.kdr png Dot --background red')).toBe(2)
    expect(h.stderr).toContain('png: --background は #rrggbb か #rgb です')

    // 太さ 4 の線は枠の外へ 2 出る
    expect(await h.run('-f in.kdr set Box stroke=#000000 strokeWidth=4 + png Box --to box.png -o in.kdr')).toBe(0)
    const box = await pixels(h.fs.get('box.png')!)
    expect([box.width, box.height]).toEqual([24, 24])
    expect(box.at(0, 12)).toEqual([0, 0, 0, 255])
  })

  it('半透明の通過のフレームは、子の描画モードが後ろにも効く。通過でなければ中身をまとめてから混ぜる', async () => {
    const h = harness()
    // 黄色の上に、半透明のフレーム（塗りなし）。中のシアンは乗算で、後ろの黄色と混ざると緑になる
    const setup =
      'new Demo + add rect --name Back --width 40 --height 40 fill=#ffff00' +
      ' + add frame --name Group --width 40 --height 40 fills=[] opacity=0.5' +
      ' + add rect --parent Group --name Cyan --width 40 --height 40 fill=#00ffff blendMode=multiply -o in.kdr'
    expect(await h.run(setup)).toBe(0)
    expect(await h.run('-f in.kdr png --to isolated.png')).toBe(0)
    near((await pixels(h.fs.get('isolated.png')!)).at(20, 20), [128, 255, 128, 255])
    expect(await h.run('-f in.kdr set Group passThrough=true + png --to pass.png -o in.kdr')).toBe(0)
    near((await pixels(h.fs.get('pass.png')!)).at(20, 20), [128, 255, 0, 255])
  })

  it('テキストの背景のぼかしは、文字の形の内側だけで後ろをぼかす', async () => {
    const h = harness()
    // 左半分が黒、右半分が白。境目にまたがる透明な文字
    const setup =
      'new Demo + add rect --name Black --width 200 --height 80 fill=#000000' +
      ' + add rect --name White --x 200 --width 200 --height 80 fill=#ffffff' +
      ' + add text --name Glass --x 120 --y 0 --text WWW fontSize=64 fills.0.opacity=0 -o in.kdr'
    expect(await h.run(setup)).toBe(0)
    expect(await h.run('-f in.kdr png --to sharp.png')).toBe(0)
    expect(await h.run('-f in.kdr set Glass backgroundBlur=30 + png --to blurred.png -o in.kdr')).toBe(0)
    const sharp = await pixels(h.fs.get('sharp.png')!)
    const blurred = await pixels(h.fs.get('blurred.png')!)
    // 文字の外（上の端・左右の端）は変わらない
    for (const [x, y] of [[2, 2], [398, 2], [2, 78], [398, 78]]) expect(blurred.at(x, y)).toEqual(sharp.at(x, y))
    // 境目のあたりのどこかが、黒と白の中間になる
    let mixed = 0
    for (let x = 160; x < 240; x++) for (let y = 10; y < 70; y++) {
      const [r] = blurred.at(x, y)
      if (r > 40 && r < 215 && sharp.at(x, y)[0] !== r) mixed++
    }
    expect(mixed).toBeGreaterThan(20)
  })

  it('kdr に埋め込んだ書体で描く（OS にない書体でも）', async () => {
    const h = harness()
    // テスト用の書体は、どの字も送り幅 0.6em・高さ 0.7em の黒い四角
    h.fs.set('box.ttf', testFontBytes({ family: 'PngBox' }))
    const setup = 'new Demo + font-add box.ttf + add text --name T --text AB fontSize=100 fontFamily=PngBox fill=#000000 -o in.kdr'
    expect(await h.run(setup)).toBe(0)
    expect(h.stderr).toContain('書体を埋め込みました: PngBox')
    expect(await h.run('-f in.kdr png T --to t.png')).toBe(0)
    const image = await pixels(h.fs.get('t.png')!)
    // 1 字目の四角は x が 5〜55、高さ 70 の範囲。その四隅の内側と真ん中が黒く、字の間（55〜65）は描かれない
    const inked = Array.from({ length: image.height }, (_, y) => y).filter((y) => image.at(30, y)[3] > 128)
    const [top, bottom] = [inked[0], inked.at(-1)!]
    expect(bottom - top).toBeGreaterThan(60)
    expect(bottom - top).toBeLessThan(75)
    for (const [x, y] of [[8, top + 3], [52, top + 3], [8, bottom - 3], [52, bottom - 3], [30, (top + bottom) / 2]]) {
      expect(image.at(x, Math.round(y))).toEqual([0, 0, 0, 255])
    }
    expect(image.at(60, Math.round((top + bottom) / 2))[3]).toBe(0)
    expect(image.at(68, Math.round((top + bottom) / 2))).toEqual([0, 0, 0, 255])
  })

  it('png はドキュメントを変えないので、kdr を書き出さない', async () => {
    const h = harness()
    await h.run(SETUP)
    expect(await h.run('-f in.kdr png Box')).toBe(0)
    expect(h.stdout).toBe('')
    expect(h.stdoutBytes).toBeNull()
  })
})
