#!/usr/bin/env node
// 静的サイト生成: data/*.json (earnings_summary.mjs --json の出力) から docs/ にHTMLを生成する。
//   docs/index.html            最新の決算概要 (日本・米国)
//   docs/jp.html, us.html      市場別の概要 + 1週間の決算予定(全件)
//   docs/archive.html          過去分の一覧
//   docs/archive/YYYY-MM-DD.html  日別スナップショット
// 使い方: node site_generator.mjs [--base-url https://USER.github.io/REPO]

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIME_LABEL, US_FIN_NOTE, fmtCap, fmtJpCell, fmtSurprise, fmtUsFin, label } from './earnings_summary.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const SITE_DIR = join(ROOT, 'docs');

const SITE_TITLE = '決算カレンダーまとめ';
const SITE_DESCRIPTION = '日本・米国の決算発表を毎日自動でまとめます。前営業日・本日の決算概要と、1週間の決算予定を全件掲載。';
const DISCLAIMER =
  '本サイトは公開情報を自動収集・整形したものであり、正確性・完全性を保証せず、投資判断を勧めるものではありません。出典: 株探、JPX(日本取引所グループ)、Nasdaq、Yahoo Finance。数値は速報値で、各社の開示資料をご確認ください。';
const AD_SLOT = '<div class="ad-slot"><!-- 広告コード(Google AdSense等)をここに貼り付け --></div>';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ---------- 引数 ----------

function parseArgs(argv) {
  const opts = { baseUrl: 'https://i15konohara.github.io/earnings_summary' };
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--base-url') opts.baseUrl = argv[++i].replace(/\/$/, '');
  return opts;
}

// ---------- HTML 部品 ----------

