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

  await viewer.locator('input[type=file]').setInputFiles(wireframePath)
  await viewer.waitForSelector('.inspect-layer:has(.layer-name:text-is("TabBar"))')
  const wireNames = await viewer.locator('.inspect-layer .layer-name').allTextContents()
  check('ワイヤーフレームの例を viewer で開ける', ['Screen', 'Header', 'Content', 'ListItem', 'TabBar'].every((name) => wireNames.includes(name)), wireNames.join())
  await viewer.screenshot({ path: path.join(OUT, 'cli-wireframe.png') })

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

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
