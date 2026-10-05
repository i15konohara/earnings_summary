// 決算の理由づけ: 「個別要因」と「外部要因」に分けて整理する。
//   個別要因: LLM(OpenRouter無料モデル)が材料テキストから「理由」を引用付きで抜き出す
//             材料 = 日本: 株探の決算記事(解説文・会社側の説明) / 米国: Yahoo Finance のニュース見出し
//   外部要因: LLMは使わず、「業種 × 市況指標の実測値の変化」のルールで決める
// 誤情報を避けるため、個別要因は材料に引用が実在するものだけ採用し、要約文もLLMには書かせない。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzip } from './earnings_summary.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(ROOT, 'data', 'reasons_cache.json');
const CACHE_VERSION = 'v3'; // 仕様を変えたら上げる (古い結果は使わない)
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) earnings-summary/2.0';

export class QuotaExceededError extends Error {}

// ---------- 設定 (.env) ----------

async function loadEnv() {
  const env = { ...process.env };
  // 自分の .env を優先し、無ければ news_summarizer の .env を流用する
  for (const path of [join(ROOT, '.env'), join(ROOT, '..', 'news_summarizer', '.env')]) {
    try {
      for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {
      /* 無ければ次へ */
    }
  }
  return env;
}

// ---------- 市況指標 ----------

const METRICS = [
  { id: 'fx_usdjpy', label: 'ドル円', symbol: 'USDJPY=X', unit: '円', mode: 'pct' },
  { id: 'dxy', label: 'ドル指数', symbol: 'DX-Y.NYB', unit: '', mode: 'pct' },
  { id: 'oil_wti', label: 'WTI原油', symbol: 'CL=F', unit: 'ドル', mode: 'pct' },
  { id: 'us10y', label: '米10年金利', symbol: '^TNX', unit: '%', mode: 'diff' },
  { id: 'nikkei', label: '日経平均', symbol: '^N225', unit: '円', mode: 'pct' },
  { id: 'sp500', label: 'S&P500', symbol: '^GSPC', unit: '', mode: 'pct' },
];

async function fetchMetric(m) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.symbol)}?range=6mo&interval=1d`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const closes = (await res.json()).chart.result[0].indicators.quote[0].close.filter((x) => x != null);
  const last = closes.at(-1);
  const change = (past) => (m.mode === 'diff' ? last - past : ((last - past) / past) * 100);
  return { ...m, last, chg1w: change(closes.at(-6)), chg3m: change(closes.at(-64)) };
}

export async function fetchMarket() {
  const out = [];
  for (const m of METRICS) {
    try {
      out.push(await fetchMetric(m));
    } catch {
      /* 取得できない指標は使わない */
    }
  }
  return out;
}

export const fmtChg = (m, v) => (m.mode === 'diff' ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}pt` : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
export const marketLine = (m) =>
  `${m.label}: 現在 ${m.last.toLocaleString('en-US', { maximumFractionDigits: 2 })}${m.unit}, 直近1週間 ${fmtChg(m, m.chg1w)}, 直近約3か月 ${fmtChg(m, m.chg3m)}`;

// ---------- 外部要因 (業種 × 市況のルール) ----------

// 約3か月でこれ以上動いた指標だけを要因とみなす
const MOVE_THRESHOLD = { pct: 3, diff: 0.25 };

const US_GLOBAL_SECTORS = ['Technology', 'Consumer Cyclical', 'Consumer Defensive', 'Industrials', 'Healthcare', 'Basic Materials', 'Communication Services'];

