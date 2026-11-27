import { describe, expect, it } from 'vitest'
import { decodeKdr } from '../src/document/kdr.ts'
import { type IO, run } from './run.ts'

// 変数のコマンド（vars・var-add / set / rename / rm・collection-*・mode-*・mode）と、set の var(名前)、css / html の var(--…)

function harness() {
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
    stdoutIsTTY: false,
    stdout: (data) => {
      if (typeof data === 'string') stdout += data
    },
    stderr: (text) => {
      stderr += text
    },
  }
  return {
    async run(line: string) {
      stdout = ''
      stderr = ''
      // 値に空白を含めない（split で分ける）
      const code = await run(line.split(' '), io)
      return { code, stdout, stderr }
    },
    write(path: string, text: string) {
      fs.set(path, new TextEncoder().encode(text))
    },
    async doc(path = 'd.kdr') {
      return decodeKdr(new Blob([new Uint8Array(fs.get(path)!)]))
    },
  }
}

const BASE = 'new Demo + add frame --name Card --id card --width 320 --height 200 fill=#ffffff + add rect --parent card --name Box --id box fill=#000000'

describe('変数のコマンド', () => {
  it('色の変数を足して塗りからつなぎ、値を変えるとつないだ色も変わる', async () => {
    const h = harness()
    expect((await h.run(`${BASE} + var-add color/primary #5b4cf5 + set box fill=var(color/primary) -o d.kdr`)).code).toBe(0)
    let doc = await h.doc()
    expect(doc.collections).toMatchObject([{ name: 'Variables', modes: [{ name: 'Mode 1' }], variables: [{ name: 'color/primary', type: 'color' }] }])
    const id = doc.collections[0].variables[0].id
    expect(doc.pages[0].nodes.box).toMatchObject({ fills: [{ color: '#5b4cf5', variable: id }] })

    expect((await h.run('-f d.kdr -w var-set color/primary #ff3366')).code).toBe(0)
    doc = await h.doc()
    expect(doc.pages[0].nodes.box).toMatchObject({ fills: [{ color: '#ff3366', variable: id }] })

    // 色を直接書けば、つながりは外れる
    expect((await h.run('-f d.kdr -w set box fills.0.color=#00ff00')).code).toBe(0)
    doc = await h.doc()
    expect(doc.pages[0].nodes.box).toMatchObject({ fills: [{ color: '#00ff00' }] })
    expect((doc.pages[0].nodes.box as { fills: object[] }).fills[0]).not.toHaveProperty('variable')
  })

  it('モードを足し、フレームやページのモードで解決する', async () => {
    const h = harness()
    const line =
      `${BASE} + collection-add Theme --mode Light + mode-add Theme Dark + var-add color/surface #ffffff Dark=#16161d` +
      ' + set card fill=var(color/surface) + set box fill=var(color/surface) + mode card Theme=Dark -o d.kdr'
    expect((await h.run(line)).code).toBe(0)
    let doc = await h.doc()
    const [light, dark] = doc.collections[0].modes
    expect(doc.pages[0].nodes.card).toMatchObject({ modes: { [doc.collections[0].id]: dark.id }, fills: [{ color: '#16161d' }] })
    expect(doc.pages[0].nodes.box).toMatchObject({ fills: [{ color: '#16161d' }] })
    // フレームの指定を消してページで決める
    expect((await h.run('-f d.kdr -w mode card Theme=null + mode Theme=Light')).code).toBe(0)
    doc = await h.doc()
    expect(doc.pages[0]).toMatchObject({ modes: { [doc.collections[0].id]: light.id } })
    expect(doc.pages[0].nodes.card).not.toHaveProperty('modes')
    expect(doc.pages[0].nodes.card).toMatchObject({ fills: [{ color: '#ffffff' }] })
    // モードを消すと、そのモードの指定も消える
    expect((await h.run('-f d.kdr -w mode Theme=Dark + mode-rm Theme Dark')).code).toBe(0)
    doc = await h.doc()
    expect(doc.pages[0]).not.toHaveProperty('modes')
    expect(doc.collections[0].modes).toHaveLength(1)
  })

  it('別名・名前の変更・削除', async () => {
    const h = harness()
    expect((await h.run(`${BASE} + var-add color/primary #5b4cf5 + var-add color/link var(color/primary) + set box fill=var(color/link) -o d.kdr`)).code).toBe(0)
    let doc = await h.doc()
    const [primary, link] = doc.collections[0].variables
    expect(link).toMatchObject({ type: 'color', values: { [doc.collections[0].modes[0].id]: { alias: primary.id } } })
    expect(doc.pages[0].nodes.box).toMatchObject({ fills: [{ color: '#5b4cf5', variable: link.id }] })

    expect((await h.run('-f d.kdr -w var-rename color/primary color/brand + var-set color/brand #222222')).code).toBe(0)
    doc = await h.doc()
    expect(doc.pages[0].nodes.box).toMatchObject({ fills: [{ color: '#222222' }] })

    // 別名の先を消すと、別名は今の値になる。つないだ色は残る
    expect((await h.run('-f d.kdr -w var-rm color/brand')).code).toBe(0)
    doc = await h.doc()
    expect(doc.collections[0].variables).toMatchObject([{ name: 'color/link', values: { [doc.collections[0].modes[0].id]: '#222222' } }])
    expect(doc.pages[0].nodes.box).toMatchObject({ fills: [{ color: '#222222', variable: link.id }] })
  })

  it('インスタンスの写しは置いた場所のモードで解決し、上書きにはしない', async () => {
    const h = harness()
    const line =
      'new Demo + collection-add Theme --mode Light + mode-add Theme Dark + var-add color/surface #ffffff Dark=#16161d' +
      ' + add frame --name Btn --id btn --width 80 --height 40 fill=var(color/surface) + component btn' +
      ' + add frame --name Dark --id dark --x 200 --width 200 --height 200 + mode dark Theme=Dark' +
      ' + instance Btn --id inst --parent dark + set dark x=300 -o d.kdr'
    expect((await h.run(line)).code).toBe(0)
    const doc = await h.doc()
    const nodes = doc.pages[0].nodes
    expect(nodes.btn).toMatchObject({ fills: [{ color: '#ffffff' }] })
    expect(nodes.inst).toMatchObject({ fills: [{ color: '#16161d' }], component: { role: 'instance', overrides: {} } })
    // 値を変えても、元と写しがそれぞれのモードで変わる
    expect((await h.run('-f d.kdr -w var-set color/surface Dark=#000000 + set btn x=10')).code).toBe(0)
    const next = (await h.doc()).pages[0].nodes
    expect(next.inst).toMatchObject({ fills: [{ color: '#000000' }], component: { overrides: {} } })
    expect(next.btn).toMatchObject({ fills: [{ color: '#ffffff' }] })
  })

  it('数値・文字・真偽の変数を項目につなぎ、値を変えると並べ直しと測り直しも追従する', async () => {
    const h = harness()
    const line =
      'new Demo + var-add radius/md 8 + var-add space/md 12 + var-add size/body 16 + var-add copy/title Hello + var-add flag/show true' +
      ' + add frame --name Row --id row layout=row gap=var(space/md) padding=4 cornerRadius=var(radius/md)' +
      ' + add text --parent row --name T --id t --text x fontSize=var(size/body) text=var(copy/title)' +
      ' + add rect --parent row --name R --id r visible=var(flag/show) -o d.kdr'
    expect((await h.run(line)).code).toBe(0)
    let doc = await h.doc()
    const ids = Object.fromEntries(doc.collections[0].variables.map((v) => [v.name, v.id]))
    let nodes = doc.pages[0].nodes
    expect(nodes.row).toMatchObject({ cornerRadius: 8, layout: { gap: 12 }, bindings: { cornerRadius: ids['radius/md'], 'layout.gap': ids['space/md'] } })
    expect(nodes.t).toMatchObject({ fontSize: 16, text: 'Hello', bindings: { fontSize: ids['size/body'], text: ids['copy/title'] } })
    expect(nodes.r).toMatchObject({ visible: true, bindings: { visible: ids['flag/show'] } })
    const width = nodes.t.width

    expect((await h.run('-f d.kdr -w var-set size/body 32 + var-set space/md 40 + var-set copy/title HelloHello + var-set flag/show false')).code).toBe(0)
    doc = await h.doc()
    nodes = doc.pages[0].nodes
    expect(nodes.t).toMatchObject({ fontSize: 32, text: 'HelloHello', visible: true })
    expect(nodes.t.width).toBeGreaterThan(width)
    expect(nodes.row).toMatchObject({ layout: { gap: 40 } })
    // 並べ直しも追従する（隠した R は並びに入らないので、幅は T と余白と間隔で決まる）
    expect(nodes.row.width).toBe(nodes.t.width + 8)
    expect(nodes.r).toMatchObject({ visible: false })

    // 値を直接書けばつながりは外れる
    expect((await h.run('-f d.kdr -w set row cornerRadius=4 + set t fontSize=10')).code).toBe(0)
    nodes = (await h.doc()).pages[0].nodes
    expect(nodes.row.bindings).toEqual({ 'layout.gap': ids['space/md'] })
    expect(nodes.t.bindings).toEqual({ text: ids['copy/title'] })
    expect(nodes.t).toMatchObject({ fontSize: 10 })

    // 入れられない値（不透明度 2）は解決せず、今の値のまま
    expect((await h.run('-f d.kdr -w var-add alpha 0.5 + set r opacity=var(alpha) + var-set alpha 2')).code).toBe(0)
    expect((await h.doc()).pages[0].nodes.r).toMatchObject({ opacity: 0.5 })
    expect((await h.run('-f d.kdr set r cornerRadius=var(copy/title) -o x.kdr')).stderr).toContain('number の変数ではありません')
    expect((await h.run('-f d.kdr set r gap=var(space/md) -o x.kdr')).stderr).toContain('gap')
  })

  it('インスタンスの写しで、文言を別の変数につなげる（上書きとして覚える）', async () => {
    const h = harness()
    const line =
      'new Demo + var-add copy/ok OK + var-add copy/cancel Cancel' +
      ' + add frame --name Btn --id btn layout=row + add text --parent btn --name Label --id label --text x text=var(copy/ok) + component btn' +
      ' + instance Btn --id inst --x 200 -o d.kdr'
    expect((await h.run(line)).code).toBe(0)
    let doc = await h.doc()
    const copy = Object.values(doc.pages[0].nodes).find((node) => node.parentId === 'inst')!
    expect(copy).toMatchObject({ text: 'OK' })
    expect((await h.run(`-f d.kdr -w set ${copy.id} text=var(copy/cancel) + var-set copy/cancel Nope + set btn x=10`)).code).toBe(0)
    doc = await h.doc()
    const nodes = doc.pages[0].nodes
    const cancel = doc.collections[0].variables.find((v) => v.name === 'copy/cancel')!.id
    expect(nodes[copy.id]).toMatchObject({ text: 'Nope', bindings: { text: cancel } })
    expect(nodes.label).toMatchObject({ text: 'OK' })
    expect(nodes.inst).toMatchObject({ component: { overrides: { label: { bindings: { text: cancel } } } } })
  })

  it('写しの文言を直接直すと残り、根の不透明度はインスタンスのもの。変数を消すとつながりも消える', async () => {
    const h = harness()
    const line =
      'new Demo + var-add copy/ok OK + var-add alpha 1' +
      ' + add frame --name Btn --id btn layout=row opacity=var(alpha) + add text --parent btn --name Label --id label --text x text=var(copy/ok) + component btn' +
      ' + instance Btn --id inst --x 200 -o d.kdr'
    expect((await h.run(line)).code).toBe(0)
    let nodes = (await h.doc()).pages[0].nodes
    const copy = Object.values(nodes).find((node) => node.parentId === 'inst')!
    expect((await h.run(`-f d.kdr -w set ${copy.id} text=Hi + set inst opacity=0.5 + set btn x=10 + var-set copy/ok OKAY + var-set alpha 0.9`)).code).toBe(0)
    nodes = (await h.doc()).pages[0].nodes
    expect(nodes[copy.id]).toMatchObject({ text: 'Hi' })
    expect(nodes[copy.id]).not.toHaveProperty('bindings')
    expect(nodes.inst).toMatchObject({ opacity: 0.5, component: { overrides: { label: { text: 'Hi', bindings: { text: null } } } } })
    expect(nodes.label).toMatchObject({ text: 'OKAY' })
    expect(nodes.btn).toMatchObject({ opacity: 0.9 })
    expect((await h.run('-f d.kdr -w var-rm alpha copy/ok')).code).toBe(0)
    nodes = (await h.doc()).pages[0].nodes
    expect(nodes.btn).not.toHaveProperty('bindings')
    expect(nodes.label).not.toHaveProperty('bindings')
  })

  it('tokens で CSS・JSON を書き出し、tokens-import で取り込む', async () => {
    const h = harness()
    const line = 'new Demo + collection-add Theme --mode Light + mode-add Theme Dark + var-add color/primary #5b4cf5 Dark=#a99fff + var-add space/md 16 -o d.kdr'
    expect((await h.run(line)).code).toBe(0)
    const css = await h.run('-f d.kdr tokens --color rgb')
    expect(css.stdout).toContain('--color-primary: rgb(91, 76, 245);')
    expect(css.stdout).toContain('[data-theme="dark"]')
    const json = (await h.run('-f d.kdr tokens --format json')).stdout
    expect(JSON.parse(json).Theme.space.md).toEqual({ $type: 'number', $value: 16, $extensions: { kadrokreo: { modes: { Dark: 16 } } } })
    h.write('t.json', json)
    const imported = await h.run('new Other + tokens-import t.json -o o.kdr')
    expect(imported.code).toBe(0)
    expect(imported.stderr).toContain('足した 2')
    const doc = await h.doc('o.kdr')
    expect(doc.collections).toMatchObject([{ name: 'Theme', modes: [{ name: 'Light' }, { name: 'Dark' }], variables: [{ name: 'color/primary' }, { name: 'space/md' }] }])
    expect((await h.run('new X + tokens-import nope.json -o x.kdr')).code).not.toBe(0)
  })

  it('誤りは使い方のエラーにする', async () => {
    const h = harness()
    expect((await h.run(`${BASE} + set box fill=var(nope) -o d.kdr`)).stderr).toContain('nope という変数がありません')
    expect((await h.run(`${BASE} + var-add space 8 + set box fill=var(space) -o d.kdr`)).stderr).toContain('色の変数ではありません')
    expect((await h.run(`${BASE} + var-add a #000000 + var-add a #ffffff -o d.kdr`)).stderr).toContain('同じ名前の変数があります')
    expect((await h.run(`${BASE} + var-add a #000000 + var-set a var(a) -o d.kdr`)).stderr).toContain('循環')
    expect((await h.run(`${BASE} + collection-add A + collection-add B + var-add a #000000 -o d.kdr`)).stderr).toContain('--collection')
  })

  it('vars で一覧し、css・html で var(--名前) と変数の定義を出す', async () => {
    const h = harness()
    const line =
      `${BASE} + collection-add Theme --mode Light + mode-add Theme Dark + var-add color/primary #5b4cf5 Dark=#a99fff` +
      ' + var-add color/link var(color/primary) + set box fill=var(color/link) -o d.kdr'
    expect((await h.run(line)).code).toBe(0)
    const list = await h.run('-f d.kdr vars')
    expect(list.stdout.trim().split('\n')).toEqual([
      'Theme\tcolor/primary\tcolor\t--color-primary\tLight=#5b4cf5\tDark=#a99fff',
      'Theme\tcolor/link\tcolor\t--color-link\tLight=var(color/primary)\tDark=var(color/primary)',
    ])
    expect(JSON.parse((await h.run('-f d.kdr vars --json')).stdout)).toMatchObject([
      { name: 'Theme', modes: ['Light', 'Dark'], variables: [{ name: 'color/primary', values: { Dark: '#a99fff' } }, { values: { Light: { alias: 'color/primary' } } }] },
    ])
    expect((await h.run('-f d.kdr css box')).stdout).toContain('background: var(--color-link);')
    const html = (await h.run('-f d.kdr html card')).stdout
    expect(html).toContain(':root {\n  --color-primary: #5b4cf5;\n  --color-link: var(--color-primary);\n}')
    expect(html).toContain('[data-theme="dark"] {\n  --color-primary: #a99fff;')
    expect(html).toContain('background: var(--color-link);')
  })
})
