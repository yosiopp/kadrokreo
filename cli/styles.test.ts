import { describe, expect, it } from 'vitest'
import { decodeKdr } from '../src/document/kdr.ts'
import { summarizePage } from '../src/viewer/summary.ts'
import { type IO, run } from './run.ts'

// colors・text-styles・shadows。viewer の「このページの色・文字・影」（summarizePage）と同じ数え方で集計する

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

const argv = (line: string) => line.split(' ')

const DOC =
  'new Demo + add frame --name Card --id card --width 320 --height 200 fill=#f5f5ff' +
  ' + add text --parent card --name T --id t --text Hi fill=#333333 fontSize=20' +
  ' + add text --parent card --name U --id u --text Yo fill=#333333 fontSize=20' +
  ' + add rect --name Box --id box fill=#ff8800 stroke=#000000 shadow.blur=8 shadow.y=4' +
  ' + add rect --name Under --id under --x 600 fill=#00ff00 + gradient linear under --colors #ffffff,#000000 --add' +
  ' + add rect --name Hidden --id hidden fill=#123456 visible=false' +
  ' + page-add P2 --id p2 + add rect --name R --id r fill=#ff8800 shadow.blur=8 shadow.y=4 + add text --name Small --id small --text s fontSize=10'

async function setup() {
  const h = harness()
  const code = await h.run([...argv(DOC), '-o', 's.kdr'])
  expect(code, h.stderr).toBe(0)
  return h
}

describe('colors / text-styles / shadows', () => {
  it('いまのページの色を、使われている数と一緒に viewer と同じ順・同じ数で出す', async () => {
    const h = await setup()
    expect(await h.run(argv('-f s.kdr colors'))).toBe(0)
    const doc = await decodeKdr(new Blob([new Uint8Array(h.fs.get('s.kdr')!)]))
    const viewer = summarizePage(doc.pages[0])
    expect(h.stdout).toBe(viewer.colors.map((use) => `${use.color.toUpperCase()}\t${use.count}\n`).join(''))
    // 非表示のノードの色は数えない
    expect(h.stdout).not.toContain('#123456')
    // 不透明なグラデーションの下に隠れた色は数えない
    expect(h.stdout).not.toContain('#00FF00')
    expect(h.stdout).toContain('#FFFFFF')
    expect(await h.run(argv('-f s.kdr colors --json'))).toBe(0)
    const rows = JSON.parse(h.stdout)
    expect(rows.map((row: { color: string; count: number }) => [row.color, row.count])).toEqual(viewer.colors.map((use) => [use.color, use.count]))
    expect(rows.find((row: { color: string }) => row.color === '#333333')).toEqual({
      color: '#333333',
      value: '#333333',
      count: 2,
      nodes: [
        { page: doc.pages[0].id, id: 't' },
        { page: doc.pages[0].id, id: 'u' },
      ],
    })
  })

  it('--all は全ページを足し合わせ、ノードを指定すればその中だけ。--color で書き方を変える', async () => {
    const h = await setup()
    expect(await h.run(argv('-f s.kdr colors --all --json'))).toBe(0)
    const orange = JSON.parse(h.stdout).find((row: { color: string }) => row.color === '#ff8800')
    expect(orange).toMatchObject({ color: '#ff8800', count: 2 })
    expect(orange.nodes.map((node: { id: string }) => node.id)).toEqual(['box', 'r'])
    expect(await h.run(argv('-f s.kdr colors card'))).toBe(0)
    expect(h.stdout).toBe('#333333\t2\n#F5F5FF\t1\n')
    // 祖先と一緒に指定しても 2 度数えない
    expect(await h.run(argv('-f s.kdr colors card t'))).toBe(0)
    expect(h.stdout).toBe('#333333\t2\n#F5F5FF\t1\n')
    // 祖先のせいで描かれないノードは、直接指定しても数えない（非表示のフレームの中・ブーリアン演算の材料）
    const g = harness()
    const made = await g.run(argv('new + add frame --name H --id h --width 50 --height 50 visible=false + add rect --name In --id in --parent h fill=#abcdef + add rect --name P --id p fill=#111111 + add ellipse --name Q --id q fill=#222222 + boolean union p q --keep -o g.kdr'))
    expect(made, g.stderr).toBe(0)
    expect(await g.run(argv('-f g.kdr colors in q'))).toBe(0)
    expect(g.stdout).toBe('')
    expect(await h.run(argv('-f s.kdr colors box --color rgb'))).toBe(0)
    expect(h.stdout).toBe('rgb(0, 0, 0)\t1\nrgb(255, 136, 0)\t1\n')
    expect(await h.run(argv('-f s.kdr colors box --color hsl'))).toBe(0)
    expect(h.stdout).toContain('hsl(32, 100%, 50%)\t1')
  })

  it('文字の書式は大きい順に CSS の font の形、影は box-shadow の値で出す', async () => {
    const h = await setup()
    expect(await h.run(argv('-f s.kdr text-styles --all'))).toBe(0)
    expect(h.stdout).toBe('400 20px/1.2 sans-serif\t2\n400 10px/1.2 sans-serif\t1\n')
    expect(await h.run(argv('-f s.kdr text-styles --json'))).toBe(0)
    expect(JSON.parse(h.stdout)).toEqual([
      { fontFamily: 'sans-serif', fontSize: 20, fontWeight: 400, lineHeight: 1.2, value: '400 20px/1.2 sans-serif', count: 2, nodes: expect.any(Array) },
    ])
    expect(await h.run(argv('-f s.kdr shadows --all --color rgb'))).toBe(0)
    expect(h.stdout).toBe('0 4px 8px rgba(0, 0, 0, 0.25)\t2\n')
    expect(await h.run(argv('-f s.kdr shadows --json'))).toBe(0)
    expect(JSON.parse(h.stdout)[0]).toMatchObject({ shadow: { type: 'drop-shadow', blur: 8, y: 4 }, value: '0 4px 8px rgba(0, 0, 0, 0.25)', count: 1 })
  })

  it('何も無ければ何も出さず（--json は空の配列）、誤った指定はエラー', async () => {
    const h = harness()
    expect(await h.run(argv('new -o e.kdr'))).toBe(0)
    for (const name of ['colors', 'text-styles', 'shadows']) {
      expect(await h.run(['-f', 'e.kdr', name])).toBe(0)
      expect(h.stdout).toBe('')
      expect(await h.run(['-f', 'e.kdr', name, '--json'])).toBe(0)
      expect(h.stdout).toBe('[]\n')
    }
    const s = await setup()
    expect(await s.run(argv('-f s.kdr colors --color cmyk'))).toBe(2)
    expect(await s.run(argv('-f s.kdr colors card --all'))).toBe(2)
    expect(await s.run(argv('-f s.kdr colors nope'))).toBe(2)
    expect(await s.run(argv('-f s.kdr text-styles --color rgb'))).toBe(2)
  })
})