function table(header, rows, { numericFrom = -1 } = {}) {
  const th = header.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows
    .map(
      (r) =>
        `<tr>${r
          .map((c, i) => {
            const cell = typeof c === 'object' && c !== null ? c : { html: esc(c) };
            const cls = [numericFrom >= 0 && i >= numericFrom ? 'num' : '', cell.cls ?? ''].filter(Boolean).join(' ');
            return `<td${cls ? ` class="${cls}"` : ''}>${cell.html}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('\n');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

// 増減に応じて色付けするセル (括弧内の前年比を判定)
function deltaCell(text) {
  const m = text.match(/\(([+-])[\d.]+%\)|\((赤転|赤縮|赤拡|黒転|黒拡|黒縮)\)/);
  let cls = '';
  if (m?.[1] === '+' || m?.[2]?.startsWith('黒')) cls = 'up';
  else if (m?.[1] === '-' || m?.[2]?.startsWith('赤')) cls = 'down';
  return { html: esc(text), cls };
}

const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

function section(title, inner, level = 'h2') {
  return `<section>\n<${level}>${esc(title)}</${level}>\n${inner}\n</section>`;
}

function daySchedule(date, count, tableHtml) {
  return `<details class="day" open><summary>${esc(label(date))} — ${count}社</summary>\n${tableHtml}\n</details>`;
}

// ---------- セクション ----------

function jpResultsHtml(r) {
  const title = `${r.title} (${label(r.date)})`;
  if (r.error) return section(title, `<p class="note">取得エラー: ${esc(r.error)}</p>`, 'h3');
  if (!r.items.length) return section(title, '<p class="note">決算速報はありません (休場日、または開示前)。</p>', 'h3');
  const kessan = r.items.filter((i) => i.kind === '決算');
  const shusei = r.items.filter((i) => i.kind !== '決算');
  const parts = [`<p class="note">決算 ${kessan.length} 件 / 業績修正・配当修正 ${shusei.length} 件 (括弧内は前年比)</p>`];
  if (kessan.length) {
    parts.push(
      table(
        ['時刻', 'コード', '会社名', '対象期', '売上高', '営業利益', '経常利益', '最終利益', '概要'],
        kessan.map((i) => [
          i.time,
          i.code,
          i.info?.name ?? '-',
          i.info?.period ?? '-',
          { html: esc(i.info ? fmtJpCell(i.info, '売上高') : '-'), cls: 'num' },
          ...['営業益', '経常益', '最終益'].map((k) => ({ ...deltaCell(i.info ? fmtJpCell(i.info, k) : '-'), cls: `num ${deltaCell(i.info ? fmtJpCell(i.info, k) : '-').cls}` })),
          { html: link(i.url, i.title) },
        ]),
      ),
    );
  }
  if (shusei.length) {
    parts.push('<h4>業績修正など</h4>', table(['時刻', 'コード', '概要'], shusei.map((i) => [i.time, i.code, { html: link(i.url, i.title) }])));
  }
  return section(title, parts.join('\n'), 'h3');
}

function jpScheduleHtml(s) {
  const parts = [];
  if (s.fallback) parts.push('<p class="note">JPXの一覧が取得できなかったため株探の記事で代替しています (件数の多い日は一部省略されます)。</p>');
  for (const d of s.dates) {
    const day = s.items.filter((i) => i.date === d).sort((a, b) => a.code.localeCompare(b.code));
    if (!day.length) continue;
    parts.push(
      daySchedule(
        d,
        day.length,
        table(['コード', '会社名', '市場', '業種', '種別', '注目'], day.map((i) => [i.code, i.name, i.market, i.industry, i.kind, i.star ? '★' : ''])),
      ),
    );
  }
  if (!s.items.length) parts.push('<p class="note">予定を取得できませんでした。</p>');
  for (const e of s.errors) parts.push(`<p class="note">取得エラー: ${esc(e)}</p>`);
  return section('決算発表予定 (本日から1週間・全件)', parts.join('\n'), 'h3');
}

function usScheduleTable(rows) {
  return table(
    ['銘柄', '会社名', '時価総額', '時間', '四半期', 'EPS予想'],
    rows.map((r) => [r.symbol, r.name, fmtCap(r.marketCap), TIME_LABEL[r.time] ?? r.time, r.quarter, r.epsForecast ?? '-']),
  );
}

function usResultsHtml(r) {
  const title = `${r.title} (${label(r.date)} 米東部時間)`;
  const reported = r.rows.filter((x) => x.epsActual);
  const pending = r.rows.filter((x) => !x.epsActual);
  const parts = [`<p class="note">発表済み ${reported.length} 社 / 発表前 ${pending.length} 社 (時価総額順)</p>`];
  if (reported.length) {
    parts.push(
      table(
        ['銘柄', '会社名', '時価総額', '四半期', 'EPS実績', 'EPS予想', 'サプライズ', '売上高', '営業利益', '純利益'],
        reported.map((x) => {
          const sur = fmtSurprise(x.surprise);
          return [
            x.symbol,
            x.name,
            { html: esc(fmtCap(x.marketCap)), cls: 'num' },
            x.quarter,
            { html: esc(x.epsActual), cls: 'num' },
            { html: esc(x.epsForecast ?? '-'), cls: 'num' },
            { html: esc(sur), cls: `num ${sur.startsWith('+') ? 'up' : sur.startsWith('-') && sur !== '-' ? 'down' : ''}` },
            ...['rev', 'op', 'net'].map((k) => ({ ...deltaCell(fmtUsFin(x, k)), cls: `num ${deltaCell(fmtUsFin(x, k)).cls}` })),
          ];
        }),
      ),
    );
  }
  if (pending.length) parts.push('<h4>発表前</h4>', usScheduleTable(pending));
  return section(title, parts.join('\n'), 'h3');
}

function usScheduleHtml(report) {
  const parts = report.us.schedule.map(({ date, rows }) =>
    daySchedule(date, rows.length, rows.length ? usScheduleTable(rows) : '<p class="note">予定なし</p>'),
  );
  for (const e of report.us.errors) parts.push(`<p class="note">取得エラー: ${esc(e)}</p>`);
  return section('決算発表予定 (翌営業日から1週間・全件)', parts.join('\n'), 'h3');
}

const usNoteHtml = (report) =>
  `<p class="note">${esc(report.yahooConnected ? US_FIN_NOTE(report.usDetail) : 'Yahoo Finance に接続できなかったため、売上高・営業利益は表示していません。')}</p>`;

// ---------- ページ ----------

function renderNav(prefix) {
  return [
    ['index.html', 'トップ'],
    ['jp.html', '🇯🇵 日本'],
    ['us.html', '🇺🇸 米国'],
    ['archive.html', 'アーカイブ'],
  ]
    .map(([href, name]) => `<a href="${prefix}${href}">${name}</a>`)
    .join('\n');
}

function renderPage({ title, description, body, prefix = '' }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="stylesheet" href="${prefix}style.css">
</head>
<body>
<header class="site-header">
  <a class="site-title" href="${prefix}index.html">${esc(SITE_TITLE)}</a>
  <p class="site-desc">${esc(SITE_DESCRIPTION)}</p>
</header>
${AD_SLOT}
<nav class="keyword-nav">${renderNav(prefix)}</nav>
<main>
${body}
</main>
${AD_SLOT}
<footer class="site-footer">
  <p>${esc(DISCLAIMER)}</p>
</footer>
</body>
</html>
`;
}

const updated = (report) => {
  const t = new Date(report.generatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
  return `<p class="updated">最終更新: ${esc(t)} (JST) / 基準日: ${esc(report.date)}</p>`;
};

function statCards(report) {
  const jpCount = (i) => report.jp.results[i].items.filter((x) => x.kind === '決算').length;
  const jpSchedToday = report.jp.schedule.items.filter((i) => i.date === report.date).length;
  const usCount = (idx) => report.us.results[idx]?.rows.filter((x) => x.epsActual).length ?? 0;
  const usNext = report.us.schedule[0];
  const cards = [
    ['日本 前営業日の決算', `${jpCount(0)}件`, `${label(report.jp.results[0].date)}`],
    ['日本 本日の決算予定', `${jpSchedToday}社`, `${label(report.date)}`],
    ['米国 前営業日の発表済み', `${usCount(0)}社`, report.us.results[0] ? label(report.us.results[0].date) : '-'],
    ['米国 次営業日の予定', `${usNext?.rows.length ?? 0}社`, usNext ? label(usNext.date) : '-'],
  ];
  return `<div class="stat-grid">${cards
    .map(([k, v, s]) => `<div class="stat"><div class="stat-k">${esc(k)}</div><div class="stat-v">${esc(v)}</div><div class="stat-s">${esc(s)}</div></div>`)
    .join('')}</div>`;
}

const jpBody = (report, withSchedule) =>
  [`<h2>🇯🇵 日本</h2>`, ...report.jp.results.map(jpResultsHtml), ...(withSchedule ? [jpScheduleHtml(report.jp.schedule)] : [])].join('\n');

const usBody = (report, withSchedule) =>
  [`<h2>🇺🇸 米国</h2>`, ...report.us.results.map(usResultsHtml), usNoteHtml(report), ...(withSchedule ? [usScheduleHtml(report)] : [])].join('\n');

function buildPages(latest, all, baseUrl) {
  const pages = new Map();
  const desc = (m) => `${m}の決算概要と1週間の決算予定 (${latest.date} 時点)`;

  pages.set(
    'index.html',
    renderPage({
      title: `${SITE_TITLE} | ${latest.date}`,
      description: SITE_DESCRIPTION,
      body: [
        updated(latest),
        statCards(latest),
        `<p class="note">決算予定の全件リストは <a href="jp.html">日本</a> / <a href="us.html">米国</a> のページにあります。</p>`,
        jpBody(latest, false),
        usBody(latest, false),
      ].join('\n'),
    }),
  );
  pages.set('jp.html', renderPage({ title: `日本の決算 | ${SITE_TITLE}`, description: desc('日本'), body: [updated(latest), jpBody(latest, true)].join('\n') }));
  pages.set('us.html', renderPage({ title: `米国の決算 | ${SITE_TITLE}`, description: desc('米国'), body: [updated(latest), usBody(latest, true)].join('\n') }));

  const items = all
    .map((r) => `<li><a href="archive/${esc(r.date)}.html">${esc(label(r.date))}</a></li>`)
    .join('\n');
  pages.set(
    'archive.html',
    renderPage({ title: `アーカイブ | ${SITE_TITLE}`, description: '過去の決算サマリー一覧', body: `<h2>アーカイブ</h2>\n<ul class="archive-list">\n${items}\n</ul>` }),
  );
  for (const r of all) {
    pages.set(
      `archive/${r.date}.html`,
      renderPage({
        title: `${r.date} の決算 | ${SITE_TITLE}`,
        description: `${r.date} 時点の日本・米国の決算サマリー`,
        prefix: '../',
        body: [updated(r), jpBody(r, true), usBody(r, true)].join('\n'),
      }),
    );
  }

  const urls = ['index.html', 'jp.html', 'us.html', 'archive.html', ...all.map((r) => `archive/${r.date}.html`)].map((p) => `${baseUrl}/${p}`);
  pages.set(
    'sitemap.xml',
    ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`), '</urlset>'].join('\n'),
  );
  pages.set('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`);
  pages.set('style.css', CSS);
  pages.set('.nojekyll', '');
  return pages;
}

