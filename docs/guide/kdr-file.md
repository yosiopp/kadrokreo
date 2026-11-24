# kdr ファイル

[ユーザーズガイド](README.md) の一部。

kadrokreo のデザインを保存するファイル（拡張子 `.kdr`）。中身はドキュメントの JSON（`document.json`）と画像・書体の元のファイル（`assets/`）を
tar にまとめて gzip で圧縮したもの（version 16）で、`tar -xzf design.kdr` でそのまま取り出せる。

- 読めるのは今の version（16）のファイルだけ。古い version のファイルは「古いバージョン」として開かない
- 取り出したものを固め直すときは、`tar --format ustar` で `document.json` と `assets/` の中だけを入れる（macOS の tar が足す拡張の見出しや `._` のファイルがあると読めない）
- 埋め込んだ書体（[editor](editor.md#書体) の「書体ファイルを追加」や `kdr font-add`）は `assets/` に元のファイル（`.ttf` / `.otf` / `.woff`）のまま入る。
  書体を埋め込んだファイルは、書体に対応する前の kadrokreo では「知らないファイル」として開けない
- `document.json` の中身は `kdr -f design.kdr json --pretty` でも見られる（[コマンドライン](cli.md)）
