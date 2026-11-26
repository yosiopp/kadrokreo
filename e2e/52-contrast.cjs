const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// viewer のインスペクトで、テキストを選ぶと背景とのコントラスト比と基準（AA / AAA）が出ることを確かめる。
// 値を押すとコピーできることと、ブラウザに何も残さないことも見る
const { OUT, VIEWER, check, finish, crashed, watchErrors } = require('./harness.cjs')

const gradient = JSON.stringify([{
  type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, opacity: 1, visible: true, blendMode: 'normal',
  stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }],
}])
const sourcePath = path.join(OUT, 'contrast.kdr')
execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'),
  ...('new Contrast + add rect --name White --width 600 --height 400 fill=#ffffff' +
    ' + add rect --name Shade --x 20 --y 20 --width 260 --height 100 fill=#000000 opacity=0.5' +
    ' + add text --name OnShade --x 40 --y 40 --text 半透明の上 fill=#ffffff fontSize=16' +
    ' + add text --name Gray --x 320 --y 40 --text 灰色の文字 fill=#777777 fontSize=16' +
    ' + add text --name Large --x 320 --y 80 --text 大きな文字 fill=#777777 fontSize=24' +
    ' + add rect --name Ramp --x 20 --y 160 --width 260 --height 100 fills=' + gradient +
    ' + add text --name OnRamp --x 40 --y 190 --text グラデーションの上 fill=#000000 fontSize=16' +
    ' + add rect --name Half --x 360 --y 160 --width 100 --height 100 fill=#000000' +
    ' + add text --name Across --x 320 --y 190 --text 半分だけ重なる fill=#ff0000 fontSize=16').split(' '),
  '-o', sourcePath,
], { encoding: 'utf8' })

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const viewer = await context.newPage()
  const errors = []
  watchErrors(viewer, errors)
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(sourcePath)
  await viewer.waitForSelector('.inspect-layer:has(.layer-name:text-is("Across"))')

  const panel = viewer.locator('.inspect-panel')
  const rows = () => panel.locator('section[aria-label="コントラスト"] .inspect-row').evaluateAll((list) =>
    list.map((r) => `${r.querySelector('dt').textContent}=${r.querySelector('.inspect-value').textContent}`))
  const select = async (name) => {
    await viewer.locator(`.inspect-layer:has(.layer-name:text-is("${name}"))`).click()
    await viewer.waitForTimeout(100)
  }

  // 白の上に黒 50% → #808080。白の文字との比は 3.95
  await select('OnShade')
  const onShade = await rows()
  check('半透明の背景は下の白と合成した色で比べる', JSON.stringify(onShade) === JSON.stringify([
    '文字=#FFFFFF',
    '背景=#808080',
    '比=3.94:1',
    '文字の大きさ=ふつうの文字',
    'AA=満たさない（4.5:1 以上）',
    'AAA=満たさない（7:1 以上）',
  ]), JSON.stringify(onShade))
  await viewer.locator('.canvas-view').screenshot({ path: path.join(OUT, 'contrast-shade.png') })

  await select('Gray')
  const gray = await rows()
  check('#777777 と白は 4.47:1 で AA を満たさない', gray.includes('比=4.47:1') && gray.includes('AA=満たさない（4.5:1 以上）'), JSON.stringify(gray))
  await select('Large')
  const large = await rows()
  check('24px の大きな文字なら同じ色で AA（3:1）を満たす', large.includes('文字の大きさ=大きな文字（24px 以上か、太字で 18.66px 以上）') &&
    large.includes('AA=満たす（3:1 以上）') && large.includes('AAA=満たさない（4.5:1 以上）'), JSON.stringify(large))

  await select('OnRamp')
  const ramp = await rows()
  check('グラデーションの上では、いちばん低い比で判定する', ramp.includes('比=いちばん低い所で 1.00:1（高い所で 21.00:1）') &&
    ramp.includes('AA=満たさない（4.5:1 以上）') && ramp.some((row) => row.startsWith('求め方=')), JSON.stringify(ramp))

  await select('Across')
  const across = await rows()
  check('一部だけ重なる図形があると求められない', JSON.stringify(across) === JSON.stringify(['比=求められない（「Half」の塗りが一部だけ重なる）']), JSON.stringify(across))

  // 長方形にはコントラストの見出しを出さない
  await select('White')
  check('テキストでなければ出さない', (await panel.locator('section[aria-label="コントラスト"]').count()) === 0)

  // 値を押すとコピーされる（ほかの欄と同じ）
  await select('Gray')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await panel.locator('section[aria-label="コントラスト"] .inspect-row:has(dt:text-is("比")) .inspect-value').click()
  const copied = await viewer.evaluate(() => navigator.clipboard.readText().catch(() => null))
  check('比の値を押すとコピーされる', copied === null || copied === '4.47:1', String(copied))

  const stored = await viewer.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))
  check('ブラウザに何も残さない', stored.local === 0 && stored.session === 0, JSON.stringify(stored))
  fs.rmSync(sourcePath, { force: true })
  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
