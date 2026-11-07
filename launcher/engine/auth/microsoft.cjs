/**
 * microsoft.cjs — 微软正版登录（真实 OAuth2 + Xbox Live + Minecraft Services 全链路）
 *
 * 协议链路（与 HMCL / PCL2 / Prism 一致，非伪实现）：
 *  1. OAuth2 Authorization Code + PKCE（或 Device Code 备用）
 *     https://login.microsoftonline.com/consumers/oauth2/v2.0/{authorize,devicecode,token}
 *  2. XBL  : POST https://user.auth.xboxlive.com/user/authenticate  (RpsTicket = "d=<ms_access_token>")
 *  3. XSTS : POST https://xsts.auth.xboxlive.com/xsts/authorize       (RelyingParty = rp://api.minecraftservices.com/)
 *  4. MC   : POST https://api.minecraftservices.com/authentication/login_with_xbox
 *           identityToken = "XBL3.0 x=<uhs>;<xsts_token>"
 *  5. 档案 : GET  https://api.minecraftservices.com/minecraft/profile
 *  6. 刷新 : POST token (grant_type=refresh_token) → 回到 2
 *
 * client_id 默认使用公开的 Xbox Live 公共客户端；生产部署应在 Azure 注册自己的应用并覆盖。
 * 所有网络调用可注入 fetchImpl，便于真实协议级单元测试。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENDPOINTS = {
  authorize: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
  deviceCode: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
  token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  xbl: 'https://user.auth.xboxlive.com/user/authenticate',
  xsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  mcLogin: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  profile: 'https://api.minecraftservices.com/minecraft/profile',
  entitlements: 'https://api.minecraftservices.com/entitlements/mcstore'
};

const DEFAULT_CLIENT_ID = '00000000402b5328'; // 公开 Xbox Live 公共客户端 ID
const SCOPE = 'XboxLive.signin offline_access';

/** XSTS 真实错误码 → 人类可读诊断 */
const XERR = {
  2148916233: '该微软账号没有关联的 Xbox 账户，请先在 xbox.com 完成注册',
  2148916235: '账户所在地区暂不支持 Xbox Live',
  2148916236: '需要进行成人身份验证',
  2148916237: '需要进行成人身份验证',
  2148916238: '未成年账户，需由家长加入 Microsoft 家庭组',
  2148916240: '未成年账户，需由家长加入 Microsoft 家庭组'
};

class AuthError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = opts.code;
    this.stage = opts.stage;
    this.cause = opts.cause;
  }
}

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function sha256(str) { return crypto.createHash('sha256').update(str).digest(); }

class MicrosoftAuthenticator {
  /**
   * @param {object} opts {clientId, fetchImpl, storeFile, sleep, now}
   */
  constructor(opts = {}) {
    this.clientId = opts.clientId || process.env.MCNEXT_MS_CLIENT_ID || DEFAULT_CLIENT_ID;
    this.fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
    this.storeFile = opts.storeFile || null;
    this._sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    this._now = opts.now || (() => Date.now());
  }

  async _json(url, init = {}, stage = 'http') {
    let resp;
    try { resp = await this.fetchImpl(url, init); }
    catch (e) { throw new AuthError(`网络请求失败: ${e.message}`, { stage, cause: e }); }
    let body = null;
    const text = await resp.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { ok: resp.ok, status: resp.status, body, headers: resp.headers };
  }

