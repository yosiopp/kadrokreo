import { describe, expect, it } from 'vitest'
import { type IO, run } from './run.ts'

// svg-out コマンド（SVG の書き出し）。中身の書き方は src/editor/svg/roundTrip.test.ts で確かめている

function harness(options: { tty?: boolean } = {}) {
  const fs = new Map<string, Uint8Array>()
  let stdout = ''
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
      stdout += typeof data === 'string' ? data : new TextDecoder().decode(data)
    },
    stderr: (text) => {
      stderr += text
    },
  }
  return {
    fs,
    text: (path: string) => new TextDecoder().decode(fs.get(path)),
    run: (line: string) => run(line.split(' '), io),
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
  }
}

const SETUP =
  'new Demo + add frame --name Card --x 10 --y 10 --width 100 --height 60 fill=#ff0000' +
  ' + add rect --parent Card --name Box --x 10 --y 10 --width 20 --height 20 fill=#0000ff' +
  ' + add text --parent Card --name Label --x 40 --y 10 --text Hello' +
  ' + add ellipse --name Dot --x 130 --y 10 --width 20 --height 20 fill=#00ff00 opacity=0.5 -o in.kdr'

describe('svg-out', () => {
  it('ノードなしならページ全体を、viewer と同じ名前で書き出す', async () => {
    const h = harness()
    expect(await h.run(SETUP)).toBe(0)
    expect(await h.run('-f in.kdr svg-out')).toBe(0)
    expect(h.stderr).toBe('kdr: SVG を書き出しました: Demo - Page 1.svg\n')
    const svg = h.text('Demo - Page 1.svg')
    expect(svg).toContain('width="140" height="60" viewBox="10 10 140 60"')
    expect(svg).toContain('<g id="Card" transform="translate(10 10)"><rect width="100" height="60" fill="#ff0000"/>')
    expect(svg).toContain('<rect id="Box" transform="translate(10 10)" width="20" height="20" fill="#0000ff"/>')
    expect(svg).toMatch(/<text id="Label"[^>]*><tspan [^>]*>Hello<\/tspan><\/text>/)
    expect(svg).toContain('<ellipse id="Dot" transform="translate(130 10)" opacity="0.5"')
  })

  it('ノードを選ぶとそれを囲む範囲。--each はノードごと、--to - は標準出力（端末にも出せる）', async () => {
    const h = harness()
    await h.run(SETUP)
    expect(await h.run('-f in.kdr svg-out Box')).toBe(0)
    expect(h.text('Box.svg')).toContain('viewBox="20 20 20 20"')
    expect(await h.run('-f in.kdr svg-out Card Dot --each --to out')).toBe(0)
    expect([...h.fs.keys()]).toEqual(expect.arrayContaining(['out/Card.svg', 'out/Dot.svg']))

    const tty = harness({ tty: true })
    await tty.run(SETUP)
    expect(await tty.run('-f in.kdr svg-out Dot --to -')).toBe(0)
    expect(tty.stdout).toMatch(/^<svg [^>]*viewBox="130 10 20 20"/)
  })

  it('書き出した SVG は svg コマンドで取り込み直せる', async () => {
    const h = harness()
    await h.run(SETUP)
    await h.run('-f in.kdr svg-out Card --to card.svg')
    expect(await h.run('new Back + svg card.svg -o back.kdr')).toBe(0)
    expect(await h.run('-f back.kdr ls')).toBe(0)
    expect(h.stdout).toContain('Box')
    expect(h.stdout).toContain('Label')
  })

  it('--no-ids は id を付けず、--background は範囲全体に背景の色を敷く', async () => {
    const h = harness()
    await h.run(SETUP)
    expect(await h.run('-f in.kdr svg-out Dot --no-ids --background #FFF --to dot.svg')).toBe(0)
    const svg = h.text('dot.svg')
    expect(svg).not.toContain('id="Dot"')
    expect(svg).toContain('<rect x="130" y="10" width="20" height="20" fill="#ffffff"/><ellipse transform="translate(130 10)"')
    expect(await h.run('-f in.kdr svg-out Dot --background red')).toBe(2)
    expect(h.stderr).toContain('--background は #rrggbb か #rgb です')
  })

  it('標準出力がぶつかる組み合わせ・空のページ・--each だけはエラー', async () => {
    const h = harness()
    await h.run(SETUP)
    expect(await h.run('-f in.kdr svg-out Dot --to - + ls')).toBe(2)
    expect(h.stderr).toContain('ほかの標準出力への出力と一緒にできません')
    expect(await h.run('-f in.kdr svg-out --each')).toBe(2)
    expect(await h.run('-f in.kdr svg-out Dot --scale 2')).toBe(2)
    expect(await h.run('new Empty + svg-out -o e.kdr')).toBe(2)
    expect(h.stderr).toContain('ページが空です')
  })
})
