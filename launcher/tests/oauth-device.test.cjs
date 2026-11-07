'use strict';
/** 【0.6.0 模块二】微软 OAuth2 设备码真流程：协议级 Mock 全链路 / 后台轮询 / 取消 / 错误分支 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DeviceFlowManager } = require('../engine/auth/deviceFlow.cjs');
const { createMockMicrosoftFetch, MOCK_PROFILE } = require('../engine/auth/mockMicrosoft.cjs');
const { ENDPOINTS, toLaunchArgs } = require('../engine/auth/microsoft.cjs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-oauth-')); }
function makeFlow(dir, fetchImpl, extra = {}) {
  return new DeviceFlowManager({
    storeFile: path.join(dir, 'accounts.json'),
    currentFile: path.join(dir, 'current.json'),
    fetchImpl,
    sleep: async () => {},
    ...extra
  });
}
async function waitFor(fn, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('等待设备码状态超时');
}

// ==================== 真实协议端点（不是假 URL） ====================
test('协议端点全部为微软 / Xbox Live / Minecraft Services 真实 HTTPS 地址', () => {
  assert.ok(ENDPOINTS.deviceCode.startsWith('https://login.microsoftonline.com/'));
  assert.ok(ENDPOINTS.token.startsWith('https://login.microsoftonline.com/'));
  assert.ok(ENDPOINTS.xbl.startsWith('https://user.auth.xboxlive.com/'));
  assert.ok(ENDPOINTS.xsts.startsWith('https://xsts.auth.xboxlive.com/'));
  assert.ok(ENDPOINTS.mcLogin.startsWith('https://api.minecraftservices.com/'));
  assert.ok(ENDPOINTS.profile.startsWith('https://api.minecraftservices.com/'));
});

// ==================== 六步全链路 ====================
test('设备码真流程：pending×2 → slow_down → MS token → XBL → XSTS → MC → profile', async () => {
  const dir = tmp();
  const fetchImpl = createMockMicrosoftFetch({ pendingCount: 2 });
  const flow = makeFlow(dir, fetchImpl);

  const s = await flow.start({ fetchImpl });
  assert.equal(s.state, 'pending');
  assert.equal(s.userCode, 'MCNX-DEMO');
  assert.equal(s.verificationUri, 'https://www.microsoft.com/link');
  assert.ok(s.verificationUriComplete.includes('otc='));
  assert.ok(s.message.includes('MCNX-DEMO'));
  assert.equal(s.mock, true, '注入 Mock 必须被标注为演示模式');

  const begun = flow.beginPolling(s.id);
  assert.equal(begun.state, 'polling', 'beginPolling 必须立即返回，不能阻塞渲染层');

  await waitFor(() => flow.status(s.id).state === 'success');
  const st = flow.status(s.id);
  assert.equal(st.account.name, 'DemoPlayer');
  assert.equal(st.account.uuid, MOCK_PROFILE.id);
  assert.equal(st.account.skinUrl, MOCK_PROFILE.skins[0].url);
  assert.equal(st.account.demo, true);
  assert.equal(st.account.mcToken, undefined, '展示视图绝不能带出令牌');
  assert.equal(st.pollCount, 3, '2 次 pending + 1 次 slow_down');

  const joined = fetchImpl.stats.requests.map(r => r.url).join('|');
  for (const step of ['oauth2/v2.0/devicecode', 'oauth2/v2.0/token',
    'user.auth.xboxlive.com', 'xsts.auth.xboxlive.com',
    'login_with_xbox', 'minecraft/profile']) {
    assert.ok(joined.includes(step), `缺少协议步骤 ${step}`);
  }
  assert.equal(fetchImpl.stats.polls, 4, '第 4 次轮询拿到 access_token');
});

test('演示账号写入独立 mock 仓库，绝不污染真实 accounts.json；current() 明确 demo', async () => {
  const dir = tmp();
  const flow = makeFlow(dir, createMockMicrosoftFetch());
  const s = await flow.start({ fetchImpl: createMockMicrosoftFetch() });
  flow.beginPolling(s.id);
  await waitFor(() => flow.status(s.id).state === 'success');

  assert.equal(fs.existsSync(path.join(dir, 'accounts.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'accounts.json.mock.json')), true);
  const cur = flow.current();
  assert.equal(cur.demo, true);
  assert.equal(cur.account.demo, true);
  assert.equal(cur.account.name, 'DemoPlayer');
  assert.equal(cur.total, 0, '演示账号不计入真实账号数');
});

test('真实账号：current()/select() 读真实仓库，toLaunchArgs 生成可启动参数', async () => {
  const dir = tmp();
  const flow = makeFlow(dir, createMockMicrosoftFetch());
  flow.authenticator.saveAccount({
    type: 'microsoft', uuid: '01234567-89ab-cdef-0123-456789abcdef',
    name: 'RealPlayer', mcToken: 'REAL_MC_TOKEN', mcExpiresAt: Date.now() + 86400000,
    msRefreshToken: 'REAL_RT', msAccessToken: 'REAL_MS', msExpiresAt: Date.now() + 3600000,
    skinUrl: 'https://textures.minecraft.net/texture/real', capeUrl: null
  });
  const cur = flow.current();
  assert.equal(cur.account.name, 'RealPlayer');
  assert.equal(cur.demo, false);
  assert.equal(cur.total, 1);
  assert.equal(cur.account.mcToken, undefined);
  assert.equal(cur.account.hasRefresh, true);

  const picked = flow.select(cur.account.uuid);
  assert.equal(picked.name, 'RealPlayer');
  const raw = flow.authenticator.listAccounts()[0];
  const args = toLaunchArgs(raw);
  assert.ok(args.includes('--accessToken') && args.includes('REAL_MC_TOKEN'));
  assert.ok(args.includes('RealPlayer'));
});

// ==================== 后台轮询控制 ====================
test('slow_down 按 RFC 8628 加大轮询间隔（+5000ms）', async () => {
  const dir = tmp();
  const delays = [];
  const flow = new DeviceFlowManager({
    storeFile: path.join(dir, 'accounts.json'),
    currentFile: path.join(dir, 'current.json'),
    sleep: async (ms) => { delays.push(ms); }
  });
  const s = await flow.start({ fetchImpl: createMockMicrosoftFetch({ pendingCount: 1, slowDown: true }) });
  flow.beginPolling(s.id);
  await waitFor(() => flow.status(s.id).state === 'success');
  assert.ok(delays.includes(5000), `应出现 5000ms 退避，实际 ${JSON.stringify(delays)}`);
});

test('cancel 真实中断后台死循环，不再空转到过期', async () => {
  const dir = tmp();
  const flow = new DeviceFlowManager({
    storeFile: path.join(dir, 'accounts.json'),
    currentFile: path.join(dir, 'current.json'),
    sleep: () => new Promise(r => setTimeout(r, 8))
  });
  const fetchImpl = createMockMicrosoftFetch({ pendingCount: 100000, slowDown: false });
  const s = await flow.start({ fetchImpl });
  flow.beginPolling(s.id);
  await waitFor(() => flow.status(s.id).pollCount >= 2);
  const cancelled = flow.cancel(s.id);
  assert.equal(cancelled.state, 'cancelled');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(flow.status(s.id).state, 'cancelled');
  assert.equal(flow.status(s.id).account, null);
});

test('重复 beginPolling 被拒绝；未知会话 status/cancel 明确返回 not-found', async () => {
  const dir = tmp();
  const flow = makeFlow(dir, createMockMicrosoftFetch());
  const s = await flow.start({ fetchImpl: createMockMicrosoftFetch() });
  flow.beginPolling(s.id);
  assert.throws(() => flow.beginPolling(s.id), /不能重复发起轮询/);
  assert.equal(flow.status('no-such-id').state, 'not-found');
  assert.equal(flow.cancel('no-such-id').state, 'not-found');
  flow.cancel(s.id);
});

test('onStatus 回调按状态机推进（polling → authorizing → success）', async () => {
  const dir = tmp();
  const seen = [];
  const flow = new DeviceFlowManager({
    storeFile: path.join(dir, 'accounts.json'),
    currentFile: path.join(dir, 'current.json'),
    sleep: async () => {},
    onStatus: (v) => seen.push(v.state)
  });
  const s = await flow.start({ fetchImpl: createMockMicrosoftFetch({ pendingCount: 1, slowDown: false }) });
  flow.beginPolling(s.id);
  await waitFor(() => flow.status(s.id).state === 'success');
  assert.ok(seen.includes('polling') && seen.includes('authorizing') && seen.includes('success'));
  assert.equal(seen[seen.length - 1], 'success');
});

// ==================== 错误分支（不伪造成功） ====================
test('设备码过期 → state=expired，携带真实 OAuth 错误码', async () => {
  const dir = tmp();
  const flow = makeFlow(dir, createMockMicrosoftFetch());
  const s = await flow.start({ fetchImpl: createMockMicrosoftFetch({ tokenError: 'expired_token' }) });
  flow.beginPolling(s.id);
  await waitFor(() => ['expired', 'error', 'cancelled'].includes(flow.status(s.id).state));
  const st = flow.status(s.id);
  assert.equal(st.state, 'expired');
  assert.equal(st.code, 'expired_token');
  assert.equal(st.account, null);
});

test('无正版档案 profile 404 → state=error 且精确提示，不伪造账号', async () => {
  const dir = tmp();
  const flow = makeFlow(dir, createMockMicrosoftFetch());
  const s = await flow.start({ fetchImpl: createMockMicrosoftFetch({ failAt: 'profile' }) });
  flow.beginPolling(s.id);
  await waitFor(() => flow.status(s.id).state === 'error');
  const st = flow.status(s.id);
  assert.equal(st.stage, 'profile');
  assert.match(st.error, /没有 Minecraft Java 版正版档案/);
  assert.equal(st.account, null);
});

test('XSTS 未成年账户 XErr 被翻译成人类可读诊断', async () => {
  const dir = tmp();
  const flow = makeFlow(dir, createMockMicrosoftFetch());
  const s = await flow.start({ fetchImpl: createMockMicrosoftFetch({ failAt: 'xsts' }) });
  flow.beginPolling(s.id);
  await waitFor(() => flow.status(s.id).state === 'error');
  assert.match(flow.status(s.id).error, /未成年账户/);
});

test('设备码申请失败直接抛出，不创建会话', async () => {
  const dir = tmp();
  const flow = makeFlow(dir, createMockMicrosoftFetch());
  await assert.rejects(
    () => flow.start({ fetchImpl: createMockMicrosoftFetch({ failAt: 'devicecode' }) }),
    /设备码申请失败/);
  assert.equal(flow.sessions.size, 0);
});

// ==================== 兼容旧 UI ====================
test('complete() 兼容旧调用：等待同一套后台流程并返回精简账号', async () => {
  const dir = tmp();
  const flow = makeFlow(dir, createMockMicrosoftFetch());
  const s = await flow.start({ fetchImpl: createMockMicrosoftFetch({ pendingCount: 1, slowDown: false }) });
  const acc = await flow.complete(s.id);
  assert.equal(acc.name, 'DemoPlayer');
  assert.equal(acc.type, 'microsoft');
  assert.equal(acc.mcToken, undefined);
});
