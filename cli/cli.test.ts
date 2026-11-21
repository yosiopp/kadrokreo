import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { KDR_VERSION, decodeKdr } from '../src/document/kdr.ts'
import type { DesignDocument, FrameNode, TextNode } from '../src/document/types.ts'
import { type IO, run } from './run.ts'

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
    expect(card).toMatchObject({ type: 'frame', width: 320, fill: '#f5f5ff', cornerRadius: 12 })
    const btn = nodeByName(doc, 'Btn')
    expect(btn).toMatchObject({ parentId: 'card', x: 16, y: 60, fill: '#5b4cf5' })
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
    expect(await third.run(argv('get Box fill'))).toBe(0)
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
    expect(nodeByName(doc, 'Text')).toMatchObject({ autoWidth: true, width: 60, height: 24 })
    // 1 行に 3 文字（16px × 3 = 48 ≦ 50）で 4 行
    expect(nodeByName(doc, 'Wrap')).toMatchObject({ autoWidth: false, width: 50, height: Math.ceil(4 * 16 * 1.2) })
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
    expect(nodeByName(doc, 'Line')).toMatchObject({ x: 0, y: 0, width: 100, height: 50, direction: 'up', flipped: true, endCap: 'arrow' })
    expect(nodeByName(doc, 'Path')).toMatchObject({ width: 100, height: 80, closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] })
    const image = nodeByName(doc, 'Image')
    expect(image).toMatchObject({ width: 20, height: 10 })
    expect(Object.values(doc.assets)).toEqual([{ mime: 'image/png', data: Buffer.from(png).toString('base64') }])
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
    expect(instance).toMatchObject({ x: 200, fill: '#123456' })
    expect(instance.component?.role).toBe('instance')
    const label = doc.pages[1].nodes[instance.children[0]] as TextNode
    expect(label.text).toBe('Cancel')
    expect(Object.values(instance.component?.role === 'instance' ? instance.component.overrides : {})).toEqual([{ text: 'Cancel' }])
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

  it('kdr v14 の折り返し・行の間隔・大きさの下限と上限を設定でき、editor と同じく並べ直す', async () => {
    const h = harness()
    await h.run(argv(
      'new + add frame --name Tags --id tags --width 100 --height 10' +
        ' + add rect --name A --parent tags --width 40 --height 20' +
        ' + add rect --name B --parent tags --width 40 --height 20' +
        ' + add rect --name C --parent tags --width 40 --height 20' +
        ' + auto-layout tags padding=0 gap=8 wrap=true crossGap=6 widthMode=fixed + set tags width=100 -o a.kdr',
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

  it('古い版の kdr を読み、-o で今の版に書き直せる', async () => {
    const fixture = readFileSync(join(import.meta.dirname, '../e2e/fixtures/sample-v1.kdr'))
    const h = harness({ 'old.kdr': new Uint8Array(fixture) })
    expect(await h.run(argv('-f old.kdr -o new.kdr'))).toBe(0)
    expect(JSON.parse(gunzipSync(h.fs.get('new.kdr')!).toString()).version).toBe(KDR_VERSION)
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
