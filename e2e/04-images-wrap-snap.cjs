const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')

const OUT = path.join(__dirname, 'out')
const FIXTURES = path.join(__dirname, 'fixtures')
require('fs').mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5181'
let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('dialog', (d) => d.accept())
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = (x, y) => [box.x + x, box.y + y]
  const drag = async (from, to, opts = {}) => {
    await page.mouse.move(...at(...from)); await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    if (opts.beforeUp) await opts.beforeUp()
    await page.mouse.up()
  }
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()
  const row = (name) => page.locator(`.layer-row:has(.layer-name:text-is("${name}"))`)
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const num = async (label) => Number(await field(label).inputValue())
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['document', 'assets'])
      const doc = tx.objectStore('document').get('current')
      const keys = tx.objectStore('assets').getAllKeys()
      tx.oncomplete = () => resolve({ ...((doc) => ({ ...doc, nodes: Object.assign({}, ...doc.pages.map((page) => page.nodes)) }))(doc.result.document), assetKeys: keys.result })
    }
  }))
  const byName = async (name) => Object.values((await saved()).nodes).find((n) => n.name === name)

  // テスト用の画像を作る
  const makePng = async (w, h, color, file) => {
    const url = await page.evaluate(([w, h, color]) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h
      const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#fff'; ctx.fillRect(w / 4, h / 4, w / 2, h / 2)
      return c.toDataURL('image/png')
    }, [w, h, color])
    fs.writeFileSync(path.join(OUT, file), Buffer.from(url.split(',')[1], 'base64'))
    return path.join(OUT, file)
  }
  const photo = await makePng(200, 100, '#e5484d', 'photo.png')

  // ── スナップ ──
  await page.keyboard.press('r'); await drag([100, 100], [200, 200])
  await page.keyboard.press('r'); await drag([300, 263], [380, 343])
  // 2 つ目を上へ動かし、上端が 1 つ目の上端（100）から 3px ずれた位置で離す → 100 に吸着
  await drag([340, 300], [340, 300 - 160])
  check('移動で上端に吸着する', (await num('Y')) === 100, String(await num('Y')))
  // Cmd を押している間は吸着しない
  await page.keyboard.down('Meta')
  await drag([340, 140], [340, 190])
  await drag([340, 190], [340, 143])
  await page.keyboard.up('Meta')
  check('Cmd/Ctrl で吸着を無効にできる', (await num('Y')) === 103, String(await num('Y')))
  await drag([340, 143], [340, 190])
  await drag([340, 190], [340, 142])
  check('同じ動きでも Cmd/Ctrl なしなら吸着する', (await num('Y')) === 100, String(await num('Y')))
  // リサイズで下端を 1 つ目の下端（200）に吸着
  await drag([340, 180], [340, 197])
  check('リサイズで下端に吸着する', (await num('H')) === 100, String(await num('H')))
  // ガイドの見た目
  await page.mouse.move(...at(340, 150)); await page.mouse.down(); await page.mouse.move(...at(341, 152), { steps: 3 }); await page.mouse.move(...at(340, 151), { steps: 2 })
  await page.screenshot({ path: path.join(OUT, '8-guides.png') })
  await page.mouse.up()
  await page.keyboard.press('Meta+z')

  // ── 整列 ──
  await page.keyboard.press('r'); await drag([450, 400], [500, 430])
  await page.keyboard.press('Meta+a')
  await page.locator('[aria-label="左揃え"]').click()
  await page.waitForTimeout(700)
  let nodes = Object.values((await saved()).nodes)
  check('左揃え', nodes.every((n) => n.x === 100), nodes.map((n) => n.x).join())
  await page.keyboard.press('Meta+z')
  await page.locator('[aria-label="左右に等間隔"]').click()
  await page.waitForTimeout(700)
  nodes = Object.values((await saved()).nodes).sort((a, b) => a.x - b.x)
  const gap1 = nodes[1].x - (nodes[0].x + nodes[0].width), gap2 = nodes[2].x - (nodes[1].x + nodes[1].width)
  check('等間隔に並ぶ', Math.abs(gap1 - gap2) <= 1, `${gap1}, ${gap2}`)
  await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace')

  // ── テキストの折り返し ──
  await page.keyboard.press('f'); await drag([60, 60], [460, 460])
  await page.keyboard.press('t')
  await drag([100, 100], [260, 140])
  await page.waitForSelector('.text-editor')
  await page.keyboard.type('The quick brown fox jumps over the lazy dog. 日本語の文章も幅に合わせて折り返されます。')
  await page.screenshot({ path: path.join(OUT, '9-wrap-editing.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  let text = await byName('Text 1')
  const lines0 = Math.round(text.height / (16 * 1.2))
  check('ドラッグで作ると固定幅で折り返す', text.autoWidth === false && text.width === 160 && lines0 >= 4, `w=${text.width} lines=${lines0}`)
  await page.screenshot({ path: path.join(OUT, '10-wrap-done.png') })
  // 幅を広げると行数が減る
  await field('W').fill('320'); await field('W').press('Enter')
  await page.waitForTimeout(700)
  text = await byName('Text 1')
  check('幅を広げると高さが縮む', text.width === 320 && Math.round(text.height / 19.2) < lines0, `h=${text.height}`)
  // 折り返しをやめる
  await page.locator('.field:has(.field-label:text-is("折り返し")) select').selectOption('auto')
  await page.waitForTimeout(700)
  text = await byName('Text 1')
  check('折り返しをやめると 1 行になる', text.autoWidth === true && text.height === 20 && text.width > 400, `${text.width}x${text.height}`)
  await page.keyboard.press('Meta+z')
  // ハンドルで幅を変える（右辺）
  await page.waitForTimeout(700)
  text = await byName('Text 1')
  const right = 100 + text.width, midY = 100 + text.height / 2
  await page.keyboard.down('Meta')
  await drag([right, midY], [right - 120, midY])
  await page.keyboard.up('Meta')
  await page.waitForTimeout(700)
  const narrowed = await byName('Text 1')
  check('ハンドルで幅を変えると折り返し直す', narrowed.width === text.width - 120 && narrowed.height > text.height, `${narrowed.width}x${narrowed.height}`)

  // ── 画像 ──
  await page.locator('input[type=file][accept^="image/"]').setInputFiles(photo)
  await page.waitForFunction(() => [...document.querySelectorAll('.layer-name')].some((e) => e.textContent === 'photo'))
  check('画像を配置できる', (await num('W')) === 200 && (await num('H')) === 100, `${await num('W')}x${await num('H')}`)
  check('フレームの上に置くと子になる', (await layers()).join() === 'Frame 1,photo,Text 1', (await layers()).join())
  check('画像には塗りの項目を出さない', (await page.locator('.section-title:text-is("塗り")').count()) === 0)
  // 角のハンドルは縦横比を保つ
  const ix = await num('X'), iy = await num('Y')
  const se = [60 + ix + 200, 60 + iy + 100]
  await page.keyboard.down('Meta')
  await drag(se, [se[0] + 100, se[1] + 10])
  await page.keyboard.up('Meta')
  check('画像は縦横比を保ってリサイズ', (await num('W')) === 300 && (await num('H')) === 150, `${await num('W')}x${await num('H')}`)
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(OUT, '11-image.png') })

  // クリップボードの画像を貼り付け
  const pasted = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64
    c.getContext('2d').fillStyle = '#30a46c'; c.getContext('2d').fillRect(0, 0, 64, 64)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); return true } catch (e) { return String(e) }
  })
  if (pasted === true) {
    await page.mouse.click(...at(700, 600))
    await page.keyboard.press('Meta+v')
    await page.waitForTimeout(500)
    check('クリップボードの画像を貼り付けられる', (await layers()).length === 4, (await layers()).join())
    // ノードをコピーした後は、ノードの貼り付けが優先される
    await row('Text 1').click()
    await page.keyboard.press('Meta+c')
    await page.keyboard.press('Meta+v')
    await page.waitForTimeout(300)
    check('ノードをコピーした後はノードが貼り付く', (await layers()).filter((n) => n === 'Text 1').length === 2, (await layers()).join())
    await page.keyboard.press('Meta+z')
  } else {
    console.log('skip クリップボード画像（権限なし）: ' + pasted)
  }

  // 再読み込みしても画像が残る
  await page.waitForTimeout(800)
  const before = await saved()
  check('画像データは別ストアに 1 件ずつ保存', before.assetKeys.length >= 1 && Object.keys(before.assets).length === 0, JSON.stringify(before.assetKeys))
  await page.reload()
  await page.waitForSelector('.layer-row')
  check('再読み込みで画像も復元', (await layers()).includes('photo'), (await layers()).join())
  await page.waitForTimeout(500)
  await page.locator('button:text-is("全体表示")').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT, '12-reloaded.png') })

  // 画像を消して保存 → 次の読み込みでデータも片付く
  await row('photo').click()
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Meta+z')
  check('削除した画像は undo で戻る', (await layers()).includes('photo'))

  // 書き出して viewer で開く
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'with-image.kdr')
  await download.saveAs(kdrPath)
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(kdrPath)).toString('utf8'))
  const used = new Set(Object.values(json.document.pages[0].nodes).filter((n) => n.type === 'image').map((n) => n.assetId))
  check('kdr に画像が埋め込まれる', json.version === 10 && used.size >= 1 && Object.keys(json.document.assets).length === used.size, `assets=${Object.keys(json.document.assets).length}`)

  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(600)
  await viewer.screenshot({ path: path.join(OUT, '13-viewer-image.png') })
  // 画像を選ぶと、埋め込んである元のファイルを、そのまま保存できる
  await viewer.locator('.inspect-layer[title="画像"]').first().click()
  const imageName = await viewer.locator('.inspect-panel .panel-title').textContent()
  const picked = Object.values(json.document.pages[0].nodes).find((n) => n.type === 'image' && n.name === imageName)
  const [original] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("元の画像を保存")').click()])
  const originalPath = path.join(OUT, 'original-image.bin')
  await original.saveAs(originalPath)
  check('viewer で、画像の元のファイルを保存できる', original.suggestedFilename() === `${imageName}.png` && fs.readFileSync(originalPath).equals(Buffer.from(json.document.assets[picked.assetId].data, 'base64')), original.suggestedFilename())
  await viewer.keyboard.press('Escape')
  check('画像でないものには、元の画像を保存するボタンは出ない', (await viewer.locator('button:text-is("元の画像を保存")').count()) === 0)
  // viewer に画像を落としても何も起きない（kdr として開こうとしてエラー表示）
  await viewer.locator('input[type=file]').setInputFiles(photo)
  await viewer.waitForSelector('.app-message')
  check('viewer は画像ファイルを受け付けない', true)

  // v1 のファイル（前のマイルストーンで書き出したもの）も開ける
  {
    await viewer.locator('.app-message button').click()
    await viewer.locator('input[type=file]').setInputFiles(path.join(FIXTURES, 'sample-v1.kdr'))
    await viewer.waitForFunction(() => document.querySelector('.document-name')?.textContent === 'テスト デザイン')
    check('version 1 の kdr も開ける', (await viewer.locator('.app-message').count()) === 0)
  }

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
