#!/usr/bin/env node
// 決算サマリー: 日本・米国の「前営業日 / 本日の決算概要」と「今後1週間の決算予定(全件)」をまとめる。
//   日本: 決算概要=株探(決算速報+記事内の業績表)、予定=JPX決算発表予定日Excel(+株探の注目★)
//   米国: 予定・EPS=Nasdaq決算カレンダー、売上・利益=Yahoo Finance
// 使い方: node earnings_summary.mjs [--date YYYY-MM-DD] [--days 7] [--us-detail 40] [--no-save] [--json]

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) earnings-summary/2.0';
const KABUTAN = 'https://kabutan.jp';
const JPX_PAGE = 'https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html';
const NASDAQ = 'https://api.nasdaq.com/api/calendar/earnings';

// ---------- 引数 ----------

function parseArgs(argv) {
  const opts = { date: null, days: 7, usDetail: 40, save: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--days') opts.days = Number(argv[++i]);
    else if (a === '--us-detail') opts.usDetail = Number(argv[++i]);
    else if (a === '--no-save') opts.save = false;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') {
      console.log('node earnings_summary.mjs [--date YYYY-MM-DD] [--days 7] [--us-detail 40] [--no-save] [--json]');
      process.exit(0);
    }
  }
  return opts;
}

// ---------- 日付ユーティリティ (YYYY-MM-DD 文字列で扱う) ----------

const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isWeekday = (ymd) => ![0, 6].includes(new Date(`${ymd}T00:00:00Z`).getUTCDay());
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const label = (ymd) => `${ymd} (${WEEKDAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()]})`;
const range = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));

// 前営業日 (月曜なら先週金曜)
function prevBusinessDay(ymd) {
  let d = addDays(ymd, -1);
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

// ---------- HTTP / 共通 ----------

async function fetchRaw(url, headers = {}, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (attempt >= retries) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

const fetchText = async (url, headers) => (await fetchRaw(url, headers)).text();

// 同時実行数を絞った Promise.all
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');

const stripTags = (html) =>
  decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/(p|div|li|tr)>/g, '\n')
      .replace(/<[^>]+>/g, ' '),
  );

const toNumber = (s) => {
  if (s == null || s === '' || s === 'N/A') return null;
  const neg = /^\(.*\)$/.test(s) || String(s).includes('-');
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isNaN(n) ? null : neg ? -n : n;
};

const pct = (cur, prev) =>
  cur == null || prev == null || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100;

const fmtPct = (p) => (p == null ? '' : ` (${p >= 0 ? '+' : ''}${p.toFixed(1)}%)`);

// ---------- 日本: 株探 決算速報 ----------

const KABUTAN_ROW =
  /<td class="news_time"><time datetime="([^"]+)">[\s\S]*?data-code="([^"]+)">([^<]+)<\/div>[\s\S]*?<a href="([^"]+)">([^<]+)<\/a>/g;

function parseKabutanNews(html) {
  return [...html.matchAll(KABUTAN_ROW)].map((m) => ({
    date: m[1].slice(0, 10),
    time: m[1].slice(11, 16),
    code: m[2],
    kind: m[3], // 決算 / 修正
    url: `${KABUTAN}${decodeEntities(m[4])}`,
    title: decodeEntities(m[5]),
  }));
}

async function fetchJpNewsFor(date, maxPages = 25) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = parseKabutanNews(await fetchText(`${KABUTAN}/news/?category=3&page=${page}`));
    if (rows.length === 0) break;
    items.push(...rows.filter((r) => r.date === date));
    if (rows.some((r) => r.date < date)) break;
  }
  return items.sort((a, b) => a.time.localeCompare(b.time));
}

const UNIT_TO_YEN = { 千円: 1e3, 百万円: 1e6, 億円: 1e8, 円: 1 };