// ---------- CSS (news_summarizer と共通のデザイン + 決算テーブル用) ----------

const CSS = `:root {
  --bg: #f7f7f5;
  --card-bg: #ffffff;
  --text: #1f2328;
  --muted: #6b7280;
  --accent: #1a56db;
  --border: #e5e7eb;
  --up: #15803d;
  --down: #b91c1c;
  --head-bg: #f3f4f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --card-bg: #1c1f24;
    --text: #e6e8eb;
    --muted: #9aa3af;
    --accent: #7aa2ff;
    --border: #2d333b;
    --up: #4ade80;
    --down: #f87171;
    --head-bg: #232830;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic", sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.7;
}
a { color: var(--accent); }
.site-header {
  padding: 24px 16px;
  text-align: center;
  border-bottom: 1px solid var(--border);
  background: var(--card-bg);
}
.site-title { font-size: 1.6rem; font-weight: 700; color: var(--text); text-decoration: none; }
.site-desc { color: var(--muted); margin: 8px 0 0; font-size: 0.9rem; }
.keyword-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  padding: 12px 16px;
  max-width: 1100px;
  margin: 0 auto;
}
.keyword-nav a {
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--card-bg);
  border: 1px solid var(--border);
  color: var(--text);
  text-decoration: none;
  font-size: 0.85rem;
  white-space: nowrap;
}
.keyword-nav a:hover { border-color: var(--accent); color: var(--accent); }
main { max-width: 1100px; margin: 0 auto; padding: 8px 16px 32px; }
h2 { font-size: 1.3rem; margin: 28px 0 12px; }
h3 { font-size: 1.05rem; margin: 24px 0 8px; }
h4 { font-size: 0.95rem; margin: 16px 0 6px; }
.note, .updated { color: var(--muted); font-size: 0.85rem; margin: 6px 0; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin: 12px 0; }
.stat { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.stat-k { font-size: 0.78rem; color: var(--muted); }
.stat-v { font-size: 1.6rem; font-weight: 700; line-height: 1.3; }
.stat-s { font-size: 0.78rem; color: var(--muted); }
.table-wrap { overflow-x: auto; background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; margin: 8px 0 16px; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
th, td { padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
td:last-child:not(.num) { white-space: normal; min-width: 14em; }
th { background: var(--head-bg); font-weight: 600; position: sticky; top: 0; }
tr:last-child td { border-bottom: none; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.up { color: var(--up); }
.down { color: var(--down); }
details.day { margin: 12px 0; }
details.day > summary { cursor: pointer; font-weight: 600; padding: 6px 0; }
.archive-list { columns: 2; padding-left: 20px; }
.ad-slot {
  max-width: 1100px;
  margin: 16px auto;
  min-height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 0.75rem;
  border: 1px dashed var(--border);
}
.site-footer {
  max-width: 1100px;
  margin: 0 auto;
  padding: 16px;
  color: var(--muted);
  font-size: 0.78rem;
  border-top: 1px solid var(--border);
}
`;

// ---------- main ----------

async function main() {
  const { baseUrl } = parseArgs(process.argv.slice(2));
  const files = (await readdir(DATA_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  if (!files.length) {
    console.error('data/ にJSONがありません。先に node earnings_summary.mjs --json を実行してください。');
    process.exit(1);
  }
  const all = [];
  for (const f of files) all.push(JSON.parse(await readFile(join(DATA_DIR, f), 'utf8')));
  const pages = buildPages(all[0], all, baseUrl);

  for (const [path, content] of pages) {
    const file = join(SITE_DIR, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
  console.log(`サイトを生成しました: ${SITE_DIR} (${pages.size}ファイル / 基準日 ${all[0].date} / アーカイブ ${all.length}件)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
