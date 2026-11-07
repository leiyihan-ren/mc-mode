'use strict';
/**
 * mockMicrosoft.cjs — 0.6.0 模块二：协议级离线 Mock（沙盒红线说明）
 *
 * 【为什么需要】沙盒无法真正打开浏览器完成微软授权，也无法保证 login.microsoftonline.com
 * 与 api.minecraftservices.com 可达。为了在 CI/离线环境验证「真实代码逻辑经得起推敲」，
 * 这里按 RFC 8628 与微软/XBL/XSTS/Minecraft Services 的真实响应结构模拟完整六步链路。
 *
 * 【绝不冒充真实登录】
 *  - 只在 DeviceFlowManager 的 mock 模式（或环境变量 MCNEXT_AUTH_MOCK=1）下注入；
 *  - 所有 mock 值以 MOCK_ / Demo 前缀标识，登录结果带 demo:true；
 *  - UI 必须明确标注「演示模式 · 非真实正版账号」，不写入任何可用于启动游戏的真令牌。
 *  - 生产路径默认使用全局 fetch 请求真实端点，不经过本文件。
 */
function resp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

const MOCK_PROFILE = Object.freeze({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'DemoPlayer',
  skins: [{
    id: 'mock-skin', state: 'ACTIVE', variant: 'CLASSIC',
    url: 'https://textures.minecraft.net/texture/mock-demo-skin'
  }],
  capes: []
});

/**
 * @param {object} opts
 *   pendingCount  模拟 authorization_pending 次数（默认 2）
 *   slowDown      是否在之后插入一次 slow_down（默认 true）
 *   tokenError    强制设备码 token 返回的错误码（如 expired_token / access_denied）
 *   failAt        在指定阶段注入失败：devicecode|token|xbl|xsts|mcLogin|profile
 *   profile       覆盖返回的 profile 对象
 */
function createMockMicrosoftFetch(opts = {}) {
  const stats = { polls: 0, requests: [] };
  const pending = Number.isInteger(opts.pendingCount) ? opts.pendingCount : 2;
  const slowDownAt = opts.slowDown === false ? -1 : pending + 1;
  const failAt = opts.failAt || null;

  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? String(init.body) : '';
    stats.requests.push({ url: u, body });

    if (u.includes('/oauth2/v2.0/devicecode')) {
      if (failAt === 'devicecode') return resp(400, { error: 'invalid_client', error_description: 'mock: client 被拒绝' });
      return resp(200, {
        user_code: 'MCNX-DEMO',
        device_code: 'MOCK_DEVICE_CODE',
        verification_uri: 'https://www.microsoft.com/link',
        verification_uri_complete: 'https://www.microsoft.com/link?otc=MCNX-DEMO',
        expires_in: 900,
        interval: 0,
        message: '（演示模式）请在 https://www.microsoft.com/link 输入代码 MCNX-DEMO'
      });
    }

    if (u.includes('/oauth2/v2.0/token')) {
      if (failAt === 'token') return resp(400, { error: 'invalid_grant' });
      if (body.includes('device_code')) {
        stats.polls++;
        if (opts.tokenError) return resp(400, { error: opts.tokenError });
        if (stats.polls <= pending) return resp(400, { error: 'authorization_pending' });
        if (stats.polls === slowDownAt) return resp(400, { error: 'slow_down' });
        return resp(200, {
          token_type: 'Bearer', scope: 'XboxLive.signin offline_access', expires_in: 3600,
          access_token: 'MOCK_MS_ACCESS', refresh_token: 'MOCK_MS_REFRESH'
        });
      }
      // refresh_token / authorization_code 兑换
      return resp(200, {
        token_type: 'Bearer', expires_in: 3600,
        access_token: 'MOCK_MS_ACCESS_REFRESHED', refresh_token: 'MOCK_MS_REFRESH'
      });
    }

    if (u.includes('user.auth.xboxlive.com')) {
      if (failAt === 'xbl') return resp(401, {});
      return resp(200, {
        IssueInstant: '2026-01-01T00:00:00.0000000Z', NotAfter: '2026-01-02T00:00:00.0000000Z',
        Token: 'MOCK_XBL_TOKEN', DisplayClaims: { xui: [{ uhs: 'MOCK_UHS' }] }
      });
    }
    if (u.includes('xsts.auth.xboxlive.com')) {
      if (failAt === 'xsts') return resp(401, { XErr: 2148916238, Message: 'mock: 未成年账户' });
      return resp(200, {
        IssueInstant: '2026-01-01T00:00:00.0000000Z', NotAfter: '2026-01-02T00:00:00.0000000Z',
        Token: 'MOCK_XSTS_TOKEN', DisplayClaims: { xui: [{ uhs: 'MOCK_UHS' }] }
      });
    }
    if (u.includes('login_with_xbox')) {
      if (failAt === 'mcLogin') return resp(401, {});
      return resp(200, {
        username: 'mock-uuid', roles: [], token_type: 'Bearer',
        access_token: 'MOCK_MC_TOKEN', expires_in: 86400
      });
    }
    if (u.includes('/minecraft/profile')) {
      if (failAt === 'profile') return resp(404, {});
      return resp(200, opts.profile || MOCK_PROFILE);
    }
    if (u.includes('entitlements')) return resp(200, { items: [] });
    return resp(404, { error: 'mock: 未处理的端点 ' + u });
  };

  fetchImpl.stats = stats;  // 供测试断言轮询次数 / 请求序列
  return fetchImpl;
}

module.exports = { createMockMicrosoftFetch, MOCK_PROFILE, resp };
