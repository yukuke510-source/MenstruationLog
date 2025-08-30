import 'dotenv/config';
import { Client } from '@notionhq/client';
import chalk from 'chalk';

// ====== Config (env) ======
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DATABASE_ID;
const AVG_WINDOW = parseInt(process.env.AVG_WINDOW || '6', 10);
const AVG_BLEED_WINDOW = parseInt(process.env.AVG_BLEED_WINDOW || String(AVG_WINDOW), 10);
const LUTEAL_DAYS = parseInt(process.env.LUTEAL_DAYS || '14', 10);
const CYCLE_MIN = parseInt(process.env.CYCLE_MIN || '17', 10);
const CYCLE_MAX = parseInt(process.env.CYCLE_MAX || '60', 10);
const DEBUG = !!parseInt(process.env.DEBUG || '1', 10);

if (!NOTION_TOKEN || !DB_ID) {
  console.error('Missing NOTION_TOKEN or NOTION_DATABASE_ID');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// ====== Desired names (can be overridden by env) ======
const P = {
  title: process.env.PROP_TITLE || 'タイトル',
  date: process.env.PROP_DATE || '記録日',
  type: process.env.PROP_TYPE || '種別',
  cycleDays: process.env.PROP_CYCLE_DAYS || '周期日数',
  avgCycle: process.env.PROP_AVG_CYCLE || '平均周期',
  bleedDays: process.env.PROP_BLEED_DAYS || '生理日数',
  avgBleed: process.env.PROP_AVG_BLEED || '平均生理日数',
  nextPeriod: process.env.PROP_NEXT_PERIOD || '次回生理予定日',
  ovulation: process.env.PROP_OVULATION || '排卵予定日',
  error: process.env.PROP_ERROR || '入力エラー'
};

const TYPE = { START: '開始', END: '終了', PLAN: '予定', OVU: '排卵予定' };

// ====== Helpers ======
const dstr = (d) => d.toISOString().slice(0, 10);
const parseDate = (s) => new Date(`${s}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((a - b) / 86400000);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

const setTitle = (v) => ({ title: [{ type: 'text', text: { content: v } }] });
const setDate = (d) => (d ? { date: { start: dstr(d) } } : { date: null });

// ★ ここを修正：ブランク時は 0 を入れる
const setNum = (n) => {
  if (n == null || Number.isNaN(n)) return { number: 0 };
  return { number: n };
};

const setSel = (v) => (v ? { select: { name: v } } : { select: null });
const setChk = (b) => ({ checkbox: !!b });

function log(...args) { if (DEBUG) console.log(...args); }
function warn(msg) { console.warn(chalk.yellow('WARN'), msg); }
function err(msg) { console.error(chalk.red('ERR'), msg); }

async function retrieveDB() {
  return await notion.databases.retrieve({ database_id: DB_ID });
}

function getProp(page, key) { return page.properties?.[key]; }
function readType(page, key) { return getProp(page, key)?.select?.name || null; }
function readDate(page, key) {
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

// ---- auto-detect critical property names ----
async function detectCriticalProps() {
  const db = await retrieveDB();
  const entries = Object.entries(db.properties);

  const findByType = (t) => entries.find(([name, def]) => def?.type === t)?.[0];
  const titleName = process.env.PROP_TITLE || findByType('title');
  const dateName = process.env.PROP_DATE || findByType('date');
  // type/select: pick env, else a select that has option '開始' or '終了', else first select
  let typeName = process.env.PROP_TYPE;
  if (!typeName) {
    const selects = entries.filter(([, def]) => def?.type === 'select');
    const withOptions = selects.find(([, def]) => {
      const names = (def.select?.options || []).map(o => o.name);
      return names.includes(TYPE.START) || names.includes(TYPE.END);
    });
    typeName = withOptions?.[0] || selects?.[0]?.[0];
  }

  if (!titleName) throw new Error('Title property (type=title) not found');
  if (!dateName) throw new Error('Date property (type=date) not found');
  if (!typeName) throw new Error('Type property (type=select) not found');

  // Validate types and print
  const expect = {
    [titleName]: 'title', [dateName]: 'date', [typeName]: 'select',
    [P.cycleDays]: 'number', [P.avgCycle]: 'number',
    [P.bleedDays]: 'number', [P.avgBleed]: 'number',
    [P.nextPeriod]: 'date', [P.ovulation]: 'date',
    [P.error]: 'checkbox'
  };
  log(chalk.cyan('Database properties (expected types):'));
  for (const [k, t] of Object.entries(expect)) {
    const def = db.properties[k];
    const actual = def?.type || '(missing)';
    const ok = actual === t;
    const mark = ok ? chalk.green('OK') : chalk.red('NG');
    console.log(`${mark} ${k} -> ${actual} (expected: ${t})`);
  }

  return { titleName, dateName, typeName };
}

async function queryAllPages(sortByDate) {
  const results = [];
  let cursor = undefined;
  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
      sorts: sortByDate ? [{ property: sortByDate, direction: 'ascending' }] : undefined
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function main() {
  const crit = await detectCriticalProps();
  // override critical names
  P.title = crit.titleName;
  P.date = crit.dateName;
  P.type = crit.typeName;

  const pages = await queryAllPages(P.date);
  log(chalk.cyan(`Fetched ${pages.length} pages`));

  // Decorate
  const recs = pages.map(p => ({
    id: p.id,
    kind: readType(p, P.type),
    date: readDate(p, P.date),
    raw: p
  })).filter(r => r.date && r.kind);

  const starts = recs.filter(r => r.kind === TYPE.START);
  const ends = recs.filter(r => r.kind === TYPE.END);

  console.log(chalk.cyan(`Records: starts=${starts.length}, ends=${ends.length}`));

  if (starts.length === 0) warn('開始レコードがありません。周期/予定は算出できません。');
  if (starts.length < 2) warn('開始が2件未満のため、平均周期・次回予定は算出されない場合があります。');
  if (ends.length === 0) warn('終了レコードがありません。生理日数・平均生理日数は算出されません。');

  // タイトル更新
  for (const r of recs) {
    await updatePage(r.id, { [P.title]: setTitle(titleFor(r.kind, r.date)) });
  }

  // 周期日数：連続する開始差分（前の開始行に入れる）
  const cycleValues = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const cur = starts[i], nxt = starts[i+1];
    const cycle = daysBetween(nxt.date, cur.date);
    cycleValues.push(cycle);
    await updatePage(cur.id, { [P.cycleDays]: setNum(cycle) });
    log(`周期日数: ${dstr(cur.date)} → ${cycle}日`);
  }
  if (!cycleValues.length) warn('周期日数を算出できる開始ペアが見つかりませんでした。');

  // 生理日数：開始→最初の終了（次開始の前）（終了行に入れる）
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
      log(`生理日数: ${dstr(s.date)}〜${dstr(e.date)} → ${days}日 (終了行に記録)`);
    } else {
      warn(`開始 ${dstr(s.date)} に対応する終了が見つかりませんでした。`);
    }
  }

  // 平均周期（直近 AVG_WINDOW）
  const saneCycles = cycleValues.filter(c => c >= CYCLE_MIN && c <= CYCLE_MAX);
  const cyclesWindow = saneCycles.slice(-AVG_WINDOW);
  const avgCycle = cyclesWindow.length
    ? Math.round(cyclesWindow.reduce((a,b)=>a+b,0) / cyclesWindow.length)
    : 0; // ★ ブランクなら0

  // 平均生理日数（直近 AVG_BLEED_WINDOW）
  const bleedsWindow = bleedValues.slice(-AVG_BLEED_WINDOW);
  const avgBleed = bleedsWindow.length
    ? Math.round(bleedsWindow.reduce((a,b)=>a+b,0) / bleedsWindow.length)
    : 0; // ★ ブランクなら0

  // 次回生理予定 & 排卵予定（最新開始）
  const lastStart = starts[starts.length - 1];
  if (lastStart) {
    const props = {};
    // 平均値は常に0以上で入れる
    props[P.avgCycle] = setNum(avgCycle);
    props[P.avgBleed] = setNum(avgBleed);

    // 次回予定は avgCycle が 0 の場合は算出できないので null にせず、何もしない or 0日後を避ける
    if (avgCycle > 0) {
      const nextPeriod = addDays(lastStart.date, avgCycle);
      const ovulation = addDays(nextPeriod, -LUTEAL_DAYS);
      props[P.nextPeriod] = setDate(nextPeriod);
      props[P.ovulation] = setDate(ovulation);
      log(`次回生理予定日: ${dstr(nextPeriod)} / 排卵予定日: ${dstr(ovulation)} (最新開始 ${dstr(lastStart.date)} 基準)`);
    } else {
      warn('平均周期が0のため、次回生理予定日/排卵予定日の算出はスキップしました。');
    }

    await updatePage(lastStart.id, props);
  }

  console.log(chalk.green('Done'));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
