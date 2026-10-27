/* ============================================================
   気象庁「過去の気象データ検索」日別値の自動取得スクリプト
   - 取得元: https://www.data.jma.go.jp/stats/etrn/ （気象庁ホームページ）
   - 送信する情報: 地点番号・年月のみ（社内データは送信しない）
   - 出力:
       data_store.json   … 取得済みデータの保存（このフォルダ）
       ../weather_data.js … 気象データ分析.html が起動時に読み込むファイル
   使い方:
       node fetch_jma.js              … 足りない月＋直近2か月を取り直し（毎日の自動実行用）
       node fetch_jma.js --from 2020  … 指定年から取り直し
       node fetch_jma.js --normals    … 平年値も取り直し
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

// ---- 設定 ----
const STATIONS = [
  { name: "沼田",       prec: 42, block: "0346" },
  { name: "菊川牧之原", prec: 50, block: "1335" },
  { name: "酸ケ湯",     prec: 31, block: "1079" },
  { name: "黒石",       prec: 31, block: "0167" },
];
const START_YEAR = 1996;          // 初回取得の開始年
const REFETCH_MONTHS = 2;         // 毎回取り直す直近の月数（速報値の修正を反映）
const WAIT_MS = 1000;             // アクセス間隔（気象庁サーバーへの負荷配慮）
const BASE = "https://www.data.jma.go.jp/stats/etrn/view";
const DIR = __dirname;
const STORE = path.join(DIR, "data_store.json");
const OUT_JS = path.join(DIR, "..", "weather_data.js");

// ---- 引数 ----
const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
const FORCE_FROM = fromIdx >= 0 ? parseInt(args[fromIdx + 1], 10) : null;
const FORCE_NORMALS = args.includes("--normals");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const log = (...a) => console.log(new Date().toLocaleString("ja-JP"), ...a);

async function get(url) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "weather-analysis-tool (daily fetch, 1 req/sec)" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } catch (e) {
      if (i === 3) throw e;
      await sleep(3000 * i);
    }
  }
}

// セル文字列 → 数値
// 品質記号: ")"準正常値・"]"資料不足値 = 値として採用（気象庁CSVでも値が入る）/ "×"欠測・"///"観測なし・"#"疑問値 = 欠測 / "--"=現象なし
function cellNum(s, isPrecip) {
  let t = String(s).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, "").trim();
  if (t === "--") return isPrecip ? 0 : null;
  if (!t || /[×#]/.test(t) || t.includes("///")) return null;
  t = t.replace(/[\)\]]/g, "").trim();
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}
const rowCells = (row) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);

// 日別値ページの解析（列位置は見出しの colgroup から算出）
function parseDaily(html, y, m) {
  const groups = [...html.matchAll(/<th[^>]*colspan="(\d+)"[^>]*scope="colgroup"[^>]*>([^<]*)/g)];
  let col = 1, pCol = null, tCol = null;
  for (const g of groups) {
    const name = g[2].trim(), span = +g[1];
    if (name === "降水量" && pCol == null) pCol = col;
    if (name === "気温" && tCol == null) tCol = col;
    if (pCol != null && tCol != null) break;
    col += span;
  }
  if (pCol == null || tCol == null) throw new Error("見出し（降水量/気温）が見つかりません");
  const out = {};
  const rows = html.split('<tr class="mtx" style="text-align:right;">').slice(1);
  for (const row of rows) {
    const c = rowCells(row.split("</tr>")[0]);
    const day = parseInt(String(c[0]).replace(/<[^>]*>/g, ""), 10);
    if (!day) continue;
    const rec = {
      precip: cellNum(c[pCol], true),
      temp: cellNum(c[tCol]),
      tmax: cellNum(c[tCol + 1]),
      tmin: cellNum(c[tCol + 2]),
    };
    if (rec.precip == null && rec.temp == null && rec.tmax == null && rec.tmin == null) continue;
    out[`${y}-${pad(m)}-${pad(day)}`] = rec;
  }
  return out;
}

// 平年値（日別）ページの解析
function parseNormals(html, m) {
  const heads = [...html.matchAll(/<th[^>]*>([^<]*)/g)].map((x) => x[1].trim());
  const order = [];
  for (const h of heads) {
    if (h === "降水量") order.push("precip");
    else if (h === "平均気温") order.push("temp");
    else if (h === "日最高気温") order.push("tmax");
    else if (h === "日最低気温") order.push("tmin");
    else if (/^(日照時間|降雪の深さ合計|最深積雪)$/.test(h)) order.push(null);
    if (h === "統計期間") break;
  }
  const out = {};
  const rows = html.split(/<tr class="mtx"[^>]*>/).slice(1);
  for (const row of rows) {
    const body = row.split("</tr>")[0];
    const th = body.match(/<th[^>]*>([\s\S]*?)<\/th>/);           // 日付は <th> に入っている
    const m1 = th && th[1].replace(/<[^>]*>/g, "").trim().match(/^(\d+)日$/);
    if (!m1) continue;
    const c = rowCells(body);
    const rec = {};
    order.forEach((k, i) => { if (k) rec[k] = cellNum(c[i], k === "precip"); });
    out[`${pad(m)}-${pad(+m1[1])}`] = rec;
  }
  return out;
}

// 保存データの読込。data_store.json が無い環境（GitHub上の自動実行など）では weather_data.js から復元する
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch {}
  try {
    const t = fs.readFileSync(OUT_JS, "utf8").replace(/^\s*window\.WEATHER_AUTO\s*=\s*/, "").replace(/;\s*$/, "");
    const A = JSON.parse(t), s = { stations: {} };
    for (const n of A.stations) s.stations[n] = { records: A.records[n] || {}, normals: (A.normals || {})[n] || {} };
    return s;
  } catch { return { stations: {} }; }
}
// weather_data.js を「1日1行」で書き出す（毎日の更新で変わるのが直近の行だけになり、履歴が小さく済む）
function serializeAuto(p) {
  const L = [`window.WEATHER_AUTO={"generatedAt":${JSON.stringify(p.generatedAt)},"source":${JSON.stringify(p.source)},"stations":${JSON.stringify(p.stations)},`];
  ["records", "normals"].forEach((k, ki) => {
    L.push(`${JSON.stringify(k)}:{`);
    p.stations.forEach((st, si) => {
      const obj = p[k][st] || {}, keys = Object.keys(obj).sort();
      L.push(`${JSON.stringify(st)}:{`);
      keys.forEach((d, i) => L.push(`${JSON.stringify(d)}:${JSON.stringify(obj[d])}${i < keys.length - 1 ? "," : ""}`));
      L.push(`}${si < p.stations.length - 1 ? "," : ""}`);
    });
    L.push(`}${ki === 0 ? "," : ""}`);
  });
  L.push("};");
  return L.join("\n") + "\n";
}
function writeAtomic(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

async function main() {
  const store = loadStore();
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  let reqs = 0, errs = 0;

  for (const st of STATIONS) {
    const s = (store.stations[st.name] ||= { records: {}, normals: {} });
    // 取得開始月: 指定 or（保存済みの最終日の月 − 直近2か月）or 開始年
    const dates = Object.keys(s.records).sort();
    let y, m;
    if (FORCE_FROM) { y = FORCE_FROM; m = 1; }
    else if (dates.length) {
      const last = dates[dates.length - 1];
      const d = new Date(+last.slice(0, 4), +last.slice(5, 7) - 1 - (REFETCH_MONTHS - 1), 1);
      y = d.getFullYear(); m = d.getMonth() + 1;
    } else { y = START_YEAR; m = 1; }

    let added = 0;
    while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
      const url = `${BASE}/daily_a1.php?prec_no=${st.prec}&block_no=${st.block}&year=${y}&month=${m}&day=&view=`;
      try {
        const recs = parseDaily(await get(url), y, m);
        for (const [d, r] of Object.entries(recs)) {
          if (d >= today) continue; // 当日分は観測途中のため除外
          if (!s.records[d]) added++;
          s.records[d] = r;
        }
      } catch (e) { errs++; log(`⚠ ${st.name} ${y}/${m} 取得失敗: ${e.message}`); }
      reqs++;
      await sleep(WAIT_MS);
      if (++m > 12) { m = 1; y++; }
    }

    if (FORCE_NORMALS || Object.keys(s.normals).length < 360) {
      for (let mm = 1; mm <= 12; mm++) {
        const url = `${BASE}/nml_amd_d.php?prec_no=${st.prec}&block_no=${st.block}&year=&month=${mm}&day=&view=`;
        try { Object.assign(s.normals, parseNormals(await get(url), mm)); }
        catch (e) { errs++; log(`⚠ ${st.name} 平年値${mm}月 取得失敗: ${e.message}`); }
        reqs++;
        await sleep(WAIT_MS);
      }
    }
    const ds = Object.keys(s.records).sort();
    log(`${st.name}: ${ds[0]} 〜 ${ds[ds.length - 1]}（${ds.length}日, 今回新規 ${added}日）`);
  }

  store.updatedAt = new Date().toISOString();
  writeAtomic(STORE, JSON.stringify(store));

  const payload = {
    generatedAt: store.updatedAt,
    source: "気象庁ホームページ「過去の気象データ検索」",
    stations: STATIONS.map((s) => s.name),
    records: Object.fromEntries(STATIONS.map((s) => [s.name, store.stations[s.name].records])),
    normals: Object.fromEntries(STATIONS.map((s) => [s.name, store.stations[s.name].normals])),
  };
  writeAtomic(OUT_JS, serializeAuto(payload));
  log(`完了: ${reqs}回アクセス, エラー${errs}件 → ${OUT_JS}`);
  if (errs) process.exitCode = 1;
}

main().catch((e) => { log("致命的エラー:", e.message); process.exit(2); });
