import { describe, expect, it } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { type IO, run } from './run.ts'

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

  it('png はドキュメントを変えないので、kdr を書き出さない', async () => {
    const h = harness()
    await h.run(SETUP)
    expect(await h.run('-f in.kdr png Box')).toBe(0)
    expect(h.stdout).toBe('')
    expect(h.stdoutBytes).toBeNull()
  })
})
