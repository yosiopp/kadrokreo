import { describe, expect, it } from 'vitest'
import { decodeKdr } from '../src/document/kdr.ts'
import { regularPolygon, star } from '../src/document/polygon.ts'
import type { DesignDocument, PathNode } from '../src/document/types.ts'
import { type IO, run } from './run.ts'

// add polygon / add star と、マークアップの <polygon> <star>。どちらもふつうの閉じたパスになる

function harness(files: Record<string, string> = {}) {
  const fs = new Map<string, Uint8Array>(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)]))
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
    stdoutIsTTY: false,
    stdout: (data) => {
      if (typeof data === 'string') stdout += data
    },
    stderr: (text) => {
      stderr += text
    },
  }
  return {
    run: (argv: string[]) => run(argv, io),
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    doc: (path: string): Promise<DesignDocument> => decodeKdr(new Blob([new Uint8Array(fs.get(path)!)])),
  }
}

const argv = (line: string) => line.split(' ')
const byName = (doc: DesignDocument, name: string) => Object.values(doc.pages[0].nodes).find((node) => node.name === name) as PathNode

describe('add polygon / add star', () => {
  it('頂点の数を指定した正多角形と星を、閉じたパスとして作る', async () => {
    const h = harness()
    const code = await h.run(argv('new + add polygon --name Hex --count 6 --x 10 --y 20 --width 80 fill=#5b4cf5 + add star --name Rate --count 5 --ratio 0.5 --height 30 -o a.kdr'))
    expect(h.stderr).toBe('')
    expect(code).toBe(0)
    const doc = await h.doc('a.kdr')
    const hex = byName(doc, 'Hex')
    expect(hex).toMatchObject({ type: 'path', closed: true, x: 10, y: 20, width: 80, points: regularPolygon(6).points })
    // 高さを省くと、正六角形になる縦横比で決める
    expect(hex.height).toBeCloseTo(80 / regularPolygon(6).aspect, 2)
    expect(hex.fills[0]).toMatchObject({ color: '#5b4cf5' })
    // 長方形・楕円と同じく線は付けない
    expect(hex.strokes).toEqual([])
    const rate = byName(doc, 'Rate')
    expect(rate).toMatchObject({ type: 'path', closed: true, height: 30, points: star(5, 0.5).points })
    expect(rate.width).toBeCloseTo(30 * star(5, 0.5).aspect, 2)
  })

  it('既定は三角形と、先が 5 つの星。大きさを省くと幅 100', async () => {
    const h = harness()
    expect(await h.run(argv('new + add polygon + add star -o a.kdr'))).toBe(0)
    const doc = await h.doc('a.kdr')
    expect(byName(doc, 'Polygon')).toMatchObject({ width: 100, points: regularPolygon(3).points })
    expect(byName(doc, 'Star')).toMatchObject({ width: 100, points: star(5).points })
  })

  it('作ったパスは、ほかのパスと同じくブーリアン演算と SVG の書き出しができる', async () => {
    const h = harness()
    expect(await h.run(argv('new + add polygon --name A --count 4 + add star --name B --x 30 + boolean union A B + get @ d -o a.kdr'))).toBe(0)
    expect(h.stderr).toBe('')
    expect(h.stdout).toMatch(/^M[\d. ]+L/)
    expect(await h.run(argv('-f a.kdr svg-out --to b.svg'))).toBe(0)
  })

  it('頂点の数・比の誤りはエラーにする', async () => {
    for (const [line, message] of [
      ['new + add polygon --count 2', '--count は 3〜100 の整数です: 2'],
      ['new + add star --count 4.5', '--count は 3〜100 の整数です: 4.5'],
      ['new + add star --ratio 1', '--ratio は 0 より大きく 1 未満です: 1'],
      ['new + add polygon --ratio 0.5', '--ratio は star にだけ指定できます'],
      ['new + add polygon --count x', '--count は数値です: x'],
    ]) {
      const h = harness()
      expect(await h.run(argv(`${line} -o a.kdr`))).not.toBe(0)
      expect(h.stderr).toContain(message)
    }
  })
})

describe('マークアップの <polygon> <star>', () => {
  it('count・ratio で形を決め、大きさを片方だけ書けば縦横比を保つ', async () => {
    const h = harness({
      'a.xml': `<kdr name="Shapes">
  <page name="P">
    <frame name="Row" layout="row" gap="8">
      <star name="Rate" count="5" width="24" fill="#f5b301"/>
      <polygon name="Hex" count="6" height="40" fill="#4f46e5"/>
      <polygon name="Tri" width="30" height="10"/>
    </frame>
  </page>
</kdr>`,
    })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    expect(h.stderr).toBe('')
    const doc = await h.doc('a.kdr')
    const rate = byName(doc, 'Rate')
    expect(rate).toMatchObject({ type: 'path', closed: true, width: 24, points: star(5).points, fills: [{ color: '#f5b301' }], strokes: [] })
    expect(rate.height).toBeCloseTo(24 / star(5).aspect, 2)
    const hex = byName(doc, 'Hex')
    expect(hex).toMatchObject({ height: 40, points: regularPolygon(6).points })
    expect(hex.width).toBeCloseTo(40 * regularPolygon(6).aspect, 2)
    expect(byName(doc, 'Tri')).toMatchObject({ width: 30, height: 10, points: regularPolygon(3).points })
  })

  it('大きさは数値として読めればどの書き方でも縦横比の計算に使う', async () => {
    const h = harness({ 'a.xml': '<kdr>\n<page name="P">\n<polygon name="A" count="4" width="24."/>\n</page>\n</kdr>' })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    expect(byName(await h.doc('a.kdr'), 'A')).toMatchObject({ width: 24, height: 24 })
  })

  it('誤りは行番号つきのエラーにする', async () => {
    const h = harness({ 'a.xml': '<kdr>\n<page name="P">\n<polygon count="1"/>\n<star ratio="2"/>\n</page>\n</kdr>' })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).not.toBe(0)
    expect(h.stderr).toContain('a.xml:3: <polygon>: count は 3〜100 の整数です: 1')
    const g = harness({ 'a.xml': '<kdr>\n<page name="P">\n<star ratio="2"/>\n</page>\n</kdr>' })
    expect(await g.run(['build', 'a.xml', '-o', 'a.kdr'])).not.toBe(0)
    expect(g.stderr).toContain('a.xml:3: <star>: ratio は 0 より大きく 1 未満です: 2')
    // polygon の ratio は、star にだけ書けると知らせる。count と ratio を別の行に書けば、誤りのある方の行を指す
    const p = harness({ 'a.xml': '<kdr>\n<page name="P">\n<polygon ratio="0.5"/>\n</page>\n</kdr>' })
    expect(await p.run(['build', 'a.xml', '-o', 'a.kdr'])).not.toBe(0)
    expect(p.stderr).toContain('a.xml:3: <polygon>: ratio は star にだけ指定できます')
    const q = harness({ 'a.xml': '<kdr>\n<page name="P">\n<star\n  ratio="0.5"\n  count="2"/>\n</page>\n</kdr>' })
    expect(await q.run(['build', 'a.xml', '-o', 'a.kdr'])).not.toBe(0)
    expect(q.stderr).toContain('a.xml:5: <star>: count は 3〜100 の整数です: 2')
  })
})
