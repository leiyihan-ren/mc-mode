/**
 * parallelDownload.test.cjs — 0.9.0 模块一B：单文件分块并发 + 断点续传 TDD
 * 纯注入 fetch / fs，不碰真实公网与真实文件（用内存 fsImpl + 真实 tmpfs 两种）。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../engine/net/parallelDownload.cjs');

// ==================== 纯函数：分块规划 ====================

test('planChunks：均匀切分、末段收敛、不越界', () => {
  const c = P.planChunks(1000, 4);
  assert.equal(c.length, 4);
  assert.equal(c[0].start, 0);
  assert.equal(c[3].end, 999);
  assert.equal(c.reduce((s, x) => s + x.length, 0), 1000, '总长度必须等于文件大小');
  for (let i = 1; i < c.length; i++) assert.equal(c[i].start, c[i - 1].end + 1, '段必须连续无缝');
});

test('planChunks：maxChunks 收敛、size 小于段数、空文件', () => {
  assert.equal(P.planChunks(10, 8).length <= 8, true);
  const few = P.planChunks(3, 8);
  assert.equal(few.reduce((s, x) => s + x.length, 0), 3);
  const empty = P.planChunks(0, 4);
  assert.equal(empty.length, 1);
});

test('shouldParallel：小文件 / 不支持 Range 明确回退', () => {
  assert.equal(P.shouldParallel(10 << 20, true), true);
  assert.equal(P.shouldParallel(100, true, 1 << 20), false, '过小不分块');
  assert.equal(P.shouldParallel(10 << 20, false), false, '不支持 Range 不分块');
});

// ==================== 用内存 fs + mock fetch 跑完整并发下载 ====================

/** 构造一个真实大 buffer，并按 Range 提供字节 */
function makeServer(buf) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const h = init.headers || {};
    if (init.method === 'HEAD') {
      return { status: 200, headers: { get: (k) => k === 'content-length' ? String(buf.length) : 'bytes' } };
    }
    const m = /bytes=(\d+)-(\d+)/.exec(h.Range || '');
    if (m) {
      const s = Number(m[1]), e = Number(m[2]);
      requests.push([s, e]);
      return { status: 206, body: Buffer.from(buf.subarray(s, e + 1)) };
    }
    return { status: 200, body: Buffer.from(buf) };
  };
  return { fetchImpl, requests };
}

/** 内存 fsImpl：支持本引擎用到的全部方法 + createWriteStream 返回 null（走 Buffer.concat 分支） */
function memFs() {
  const files = new Map();
  return {
    _files: files,
    mkdirSync() {},
    existsSync: (p) => files.has(p),
    statSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return { size: files.get(p).length }; },
    writeFileSync: (p, d) => files.set(p, Buffer.from(d)),
    readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    rmSync: (p) => files.delete(p)
    // 故意不提供 createWriteStream → 走 Buffer.concat 合并分支
  };
}

test('downloadParallel：4 段并发下载，合并字节与整体 sha1 完全一致', async () => {
  const buf = crypto.randomBytes(4 * 1024 * 1024 + 123); // 4MB+，非整块对齐
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  const { fetchImpl, requests } = makeServer(buf);
  const F = memFs();
  const dest = '/virtual/big.jar';
  const r = await P.downloadParallel('https://x.invalid/big.jar', dest, {
    fetchImpl, fsImpl: F, concurrency: 4, minChunkSize: 1 << 20,
    probeResult: { size: buf.length, acceptRanges: true },
    expectedSha1: sha1, retries: 0
  });
  assert.equal(r.ok, true, `下载应成功: ${r.error || ''}`);
  assert.equal(r.chunks, 4);
  assert.equal(r.size, buf.length);
  assert.equal(r.sha1, sha1);
  assert.ok(requests.length >= 4, '应发起多个分段请求');
  assert.deepEqual(F.readFileSync(dest), buf, '合并后的文件字节必须与源一致');
  // 段临时文件应被清理
  for (let i = 0; i < 4; i++) assert.equal(F.existsSync(`${dest}.part.${i}`), false, '临时段应清理');
});

