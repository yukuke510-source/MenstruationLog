import 'dotenv/config';
import { Client } from '@notionhq/client';

/** ===== Config ===== */
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DATABASE_ID;
if (!NOTION_TOKEN || !DB_ID) {
  console.error('Missing NOTION_TOKEN or NOTION_DATABASE_ID');
  process.exit(1);
}
const LUTEAL_DAYS = parseInt(process.env.LUTEAL_DAYS || '14', 10);
const DEFAULT_CYCLE = parseInt(process.env.DEFAULT_CYCLE || '28', 10);
const CREATE_PLAN_PAGES = String(process.env.CREATE_PLAN_PAGES || 'false').toLowerCase() === 'true';
const EVENT_REASON = (process.env.EVENT_REASON || '').toLowerCase(); // '', 'start-updated', 'end-updated'
const MIN_TRIGGER_INTERVAL_SEC = parseInt(process.env.MIN_TRIGGER_INTERVAL_SEC || '45', 10);
const STRICT_TEMPLATES = String(process.env.STRICT_TEMPLATES || 'false').toLowerCase() === 'true';
const MORNING_END_HOUR = parseInt(process.env.MORNING_END_HOUR || '10', 10);
const AFTERNOON_END_HOUR = parseInt(process.env.AFTERNOON_END_HOUR || '16', 10);

/** ===== Property map (overridable via PROP_*) ===== */
const P = {
  title: process.env.PROP_TITLE || 'タイトル',
  type: process.env.PROP_TYPE || '種別',
  date: process.env.PROP_DATE || '登録日',
  cycleDays: process.env.PROP_CYCLE_DAYS || '周期日数',
  avgCycle: process.env.PROP_AVG_CYCLE || '平均周期',
  bleedDays: process.env.PROP_BLEED_DAYS || '生理日数',
  avgBleed: process.env.PROP_AVG_BLEED || '平均生理日数',
  nextPeriod: process.env.PROP_NEXT_PERIOD || '次回生理予定日',
  ovulation: process.env.PROP_OVULATION || '排卵予定日',
  error: process.env.PROP_ERROR || '入力エラー',
  templateError: process.env.PROP_TEMPLATE_ERROR || 'テンプレ不一致',
  // Metrics flags
  latestAvgCycle: process.env.PROP_LATEST_AVG_CYCLE || '最新_平均周期',
  latestAvgBleed: process.env.PROP_LATEST_AVG_BLEED || '最新_平均生理',
  latestCycle: process.env.PROP_LATEST_CYCLE || '最新_周期日数',
  latestBleed: process.env.PROP_LATEST_BLEED || '最新_生理日数',
  latestStart: process.env.PROP_LATEST_START || '最新開始',
  latestEnd: process.env.PROP_LATEST_END || '最新終了',
};

/** ===== Types ===== */
const TYPE = { START:'開始', END:'終了', PLAN:'生理予定', OVU:'排卵予定', DAILY:'日次記録' };

/** ===== Notion client ===== */
const notion = new Client({ auth: NOTION_TOKEN });

