// 書き出した kdr を読むための e2e の共通部品。
// kdr は tar.gz（document.json と assets/<sha256>.<拡張子>）で、ノードは入れ子にして既定値を省いた形なので、
// 本体の readKdrArchive と parseKdr（src/document/kdr.ts。Node が型を消して読む）で
// メモリ上の形（ページごとの平らな nodes の表、画像は { mime, bytes }）に直す。document.json の中身も raw で見られる。

/** bytes（kdr）を読み、{ format, version, raw, names, document } を返す。document.pages[i].nodes はノードの表、names は tar の中の名前 */
async function parseKdrBytes(bytes) {
  const { readKdrArchive, parseKdr } = await import('../src/document/kdr.ts')
  const { document: raw, assets } = await readKdrArchive(new Blob([bytes]))
  return { format: raw.format, version: raw.version, raw, names: ['document.json', ...Object.keys(assets)], document: parseKdr(raw, assets) }
}


/** 直線（2 頂点のパス）の向き。左上と右下を結ぶなら down、左下と右上なら up（v14 までの direction と同じ） */
function lineDirection(line) {
  const [a, b] = line.points
  return (a.x - b.x) * (a.y - b.y) >= 0 ? 'down' : 'up'
}

/** 直線の始点が右側（垂直なら下側）にあるか（v14 までの flipped と同じ） */
function lineFlipped(line) {
  const [a, b] = line.points.map((p) => ({ x: p.x * line.width, y: p.y * line.height }))
  return b.x < a.x || (b.x === a.x && b.y < a.y)
}

module.exports = { parseKdrBytes, lineDirection, lineFlipped }
