// 注目の個別銘柄: これまでの決算内容から、注目銘柄を機械的に選ぶ (LLMは使わない)
//   1. 直近の決算で目立った銘柄   … 決算DBの直近14日から「好決算」「不振」
//   2. 今後1週間に発表する注目銘柄 … 前回までの決算の勢い + セクター判定から「期待」「警戒」
//      日本: 株探の銘柄別「3ヵ月決算【実績】」(直近8四半期)
//      米国: Nasdaq の銘柄別 EPS サプライズ (直近4四半期)
// 銘柄別の履歴は data/history_cache.json にキャッシュする。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jpProfitYoy } from './reasons.mjs';
import { loadJson, mapLimit, saveJson, sleep } from './sectors.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = join(ROOT, 'data', 'history_cache.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) earnings-summary/2.0';

const RECENT_DAYS = 14; // 「直近の決算」とみなす期間
const HISTORY_TTL_DAYS = 30; // 履歴キャッシュの有効期間 (四半期に1回しか変わらない)
const MAX_FETCH = 60; // 1回の実行で新たに履歴を取りに行く銘柄数の上限 (日本・米国それぞれ)
const US_MIN_CAP = 1e9;
const TOP = { good: 10, bad: 5, expect: 10, warn: 5 };
const UPCOMING_THRESHOLD = 0.4;
const SECTOR_ADJ = { 良さそう: 0.3, 悪そう: -0.3 };

const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtPct = (v) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const fmtOku = (v) => (v == null ? '-' : v >= 1e12 ? `${(v / 1e12).toFixed(2)}兆円` : `${(v / 1e8).toFixed(1)}億円`);
const fmtUsd = (v) => (v == null ? '-' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : `$${(v / 1e6).toFixed(0)}M`);
const daysAgo = (ymd, n) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() - n * 864e5).toISOString().slice(0, 10);

// ---------- 銘柄別の履歴 ----------

const toNum = (s) => {
  const t = String(s ?? '').replace(/,/g, '').trim();
  return /^[+-]?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

// 株探の銘柄別「決算」ページの「3ヵ月決算【実績】」表 (直近の四半期ごとの業績)
export function parseKabutanQuarters(html) {
  const tokens = html
    .slice(html.indexOf('<body'))
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;/g, ' ')
    .split('|')
    .map((t) => t.trim())
    .filter(Boolean);
  const head = tokens.indexOf('3ヵ月決算【実績】');
  if (head < 0) return [];
  const start = tokens.indexOf('決算期', head);
  const labelRe = /^\d{2}\.\d{2}-\d{2}$/;
  const header = [];
  let i = start + 1;
  for (; i < tokens.length && !labelRe.test(tokens[i]); i++) header.push(tokens[i]);
  const col = (name) => header.indexOf(name);
  const rows = [];
  let cur = null;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (labelRe.test(t)) {
      cur = { label: t, cells: [] };
      rows.push(cur);
    } else if (/^(前年同期比|前年比)$/.test(t) || t.startsWith('※')) {
      break;
    } else if (cur) cur.cells.push(t);
  }
  return rows.map((r) => ({
    label: r.label,
    sales: toNum(r.cells[col('売上高')]),
    op: toNum(r.cells[col('営業益')]),
    ordinary: toNum(r.cells[col('経常益')]),
    net: toNum(r.cells[col('最終益')]),
  }));
}

