import { type Command } from './commands/common.ts'
import { component, detach, instance } from './commands/components.ts'
import { add, dup, svg } from './commands/create.ts'
import { mv, order, rm, set } from './commands/edit.ts'
import { autoLayout, layoutFill, wrap } from './commands/layout.ts'
import { css, html, json } from './commands/output.ts'
import { docName, newDocument, page, pageAdd, pageRename, pageRm } from './commands/pages.ts'
import { bounds, componentList, find, get, info, ls } from './commands/query.ts'

export type { Command } from './commands/common.ts'

// コマンドの中身は commands/ に種類ごとに置く。ここに並べた順がヘルプの順になる
const commands: Command[] = [
  // source
  newDocument,
  // query
  info,
  ls,
  get,
  find,
  bounds,
  css,
  html,
  json,
  componentList,
  // nav
  page,
  // edit: ドキュメントとページ
  docName,
  pageAdd,
  pageRename,
  pageRm,
  // edit: ノード
  add,
  svg,
  set,
  rm,
  mv,
  order,
  dup,
  // edit: オートレイアウト
  autoLayout,
  wrap,
  layoutFill,
  // edit: コンポーネント
  component,
  detach,
  instance,
]

export const COMMANDS: ReadonlyMap<string, Command> = new Map(commands.map((command) => [command.name, command]))
