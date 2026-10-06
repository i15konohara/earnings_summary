// TDnet(適時開示)の決算短信: 日本の決算の「抜け」を防ぐための正の一覧と、XBRLサマリーからの数値取得
//   一覧: やのしん TDnet WEB-API (1日1,000件超でも全件取れる)
//   数値: 決算短信XBRL(zip)の Summary/*-ixbrl.htm (売上高・営業利益・経常利益・純利益と前年比)
// TDnet の XBRL は公開から約1か月で消えるため、それより古い日付の補完はできない。

import { inflateRawSync } from 'node:zlib';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) earnings-summary/2.0';

// ---------- zip ----------

export function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('zip ではありません');
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

// ---------- 決算短信の一覧 ----------

// 新しい決算の決算短信だけを残す。除外するもの:
//   訂正 / 期中レビュー完了などに伴う再提出 / ETF・投信・REIT(会計基準〔〕が無い・REIT表記) / TOKYO PRO Market(Ｐ－) ・REIT(Ｒ－)
export function isNewEarningsReport(t) {
  if (!t?.title || !/決算短信/.test(t.title)) return false;
  if (/訂正|期中レビュー|開示事項の変更|お知らせ|REIT|ＲＥＩＴ/.test(t.title)) return false;
  if (!/[〔［\[](日本基準|ＩＦＲＳ|IFRS|米国基準|ＪＭＩＳ|JMIS)/.test(t.title)) return false;
  return !/^[ＰＲ]－/.test(t.company_name ?? '');
}

const listCache = new Map();

// その日の新しい決算短信 (コード → 開示情報)。同じ会社が複数出していれば最初の1件
export function listEarnings(ymd) {
  if (!listCache.has(ymd)) {
    listCache.set(
      ymd,
      (async () => {
        const json = await fetchListJson(ymd);
        const map = new Map();
        for (const t of json.items) {
          if (!isNewEarningsReport(t) || !t.url_xbrl) continue;
          const code = String(t.company_code).slice(0, 4);
          if (map.has(code)) continue;
          map.set(code, {
            code,
            name: t.company_name,
            title: t.title,
            pubdate: t.pubdate,
            xbrlUrl: t.url_xbrl.replace(/^.*?\?(https?:)/, '$1'),
            pdfUrl: t.document_url ? t.document_url.replace(/^.*?\?(https?:)/, '$1') : null,
          });
        }
        return map;
      })(),
    );
    // 失敗した結果はキャッシュに残さない (次の呼び出しで取り直す)
    listCache.get(ymd).catch(() => listCache.delete(ymd));
  }
  return listCache.get(ymd);
}

// 一覧を取得する。要素は日によって {Tdnet: {...}} で包まれている形と、包まれていない形の両方があるのでそろえる。
// 「総数はあるのに中身が無い」応答のときは取り直す
async function fetchListJson(ymd, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://webapi.yanoshin.jp/webapi/tdnet/list/${ymd.replace(/-/g, '')}.json?limit=5000`, {
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) throw new Error(`TDnet一覧 ${ymd}: HTTP ${res.status}`);
    const json = await res.json();
    const items = (Array.isArray(json.items) ? json.items : Object.values(json.items ?? {}))
      .map((x) => x?.Tdnet ?? x)
      .filter((t) => t?.title);
    if (!(json.total_count > 0 && items.length === 0)) return { ...json, items };
    if (attempt >= retries) throw new Error(`TDnet一覧 ${ymd}: 総数 ${json.total_count} 件に対し中身が空の応答`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

export async function fetchXbrlFiles(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`XBRL HTTP ${res.status}`);
  return unzip(Buffer.from(await res.arrayBuffer()));
}

// ---------- XBRL サマリー ----------

// 項目ごとの要素名 (日本基準 / IFRS / 米国基準の順に探す)。IFRS は経常利益が無いため税引前利益で代替する(株探と同じ扱い)
const ITEMS = {
  売上高: ['NetSales', 'OperatingRevenues', 'OrdinaryRevenues', 'NetSalesIFRS', 'SalesIFRS', 'RevenueIFRS', 'OperatingRevenuesIFRS', 'NetSalesUS', 'RevenuesUS'],
  営業益: ['OperatingIncome', 'OperatingProfitIFRS', 'OperatingIncomeIFRS', 'OperatingIncomeUS'],
  経常益: ['OrdinaryIncome', 'ProfitBeforeTaxIFRS', 'IncomeBeforeIncomeTaxesUS'],
  最終益: ['ProfitAttributableToOwnersOfParent', 'NetIncome', 'ProfitAttributableToOwnersOfParentIFRS', 'NetIncomeAttributableToOwnersOfParentUS', 'NetIncomeUS'],
};

// 実績の文脈: 累計四半期 (CurrentAccumulatedQ2Duration_...) か通期 (CurrentYearDuration_...)。前年同期 (Prior...) も読む
const CONTEXT_RE = /^(Current|Prior)(?:AccumulatedQ([1-3])|Year)Duration_(Consolidated|NonConsolidated)Member_ResultMember$/;

// 会社が前年比を「－」にしている(赤字が絡む)場合は、株探と同じ表記を前年同期の値から求める
function yoyText(cur, prev) {
  if (cur == null || prev == null) return null;
  if (prev > 0 && cur < 0) return '赤転';
  if (prev < 0 && cur > 0) return '黒転';
  if (prev < 0 && cur < 0) return cur > prev ? '赤縮' : '赤拡';
  if (prev === 0) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

// 株探と同じ形式の決算期ラベル: 通期 "2027.02" / 累計四半期 "26.03-08"
export function periodLabel(fiscalYearEnd, quarter) {
  const [y, m] = fiscalYearEnd.split('-').map(Number);
  if (!quarter) return `${y}.${pad2(m)}`;
  const startMonth = (m % 12) + 1;
  const startYear = startMonth === 1 ? y : y - 1;
  const endMonth = ((startMonth - 1 + 3 * quarter - 1) % 12) + 1;
  return `${String(startYear).slice(2)}.${pad2(startMonth)}-${pad2(endMonth)}`;
}

// Summary が無い決算短信 (新設会社の最初の決算など) 用: 添付の損益計算書(PL)のXBRLから読む
const PL_ITEMS = {
  売上高: ['NetSales', 'OperatingRevenue1', 'Revenue', 'RevenueIFRS'],
  営業益: ['OperatingIncome', 'OperatingProfitLoss'],
  経常益: ['OrdinaryIncome', 'ProfitLossBeforeTax'],
  最終益: ['ProfitLossAttributableToOwnersOfParent', 'ProfitLoss'],
};

function parseStatements(files) {
  const name = [...files.keys()].find((k) => /Attachment\/.*-[a-z]*pl\d*-.*ixbrl\.htm$/i.test(k));
  if (!name) return null;
  const html = files.get(name).toString('utf8');
  const attr = (a, k) => a.match(new RegExp(`${k}="([^"]*)"`))?.[1];
  const facts = [];
  for (const m of html.matchAll(/<ix:nonFraction([^>]*)>([\s\S]*?)<\/ix:nonFraction>/g)) {
    const ctx = attr(m[1], 'contextRef')?.match(/^(Current|Prior)(YTD|Year)Duration$/);
    const text = m[2].replace(/<[^>]+>/g, '').replace(/,/g, '').trim();
    if (!ctx || !/^\d+(\.\d+)?$/.test(text)) continue;
    facts.push({
      name: attr(m[1], 'name')?.replace(/^.*:/, ''),
      current: ctx[1] === 'Current',
      value: Number(text) * (attr(m[1], 'sign') === '-' ? -1 : 1) * 10 ** Number(attr(m[1], 'scale') ?? 0),
    });
  }
  const values = {};
  const yoy = {};
  for (const [key, names] of Object.entries(PL_ITEMS)) {
    for (const n of names) {
      const v = facts.find((f) => f.current && f.name === n);
      if (!v) continue;
      values[key] = v.value;
      yoy[key] = yoyText(v.value, facts.find((f) => !f.current && f.name === n)?.value ?? null);
      break;
    }
  }
  // ファイル名の期末日から決算期ラベルを作る (例: tse-qcedjpfr-94440-2026-08-08-01-... → 四半期 2026-08-08)
  const m = name.match(/-([aq])[a-z]*edjp[a-z]*-\w+-(\d{4})-(\d{2})-(\d{2})-/);
  if (!m || !Object.keys(values).length) return null;
  return {
    name: null,
    period: m[1] === 'q' ? `${m[2].slice(2)}.${m[3]}.${m[4]}期末(四半期)` : `${m[2]}.${m[3]}`,
    values,
    yoy,
    narrative: null,
    consolidated: /-[aq]c/.test(name),
  };
}

export function parseSummary(files) {
  const name = [...files.keys()].find((k) => /Summary\/.*ixbrl\.htm$/i.test(k));
  if (!name) return parseStatements(files);
  const html = files.get(name).toString('utf8');
  const attr = (a, k) => a.match(new RegExp(`${k}="([^"]*)"`))?.[1];

  const facts = [];
  for (const m of html.matchAll(/<ix:nonFraction([^>]*)>([\s\S]*?)<\/ix:nonFraction>/g)) {
    const ctx = attr(m[1], 'contextRef')?.match(CONTEXT_RE);
    if (!ctx) continue;
    const text = m[2].replace(/<[^>]+>/g, '').replace(/,/g, '').trim();
    if (!/^\d+(\.\d+)?$/.test(text)) continue;
    const value = Number(text) * (attr(m[1], 'sign') === '-' ? -1 : 1);
    facts.push({
      name: attr(m[1], 'name')?.replace(/^.*:/, ''),
      current: ctx[1] === 'Current',
      quarter: ctx[2] ? Number(ctx[2]) : null,
      consolidated: ctx[3] === 'Consolidated',
      value,
      scale: Number(attr(m[1], 'scale') ?? 0),
    });
  }
  // 連結があれば連結、無ければ単体
  const consolidated = facts.some((f) => f.current && f.consolidated);
  const use = facts.filter((f) => f.consolidated === consolidated);
  const current = use.filter((f) => f.current);
  if (!current.length) return null;
  const amount = (f) => (f ? f.value * 10 ** f.scale : null);

  const values = {};
  const yoy = {};
  for (const [key, names] of Object.entries(ITEMS)) {
    for (const n of names) {
      const v = current.find((f) => f.name === n);
      if (!v) continue;
      values[key] = amount(v);
      // 前年比は株探と同じ "+12.3" 形式。会社発表の値を優先し、「－」なら前年同期から求める
      const c = current.find((f) => f.name === `ChangeIn${n}`);
      const prev = amount(use.find((f) => !f.current && f.name === n));
      yoy[key] = c ? `${c.value >= 0 ? '+' : ''}${(c.value * 10 ** (c.scale + 2)).toFixed(1)}` : yoyText(values[key], prev);
      break;
    }
  }
  const fiscalYearEnd = html.match(/name="[^"]*FiscalYearEnd"[^>]*>([\s\S]*?)<\/ix:nonNumeric>/)?.[1].replace(/<[^>]+>/g, '').trim();
  const companyName = html.match(/name="[^"]*CompanyName"[^>]*>([\s\S]*?)<\/ix:nonNumeric>/)?.[1].replace(/<[^>]+>/g, '').trim();
  if (!fiscalYearEnd || !/^\d{4}-\d{2}-\d{2}$/.test(fiscalYearEnd) || !Object.keys(values).length) return null;
  return {
    name: companyName?.replace(/[\s　]+/g, '').replace(/^株式会社|株式会社$/g, '') || null,
    period: periodLabel(fiscalYearEnd, current[0].quarter),
    values,
    yoy,
    narrative: null,
    consolidated,
  };
}

// 決算短信1件を、株探の決算記事と同じ形の item にする。
// XBRL から数値を読めなくても、決算があったこと自体は一覧から落とさない (数値なし・PDFへのリンクのみ)
export async function earningsItem(doc, date) {
  const info = parseSummary(await fetchXbrlFiles(doc.xbrlUrl)) ?? {
    name: null,
    period: `${doc.pubdate?.slice(0, 10) ?? date}開示`,
    values: {},
    yoy: {},
    narrative: null,
  };
  return {
    date,
    time: doc.pubdate?.slice(11, 16) ?? '',
    code: doc.code,
    kind: '決算',
    url: doc.pdfUrl ?? doc.xbrlUrl,
    title: doc.title,
    info: { ...info, name: info.name ?? doc.name.replace(/[\s　]+/g, '') },
    source: 'tdnet',
  };
}