async function fetchJpHistory(code) {
  const res = await fetch(`https://kabutan.jp/stock/finance?code=${encodeURIComponent(code)}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { quarters: parseKabutanQuarters(await res.text()) };
}

async function fetchUsHistory(symbol) {
  const res = await fetch(`https://api.nasdaq.com/api/company/${encodeURIComponent(symbol)}/earnings-surprise`, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json())?.data?.earningsSurpriseTable?.rows ?? [];
  return {
    surprises: rows.map((r) => ({ quarter: r.fiscalQtrEnd, date: r.dateReported, eps: r.eps, consensus: toNum(r.consensusForecast), surprise: toNum(r.percentageSurprise) })),
  };
}

// キャッシュに無い/古い銘柄だけ取りに行く
async function ensureHistory(cache, keys, fetcher, asOf) {
  const stale = daysAgo(asOf, HISTORY_TTL_DAYS);
  const missing = keys.filter((k) => !cache[k] || cache[k].fetchedAt < stale).slice(0, MAX_FETCH);
  await mapLimit(missing, 3, async (k) => {
    try {
      cache[k] = { fetchedAt: asOf, ...(await fetcher(k.split(':')[1])) };
    } catch {
      /* 次回に再試行 */
    }
    await sleep(300);
  });
}

// ---------- 1. 直近の決算で目立った銘柄 ----------

const sectorLine = (industry, outlook) => (industry ? `セクター: ${industry}${outlook ? `(${outlook})` : ''}` : null);

// 小さい会社の極端な増益率が上位を占めないよう、増益率は +150% で頭打ちにし、売上規模を加点する
function jpRecentScore(r) {
  const y = jpProfitYoy(r);
  const growth = y?.kind === 'up' ? 1 : y?.kind === 'down' ? -1 : clip(y?.pct ?? 0, -100, 150) / 100;
  const size = r.values?.['売上高'] ? clip(Math.log10(r.values['売上高'] / 1e9), 0, 3) * 0.35 : 0; // 売上10億円で0、1兆円で+1.05
  return { growth, size, y };
}

// 株探の前年比表記 ("+33.2" / "2.6 倍" / "黒転") に、数値なら % を付ける
const jpYoyText = (s) => (s == null ? '-' : /^[+-]?[\d.]+$/.test(String(s).trim()) ? `${s}%` : s);

function jpRecentPick(r, outlookBy) {
  const { growth, size, y } = jpRecentScore(r);
  const outlook = outlookBy.get(r.industry);
  const yText = y ? (y.kind === 'pct' ? fmtPct(y.pct) : (r.yoy['営業益'] ?? r.yoy['経常益'])) : '-';
  return {
    market: 'JP',
    code: r.code,
    name: r.name,
    date: r.date,
    url: r.url,
    industry: r.industry,
    outlook,
    good: growth + size + (r.star ? 0.3 : 0) + (SECTOR_ADJ[outlook] ?? 0) + (r.reasons ? 0.1 : 0),
    bad: -growth + size + (r.star ? 0.3 : 0) - (SECTOR_ADJ[outlook] ?? 0),
    points: [
      `${r.period} 営業益 ${fmtOku(r.values?.['営業益'])} (前年比 ${yText}) / 売上高 ${fmtOku(r.values?.['売上高'])} (前年比 ${jpYoyText(r.yoy?.['売上高'])})`,
      r.reasons?.summary && !r.reasons.summary.startsWith('材料から') ? `理由: ${r.reasons.summary}` : null,
      sectorLine(r.industry, outlook),
      r.star ? '株探の注目決算★' : null,
    ].filter(Boolean),
  };
}

function usRecentPick(r, outlookBy) {
  const growth = clip(r.surprise ?? 0, -50, 50) / 25 + (r.revYoY > 0 ? 0.2 : r.revYoY < 0 ? -0.2 : 0);
  const size = r.marketCap ? clip(Math.log10(r.marketCap / 1e9), 0, 3) * 0.2 : 0;
  const outlook = outlookBy.get(r.industry);
  return {
    market: 'US',
    code: r.code,
    name: r.name,
    date: r.date,
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(r.code)}`,
    industry: r.industry,
    outlook,
    good: growth + size + (SECTOR_ADJ[outlook] ?? 0) + (r.reasons ? 0.1 : 0),
    bad: -growth + size - (SECTOR_ADJ[outlook] ?? 0),
    points: [
      `${r.period} EPS ${r.eps} (予想 ${r.epsForecast || '-'}, サプライズ ${fmtPct(r.surprise)})`,
      r.rev != null ? `売上高 ${fmtUsd(r.rev)} (前年比 ${fmtPct(r.revYoY)})` : null,
      r.reasons?.summary && !r.reasons.summary.startsWith('材料から') ? `理由: ${r.reasons.summary}` : null,
      sectorLine(r.industry, outlook),
    ].filter(Boolean),
  };
}

function recentPicks(db, sectors, asOf) {
  const from = daysAgo(asOf, RECENT_DAYS);
  const out = {};
  for (const market of ['JP', 'US']) {
    const outlookBy = new Map(sectors[market].map((s) => [s.industry, s.judgement]));
    // 米国は超小型株の極端なサプライズが上位を占めるため、時価総額10億ドル以上に絞る (セクター判定と同じ基準)
    const recs = Object.values(db).filter(
      (r) => r.market === market && r.date >= from && r.date <= asOf && (market === 'JP' || r.marketCap >= US_MIN_CAP),
    );
    const pick = (r) => (market === 'JP' ? jpRecentPick(r, outlookBy) : usRecentPick(r, outlookBy));
    out[market] = {
      good: recs.filter((r) => r.verdict === '良い').map(pick).sort((a, b) => b.good - a.good).slice(0, TOP.good),
      bad: recs.filter((r) => r.verdict === '悪い').map(pick).sort((a, b) => b.bad - a.bad).slice(0, TOP.bad),
    };
  }
  return out;
}

// ---------- 2. 今後1週間に発表する注目銘柄 ----------

// 四半期 i の前年同期比 (4四半期前と比較)。赤字/黒字の転換は ±1 として扱う
function quarterYoy(quarters, i, key = 'op') {
  const cur = quarters[i]?.[key];
  const prev = quarters[i - 4]?.[key];
  if (cur == null || prev == null) return null;
  if (prev <= 0 && cur > 0) return { text: '黒字転換', score: 1, up: true };
  if (prev >= 0 && cur < 0) return { text: '赤字転落', score: -1, up: false };
  if (prev < 0 && cur < 0) return { text: cur > prev ? '赤字縮小' : '赤字拡大', score: cur > prev ? 0.2 : -0.5, up: cur > prev };
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  return { text: fmtPct(pct), score: clip(pct, -100, 100) / 100, up: pct > 0 };
}

const label = (score) => (score >= UPCOMING_THRESHOLD ? '期待' : score <= -UPCOMING_THRESHOLD ? '警戒' : null);

function jpUpcomingPick(item, hist, outlook) {
  const q = hist?.quarters ?? [];
  if (q.length < 6) return null;
  // 銀行などは営業益の欄が無いため経常益で見る
  const key = q.at(-1).op != null ? 'op' : 'ordinary';
  const name = key === 'op' ? '営業益' : '経常益';
  const last = quarterYoy(q, q.length - 1, key);
  const prev = quarterYoy(q, q.length - 2, key);
  if (!last) return null;
  const momentum = last.score * 0.6 + (prev?.score ?? 0) * 0.4;
  const score = momentum + (SECTOR_ADJ[outlook] ?? 0);
  const streak = last.up && prev?.up ? `2四半期連続で${name.replace('益', '')}増益` : !last.up && prev && !prev.up ? `2四半期連続で${name.replace('益', '')}減益` : null;
  return {
    market: 'JP',
    code: item.code,
    name: item.name,
    date: item.date,
    url: `https://kabutan.jp/stock/finance?code=${encodeURIComponent(item.code)}`,
    industry: item.industry,
    outlook,
    score,
    label: label(score),
    attention: item.star ? 1 : 0,
    points: [
      `前回(${q.at(-1).label}) ${name} 前年比 ${last.text}`,
      prev ? `前々回(${q.at(-2).label}) ${name} 前年比 ${prev.text}` : null,
      streak,
      sectorLine(item.industry, outlook),
      item.star ? '株探の注目決算★' : null,
    ].filter(Boolean),
  };
}