// 決算記事の【実績】表から 売上高・営業益・経常益・最終益 と前年比を取り出す
function parseKabutanArticle(html) {
  const tokens = stripTags(html.slice(html.indexOf('<body')))
    .split(/[\n]+/)
    .flatMap((l) => l.split(/\s{2,}/))
    .map((t) => t.trim())
    .filter(Boolean);
  const info = { name: null, period: null, values: {}, yoy: {} };

  const nameIdx = tokens.findIndex((t) => /^[0-9A-Z]{4}$/.test(t));
  if (nameIdx >= 0 && tokens[nameIdx + 1]) info.name = tokens[nameIdx + 1].replace(/【.*?】/g, '');

  const head = tokens.findIndex((t) => t.endsWith('【実績】'));
  if (head < 0) return info;
  const start = tokens.indexOf('決算期', head);
  if (start < 0) return info;

  // 行ラベル: 通期 "2026.08" / 四半期 "26.06-08" (小数の 89.52 などと区別する)
  const labelRe = /^(\d{4}\.\d{2}|\d{2}\.\d{2}-\d{2})$/;
  const header = [];
  let i = start + 1;
  for (; i < tokens.length && !labelRe.test(tokens[i]); i++) header.push(tokens[i]);

  const noteTok = tokens.slice(i, i + 80).find((t) => t.startsWith('※単位'));
  const unit = UNIT_TO_YEN[(noteTok?.match(/「(.+?)」/) ?? [])[1]] ?? 1e6;

  let last = null;
  let yoyRow = null;
  for (; i < tokens.length; i++) {
    if (labelRe.test(tokens[i])) {
      last = { label: tokens[i], cells: [] };
      yoyRow = null;
    } else if (/^(前年同期比|前年比|前期比)$/.test(tokens[i])) {
      yoyRow = [];
    } else if (tokens[i].startsWith('(%)') || tokens[i].startsWith('※')) {
      break;
    } else if (yoyRow) yoyRow.push(tokens[i]);
    else if (last) last.cells.push(tokens[i]);
  }
  if (!last) return info;

  info.period = last.label;
  for (const key of ['売上高', '営業益', '経常益', '最終益']) {
    const col = header.indexOf(key);
    if (col < 0) continue;
    const v = toNumber(last.cells[col]);
    info.values[key] = v == null || last.cells[col] === '-' ? null : v * unit;
    info.yoy[key] = yoyRow?.[col] ?? null;
  }
  return info;
}