// sign: 指標の上昇が追い風なら +1、逆風なら -1。 up / down: 上昇時・下落時の説明
const EXTERNAL_RULES = [
  {
    jp: ['輸送用機器', '電気機器', '機械', '精密機器', 'ゴム製品'],
    metric: 'fx_usdjpy', sign: +1,
    up: '円安は海外売上の円換算額と輸出採算を押し上げる', down: '円高は海外売上の円換算額と輸出採算を押し下げる',
  },
  {
    jp: ['小売業', '食料品', '電気・ガス業', '空運業', 'パルプ・紙'],
    metric: 'fx_usdjpy', sign: -1,
    up: '円安は輸入する原材料・商品の仕入れコストを押し上げる', down: '円高は輸入する原材料・商品の仕入れコストを押し下げる',
  },
  {
    jp: ['空運業', '陸運業', '海運業', '電気・ガス業', '化学'],
    usIndustry: /Airlines|Trucking|Railroads|Marine Shipping/,
    metric: 'oil_wti', sign: -1,
    up: '原油高は燃料・原料コストを押し上げる', down: '原油安は燃料・原料コストを押し下げる',
  },
  {
    jp: ['鉱業', '石油・石炭製品'],
    usSector: ['Energy'],
    metric: 'oil_wti', sign: +1,
    up: '原油高は販売価格と採算を押し上げる', down: '原油安は販売価格と採算を押し下げる',
  },
  {
    jp: ['証券、商品先物取引業'],
    metric: 'nikkei', sign: +1,
    up: '株式市場の上昇は売買・運用関連の収入を押し上げる', down: '株式市場の下落は売買・運用関連の収入を押し下げる',
  },
  {
    usIndustry: /Capital Markets|Asset Management/,
    metric: 'sp500', sign: +1,
    up: '株式市場の上昇は売買・運用関連の収入を押し上げる', down: '株式市場の下落は売買・運用関連の収入を押し下げる',
  },
  {
    usIndustry: /^Banks/,
    metric: 'us10y', sign: +1,
    up: '金利上昇は預貸の利ざや(純金利収入)を広げる', down: '金利低下は預貸の利ざや(純金利収入)を縮める',
  },
  {
    usSector: ['Real Estate', 'Utilities'],
    metric: 'us10y', sign: -1,
    up: '金利上昇は借入コストを押し上げ、資産価値の重荷になる', down: '金利低下は借入コストを押し下げる',
  },
  {
    usSector: US_GLOBAL_SECTORS,
    metric: 'dxy', sign: -1,
    up: 'ドル高は海外売上のドル換算額を押し下げる', down: 'ドル安は海外売上のドル換算額を押し上げる',
  },
];

function ruleMatches(rule, c) {
  if (c.market === 'JP') return Boolean(rule.jp?.includes(c.industry));
  return Boolean(rule.usSector?.includes(c.sector) || (c.usIndustry && rule.usIndustry?.test(c.usIndustry)));
}

export function externalFactors(c, market) {
  const byId = new Map(market.map((m) => [m.id, m]));
  const out = [];
  for (const rule of EXTERNAL_RULES) {
    const m = byId.get(rule.metric);
    if (!m || !ruleMatches(rule, c)) continue;
    if (Math.abs(m.chg3m) < MOVE_THRESHOLD[m.mode]) continue;
    const rising = m.chg3m > 0;
    out.push({
      metric: m.id,
      effect: (rising ? 1 : -1) * rule.sign > 0 ? '追い風' : '逆風',
      reason: rising ? rule.up : rule.down,
      change: `${m.label} 約3か月 ${fmtChg(m, m.chg3m)}`,
    });
  }
  return out;
}

// ---------- 評価 (数値から機械的に決める。LLMには判定させない) ----------

function jpVerdict(info) {
  const y = info.yoy['営業益'] ?? info.yoy['経常益'];
  if (y == null) return '中立';
  if (/^(黒転|黒拡)/.test(y)) return '良い';
  if (/^(赤転|赤拡)/.test(y)) return '悪い';
  const n = Number(y);
  if (Number.isNaN(n)) return '中立';
  return n >= 5 ? '良い' : n <= -5 ? '悪い' : '中立';
}

function usVerdict(row) {
  const s = Number(String(row.surprise ?? '').replace(/[^0-9.-]/g, ''));
  if (row.surprise == null || Number.isNaN(s)) return '中立';
  return s >= 2 ? '良い' : s <= -2 ? '悪い' : '中立';
}

// ---------- 対象の選定 ----------

