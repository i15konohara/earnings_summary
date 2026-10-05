# earnings_summary

日本・米国の決算発表をまとめ、静的サイト(GitHub Pages)として公開するツールです。外部パッケージ不要(Node.js 18以上)。

- 前営業日 / 本日の決算概要(売上高・営業利益などの数値付き)
- 本日から1週間の決算予定(全件)

## 使い方

```
node earnings_summary.mjs            # Markdownを表示し output/ に保存
node earnings_summary.mjs --json     # data/YYYY-MM-DD.json も保存 (サイト生成用)
node site_generator.mjs              # data/*.json から docs/ にサイトを生成
```

オプション: `--date YYYY-MM-DD` / `--days 7` / `--us-detail 40` / `--no-save` / `--json`
サイト生成: `--base-url https://USER.github.io/REPO` (sitemap.xml / robots.txt 用)

## 自動更新と公開

`run_all.bat` が 収集 → サイト生成 → git commit/push を行います。タスクスケジューラに登録して毎日実行します(例は下記)。
GitHub の Settings → Pages で「Deploy from a branch」→ `main` / `/docs` を指定すると公開されます。

```
schtasks /Create /TN EarningsSummary_Morning /TR "D:\ClaudeCodeDir\earnings_summary\run_all.bat" /SC DAILY /ST 07:30
schtasks /Create /TN EarningsSummary_Evening /TR "D:\ClaudeCodeDir\earnings_summary\run_all.bat" /SC DAILY /ST 18:00
```

朝は米国の前日分と日本の前営業日分、夕方は日本の当日分(15時以降に開示)が反映されます。

## データソース

| 用途 | ソース |
|---|---|
| 日本の決算概要・数値 | 株探 決算速報と記事内の業績表 |
| 日本の決算予定(全件) | JPX 決算発表予定日Excel(+株探の注目★) |
| 米国の予定・EPS | Nasdaq 決算カレンダーAPI |
| 米国の売上・利益 | Yahoo Finance (発表直後は営業利益が未反映のことがあります) |

スクレイピングを含むため、提供元のページ構造が変わると取得できなくなる場合があります。
