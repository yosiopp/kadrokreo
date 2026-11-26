import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { type IO, run } from './run.ts'
import { CHECKS, type Finding, lintDocument } from './commands/lint.ts'
import { decodeKdr } from '../src/document/kdr.ts'

// kdr lint。検査ごとに見つけるもの・見つけないもの、選び方、出力の形、終了コード

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

async function make(script: string) {
  const h = harness()
  const code = await h.run([...argv(script), '-o', 'a.kdr'])
  expect(code, h.stderr).toBe(0)
  return h
}

async function findings(h: ReturnType<typeof harness>, extra = ''): Promise<Finding[]> {
  const code = await h.run([...argv('-f a.kdr lint --json'), ...(extra === '' ? [] : argv(extra))])
  expect(code === 0 || code === 1, h.stderr).toBe(true)
  const list = JSON.parse(h.stdout) as Finding[]
  expect(code).toBe(list.length > 0 ? 1 : 0)
  return list
}

const pairs = (list: readonly Finding[]) => list.map((finding) => [finding.check, finding.id])

describe('kdr lint', () => {
  it('問題が無ければ何も出さず終了コード 0（--json は []）', async () => {
    const h = await make('new + add frame --name Card --id card --width 320 --height 200 + add text --name Title --id title --parent card --text Hi')
    expect(await h.run(argv('-f a.kdr lint'))).toBe(0)
    expect(h.stdout).toBe('')
    expect(await findings(h)).toEqual([])
  })

  it('既定の名前・空のテキスト・非表示・大きさ 0 を見つける', async () => {
    const h = await make(
      'new + add rect --id r1 + add star --id s1 + add frame --name Box --id box --width 100 --height 100' +
        ' + add text --name Empty --id e --text x + set e text=' +
        ' + add frame --name Hid --id hid visible=false + add rect --name Child --id child --parent hid visible=false' +
        ' + add rect --name Flat --id flat --width 0 + add line --name Rule --id rule --from 0,0 --to 100,0',
    )
    const list = await findings(h)
    expect(pairs(list)).toEqual(
      expect.arrayContaining([
        ['default-name', 'r1'],
        ['default-name', 's1'],
        ['empty-text', 'e'],
        ['hidden', 'hid'],
        ['zero-size', 'flat'],
      ]),
    )
    // 非表示の中の非表示は 1 つずつ出さない。高さ 0 の直線は大きさ 0 ではない
    expect(pairs(list)).not.toContainEqual(['hidden', 'child'])
    expect(pairs(list)).not.toContainEqual(['zero-size', 'rule'])
    expect(list.find((finding) => finding.id === 'r1')).toEqual({
      check: 'default-name',
      page: expect.any(String),
      id: 'r1',
      name: 'Rectangle',
      message: 'rect "Rectangle": 作ったときの名前のまま',
    })
  })

  it('切り抜くフレームの外に出たノードを見つける（中身は出さず、切り抜かないフレームなら出さない）', async () => {
    const h = await make(
      'new + add frame --name Clip --id clip --width 100 --height 100 clipContent=true' +
        ' + add frame --name Out --id out --parent clip --x 200 --width 50 --height 50 + add rect --name In --id inner --parent out' +
        ' + add rect --name Edge --id edge --parent clip --x 90' +
        ' + add frame --name Open --id open --x 400 --width 100 --height 100 clipContent=false + add rect --name Far --id far --parent open --x 300',
    )
    const list = (await findings(h)).filter((finding) => finding.check === 'out-of-frame')
    expect(pairs(list)).toEqual([['out-of-frame', 'out']])
    expect(list[0].message).toBe('frame "Out": "Clip"（clip）の外にあって見えない')
  })

  it('元の無いインスタンス・使われていない元を見つける。インスタンスの中身は元の側で 1 度だけ', async () => {
    const h = await make(
      'new + add frame --name Card --id card --width 100 --height 100 + component card' +
        ' + add frame --name Tag --id tag --x 200 --width 100 --height 100 + add rect --name Rectangle --id rr --parent tag + component tag + instance Tag --id t2 --x 400',
    )
    const list = await findings(h)
    expect(pairs(list)).toContainEqual(['unused-component', 'card'])
    expect(pairs(list)).not.toContainEqual(['unused-component', 'tag'])
    // 写しの中の「Rectangle」は出さず、元の rr だけ
    expect(list.filter((finding) => finding.check === 'default-name').map((finding) => finding.id)).toEqual(['rr'])

    // 元が無くなったインスタンス（editor や CLI では元を消すと切り離すので、ファイルを直に書き換えた場合）
    const doc = await decodeKdr(new Blob([new Uint8Array(h.fs.get('a.kdr')!)]))
    const page = doc.pages[0]
    const t2 = page.nodes.t2
    if (t2.type !== 'frame' || !t2.component) throw new Error('t2 がインスタンスでない')
    const broken = { ...doc, pages: [{ ...page, nodes: { ...page.nodes, t2: { ...t2, component: { ...t2.component, id: 'gone' } } } }] }
    expect(pairs(lintDocument(broken, new Set(['missing-main']), { targetSize: 44, targetName: /button/i }))).toEqual([['missing-main', 't2']])
  })

  it('使われていない書体を見つける（上書きで使っていれば使っている）', async () => {
    const { testFontBytes } = await import('../src/document/testFont.ts')
    const h = harness({ 'f.ttf': testFontBytes({ family: 'Brand' }), 'g.ttf': testFontBytes({ family: 'Other', weight: 700 }) })
    expect(await h.run(argv('new + font-add f.ttf + font-add g.ttf + add text --name T --id t --text Hi fontFamily=Brand -o a.kdr'))).toBe(0)
    const list = await findings(h)
    expect(list).toEqual([{ check: 'unused-font', page: null, id: null, name: null, message: '"Other" 700: どのテキストでも使われていない書体' }])
    expect(await h.run(argv('-f a.kdr lint'))).toBe(1)
    expect(h.stdout).toBe('-\tunused-font\t"Other" 700: どのテキストでも使われていない書体\n')
  })

  it('押す対象の大きさを、名前の規則と大きさを変えて確かめる', async () => {
    const h = await make('new + add frame --name PrimaryButton --id b --width 40 --height 48 + add frame --name Chip --id c --x 100 --width 20 --height 20')
    expect(pairs(await findings(h))).toEqual([['small-target', 'b']])
    expect(pairs(await findings(h, '--target-size 40'))).toEqual([])
    expect(pairs(await findings(h, '--target-name ^chip$'))).toEqual([['small-target', 'c']])
  })

  it('--grid で間隔・余白・角丸の刻みを、--palette で色の一覧を確かめる（指定したときだけ）', async () => {
    const h = await make(
      'new + add frame --name Card --id card --width 100 --height 100 fill=#ffffff cornerRadius=6 + auto-layout card gap=8 padding=10' +
        ' + add rect --name Box --id box --x 200 fill=#ff0000 stroke=#000000 cornerRadius=8,8,0,0 + add rect --name Ghost --id ghost --x 400 fill=#00ff00 visible=false',
    )
    expect((await findings(h)).map((finding) => finding.check)).not.toContain('off-grid')
    const grid = (await findings(h, '--grid 4')).filter((finding) => finding.check === 'off-grid')
    expect(grid.map((finding) => [finding.id, finding.message])).toEqual([
      ['card', 'frame "Card": cornerRadius=6 paddingTop=10 paddingRight=10 paddingBottom=10 paddingLeft=10 が 4 の倍数でない'],
    ])
    const palette = (await findings(h, '--palette #FFFFFF,#000000')).filter((finding) => finding.check === 'off-palette')
    expect(palette.map((finding) => [finding.id, finding.message])).toEqual([['box', 'rect "Box": 一覧に無い色 #ff0000']])
    // ファイルからも読む（中の #rrggbb を拾う）
    h.fs.set('colors.json', new TextEncoder().encode('{"white": "#ffffff", "red": "#FF0000", "black": "#000000"}'))
    expect((await findings(h, '--palette colors.json')).filter((finding) => finding.check === 'off-palette')).toEqual([])
  })

  it('描かれない色・入れ子の切り抜き・太さ違いの書体・バリアント・表示のプロパティの扱い', async () => {
    // 非表示の親の中・ブーリアン演算の材料の色は off-palette に出さない
    const p = await make(
      'new + add frame --name H --id h --width 50 --height 50 visible=false + add rect --name In --id in --parent h fill=#123456' +
        ' + add rect --name P --id p fill=#111111 + add ellipse --name Q --id q fill=#222222 + boolean union p q --keep + set @ fill=#ffffff',
    )
    expect((await findings(p, '--only off-palette --palette #ffffff'))).toEqual([])
    // 内側のフレームには収まっていても、外側の切り抜くフレームの外なら見えない
    const c = await make(
      'new + add frame --name Outer --id outer --width 100 --height 100 clipContent=true' +
        ' + add frame --name Inner --id inner --parent outer --width 400 --height 100 clipContent=false + add rect --name Far --id far --parent inner --x 300',
    )
    expect(pairs(await findings(c, '--only out-of-frame'))).toEqual([['out-of-frame', 'far']])
    // 書体は太さごと。描画と同じく、指定の先頭の名前で選ぶ
    const { testFontBytes } = await import('../src/document/testFont.ts')
    const f = harness({ 'a.ttf': testFontBytes({ family: 'Brand' }), 'b.ttf': testFontBytes({ family: 'Brand', weight: 700 }), 'c.ttf': testFontBytes({ family: 'Sub' }) })
    expect(await f.run(['new', '+', 'font-add', 'a.ttf', '+', 'font-add', 'b.ttf', '+', 'font-add', 'c.ttf', '+', 'add', 'text', '--text', 'x', '--name', 'T', 'fontFamily=Brand, Sub', '-o', 'a.kdr'])).toBe(0)
    expect((await findings(f, '--only unused-font')).map((finding) => finding.message)).toEqual([
      '"Brand" 700: どのテキストでも使われていない書体',
      '"Sub" 400: どのテキストでも使われていない書体',
    ])
    // バリアントは、まとまりのどれかが使われていれば使われている。表示のプロパティに結んだ子の非表示は出さない
    const v = await make(
      'new + add frame --name Button --id btn --width 100 --height 50 + add rect --name Icon --id icon --parent btn visible=false + component btn' +
        ' + prop-add btn boolean icon --name アイコン + variant-add btn --id big 種類=大 + instance btn --id use --x 300',
    )
    const list = await findings(v, '--only unused-component,hidden')
    expect(list).toEqual([])
  })

  it('テキストと背景のコントラスト比が AA の基準に届かないものを、viewer と同じ求め方で見つける', async () => {
    const h = await make(
      'new + add frame --name Card --id card --width 300 --height 200 fill=#ffffff' +
        ' + add text --parent card --name Faint --id faint --text Hi fill=#cccccc' +
        ' + add text --parent card --name Big --id big --y 40 --text Hi fill=#959595 fontSize=30' +
        ' + add text --parent card --name Ok --id ok --x 100 --text Hi fill=#333333' +
        ' + add frame --name Dark --id dark --x 400 --width 100 --height 100 fill=#222222 + add text --parent dark --name Light --id light --text Hi fill=#ffffff' +
        ' + component dark + instance Dark --id dark2 --x 600 + set dark2 fill=#dddddd',
    )
    const list = await findings(h, '--only low-contrast')
    // 大きな文字は 3:1 で判定する（2.99 は届かない）。背景を変えたインスタンスの中のテキストも見る
    expect(list.map((finding) => finding.message)).toEqual([
      expect.stringMatching(/^text "Light": コントラスト比 1\.\d\d:1（AA の基準 4\.5:1 に届かない。文字 #ffffff・背景 #dddddd）$/),
      'text "Big": コントラスト比 2.99:1（AA の基準 3:1 に届かない。文字 #959595・背景 #ffffff）',
      'text "Faint": コントラスト比 1.60:1（AA の基準 4.5:1 に届かない。文字 #cccccc・背景 #ffffff）',
    ])
    expect(list[0].id).not.toBe('light')
  })

  it('--only / --skip で検査を選び、誤った指定は使い方の誤り（2）', async () => {
    const h = await make('new + add rect --id r1 + add rect --name Flat --id flat --width 0')
    expect(pairs(await findings(h, '--only zero-size'))).toEqual([['zero-size', 'flat']])
    expect(pairs(await findings(h, '--skip zero-size,default-name'))).toEqual([])
    for (const bad of ['--only nope', '--skip a,b', '--grid 0', '--grid x', '--only off-grid', '--only off-palette', '--palette red', '--target-name (', '--target-size -1', '--only ,', '--skip ,']) {
      expect(await h.run([...argv('-f a.kdr lint'), ...argv(bad)]), bad).toBe(2)
    }
    expect(await h.run(argv('-f a.kdr lint extra'))).toBe(2)
    expect(await h.run(argv('-f a.kdr lint --palette none.txt'))).toBe(2)
  })

  it('ほかのコマンドとつなげられ、見つかれば 1。kdr が読めなければ 2（見つけた 1 と見分ける）', async () => {
    const h = await make('new + add rect --id r1')
    expect(await h.run(argv('-f a.kdr info + lint'))).toBe(1)
    expect(h.stdout).toContain('name: ')
    expect(h.stdout).toContain('r1\tdefault-name\t')
    expect(await h.run(argv('-f a.kdr -w set r1 name=Box + lint'))).toBe(0)
    h.fs.set('bad.kdr', new Uint8Array([1, 2, 3]))
    expect(await h.run(argv('-f bad.kdr lint'))).toBe(2)
    expect(await h.run(argv('-f bad.kdr info'))).toBe(1)
  })

  it('検査の一覧がユーザーズガイドに載っている', () => {
    const guide = readFileSync(new URL('../docs/guide/cli.md', import.meta.url), 'utf8')
    for (const check of CHECKS) expect(guide).toContain(`| \`${check.name}\` | ${check.description.replaceAll('|', '\\|')}`)
  })
})
