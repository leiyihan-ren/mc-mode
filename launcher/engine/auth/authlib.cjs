/**
 * authlib.cjs — Authlib-Injector / Yggdrasil 第三方认证（LittleSkin 等皮肤站）
 *
 * 真实规范参考 authlib-injector yushijinhun 文档与 Yggdrasil (wiki.vg) 协议：
 *  - 认证服务器根地址返回 metadata：{ meta: {serverName,...}, skinDomains, signaturePublickey }
 *  - /authserver/authenticate|refresh|validate|invalidate|signout
 *  - /sessionserver/session/minecraft/join|hasJoined  （正版验证 joinServer）
 *  - JVM 注入：-javaagent:<jar>=<apiRoot> -Dauthlibinjector.side=client
 *    -Dauthlibinjector.yggdrasil.prefetched=<base64(metadata)>  （启动期免联网预取）
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const ALI_META_HEADER = 'X-Authlib-Injector-API-Location';
const DEFAULT_AGENT_VERSION = '1.2.5';

/** 常见第三方认证站（真实公开 API Root，用户可自行添加任意皮肤站） */
const KNOWN_SERVERS = [
  { name: 'LittleSkin', apiRoot: 'https://littleskin.cn/api/yggdrasil' },
  { name: '自定义皮肤站', apiRoot: '' }
];

function normalizeRoot(apiRoot) {
  let s = String(apiRoot || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) throw new Error('认证服务器地址必须是 http(s) 绝对 URL: ' + s);
  return s;
}

async function _json(url, init, fetchImpl, stage) {
  let resp;
  try { resp = await fetchImpl(url, init); }
  catch (e) { throw new Error(`[${stage}] 网络失败: ${e.message}`); }
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* 部分端点返回空体 */ }
  if (!resp.ok) {
    const msg = (body && (body.errorMessage || body.error || body.message)) || `HTTP ${resp.status}`;
    throw new Error(`[${stage}] ${msg} (HTTP ${resp.status})`);
  }
  return { body, headers: resp.headers };
}

/** 拉取并校验 authlib-injector 元数据 */
async function fetchMetadata(apiRoot, fetchImpl = (...a) => fetch(...a)) {
  const root = normalizeRoot(apiRoot);
  const { body, headers } = await _json(root, { method: 'GET', headers: { Accept: 'application/json' } }, fetchImpl, 'metadata');
  if (!body || !body.meta || !body.meta.serverName) {
    throw new Error('该地址不是有效的 authlib-injector / Yggdrasil 认证服务器（缺少 meta.serverName）');
  }
  const declaredRoot = headers && headers.get && headers.get(ALI_META_HEADER);
  return {
    apiRoot: root,
    declaredRoot: declaredRoot || null,
    serverName: body.meta.serverName,
    meta: body.meta,
    skinDomains: Array.isArray(body.skinDomains) ? body.skinDomains : [],
    signaturePublickey: body.signaturePublickey || null,
    raw: body
  };
}

/** authlib-injector 启动期预取数据（base64 of metadata JSON） */
function prefetchedData(metadata) {
  const raw = metadata && metadata.raw ? metadata.raw : metadata;
  return Buffer.from(JSON.stringify(raw)).toString('base64');
}

/**
 * 构造真实 JVM 注入参数。
 * @param {object} o {agentJar, apiRoot, metadata, checkExists}
 */
function buildAuthlibArgs(o = {}) {
  if (!o.agentJar) throw new Error('缺少 authlib-injector jar 路径');
  const root = normalizeRoot(o.apiRoot);
  if (o.checkExists !== false && !fs.existsSync(o.agentJar)) {
    throw new Error('authlib-injector jar 不存在: ' + o.agentJar);
  }
  const args = [
    `-javaagent:${o.agentJar}=${root}`,
    '-Dauthlibinjector.side=client'
  ];
  if (o.metadata) args.push('-Dauthlibinjector.yggdrasil.prefetched=' + prefetchedData(o.metadata));
  return args;
}