/** ===== Helpers ===== */
function toJST(d) { return new Date(d.getTime() + 9 * 3600 * 1000); }
function formatMMDD_JST(d) {
  const j = toJST(d);
  const m = String(j.getMonth() + 1).padStart(2, '0');
  const day = String(j.getDate()).padStart(2, '0');
  return `${m}/${day}`;
}
const dstr = (d) => d.toISOString().slice(0, 10);
const parseDate = (s) => new Date(`${s}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((a - b) / 86400000);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

const setTitle = (v) => ({ title: [{ type: 'text', text: { content: v } }] });
const setDate = (d) => (d ? { date: { start: dstr(d) } } : { date: null });
const setSel = (v) => (v ? { select: { name: v } } : { select: null });
const setNum = (n) => ({ number: (n == null || Number.isNaN(n)) ? 0 : n });
const setChk = (b) => ({ checkbox: !!b });

function readProp(page, key) { return page.properties?.[key]; }
function readType(page) { return readProp(page, P.type)?.select?.name || null; }
function readDate(page) { const s = readProp(page, P.date)?.date?.start; return s ? parseDate(s) : null; }

function timeBandFromISO(iso) {
  const d = new Date(iso);
  const j = toJST(d);
  const h = j.getHours();
  if (h <= MORNING_END_HOUR) return '朝';
  if (h <= AFTERNOON_END_HOUR) return '昼';
  return '夜';
}

function titleFor(kind, date, rec) {
  const base = `${kind} / ${formatMMDD_JST(date)}`;
  if (kind === TYPE.DAILY) {
    const band = timeBandFromISO(rec.raw.created_time);
    return `${base}（${band}）`;
  }
  // 開始/終了/予定は帯も通番も付けない
  return base;
}

async function updatePage(pageId, props) {
  await notion.pages.update({ page_id: pageId, properties: props });
}

async function createPage(date, kind, extra = {}) {
  return await notion.pages.create({
    parent: { database_id: DB_ID },
    properties: {
      [P.title]: setTitle(titleFor(kind, date, { raw:{ created_time: new Date().toISOString() } })),
      [P.date]: setDate(date),
      [P.type]: setSel(kind),
      ...extra
    }
  });
}

async function getAllSorted() {
  const results = [];
  let cursor;
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

// ----- State page (内部:状態) -----
async function getStatePage() {
  const db = await notion.databases.query({
    database_id: DB_ID,
    filter: { property: P.title, title: { equals: '内部:状態' } }
  });
  let page = db.results[0];
  if (!page) {
    page = await notion.pages.create({
      parent: { database_id: DB_ID },
      properties: { [P.title]: setTitle('内部:状態'), [P.date]: setDate(new Date()) }
    });
  }
  const lastCalc = page.properties['最終計算時刻']?.date?.start ? new Date(page.properties['最終計算時刻'].date.start) : null;
  const lastTrig = page.properties['直近トリガ時刻']?.date?.start ? new Date(page.properties['直近トリガ時刻'].date.start) : null;
  return { id: page.id, lastCalc, lastTrig };
}
async function setStateTime(pageId, key, time) {
  await notion.pages.update({ page_id: pageId, properties: { [key]: { date: { start: time.toISOString() } } } });
}

/** Pairing: strict two-pointer mapping of STARTs to ENDs (each END at most once) */
function pairStartsEnds(starts, ends) {
  const pairs = []; // {start, end|null}
  let j = 0;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const nextS = i + 1 < starts.length ? starts[i+1].date : null;
    while (j < ends.length && ends[j].date < s.date) j++;
    let chosen = null, k = j;
    while (k < ends.length && (!nextS || ends[k].date < nextS)) {
      chosen = ends[k];
      j = k + 1; // consume this end
      break;
    }
    pairs.push({ start: s, end: chosen });
  }
  return pairs;
}

// upsert for plan pages (avoid duplicates)
async function upsertPlan(date, kind) {
  const res = await notion.databases.query({
    database_id: DB_ID,
    filter: {
      and: [
        { property: P.type, select: { equals: kind } },
        { property: P.date, date: { equals: dstr(date) } }
      ]
    },
    page_size: 1
  });
  if (res.results.length === 0) {
    await createPage(date, kind);
  }
}

async function main() {
  const now = new Date();
  const state = await getStatePage();

  // Debounce
  if (EVENT_REASON && state.lastTrig) {
    const diffSec = (now - state.lastTrig) / 1000;
    if (diffSec < MIN_TRIGGER_INTERVAL_SEC) {
      await setStateTime(state.id, '直近トリガ時刻', now);
      console.log(`Debounced: ${diffSec.toFixed(1)}s < ${MIN_TRIGGER_INTERVAL_SEC}s`);
      return;
    }
  }
  await setStateTime(state.id, '直近トリガ時刻', now);

  // Fetch & normalize
  const pages = await getAllSorted();
  const recs = pages.map(p => ({ id: p.id, kind: readType(p), date: readDate(p), raw: p }))
                    .filter(r => r.kind && r.date)
                    .sort((a,b)=>a.date - b.date);

  // Titles (JST) + reset flags
  for (const r of recs) {
    await updatePage(r.id, {
      [P.title]: setTitle(titleFor(r.kind, r.date, r)),
      [P.error]: setChk(false),
      [P.templateError]: setChk(false),
      [P.latestAvgCycle]: setChk(false),
      [P.latestAvgBleed]: setChk(false),
      [P.latestCycle]: setChk(false),
      [P.latestBleed]: setChk(false),
      [P.latestStart]: setChk(false),
      [P.latestEnd]: setChk(false),
    });
  }

  // Template compliance
  const isPlannedKind = (k) => k === TYPE.PLAN || k === TYPE.OVU;
  const isUserKind = (k) => k === TYPE.START || k === TYPE.END;
  for (const r of recs) {
    const creatorType = r.raw.created_by?.type || 'person'; // 'person' or 'bot'
    let violated = false;
    if (isUserKind(r.kind)) {
      if (creatorType === 'bot') violated = true;
      if (!r.date) violated = true;
    } else if (isPlannedKind(r.kind)) {
      if (creatorType !== 'bot') violated = true;
    }
    if (violated) await updatePage(r.id, { [P.templateError]: setChk(true) });
  }
  const effectiveRecs = STRICT_TEMPLATES
    ? recs.filter(r => r.raw.properties?.[P.templateError]?.checkbox !== true)
    : recs;

  // Duplicate & order error
  const keyMap = {};
  for (const r of effectiveRecs) {
    const key = `${r.kind}:${dstr(r.date)}`;
    (keyMap[key] ||= []).push(r);
  }
  for (const list of Object.values(keyMap)) {
    if (list.length > 1) for (const r of list) await updatePage(r.id, { [P.error]: setChk(true) });
  }

  // Window: incremental
  let fromDate = null;
  if (state.lastCalc) {
    for (const p of pages) {
      const edited = new Date(p.last_edited_time);
      if (edited > state.lastCalc) {
        const s = p.properties?.[P.date]?.date?.start ? parseDate(p.properties[P.date].date.start) : null;
        if (s && (!fromDate || s < fromDate)) fromDate = s;
      }
    }
  }

  const startsAll = effectiveRecs.filter(r => r.kind === TYPE.START);
  const endsAll   = effectiveRecs.filter(r => r.kind === TYPE.END);
  let starts = startsAll, ends = endsAll;
  if (fromDate) {
    let idx = startsAll.findIndex(s => s.date >= fromDate);
    if (idx > 0) idx -= 1;
    if (idx >= 0) {
      starts = startsAll.slice(idx);
      const boundary = starts[0]?.date;
      ends = endsAll.filter(e => !boundary || e.date >= boundary);
    }
  }

  // Pairing
  const pairsAll = pairStartsEnds(startsAll, endsAll);
  const pairsWin = pairStartsEnds(starts, ends);
  for (const { start, end } of pairsWin) {
    if (end && end.date < start.date) await updatePage(end.id, { [P.error]: setChk(true) });
  }

  // Cycle (prev END -> START)
  const prevEndForStart = new Map();
  let lastEndBefore = null;
  let eIdx = 0;
  const endsSorted = [...endsAll].sort((a,b)=>a.date-b.date);
  for (const s of [...startsAll].sort((a,b)=>a.date-b.date)) {
    while (eIdx < endsSorted.length && endsSorted[eIdx].date < s.date) {
      lastEndBefore = endsSorted[eIdx];
      eIdx++;
    }
    prevEndForStart.set(s.id, lastEndBefore);
  }
  const startCycles = new Map();
  const cycleVals = [];
  for (const s of startsAll) {
    const pe = prevEndForStart.get(s.id);
    const c = pe ? Math.max(0, daysBetween(s.date, pe.date)) : 0;
    startCycles.set(s.id, c);
    if (c > 0) cycleVals.push(c);
  }
  const avgCycleAll = cycleVals.length ? Math.round(cycleVals.reduce((a,b)=>a+b,0)/cycleVals.length) : 0;

  // ★表示用：0ならDEFAULT_CYCLE（既定28）に置き換え
  const displayedAvgCycle = avgCycleAll > 0 ? avgCycleAll : DEFAULT_CYCLE;

  // 次回計算用：0なら28日で計算（従来どおり）
  const baseCycle = avgCycleAll > 0 ? avgCycleAll : (DEFAULT_CYCLE > 0 ? DEFAULT_CYCLE : 28);

  // Bleed (START -> first END)
  const endBleeds = new Map();
  const bleedVals = [];
  for (const { start, end } of pairsAll) {
    if (end) {
      const b = Math.max(1, daysBetween(end.date, start.date) + 1);
      endBleeds.set(end.id, b);
      bleedVals.push(b);
    }
  }
  const avgBleedAll = bleedVals.length ? Math.round(bleedVals.reduce((a,b)=>a+b,0)/bleedVals.length) : 0;

  // START updates (window) —— 平均周期は表示用の displayedAvgCycle を書き込む
  for (const s of starts) {
    await updatePage(s.id, {
      [P.cycleDays]: setNum(startCycles.get(s.id) ?? 0),
      [P.avgCycle]: setNum(displayedAvgCycle),  // ← 0なら28で表示
      [P.bleedDays]: setNum(0),
      [P.avgBleed]: setNum(0),
      [P.nextPeriod]: setDate(null),
      [P.ovulation]: setDate(null)
    });
  }

  // 最新開始に次回/排卵を書き、必要なら予定ページも upsert
  const lastStartAll = startsAll[startsAll.length - 1];
  if (!fromDate || starts.some(st => st.id === lastStartAll?.id)) {
    if (lastStartAll) {
      const nextPeriod = addDays(lastStartAll.date, baseCycle);
      const ovulation = addDays(nextPeriod, -LUTEAL_DAYS);
      await updatePage(lastStartAll.id, { [P.nextPeriod]: setDate(nextPeriod), [P.ovulation]: setDate(ovulation) });

      // Zap 有無に関係なく、フラグに従い予定ページを upsert 作成
      if (CREATE_PLAN_PAGES) {
        await upsertPlan(nextPeriod, TYPE.PLAN);
        await upsertPlan(ovulation, TYPE.OVU);
      }
    }
  }

  // END updates (window)
  for (const { start, end } of pairsWin) {
    if (!end) continue;
    const bleed = endBleeds.get(end.id) ?? Math.max(1, daysBetween(end.date, start.date) + 1);
    await updatePage(end.id, {
      [P.bleedDays]: setNum(bleed),
      [P.avgBleed]: setNum(avgBleedAll),
      [P.nextPeriod]: setDate(null),
      [P.ovulation]: setDate(null)
    });
  }

  // Metrics flags（※ご要望どおり現状のまま・平均は avgCycleAll>0 を基準）
  const lastEndAll = endsAll[endsAll.length - 1];
  if (lastStartAll) await updatePage(lastStartAll.id, { [P.latestStart]: setChk(true) });
  if (lastEndAll)   await updatePage(lastEndAll.id,   { [P.latestEnd]: setChk(true) });

  for (let i = startsAll.length - 1; i >= 0; i--) {
    const s = startsAll[i];
    const cyc = startCycles.get(s.id) ?? 0;
    if (cyc > 0) { await updatePage(s.id, { [P.latestCycle]: setChk(true) }); break; }
  }
  for (let i = endsAll.length - 1; i >= 0; i--) {
    const e = endsAll[i];
    const b = endBleeds.get(e.id) ?? 0;
    if (b > 0) { await updatePage(e.id, { [P.latestBleed]: setChk(true) }); break; }
  }
  if (avgCycleAll > 0 && lastStartAll) await updatePage(lastStartAll.id, { [P.latestAvgCycle]: setChk(true) });
  if (avgBleedAll > 0 && lastEndAll)   await updatePage(lastEndAll.id,   { [P.latestAvgBleed]: setChk(true) });

  await setStateTime(state.id, '最終計算時刻', now);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
