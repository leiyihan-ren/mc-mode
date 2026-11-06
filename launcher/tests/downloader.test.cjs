'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DownloadQueue, downloadBatch } = require('../engine/downloader.cjs');
const { fetchJson } = require('../engine/http.js');

const PAYLOADS = {
  a: Buffer.from('MC-NEXT-FILE-A-' + 'x'.repeat(4096)),
  b: Buffer.from('MC-NEXT-FILE-B-' + 'y'.repeat(8192)),
  c: Buffer.from('MC-NEXT-FILE-C-' + 'z'.repeat(2048))
};
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

function makeServer(t) {
  const state = { active: 0, peak: 0, requests: [], ranges: [] };
  const server = http.createServer((req, res) => {
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    state.requests.push({ url: req.url, range: req.headers.range || null });
    const u = new URL(req.url, 'http://127.0.0.1');
    const name = u.pathname.split('/').pop();
    res.on('finish', () => { state.active--; });
    if (u.pathname.startsWith('/bad')) { res.writeHead(500); return res.end('official down'); }
    if (u.pathname.startsWith('/corrupt')) { const b = Buffer.from('WRONG CONTENT'); res.writeHead(200, { 'content-length': b.length }); return res.end(b); }
    if (u.pathname.startsWith('/slow')) { setTimeout(() => { res.writeHead(200, { 'content-length': PAYLOADS.a.length }); res.end(PAYLOADS.a); }, 800); return; }
    const buf = PAYLOADS[name] || PAYLOADS.a;
    if (u.pathname.startsWith('/range/') && req.headers.range) {
      const m = /bytes=(\d+)-/.exec(req.headers.range);
      const start = m ? Number(m[1]) : 0;
      state.ranges.push(req.headers.range);
      const part = buf.subarray(start);
      res.writeHead(206, { 'content-length': part.length, 'content-range': `bytes ${start}-${buf.length - 1}/${buf.length}` });
      return res.end(part);
    }
    res.writeHead(200, { 'content-length': buf.length });
    res.end(buf);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      t.after(() => new Promise(r => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }));
      resolve({ base, state });
    });
  });
}
function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-dl-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('并发下载 3 个文件，SHA-1 全部校验通过', async (t) => {
  const { base } = await makeServer(t);
  const dir = tmp(t);
  const tasks = ['a', 'b', 'c'].map(n => ({
    id: n, url: `${base}/ok/${n}`, dest: path.join(dir, n + '.bin'),
    sha1: sha1(PAYLOADS[n]), size: PAYLOADS[n].length
  }));
  const events = [];
  const { results, progress } = await downloadBatch(tasks, { concurrency: 3, onEvent: e => events.push(e) });
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.readFileSync(r.dest).length, PAYLOADS[r.id].length);
    assert.equal(r.sha1, sha1(PAYLOADS[r.id]));
  }
  assert.equal(progress.counts.done, 3);
  assert.equal(progress.percent, 100);
  assert.ok(events.some(e => e.type === 'progress') && events.some(e => e.type === 'done') && events.some(e => e.type === 'summary'));
});

test('并发度上限真实生效', async (t) => {
  const { base, state } = await makeServer(t);
  const dir = tmp(t);
  const tasks = ['a', 'b', 'c', 'a'].map((n, i) => ({ id: 't' + i, url: `${base}/ok/${n}`, dest: path.join(dir, i + '.bin') }));
  await downloadBatch(tasks, { concurrency: 2 });
  assert.ok(state.peak <= 2, `峰值并发 ${state.peak} 应 <= 2`);
  assert.ok(state.peak >= 1);
});

test('官方源 500 自动降级到备用源', async (t) => {
  const { base } = await makeServer(t);
  const dir = tmp(t);
  const r = (await downloadBatch([{
    id: 'fallback', url: `${base}/bad/down`, urls: [`${base}/ok/b`],
    dest: path.join(dir, 'b.bin'), sha1: sha1(PAYLOADS.b)
  }], { concurrency: 1 })).results[0];
  assert.equal(r.ok, true, r.error);
  assert.ok(r.usedUrl.includes('/ok/b'));
  assert.equal(r.sha1, sha1(PAYLOADS.b));
});

test('SHA-1 不符时拒绝落盘（不产生目标文件）', async (t) => {
  const { base } = await makeServer(t);
  const dir = tmp(t);
  const dest = path.join(dir, 'corrupt.bin');
  const r = (await downloadBatch([{ id: 'bad', url: `${base}/corrupt/x`, dest, sha1: sha1(PAYLOADS.a) }], { concurrency: 1 })).results[0];
  assert.equal(r.ok, false);
  assert.match(r.error, /SHA1 不符|下载失败/);
  assert.equal(fs.existsSync(dest), false, '校验失败不应 rename 成目标文件');
});

test('.part 断点续传：发出 Range 请求并拼接出完整文件', async (t) => {
  const { base, state } = await makeServer(t);
  const dir = tmp(t);
  const dest = path.join(dir, 'resume.bin');
  fs.writeFileSync(dest + '.part', PAYLOADS.a.subarray(0, 512));
  const r = (await downloadBatch([{
    id: 'resume', url: `${base}/range/a`, dest, sha1: sha1(PAYLOADS.a), size: PAYLOADS.a.length
  }], { concurrency: 1 })).results[0];
  assert.equal(r.ok, true, r.error);
  assert.ok(state.ranges.some(x => x.includes('bytes=512-')), '服务器应收到续传 Range');
  assert.deepEqual(fs.readFileSync(dest), PAYLOADS.a);
  assert.equal(r.sha1, sha1(PAYLOADS.a));
});

test('cancelAll 穿透到 fetch，任务标记为已取消', async (t) => {
  const { base } = await makeServer(t);
  const dir = tmp(t);
  const q = new DownloadQueue({ concurrency: 1 });
  const p = q.enqueue([{ id: 'slow', url: `${base}/slow/a`, dest: path.join(dir, 'slow.bin') }]);
  setTimeout(() => q.cancelAll(), 80);
  const { results } = await p;
  assert.equal(results.length, 1);
  assert.equal(results[0].cancelled, true);
  assert.equal(results[0].ok, false);
});

test('fetchJson 支持注入 fetch（http.js 改动向后兼容）', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ hello: 'world' }) });
  const j = await fetchJson('http://example.invalid/x.json', { fetchImpl: f, retries: 0 });
  assert.deepEqual(j, { hello: 'world' });
});
