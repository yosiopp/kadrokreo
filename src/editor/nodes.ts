import type { Bounds } from '../document/geometry.ts'
import type { EllipseNode, FrameNode, NodeId, RectNode, TextNode } from '../document/types.ts'

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

// crypto.randomUUID は http 配信（非セキュアコンテキスト）では使えないので getRandomValues で作る
export function createId(): NodeId {
  let id = ''
  for (const byte of crypto.getRandomValues(new Uint8Array(12))) id += ID_ALPHABET[byte & 63]
  return id
}

function base(name: string, bounds: Bounds) {
  return {
    id: createId(),
    name,
    parentId: null,
    ...bounds,
    visible: true,
    locked: false,
    opacity: 1,
  }
}

export function createRect(bounds: Bounds): RectNode {
  return {
    ...base('Rectangle', bounds),
    type: 'rect',
    fill: '#d9d9d9',
    stroke: null,
    strokeWidth: 1,
    cornerRadius: 0,
  }
}

export function createEllipse(bounds: Bounds): EllipseNode {
  return {
    ...base('Ellipse', bounds),
    type: 'ellipse',
    fill: '#d9d9d9',
    stroke: null,
    strokeWidth: 1,
  }
}

export function createText(bounds: Bounds, text = ''): TextNode {
  return {
    ...base('Text', bounds),
    type: 'text',
    text,
    fontSize: 16,
    fontFamily: 'sans-serif',
    fill: '#000000',
  }
}

export function createFrame(bounds: Bounds): FrameNode {
  return {
    ...base('Frame', bounds),
    type: 'frame',
    fill: '#ffffff',
    stroke: null,
    strokeWidth: 1,
    children: [],
    clipContent: true,
  }
}