test('downloadParallel：断点续传 —— 已完整存在的段不重复下载', async () => {
  const buf = crypto.randomBytes(2 * 1024 * 1024 + 7);
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  const { fetchImpl, requests } = makeServer(buf);
  const F = memFs();
  const dest = '/virtual/resume.jar';
  const chunks = P.planChunks(buf.length, 4);
  // 预置第 0、2 段为已完成
  for (const idx of [0, 2]) {
    const c = chunks[idx];
    F.writeFileSync(`${dest}.part.${idx}`, buf.subarray(c.start, c.end + 1));
  }
  const r = await P.downloadParallel('https://x.invalid/x', dest, {
    fetchImpl, fsImpl: F, concurrency: 4, minChunkSize: 1 << 20,
    probeResult: { size: buf.length, acceptRanges: true }, expectedSha1: sha1, retries: 0
  });
  assert.equal(r.ok, true, `下载应成功: ${r.error || ''}`);
  assert.equal(r.resumed, 2, '两段应被识别为已续传');
  assert.equal(requests.length, 2, '只应下载缺失的 2 段');
  assert.deepEqual(F.readFileSync(dest), buf);
});

test('downloadParallel：长度不符的旧 .part 会被重下，不产出损坏文件', async () => {
  const buf = crypto.randomBytes(2 * 1024 * 1024);
  const { fetchImpl } = makeServer(buf);
  const F = memFs();
  const dest = '/virtual/corrupt.jar';
  const chunks = P.planChunks(buf.length, 4);
  F.writeFileSync(`${dest}.part.0`, Buffer.alloc(10)); // 长度错误的残留段
  const r = await P.downloadParallel('https://x.invalid/x', dest, {
    fetchImpl, fsImpl: F, concurrency: 4, minChunkSize: 1 << 20,
    probeResult: { size: buf.length, acceptRanges: true }, retries: 0
  });
  assert.equal(r.ok, true);
  assert.equal(F.readFileSync(`${dest}`).length, buf.length);
});

test('downloadParallel：SHA1 不符时拒绝产出成品，保留 .part 供续传', async () => {
  const buf = crypto.randomBytes(2 * 1024 * 1024);
  const { fetchImpl } = makeServer(buf);
  const F = memFs();
  const dest = '/virtual/badsha.jar';
  const r = await P.downloadParallel('https://x.invalid/x', dest, {
    fetchImpl, fsImpl: F, concurrency: 4, minChunkSize: 1 << 20,
    probeResult: { size: buf.length, acceptRanges: true },
    expectedSha1: '0000000000000000000000000000000000000000', retries: 0
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /SHA1 不符/);
  assert.equal(F.existsSync(dest), false, '校验失败不得产出成品');
  assert.equal(F.existsSync(`${dest}.part.0`), true, '应保留分段供续传');
});

test('downloadParallel：某段反复失败 → 明确报错，不产出半成品', async () => {
  const buf = crypto.randomBytes(2 * 1024 * 1024);
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'HEAD') return { status: 200, headers: { get: () => String(buf.length) } };
    n++;
    if (n === 2) throw new Error('connection reset');
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return { status: 206, body: Buffer.from(buf.subarray(Number(m[1]), Number(m[2]) + 1)) };
  };
  const F = memFs();
  const dest = '/virtual/fail.jar';
  const r = await P.downloadParallel('https://x.invalid/x', dest, {
    fetchImpl, fsImpl: F, concurrency: 2, minChunkSize: 1 << 20,
    probeResult: { size: buf.length, acceptRanges: true }, retries: 0
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /chunk/);
  assert.equal(F.existsSync(dest), false);
});

test('downloadParallel：不支持 Range / 小文件 → fallback:true 让调用方走单连接', async () => {
  const F = memFs();
  const r = await P.downloadParallel('https://x.invalid/x', '/virtual/small', {
    fsImpl: F, probeResult: { size: 100, acceptRanges: false }, minChunkSize: 1 << 20
  });
  assert.equal(r.fallback, true);
  assert.equal(r.ok, false);
});

test('probe：HEAD 给长度与 Accept-Ranges；Range 兜底解析 Content-Range', async () => {
  const r1 = await P.probe('https://x.invalid/x', {
    fetchImpl: async () => ({ status: 200, headers: { get: (k) => k === 'content-length' ? '4096' : 'bytes' } })
  });
  assert.equal(r1.size, 4096);
  assert.equal(r1.acceptRanges, true);

  const r2 = await P.probe('https://x.invalid/x', {
    fetchImpl: async (url, init) => {
      if (init.method === 'HEAD') return { status: 405, headers: { get: () => null } };
      return { status: 206, headers: { get: (k) => k === 'content-range' ? 'bytes 0-0/9999' : null }, body: { cancel: async () => {} } };
    }
  });
  assert.equal(r2.size, 9999);
  assert.equal(r2.acceptRanges, true);
});
