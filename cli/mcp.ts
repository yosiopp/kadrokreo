import { createInterface } from 'node:readline'
import { decodeKdr } from '../src/document/kdr.ts'
import type { DesignDocument } from '../src/document/types.ts'
import { encodeKdr } from '../src/editor/exportKdr.ts'
import { UsageError } from './args.ts'
import { docs, help } from './help.ts'
import { type Held, type IO, run } from './run.ts'
import { Session } from './session.ts'

// kdr mcp: AI エージェント向けの MCP（Model Context Protocol）のサーバー。
// 口は標準入出力だけ（1 行に 1 つの JSON-RPC 2.0 のメッセージ）。ネットワークの口は開かない。標準出力には JSON-RPC 以外を出さない。
// 依存を増やさないため、JSON-RPC と MCP の必要な分（initialize・ping・tools/list・tools/call）を自前で書いている。
// 開いたドキュメントはメモリに持ち、run の道具で CLI のコマンドを重ね、save で kdr に書き出す。

/** 応えられる版（新しい順）。クライアントの版がこの中にあればそれを、なければ先頭を返す */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export type ServerFiles = Pick<IO, 'readFile' | 'writeFile'>

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }
type ToolResult = { content: Content[]; isError?: boolean }
type Tool = {
  name: string
  title: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, Json>; required?: string[]; additionalProperties: false }
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: false }
}

class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

const strings = { type: 'array', items: { type: 'string' } } as const

export const TOOLS: Tool[] = [
  {
    name: 'open',
    title: 'kdr を開く',
    description:
      'kdr ファイルを読み込んで、開いているドキュメントにする（それまでの保存していない変更は捨てる）。' +
      'パスはサーバーの今のディレクトリ（Docker なら /work）からの相対パス。新しく作るなら open でなく run で new・build',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '開く kdr のパス' } }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'run',
    title: 'kdr のコマンドを実行する',
    description:
      'kdr のコマンド（ls・get・find・set・add・build・css・lint …。書き方は help の道具）を、開いているドキュメントに対して実行し、文字の出力を返す。' +
      'args はコマンドラインの引数の配列（例 ["set", "Title", "text=ホーム", "+", "get", "Title"]）。"+" でつなぐと 1 回で順に実行し、途中で失敗するとその呼び出しの変更はすべて捨てる。' +
      'new・build で始めると新しいドキュメントを作る。変更はメモリに持つだけなので、残すには save。-f・-o・-w は使えない。' +
      'stdin は build - / place - に渡すマークアップ。見た目は png の道具で画像として受け取れる',
    inputSchema: {
      type: 'object',
      properties: {
        args: { ...strings, description: 'コマンドと引数（"kdr" は含めない）' },
        stdin: { type: 'string', description: '標準入力として渡す文字（build - / place - のマークアップ）' },
      },
      required: ['args'],
      additionalProperties: false,
    },
    // png --to・svg-out などはファイルを書くことがあるので、destructiveHint は既定（true）のまま
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'png',
    title: 'PNG で見る',
    description:
      'kdr png と同じ絵（viewer の PNG 書き出しと同じ）を、ファイルに書かずに画像として返す。nodes を省くと今のページ全体、指定するとそれらを囲む範囲。' +
      'ノードの指定は id・レイヤー名・「親/子」の道筋・@（直前に作ったノード）',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: { ...strings, description: '描くノード（省くとページ全体）' },
        scale: { type: 'number', description: '倍率（既定 1）', exclusiveMinimum: 0 },
        background: { type: 'string', description: '背景の色 #rrggbb（既定は透明）' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'save',
    title: 'kdr を保存する',
    description: '開いているドキュメントを kdr ファイルに書き出す。path を省くと、開いた（前に保存した）ファイルへ上書きする',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '書き出す kdr のパス' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'help',
    title: 'kdr の説明',
    description: 'command を省くと、全体のリファレンス（kdr docs と同じ Markdown。ノードの指定・出力の形・すべてのコマンドと例）を返す。指定するとそのコマンドの説明と例',
    inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'コマンドの名前（set・build など）' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
]

const INSTRUCTIONS =
  'kadrokreo のデザインファイル（kdr）を作る・調べる・編集する・PNG で見るためのサーバー。' +
  '流れ: open で開く（新しく作るなら run で new / build）→ run で kdr のコマンドを実行（調べる ls・get・find、変える set・add・build・place など）→ png で見た目を確かめる → save で保存。' +
  '変更はメモリにあり、save するまでファイルは変わらない。コマンドの書き方は help（全体）か help の command。'