function fmtYen(v) {
  if (v == null) return '-';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}兆円`;
  if (abs >= 1e8) return `${(v / 1e8).toLocaleString('en-US', { maximumFractionDigits: 1 })}億円`;
  return `${(v / 1e4).toLocaleString('en-US', { maximumFractionDigits: 0 })}万円`;
}

function fmtJpCell(info, key) {
  const v = info.values[key];
  if (v == null) return '-';
  const y = info.yoy[key];
  let yoy = '';
  if (y && y !== '-') yoy = /^[+-]?[\d.]+$/.test(y) ? ` (${/^[+-]/.test(y) ? y : `+${y}`}%)` : ` (${y})`;
  return `${fmtYen(v)}${yoy}`;
}

async function enrichJpResults(items) {
  await mapLimit(items, 6, async (item) => {
    if (item.kind !== '決算') return;
    try {
      item.info = parseKabutanArticle(await fetchText(item.url));
    } catch {
      item.info = null;
    }
  });
  return items;
}

// ---------- 日本: 決算予定 (JPX Excel + 株探の注目★) ----------

function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    files.set(name, method === 8 ? inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function parseXlsxRows(buf) {
  const files = unzip(buf);
  const strings = [...decodeEntities(files.get('xl/sharedStrings.xml').toString('utf8')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''),
  );
  const sheet = files.get('xl/worksheets/sheet1.xml').toString('utf8');
  const rows = [];
  for (const row of sheet.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const v = c[3]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (v == null) continue;
      cells[c[1]] = /t="s"/.test(c[2]) ? strings[Number(v)] : v;
    }
    rows.push(cells);
  }
  return rows;
}

const excelDate = (serial) => new Date(Date.UTC(1899, 11, 30) + Number(serial) * 864e5).toISOString().slice(0, 10);

async function fetchJpxSchedule() {
  const page = await fetchText(JPX_PAGE);
  const urls = [...new Set([...page.matchAll(/href="([^"]+\.xlsx)"/g)].map((m) => new URL(m[1], JPX_PAGE).href))];
  const byKey = new Map();
  for (const url of urls) {
    const buf = Buffer.from(await (await fetchRaw(url)).arrayBuffer());
    for (const r of parseXlsxRows(buf)) {
      if (!r.A || !/^\d+$/.test(r.A) || !r.B) continue;
      const date = excelDate(r.A);
      byKey.set(`${date}|${r.B}`, {
        date,
        code: String(r.B),
        name: r.C,
        industry: r.F ?? '',
        kind: r.H ?? '',
        market: r.J ?? '',
      });
    }
  }
  return [...byKey.values()];
}

// 株探「今週の決算発表予定」記事: 注目銘柄(★)と JPX 取得失敗時の代替
async function findWeeklyArticleUrls() {
  const top = await fetchText(`${KABUTAN}/`);
  const re = /href="(\/news\/marketnews\/\?b=n\d+)"[^>]*>\s*今週の決算発表予定/g;
  return [...new Set([...top.matchAll(re)].map((m) => `${KABUTAN}${m[1]}`))];
}

function parseWeeklyArticle(html, refYmd) {
  const text = stripTags(html.slice(html.indexOf('決算発表銘柄(予定)')));
  const refYear = Number(refYmd.slice(0, 4));
  const refMonth = Number(refYmd.slice(5, 7));
  const items = [];
  let date = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const head = line.match(/^●\s*(\d+)月\s*(\d+)日/);
    if (head) {
      const month = Number(head[1]);
      const year = refMonth === 12 && month === 1 ? refYear + 1 : refYear;
      date = `${year}-${String(month).padStart(2, '0')}-${String(head[2]).padStart(2, '0')}`;
      continue;
    }
    const m = date && line.match(/^<\s*(\w+)\s*>\s*(.+?)\s*\[(.+?)\](\s*★)?$/);
    if (m) items.push({ date, code: m[1], name: m[2], market: m[3], star: Boolean(m[4]) });
  }
  return items;
}

async function fetchJpSchedule(today) {
  const errors = [];
  let jpx = [];
  let weekly = [];
  try {
    jpx = await fetchJpxSchedule();
  } catch (err) {
    errors.push(`JPX: ${err.message}`);
  }
  try {
    for (const url of await findWeeklyArticleUrls()) weekly.push(...parseWeeklyArticle(await fetchText(url), today));
  } catch (err) {
    errors.push(`株探: ${err.message}`);
  }
  const stars = new Set(weekly.filter((w) => w.star).map((w) => `${w.date}|${w.code}`));
  // JPX を正とし、無ければ株探の記事(一部省略あり)で代替
  const base = jpx.length ? jpx : weekly.map((w) => ({ ...w, industry: '', kind: '' }));
  const items = base.map((i) => ({ ...i, star: stars.has(`${i.date}|${i.code}`) }));
  return { items, errors, fallback: jpx.length === 0 && weekly.length > 0 };
}

// ---------- 米国: Nasdaq カレンダー + Yahoo 財務 ----------

async function fetchUsDay(ymd) {
  const json = JSON.parse(await fetchText(`${NASDAQ}?date=${ymd}`, { Accept: 'application/json, text/plain, */*' }));
  return (json?.data?.rows ?? [])
    .map((r) => ({
      symbol: r.symbol,
      name: r.name,
      marketCap: toNumber(r.marketCap) ?? 0,
      time: r.time,
      quarter: r.fiscalQuarterEnding,
      epsForecast: r.epsForecast || null,
      epsActual: r.eps || null,
      surprise: r.surprise ?? null,
    }))
    .sort((a, b) => b.marketCap - a.marketCap);
}

async function fetchUsDays(dates) {
  const results = new Map();
  const errors = [];
  await Promise.all(
    dates.map(async (d) => {
      try {
        results.set(d, await fetchUsDay(d));
      } catch (err) {
        errors.push(err.message);
      }
    }),
  );
  return { results, errors };
}

async function yahooSession() {
  try {
    const res = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
    const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const crumb = await (await fetchRaw('https://query1.finance.yahoo.com/v1/test/getcrumb', { Cookie: cookie })).text();
    return { cookie, crumb };
  } catch {
    return null;
  }
}

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const ymOf = (ymd) => ymd.slice(0, 7);

async function fetchUsFinancials(row, session) {
  const [mon, year] = (row.quarter ?? '').split('/');
  if (!MONTHS[mon]) return null;
  const target = `${year}-${String(MONTHS[mon]).padStart(2, '0')}`;
  const prevTarget = `${Number(year) - 1}-${String(MONTHS[mon]).padStart(2, '0')}`;
  const sym = encodeURIComponent(row.symbol.replace(/\./g, '-'));
  const headers = { Cookie: session.cookie };
  const cur = {};
  const prev = {};

  // 直近四半期 (発表直後は売上・純利益のみのことが多い)
  try {
    const j = JSON.parse(
      await fetchText(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=incomeStatementHistoryQuarterly&crumb=${encodeURIComponent(session.crumb)}`,
        headers,
      ),
    );
    const list = j.quoteSummary?.result?.[0]?.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? [];
    const q = list.find((e) => ymOf(e.endDate?.fmt ?? '') === target);
    if (q) {
      cur.rev = q.totalRevenue?.raw ?? null;
      cur.op = q.operatingIncome?.raw ?? null;
      cur.net = q.netIncome?.raw ?? null;
    }
  } catch {
    /* 取得できなければ空欄 */
  }

  // 時系列 (前年同期との比較・営業利益の補完)
  try {
    const p1 = Math.floor(Date.UTC(Number(year) - 2, 0, 1) / 1000);
    const p2 = Math.floor(Date.now() / 1000) + 86400 * 120;
    const j = JSON.parse(
      await fetchText(
        `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${sym}?type=quarterlyTotalRevenue,quarterlyOperatingIncome,quarterlyNetIncome&merge=false&period1=${p1}&period2=${p2}`,
      ),
    );
    const keyMap = { quarterlyTotalRevenue: 'rev', quarterlyOperatingIncome: 'op', quarterlyNetIncome: 'net' };
    for (const r of j.timeseries?.result ?? []) {
      const type = r.meta.type[0];
      for (const e of r[type] ?? []) {
        const v = e.reportedValue?.raw ?? null;
        if (ymOf(e.asOfDate) === target && cur[keyMap[type]] == null) cur[keyMap[type]] = v;
        if (ymOf(e.asOfDate) === prevTarget) prev[keyMap[type]] = v;
      }
    }
  } catch {
    /* 同上 */
  }
  // Yahoo は未反映の項目を 0 で返すことがあるため欠損扱いにする
  for (const o of [cur, prev]) for (const k of Object.keys(o)) if (o[k] === 0) o[k] = null;
  return { cur, prev };
}

