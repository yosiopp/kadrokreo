import type { DesignDocument, FrameNode, RectNode, Scene, SceneNode, Style, TextNode } from './types.ts'

// テストで使うノードの組み立て。editor の側にあるノードの生成（nodes.ts）は、共通側や viewer のテストからは使えない

export const base = {
  name: 'Node',
  parentId: null,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  rotation: 0,
  visible: true,
  locked: false,
  opacity: 1,
  sizing: { width: 'fixed', height: 'fixed' } as SceneNode['sizing'],
  layoutPositioning: 'auto' as const,
  constraints: { horizontal: 'start', vertical: 'start' } as SceneNode['constraints'],
  minWidth: null,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
}
export const paint: Style = { fills: [{ type: 'solid', color: '#ff0000' }], strokes: [], strokeWidth: 1, effects: [] }

export const rect = (patch: Partial<RectNode> = {}): RectNode => ({
  ...base,
  ...paint,
  id: 'rect',
  type: 'rect',
  cornerRadius: 0,
  ...patch,
})
export const frame = (patch: Partial<FrameNode> = {}): FrameNode => ({
  ...base,
  ...paint,
  id: 'frame',
  type: 'frame',
  children: [],
  clipContent: true,
  cornerRadius: 0,
  layout: null,
  component: null,
  ...patch,
})
export const text = (patch: Partial<TextNode> = {}): TextNode => ({
  ...base,
  id: 'text',
  type: 'text',
  text: 'こんにちは',
  fontSize: 16,
  fontFamily: 'sans-serif',
  fills: [{ type: 'solid', color: '#111111' }],
  sizing: { width: 'hug', height: 'hug' },
  fontWeight: 400,
  textAlign: 'left',
  lineHeight: 1.5,
  ...patch,
})

export function sceneOf(...nodes: SceneNode[]): Scene {
  return {
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    rootIds: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  }
}

export function docOf(scene: Scene): DesignDocument {
  return {
    name: 'x',
    pages: [{ id: 'p1', name: 'Page 1', ...scene }],
    assets: { a1: { mime: 'image/png', data: '' } },
  }
}