function usUpcomingPick(row, hist, outlook) {
  const s = (hist?.surprises ?? []).filter((x) => x.surprise != null).slice(0, 4);
  if (s.length < 2) return null;
  const beats = s.filter((x) => x.surprise > 0).length;
  const avg = s.reduce((a, x) => a + x.surprise, 0) / s.length;
  const score = ((beats - s.length / 2) / (s.length / 2)) * 0.6 + (clip(avg, -20, 20) / 20) * 0.4 + (SECTOR_ADJ[outlook] ?? 0);
  return {
    market: 'US',
    code: row.symbol,
    name: row.name,
    date: row.date,
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(row.symbol)}`,
    industry: row.sector,
    outlook,
    score,
    label: label(score),
    attention: clip(Math.log10(row.marketCap / 1e9), 0, 3),
    points: [
      `過去${s.length}四半期で予想超え ${beats}回 (平均サプライズ ${fmtPct(avg)})`,
      `前回(${s[0].quarter}) EPS ${s[0].eps} (予想 ${s[0].consensus ?? '-'}, サプライズ ${fmtPct(s[0].surprise)})`,
      sectorLine(row.sector, outlook),
    ].filter(Boolean),
  };
}

function splitUpcoming(list) {
  const valid = list.filter(Boolean);
  return {
    expect: valid.filter((p) => p.label === '期待').sort((a, b) => b.score - a.score || b.attention - a.attention).slice(0, TOP.expect),
    warn: valid.filter((p) => p.label === '警戒').sort((a, b) => a.score - b.score || b.attention - a.attention).slice(0, TOP.warn),
    evaluated: valid.length,
  };
}

async function upcomingPicks(report, cache) {
  const asOf = report.date;
  const jpOutlook = new Map(report.sectors.JP.map((s) => [s.industry, s.judgement]));
  const usOutlook = new Map(report.sectors.US.map((s) => [s.industry, s.judgement]));

  // 日本: ★ → セクター判定が出ている業種 の順に優先して履歴を取る
  const jpItems = report.jp.schedule.items.filter((i) => i.date >= asOf);
  const prio = (i) => (i.star ? 2 : 0) + (['良さそう', '悪そう'].includes(i.outlook) ? 1 : 0);
  const jpKeys = [...jpItems].sort((a, b) => prio(b) - prio(a)).map((i) => `JP:${i.code}`);
  await ensureHistory(cache, [...new Set(jpKeys)], fetchJpHistory, asOf);

  // 米国: 時価総額10億ドル以上を大きい順に
  const usRows = report.us.schedule
    .flatMap((d) => d.rows.map((r) => ({ ...r, date: d.date })))
    .filter((r) => r.marketCap >= US_MIN_CAP)
    .sort((a, b) => b.marketCap - a.marketCap);
  await ensureHistory(cache, [...new Set(usRows.map((r) => `US:${r.symbol}`))], fetchUsHistory, asOf);

  return {
    JP: splitUpcoming(jpItems.map((i) => jpUpcomingPick(i, cache[`JP:${i.code}`], jpOutlook.get(i.industry)))),
    US: splitUpcoming(usRows.map((r) => usUpcomingPick(r, cache[`US:${r.symbol}`], usOutlook.get(r.sector)))),
  };
}

// ---------- 公開API ----------

export async function buildPicks(report, db) {
  const cache = await loadJson(HISTORY_FILE, {});
  const upcoming = await upcomingPicks(report, cache);
  await saveJson(HISTORY_FILE, cache);
  return {
    asOf: report.date,
    recentDays: RECENT_DAYS,
    recent: recentPicks(db, report.sectors, report.date),
    upcoming,
  };
}