async function enrichUsRows(rowsByDate, limit, session) {
  if (!session) return;
  const targets = [];
  for (const rows of rowsByDate) targets.push(...rows.filter((r) => r.epsActual).slice(0, limit));
  await mapLimit(targets, 6, async (row) => {
    row.fin = await fetchUsFinancials(row, session);
  });
}

// ---------- 整形 ----------

const TIME_LABEL = { 'time-pre-market': '寄り前', 'time-after-hours': '引け後', 'time-not-supplied': '時間未定' };

function fmtCap(cap) {
  if (!cap) return '-';
  if (cap >= 1e12) return `$${(cap / 1e12).toFixed(2)}T`;
  if (cap >= 1e9) return `$${(cap / 1e9).toFixed(1)}B`;
  return `$${(cap / 1e6).toFixed(0)}M`;
}

function fmtUsd(v) {
  if (v == null) return '-';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString('en-US')}`;
}

function fmtUsFin(row, key) {
  const cur = row.fin?.cur?.[key];
  if (cur == null) return '-';
  return `${fmtUsd(cur)}${fmtPct(pct(cur, row.fin.prev?.[key]))}`;
}

const fmtSurprise = (s) => {
  const n = toNumber(s);
  return n == null ? '-' : `${n >= 0 ? '+' : ''}${n}%`;
};

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const table = (header, rows) =>
  [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');

function renderJpResults(title, date, items) {
  const out = [`### ${title} (${label(date)})`, ''];
  if (items.length === 0) {
    out.push('_決算速報はありません (休場日、または開示前)。_', '');
    return out;
  }
  const kessan = items.filter((i) => i.kind === '決算');
  const shusei = items.filter((i) => i.kind !== '決算');
  out.push(`決算 ${kessan.length} 件 / 業績修正・配当修正 ${shusei.length} 件`, '');
  if (kessan.length) {
    out.push(
      '**決算発表** (金額は連結/単体の表記どおり、括弧内は前年同期比)',
      '',
      table(
        ['時刻', 'コード', '会社名', '対象期', '売上高', '営業利益', '経常利益', '最終利益', '概要'],
        kessan.map((i) => [
          i.time,
          i.code,
          i.info?.name ?? '-',
          i.info?.period ?? '-',
          i.info ? fmtJpCell(i.info, '売上高') : '-',
          i.info ? fmtJpCell(i.info, '営業益') : '-',
          i.info ? fmtJpCell(i.info, '経常益') : '-',
          i.info ? fmtJpCell(i.info, '最終益') : '-',
          `[${i.title}](${i.url})`,
        ]),
      ),
      '',
    );
  }
  if (shusei.length) {
    out.push('**業績修正など**', '', table(['時刻', 'コード', '概要'], shusei.map((i) => [i.time, i.code, `[${i.title}](${i.url})`])), '');
  }
  return out;
}

