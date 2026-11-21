// SVG の取り込み: ファイルを開く・ドロップ・貼り付けで、SVG を図形のノードに変換して置く。
// スクリプトが動かないこと、SVG を DOM に入れないこと、落としたものを知らせることも確かめる
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5181'
const SAMPLE = path.join(__dirname, 'fixtures', 'sample.svg')
let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('dialog', (d) => d.accept())
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(['document'])
      const doc = tx.objectStore('document').get('current')
      tx.oncomplete = () => resolve({ ...doc.result.document, nodes: Object.assign({}, ...doc.result.document.pages.map((p) => p.nodes)) })
    }
  }))
  const byName = (doc, name) => Object.values(doc.nodes).filter((n) => n.name === name)
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()

  // ── ツールバーの「画像・SVG を配置」から開く ──
  const input = page.locator('input[type=file][accept*=".svg"][multiple]')
  check('画像を置くファイル選択で SVG も選べる', (await input.count()) === 1)
  await input.setInputFiles(SAMPLE)
  await page.waitForSelector('.app-message')
  const message = await page.locator('.app-message').textContent()
  check('落としたものを知らせる', /sample\.svg/.test(message) && /スクリプト/.test(message) && /foreignObject/.test(message) && /フィルタ/.test(message) && /画像（<image>）/.test(message), message)
  await page.waitForTimeout(700)
  let doc = await saved()
  const root = byName(doc, 'sample')[0]
  check('SVG 全体が 1 つのフレームになる（名前はファイル名、大きさは width / height）', root?.type === 'frame' && root.width === 240 && root.height === 160 && root.clipContent === true, JSON.stringify(root && { w: root.width, h: root.height }))
  const house = byName(doc, 'house')[0]
  check('g は入れ子のフレームになり、レイヤー名に id を使う', house?.type === 'frame' && house.parentId === root.id && house.children.length === 3)
  const wall = byName(doc, 'wall')[0]
  check('rect は矩形（viewBox の縮尺と g の transform を焼き込む）', wall?.type === 'rect' && wall.parentId === house.id && wall.width === 80 && wall.height === 60 && wall.cornerRadius === 4 && wall.strokes[0]?.color === '#222222', JSON.stringify(wall && { w: wall.width, h: wall.height, r: wall.cornerRadius }))
  const hill = byName(doc, 'hill')[0]
  check('path の曲線は制御点つきの頂点になる', hill?.type === 'path' && hill.closed && hill.points.some((p) => p.in || p.out))
  const background = byName(doc, 'background')[0]
  check('linearGradient は直線状のグラデーションになる', background?.fills[0]?.type === 'linear' && background.fills[0].angle === 90 && background.fills[0].stops[0].color === '#4f8ef7')
  const caption = byName(doc, 'caption')[0]
  check('text はテキストになる（中央揃え・白）', caption?.type === 'text' && caption.text === 'Hello SVG' && caption.textAlign === 'center' && caption.fills[0]?.color === '#ffffff' && caption.fontSize === 12)
  check('ほかの図形もノードになる', ['roof', 'window', 'sun', 'ground', 'bird'].every((name) => byName(doc, name).length === 1), (await layers()).join(','))
  const pwned = await page.evaluate(() => window.svgPwned)
  check('SVG のスクリプトや onload は動かない', pwned === undefined, String(pwned))
  check('SVG を画面の DOM に入れない', (await page.locator('#fixture-root, foreignObject').count()) === 0)
  check('kdr に SVG の文字が残らない', !/svgPwned|example\.com|<svg/.test(JSON.stringify(doc)))
  check('取り込んだものが選ばれている', (await page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()).includes('sample'))
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, 'svg-import.png') })

  // ── Undo で 1 回で消える ──
  await page.locator('.app-message button').click()
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(700)
  check('取り込みは Undo 1 回で消える', byName(await saved(), 'sample').length === 0)
  await page.keyboard.press('Meta+Shift+z')

  // ── ドロップ ──
  const source = fs.readFileSync(SAMPLE, 'utf8')
  await page.evaluate((text) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([text], 'dropped.svg', { type: 'image/svg+xml' }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  }, source)
  await page.waitForTimeout(700)
  doc = await saved()
  check('ドロップした SVG も取り込む', byName(doc, 'dropped').length === 1 && byName(doc, 'sample').length === 1)

  // ── 貼り付け（「SVG としてコピー」した文字） ──
  await page.locator('.canvas-view canvas').click({ position: { x: 20, y: 20 } })
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="40"><rect id="pasted-box" width="50" height="40" fill="#123456"/></svg>')
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(700)
  doc = await saved()
  const pasted = byName(doc, 'pasted-box')[0]
  check('貼り付けた SVG の文字も取り込む', pasted?.type === 'rect' && pasted.fills[0]?.color === '#123456' && pasted.width === 50)

  // ── 壊れた SVG と、画像としての SVG ──
  fs.writeFileSync(path.join(OUT, 'broken.svg'), '<svg><g></svg>')
  await input.setInputFiles(path.join(OUT, 'broken.svg'))
  await page.waitForSelector('.app-message')
  check('壊れた SVG はエラーを出す', /broken\.svg/.test(await page.locator('.app-message').textContent()))
  await page.locator('.app-message button').click()
  // 画像の差し替えは SVG を受け付けない（IMAGE_MIME_TYPES に入っていない）
  const accepts = await page.locator('input[type=file]').evaluateAll((inputs) => inputs.map((i) => i.accept))
  check('kdr を開くボタンでも SVG を選べる', accepts.some((a) => a.includes('.kdr') && a.includes('.svg')), accepts.join(' | '))

  // ── viewer は SVG を受け付けない（kdr として開こうとしてエラー） ──
  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push(String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await viewer.goto(VIEWER)
  // 開発サーバーの最初の読み込みは遅いことがある
  await viewer.waitForSelector('input[type=file]', { state: 'attached', timeout: 60000 })
  await viewer.locator('input[type=file]').first().setInputFiles(SAMPLE)
  await viewer.waitForSelector('.app-message')
  check('viewer は SVG を開かない', (await viewer.evaluate(() => window.svgPwned)) === undefined)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
