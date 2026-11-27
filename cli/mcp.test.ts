import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { decodeKdr } from '../src/document/kdr.ts'
import { McpServer, TOOLS } from './mcp.ts'

// kdr mcp。McpServer にメモリ上のファイルを渡し、JSON-RPC の行を流して確かめる。最後に本物のプロセスも 1 度起動する

type Reply = { jsonrpc: '2.0'; id: number | string | null; result?: any; error?: { code: number; message: string } }

function harness() {
  const fs = new Map<string, Uint8Array>()
  const server = new McpServer(
    {
      readFile: async (path) => {
        const data = fs.get(path)
        if (!data) throw new Error(`ENOENT: ${path}`)
        return new Uint8Array(data)
      },
      writeFile: async (path, data) => {
        fs.set(path, data)
      },
    },
    '9.9.9',
  )
  let id = 0
  const send = async (method: string, params?: unknown): Promise<Reply> => {
    const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }))
    return JSON.parse(line!)
  }
  /** 道具を呼んで、結果（content と isError）を返す */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await send('tools/call', { name, arguments: args })
    expect(reply.error).toBeUndefined()
    const result = reply.result as { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }
    const text = result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n')
    return { ...result, text }
  }
  return { fs, server, send, call, doc: (path: string) => decodeKdr(new Blob([new Uint8Array(fs.get(path)!)])) }
}