export class McpServer {
  readonly #files: ServerFiles
  readonly #version: string
  readonly #held: Held = { session: null }
  /** 開いた（最後に保存した）ファイル。save の既定の書き出し先 */
  #path: string | null = null
  /** 開いた・保存したときのドキュメント。今のものと参照が違えば、保存していない変更がある */
  #saved: DesignDocument | null = null

  constructor(files: ServerFiles, version: string) {
    this.#files = files
    this.#version = version
  }

  /** 1 行（1 つのメッセージ）を処理して、返す行を返す（通知や応答なら null） */
  async handleLine(line: string): Promise<string | null> {
    if (line.trim() === '') return null
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return JSON.stringify(failure(null, new RpcError(-32700, 'JSON として読めません')))
    }
    if (Array.isArray(message)) {
      if (message.length === 0) return JSON.stringify(failure(null, new RpcError(-32600, '空の配列です')))
      const replies = []
      for (const item of message) {
        const reply = await this.#handle(item)
        if (reply !== null) replies.push(reply)
      }
      return replies.length > 0 ? JSON.stringify(replies) : null
    }
    const reply = await this.#handle(message)
    return reply === null ? null : JSON.stringify(reply)
  }

  async #handle(message: unknown): Promise<object | null> {
    if (!isObject(message) || message.jsonrpc !== '2.0') return failure(idOf(message), new RpcError(-32600, 'JSON-RPC 2.0 の要求ではありません'))
    // クライアントからの応答（このサーバーは要求を送らないので、来ても捨てる）
    if (typeof message.method !== 'string') return null
    const notification = !('id' in message)
    const id = idOf(message)
    try {
      const result = await this.#dispatch(message.method, message.params)
      return notification ? null : { jsonrpc: '2.0', id, result }
    } catch (error) {
      if (notification) return null
      return failure(id, error instanceof RpcError ? error : new RpcError(-32603, error instanceof Error ? error.message : String(error)))
    }
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = isObject(params) ? params.protocolVersion : undefined
        return {
          protocolVersion: typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kdr', title: 'kadrokreo kdr', version: this.#version },
          instructions: INSTRUCTIONS,
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: TOOLS }
      case 'tools/call': {
        if (!isObject(params) || typeof params.name !== 'string') throw new RpcError(-32602, 'name がありません')
        const args = params.arguments ?? {}
        if (!isObject(args)) throw new RpcError(-32602, 'arguments はオブジェクトです')
        const tool = TOOLS.find((candidate) => candidate.name === params.name)
        if (!tool) throw new RpcError(-32602, `不明な道具です: ${params.name}`)
        return this.#call(tool.name, args)
      }
      default:
        if (method.startsWith('notifications/')) return null
        throw new RpcError(-32601, `対応していないメソッドです: ${method}`)
    }
  }

  /** 道具を呼ぶ。道具の中の失敗は JSON-RPC のエラーにせず、isError の結果として返す（エージェントが読んで直せるように） */
  async #call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'open':
          return await this.#open(args)
        case 'run':
          return await this.#run(args)
        case 'png':
          return await this.#png(args)
        case 'save':
          return await this.#save(args)
        default:
          return this.#help(args)
      }
    } catch (error) {
      return { content: [text(`kdr: ${error instanceof Error ? error.message : String(error)}`)], isError: true }
    }
  }

  async #open(args: Record<string, unknown>): Promise<ToolResult> {
    const path = stringArg(args, 'path', true)
    const discarded = this.#dirty()
    const document = await decodeKdr(new Blob([await this.#files.readFile(path)]))
    this.#held.session = new Session(document)
    this.#path = path
    this.#saved = this.#held.session.document
    const nodes = document.pages.reduce((sum, page) => sum + Object.keys(page.nodes).length, 0)
    const lines = [`${path} を開きました（「${document.name}」、ページ ${document.pages.length}、ノード ${nodes} 個）`]
    if (discarded) lines.push('前に開いていたドキュメントの、保存していない変更は捨てました')
    return { content: [text(lines.join('\n'))] }
  }

  async #run(args: Record<string, unknown>): Promise<ToolResult> {
    const argv = args.args
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => typeof arg === 'string')) {
      throw new UsageError('args はコマンドと引数の文字列の配列です（例 ["ls"]）')
    }
    const stdin = stringArg(args, 'stdin', false)
    const before = this.#held.session
    const result = await this.#execute(argv, stdin)
    // new・build で作り直したら新しいドキュメント（保存先はまだない）
    if (this.#held.session !== before) {
      this.#path = null
      this.#saved = null
    }
    return this.#withStatus(result)
  }

  async #png(args: Record<string, unknown>): Promise<ToolResult> {
    const nodes = args.nodes ?? []
    if (!Array.isArray(nodes) || !nodes.every((node) => typeof node === 'string')) throw new UsageError('nodes はノードの指定の文字列の配列です')
    const argv = ['png', ...nodes, '--to', '-']
    if (args.scale !== undefined) {
      if (typeof args.scale !== 'number') throw new UsageError('scale は数です')
      argv.push('--scale', String(args.scale))
    }
    const background = stringArg(args, 'background', false)
    if (background !== undefined) argv.push('--background', background)
    return this.#execute(argv, undefined)
  }

  async #save(args: Record<string, unknown>): Promise<ToolResult> {
    const session = this.#held.session
    if (session === null) throw new UsageError('開いているドキュメントがありません')
    const path = stringArg(args, 'path', false) ?? this.#path
    if (path === null) throw new UsageError('path を指定してください（new・build で作ったドキュメントには、まだ保存先がありません）')
    const document = session.document
    await this.#files.writeFile(path, new Uint8Array(await (await encodeKdr(document)).arrayBuffer()))
    this.#path = path
    this.#saved = document
    return { content: [text(`${path} に保存しました`)] }
  }

  #help(args: Record<string, unknown>): ToolResult {
    const command = stringArg(args, 'command', false)
    return { content: [text(command === undefined ? docs() : help(command))] }
  }

  /** CLI の run を、開いているドキュメントに対して動かす。文字の出力は文字、PNG は画像にする */
  async #execute(argv: readonly string[], stdin: string | undefined): Promise<ToolResult> {
    const content: Content[] = []
    let out = ''
    let err = ''
    const io: IO = {
      readFile: this.#files.readFile,
      writeFile: this.#files.writeFile,
      readStdin: async () => {
        if (stdin === undefined) throw new UsageError('標準入力（-）の中身は、run の stdin で渡してください')
        return new TextEncoder().encode(stdin)
      },
      // 端末ではないことにして、stdin がなければ readStdin で「stdin で渡す」ように知らせる
      stdinIsTTY: false,
      stdoutIsTTY: false,
      stdout: (data) => {
        if (typeof data === 'string') out += data
        else if (PNG_SIGNATURE.every((byte, i) => data[i] === byte)) content.push({ type: 'image', data: Buffer.from(data).toString('base64'), mimeType: 'image/png' })
        else out += new TextDecoder().decode(data)
      },
      stderr: (message) => {
        err += message
      },
    }
    const code = await run(argv, io, this.#held)
    if (out !== '') content.unshift(text(out))
    if (err !== '') content.push(text(err))
    // diff・lint は「見つけた」を終了コード 1 で知らせる。最後まで通ったなら失敗にしない
    const failed = code !== 0 && !(code === 1 && this.#held.ok === true)
    if (failed) content.push(text(`終了コード ${code}`))
    if (content.length === 0) content.push(text('（出力なし）'))
    return failed ? { content, isError: true } : { content }
  }

  #dirty(): boolean {
    const session = this.#held.session
    return session !== null && session.document !== this.#saved
  }

  /** run の結果に、開いているドキュメントと保存の状態を 1 行足す */
  #withStatus(result: ToolResult): ToolResult {
    const session = this.#held.session
    if (session === null) return result
    const where = this.#path === null ? '保存先なし' : this.#path
    const state = this.#dirty() ? '保存していない変更あり' : '変更なし'
    return { ...result, content: [...result.content, text(`［${where}・ページ「${session.page.name}」・${state}］`)] }
  }
}

/** 標準入出力で動かす。要求は来た順に 1 つずつ処理する */
export async function serve(files: ServerFiles, version: string): Promise<void> {
  const server = new McpServer(files, version)
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let queue = Promise.resolve()
  // Docker では PID 1 になり、SIGTERM の既定の動き（終わる）が効かないので、自分で終わる
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0))
  process.stderr.write('kdr: MCP のサーバーを標準入出力で起動しました\n')
  for await (const line of lines) {
    queue = queue.then(async () => {
      const reply = await server.handleLine(line)
      if (reply !== null) process.stdout.write(reply + '\n')
    })
  }
  await queue
}

function text(value: string): Content {
  return { type: 'text', text: value }
}

function failure(id: unknown, error: RpcError) {
  return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message } }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function idOf(message: unknown): string | number | null {
  const id = isObject(message) ? message.id : null
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

function stringArg(args: Record<string, unknown>, name: string, required: true): string
function stringArg(args: Record<string, unknown>, name: string, required: false): string | undefined
function stringArg(args: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const value = args[name]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value === '') throw new UsageError(`${name} は文字列です`)
  return value
}