function renderJpSchedule(dates, items, errors, fallback) {
  const out = ['### 決算発表予定 (本日から1週間・全件)', ''];
  if (fallback) out.push('_JPXの一覧が取得できなかったため株探の記事で代替しています (件数の多い日は一部省略されます)。_', '');
  for (const d of dates) {
    const day = items.filter((i) => i.date === d).sort((a, b) => a.code.localeCompare(b.code));
    if (!day.length) continue;
    out.push(
      `#### ${label(d)} — ${day.length}社`,
      '',
      table(
        ['コード', '会社名', '市場', '業種', '種別', '注目'],
        day.map((i) => [i.code, i.name, i.market, i.industry, i.kind, i.star ? '★' : '']),
      ),
      '',
    );
  }
  if (!items.length) out.push('_予定を取得できませんでした。_', '');
  for (const e of errors) out.push(`_取得エラー: ${e}_`, '');
  return out;
}

function renderUsResults(title, rows) {
  const reported = rows.filter((r) => r.epsActual);
  const pending = rows.filter((r) => !r.epsActual);
  const out = [`### ${title}`, '', `発表済み ${reported.length} 社 / 発表前 ${pending.length} 社 (時価総額順)`, ''];
  if (reported.length) {
    out.push(
      table(
        ['銘柄', '会社名', '時価総額', '四半期', 'EPS実績', 'EPS予想', 'サプライズ', '売上高', '営業利益', '純利益'],
        reported.map((r) => [
          r.symbol,
          r.name,
          fmtCap(r.marketCap),
          r.quarter,
          r.epsActual,
          r.epsForecast ?? '-',
          fmtSurprise(r.surprise),
          fmtUsFin(r, 'rev'),
          fmtUsFin(r, 'op'),
          fmtUsFin(r, 'net'),
        ]),
      ),
      '',
    );
  }
  if (pending.length) out.push('**発表前**', '', usScheduleTable(pending), '');
  return out;
}

const usScheduleTable = (rows) =>
  table(
    ['銘柄', '会社名', '時価総額', '時間', '四半期', 'EPS予想'],
    rows.map((r) => [r.symbol, r.name, fmtCap(r.marketCap), TIME_LABEL[r.time] ?? r.time, r.quarter, r.epsForecast ?? '-']),
  );

function renderUsSchedule(schedule) {
  const out = ['### 決算発表予定 (翌営業日から1週間・全件)', ''];
  for (const { date, rows } of schedule) {
    out.push(`#### ${label(date)} — ${rows.length}社`, '');
    out.push(rows.length ? usScheduleTable(rows) : '_予定なし_', '');
  }
  return out;
}

// ---------- 収集 (サイト生成と Markdown 出力で共通) ----------

