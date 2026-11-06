'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ms = require('../engine/auth/microsoft.cjs');
const ali = require('../engine/auth/authlib.cjs');

function resp(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k] || null },
    text: async () => body === null || body === undefined ? '' : JSON.stringify(body)
  };
}
function router(handlers) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [re, fn] of handlers) if (re.test(url)) return fn(url, init, calls);
    throw new Error('未预期的请求: ' + url);
  };
  f.calls = calls;
  return f;
}
function bodyOf(init) { return JSON.parse(String(init.body || '{}')); }
function formOf(init) { return Object.fromEntries(new URLSearchParams(String(init.body || ''))); }

function chainHandlers(overrides = {}) {
  return [
    [/oauth2\/v2\.0\/token/, (u, i) => {
      const form = formOf(i);
      if (form.grant_type === 'refresh_token') return resp(200, { access_token: 'MS_REFRESHED', refresh_token: 'RT2', expires_in: 3600 });
      if (form.grant_type === 'authorization_code') return resp(200, { access_token: 'MSACCESS', refresh_token: 'RT1', expires_in: 3600 });
      return resp(200, { access_token: 'MSDEVICE', refresh_token: 'RTD', expires_in: 3600 });
    }],
    [/user\.auth\.xboxlive\.com\/user\/authenticate/, (u, i) => {
      const b = bodyOf(i);
      assert.equal(b.Properties.RpsTicket.startsWith('d='), true);
      return resp(200, { Token: 'XBLTOKEN', DisplayClaims: { xui: [{ uhs: 'UHS123' }] } });
    }],
    [/xsts\.auth\.xboxlive\.com\/xsts\/authorize/, () => overrides.xsts || resp(200, { Token: 'XSTSTOKEN', DisplayClaims: { xui: [{ uhs: 'UHS123' }] } })],
    [/authentication\/login_with_xbox/, (u, i) => {
      assert.equal(bodyOf(i).identityToken, 'XBL3.0 x=UHS123;XSTSTOKEN');
      return resp(200, { access_token: 'MCTOKEN', expires_in: 86400 });
    }],
    [/minecraft\/profile/, () => overrides.profile || resp(200, { id: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Steve', skins: [{ url: 'https://textures.minecraft.net/texture/abc' }] })]
  ];
}

// ---------------- Microsoft OAuth2 ----------------
test('PKCE 会话生成真实 S256 challenge 与 state', () => {
  const a = new ms.MicrosoftAuthenticator();
  const s = a.createPkceSession('http://127.0.0.1:29110/cb');
  const u = new URL(s.url);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), ms.SCOPE);
  assert.equal(u.searchParams.get('client_id'), ms.DEFAULT_CLIENT_ID);
  const crypto = require('crypto');
  const expect = crypto.createHash('sha256').update(s.verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(s.challenge, expect);
});

test('授权码全链路：MS → XBL → XSTS → Minecraft → 档案', async () => {
  const fetchImpl = router(chainHandlers());
  const a = new ms.MicrosoftAuthenticator({ fetchImpl });
  const s = a.createPkceSession();
  const acc = await a.loginWithCode(s, 'CODE123', s.state);
  assert.equal(acc.type, 'microsoft');
  assert.equal(acc.name, 'Steve');
  assert.equal(acc.uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.equal(acc.mcToken, 'MCTOKEN');
  assert.equal(acc.skinUrl, 'https://textures.minecraft.net/texture/abc');
  const urls = fetchImpl.calls.map(c => c.url);
  assert.equal(urls.length, 5);
  assert.ok(urls[0].includes('oauth2/v2.0/token'));
  assert.ok(urls[1].includes('user/authenticate'));
  assert.ok(urls[2].includes('xsts/authorize'));
  assert.ok(urls[3].includes('login_with_xbox'));
  assert.ok(urls[4].includes('minecraft/profile'));
  assert.equal(fetchImpl.calls[4].init.headers.Authorization, 'Bearer MCTOKEN');
  assert.equal(formOf(fetchImpl.calls[0].init).code, 'CODE123');
  assert.equal(formOf(fetchImpl.calls[0].init).code_verifier, s.verifier);
});

test('state 不匹配被拒绝（CSRF 防护）', async () => {
  const a = new ms.MicrosoftAuthenticator({ fetchImpl: router(chainHandlers()) });
  const s = a.createPkceSession();
  await assert.rejects(() => a.exchangeCode(s, 'CODE', 'BAD_STATE'), /state 不匹配/);
});

test('XSTS 真实错误码映射为中文诊断', async () => {
  const a = new ms.MicrosoftAuthenticator({ fetchImpl: router(chainHandlers({ xsts: resp(401, { XErr: 2148916238 }) })) });
  const s = a.createPkceSession();
  await assert.rejects(() => a.loginWithCode(s, 'C', s.state), /未成年账户/);
});

test('无正版档案（profile 404）给出精确提示', async () => {
  const a = new ms.MicrosoftAuthenticator({ fetchImpl: router(chainHandlers({ profile: resp(404, {}) })) });
  const s = a.createPkceSession();
  await assert.rejects(() => a.loginWithCode(s, 'C', s.state), /没有 Minecraft Java 版正版档案/);
});

test('设备码流程：authorization_pending → 成功', async () => {
  let polls = 0;
  const fetchImpl = router([
    [/oauth2\/v2\.0\/devicecode/, () => resp(200, { device_code: 'DC', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/link', expires_in: 900, interval: 0 })],
    [/oauth2\/v2\.0\/token/, () => (++polls === 1 ? resp(400, { error: 'authorization_pending' }) : resp(200, { access_token: 'MSDEVICE', refresh_token: 'RTD', expires_in: 3600 }))],
    ...chainHandlers().slice(1)
  ]);
  const a = new ms.MicrosoftAuthenticator({ fetchImpl, sleep: async () => {} });
  const sess = await a.createDeviceCodeSession();
  assert.equal(sess.user_code, 'ABCD-EFGH');
  const token = await a.pollDeviceCode(sess);
  assert.equal(token.access_token, 'MSDEVICE');
  assert.equal(polls, 2);
});

test('ensureValid：未过期直接命中缓存，过期则刷新重签', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-auth-'));
  const store = path.join(dir, 'accounts.json');
  const fetchImpl = router(chainHandlers());
  const a = new ms.MicrosoftAuthenticator({ fetchImpl, storeFile: store, now: () => 1_000_000 });
  const acc = await a.loginWithCode(a.createPkceSession(), 'C');
  a.saveAccount(acc);
  assert.equal(fs.existsSync(store), true);
  assert.equal(a.listAccounts()[0].name, 'Steve');
  const before = fetchImpl.calls.length;
  const cached = await a.ensureValid(acc);
  assert.equal(cached, acc, '未过期应直接返回原对象');
  assert.equal(fetchImpl.calls.length, before);
  const expired = { ...acc, mcExpiresAt: 1, msRefreshToken: 'RT1' };
  const fresh = await a.ensureValid(expired);
  assert.equal(fresh.mcToken, 'MCTOKEN');
  assert.equal(fetchImpl.calls.length, before + 5, '刷新应重新走完整 5 步链路');
  assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).accounts.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('toLaunchArgs 输出真实 MC 启动参数', () => {
  const args = ms.toLaunchArgs({ name: 'Steve', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', mcToken: 'TOK' });
  assert.equal(args[args.indexOf('--username') + 1], 'Steve');
  assert.equal(args[args.indexOf('--uuid') + 1], '069a79f444e94726a5befca90e38aaf5');
  assert.equal(args[args.indexOf('--accessToken') + 1], 'TOK');
  assert.equal(args[args.indexOf('--userType') + 1], 'mojang');
});

// ---------------- Authlib-Injector ----------------
const META = {
  meta: { serverName: 'LittleSkin', implementationName: 'yggdrasil', implementationVersion: '1.0', 'feature.legacy_skin_api': true },
  skinDomains: ['littleskin.cn', '.littleskin.cn'],
  signaturePublickey: '-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----'
};

test('fetchMetadata 解析真实 authlib-injector 元数据与声明头', async () => {
  const fetchImpl = router([
    [/littleskin\.cn\/api\/yggdrasil$/, (u, i, calls) => {
      assert.equal(calls[0].init.method, 'GET');
      return resp(200, META, { 'X-Authlib-Injector-API-Location': 'https://littleskin.cn/api/yggdrasil' });
    }]
  ]);
  const m = await ali.fetchMetadata('https://littleskin.cn/api/yggdrasil/', fetchImpl);
  assert.equal(m.serverName, 'LittleSkin');
  assert.deepEqual(m.skinDomains, ['littleskin.cn', '.littleskin.cn']);
  assert.equal(m.declaredRoot, 'https://littleskin.cn/api/yggdrasil');
  assert.equal(m.apiRoot, 'https://littleskin.cn/api/yggdrasil', '尾部斜杠应被规范化');
  assert.ok(m.signaturePublickey.includes('PUBLIC KEY'));
});

test('非 Yggdrasil 地址被拒绝', async () => {
  const fetchImpl = router([[/.*/, () => resp(200, { hello: 'world' })]]);
  await assert.rejects(() => ali.fetchMetadata('https://example.com/api', fetchImpl), /不是有效的 authlib-injector/);
});

test('buildAuthlibArgs：javaagent / side / prefetched 全部正确且可解码', () => {
  const jar = path.join(os.tmpdir(), 'authlib-injector-test.jar');
  fs.writeFileSync(jar, 'JAR');
  const args = ali.buildAuthlibArgs({ agentJar: jar, apiRoot: 'https://littleskin.cn/api/yggdrasil', metadata: META });
  assert.equal(args[0], `-javaagent:${jar}=https://littleskin.cn/api/yggdrasil`);
  assert.equal(args[1], '-Dauthlibinjector.side=client');
  const pref = args[2].split('prefetched=')[1];
  assert.deepEqual(JSON.parse(Buffer.from(pref, 'base64').toString('utf8')), META);
  assert.throws(() => ali.buildAuthlibArgs({ agentJar: '/no/such.jar', apiRoot: 'https://a.b' }), /jar 不存在/);
  assert.equal(ali.buildAuthlibArgs({ agentJar: '/virtual.jar', apiRoot: 'https://a.b', checkExists: false }).length, 2);
  fs.rmSync(jar);
});

test('authenticate / refresh / validate / invalidate / joinServer 协议正确', async () => {
  const root = 'https://littleskin.cn/api/yggdrasil';
  const fetchImpl = router([
    [/authserver\/authenticate/, (u, i) => {
      const b = bodyOf(i);
      assert.deepEqual(b.agent, { name: 'Minecraft', version: 1 });
      assert.equal(b.username, 'player@example.com');
      assert.equal(b.password, 'p@ss');
      assert.ok(b.clientToken);
      return resp(200, { accessToken: 'YTOKEN', clientToken: b.clientToken, availableProfiles: [{ id: 'abc-def', name: 'Alex' }], selectedProfile: { id: 'abc-def', name: 'Alex' } });
    }],
    [/authserver\/refresh/, (u, i) => resp(200, { accessToken: 'YTOKEN2', clientToken: bodyOf(i).clientToken, selectedProfile: { id: 'abc-def', name: 'Alex' } })],
    [/authserver\/(validate|invalidate)/, () => resp(204, null)],
    [/sessionserver\/session\/minecraft\/join/, (u, i) => {
      assert.equal(bodyOf(i).selectedProfile, 'abcdef');
      return resp(204, null);
    }]
  ]);
  const acc = await ali.authenticate(root, { username: 'player@example.com', password: 'p@ss', clientToken: 'CT1' }, fetchImpl);
  assert.equal(acc.type, 'authlib');
  assert.equal(acc.uuid, 'abcdef', 'UUID 去横线');
  assert.equal(acc.name, 'Alex');
  assert.equal(acc.mcToken, 'YTOKEN');
  const r = await ali.refresh(root, 'YTOKEN', 'CT1', fetchImpl);
  assert.equal(r.mcToken, 'YTOKEN2');
  assert.equal(await ali.validate(root, 'YTOKEN', 'CT1', fetchImpl), true);
  assert.equal(await ali.invalidate(root, 'YTOKEN', 'CT1', fetchImpl), true);
  assert.equal(await ali.joinServer(root, { accessToken: 'YTOKEN', uuid: 'abc-def', serverId: '-abc' }, fetchImpl), true);
  const args = ali.toLaunchArgs(acc);
  assert.equal(args[args.indexOf('--username') + 1], 'Alex');
  assert.equal(args[args.indexOf('--accessToken') + 1], 'YTOKEN');
});

test('agentSources 为真实外网绝对 URL，KNOWN_SERVERS 非空', () => {
  for (const u of ali.agentSources()) assert.match(u, /^https:\/\//);
  assert.ok(ali.KNOWN_SERVERS.some(s => s.apiRoot.startsWith('https://')));
  assert.throws(() => ali.normalizeRoot('/relative'), /绝对 URL/);
});

test('认证服务器非绝对 URL 被拒绝', async () => {
  await assert.rejects(() => ali.authenticate('', { username: 'u', password: 'p' }), /绝对 URL/);
});