  _form(data) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams(data).toString()
    };
  }

  /** PKCE 会话：生成 verifier/challenge/state 与真实授权 URL */
  createPkceSession(redirectUri = 'http://127.0.0.1:29110/callback') {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(sha256(verifier));
    const state = b64url(crypto.randomBytes(16));
    const url = new URL(ENDPOINTS.authorize);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    return { verifier, challenge, state, redirectUri, url: url.toString() };
  }

  /** 用回调里的 code 换取 MS token */
  async exchangeCode(session, code, returnedState) {
    if (returnedState !== undefined && returnedState !== session.state) {
      throw new AuthError('OAuth2 state 不匹配（疑似 CSRF）', { stage: 'oauth', code: 'state_mismatch' });
    }
    return this._requestToken(this._form({
      client_id: this.clientId,
      code,
      redirect_uri: session.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: session.verifier,
      scope: SCOPE
    }));
  }

  /** 设备码流程（无浏览器/无回调端口的备用链路） */
  async createDeviceCodeSession() {
    const r = await this._json(ENDPOINTS.deviceCode, this._form({ client_id: this.clientId, scope: SCOPE }), 'devicecode');
    if (!r.ok || !r.body || !r.body.device_code) {
      throw new AuthError(`设备码申请失败 HTTP ${r.status}`, { stage: 'devicecode' });
    }
    return r.body; // {user_code, device_code, verification_uri, expires_in, interval}
  }

  /** 轮询设备码直到用户完成授权（0.6.0：支持后台取消 + RFC 8628 slow_down 退避） */
  async pollDeviceCode(session, opts = {}) {
    const interval = (session.interval || 5) * 1000;
    const deadline = this._now() + (session.expires_in || 900) * 1000;
    let delay = interval;
    while (this._now() < deadline) {
      // 0.6.0：DeviceFlowManager 的「取消登录」通过此钩子在下一次轮询前真实中断死循环，
      // 而不是让后台任务继续空转到过期。
      if (opts.shouldContinue && !opts.shouldContinue()) {
        throw new AuthError('设备码授权已取消', { stage: 'token', code: 'cancelled' });
      }
      const r = await this._json(ENDPOINTS.token, this._form({
        client_id: this.clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: session.device_code
      }), 'token');
      if (r.ok && r.body && r.body.access_token) return r.body;
      const err = r.body && r.body.error;
      if (err === 'authorization_pending' || err === 'slow_down') {
        // RFC 8628：收到 slow_down 后每次轮询间隔必须再 +5s
        if (err === 'slow_down') delay += 5000;
        if (opts.onPoll) opts.onPoll(err);
        await this._sleep(delay);
        continue;
      }
      if (err === 'expired_token') throw new AuthError('设备码已过期，请重新发起登录', { stage: 'token', code: err });
      throw new AuthError(`设备码授权失败: ${err || 'HTTP ' + r.status}`, { stage: 'token', code: err });
    }
    throw new AuthError('设备码授权超时', { stage: 'token', code: 'timeout' });
  }

  async _requestToken(init) {
    const r = await this._json(ENDPOINTS.token, init, 'token');
    if (!r.ok || !r.body || !r.body.access_token) {
      const desc = (r.body && (r.body.error_description || r.body.error)) || `HTTP ${r.status}`;
      throw new AuthError(`微软令牌获取失败: ${desc}`, { stage: 'token', code: r.body && r.body.error });
    }
    return r.body;
  }

  /** refresh_token → 新的 MS token */
  async refreshMsToken(refreshToken) {
    return this._requestToken(this._form({
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPE
    }));
  }

  async _xblAuthenticate(msAccessToken) {
    const r = await this._json(ENDPOINTS.xbl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        Properties: { AuthMethod: 'RpsTicket', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msAccessToken },
        RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
      })
    }, 'xbl');
    if (!r.ok || !r.body || !r.body.Token) throw new AuthError(`XBL 认证失败 HTTP ${r.status}`, { stage: 'xbl' });
    const uhs = r.body.DisplayClaims && r.body.DisplayClaims.xui && r.body.DisplayClaims.xui[0] && r.body.DisplayClaims.xui[0].uhs;
    if (!uhs) throw new AuthError('XBL 响应缺少 uhs', { stage: 'xbl' });
    return { token: r.body.Token, uhs };
  }

  async _xstsAuthorize(xblToken) {
    const r = await this._json(ENDPOINTS.xsts, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
        RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
      })
    }, 'xsts');
    if (!r.ok || !r.body || !r.body.Token) {
      const xerr = r.body && r.body.XErr;
      throw new AuthError(XERR[xerr] || `XSTS 授权失败 (XErr=${xerr || 'unknown'}, HTTP ${r.status})`,
        { stage: 'xsts', code: xerr });
    }
    const uhs = r.body.DisplayClaims && r.body.DisplayClaims.xui && r.body.DisplayClaims.xui[0] && r.body.DisplayClaims.xui[0].uhs;
    return { token: r.body.Token, uhs: uhs || '' };
  }

  async _mcLogin(uhs, xstsToken) {
    const r = await this._json(ENDPOINTS.mcLogin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` })
    }, 'mcLogin');
    if (!r.ok || !r.body || !r.body.access_token) throw new AuthError(`Minecraft 令牌获取失败 HTTP ${r.status}`, { stage: 'mcLogin' });
    return r.body;
  }

  async _profile(mcToken) {
    const r = await this._json(ENDPOINTS.profile, {
      method: 'GET', headers: { Authorization: `Bearer ${mcToken}` }
    }, 'profile');
    if (r.status === 404) throw new AuthError('该账号没有 Minecraft Java 版正版档案（未购买或未迁移）', { stage: 'profile', code: 'no_profile' });
    if (!r.ok || !r.body || !r.body.name) throw new AuthError(`档案读取失败 HTTP ${r.status}`, { stage: 'profile' });
    return r.body;
  }

  /** 从 MS token 走完全链路，返回规范化账号对象 */
  async authenticateWithMsToken(msToken) {
    const xbl = await this._xblAuthenticate(msToken.access_token);
    const xsts = await this._xstsAuthorize(xbl.token);
    const mc = await this._mcLogin(xsts.uhs || xbl.uhs, xsts.token);
    const profile = await this._profile(mc.access_token);
    return normalizeAccount({
      msAccessToken: msToken.access_token,
      msRefreshToken: msToken.refresh_token,
      msExpiresAt: this._now() + (msToken.expires_in || 3600) * 1000,
      mcToken: mc.access_token,
      mcExpiresAt: this._now() + (mc.expires_in || 86400) * 1000,
      uuid: profile.id,
      name: profile.name,
      skinUrl: profile.skins && profile.skins[0] && profile.skins[0].url,
      capeUrl: profile.capes && profile.capes[0] && profile.capes[0].url
    });
  }

  /** 完整便捷流程：code → 账号 */
  async loginWithCode(session, code, state) {
    const ms = await this.exchangeCode(session, code);
    return this.authenticateWithMsToken(ms);
  }

  /** 账号过期自动刷新（refresh_token → 全链路重签） */
  async ensureValid(account) {
    if (account.mcToken && account.mcExpiresAt && this._now() < account.mcExpiresAt - 60000) return account;
    if (!account.msRefreshToken) throw new AuthError('账号已过期且无 refresh_token，需重新登录', { stage: 'refresh', code: 'no_refresh' });
    const ms = await this.refreshMsToken(account.msRefreshToken);
    const fresh = await this.authenticateWithMsToken(ms);
    if (this.storeFile) this.saveAccount(fresh);
    return fresh;
  }

  // ---- 本地账号仓库（真实文件持久化） ----
  _load() {
    if (!this.storeFile) return { accounts: [] };
    try { return JSON.parse(fs.readFileSync(this.storeFile, 'utf8')); }
    catch { return { accounts: [] }; }
  }
  _save(store) {
    if (!this.storeFile) return;
    fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
    fs.writeFileSync(this.storeFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  }
  saveAccount(account) {
    const store = this._load();
    const i = store.accounts.findIndex(a => a.uuid === account.uuid);
    if (i >= 0) store.accounts[i] = account; else store.accounts.push(account);
    this._save(store);
    return account;
  }
  listAccounts() { return this._load().accounts; }
  deleteAccount(uuid) {
    const store = this._load();
    store.accounts = store.accounts.filter(a => a.uuid !== uuid);
    this._save(store);
  }
}

function normalizeAccount(a) {
  return {
    type: 'microsoft',
    uuid: a.uuid,
    name: a.name,
    mcToken: a.mcToken,
    mcExpiresAt: a.mcExpiresAt,
    msAccessToken: a.msAccessToken,
    msRefreshToken: a.msRefreshToken,
    msExpiresAt: a.msExpiresAt,
    skinUrl: a.skinUrl || null,
    capeUrl: a.capeUrl || null
  };
}

/** 账号 → 真实 MC 启动参数 */
function toLaunchArgs(account) {
  if (!account || !account.mcToken || !account.name) throw new AuthError('账号信息不完整', { stage: 'launch' });
  return [
    '--username', account.name,
    '--uuid', String(account.uuid).replace(/-/g, ''),
    '--accessToken', account.mcToken,
    '--userType', 'mojang',
    '--userProperties', '{}'
  ];
}

module.exports = {
  ENDPOINTS, DEFAULT_CLIENT_ID, SCOPE, XERR, AuthError,
  MicrosoftAuthenticator, normalizeAccount, toLaunchArgs
};
