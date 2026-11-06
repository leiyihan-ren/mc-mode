'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const S = require('../engine/skin/manager.cjs');

/** 构造真实合法 PNG（IHDR + IDAT + IEND，8bit RGBA，非隔行） */
function makePng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const b of Buffer.concat([t, data])) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth / RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const resp = (status, body, asJson = true) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => (asJson ? body : Promise.reject(new Error('not json'))),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  arrayBuffer: async () => body
});

test('inspectSkin：合法官方/HD 尺寸通过，非法尺寸与非 PNG 拒绝', () => {
  for (const [w, h] of [[64, 32], [64, 64], [128, 128], [256, 256], [1024, 1024]]) {
    const r = S.inspectSkin(makePng(w, h));
    assert.equal(r.ok, true, `${w}x${h} 应合法`);
    assert.equal(r.width, w); assert.equal(r.height, h);
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(S.inspectSkin(makePng(64, 64)).hd, false);
  assert.equal(S.inspectSkin(makePng(128, 128)).hd, true);
  const bad = S.inspectSkin(makePng(100, 100));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不是 Minecraft 合法皮肤尺寸/);
  assert.equal(S.inspectSkin(Buffer.from('not a png')).ok, false);
  assert.equal(S.inspectSkin(Buffer.alloc(3)).ok, false);
  assert.equal(S.inspectSkin(makePng(64, 64)).model, 'auto-detect', 'slim 交给 skinview3d 判定，不臆测');
});

test('toDataUrl / loadLocalSkin 往返', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const buf = makePng(64, 64);
  assert.ok(S.toDataUrl(buf).startsWith('data:image/png;base64,'));
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcskin-')), 'skin.png');
  fs.writeFileSync(p, buf);
  const r = S.loadLocalSkin(p);
  assert.equal(r.ok, true);
  assert.equal(r.info.sha256, S.inspectSkin(buf).sha256);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('decodeTexturesProperty：标准 Yggdrasil textures 解码（slim/cape）', () => {
  const t = {
    timestamp: 1700000000000, profileId: 'abcdef', profileName: 'Steve',
    textures: {
      SKIN: { url: 'https://skin.example/textures/aaa', metadata: { model: 'slim' } },
      CAPE: { url: 'https://skin.example/textures/cape' }
    }
  };
  const b64 = Buffer.from(JSON.stringify(t)).toString('base64');
  const d = S.decodeTexturesProperty(b64);
  assert.equal(d.skinUrl, 'https://skin.example/textures/aaa');
  assert.equal(d.skinModel, 'slim');
  assert.equal(d.capeUrl, 'https://skin.example/textures/cape');
  assert.equal(d.profileName, 'Steve');
  assert.throws(() => S.decodeTexturesProperty('!!!not-base64-json!!!'), /不是合法 base64 JSON/);
});

test('fetchSkinFromAuthlib：真实两步 Yggdrasil 协议（注入 fetch）', async () => {
  const calls = [];
  const textures = {
    timestamp: 1, profileId: 'id', profileName: 'Alex',
    textures: { SKIN: { url: 'https://s.example/a.png' } }
  };
  const fetchImpl = async (url, o) => {
    calls.push({ url, method: o.method });
    if (url.endsWith('/api/profiles/minecraft')) return resp(200, [{ id: 'uuid-1234', name: 'Alex' }]);
    if (url.includes('/sessionserver/session/minecraft/profile/')) {
      return resp(200, { id: 'uuid1234', name: 'Alex', properties: [
        { name: 'textures', value: Buffer.from(JSON.stringify(textures)).toString('base64') }
      ] });
    }
    throw new Error('unexpected url ' + url);
  };
  const r = await S.fetchSkinFromAuthlib('https://littleskin.cn/api/yggdrasil/', 'Alex', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.profileName, 'Alex');
  assert.equal(r.skinUrl, 'https://s.example/a.png');
  assert.equal(r.skinModel, 'default');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.ok(calls[1].url.includes('/profile/uuid1234?unsigned=false'));
});

test('fetchSkinFromAuthlib：角色不存在 / HTTP 失败 / 缺 textures 明确报错', async () => {
  await assert.rejects(() => S.fetchSkinFromAuthlib('https://x/api/yggdrasil', '', {}), /角色名不能为空/);
  await assert.rejects(
    () => S.fetchSkinFromAuthlib('https://x/api/yggdrasil', 'Nobody', { fetchImpl: async () => resp(200, []) }),
    /不存在角色/
  );
  await assert.rejects(
    () => S.fetchSkinFromAuthlib('https://x/api/yggdrasil', 'A', { fetchImpl: async () => resp(500, {}) }),
    /HTTP 500/
  );
  await assert.rejects(
    () => S.fetchSkinFromAuthlib('https://x/api/yggdrasil', 'A', {
      fetchImpl: async u => resp(200, u.endsWith('/api/profiles/minecraft') ? [{ id: 'abc', name: 'A' }] : { properties: [] })
    }),
    /缺少 textures 属性/
  );
});

test('downloadSkinImage：真实校验远端图片，非法内容报错', async () => {
  const good = makePng(64, 64);
  const r = await S.downloadSkinImage('https://s.example/skin.png', {
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => good })
  });
  assert.equal(r.ok, true);
  assert.equal(r.info.width, 64);
  const bad = await S.downloadSkinImage('https://s.example/bad.png', {
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('oops') })
  });
  assert.equal(bad.ok, false);
  await assert.rejects(() => S.downloadSkinImage('file:///etc/passwd'), /绝对地址/);
});

