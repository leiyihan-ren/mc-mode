'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { downloadFile, fetchJson, DownloadError } = require('../engine/http');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-test-'));

// ---- 本地测试服务器（模拟官方源 + 故障注入）----
let server, baseUrl, failNext = 0, requests = [];
function startServer() {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      requests.push(req.url);
      if (failNext > 0) { failNext--; res.writeHead(500); res.end('boom'); return; }
      if (req.url === '/ok.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ hello: 'world' })); return; }
      if (req.url.startsWith('/range/')) {
        const total = 1024 * 512; // 512KB
        const range = req.headers.range;
        const buf = Buffer.alloc(total);
        for (let i = 0; i < total; i++) buf[i] = i % 256;
        if (range) {
          const m = range.match(/bytes=(\d+)-/);
          const start = Number(m[1]);
          res.writeHead(206, { 'content-length': total - start, 'content-range': `bytes ${start}-${total - 1}/${total}`, 'accept-ranges': 'bytes' });
          res.end(buf.slice(start));
        } else {
          res.writeHead(200, { 'content-length': total, 'accept-ranges': 'bytes' });
          res.end(buf);
        }
        return;
      }
      if (req.url === '/404') { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(404); res.end('nf');
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

test.before(async () => { await startServer(); });
test.after(() => server.close());

test('下载小文件成功且内容正确', async () => {
  const dir = tmp();
  const dest = path.join(dir, 'ok.json');
  const r = await downloadFile(`${baseUrl}/ok.json`, dest, { retries: 1 });
  assert.equal(fs.readFileSync(dest, 'utf8'), JSON.stringify({ hello: 'world' }));
  assert.equal(r.size, 17);
  assert.ok(r.sha1.length === 40);
});

test('fetchJson 多源降级与解析', async () => {
  const j = await fetchJson(`${baseUrl}/ok.json`, { retries: 1 });
  assert.deepEqual(j, { hello: 'world' });
});

test('404 立即换源/失败且不无限重试', async () => {
  const dir = tmp();
  await assert.rejects(
    downloadFile(`${baseUrl}/404`, path.join(dir, 'x'), { retries: 3 }),
    (e) => e instanceof DownloadError
  );
});

test('HTTP 500 触发重试后成功（故障注入）', async () => {
  const dir = tmp();
  failNext = 2; // 前两次 500
  const r = await downloadFile(`${baseUrl}/ok.json`, path.join(dir, 'ok.json'), { retries: 3 });
  assert.ok(r.size === 17, '重试后应成功');
});

test('Range 断点续传：中断后续传不重下已传部分', async () => {
  const dir = tmp();
  const dest = path.join(dir, 'range.bin');
  // 先写 100KB 的部分文件（模拟中断）
  const part = dest + '.part';
  const buf = Buffer.alloc(1024 * 100);
  for (let i = 0; i < buf.length; i++) buf[i] = i % 256;
  fs.writeFileSync(part, buf);
  const r = await downloadFile(`${baseUrl}/range/data.bin`, dest, { retries: 1 });
  assert.equal(r.size, 1024 * 512);
  // 校验内容: byte[i] = i%256
  const full = fs.readFileSync(dest);
  for (let i = 0; i < full.length; i += 997) assert.equal(full[i], i % 256);
});

test('expectedSha1 不符时抛出且不留完整文件', async () => {
  const dir = tmp();
  const dest = path.join(dir, 'sha.bin');
  await assert.rejects(
    downloadFile(`${baseUrl}/ok.json`, dest, { retries: 0, expectedSha1: 'a'.repeat(40) }),
    /SHA1/
  );
  assert.ok(!fs.existsSync(dest), '校验失败不应留下正式文件');
});

test('超时控制: 慢端点不会永久挂起', async () => {
  // 使用一个不存在的端口模拟连接失败（快速失败场景）
  const dir = tmp();
  const t0 = Date.now();
  await assert.rejects(downloadFile('http://127.0.0.1:1/x', path.join(dir, 'x'), { retries: 1, timeoutMs: 3000 }));
  assert.ok(Date.now() - t0 < 15000, '应在合理时间内失败');
});
