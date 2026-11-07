'use strict';
/**
 * deviceFlow.cjs — 0.6.0 模块二：微软 OAuth2 设备码「真流程」会话管理器
 *
 * 与 0.2.0 的框架级实现的区别（用户要求「抛弃框架假数据」）：
 *  1. **后台死循环轮询**：beginPolling() 立即返回，主进程独立跑 RFC 8628 轮询
 *     （authorization_pending / slow_down 退避 / expired_token / 超时），UI 用 status() 或事件订阅读状态。
 *  2. **六步真实协议**：devicecode → MS token → XBL → XSTS → MC login → profile，
 *     由 microsoft.cjs 发真实 HTTPS 请求；拿到 token 后真实读取正版档案（name/UUID/皮肤 URL）。
 *  3. **可取消**：shouldContinue 钩子在下一次轮询前真实中断后台任务，不留空转协程。
 *  4. **账号持久化 + 当前账号**：saveAccount 写 accounts.json（0600），current-account.json 记住选择，
 *     供主页展示正版玩家卡片。
 *  5. **Mock 明确隔离**：仅 mock 模式注入 mockMicrosoft.cjs，结果带 demo:true，绝不混入真实账号文件。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MicrosoftAuthenticator, AuthError } = require('./microsoft.cjs');
const { createMockMicrosoftFetch } = require('./mockMicrosoft.cjs');

const UPDATES_LIMIT = 60;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

class DeviceFlowManager {
  /**
   * @param {object} opts
   *   storeFile    账号仓库路径（真实模式）
   *   currentFile  当前账号选择文件
   *   mock         全局 mock 模式（环境变量 / 离线演示）
   *   mockOptions  传给 mockMicrosoft.cjs 的注入选项
   *   fetchImpl    显式注入网络层（测试用，优先级最高）
   *   sleep / now  可注入时钟
   *   onStatus     状态变化回调（IPC 事件推送）
   */
  constructor(opts = {}) {
    this.storeFile = opts.storeFile || null;
    this.currentFile = opts.currentFile || null;
    this.mockMode = !!opts.mock;
    this.now = opts.now || (() => Date.now());
    this._sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    this.onStatus = opts.onStatus || null;
    this.mockOptions = opts.mockOptions || {};

    const fetchImpl = opts.fetchImpl || (this.mockMode ? createMockMicrosoftFetch(this.mockOptions) : undefined);
    // 全局 mock 模式也把演示账号隔离到独立文件
    this.mockStoreFile = this.storeFile ? this.storeFile + '.mock.json' : null;
    this.authenticator = new MicrosoftAuthenticator({
      storeFile: this.mockMode ? this.mockStoreFile : this.storeFile,
      fetchImpl,
      sleep: this._sleep,
      now: this.now
    });
    this.sessions = new Map();
  }

  /** 公开发给渲染层的账号视图（剔除全部令牌，只保留展示与启动所需字段） */
  static publicAccount(a, demo = false) {
    if (!a) return null;
    return {
      type: 'microsoft',
      uuid: a.uuid,
      name: a.name,
      skinUrl: a.skinUrl || null,
      capeUrl: a.capeUrl || null,
      mcExpiresAt: a.mcExpiresAt || null,
      hasRefresh: !!a.msRefreshToken,
      demo: !!demo
    };
  }

  _view(rec) {
    const s = rec.session || {};
    return {
      id: rec.id,
      state: rec.state,
      userCode: s.user_code || null,
      verificationUri: s.verification_uri || null,
      verificationUriComplete: s.verification_uri_complete || null,
      message: s.message || `请在 ${s.verification_uri || 'https://www.microsoft.com/link'} 输入代码 ${s.user_code || ''}`,
      expiresIn: s.expires_in || 900,
      interval: s.interval || 5,
      pollCount: rec.pollCount,
      elapsedMs: Math.max(0, this.now() - rec.startedAt),
      mock: rec.mock,
      account: DeviceFlowManager.publicAccount(rec.account, rec.mock),
      error: rec.error,
      code: rec.code,
      stage: rec.stage
    };
  }

  _emit(rec) {
    const view = this._view(rec);
    rec.updates.push(view);
    if (rec.updates.length > UPDATES_LIMIT) rec.updates.shift();
    if (rec.onUpdate) { try { rec.onUpdate(view); } catch { /* UI 回调异常不打断轮询 */ } }
    if (this.onStatus) { try { this.onStatus(view); } catch { /* 同上 */ } }
  }

  /** 第 1 步：申请真实设备码。mock=true 时按会话使用协议级 Mock，并明确标注 */
  async start(opts = {}) {
    // 显式注入 fetchImpl 只用于协议级测试/离线演示，一律按 mock 隔离处理
    const useMock = !!opts.mock || this.mockMode || !!opts.fetchImpl;
    let auth = this.authenticator;
    const mockStore = this.storeFile ? this.storeFile + '.mock.json' : null;
    if (opts.fetchImpl) {
      auth = new MicrosoftAuthenticator({
        storeFile: mockStore,
        fetchImpl: opts.fetchImpl,
        sleep: this._sleep,
        now: this.now
      });
    } else if (useMock && !this.mockMode) {
      auth = new MicrosoftAuthenticator({
        // 演示账号单独落盘，绝不污染真实 accounts.json
        storeFile: mockStore,
        fetchImpl: createMockMicrosoftFetch({ ...this.mockOptions, ...(opts.mockOptions || {}) }),
        sleep: this._sleep,
        now: this.now
      });
    }
    const session = await auth.createDeviceCodeSession();
    const id = crypto.randomUUID();
    const rec = {
      id, auth, session, mock: useMock,
      state: 'pending', startedAt: this.now(), pollCount: 0,
      cancelled: false, promise: null, account: null,
      error: null, code: null, stage: null, onUpdate: null, updates: []
    };
    this.sessions.set(id, rec);
    return this._view(rec);
  }

  /** 第 2 步：启动后台轮询（非阻塞）。返回后 UI 用 status()/事件追踪，不阻塞 IPC 与渲染 */
  beginPolling(id, onUpdate) {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error('设备码会话不存在或已过期，请重新发起登录');
    if (rec.state !== 'pending') throw new Error(`会话状态为 ${rec.state}，不能重复发起轮询`);
    rec.state = 'polling';
    rec.onUpdate = onUpdate || null;
    rec.promise = this._run(rec);
    // 错误经 status() 暴露，这里吞掉 rejection 避免 unhandledRejection 杀进程
    rec.promise.catch(() => {});
    this._emit(rec);
    return this._view(rec);
  }

  async _run(rec) {
    try {
      const token = await rec.auth.pollDeviceCode(rec.session, {
        shouldContinue: () => !rec.cancelled,
        onPoll: (err) => { rec.pollCount++; rec.lastPoll = err; this._emit(rec); }
      });
      if (rec.cancelled) throw new AuthError('设备码授权已取消', { stage: 'token', code: 'cancelled' });

      rec.state = 'authorizing';
      this._emit(rec);
      // 第 3~6 步：XBL → XSTS → Minecraft Services → 正版档案（皮肤/UUID/名字）
      const account = await rec.auth.authenticateWithMsToken(token);
      rec.auth.saveAccount(account);
      this._setCurrent(account.uuid, rec.mock);
      rec.account = account;
      rec.state = 'success';
      this._emit(rec);
      return account;
    } catch (e) {
      const code = e && e.code;
      rec.state = code === 'cancelled' ? 'cancelled'
        : (code === 'expired_token' || code === 'timeout' ? 'expired' : 'error');
      rec.error = e && e.message ? e.message : String(e);
      rec.code = code || null;
      rec.stage = (e && e.stage) || null;
      this._emit(rec);
      throw e;
    }
  }

  status(id) {
    const rec = this.sessions.get(id);
    if (!rec) return { id, state: 'not-found' };
    return this._view(rec);
  }

  /** 真实中断后台轮询（下一次循环检查 shouldContinue 即退出） */
  cancel(id) {
    const rec = this.sessions.get(id);
    if (!rec) return { id, state: 'not-found' };
    rec.cancelled = true;
    if (rec.state === 'polling' || rec.state === 'pending') {
      rec.state = 'cancelled';
      rec.error = '用户已取消设备码登录';
      rec.code = 'cancelled';
      this._emit(rec);
    }
    return this._view(rec);
  }

  /** 兼容旧 UI：发起并等待完成（内部仍是同一套真实后台流程） */
  async complete(id) {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error('设备码会话不存在或已过期，请重新发起登录');
    if (rec.state === 'pending') this.beginPolling(id);
    const account = await rec.promise;
    return DeviceFlowManager.publicAccount(account, rec.mock);
  }

  // ---------------- 当前账号（主页正版玩家卡片） ----------------
  _setCurrent(uuid, demo = false) {
    if (!this.currentFile) return;
    // 演示账号不写入「当前账号」文件，避免污染真实登录态
    writeJson(this.currentFile, { uuid, demo: !!demo, updatedAt: this.now() });
  }

  select(uuid) {
    const account = this.authenticator.listAccounts().find(a => a.uuid === uuid);
    if (!account) throw new Error('账号不存在');
    this._setCurrent(uuid, false);
    return DeviceFlowManager.publicAccount(account, false);
  }

  current() {
    const saved = this.currentFile ? readJson(this.currentFile, {}) : {};
    if (saved.demo) {
      // 演示账号从隔离的 mock 仓库读取，UI 会明确标注「演示模式」
      const mockAccounts = this.mockStoreFile ? readJson(this.mockStoreFile, { accounts: [] }).accounts || [] : [];
      const demo = mockAccounts.find(a => a.uuid === saved.uuid) || null;
      return { account: DeviceFlowManager.publicAccount(demo, true), total: 0, demo: true };
    }
    const accounts = this.authenticator.listAccounts();
    const account = accounts.find(a => a.uuid === saved.uuid) || accounts[0] || null;
    return {
      account: DeviceFlowManager.publicAccount(account, false),
      total: accounts.length,
      demo: false
    };
  }

  /** 账号列表（剔除令牌，供 auth:list 复用） */
  list() {
    return this.authenticator.listAccounts().map(a => ({
      ...DeviceFlowManager.publicAccount(a, false),
      hasRefresh: !!a.msRefreshToken
    }));
  }
}

module.exports = { DeviceFlowManager, UPDATES_LIMIT };
