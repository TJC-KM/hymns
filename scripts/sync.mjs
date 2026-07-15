// 放到 repo 的 scripts/sync.mjs  —— 由 .github/workflows/sync-hymns.yml 執行
// 功能:抓全部詩歌 → 和上次快照比對 → 覆蓋 hymns.json + 產出結構化變更紀錄
// 零相依套件(Node 18+ 內建 fetch)

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const API  = 'https://sacredmusic.tjc.org.tw/api/hymn?limit=1000&page=1&sort=asc';
const DATA = 'data/hymns.json';

// ---- 1. 抓取(列表端點一次回傳全部,含 audio_files)----
const res = await fetch(API, { headers: { accept: 'application/json' } });
if (!res.ok) throw new Error(`fetch 失敗: HTTP ${res.status}`);
const payload = await res.json();
const next = payload.data;
if (!Array.isArray(next) || next.length === 0) throw new Error('回傳為空,中止(避免用空資料覆蓋)');
next.sort((a, b) => a.id - b.id); // 用 id 穩定排序,讓 git diff 乾淨

// ---- 2. 讀上一次快照 ----
let prev = [];
if (existsSync(DATA)) prev = JSON.parse(await readFile(DATA, 'utf8'));

await mkdir('data', { recursive: true });
const stamp   = new Date().toISOString();
const dateKey = stamp.slice(0, 10);

// 先寫入最新快照 + meta(不論有無變動)
await writeFile(DATA, JSON.stringify(next, null, 2));
await writeFile('data/meta.json', JSON.stringify({
  last_synced: stamp,
  total: next.length,
  max_updated_at: next.reduce((m, h) => (h.updated_at > m ? h.updated_at : m), ''),
}, null, 2));

// 首次執行(沒有舊資料)當作建立基準,不產差異
if (prev.length === 0) {
  await finish('baseline', false);
  console.log(`baseline: 建立 ${next.length} 首`);
  process.exit(0);
}

// ---- 3. 比對 ----
const byId = arr => new Map(arr.map(h => [h.id, h]));
const pMap = byId(prev), nMap = byId(next);

const added = [], removed = [], changed = [];
for (const [id, h] of nMap) if (!pMap.has(id)) added.push(h);
for (const [id, h] of pMap) if (!nMap.has(id)) removed.push(h);
for (const [id, h] of nMap) {
  const old = pMap.get(id);
  if (!old) continue;
  const d = diffHymn(old, h);
  if (d.changes.length) changed.push(d);
}

const hasChanges = added.length || removed.length || changed.length;
const summary = `+${added.length} ~${changed.length} -${removed.length}`;

// ---- 4. 產出結構化變更(給網站讀)+ changelog(給人看)----
if (hasChanges) {
  await mkdir('data/changes', { recursive: true });

  const record = {
    synced_at: stamp,
    summary,
    added:   added.map(h => ({ no: h.no, name: h.name })),
    removed: removed.map(h => ({ no: h.no, name: h.name })),
    changed, // 每筆含 no / name / changes:[人類可讀的變更描述]
  };
  await writeFile(`data/changes/${dateKey}.json`, JSON.stringify(record, null, 2));

  // index.json:網站「最近更新」列表直接讀這個(新到舊)
  let index = existsSync('data/changes/index.json')
    ? JSON.parse(await readFile('data/changes/index.json', 'utf8')) : [];
  index = index.filter(e => e.date !== dateKey); // 同日重跑就覆蓋
  index.unshift({ date: dateKey, file: `changes/${dateKey}.json`,
                  added: added.length, changed: changed.length, removed: removed.length });
  await writeFile('data/changes/index.json', JSON.stringify(index, null, 2));

  // CHANGELOG.md(新區塊插在最前)
  const block = [`## ${dateKey}　(${summary})`, ''];
  for (const h of added)   block.push(`- ➕ 新增　${h.no}　${h.name}`);
  for (const h of removed) block.push(`- ➖ 移除　${h.no}　${h.name}`);
  for (const c of changed) block.push(`- ✏️ ${c.no}　${c.name}：${c.changes.join('；')}`);
  block.push('');
  const HEAD = '# 更新紀錄\n\n';
  const body = existsSync('CHANGELOG.md')
    ? (await readFile('CHANGELOG.md', 'utf8')).replace(HEAD, '') : '';
  await writeFile('CHANGELOG.md', HEAD + block.join('\n') + '\n' + body);
}

await finish(summary, hasChanges);
console.log(`${summary} ${hasChanges ? '(有變動)' : '(無變動)'}`);

// ---------------- helpers ----------------
function audioCats(h) {
  const m = new Map();
  for (const a of h.audio_files || []) m.set(a.id, a.audio_category?.name ?? String(a.audio_category_id));
  return m;
}
function scoreSig(h) {
  return JSON.stringify([h.sheet_score_pdf, h.num_score_pdf, h.num_score_xml, h.sheet_score_images]);
}
function diffHymn(o, n) {
  const changes = [];
  if (o.name !== n.name) changes.push(`名稱:「${o.name}」→「${n.name}」`);
  if (o.status !== n.status) changes.push(`狀態:${o.status}→${n.status}`);
  if (JSON.stringify(o.lyrics) !== JSON.stringify(n.lyrics)) changes.push('歌詞變更');
  if ((o.lyrics_chorus || '') !== (n.lyrics_chorus || '')) changes.push('副歌變更');
  if (scoreSig(o) !== scoreSig(n)) changes.push('樂譜變更');

  const om = audioCats(o), nm = audioCats(n);
  const addA = [...nm].filter(([id]) => !om.has(id)).map(([, c]) => c);
  const delA = [...om].filter(([id]) => !nm.has(id)).map(([, c]) => c);
  if (addA.length) changes.push('新增音檔:' + addA.join('、'));
  if (delA.length) changes.push('移除音檔:' + delA.join('、'));

  if (JSON.stringify(o.youtube_urls) !== JSON.stringify(n.youtube_urls)) changes.push('YouTube 變更');
  if (!changes.length && o.updated_at !== n.updated_at)
    changes.push(`updated_at:${o.updated_at}→${n.updated_at}`);

  return { id: n.id, no: n.no, name: n.name, updated_at: n.updated_at, changes };
}
async function finish(summary, changed) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `summary=${summary}\nchanged=${changed ? 1 : 0}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### 同步結果　${summary}\n`);
}