/** authlib-injector 本体多源下载地址（可被本地 jar 覆盖） */
function agentSources(version = DEFAULT_AGENT_VERSION) {
  return [
    `https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/${version}/authlib-injector-${version}.jar`,
    `https://github.com/yushijinhun/authlib-injector/releases/download/v${version}/authlib-injector-${version}.jar`
  ];
}

function makeClientToken() { return crypto.randomUUID().replace(/-/g, ''); }

async function authenticate(apiRoot, credentials, fetchImpl = (...a) => fetch(...a)) {
  const root = normalizeRoot(apiRoot);
  const { username, password, clientToken = makeClientToken(), requestUser = true } = credentials || {};
  if (!username || !password) throw new Error('用户名与密码不能为空');
  const { body } = await _json(root + '/authserver/authenticate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent: { name: 'Minecraft', version: 1 },
      username, password, clientToken, requestUser
    })
  }, fetchImpl, 'authenticate');
  return normalizeYggdrasilAccount(body, clientToken, root);
}

async function refresh(apiRoot, accessToken, clientToken, fetchImpl = (...a) => fetch(...a)) {
  const root = normalizeRoot(apiRoot);
  const { body } = await _json(root + '/authserver/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, clientToken, requestUser: true })
  }, fetchImpl, 'refresh');
  return normalizeYggdrasilAccount(body, clientToken, root);
}

async function validate(apiRoot, accessToken, clientToken, fetchImpl = (...a) => fetch(...a)) {
  const root = normalizeRoot(apiRoot);
  await _json(root + '/authserver/validate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, clientToken })
  }, fetchImpl, 'validate');
  return true;
}

async function invalidate(apiRoot, accessToken, clientToken, fetchImpl = (...a) => fetch(...a)) {
  const root = normalizeRoot(apiRoot);
  await _json(root + '/authserver/invalidate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, clientToken })
  }, fetchImpl, 'invalidate');
  return true;
}

/** 正版验证协议：进入服务器前 join（serverId 为 sha1(secret+publicKey) 的「-」形式） */
async function joinServer(apiRoot, { accessToken, uuid, serverId }, fetchImpl = (...a) => fetch(...a)) {
  const root = normalizeRoot(apiRoot);
  await _json(root + '/sessionserver/session/minecraft/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, selectedProfile: String(uuid).replace(/-/g, ''), serverId })
  }, fetchImpl, 'join');
  return true;
}

function normalizeYggdrasilAccount(body, clientToken, apiRoot) {
  if (!body || !body.accessToken) throw new Error('认证响应缺少 accessToken');
  const profile = body.selectedProfile || (body.availableProfiles && body.availableProfiles[0]);
  if (!profile || !profile.id || !profile.name) throw new Error('该账号没有可用游戏档案');
  return {
    type: 'authlib',
    apiRoot,
    uuid: String(profile.id).replace(/-/g, ''),
    name: profile.name,
    mcToken: body.accessToken,
    clientToken: body.clientToken || clientToken,
    availableProfiles: body.availableProfiles || []
  };
}

/** Yggdrasil 账号 → 真实 MC 启动参数 */
function toLaunchArgs(account) {
  if (!account || !account.mcToken || !account.name) throw new Error('账号信息不完整');
  return [
    '--username', account.name,
    '--uuid', String(account.uuid).replace(/-/g, ''),
    '--accessToken', account.mcToken,
    '--userType', 'mojang',
    '--userProperties', '{}'
  ];
}

module.exports = {
  ALI_META_HEADER, KNOWN_SERVERS, DEFAULT_AGENT_VERSION,
  normalizeRoot, fetchMetadata, prefetchedData, buildAuthlibArgs, agentSources,
  authenticate, refresh, validate, invalidate, joinServer,
  normalizeYggdrasilAccount, toLaunchArgs, makeClientToken
};
