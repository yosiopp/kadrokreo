const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')

const OUT = path.join(__dirname, 'out')
const FIXTURES = path.join(__dirname, 'fixtures')
fs.mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5181'
let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
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
  const click = (x, y) => page.mouse.click(...at(x, y))
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()
  const select = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) select`)
  const deselect = () => click(740, 600)
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('document').objectStore('document').get('current')
      request.onsuccess = () => resolve(request.result.document.pages[0])
    }
  }))
  const byName = async (name) => { await page.waitForTimeout(700); return Object.values((await saved()).nodes).find((n) => n.name === name) }
  // 描画は requestAnimationFrame でまとめられるので、2 フレーム待ってから読む。背景は透明なので alpha で見る
  const alpha = (x, y) => page.evaluate(async ([x, y]) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    return canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data[3]
  }, [x, y])

  // ── 矢印 ──
  // 右から左へ引く。始点は右、終点は左
  await page.keyboard.press('l')
  await page.keyboard.down('Shift'); await drag([300, 100], [100, 103]); await page.keyboard.up('Shift')
  let line = await byName('Line 1')
  check('右から左へ引いた線は、右の端が始点', line.flipped === true && line.width === 200 && line.height === 0, JSON.stringify(line))
  await select('終点').selectOption('arrow')
  await page.locator('.field:has(.field-label:text-is("太さ")) input').fill('3')
  await page.locator('.field:has(.field-label:text-is("太さ")) input').press('Enter')
  await deselect()
  // 矢印の中ほどは線より太い。線の太さは 3 なので、中心から 2.5 離れた所は矢印だけが塗られる
  check('終点（左の端）に矢印が付く', (await alpha(110, 102.5)) > 200 && (await alpha(290, 102.5)) < 50, `${await alpha(110, 102.5)} / ${await alpha(290, 102.5)}`)

  // 始点をつかんで下へ動かしても、矢印は終点に付いたまま
  await click(200, 100)
  await drag([300, 100], [300, 200])
  line = await byName('Line 1')
  check('始点を動かしても終点は動かない', line.x === 100 && line.y === 100 && line.width === 200 && line.height === 100 && line.flipped === true && line.direction === 'down' && line.endCap === 'arrow', JSON.stringify(line))
  // 終点を始点より右へ動かすと、向きが入れ替わっても終点のまま
  await drag([100, 100], [420, 140])
  line = await byName('Line 1')
  check('終点を反対側へ動かしても、始点と終点は入れ替わらない', line.x === 300 && line.width === 120 && line.flipped === false && line.direction === 'up' && line.endCap === 'arrow', JSON.stringify(line))
  await deselect()
  check('矢印は動かした先の終点に付く', (await alpha(414, 143)) > 200, String(await alpha(414, 143)))

  // ── ペンツール: 折れ線 ──
  await page.keyboard.press('p')
  await click(100, 300); await click(200, 300); await click(200, 400)
  await page.mouse.move(...at(260, 430))
  await page.screenshot({ path: path.join(OUT, '25-pen-draft.png') })
  await page.keyboard.press('Enter')
  check('Enter で折れ線が確定し、選択ツールに戻る', (await layers())[0] === 'Path 1' && (await page.locator('[aria-label="選択"]').getAttribute('aria-pressed')) === 'true', (await layers()).join())
  let open = await byName('Path 1')
  check('折れ線は塗りなしで、頂点は 3 つ', open.points.length === 3 && open.closed === false && open.fill === null && open.width === 100 && open.height === 100, JSON.stringify(open))

  // ── ペンツール: 多角形（最初の頂点をクリックして閉じる） ──
  await page.keyboard.press('p')
  await click(300, 300); await click(400, 300); await click(350, 380); await click(300, 300)
  const closed = await byName('Path 2')
  check('最初の頂点をクリックすると閉じた形になる', closed.closed === true && closed.points.length === 3 && closed.fill === '#d9d9d9', JSON.stringify(closed))
  await deselect()
  await click(350, 330)
  check('塗った多角形は内側をクリックして選べる', (await page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()).join() === 'Path 2')

  // ── 描きかけはツールを切り替えると捨てる ──
  await page.keyboard.press('p')
  await click(600, 300); await click(650, 320)
  await page.keyboard.press('v')
  check('ツールを切り替えると描きかけは残らない', (await layers()).length === 3, (await layers()).join())
  // 頂点が 1 つだけなら Esc でも何も作らない
  await page.keyboard.press('p')
  await click(600, 300)
  await page.keyboard.press('Escape')
  check('頂点 1 つでは確定しない', (await layers()).length === 3, (await layers()).join())

  // ── 頂点の編集 ──
  await page.keyboard.press('v')
  await page.mouse.dblclick(...at(150, 300))
  await drag([200, 400], [260, 440])
  open = await byName('Path 1')
  check('ダブルクリックで頂点を動かせる', open.width === 160 && open.height === 140 && open.points.length === 3, `${open.width}x${open.height}`)
  await page.screenshot({ path: path.join(OUT, '26-vertex-edit.png') })
  await page.keyboard.press('Escape')
  check('Esc で頂点の編集を抜けても選択は残る', (await page.locator('.layer-row[data-selected="true"]').count()) === 1)
  // 枠のハンドルでリサイズすると、頂点も一緒に伸縮する
  await page.keyboard.down('Meta'); await drag([260, 440], [340, 510]); await page.keyboard.up('Meta')
  const scaled = await byName('Path 1')
  check('リサイズで形も伸縮する', scaled.width === 240 && scaled.height === 210 && JSON.stringify(scaled.points) === JSON.stringify(open.points), `${scaled.width}x${scaled.height}`)

  // ── 折れ線の端の形、閉じる ──
  await select('終点').selectOption('arrow')
  check('折れ線にも矢印を付けられる', (await byName('Path 1')).endCap === 'arrow')
  await page.locator('label:has-text("最後の頂点を最初の頂点につなぐ") input').check()
  check('閉じると端の形の項目は出ない', (await page.locator('.section-title:text-is("端の形")').count()) === 0 && (await byName('Path 1')).closed === true)
  await page.keyboard.press('Meta+z')
  await deselect()
  await page.screenshot({ path: path.join(OUT, '27-pen-arrows.png') })

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'pen.kdr')
  await download.saveAs(kdrPath)
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(kdrPath)).toString('utf8'))
  const types = Object.values(json.document.pages[0].nodes).map((n) => n.type).sort().join()
  check('kdr にパスと矢印が入る', json.version === 10 && types === 'line,path,path', types)

  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(300)
  await viewer.screenshot({ path: path.join(OUT, '28-viewer-pen.png') })
  await viewer.locator('input[type=file]').setInputFiles(path.join(FIXTURES, 'sample-v5.kdr'))
  await viewer.waitForTimeout(400)
  check('version 5 の kdr も開ける', (await viewer.locator('.app-message').count()) === 0)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