export async function collectReport(opts) {
  const jpToday = opts.date ?? todayIn('Asia/Tokyo');
  const usToday = opts.date ?? todayIn('America/New_York');
  const jpPrev = prevBusinessDay(jpToday);
  const usPrev = prevBusinessDay(usToday);
  const jpWindow = range(jpToday, opts.days + 1); // 本日を含む
  const usWindow = range(addDays(usToday, 1), opts.days).filter(isWeekday);
  const usTodayDates = isWeekday(usToday) ? [usToday] : [];

  const safe = (p) => p.then((value) => ({ value }), (err) => ({ error: err.message }));
  const [jpPrevNews, jpTodayNews, jpSched, us, session] = await Promise.all([
    safe(fetchJpNewsFor(jpPrev).then(enrichJpResults)),
    safe(fetchJpNewsFor(jpToday).then(enrichJpResults)),
    fetchJpSchedule(jpToday),
    fetchUsDays([usPrev, ...usTodayDates, ...usWindow]),
    yahooSession(),
  ]);

  const usResultDates = [usPrev, ...usTodayDates].filter((d) => us.results.has(d));
  await enrichUsRows(usResultDates.map((d) => us.results.get(d)), opts.usDetail, session);

  return {
    generatedAt: new Date().toISOString(),
    date: jpToday,
    usDetail: opts.usDetail,
    yahooConnected: Boolean(session),
    jp: {
      results: [
        { title: '前営業日の決算概要', date: jpPrev, items: jpPrevNews.value ?? [], error: jpPrevNews.error ?? null },
        { title: '本日の決算概要', date: jpToday, items: jpTodayNews.value ?? [], error: jpTodayNews.error ?? null },
      ],
      schedule: { dates: jpWindow, items: jpSched.items, errors: jpSched.errors, fallback: jpSched.fallback },
    },
    us: {
      results: usResultDates.map((d) => ({
        title: `${d === usPrev ? '前営業日' : '本日'}の決算概要`,
        date: d,
        rows: us.results.get(d),
      })),
      schedule: usWindow.filter((d) => us.results.has(d)).map((d) => ({ date: d, rows: us.results.get(d) })),
      errors: us.errors,
    },
  };
}

export function renderMarkdown(report) {
  const md = [`# 決算サマリー (${report.date} JST 作成)`, '', '## 🇯🇵 日本', ''];
  for (const r of report.jp.results) {
    md.push(...(r.error ? [`### ${r.title}`, '', `_取得エラー: ${r.error}_`, ''] : renderJpResults(r.title, r.date, r.items)));
  }
  const s = report.jp.schedule;
  md.push(...renderJpSchedule(s.dates, s.items, s.errors, s.fallback));

  md.push('## 🇺🇸 米国', '');
  for (const r of report.us.results) md.push(...renderUsResults(`${r.title} (${label(r.date)} 米東部時間)`, r.rows));
  if (!report.yahooConnected) md.push('_Yahoo Finance に接続できなかったため、売上高・営業利益は表示していません。_', '');
  md.push(`_${US_FIN_NOTE(report.usDetail)}_`, '');
  md.push(...renderUsSchedule(report.us.schedule));
  for (const e of report.us.errors) md.push(`_取得エラー: ${e}_`, '');
  return md.join('\n');
}

export const US_FIN_NOTE = (n) =>
  `売上高・営業利益・純利益はYahoo Finance由来で、発表直後は営業利益が未反映(-)のことがあります。財務詳細は時価総額上位${n}社/日まで取得。`;

// 再利用する整形ヘルパー (サイト生成用)
export { label, isWeekday, fmtJpCell, fmtUsFin, fmtCap, fmtSurprise, TIME_LABEL };

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await collectReport(opts);
  const text = renderMarkdown(report);
  console.log(text);

  const root = dirname(fileURLToPath(import.meta.url));
  if (opts.save) {
    const dir = join(root, 'output');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `earnings_${report.date}.md`);
    await writeFile(file, text.replace(/\n/g, '\r\n'), 'utf8');
    console.error(`\n保存しました: ${file}`);
  }
  if (opts.json) {
    const dir = join(root, 'data');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${report.date}.json`);
    await writeFile(file, JSON.stringify(report), 'utf8');
    console.error(`保存しました: ${file}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