function fmtJpFig(info, key) {
  const v = info.values[key];
  if (v == null) return '-';
  return `${(v / 1e8).toFixed(1)}億円 (前年比 ${info.yoy[key] ?? '-'})`;
}

function jpCandidates(report) {
  const stars = new Set(report.jp.schedule.items.filter((i) => i.star).map((i) => `${i.date}|${i.code}`));
  const out = [];
  for (const r of report.jp.results) {
    for (const i of r.items) {
      if (i.kind !== '決算' || !i.info?.narrative || !i.info.period) continue;
      const y = i.info.yoy['営業益'] ?? i.info.yoy['経常益'] ?? '';
      const big = /^(黒転|赤転|黒拡|赤拡)/.test(y) || Math.abs(Number(y)) >= 30;
      out.push({
        market: 'JP',
        key: `${CACHE_VERSION}:JP:${i.code}:${i.info.period}`,
        code: i.code,
        name: i.info.name ?? i.code,
        period: i.info.period,
        date: r.date,
        url: i.url,
        industry: i.industry ?? null,
        verdict: jpVerdict(i.info),
        score: (stars.has(`${r.date}|${i.code}`) ? 3 : 0) + (big ? 2 : 0),
        figures: ['売上高', '営業益', '経常益', '最終益'].map((k) => `${k}: ${fmtJpFig(i.info, k)}`).join(' / '),
        material: null, // 後で決算短信の定性情報を取得 (取れなければ株探の解説文)
        fallbackMaterial: i.info.narrative,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function usCandidates(report) {
  const out = [];
  for (const r of report.us.results) {
    for (const row of r.rows) {
      if (!row.epsActual) continue;
      const sur = Math.abs(Number(String(row.surprise ?? '').replace(/[^0-9.-]/g, '')) || 0);
      out.push({
        market: 'US',
        key: `${CACHE_VERSION}:US:${row.symbol}:${row.quarter}`,
        code: row.symbol,
        name: row.name,
        period: row.quarter,
        date: r.date,
        url: `https://finance.yahoo.com/quote/${encodeURIComponent(row.symbol)}`,
        industry: row.fin?.industry ? `${row.fin.sector} / ${row.fin.industry}` : null,
        sector: row.fin?.sector ?? null,
        usIndustry: row.fin?.industry ?? null,
        verdict: usVerdict(row),
        score: (sur >= 10 ? 1e11 : 0) + row.marketCap, // 大きなサプライズ → 時価総額順
        figures:
          `EPS 実績 ${row.epsActual} / 予想 ${row.epsForecast ?? '-'} / サプライズ ${row.surprise ?? '-'}%` +
          (row.fin?.cur?.rev ? ` / 売上高 ${(row.fin.cur.rev / 1e9).toFixed(2)}B USD` : ''),
        material: null, // 後でニュース見出しを取得
        symbol: row.symbol,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------- 日本の材料: TDnet 決算短信 XBRL の定性情報 ----------

const tdnetIndexCache = new Map();

// その日の決算短信の XBRL(zip) URL をコード別に引く (やのしん TDnet WEB-API)
async function tdnetIndex(ymd) {
  if (!tdnetIndexCache.has(ymd)) {
    tdnetIndexCache.set(
      ymd,
      (async () => {
        const res = await fetch(`https://webapi.yanoshin.jp/webapi/tdnet/list/${ymd.replace(/-/g, '')}.json?limit=2000`, {
          headers: { 'User-Agent': UA },
        });
        if (!res.ok) throw new Error(`TDnet一覧 HTTP ${res.status}`);
        const map = new Map();
        for (const { Tdnet: t } of (await res.json()).items ?? []) {
          if (!t?.url_xbrl || !/決算短信/.test(t.title) || /訂正/.test(t.title)) continue;
          map.set(String(t.company_code).slice(0, 4), t.url_xbrl.replace(/^.*?\?(https?:)/, '$1'));
        }
        return map;
      })(),
    );
  }
  return tdnetIndexCache.get(ymd);
}

// 定性情報 (qualitative.htm) から「経営成績の概況」の本文を取り出す
function extractBusinessReview(html) {
  const lines = html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<\/(p|div|tr|h\d)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/[ \t　]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // 目次 (…… を含む行) を飛ばし、本文の見出し「（１）…経営成績…」から次の「（２）」の手前まで
  const start = lines.findIndex((l) => /^[（(]１[）)].*経営成績/.test(l) && !/…/.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^[（(]２[）)]/.test(l));
  if (end < 0) end = Math.min(lines.length, start + 60);
  return lines.slice(start + 1, end).join('\n').slice(0, 4000);
}

async function fetchJpMaterial(code, ymd) {
  try {
    const url = (await tdnetIndex(ymd)).get(code);
    if (!url) return null;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    const name = [...files.keys()].find((k) => /qualitative\.htm$/i.test(k));
    return name ? extractBusinessReview(files.get(name).toString('utf8')) : null;
  } catch {
    return null;
  }
}

async function fetchUsHeadlines(symbol, sinceYmd) {
  const res = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=10&quotesCount=0`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) return null;
  const since = new Date(`${sinceYmd}T00:00:00Z`).getTime() - 86400e3;
  const lines = ((await res.json()).news ?? [])
    .filter((n) => n.providerPublishTime * 1000 >= since)
    .map((n) => `- (${new Date(n.providerPublishTime * 1000).toISOString().slice(0, 10)} ${n.publisher}) ${n.title}`);
  return lines.length ? lines.join('\n') : null;
}

// ---------- LLM (個別要因のみ) ----------

const MATERIAL_LABEL = {
  tdnet: '決算短信「経営成績の概況」(会社による説明)',
  kabutan: '決算に関する解説文',
  news: '決算前後のニュース見出し',
};

function buildPrompt(c) {
  return `次の決算について、業績が「${c.verdict}」になった理由を、材料から抜き出して「個別要因」と「外部要因」に分けてください。

# 対象
${c.name} (${c.code}) ${c.period} / ${c.market === 'JP' ? '日本株' : '米国株'}${c.industry ? ` / 業種: ${c.industry}` : ''}
${c.figures}

# 材料: ${MATERIAL_LABEL[c.materialSource]}
${c.material}

# ルール
- 「なぜそうなったか」という理由だけを書く。売上・利益の増減率や利益率、「最高益」「増配」「予想を下回った」など、結果そのものは理由ではないので書かない。
- individual(個別要因): 会社自身の取り組みや事業の状況。例: 販売数量の増加、値上げ、新規出店、販路拡大、新商品、原価低減、大型案件、販管費の増加、減損、特定事業の不振。
- external(外部要因): 会社の外の環境で、材料の中で業績への影響が述べられているもの。例: 為替、原材料・資材価格、金利、需要動向、規制、天候、地政学リスク。「景気は緩やかに回復」のような一般的な景気の説明だけのものは書かない。
- "evidence" には材料の文をそのまま引用する(40字以内)。言い換えない。
- "factor" は要因を20字以内の日本語で書く。
- 材料に書かれていないことは書かない。該当がなければ空配列にする。
- それぞれ最大3件。出力はJSONのみ(前後に説明文を付けない)。

{"individual":[{"factor":"要因","evidence":"材料からの引用"}],"external":[{"factor":"要因","evidence":"材料からの引用"}]}`;
}

async function callLlm(prompt, env, models) {
  let lastErr = null;
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let res;
      try {
        res = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://i15konohara.github.io/earnings_summary',
            'X-Title': 'Earnings Summary',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 1000,
            // 推論モデルは思考過程を本文に書き出して JSON の前で打ち切られるため、推論を無効にする
            reasoning: { enabled: false },
          }),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (err) {
        lastErr = err;
        if (err.name === 'TimeoutError') break; // 同じモデルでの再試行は無駄なので次のモデルへ
        await sleep(2000 * attempt);
        continue;
      }
      if (res.status === 429) {
        const text = await res.text();
        if (/per-day/.test(text)) throw new QuotaExceededError('OpenRouter無料枠の1日の上限に達しました');
        await sleep(6000 * attempt);
        lastErr = new Error('rate limited');
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        break; // このモデルは諦めて次へ
      }
      const content = (await res.json()).choices?.[0]?.message?.content;
      if (content) return { content, model };
      lastErr = new Error('empty response');
    }
  }
  throw lastErr ?? new Error('LLM call failed');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 出力の検証 ----------

const normalize = (s) => String(s).replace(/[\s「」『』"'“”…。、,.・]/g, '').toLowerCase();

// 引用が材料に実在するか (部分一致、または4文字連続の一致率で判定)
function isGrounded(evidence, material) {
  const e = normalize(evidence);
  const m = normalize(material);
  if (e.length < 4) return false;
  if (m.includes(e)) return true;
  const grams = new Set();
  for (let i = 0; i + 4 <= e.length; i++) grams.add(e.slice(i, i + 4));
  let hit = 0;
  for (const g of grams) if (m.includes(g)) hit++;
  return hit / grams.size >= 0.7;
}

// 本文中の JSON を取り出す (前置きの文章やコードフェンスが混ざっても、individual を持つ最後の JSON を採用)
function extractJson(content) {
  const text = content.replace(/```(?:json)?/g, '');
  const end = text.lastIndexOf('}');
  for (let i = text.lastIndexOf('{', end); i >= 0; i = text.lastIndexOf('{', i - 1)) {
    try {
      const data = JSON.parse(text.slice(i, end + 1));
      if (data && typeof data === 'object' && 'individual' in data) return data;
    } catch {
      /* 次の候補へ */
    }
    if (i === 0) break;
  }
  return null;
}

// 結果の言い換えだけの要因を除く (例: 「経常利益の大幅増」「予想を下回る」)
const RESULT_ONLY = new RegExp(
  [
    '^(大幅な?)?(売上高?|営業利益|経常利益|最終利益|純利益|利益|収益|EPS)(の|が)?(大幅)?(増加|減少|増|減|拡大|縮小|改善|悪化|上振れ|下振れ)$',
    '^(過去)?最高益(の更新|更新)?$',
    '^(連続)?(増配|減配|増収|減収|増益|減益)(方針|の達成)?$',
    '^(損失|赤字|黒字)(の)?(縮小|拡大|転換|転落)$',
    '予想(を)?(上回|下回)',
  ].join('|'),
);

// 引用が数値の増減だけ (例: 「前年同期比1,339百万円の減少」) なら理由ではない
const NUMERIC_ONLY_EVIDENCE = /^[^぀-ヿ一-鿿]*[\d,.０-９]+[^぀-ヿ一-鿿]*(百万円|億円|千円|円|%|％|ポイント|pt)?の?(増加|減少|増|減|改善|悪化)?(しました|となりました)?$|^(前年同期比|前期比|前年比)[\d,.０-９]/;
// 今後のリスクへの注意書きは、業績の理由ではない
const CAVEAT_EVIDENCE = /留意|注視|不透明|先行き|見通せ|懸念され|可能性があ/;
const NET_LOSS_ONLY = /net loss.*narrow|lag estimates|beat estimates|top estimates|miss(es)? estimates/i;

export function isReasonLike(x) {
  const factor = String(x.factor).trim();
  const evidence = String(x.evidence).trim();
  return !RESULT_ONLY.test(factor) && !NUMERIC_ONLY_EVIDENCE.test(evidence) && !CAVEAT_EVIDENCE.test(evidence) && !NET_LOSS_ONLY.test(evidence);
}

const groundedFactors = (list, material) =>
  (Array.isArray(list) ? list : [])
    .filter((x) => x?.factor && x?.evidence && isGrounded(x.evidence, material) && isReasonLike(x))
    .slice(0, 3)
    .map((x) => ({ factor: String(x.factor).trim().slice(0, 40), evidence: String(x.evidence).trim().slice(0, 80) }));

// キャッシュ済みの結果にも最新のフィルタを適用し、要約を組み直す
function refine(result) {
  const individual = result.individual.filter(isReasonLike);
  const cited = (result.cited ?? []).filter(isReasonLike);
  return { ...result, individual, cited, summary: composeSummary(individual, cited, result.external) };
}

// 形式不正なら null (キャッシュせず次回再試行)。要因は引用が材料に実在するものだけ残す
function validateFactors(content, material) {
  const data = extractJson(content);
  if (!data || !Array.isArray(data.individual)) return null;
  return { individual: groundedFactors(data.individual, material), cited: groundedFactors(data.external, material) };
}

// 要約はLLMに書かせず、検証済みの要因から組み立てる
function composeSummary(individual, cited, market) {
  const parts = [];
  if (individual.length) parts.push(`個別要因: ${individual.map((i) => i.factor).join('、')}`);
  const ext = [...cited.map((e) => e.factor), ...market.map((e) => `${e.change}(${e.effect})`)];
  if (ext.length) parts.push(`外部要因: ${ext.join('、')}`);
  return parts.length ? parts.join(' / ') : '材料から要因を特定できませんでした';
}

// ---------- 公開API ----------

async function loadCache() {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export async function generateReasons(report, { max = 25, log = console.error } = {}) {
  const env = await loadEnv();
  const cache = await loadCache();
  const market = await fetchMarket();
  report.market = market;
  report.reasons = [];

  const maxJp = Math.ceil(max / 2);
  const maxUs = max - maxJp;
  const picked = [...jpCandidates(report).slice(0, maxJp), ...usCandidates(report).slice(0, maxUs)];
  const models = [env.OPENROUTER_MODEL, ...(env.OPENROUTER_FALLBACK_MODELS ?? '').split(',')].map((s) => s?.trim()).filter(Boolean);
  const canCall = Boolean(env.OPENROUTER_API_KEY) && models.length > 0;
  if (!canCall) log('[reasons] APIキー/モデルが無いため、新規の個別要因の抽出はスキップします (キャッシュのみ使用)');

  let quotaHit = false;
  let created = 0;
  for (const c of picked) {
    let result = cache[c.key];
    if (!result && canCall && !quotaHit) {
      try {
        if (c.market === 'US') {
          c.material = await fetchUsHeadlines(c.symbol, c.date);
          c.materialSource = 'news';
        } else {
          c.material = await fetchJpMaterial(c.code, c.date);
          c.materialSource = c.material ? 'tdnet' : 'kabutan';
          c.material ??= c.fallbackMaterial;
        }
        if (c.material) {
          const { content, model } = await callLlm(buildPrompt(c), env, models);
          const factors = validateFactors(content, c.material);
          if (factors) {
            // 市況による外部要因は生成時点の実測値で固定して保存する
            const external = externalFactors(c, market);
            result = {
              individual: factors.individual,
              cited: factors.cited,
              external,
              source: c.materialSource,
              summary: composeSummary(factors.individual, factors.cited, external),
              model,
              generatedAt: new Date().toISOString(),
            };
            cache[c.key] = result;
            created++;
          } else {
            log(`[reasons] ${c.key}: 出力の形式が不正のため破棄 (${model})`);
            if (process.env.REASONS_DEBUG) log(content.slice(0, 1200));
          }
          await sleep(3500); // 無料枠のレート制限対策
        }
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          quotaHit = true;
          log(`[reasons] ${err.message}。残りは次回実行に回します`);
        } else {
          log(`[reasons] ${c.key}: ${err.message}`);
        }
      }
    }
    // 個別要因も外部要因も無いものは表示しない
    if (result) result = refine(result);
    if (result && (result.individual.length || result.cited.length || result.external.length)) {
      report.reasons.push({
        market: c.market, code: c.code, name: c.name, period: c.period, date: c.date, url: c.url,
        industry: c.industry, verdict: c.verdict, figures: c.figures, ...result,
      });
    }
  }
  if (created) await writeFile(CACHE_FILE, JSON.stringify(cache, null, 1), 'utf8');
  log(`[reasons] 対象 ${picked.length} 件 / 表示 ${report.reasons.length} 件 / 新規生成 ${created} 件`);
}
