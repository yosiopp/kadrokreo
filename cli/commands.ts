import { type Command } from './commands/common.ts'
import { align, distribute, flip, rotate } from './commands/arrange.ts'
import {
  component,
  describe_,
  detach,
  instance,
  overridePush,
  overrideReset,
  prop,
  propAdd,
  propAlign,
  propOrder,
  propPrefer,
  propRename,
  propRm,
  swap,
  variant,
  variantAdd,
  variantPropAdd,
  variantPropRename,
  variantPropOrder,
  variantPropRm,
  variantValueOrder,
  variantValueRename,
} from './commands/components.ts'
import { add, dup, svg } from './commands/create.ts'
import { mv, order, rm, set } from './commands/edit.ts'
import { boolean, flatten, join, mask, outlineStroke, split } from './commands/paths.ts'
import { gradient } from './commands/paints.ts'
import { autoLayout, layoutFill, wrap } from './commands/layout.ts'
import { css, html, json, png, svgOut } from './commands/output.ts'
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
  svgOut,
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
  gradient,
  rm,
  mv,
  order,
  dup,
  // edit: パスとマスク
  join,
  split,
  boolean,
  flatten,
  outlineStroke,
  mask,
  // edit: 並べる
  align,
  distribute,
  rotate,
  flip,
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
  variantPropAdd,
  variantPropRename,
  variantPropRm,
  variantPropOrder,
  variantValueRename,
  variantValueOrder,
  describe_,
  propAdd,
  propRename,
  propOrder,
  propPrefer,
  propRm,
  propAlign,
  prop,
]

export const COMMANDS: ReadonlyMap<string, Command> = new Map(commands.map((command) => [command.name, command]))
