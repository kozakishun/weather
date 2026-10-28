/* ============================================================
   全国の「気温を観測している・現在も観測中」のアメダス／気象台の一覧を作る
   - 取得元: 気象庁ホームページ「過去の気象データ検索」の地点選択ページ（公開情報）
   - 出力: amedas_master.json（このフォルダ）
   使い方: node build_master.js   （地点の新設・廃止を反映したいときに年1回程度）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const BASE = "https://www.data.jma.go.jp/stats/etrn/select";
const OUT = path.join(__dirname, "amedas_master.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "weather-analysis-tool (station list, 1 req/sec)" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } catch (e) { if (i === 3) throw e; await sleep(3000 * i); }
  }
}

async function main() {
  const top = await get(`${BASE}/prefecture00.php?prec_no=&block_no=&year=&month=&day=&view=`);
  const prefs = [...top.matchAll(/<area[^>]*alt="([^"]+)"[^>]*prefecture\.php\?prec_no=(\d+)/g)]
    .map((m) => ({ pref: m[1], prec: +m[2] }))
    .filter((p, i, a) => a.findIndex((q) => q.prec === p.prec) === i);
  const out = new Map();
  for (const p of prefs) {
    await sleep(1000);
    const html = await get(`${BASE}/prefecture.php?prec_no=${p.prec}&block_no=&year=&month=&day=&view=`);
    for (const m of html.matchAll(/viewPoint\('([as])','(\d+)','([^']*)','([^']*)','(\d+)','([\d.]+)','(\d+)','([\d.]+)','([\d.]+)','(\d)','(\d)','(\d)','(\d)','(\d)','(\d)','(\d+)'/g)) {
      const [, type, block, name, kana, latd, latm, lond, lonm, height, , , ftem, , , , edy] = m;
      if (ftem !== "1" || edy !== "9999") continue; // 気温あり・現在も観測中のみ
      if (out.has(block)) continue;
      out.set(block, { name, kana, pref: p.pref, type, prec: p.prec, block,
        lat: +(+latd + (+latm) / 60).toFixed(4), lon: +(+lond + (+lonm) / 60).toFixed(4), height: +height });
    }
    process.stdout.write(`${p.pref} `);
  }
  const list = [...out.values()];
  // 同名の地点は「名前（地方）」にして区別
  const cnt = {}; list.forEach((s) => (cnt[s.name] = (cnt[s.name] || 0) + 1));
  list.forEach((s) => { s.label = cnt[s.name] > 1 ? `${s.name}（${s.pref}）` : s.name; });
  fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), source: "気象庁ホームページ「過去の気象データ検索」", stations: list }, null, 1));
  console.log(`\n${list.length}地点 → ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
