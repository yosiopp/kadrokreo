import type { Point } from '../../src/document/geometry.ts'
import { type Step, UsageError } from '../args.ts'
import type { Session } from '../session.ts'

/**
 * source: 新しいドキュメントを作る（先頭にだけ置ける）
 * edit: ドキュメントを変える（最後に kdr を書き出す）
 * query: 標準出力に文字を出す
 * nav: どちらでもない（いまのページを変えるなど）
 * export: ファイルに書き出す（png。--to - なら標準出力なので query と同じ扱い）
 */
export type Kind = 'source' | 'edit' | 'query' | 'nav' | 'export'

/** コマンドを実行するときに使えるもの */
export type Context = {
  session: Session
  print: (text: string) => void
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>
  writeFile: (path: string, data: Uint8Array) => Promise<void>
  /** バイト列を標準出力へ（png --to -）。文字の出力と一緒には使えない（checkPlan が止める） */
  stdout: (data: Uint8Array) => void
  /** 標準エラーへの知らせ（kdr や query の出力を汚さない） */
  warn: (text: string) => void
  /** ファイルを読む。'-' は標準入力（standalone のコマンドが、入力の kdr を自分で読むときに使う） */
  readInput: (path: string) => Promise<Uint8Array<ArrayBuffer>>
  /** 標準入力が端末か（standalone のコマンドが - を読む前に確かめる） */
  stdinIsTTY: boolean
  /** 見つけたものがあったことを知らせる（reports のコマンド。終了コードが 1 になる） */
  report: () => void
}

export type Command = {
  name: string
  kind: Kind
  usage: string
  summary: string
  /** 値を取らない --オプション */
  flags?: readonly string[]
  /** 「名前=値」を受け付ける。'any' なら名前に英字以外も使える（バリアントのプロパティ名） */
  assignments?: true | 'any'
  /** 入力の kdr を -f でなく引数で受け取る（diff）。ほかのコマンドとも -f / -o / -w ともつなげない。ctx.session は使えない */
  standalone?: true
  /**
   * 見つけたもの（違い・検査の結果）を終了コード 1 で知らせる（diff・lint）。
   * 見つけたものと失敗を見分けられるよう、このコマンドを含む実行の失敗は、ふだん 1 のもの（kdr が読めないなど）も 2 にする
   */
  reports?: true
  run: (ctx: Context, step: Step) => void | Promise<void>
}

// ── 引数の読み取り ──

export function option(step: Step, key: string): string | undefined {
  const value = step.options.get(key)
  if (value === true) throw new UsageError(`${step.name}: --${key} に値を指定してください`)
  return value
}

export function flag(step: Step, key: string): boolean {
  return step.options.has(key)
}

export function numberOption(step: Step, key: string): number | undefined {
  const raw = option(step, key)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(value)) throw new UsageError(`${step.name}: --${key} は数値です: ${raw}`)
  return value
}

export function point(raw: string, label: string): Point {
  const parts = raw.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) {
    throw new UsageError(`${label} は「x,y」の形で指定してください: ${raw}`)
  }
  return { x: parts[0], y: parts[1] }
}

export function positional(step: Step, index: number, label: string): string {
  const value = step.positionals[index]
  if (value === undefined) throw new UsageError(`${step.name}: ${label}を指定してください`)
  return value
}

/** 想定していない引数やオプションを黙って無視しない */
export function checkStep(step: Step, allowed: { options?: readonly string[]; positionals?: number; assignments?: boolean }): void {
  for (const key of step.options.keys()) {
    if (!allowed.options?.includes(key)) throw new UsageError(`${step.name}: 不明なオプションです: --${key}`)
  }
  if (allowed.positionals !== undefined && step.positionals.length > allowed.positionals) {
    throw new UsageError(`${step.name}: 余分な引数があります: ${step.positionals.slice(allowed.positionals).join(' ')}`)
  }
  if (!allowed.assignments && step.assignments.length > 0) {
    throw new UsageError(`${step.name}: 「名前=値」は指定できません: ${step.assignments[0].join('=')}`)
  }
}

export const round = (value: number) => Math.round(value * 100) / 100
