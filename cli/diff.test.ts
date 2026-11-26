import { describe, expect, it } from 'vitest'
import { type IO, run } from './run.ts'
import { type DocumentDiff } from './commands/diff.ts'

// kdr diff。2 つの kdr のノード・ページ・コンポーネント・画像・書体の違いと、終了コード

// 1×1 の PNG
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

function harness(files: Record<string, Uint8Array> = {}, stdin?: Uint8Array) {
  const fs = new Map(Object.entries(files))
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
    readStdin: async () => new Uint8Array(stdin ?? new Uint8Array()),
    stdinIsTTY: stdin === undefined,
    stdoutIsTTY: false,
    stdout: (data) => {
      if (typeof data === 'string') stdout += data
    },
    stderr: (text) => {
      stderr += text
    },
  }
  return {
    fs,
    async run(args: string[]) {
      stdout = ''
      stderr = ''
      return run(args, io)
    },
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
  }
}

const BASE =
  'new Demo + add frame --name Card --id card --width 320 --height 200 fill=#ffffff' +
  ' + add rect --name A --id a --parent card + add rect --name B --id b --parent card + add text --name T --id t --text Hi'

async function setup(edits: string): Promise<ReturnType<typeof harness>> {
  const h = harness({ 'p.png': PNG })
  expect(await h.run([...BASE.split(' '), '-o', 'old.kdr'])).toBe(0)
  const code = await h.run(['-f', 'old.kdr', ...edits.split(' '), '-o', 'new.kdr'])
  expect(code, h.stderr).toBe(0)
  return h
}

