// 書き出した kdr を読むための e2e の共通部品。
// kdr はノードを入れ子にして既定値を省いた形なので、本体の parseKdr（src/document/kdr.ts。Node が型を消して読む）で
// メモリ上の形（ページごとの平らな nodes の表）に直す。生の JSON も raw で見られる。
const zlib = require('zlib')

/** bytes（gzip した kdr）を読み、{ format, version, raw, document } を返す。document.pages[i].nodes はノードの表 */
async function parseKdrBytes(bytes) {
  const raw = JSON.parse(zlib.gunzipSync(bytes).toString('utf8'))
  const { parseKdr } = await import('../src/document/kdr.ts')
  return { format: raw.format, version: raw.version, raw, document: parseKdr(raw) }
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