describe('kdr mcp', () => {
  it('initialize はクライアントの版が分かればその版、分からなければ新しい版で応える', async () => {
    const { send } = harness()
    const known = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(known.result.protocolVersion).toBe('2025-06-18')
    expect(known.result.capabilities).toEqual({ tools: { listChanged: false } })
    expect(known.result.serverInfo).toMatchObject({ name: 'kdr', version: '9.9.9' })
    const unknown = await send('initialize', { protocolVersion: '1999-01-01' })
    expect(unknown.result.protocolVersion).toBe('2025-11-25')
  })

  it('通知には応えず、知らないメソッド・読めない行・JSON-RPC でないものはエラーで応える', async () => {
    const { server, send } = harness()
    expect(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeNull()
    expect(await server.handleLine('')).toBeNull()
    expect((await send('ping')).result).toEqual({})
    expect((await send('resources/list')).error?.code).toBe(-32601)
    expect(JSON.parse((await server.handleLine('{oops'))!).error.code).toBe(-32700)
    expect(JSON.parse((await server.handleLine('{"id":3,"method":"ping"}'))!)).toMatchObject({ id: 3, error: { code: -32600 } })
    expect((await send('tools/call', { name: 'nothing' })).error?.code).toBe(-32602)
    // クライアントからの応答は捨てる
    expect(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))).toBeNull()
    // まとめて送った要求には、まとめて応える
    const batch = JSON.parse((await server.handleLine(JSON.stringify([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }])))!)
    expect(batch).toEqual([{ jsonrpc: '2.0', id: 'a', result: {} }])
  })

  it('tools/list は 5 つの道具を出す', async () => {
    const { send } = harness()
    const { tools } = (await send('tools/list')).result
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(['open', 'run', 'png', 'save', 'help'])
    expect(tools).toEqual(TOOLS)
  })

  it('new で作り、run で重ねた変更をメモリに持ち、save で書き出し、open で開き直せる', async () => {
    const { fs, call, doc } = harness()
    const made = await call('run', { args: ['new', 'Demo', '+', 'add', 'rect', '--name', 'Box', '--id', 'box', '--width', '40', '--height', '30'] })
    expect(made.isError).toBeUndefined()
    expect(made.text).toContain('保存先なし')
    expect(made.text).toContain('保存していない変更あり')
    await call('run', { args: ['set', 'Box', 'fill=#ff0000'] })
    const got = await call('run', { args: ['get', 'box', 'fills'] })
    expect(got.text).toContain('#ff0000')

    // 保存先がないうちは path が要る
    expect((await call('save')).isError).toBe(true)
    expect((await call('save', { path: 'demo.kdr' })).text).toContain('demo.kdr に保存しました')
    expect(Object.values((await doc('demo.kdr')).pages[0].nodes).map((node) => node.name)).toEqual(['Box'])
    expect((await call('run', { args: ['ls'] })).text).toContain('demo.kdr・ページ「Page 1」・変更なし')

    // 開き直して変え、path を省いた save は開いたファイルへ
    await call('run', { args: ['set', 'box', 'opacity=0.5'] })
    const reopened = await call('open', { path: 'demo.kdr' })
    expect(reopened.text).toContain('「Demo」、ページ 1、ノード 1 個')
    expect(reopened.text).toContain('保存していない変更は捨てました')
    await call('run', { args: ['set', 'box', 'opacity=0.25'] })
    await call('save')
    expect((await doc('demo.kdr')).pages[0].nodes.box.opacity).toBe(0.25)
    expect(fs.size).toBe(1)
  })

  it('途中で失敗した run は、その呼び出しの変更をすべて捨てる。ページと @ は呼び出しをまたいで覚える', async () => {
    const { call } = harness()
    await call('run', { args: ['new', '+', 'page-add', 'Second', '+', 'add', 'rect', '--name', 'A'] })
    const failed = await call('run', { args: ['set', 'A', 'opacity=0.5', '+', 'set', 'A', 'fill=red'] })
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('kdr: set:')
    expect(failed.text).toContain('終了コード 1')
    // いまのページは Second のまま、@ は A のまま
    const after = await call('run', { args: ['get', '@', 'opacity'] })
    expect(after.text).toMatch(/^1\n/)
    expect(after.text).toContain('ページ「Second」')
  })

  it('作り直しの new・build は、いまのページと @ を持ち越さず、保存先を消す。ヘルプだけなら何も変えない', async () => {
    const { call } = harness()
    const markup = (name: string) => `<kdr><page name="One"/><page name="Two"><rect name="${name}" width="10" height="10"/></page></kdr>`
    await call('run', { args: ['build', '-'], stdin: markup('A') })
    await call('save', { path: 'a.kdr' })
    expect((await call('run', { args: ['new', '--help'] })).text).toContain('変更なし')
    await call('run', { args: ['page', 'Two', '+', 'add', 'rect', '--name', 'B'] })
    const rebuilt = await call('run', { args: ['build', '-'], stdin: markup('C') })
    expect(rebuilt.text).toContain('［保存先なし・ページ「One」・保存していない変更あり］')
    expect((await call('run', { args: ['get', '@'] })).text).toContain('直前に作ったノードがありません')
  })

  it('lint が見つけても、同じ呼び出しのほかの知らせがあっても失敗にしない。失敗した new は前のドキュメントと保存先を残す', async () => {
    const { fs, call } = harness()
    await call('run', { args: ['new', 'Old', '+', 'add', 'rect', '--name', 'Old'] })
    await call('save', { path: 'a.kdr' })
    const found = await call('run', { args: ['add', 'rect', '+', 'replace', 'Old', 'Older', '+', 'lint', '--only', 'default-name'] })
    expect(found.isError).toBeUndefined()
    expect(found.text).toContain('default-name')
    const failed = await call('run', { args: ['new', 'X', '+', 'set', 'nothing', 'opacity=1'] })
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('a.kdr・')
    await call('save')
    expect(fs.has('a.kdr')).toBe(true)
    expect((await call('run', { args: ['info'] })).text).toContain('name: Old')
  })

  it('開いていない・-f などを使った・args が配列でないときはエラーの結果を返す', async () => {
    const { call } = harness()
    expect((await call('run', { args: ['ls'] })).text).toContain('開いているドキュメントがありません')
    expect((await call('open', { path: 'none.kdr' })).isError).toBe(true)
    await call('run', { args: ['new'] })
    const withFile = await call('run', { args: ['-f', 'a.kdr', 'ls'] })
    expect(withFile.isError).toBe(true)
    expect(withFile.text).toContain('-f・-o・-w は使えません')
    expect((await call('run', { args: 'ls' })).isError).toBe(true)
    expect((await call('run', { args: ['mcp'] })).isError).toBe(true)
  })

  it('stdin のマークアップを build - に渡せる。lint の「見つけた」は失敗にしない', async () => {
    const { call } = harness()
    const built = await call('run', { args: ['build', '-'], stdin: '<kdr><page name="P"><frame name="Card" width="100" height="50"><rect width="10" height="10"/></frame></page></kdr>' })
    expect(built.isError).toBeUndefined()
    expect((await call('run', { args: ['ls'] })).text).toContain('"Card"')
    const linted = await call('run', { args: ['lint', '--only', 'default-name'] })
    expect(linted.isError).toBeUndefined()
    expect(linted.text).toContain('default-name')
    expect((await call('run', { args: ['build', '-'] })).text).toContain('run の stdin で渡してください')
  })

  it('png は画像として返す', async () => {
    const { call } = harness()
    await call('run', { args: ['new', '+', 'add', 'rect', '--name', 'Box', '--width', '20', '--height', '10', 'fill=#00ff00'] })
    const result = await call('png', { nodes: ['Box'], scale: 2 })
    expect(result.isError).toBeUndefined()
    const image = result.content.find((item) => item.type === 'image')!
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' })
    const bytes = Buffer.from((image as { data: string }).data, 'base64')
    expect([...bytes.subarray(1, 4)].map((byte) => String.fromCharCode(byte)).join('')).toBe('PNG')
    expect(bytes.readUInt32BE(16)).toBe(40)
    expect(bytes.readUInt32BE(20)).toBe(20)
    expect((await call('png', { nodes: ['Nothing'] })).isError).toBe(true)
  })

  it('help は全体のリファレンスか、1 つのコマンドの説明を返す', async () => {
    const { call } = harness()
    expect((await call('help')).text).toContain('## MCP のサーバー（kdr mcp）')
    expect((await call('help', { command: 'set' })).text).toMatch(/^kdr set /)
    expect((await call('help', { command: 'nothing' })).isError).toBe(true)
  })

  it('kdr mcp のプロセスは、標準出力に JSON-RPC の応答だけを 1 行ずつ出す', async () => {
    const entry = fileURLToPath(new URL('./kadrokreo.ts', import.meta.url))
    const child = spawn(process.execPath, [entry, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run', arguments: { args: ['new', 'X', '+', 'info'] } } },
    ]
    child.stdin.end(lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
    const code = await new Promise((resolve) => child.on('close', resolve))
    expect(code).toBe(0)
    const replies = stdout.trimEnd().split('\n').map((line) => JSON.parse(line))
    expect(replies.map((reply) => reply.id)).toEqual([1, 2])
    expect(replies[1].result.content[0].text).toContain('X')
  }, 20_000)
})