test('uploadSkin：未配置端点/Token 明确报错，绝不伪造同步成功', async () => {
  const buf = makePng(64, 64);
  await assert.rejects(() => S.uploadSkin({ buf }), e => e.code === 'NO_UPLOAD_CONFIG');
  await assert.rejects(() => S.uploadSkin({ buf, endpoint: 'https://x/api/upload' }), e => e.code === 'NO_TOKEN');
  await assert.rejects(() => S.uploadSkin({ buf, endpoint: 'http://x/api', token: 't' }), e => e.code === 'INVALID_ENDPOINT');
  await assert.rejects(() => S.uploadSkin({ buf: Buffer.from('x'), endpoint: 'https://x/api', token: 't' }), e => e.code === 'INVALID_SKIN');
});

test('uploadSkin：真实 multipart 上传，2xx 才算成功，响应体标记失败也要判失败', async () => {
  const buf = makePng(64, 64);
  let captured = null;
  const ok = await S.uploadSkin({
    buf, endpoint: 'https://skin.example/api/upload', token: 'TOKEN', player: 'Alex',
    fetchImpl: async (url, o) => { captured = { url, o }; return resp(200, { ok: true, texture: 'abc' }); }
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 200);
  assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  assert.equal(captured.o.headers.Authorization, 'Bearer TOKEN');
  assert.equal(captured.o.method, 'POST');
  assert.ok(captured.o.body instanceof FormData);

  const fail = await S.uploadSkin({
    buf, endpoint: 'https://skin.example/api/upload', token: 'T',
    fetchImpl: async () => resp(403, { message: 'token 无效' })
  });
  assert.equal(fail.ok, false);
  assert.match(fail.error, /403/);

  const bodyFail = await S.uploadSkin({
    buf, endpoint: 'https://skin.example/api/upload', token: 'T',
    fetchImpl: async () => resp(200, { ok: false, message: '角色不存在' })
  });
  assert.equal(bodyFail.ok, false, 'HTTP 200 但响应体明确失败也不算成功');
});

test('uploadSkin：JSON 模式携带 base64 与校验和', async () => {
  const buf = makePng(64, 64);
  let body = null;
  const r = await S.uploadSkin({
    buf, endpoint: 'https://skin.example/api/upload', token: 'T', bodyMode: 'json', model: 'slim',
    fetchImpl: async (u, o) => { body = JSON.parse(o.body); return resp(200, { ok: true }); }
  });
  assert.equal(r.ok, true);
  assert.ok(body.skin.startsWith('data:image/png;base64,'));
  assert.equal(body.model, 'slim');
  assert.match(body.sha256, /^[0-9a-f]{64}$/);
});
