/* ============================================================
   気象庁「過去の気象データ検索」日別値の自動取得スクリプト（地点ごとのファイル版）
   - 取得元: https://www.data.jma.go.jp/stats/etrn/ （気象庁ホームページ）
   - 送信する情報: 地点番号・年月のみ（社内データは送信しない）
   - 設定: このフォルダの stations_config.json … データを取る地点（地点番号 block と名前）
           このフォルダの amedas_master.json   … 全国の気温観測地点（build_master.js で作成）
   - 出力（1つ上のフォルダ = HTML と同じ場所）:
       stations.js        … 地点一覧（取得済み地点＋全国の地点。画面の地点選択・現在地検索に使う）
       data/<地点番号>.js … 地点ごとの日別データと平年値（画面で選んだ地点だけ読み込む）
   使い方:
       node fetch_jma.js              … 毎日の自動実行用（直近2か月を取り直し＋新しい地点は過去30年分を少しずつ）
       node fetch_jma.js --normals    … 平年値も取り直し
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const START_YEAR = +process.env.START_YEAR || 1996; // 新しい地点の取得開始年（約30年分。テスト時のみ環境変数で変更）
const REFETCH_MONTHS = 2;         // 毎回取り直す直近の月数（速報値の修正を反映）
const MAX_BACKFILL = 3;           // 1回の実行で過去30年分を取り込む新しい地点の数（気象庁サーバーへの負荷配慮）
const WAIT_MS = 1000;             // アクセス間隔
const BASE = "https://www.data.jma.go.jp/stats/etrn/view";
const DIR = __dirname;
const ROOT = path.join(DIR, "..");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG = path.join(DIR, "stations_config.json");
const MASTER = path.join(DIR, "amedas_master.json");
const OUT_STATIONS = path.join(ROOT, "stations.js");
const LEGACY_JS = path.join(ROOT, "weather_data.js"); // 旧形式（初回の移行にだけ使う）

const FORCE_NORMALS = process.argv.includes("--normals");
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
  let t = String(s).replace(/<[^>]*>/g, "").replace(/&nbsp;|&#64;/g, "").trim();
  if (t === "--") return isPrecip ? 0 : null;
  if (!t || /[×#]/.test(t) || t.includes("///")) return null;
  t = t.replace(/[\)\]]/g, "").trim();
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}
const rowCells = (row) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);

// 日別値ページの解析（列位置は見出しの colgroup から算出。アメダス/気象台どちらにも対応）
function parseDaily(html, y, m) {
  const groups = [...html.matchAll(/<th[^>]*colspan="(\d+)"[^>]*scope="colgroup"[^>]*>([^<]*)/g)];
  let col = 1, pCol = null, tCol = null;
  for (const g of groups) {
    const name = g[2].trim(), span = +g[1];
    if (name.startsWith("降水量") && pCol == null) pCol = col;
    if (name.startsWith("気温") && tCol == null) tCol = col;
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
    const rec = { precip: cellNum(c[pCol], true), temp: cellNum(c[tCol]), tmax: cellNum(c[tCol + 1]), tmin: cellNum(c[tCol + 2]) };
    if (rec.precip == null && rec.temp == null && rec.tmax == null && rec.tmin == null) continue;
    out[`${y}-${pad(m)}-${pad(day)}`] = rec;
  }
  return out;
}

// 平年値（日別）ページの解析
function parseNormals(html, m) {
  const heads = [...html.matchAll(/<th[^>]*>([^<]*)/g)].map((x) => x[1].trim());
  const order = [];
  let started = false;
  for (const h of heads) {
    if (h === "要素") { started = true; continue; }
    if (!started) continue;
    if (h === "統計期間") break;
    if (h === "降水量") order.push("precip");
    else if (h === "平均気温") order.push("temp");
    else if (h === "日最高気温" || h === "最高気温") order.push("tmax");
    else if (h === "日最低気温" || h === "最低気温") order.push("tmin");
    else order.push(null);
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

function writeAtomic(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}
// 「window.X=...;」形式のJSファイルからオブジェクトを読む
function readJsVar(file, re) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(re, "").replace(/;\s*$/, "")); } catch { return null; }
}
// 地点データを「1日1行」で書き出す（毎日の更新で変わるのが直近の行だけになり、履歴が小さく済む）
function serializeStation(block, d) {
  const L = [`window.WEATHER_DATA=window.WEATHER_DATA||{};window.WEATHER_DATA[${JSON.stringify(block)}]={"block":${JSON.stringify(block)},"label":${JSON.stringify(d.label)},"generatedAt":${JSON.stringify(d.generatedAt)},`];
  ["records", "normals"].forEach((k, ki) => {
    const obj = d[k] || {}, keys = Object.keys(obj).sort();
    L.push(`${JSON.stringify(k)}:{`);
    keys.forEach((x, i) => L.push(`${JSON.stringify(x)}:${JSON.stringify(obj[x])}${i < keys.length - 1 ? "," : ""}`));
    L.push(`}${ki === 0 ? "," : ""}`);
  });
  L.push("};");
  return L.join("\n") + "\n";
}

async function fetchMonths(st, s, y, m, today, now, counter) {
  let added = 0;
  const page = st.type === "s" ? "daily_s1.php" : "daily_a1.php";
  while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
    const url = `${BASE}/${page}?prec_no=${st.prec}&block_no=${st.block}&year=${y}&month=${m}&day=&view=`;
    try {
      const recs = parseDaily(await get(url), y, m);
      for (const [d, r] of Object.entries(recs)) {
        if (d >= today) continue; // 当日分は観測途中のため除外
        if (!s.records[d]) added++;
        s.records[d] = r;
      }
    } catch (e) { counter.errs++; log(`⚠ ${st.label} ${y}/${m} 取得失敗: ${e.message}`); }
    counter.reqs++;
    await sleep(WAIT_MS);
    if (++m > 12) { m = 1; y++; }
  }
  return added;
}

async function main() {
  const master = JSON.parse(fs.readFileSync(MASTER, "utf8")).stations;
  const byBlock = Object.fromEntries(master.map((s) => [s.block, s]));
  const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const legacy = readJsVar(LEGACY_JS, /^\s*window\.WEATHER_AUTO\s*=\s*/);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const counter = { reqs: 0, errs: 0 };
  let backfilled = 0;
  const registered = [];

  for (const c of config.stations) {
    const st = byBlock[c.block];
    if (!st) { log(`⚠ 地点番号 ${c.block}（${c.name || ""}）が全国一覧にありません（廃止・番号違いの可能性）`); continue; }
    const file = path.join(DATA_DIR, `${st.block}.js`);
    const prev = readJsVar(file, /^[\s\S]*?window\.WEATHER_DATA\[[^\]]+\]\s*=\s*/);
    const s = { label: st.label, records: (prev && prev.records) || {}, normals: (prev && prev.normals) || {} };
    // 旧形式（weather_data.js）にこの地点があれば引き継ぐ（取り直し不要）
    if (!Object.keys(s.records).length && legacy && legacy.records && legacy.records[st.name]) {
      s.records = legacy.records[st.name]; s.normals = (legacy.normals || {})[st.name] || {};
      log(`${st.label}: 旧データから引き継ぎ（${Object.keys(s.records).length}日）`);
    }
    const dates = Object.keys(s.records).sort();
    let added = 0;
    if (dates.length) {
      const last = dates[dates.length - 1];
      const d = new Date(+last.slice(0, 4), +last.slice(5, 7) - 1 - (REFETCH_MONTHS - 1), 1);
      added = await fetchMonths(st, s, d.getFullYear(), d.getMonth() + 1, today, now, counter);
    } else if (backfilled < MAX_BACKFILL) {
      log(`${st.label}: 新しい地点のため ${START_YEAR}年から取得します（数分かかります）`);
      added = await fetchMonths(st, s, START_YEAR, 1, today, now, counter);
      backfilled++;
    } else {
      log(`${st.label}: 準備中（次回以降に過去データを取得します）`);
    }
    if (Object.keys(s.records).length && (FORCE_NORMALS || Object.keys(s.normals).length < 360)) {
      const page = st.type === "s" ? "nml_sfc_d.php" : "nml_amd_d.php";
      for (let mm = 1; mm <= 12; mm++) {
        const url = `${BASE}/${page}?prec_no=${st.prec}&block_no=${st.block}&year=&month=${mm}&day=&view=`;
        try { Object.assign(s.normals, parseNormals(await get(url), mm)); }
        catch (e) { counter.errs++; log(`⚠ ${st.label} 平年値${mm}月 取得失敗: ${e.message}`); }
        counter.reqs++;
        await sleep(WAIT_MS);
      }
    }
    const ds = Object.keys(s.records).sort();
    if (ds.length) {
      writeAtomic(file, serializeStation(st.block, { label: st.label, generatedAt: new Date().toISOString(), records: s.records, normals: s.normals }));
      log(`${st.label}: ${ds[0]} 〜 ${ds[ds.length - 1]}（${ds.length}日, 今回新規 ${added}日）`);
    }
    registered.push({ label: st.label, name: st.name, pref: st.pref, block: st.block, type: st.type, lat: st.lat, lon: st.lon, height: st.height,
      first: ds[0] || null, last: ds[ds.length - 1] || null });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: "気象庁ホームページ「過去の気象データ検索」",
    registered,
    master: master.filter((s) => s.pref !== "南極").map((s) => ({ label: s.label, pref: s.pref, block: s.block, lat: s.lat, lon: s.lon, height: s.height })),
  };
  writeAtomic(OUT_STATIONS, "window.WEATHER_STATIONS=" + JSON.stringify(payload) + ";\n");
  // GitHub上の自動実行では、保存対象（stations.js と data/）をここで登録しておく（設定ファイル update.yml の変更を不要にするため）
  if (process.env.GITHUB_ACTIONS === "true") {
    try { require("child_process").execSync("git add stations.js data", { cwd: ROOT, stdio: "inherit" }); }
    catch (e) { log("⚠ git add 失敗: " + e.message); }
  }
  log(`完了: ${counter.reqs}回アクセス, エラー${counter.errs}件, 地点 ${registered.filter((r) => r.last).length}/${registered.length} 準備済み → ${OUT_STATIONS}`);
  if (counter.errs) process.exitCode = 1;
}

main().catch((e) => { log("致命的エラー:", e.message); process.exit(2); });