describe('kdr diff', () => {
  it('違いが無ければ何も出さず終了コード 0。--json は different: false を出す', async () => {
    const h = harness()
    expect(await h.run([...BASE.split(' '), '-o', 'a.kdr'])).toBe(0)
    expect(await h.run(['diff', 'a.kdr', 'a.kdr'])).toBe(0)
    expect(h.stdout).toBe('')
    expect(await h.run(['diff', 'a.kdr', 'a.kdr', '--json'])).toBe(0)
    expect(JSON.parse(h.stdout)).toEqual({ different: false, document: [], pages: [], nodes: [], components: [], assets: [], fonts: [] })
  })

  it('増えた・消えた・変わったノードと、変わった項目の前後の値を出す（終了コード 1）', async () => {
    const h = await setup('set a width=150 fill=#ff0000 layoutPositioning=auto + rm b + add ellipse --name E --id e --parent card')
    expect(await h.run(['diff', 'old.kdr', 'new.kdr'])).toBe(1)
    expect(h.stderr).toBe('')
    const lines = h.stdout.split('\n')
    expect(lines[0]).toMatch(/^# Page 1 {2}\S+$/)
    expect(h.stdout).toContain('+ ellipse "E"  e\n')
    expect(h.stdout).toContain('~ rect "A"  a\n    width: 100 → 150\n    fills: [{"type":"solid","color":"#')
    expect(h.stdout).toContain('- rect "B"  b\n')
    // 子を足した・消しただけでは、親の children は出さない
    expect(h.stdout).not.toContain('children')
    expect(h.stdout).not.toContain('"Card"')

    expect(await h.run(['diff', 'old.kdr', 'new.kdr', '--json'])).toBe(1)
    const diff = JSON.parse(h.stdout) as DocumentDiff
    expect(diff.different).toBe(true)
    expect(diff.nodes.map(({ change, id }) => [change, id])).toEqual([
      ['added', 'e'],
      ['changed', 'a'],
      ['removed', 'b'],
    ])
    const a = diff.nodes.find((node) => node.id === 'a')!
    expect(a).toMatchObject({ kind: 'rect', name: 'A', parentId: 'card' })
    expect(a.fields!.map((field) => field.path)).toEqual(['width', 'fills'])
    expect(a.fields![0]).toEqual({ path: 'width', before: 100, after: 150 })
  })

  it('入れ子の項目は . でつなぎ、子の並べ替えは children に、親の付け替えは parentId に出す', async () => {
    const h = await setup('order front a + set card layout=column gap=8 + mv t --parent card')
    expect(await h.run(['diff', 'old.kdr', 'new.kdr', '--json'])).toBe(1)
    const diff = JSON.parse(h.stdout) as DocumentDiff
    const card = diff.nodes.find((node) => node.id === 'card')!
    const paths = card.fields!.map((field) => field.path)
    expect(paths).toContain('layout')
    expect(card.fields!.find((field) => field.path === 'children')).toEqual({ path: 'children', before: ['a', 'b'], after: ['b', 'a'] })
    expect(diff.nodes.find((node) => node.id === 't')!.fields).toContainEqual(expect.objectContaining({ path: 'parentId', before: null, after: 'card' }))

    const n = await setup('auto-layout card + set card layout.gap=24')
    expect(await n.run(['diff', 'old.kdr', 'new.kdr', '--json'])).toBe(1)
    const fields = (JSON.parse(n.stdout) as DocumentDiff).nodes.find((node) => node.id === 'card')!.fields!
    expect(fields.map((field) => field.path)).toContain('layout')
  })

  it('消えた・増えたフレームの中身は並べず、子孫の数を出す', async () => {
    const h = await setup('rm card')
    expect(await h.run(['diff', 'old.kdr', 'new.kdr'])).toBe(1)
    expect(h.stdout).toContain('- frame "Card"  card  (+2 descendants)\n')
    expect(h.stdout).not.toContain('"A"')
    expect(await h.run(['diff', 'new.kdr', 'old.kdr', '--json'])).toBe(1)
    const diff = JSON.parse(h.stdout) as DocumentDiff
    expect(diff.nodes).toEqual([{ change: 'added', page: expect.any(String), id: 'card', kind: 'frame', name: 'Card', parentId: null, descendants: 2 }])
  })

  it('ドキュメントの名前、ページの増減・名前・順、コンポーネント・画像・書体の増減を出す', async () => {
    const h = await setup('doc-name Renamed + page-rename Home + component card + add image --src p.png + page-add Icons --id icons + add rect --name S')
    expect(await h.run(['diff', 'old.kdr', 'new.kdr'])).toBe(1)
    expect(h.stdout).toContain('~ document\n    name: "Demo" → "Renamed"\n')
    expect(h.stdout).toMatch(/~ page "Home" {2}\S+\n {4}name: "Page 1" → "Home"\n/)
    expect(h.stdout).toContain('+ page "Icons"  icons  nodes:1\n')
    expect(h.stdout).toContain('+ component "Card"  card  page:')
    expect(h.stdout).toMatch(/\+ asset [0-9a-f]{64} {2}image\/png {2}\d+ bytes\n/)
    // ページの中のノードはページごとの見出しの下（増えたページの中身は並べない）
    expect(h.stdout).toMatch(/# Home {2}\S+\n\+ image "Image"  \S+\n~ frame "Card"  card\n {4}component: null → /)
    expect(h.stdout).not.toContain('"S"')

    expect(await h.run(['diff', 'new.kdr', 'old.kdr', '--json'])).toBe(1)
    const diff = JSON.parse(h.stdout) as DocumentDiff
    expect(diff.pages.map(({ change, name }) => [change, name])).toEqual([
      ['changed', 'Page 1'],
      ['removed', 'Icons'],
    ])
    expect(diff.components).toMatchObject([{ change: 'removed', node: 'card', name: 'Card' }])
    expect(diff.assets).toMatchObject([{ change: 'removed', mime: 'image/png' }])

    // ページの並べ替えは index に出る（ページを足しただけでは出ない）
    const p = harness()
    expect(await p.run(argv('new + page-add Second --id s2 -o a.kdr'))).toBe(0)
    expect(await p.run(argv('-f a.kdr page-add Third --id s3 -o b.kdr'))).toBe(0)
    expect(await p.run(['diff', 'a.kdr', 'b.kdr', '--json'])).toBe(1)
    expect((JSON.parse(p.stdout) as DocumentDiff).pages).toEqual([{ change: 'added', id: 's3', name: 'Third', nodes: 0 }])
  })

  it('子孫の数には、移しただけのノードを入れない。インスタンスの上書きは component.overrides に出る', async () => {
    const h = await setup('add frame --name N --id n --width 50 --height 50 + mv a --parent n')
    expect(await h.run(['diff', 'old.kdr', 'new.kdr'])).toBe(1)
    expect(h.stdout).toContain('+ frame "N"  n\n')
    expect(h.stdout).toContain('~ rect "A"  a\n    parentId: "card" → "n"')

    const i = harness()
    expect(await i.run(argv('new + add frame --name Btn --id btn + add text --name L --parent btn --text OK + component btn + instance Btn --id b2 -o old.kdr'))).toBe(0)
    expect(await i.run(argv('-f old.kdr set b2/L text=Cancel -o new.kdr'))).toBe(0)
    expect(await i.run(['diff', 'old.kdr', 'new.kdr', '--json'])).toBe(1)
    const diff = JSON.parse(i.stdout) as DocumentDiff
    const b2 = diff.nodes.find((node) => node.id === 'b2')!
    expect(b2.fields!.some((field) => field.path.startsWith('component.overrides.'))).toBe(true)
  })

  it('長い値はテキストでは縮め、JSON ではそのまま出す', async () => {
    const long = 'x'.repeat(200)
    const h = await setup(`set t text=${long}`)
    expect(await h.run(['diff', 'old.kdr', 'new.kdr'])).toBe(1)
    expect(h.stdout).toContain(`    text: "Hi" → "${'x'.repeat(78)}…\n`)
    expect(await h.run(['diff', 'old.kdr', 'new.kdr', '--json'])).toBe(1)
    expect(h.stdout).toContain(`"after": "${long}"`)
  })

  it('- で片方を標準入力から読む', async () => {
    const h = await setup('set a width=150')
    const stdin = harness({ 'new.kdr': h.fs.get('new.kdr')! }, h.fs.get('old.kdr')!)
    expect(await stdin.run(['diff', '-', 'new.kdr'])).toBe(1)
    expect(stdin.stdout).toContain('~ rect "A"  a\n    width: 100 → 150')
  })

  it('失敗は終了コード 2（違いがある 1 と見分ける）。ほかのコマンドや -f とはつなげない', async () => {
    const h = harness({ 'bad.kdr': new Uint8Array([1, 2, 3]) })
    expect(await h.run([...BASE.split(' '), '-o', 'a.kdr'])).toBe(0)
    expect(await h.run(['diff', 'a.kdr', 'bad.kdr'])).toBe(2)
    expect(h.stderr).toMatch(/^kdr: diff: bad\.kdr: /)
    expect(await h.run(['diff', 'a.kdr', 'none.kdr'])).toBe(2)
    expect(h.stderr).toContain('none.kdr')
    expect(await h.run(['diff', 'a.kdr'])).toBe(2)
    expect(await h.run(['diff', 'a.kdr', 'a.kdr', 'a.kdr'])).toBe(2)
    expect(await h.run(['diff', '-', '-'])).toBe(2)
    // 標準入力が端末なら待たずにエラー
    expect(await h.run(['diff', '-', 'a.kdr'])).toBe(2)
    expect(h.stderr).toContain('端末')
    expect(await h.run(['diff', 'a.kdr', 'a.kdr', '--color', 'rgb'])).toBe(2)
    expect(await h.run(['-f', 'a.kdr', 'diff', 'a.kdr', 'a.kdr'])).toBe(2)
    expect(h.stderr).toContain('-f・-o・-w は指定できません')
    expect(await h.run(['diff', 'a.kdr', 'a.kdr', '-o', 'b.kdr'])).toBe(2)
    expect(await h.run(['diff', 'a.kdr', 'a.kdr', '+', 'info'])).toBe(2)
    expect(await h.run(['-f', 'a.kdr', 'info', '+', 'diff', 'a.kdr', 'a.kdr'])).toBe(2)
    // ほかのコマンドの終了コードは変えない（壊れた kdr は 1 のまま）
    expect(await h.run(['-f', 'bad.kdr', 'info'])).toBe(1)
  })
})

const argv = (line: string) => line.split(' ')
