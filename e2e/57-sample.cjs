const { chromium } = require('playwright-core')
const fs = require('fs')
const path = require('path')

// viewer の最初の画面の「サンプルを開く」: ビルドに入れたサンプルの kdr（docs/examples/sample.kdr）を、同じ配信元から読んで開く。
// 配布するイメージ（CSP は default-src 'self'）を相手にしても通ること（data: URL や外部への通信になっていれば、ここで落ちる）。
// 開いたあとは見出しから消え、別の kdr を開けばそちらに替わる。editor の画面には出ない
const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const errors = []
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  const requests = []
  const fetched = []
  viewer.on('request', (request) => {
    requests.push(request.url())
    if (request.resourceType() === 'fetch') fetched.push(request.url())
  })
  await viewer.goto(VIEWER)
  const sampleButton = viewer.locator('.empty-state button:text-is("サンプルを開く")')
  await sampleButton.waitFor()
  check('何も開いていない画面に「サンプルを開く」がある', (await sampleButton.count()) === 1)

  await sampleButton.click()
  await viewer.waitForSelector('.canvas-view canvas')
  check('サンプルのドキュメント名が出る', (await viewer.locator('.document-name').textContent()) === 'kadrokreo サンプル')
  const pages = await viewer.locator('section[aria-label="ページ"] .list-button').allTextContents()
  check('サンプルのページが一覧に出る', pages.includes('タスクの画面'), pages.join())
  check('フレームの一覧に画面が出る', (await viewer.locator('section[aria-label="フレーム"] .list-button:text-is("Screen")').count()) === 1)
  check('開いたあとは「サンプルを開く」が消える', (await viewer.locator('.empty-state').count()) === 0)
  const origin = new URL(VIEWER).origin
  const outside = requests.filter((url) => !url.startsWith(origin) && !url.startsWith('blob:') && !url.startsWith('data:'))
  check('外部へは通信しない', outside.length === 0, outside.join(' '))
  const sampleRequest = fetched.find((url) => /sample[^/]*\.kdr/.test(url))
  check('サンプルは同じ配信元のファイルとして読む', !!sampleRequest && sampleRequest.startsWith(origin), sampleRequest)
  // 配信しているサンプルは docs/examples/sample.kdr と同じ中身
  const served = await viewer.evaluate(async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], sampleRequest)
  check('配信しているサンプルは docs/examples/sample.kdr と同じ', Buffer.from(served).equals(fs.readFileSync(path.join(__dirname, '../docs/examples/sample.kdr'))))
  await viewer.screenshot({ path: path.join(OUT, '57-sample.png') })

  // 選んだ場所はハッシュに書かれる。そのまま別の kdr を開くと、そちらに替わる（ハッシュは開いた kdr に当てはめるので、
  // その kdr に無いページ・ノードを指していれば、最初のページを何も選ばずに出す）
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Heading"))').first().click()
  await viewer.waitForFunction(() => window.location.hash.length > 1)
  check('サンプルの中を選べる（ハッシュに書かれる）', (await viewer.locator('.layer-row[data-selected="true"]').count()) === 1)
  const other = path.join(OUT, '57-other.kdr')
  const otherXml = path.join(OUT, '57-other.xml')
  fs.writeFileSync(otherXml, '<kdr name="別の kdr"><page name="別のページ"><frame name="別の画面" width="100" height="100" fill="#ffffff"/></page></kdr>')
  require('child_process').execFileSync('node', [path.join(__dirname, '../cli/kadrokreo.ts'), 'build', otherXml, '-o', other])
  await viewer.locator('input[type=file]').setInputFiles(other)
  await viewer.waitForFunction(() => document.querySelector('.document-name')?.textContent === '別の kdr')
  const otherPages = await viewer.locator('section[aria-label="ページ"] .list-button').allTextContents()
  check('別の kdr を開くとそちらに替わる', otherPages.join() === '別のページ', otherPages.join())
  check('開いた kdr に無いノードの選択は残らない', (await viewer.locator('.inspect-layer[aria-selected="true"], .layer-row[data-selected="true"]').count()) === 0)

  // サンプルの読み込みを待つあいだに別の kdr を開いたら、あとから届いたサンプルで替えない
  const slow = await context.newPage()
  watchErrors(slow, errors, 'slow: ')
  let release
  const released = new Promise((resolve) => (release = resolve))
  await slow.route(/sample[^/]*\.kdr/, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue()
    await released
    await route.continue()
  })
  await slow.goto(VIEWER)
  const sampleRequested = slow.waitForRequest((request) => request.resourceType() === 'fetch' && /sample[^/]*\.kdr/.test(request.url()))
  await slow.locator('.empty-state button:text-is("サンプルを開く")').click()
  await sampleRequested
  await slow.locator('input[type=file]').setInputFiles(other)
  await slow.waitForFunction(() => document.querySelector('.document-name')?.textContent === '別の kdr')
  const sampleResponse = slow.waitForResponse((response) => /sample[^/]*\.kdr/.test(response.url()) && response.request().resourceType() === 'fetch')
  release()
  await sampleResponse
  await slow.waitForTimeout(300)
  check('サンプルの読み込み中に開いた kdr は、あとから届いたサンプルで替わらない', (await slow.locator('.document-name').textContent()) === '別の kdr', await slow.locator('.document-name').textContent())

  // editor の画面には出ない
  const editor = await context.newPage()
  watchErrors(editor, errors, 'editor: ')
  await editor.goto(EDITOR)
  await editor.waitForSelector('.canvas-view canvas')
  check('editor に「サンプルを開く」はない', (await editor.locator('button:text-is("サンプルを開く")').count()) === 0)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
