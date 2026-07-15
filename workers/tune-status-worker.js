// Cloudflare Worker：代替網站 commit data/tune-status.json（曲調註記）
// 讓任何訪客不需要 GitHub Token 就能維護註記；真正的 Token 以 Secret 存在 Cloudflare。
//
// 部署步驟：
// 1. https://dash.cloudflare.com → Workers & Pages → Create → Worker（名稱如 hymns-tune）
// 2. 把本檔全部內容貼進編輯器 → Deploy
// 3. Worker 的 Settings → Variables and Secrets → Add → 類型選 Secret，
//    名稱 GITHUB_TOKEN，值為 fine-grained PAT（僅 TJC-KM/hymns、僅 Contents 讀寫權限）
// 4. 複製 Worker 網址（https://hymns-tune.<你的帳號>.workers.dev），
//    填入 index.html 的 TUNE_API 常數

const REPO_API = 'https://api.github.com/repos/TJC-KM/hymns/contents/data/tune-status.json';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } });

const b64decodeUtf8 = b64 =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));
const b64encodeUtf8 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad JSON' }, 400); }

    // 嚴格驗證：只接受合法詩歌編號與三種狀態，Worker 端合併，
    // 呼叫者無法寫入任意內容
    const no = String(body.no ?? '');
    const val = String(body.val ?? '');
    if (!/^[0-9]{1,3}(_[ab])?$/.test(no)) return json({ error: 'bad no' }, 400);
    if (val !== '正調' && val !== '變奏' && val !== '') return json({ error: 'bad val' }, 400);

    const gh = {
      authorization: 'Bearer ' + env.GITHUB_TOKEN,
      accept: 'application/vnd.github+json',
      'user-agent': 'hymns-tune-worker',
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await fetch(REPO_API + '?ref=main', { headers: gh });
      if (!cur.ok) return json({ error: 'github read ' + cur.status }, 502);
      const info = await cur.json();

      let data;
      try { data = JSON.parse(b64decodeUtf8(info.content)); } catch { data = {}; }

      if ((data[no] ?? '') === val) return json({ ok: true, unchanged: true });
      if (val) data[no] = val; else delete data[no];

      const put = await fetch(REPO_API, {
        method: 'PUT',
        headers: { ...gh, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: val ? `註記 ${no} ${val}` : `清除 ${no} 曲調註記`,
          branch: 'main',
          content: b64encodeUtf8(JSON.stringify(data, null, 2) + '\n'),
          sha: info.sha,
        }),
      });
      if (put.ok) return json({ ok: true });
      if (put.status !== 409) return json({ error: 'github write ' + put.status }, 502);
      // 409 = 有人同時在改，重新讀最新版再套用一次
    }
    return json({ error: 'conflict, retry later' }, 409);
  },
};
