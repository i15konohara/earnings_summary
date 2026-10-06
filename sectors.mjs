// 個別銘柄の決算DBとセクター判定
//   data/earnings_db.json  … 銘柄×決算期ごとの数値・評価・業種・理由づけ (実行のたびに追記・更新)
//   data/jp_industries.json / data/us_sectors.json … 業種のキャッシュ
// DB の直近の決算を業種ごとに集計し、「良さそう / まちまち / 悪そう」を判定する。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalFactors, jpProfitYoy, jpVerdict, usVerdict } from './reasons.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DB_FILE = join(ROOT, 'data', 'earnings_db.json');
const JP_INDUSTRY_FILE = join(ROOT, 'data', 'jp_industries.json');
const US_SECTOR_FILE = join(ROOT, 'data', 'us_sectors.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) earnings-summary/2.0';

const KEEP_DAYS = 400; // DB に残す期間 (前年同期と比べられるよう1年強)
const US_SECTOR_MIN_CAP = 1e9; // 米国は時価総額10億ドル以上だけ業種を引く (小型株は数が多くノイズも大きいため)
const MIN_COMPANIES = 3; // これ未満の業種は判定しない
const JUDGE_THRESHOLD = 0.25;
const MARKET_WEIGHT = 0.15; // 市況の追い風/逆風1件あたりの補正

export async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export const saveJson = (path, data) => writeFile(path, JSON.stringify(data, null, 1), 'utf8');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

// ---------- 業種の解決 ----------

// 株探の業種名を JPX(東証33業種)の正式名にそろえる
const KABUTAN_INDUSTRY_ALIAS = {
  'ガラス・土石': 'ガラス・土石製品',
  'ガス・電気': '電気・ガス業',
  '電気・ガス': '電気・ガス業',
  '証券・商品': '証券、商品先物取引業',
  '石油・石炭': '石油・石炭製品',
};
export const normalizeIndustry = (name) => (name ? (KABUTAN_INDUSTRY_ALIAS[name] ?? name) : name);

// 日本: 株探の銘柄ページの「業種」(東証33業種)。JPX の予定表に載っていない会社用
export async function resolveJpIndustries(codes, known = new Map(), { max = 150 } = {}) {
  const cache = await loadJson(JP_INDUSTRY_FILE, {});
  for (const code of Object.keys(cache)) cache[code] = normalizeIndustry(cache[code]);
  for (const [code, ind] of known) if (ind) cache[code] = ind;
  const missing = [...new Set(codes)].filter((c) => !cache[c]).slice(0, max);
  await mapLimit(missing, 4, async (code) => {
    try {
      const res = await fetch(`https://kabutan.jp/stock/?code=${encodeURIComponent(code)}`, { headers: { 'User-Agent': UA } });
      const m = (await res.text()).match(/<a href="\/themes\/\?industry=\d+[^"]*"[^>]*>([^<]+)<\/a>/);
      if (m) cache[code] = normalizeIndustry(m[1].trim());
    } catch {
      /* 次回に再試行 */
    }
    await sleep(300);
  });
  await saveJson(JP_INDUSTRY_FILE, cache);
  return cache;
}

// 米国: Yahoo Finance の assetProfile (sector / industry)
export async function resolveUsSectors(rows, session, { max = 120 } = {}) {
  const cache = await loadJson(US_SECTOR_FILE, {});
  for (const r of rows) if (r.fin?.sector) cache[r.symbol] = { sector: r.fin.sector, industry: r.fin.industry };
  if (session) {
    const missing = [...new Map(rows.filter((r) => r.marketCap >= US_SECTOR_MIN_CAP && !cache[r.symbol]).map((r) => [r.symbol, r])).values()]
      .sort((a, b) => b.marketCap - a.marketCap)
      .slice(0, max);
    await mapLimit(missing, 4, async (r) => {
      try {
        const sym = encodeURIComponent(r.symbol.replace(/\./g, '-'));
        const res = await fetch(
          `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=assetProfile&crumb=${encodeURIComponent(session.crumb)}`,
          { headers: { 'User-Agent': UA, Cookie: session.cookie } },
        );
        const p = (await res.json()).quoteSummary?.result?.[0]?.assetProfile;
        if (p?.sector) cache[r.symbol] = { sector: p.sector, industry: p.industry ?? null };
      } catch {
        /* 次回に再試行 */
      }
    });
  }
  await saveJson(US_SECTOR_FILE, cache);
  return cache;
}

// ---------- 決算DB ----------

const pctChange = (cur, prev) => (cur == null || prev == null || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100);
// "N/A" や "黒転" のように数字を含まない値は null (0 にしない)
const num = (s) => {
  const cleaned = String(s ?? '').replace(/[^0-9.-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
};

function jpRecord(item, date) {
  return {
    key: `JP:${item.code}:${item.info.period}`,
    market: 'JP',
    code: item.code,
    name: item.info.name ?? item.title.split('、')[0],
    industry: item.industry ?? null,
    period: item.info.period,
    date,
    url: item.url,
    title: item.title,
    values: item.info.values,
    yoy: item.info.yoy,
    verdict: jpVerdict(item.info),
    star: Boolean(item.star),
  };
}

function usRecord(row, date, sector) {
  const cur = row.fin?.cur ?? {};
  const prev = row.fin?.prev ?? {};
  return {
    key: `US:${row.symbol}:${row.quarter}`,
    market: 'US',
    code: row.symbol,
    name: row.name,
    industry: sector?.sector ?? null, // 集計の単位 (Yahoo のセクター)
    subIndustry: sector?.industry ?? null,
    period: row.quarter,
    date,
    marketCap: row.marketCap,
    eps: row.epsActual,
    epsForecast: row.epsForecast,
    surprise: num(row.surprise),
    rev: cur.rev ?? null,
    op: cur.op ?? null,
    net: cur.net ?? null,
    revYoY: pctChange(cur.rev, prev.rev),
    opYoY: pctChange(cur.op, prev.op),
    netYoY: pctChange(cur.net, prev.net),
    verdict: usVerdict(row),
  };
}

export const loadDb = () => loadJson(DB_FILE, {});

// report の決算結果と理由づけを DB に反映する
export async function updateDb(report, usSectors) {
  const db = await loadDb();
  const now = new Date().toISOString();
  const reasonsByKey = new Map((report.reasons ?? []).map((r) => [`${r.market}:${r.code}:${r.period}`, r]));
  const upsert = (rec) => {
    const old = db[rec.key];
    const r = reasonsByKey.get(rec.key);
    const reasons = r
      ? { individual: r.individual, cited: r.cited ?? [], external: r.external, source: r.source, summary: r.summary }
      : (old?.reasons ?? null);
    // 業種が取れなかった回で既存の業種を消さない
    db[rec.key] = { ...old, ...rec, industry: rec.industry ?? old?.industry ?? null, reasons, updatedAt: now };
  };

  for (const res of report.jp.results) {
    for (const item of res.items) if (item.kind === '決算' && item.info?.period) upsert(jpRecord(item, res.date));
  }
  for (const res of report.us.results) {
    for (const row of res.rows) if (row.epsActual) upsert(usRecord(row, res.date, usSectors[row.symbol]));
  }

  const limit = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  for (const [k, v] of Object.entries(db)) {
    if (v.date < limit) delete db[k];
    else if (v.market === 'JP') v.industry = normalizeIndustry(v.industry);
  }
  await saveJson(DB_FILE, db);
  return db;
}

// ---------- セクター判定 ----------

const median = (xs) => {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// 日本: 営業益(無ければ経常益)の前年比。"3.8 倍" は +280% に換算し、黒転/赤転などは数値化できないので中央値から除く
const jpGrowth = (r) => jpProfitYoy(r)?.pct ?? null;

function judge(n, score, marketAdj) {
  const composite = Math.max(-1, Math.min(1, score + marketAdj));
  if (n < MIN_COMPANIES) return { judgement: 'データ不足', composite };
  if (composite >= JUDGE_THRESHOLD) return { judgement: '良さそう', composite };
  if (composite <= -JUDGE_THRESHOLD) return { judgement: '悪そう', composite };
  return { judgement: 'まちまち', composite };
}

function sectorStats(market, industry, records, marketData) {
  const n = records.length;
  const good = records.filter((r) => r.verdict === '良い').length;
  const bad = records.filter((r) => r.verdict === '悪い').length;
  const score = n ? (good - bad) / n : 0;
  // 業種と市況のルールで、セクター全体にかかる追い風/逆風を判定
  const ext = externalFactors(market === 'JP' ? { market, industry } : { market, sector: industry, usIndustry: null }, marketData);
  const marketAdj = MARKET_WEIGHT * ext.reduce((s, e) => s + (e.effect === '追い風' ? 1 : -1), 0);
  const factors = records
    .filter((r) => r.reasons)
    .sort((a, b) => b.date.localeCompare(a.date))
    .flatMap((r) => [...r.reasons.individual, ...(r.reasons.cited ?? [])].map((f) => ({ factor: f.factor, name: r.name, verdict: r.verdict })))
    .slice(0, 5);
  return {
    industry,
    n,
    good,
    neutral: n - good - bad,
    bad,
    score,
    // 予想EPSが0に近いとサプライズ率が極端になるため ±100% で頭打ちにする
    medianGrowth:
      market === 'JP'
        ? median(records.map(jpGrowth))
        : median(records.map((r) => (r.surprise == null ? null : Math.max(-100, Math.min(100, r.surprise))))),
    market: ext,
    factors,
    ...judge(n, score, marketAdj),
  };
}

const ORDER = { 良さそう: 0, まちまち: 1, 悪そう: 2, データ不足: 3 };

export function sectorOutlook(db, marketData, asOf, windowDays = 60) {
  const from = new Date(new Date(`${asOf}T00:00:00Z`).getTime() - windowDays * 864e5).toISOString().slice(0, 10);
  const out = { asOf, windowDays, from, JP: [], US: [] };
  for (const market of ['JP', 'US']) {
    const groups = new Map();
    for (const r of Object.values(db)) {
      // 数値を読めなかった決算 (決算があった記録のみ) は良し悪しを判定できないので集計しない
      if (r.market !== market || !r.industry || r.date < from || r.date > asOf) continue;
      if (market === 'JP' && !Object.keys(r.values ?? {}).length) continue;
      if (!groups.has(r.industry)) groups.set(r.industry, []);
      groups.get(r.industry).push(r);
    }
    out[market] = [...groups]
      .map(([industry, recs]) => sectorStats(market, industry, recs, marketData ?? []))
      .sort((a, b) => ORDER[a.judgement] - ORDER[b.judgement] || b.composite - a.composite || b.n - a.n);
  }
  return out;
}

// 今後の決算予定の各社に、所属セクターの判定を付ける
export function annotateSchedule(report, usSectors) {
  const jpBy = new Map(report.sectors.JP.map((s) => [s.industry, s]));
  const usBy = new Map(report.sectors.US.map((s) => [s.industry, s]));
  for (const i of report.jp.schedule.items) i.outlook = jpBy.get(i.industry)?.judgement ?? null;
  // 1週間の予定に加え、本日/前営業日の「発表前」の行にも付ける (同じ表で表示しているため)
  const usRows = [...report.us.schedule.flatMap((d) => d.rows), ...report.us.results.flatMap((d) => d.rows.filter((r) => !r.epsActual))];
  for (const r of usRows) {
    r.sector = usSectors[r.symbol]?.sector ?? null;
    r.outlook = usBy.get(r.sector)?.judgement ?? null;
  }
  for (const [market, list] of [['JP', report.sectors.JP], ['US', report.sectors.US]]) {
    for (const s of list) {
      s.upcoming =
        market === 'JP'
          ? report.jp.schedule.items.filter((i) => i.industry === s.industry && i.date >= report.date).map((i) => i.name)
          : report.us.schedule.flatMap((d) => d.rows.filter((r) => r.sector === s.industry).map((r) => r.symbol));
    }
  }
}
