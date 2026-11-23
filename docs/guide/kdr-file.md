# kdr ファイル

[ユーザーズガイド](README.md) の一部。

kadrokreo のデザインを保存するファイル（拡張子 `.kdr`）。中身はドキュメントの JSON（`document.json`）と画像の元のファイル（`assets/`）を
tar にまとめて gzip で圧縮したもの（version 16）で、`tar -xzf design.kdr` でそのまま取り出せる。

- 読めるのは今の version（16）のファイルだけ。古い version のファイルは「古いバージョン」として開かない
- 取り出したものを固め直すときは、`tar --format ustar` で `document.json` と `assets/` の中だけを入れる（macOS の tar が足す拡張の見出しや `._` のファイルがあると読めない）
- `document.json` の中身は `kdr -f design.kdr json --pretty` でも見られる（[コマンドライン](cli.md)）
