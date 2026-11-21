import { type Command } from './commands/common.ts'
import { align, distribute, rotate } from './commands/arrange.ts'
import {
  component,
  describe_,
  detach,
  instance,
  overridePush,
  overrideReset,
  prop,
  propAdd,
  swap,
  variant,
  variantAdd,
} from './commands/components.ts'
import { add, dup, svg } from './commands/create.ts'
import { mv, order, rm, set } from './commands/edit.ts'
import { autoLayout, layoutFill, wrap } from './commands/layout.ts'
import { css, html, json, png } from './commands/output.ts'
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
  // export
  png,
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
  // edit: 並べる
  align,
  distribute,
  rotate,
  // edit: オートレイアウト
  autoLayout,
  wrap,
  layoutFill,
  // edit: コンポーネント
  component,
  detach,
  instance,
  swap,
  overridePush,
  overrideReset,
  variantAdd,
  variant,
  describe_,
  propAdd,
  prop,
]

export const COMMANDS: ReadonlyMap<string, Command> = new Map(commands.map((command) => [command.name, command]))
