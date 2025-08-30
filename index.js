import 'dotenv/config';
import { Client } from '@notionhq/client';

// ====== Config (env) ======
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DATABASE_ID;
const AVG_WINDOW = parseInt(process.env.AVG_WINDOW || '6', 10);
const AVG_BLEED_WINDOW = parseInt(process.env.AVG_BLEED_WINDOW || String(AVG_WINDOW), 10);
const LUTEAL_DAYS = parseInt(process.env.LUTEAL_DAYS || '14', 10);
const CYCLE_MIN = parseInt(process.env.CYCLE_MIN || '17', 10);
const CYCLE_MAX = parseInt(process.env.CYCLE_MAX || '60', 10);

if (!NOTION_TOKEN || !DB_ID) {
  console.error('Missing NOTION_TOKEN or NOTION_DATABASE_ID');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// ====== Property Names (edit to match DB) ======
const P = {
  title: 'タイトル',              // Title
  date: '登録日',                 // Date
  type: '種別',                   // Select: 開始/終了/予定/排卵予定
  cycleDays: '周期日数',          // Number
  avgCycle: '平均周期',           // Number
  bleedDays: '生理日数',          // Number
  avgBleed: '平均生理日数',       // Number  <= New
  nextPeriod: '次回生理予定日',   // Date
  ovulation: '排卵予定日',        // Date
  error: '入力エラー'             // Checkbox
};

const TYPE = {
  START: '開始',
  END: '終了',
  PLAN: '予定',
  OVU: '排卵予定'
};

// ====== Helpers ======
const dstr = (d) => d.toISOString().slice(0, 10);
const parseDate = (s) => new Date(`${s}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((a - b) / 86400000);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

const setTitle = (v) => ({ title: [{ text: { content: v } }] });
const setDate = (d) => d ? ({ date: { start: dstr(d) } }) : { date: null };
// 値が無いときは 0 を入れる
const setNum = (n) => {
  if (n == null || Number.isNaN(n)) return { number: 0 };
  return { number: n };
};

const setSel = (v) => v ? ({ select: { name: v } }) : { select: null };
const setChk = (b) => ({ checkbox: !!b });

async function queryAllPages() {
  const results = [];
  let cursor = undefined;
  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
      sorts: [{ property: P.date, direction: 'ascending' }]
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

function getProp(page, key) { return page.properties?.[key]; }
function readType(page) { return getProp(page, P.type)?.select?.name || null; }
function readDate(page, key = P.date) {
  const v = getProp(page, key)?.date?.start;
  return v ? parseDate(v) : null;
}

function titleFor(kind, date) {
  const md = `${String(date.getUTCMonth()+1).padStart(2,'0')}/${String(date.getUTCDate()).padStart(2,'0')}`;
  if (kind === TYPE.START) return `🩸開始 ${md}`;
  if (kind === TYPE.END) return `✅終了 ${md}`;
  if (kind === TYPE.PLAN) return `📅生理予定 ${md}`;
  if (kind === TYPE.OVU) return `🔵排卵予定 ${md}`;
  return `📌記録 ${md}`;
}

async function updatePage(pageId, props) {
  await notion.pages.update({ page_id: pageId, properties: props });
}

async function createPage(date, kind, extra = {}) {
  return await notion.pages.create({
    parent: { database_id: DB_ID },
    properties: {
      [P.title]: setTitle(titleFor(kind, date)),
      [P.date]: setDate(date),
      [P.type]: setSel(kind),
      ...extra
    }
  });
}

async function upsertSingle(kind, date) {
  const res = await notion.databases.query({
    database_id: DB_ID,
    filter: { property: P.type, select: { equals: kind } },
    sorts: [{ property: P.date, direction: 'ascending' }]
  });
  const targetTitle = titleFor(kind, date);
  if (res.results.length === 0) {
    await createPage(date, kind);
    return;
  }
  const first = res.results[0];
  await notion.pages.update({
    page_id: first.id,
    properties: {
      [P.title]: setTitle(targetTitle),
      [P.date]: setDate(date),
      [P.type]: setSel(kind)
    }
  });
  // Optional: archive others
}

function sanitizeCycles(cycles) {
  return cycles.filter(c => c >= CYCLE_MIN && c <= CYCLE_MAX);
}

async function main() {
  const pages = await queryAllPages();

  // Decorate
  const recs = pages.map(p => ({
    id: p.id,
    kind: readType(p),
    date: readDate(p),
    raw: p
  })).filter(r => r.date);

  // Update titles
  for (const r of recs) {
    await updatePage(r.id, { [P.title]: setTitle(titleFor(r.kind, r.date)) });
  }

  const starts = recs.filter(r => r.kind === TYPE.START);
  const ends = recs.filter(r => r.kind === TYPE.END);

  // 周期日数：連続する開始差分
  const cycleValues = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const cur = starts[i], nxt = starts[i+1];
    const cycle = daysBetween(nxt.date, cur.date);
    cycleValues.push(cycle);
    await updatePage(cur.id, { [P.cycleDays]: setNum(cycle) });
  }

  // 生理日数：開始→最初の終了（次開始の前）
  const bleedValues = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const nextStart = starts[i+1]?.date || null;
    const candidateEnds = ends.filter(e => e.date >= s.date && (!nextStart || e.date < nextStart));
    const e = candidateEnds[0];
    if (e) {
      const days = daysBetween(e.date, s.date) + 1;
      bleedValues.push(days);
      await updatePage(e.id, { [P.bleedDays]: setNum(days) });
    }
  }

  // 平均周期（直近 AVG_WINDOW）
  const saneCycles = sanitizeCycles(cycleValues);
  const cyclesWindow = saneCycles.slice(-AVG_WINDOW);
  const avgCycle = cyclesWindow.length ? Math.round(cyclesWindow.reduce((a,b)=>a+b,0) / cyclesWindow.length) : null;

  // 平均生理日数（直近 AVG_BLEED_WINDOW）
  const bleedsWindow = bleedValues.slice(-AVG_BLEED_WINDOW);
  const avgBleed = bleedsWindow.length ? Math.round(bleedsWindow.reduce((a,b)=>a+b,0) / bleedsWindow.length) : null;

  // 次回生理予定 & 排卵予定を最新開始に付与 + 平均値も同時に書き込み
  const lastStart = starts[starts.length - 1];
  if (lastStart) {
    const props = {};
    if (avgCycle != null) props[P.avgCycle] = setNum(avgCycle);
    if (avgBleed != null) props[P.avgBleed] = setNum(avgBleed);

    if (avgCycle != null) {
      const nextPeriod = addDays(lastStart.date, avgCycle);
      const ovulation = addDays(nextPeriod, -LUTEAL_DAYS);
      props[P.nextPeriod] = setDate(nextPeriod);
      props[P.ovulation] = setDate(ovulation);
      await upsertSingle(TYPE.PLAN, nextPeriod);
      await upsertSingle(TYPE.OVU, ovulation);
    }
    if (Object.keys(props).length) {
      await updatePage(lastStart.id, props);
    }
  }

  // バリデーション：同日重複
  const byDayType = new Map();
  for (const r of recs) {
    const key = `${dstr(r.date)}:${r.kind}`;
    byDayType.set(key, (byDayType.get(key) || 0) + 1);
  }
  const dupKeys = [...byDayType.entries()].filter(([k,c]) => c > 1);
  for (const [k] of dupKeys) {
    const [dateStr, kind] = k.split(':');
    for (const r of recs.filter(x => dstr(x.date) === dateStr && x.kind === kind)) {
      await updatePage(r.id, { [P.error]: setChk(true) });
    }
  }

  console.log('Done');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
