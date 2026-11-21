// コマンドライン（cli/kadrokreo.ts）で作った kdr を、viewer と editor で開けることを確かめる
const { chromium } = require('playwright-core')
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5181'
const CLI = path.join(__dirname, '..', 'cli', 'kadrokreo.ts')
let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }
const cli = (args, input) => execFileSync(process.execPath, [CLI, ...args], { input, stdio: ['pipe', 'pipe', 'inherit'] })

;(async () => {
  // ── CLI でデザインを作る。パイプと「+」の両方を使う ──
  const kdrPath = path.join(OUT, 'cli.kdr')
  const base = cli(['new', 'CLI Demo', '+', 'add', 'frame', '--name', 'Card', '--id', 'card', '--x', '100', '--y', '100', '--width', '300', '--height', '200', 'fill=#f5f5ff',
    '+', 'add', 'frame', '--name', 'Button', '--id', 'btn', '--parent', 'card', 'fill=#5b4cf5', 'cornerRadius=8',
    '+', 'add', 'text', '--parent', 'btn', '--name', 'Label', '--text', 'OK', 'fill=#ffffff',
    '+', 'auto-layout', 'btn', 'padding=12', '+', 'component', 'btn'])
  cli(['instance', 'Button', '--id', 'btn2', '--parent', 'card', '--x', '120', '--y', '20', '+', 'set', 'btn2/Label', 'text=Cancel', '-o', kdrPath], base)
  const listing = cli(['-f', kdrPath, 'ls']).toString()
  check('CLI で作った kdr を CLI で読める', listing.includes('"Cancel"') && listing.includes('component:instance'))

  // docs/examples の例（スマホ画面のワイヤーフレーム）がそのまま動く
  const wireframePath = path.join(OUT, 'wireframe.kdr')
  fs.rmSync(wireframePath, { force: true })
  const example = execFileSync('sh', [path.join(__dirname, '..', 'docs', 'examples', 'wireframe.sh'), wireframePath], { stdio: ['ignore', 'pipe', 'inherit'] }).toString()
  check('docs/examples/wireframe.sh が動く', example.includes('"リストの項目 3"') && example.includes('Screen"  screen  0,0 375×812'))

  // 整列・回転・上書きの反映・元の差し替え・バリアントのコマンドで作ったものも、CLI で読み直せる
  const morePath = path.join(OUT, 'cli-more.kdr')
  cli(['-f', kdrPath, '-o', morePath, 'variant-add', 'btn', '--id', 'btn-big', '種類=大',
    '+', 'set', 'btn2/Label', 'text=Push', '+', 'override-push', 'btn2/Label',
    '+', 'add', 'frame', '--name', 'Chip', '--id', 'chip', '--x', '500', '--y', '100', 'fill=#e0e0ff', '+', 'add', 'text', '--parent', 'chip', '--name', 'Label', '--text', 'Tag', '+', 'component', 'chip',
    '+', 'instance', 'btn-big', '--id', 'i3', '--x', '500', '--y', '300', '+', 'variant', 'i3', '種類=標準',
    '+', 'instance', 'Chip', '--id', 'i4', '--x', '700', '--y', '300', '+', 'swap', 'i4', 'btn',
    '+', 'align', 'top', 'i3', 'i4', '+', 'rotate', '15', 'i4', '--each'])
  const more = cli(['-f', morePath, 'ls', '--all', '+', 'get', 'btn/Label', 'text', '+', 'bounds', 'i3', '+', 'get', 'i4', 'rotation']).toString()
  check('整列・回転・上書きの反映・差し替え・バリアントのコマンドの結果を読める', more.includes('"種類=大"') && more.includes('\nPush\n') && more.trimEnd().endsWith('\n15'), more.slice(-200))
  // html の --format は viewer のコードの形式と同じものを出す
  const tailwind = cli(['-f', kdrPath, 'html', 'card', '--format', 'tailwind']).toString().trimEnd()

  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const errors = []
  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push(String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForSelector('.inspect-layer')
  const names = await viewer.locator('.inspect-layer .layer-name').allTextContents()
  check('viewer で開ける', ['Card', 'Button', 'Label'].every((name) => names.includes(name)), names.join())
  await viewer.screenshot({ path: path.join(OUT, 'cli-viewer.png') })
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Card"))').click()
  const panel = viewer.locator('.inspect-panel')
  await panel.locator('select[aria-label="コードの形式"]').selectOption('tailwind')
  const shown = await panel.locator('section[aria-label="JSX"] .inspect-code').first().textContent()
  check('html --format tailwind が viewer の JSX と同じ', shown === tailwind, JSON.stringify(shown.slice(0, 120)) + ' / ' + JSON.stringify(tailwind.slice(0, 120)))
  await panel.locator('select[aria-label="コードの形式"]').selectOption('html')

  await viewer.locator('input[type=file]').setInputFiles(wireframePath)
  await viewer.waitForSelector('.inspect-layer:has(.layer-name:text-is("TabBar"))')
  const wireNames = await viewer.locator('.inspect-layer .layer-name').allTextContents()
  check('ワイヤーフレームの例を viewer で開ける', ['Screen', 'Header', 'Content', 'ListItem', 'TabBar'].every((name) => wireNames.includes(name)), wireNames.join())
  await viewer.screenshot({ path: path.join(OUT, 'cli-wireframe.png') })

  // CLI の png は viewer の「ページを PNG に」と同じ名前・大きさ・絵になる（描画は同じ render.ts。違いは書体の細部だけ）
  const [viewerPng] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("ページを PNG に")').click()])
  const viewerPngPath = path.join(OUT, 'cli-wireframe-viewer.png')
  await viewerPng.saveAs(viewerPngPath)
  const pngDir = path.join(OUT, 'cli-png')
  fs.rmSync(pngDir, { recursive: true, force: true })
  fs.mkdirSync(pngDir)
  execFileSync(process.execPath, [CLI, '-f', wireframePath, 'png'], { cwd: pngDir, stdio: ['ignore', 'pipe', 'pipe'] })
  const cliPngName = fs.readdirSync(pngDir)[0]
  check('CLI の png の名前が viewer と同じ', cliPngName === viewerPng.suggestedFilename(), `${cliPngName} / ${viewerPng.suggestedFilename()}`)
  const diff = await viewer.evaluate(async ([a, b]) => {
    const decode = async (base64) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }))
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      return { width: bitmap.width, height: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data }
    }
    const [x, y] = [await decode(a), await decode(b)]
    if (x.width !== y.width || x.height !== y.height) return { size: [x.width, x.height, y.width, y.height] }
    let differ = 0
    for (let i = 0; i < x.data.length; i += 4) {
      const d = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(x.data[i + k] - y.data[i + k])))
      if (d > 16) differ++
    }
    return { size: null, ratio: differ / (x.width * x.height) }
  }, [fs.readFileSync(viewerPngPath).toString('base64'), fs.readFileSync(path.join(pngDir, cliPngName)).toString('base64')])
  // 違ってよいのは文字の縁のにじみ程度（全体の 3% まで。手元の Chrome と Skia で 1.6%）
  check('CLI の png が viewer の PNG と同じ大きさ・ほぼ同じ絵', diff.size === null && diff.ratio < 0.03, JSON.stringify(diff))

  // editor でも開けて、インスタンスの上書き（Cancel）がそのまま残る
  const editor = await context.newPage()
  editor.on('pageerror', (e) => errors.push('editor: ' + String(e)))
  editor.on('console', (m) => m.type() === 'error' && errors.push('editor: ' + m.text()))
  await editor.goto(EDITOR)
  await editor.waitForSelector('.canvas-view canvas')
  await editor.locator('input[type=file][accept^=".kdr"]').setInputFiles(kdrPath)
  await editor.waitForSelector('.layer-row:has(.layer-name:text-is("Card"))')
  const rows = await editor.locator('.layer-row .layer-name').allTextContents()
  check('editor で開ける', rows.includes('Card') && rows.includes('Button'), rows.join())
  await editor.screenshot({ path: path.join(OUT, 'cli-editor.png') })
  editor.on('dialog', (d) => d.accept())
  await editor.locator('input[type=file][accept^=".kdr"]').setInputFiles(morePath)
  await editor.waitForSelector('.layer-row:has(.layer-name:text-is("Chip"))')
  const moreRows = await editor.locator('.layer-row .layer-name').allTextContents()
  check('バリアントなどを足した kdr を editor で開ける', ['Card', 'Chip'].every((name) => moreRows.includes(name)), moreRows.join())

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
