const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5181'
let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = (x, y) => [box.x + x, box.y + y]
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from)); await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
  }
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const deselect = () => page.mouse.click(...at(740, 600))
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('document').objectStore('document').get('current')
      request.onsuccess = () => resolve(request.result.document.pages[0])
    }
  }))
  const byName = async (name) => { await page.waitForTimeout(700); return Object.values((await saved()).nodes).find((n) => n.name === name) }
  // 描画は requestAnimationFrame でまとめられるので、2 フレーム待ってから読む
  const pixel = (x, y) => page.evaluate(async ([x, y]) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    return [...canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data]
  }, [x, y])
  const reddish = (p) => p[0] > 200 && p[1] < 90 && p[2] < 90 && p[3] === 255
  const bluish = (p) => p[0] < 60 && p[2] > 200 && p[3] === 255
  const whitish = (p) => p[0] > 240 && p[1] > 240 && p[2] > 240 && p[3] === 255
  /** PNG のヘッダから幅と高さを読む */
  const pngSize = (file) => {
    const bytes = fs.readFileSync(file)
    const signature = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    return { signature, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }

  // ── グラデーション ──
  const typeSelect = (label) => page.locator(`.field:has(.field-label:text-is("${label}の種類")) select`)
  await page.keyboard.press('r'); await drag([100, 100], [300, 200])
  await page.locator('[aria-label="塗りの色"]').fill('#ff0000')
  await typeSelect('塗り').selectOption('linear')
  await page.locator('[aria-label="塗りの2 番目の色"]').fill('#0000ff')
  await set('角度', 0)
  let rect = await byName('Rectangle 1')
  check('グラデーションが保存される', JSON.stringify(rect.fills) === JSON.stringify([{ type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }], opacity: 1, visible: true, blendMode: 'normal' }]), JSON.stringify(rect.fills))
  await deselect()
  const left = await pixel(103, 150), right = await pixel(297, 150), middle = await pixel(200, 150)
  check('左から右へ色が変わる', reddish(left) && bluish(right) && middle[0] > 80 && middle[2] > 80, `${left} / ${middle} / ${right}`)

  await page.mouse.click(...at(200, 150))
  await set('角度', 90)
  await deselect()
  const top = await pixel(200, 103), bottom = await pixel(200, 197)
  check('角度 90 で上から下へ変わる', reddish(top) && bluish(bottom), `${top} / ${bottom}`)

  // 3 色目を足すと、間に入る。色を変えると真ん中の色が変わる
  await page.mouse.click(...at(200, 150))
  await page.locator('button:text-is("塗りに色を足す")').click()
  await page.locator('[aria-label="塗りの2 番目の色"]').fill('#00ff00')
  rect = await byName('Rectangle 1')
  check('3 色のグラデーションになる', rect.fills[0].stops.length === 3 && rect.fills[0].stops[1].offset === 0.5 && rect.fills[0].stops[1].color === '#00ff00', JSON.stringify(rect.fills))
  await deselect()
  const center = await pixel(200, 150)
  check('3 色目が真ん中に描かれる', center[1] > 200 && center[0] < 90 && center[2] < 90, `${center}`)

  // 円形にすると、中心が始まりの色、角が終わりの色
  await page.mouse.click(...at(200, 150))
  await typeSelect('塗り').selectOption('radial')
  rect = await byName('Rectangle 1')
  check('円形のグラデーションになる（色はそのまま）', rect.fills[0].type === 'radial' && rect.fills[0].rx === 0.5 && rect.fills[0].stops.length === 3, JSON.stringify(rect.fills))
  await deselect()
  const core = await pixel(200, 150), corner = await pixel(103, 103)
  check('円形: 中心は始まりの色、角は終わりの色', reddish(core) && bluish(corner), `${core} / ${corner}`)

  // 塗りを重ねる。上に足した単色が見え、外すと下が見える
  await page.mouse.click(...at(200, 150))
  await page.locator('[aria-label="塗りを足す"]').click()
  rect = await byName('Rectangle 1')
  check('塗りを上に重ねられる', rect.fills.length === 2 && rect.fills[1].type === 'solid' && rect.fills[0].type === 'radial', JSON.stringify(rect.fills.map((f) => f.type)))
  await page.locator('[aria-label="塗りの色"]').fill('#ffffff')
  await deselect()
  check('上の塗りが見える', whitish(await pixel(200, 150)))
  await page.mouse.click(...at(200, 150))
  await page.locator('[aria-label="塗りを下へ"]').click()
  await deselect()
  check('並べ替えると下にあった塗りが見える', reddish(await pixel(200, 150)))
  await page.mouse.click(...at(200, 150))
  await page.locator('[aria-label="塗り 2を外す"]').click()
  rect = await byName('Rectangle 1')
  check('重ねた塗りを外せる', rect.fills.length === 1 && rect.fills[0].type === 'radial', JSON.stringify(rect.fills.map((f) => f.type)))

  // 線もグラデーションにできる
  await page.locator('[aria-label="線を有効にする"]').click()
  await set('太さ', 10)
  await typeSelect('線').selectOption('linear')
  rect = await byName('Rectangle 1')
  check('線をグラデーションにできる', rect.strokes[0].type === 'linear' && rect.strokes[0].stops[0].color === '#000000', JSON.stringify(rect.strokes))
  await typeSelect('線').selectOption('radial')
  await page.locator('[aria-label="線の1 番目の色"]').fill('#ff0000')
  await page.locator('[aria-label="線の2 番目の色"]').fill('#0000ff')
  await deselect()
  check('線の円形のグラデーションも描かれる（角は終わりの色）', bluish(await pixel(100, 100)), `${await pixel(100, 100)}`)
  await page.mouse.click(...at(200, 150))
  await page.locator('[aria-label="線を外す"]').click()

  // 角丸を 4 隅ばらばらに
  await page.locator('label:has-text("角ごとに変える") input').check()
  await set('右下', 40)
  rect = await byName('Rectangle 1')
  check('角丸を 4 隅ばらばらにできる', JSON.stringify(rect.cornerRadius) === '[0,0,40,0]', JSON.stringify(rect.cornerRadius))
  await deselect()
  check('丸めた右下の角だけが透ける', (await pixel(298, 198))[3] === 0 && (await pixel(102, 198))[3] === 255, `${await pixel(298, 198)}`)
  await page.mouse.click(...at(200, 150))
  await set('半径', 0)
  rect = await byName('Rectangle 1')
  check('半径で 4 隅を揃えると数値 1 つに戻る', rect.cornerRadius === 0, JSON.stringify(rect.cornerRadius))

  // テキストの塗りもグラデーションにできる
  await page.keyboard.press('t'); await drag([400, 280], [560, 320])
  await page.keyboard.type('グラデーション'); await page.keyboard.press('Escape')
  await typeSelect('塗り').selectOption('linear')
  const label = Object.values((await (async () => { await page.waitForTimeout(700); return saved() })()).nodes).find((n) => n.type === 'text')
  check('テキストの塗りをグラデーションにできる', label?.fills[0]?.type === 'linear', JSON.stringify(label?.fills))
  await page.keyboard.press('Delete')
  await page.mouse.click(...at(200, 150))

  // 始まりの色を変える
  await page.locator('[aria-label="塗りの1 番目の色"]').fill('#00ff00')
  rect = await byName('Rectangle 1')
  check('始まりの色を変えられる', rect.fills[0].stops[0].color === '#00ff00' && rect.fills[0].stops[2].color === '#0000ff', JSON.stringify(rect.fills))
  // 書き出しの確認のため、上から下への赤から青に戻す
  await typeSelect('塗り').selectOption('linear')
  await page.locator('[aria-label="塗りの2 番目の色を消す"]').click()
  await page.locator('[aria-label="塗りの1 番目の色"]').fill('#ff0000')
  rect = await byName('Rectangle 1')
  check('直線に戻して色を消せる', JSON.stringify(rect.fills) === JSON.stringify([{ type: 'linear', x1: 0.5, y1: 0, x2: 0.5, y2: 1, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }], opacity: 1, visible: true, blendMode: 'normal' }]), JSON.stringify(rect.fills))
  await page.screenshot({ path: path.join(OUT, '29-gradient.png') })

  // ── PNG 書き出し ──
  await page.locator('[aria-label="書き出しの倍率"]').selectOption('2')
  const [selectionPng] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("PNG に書き出し")').click()])
  const selectionPath = path.join(OUT, 'export-selection.png')
  await selectionPng.saveAs(selectionPath)
  const size = pngSize(selectionPath)
  check('選択したものを 2 倍で書き出せる', selectionPng.suggestedFilename() === 'Rectangle 1@2x.png' && size.signature && size.width === 400 && size.height === 200, `${selectionPng.suggestedFilename()} ${JSON.stringify(size)}`)
  // 書き出した画像の中身（左上は赤、右下は青、選択枠は写らない）
  const exported = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0)
    const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data]
    return { top: at(200, 4), bottom: at(200, 195), corner: at(0, 0) }
  }, fs.readFileSync(selectionPath).toString('base64'))
  check('書き出した PNG にグラデーションが写り、選択枠は写らない', reddish(exported.top) && bluish(exported.bottom) && reddish(exported.corner), JSON.stringify(exported))

  // SVG 書き出し: 同じ選択を SVG に。グラデーションは linearGradient で、ブラウザで開いても同じ色になる
  const [selectionSvg] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("SVG に")').click()])
  const selectionSvgPath = path.join(OUT, 'export-selection.svg')
  await selectionSvg.saveAs(selectionSvgPath)
  const svgText = fs.readFileSync(selectionSvgPath, 'utf8')
  const svgPixels = await page.evaluate(async (text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
    const img = new Image(); img.src = url; await img.decode()
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0)
    URL.revokeObjectURL(url)
    const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data]
    return { width: canvas.width, height: canvas.height, top: at(100, 2), bottom: at(100, 97) }
  }, svgText)
  check('選択したものを SVG に書き出せる（ブラウザで開くと PNG と同じ向きのグラデーション）',
    selectionSvg.suggestedFilename() === 'Rectangle 1.svg' && svgText.includes('<linearGradient') &&
      svgPixels.width === 200 && svgPixels.height === 100 && reddish(svgPixels.top) && bluish(svgPixels.bottom),
    `${selectionSvg.suggestedFilename()} ${JSON.stringify(svgPixels)}`)
  // 「SVG をコピー」と右クリックメニューの「SVG としてコピー」は、書き出すファイルと同じ文字をクリップボードへ入れる
  const clipboard = (target) => target.evaluate(() => navigator.clipboard.readText())
  await page.evaluate(() => navigator.clipboard.writeText(''))
  await page.locator('button:text-is("SVG をコピー")').click()
  check('editor の「SVG をコピー」で書き出しと同じ SVG がクリップボードに入る',
    (await clipboard(page)) === svgText && (await page.locator('button:text-is("コピーしました")').count()) === 1)
  await page.evaluate(() => navigator.clipboard.writeText(''))
  await page.mouse.click(...at(200, 150), { button: 'right' })
  await page.locator('.context-menu-item:has-text("SVG としてコピー")').click()
  await page.waitForTimeout(100)
  check('右クリックメニューの「SVG としてコピー」でも同じ SVG が入る', (await clipboard(page)) === svgText)

  // 何も選んでいなければページ全体
  await page.keyboard.press('o'); await drag([400, 150], [460, 250])
  await deselect()
  const [pagePng] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("このページを PNG に書き出し")').click()])
  const pagePath = path.join(OUT, 'export-page.png')
  await pagePng.saveAs(pagePath)
  const pageSize = pngSize(pagePath)
  check('何も選んでいなければページ全体を書き出す', pagePng.suggestedFilename() === 'Untitled - Page 1.png' && pageSize.width === 360 && pageSize.height === 150, `${pagePng.suggestedFilename()} ${JSON.stringify(pageSize)}`)

  // ── 画像の収め方 ──
  // 200 × 100 の赤い画像の中央に、100 × 50 の白い四角
  const photo = path.join(OUT, 'fit-source.png')
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 100
    const ctx = c.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 200, 100)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(50, 25, 100, 50)
    return c.toDataURL('image/png')
  })
  fs.writeFileSync(photo, Buffer.from(dataUrl.split(',')[1], 'base64'))
  await page.locator('input[type=file][accept^="image/"]').setInputFiles(photo)
  await page.waitForFunction(() => [...document.querySelectorAll('.layer-name')].some((e) => e.textContent === 'fit-source'))
  await set('X', 500); await set('Y', 400); await set('W', 100); await set('H', 100)
  let image = await byName('fit-source')
  check('新しい画像は「枠を埋めて切り抜く」', image.fit === 'cover' && image.width === 100 && image.height === 100, JSON.stringify([image.fit, image.width, image.height]))
  const fitSelect = page.locator('.field:has(.field-label:text-is("収め方")) select')
  await deselect()
  // 枠の左端・上下中央。切り抜きなら白い四角が左右いっぱいに広がる
  check('切り抜き: 画像の中央が枠いっぱいに広がる', whitish(await pixel(505, 450)) && reddish(await pixel(550, 410)), `${await pixel(505, 450)} / ${await pixel(550, 410)}`)
  await page.mouse.click(...at(550, 450))
  await fitSelect.selectOption('stretch')
  await deselect()
  check('引き伸ばし: 画像全体が枠に合わせて歪む', reddish(await pixel(505, 450)) && whitish(await pixel(550, 450)), `${await pixel(505, 450)}`)
  await page.mouse.click(...at(550, 450))
  await fitSelect.selectOption('contain')
  await deselect()
  const margin = await pixel(550, 410)
  check('全体を収める: 上下に余白が空く', margin[3] === 0 && reddish(await pixel(505, 450)), `${margin}`)
  // 寄せる位置: 全体を収めるなら余白の配り方、切り抜くなら残す場所
  await page.mouse.click(...at(550, 450))
  await set('縦の位置 %', 0)
  await deselect()
  check('収めた画像を上に寄せられる', reddish(await pixel(550, 410)) && (await pixel(550, 490))[3] === 0, `${await pixel(550, 410)} / ${await pixel(550, 490)}`)
  await page.mouse.click(...at(550, 420))
  await fitSelect.selectOption('cover')
  await set('横の位置 %', 0)
  await deselect()
  image = await byName('fit-source')
  check('切り抜く位置を左に寄せられる', image.positionX === 0 && image.positionY === 0 && reddish(await pixel(505, 450)) && whitish(await pixel(590, 450)), `${await pixel(505, 450)} / ${await pixel(590, 450)}`)
  await page.mouse.click(...at(550, 450))
  await fitSelect.selectOption('contain')
  await set('横の位置 %', 50); await set('縦の位置 %', 50)
  await deselect()
  await page.screenshot({ path: path.join(OUT, '30-image-fit.png') })

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'paint.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  const nodes = Object.values(json.document.pages[0].nodes)
  check('kdr にグラデーションと収め方が入る', json.version === 16 && nodes.some((n) => n.fills && n.fills.some((p) => p.type === 'linear')) && nodes.some((n) => n.fit === 'contain'))

  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(400)
  await viewer.screenshot({ path: path.join(OUT, '31-viewer-paint.png') })
  // viewer でもページやフレームを PNG として保存できる（ドキュメントは変更しない）
  await viewer.locator('[aria-label="書き出しの倍率"]').selectOption('2')
  const [viewerPng] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("ページを PNG に")').click()])
  const viewerPath = path.join(OUT, 'export-viewer.png')
  await viewerPng.saveAs(viewerPath)
  const viewerSize = pngSize(viewerPath)
  // ページ全体: 長方形の左端 100 から画像の右端 600、上端 100 から下端 500
  check('viewer でページを PNG に書き出せる', viewerPng.suggestedFilename() === 'Untitled - Page 1@2x.png' && viewerSize.signature && viewerSize.width === 1000 && viewerSize.height === 800, `${viewerPng.suggestedFilename()} ${JSON.stringify(viewerSize)}`)
  const [viewerSvg] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("SVG に")').click()])
  const viewerSvgPath = path.join(OUT, 'export-viewer.svg')
  await viewerSvg.saveAs(viewerSvgPath)
  const viewerSvgText = fs.readFileSync(viewerSvgPath, 'utf8')
  check('viewer でページを SVG に書き出せる（画像は埋め込み）',
    viewerSvg.suggestedFilename() === 'Untitled - Page 1.svg' && viewerSvgText.includes('viewBox="100 100 500 400"') && viewerSvgText.includes('href="data:image/png;base64,'),
    `${viewerSvg.suggestedFilename()} ${viewerSvgText.slice(0, 200)}`)
  await viewer.locator('button:text-is("SVG をコピー")').click()
  check('viewer の「SVG をコピー」でページの SVG がクリップボードに入る', (await clipboard(viewer)) === viewerSvgText)
  check('viewer に編集 UI がない', (await viewer.locator('.toolbar, .layers-panel, .properties-panel, .page-row').count()) === 0)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
