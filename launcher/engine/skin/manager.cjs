'use strict';
/**
 * engine/skin/manager.cjs — 模块四：皮肤资源管理与第三方皮肤站同步
 *
 * 真实能力：
 *  - inspectSkin：校验 PNG 签名 + IHDR，只接受 Minecraft 合法皮肤尺寸（slim/classic 由
 *    skinview3d 的 model:"auto-detect" 在渲染时判定，此处不臆测）
 *  - fetchSkinFromAuthlib：走标准 authlib-injector / Yggdrasil 协议
 *    POST {apiRoot}/api/profiles/minecraft → GET .../sessionserver/session/minecraft/profile/{uuid}
 *    → 解码 textures property → 拿到真实 SKIN / CAPE URL
 *  - uploadSkin：向用户配置的开放 API 端点 multipart 上传。
 *
 * 诚实边界：LittleSkin 官方仅公开 Yggdrasil 认证协议（https://littleskin.cn/api/yggdrasil），
 * 并未提供稳定的「公开一键上传皮肤」REST API。因此上传功能要求用户显式提供 endpoint + token
 * （例如自建 Blessing Skin 启用了 User API 插件）；未配置时明确报错，绝不伪造「同步成功」。
 */
const fs = require('fs');
const crypto = require('crypto');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// 官方尺寸 + 常见 HD 皮肤（HD 需 OptiFine / CustomSkinLayers 之类 Mod 支持）
const VALID_SIZES = [
  { w: 64, h: 32, standard: 'legacy-1.8-' },
  { w: 64, h: 64, standard: 'official-1.8+' },
  { w: 128, h: 64, standard: 'hd-2x' }, { w: 128, h: 128, standard: 'hd-2x' },
  { w: 256, h: 128, standard: 'hd-4x' }, { w: 256, h: 256, standard: 'hd-4x' },
  { w: 512, h: 256, standard: 'hd-8x' }, { w: 512, h: 512, standard: 'hd-8x' },
  { w: 1024, h: 512, standard: 'hd-16x' }, { w: 1024, h: 1024, standard: 'hd-16x' }
];

/** 校验 PNG 与皮肤尺寸 */
function inspectSkin(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  if (buf.length < 24) return { ok: false, error: '文件过短，不是合法 PNG' };
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return { ok: false, error: 'PNG 签名不匹配（不是 PNG 文件）' };
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return { ok: false, error: '缺少 IHDR 块' };
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const hit = VALID_SIZES.find(s => s.w === w && s.h === h);
  if (!hit) {
    return {
      ok: false, width: w, height: h,
      error: `尺寸 ${w}×${h} 不是 Minecraft 合法皮肤尺寸（需 64×32 / 64×64 或 2/4/8/16 倍 HD）`
    };
  }
  return {
    ok: true, width: w, height: h, standard: hit.standard,
    hd: w > 64 || h > 64,
    model: 'auto-detect',
    modelNote: 'Steve/Alex（classic/slim）由 skinview3d 在渲染时按像素自动判定，也可在皮肤页手动指定',
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex')
  };
}

function toDataUrl(buf) { return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`; }

function loadLocalSkin(filePath) {
  const buf = fs.readFileSync(filePath);
  const info = inspectSkin(buf);
  if (!info.ok) return { ok: false, info, error: info.error };
  return { ok: true, info, dataUrl: toDataUrl(buf), path: filePath };
}

/**
 * 解码 Yggdrasil profile 里的 textures property（base64 → JSON）
 * 返回 { skinUrl, capeUrl, model, timestamp, profileId, profileName }
 */
function decodeTexturesProperty(b64) {
  let json;
  try { json = JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8')); }
  catch (e) { throw new Error(`textures 属性不是合法 base64 JSON：${e.message}`); }
  const t = (json && json.textures) || {};
  const skin = t.SKIN || null, cape = t.CAPE || null;
  return {
    skinUrl: skin && skin.url ? String(skin.url) : null,
    skinModel: skin && skin.metadata && skin.metadata.model === 'slim' ? 'slim' : 'default',
    capeUrl: cape && cape.url ? String(cape.url) : null,
    timestamp: json.timestamp || null,
    profileId: json.profileId || null,
    profileName: json.profileName || null
  };
}

function normalizeRoot(apiRoot) {
  return String(apiRoot || 'https://littleskin.cn/api/yggdrasil').replace(/\/+$/, '');
}

/**
 * 从 authlib-injector 兼容皮肤站拉取角色当前皮肤（真实两步协议）。
 * opts: { fetchImpl, timeoutMs, withUnsigned }
 * 返回 { ok, profileId, profileName, skinUrl, capeUrl, model, textures }
 */
async function fetchSkinFromAuthlib(apiRoot, playerName, opts = {}) {
  if (!playerName || !String(playerName).trim()) throw new Error('角色名不能为空');
  const root = normalizeRoot(apiRoot);
  const fetchFn = opts.fetchImpl || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 20000);
  try {
    // 第一步：角色名 → UUID
    const lookup = await fetchFn(`${root}/api/profiles/minecraft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'mc-next/0.3' },
      body: JSON.stringify({ names: [String(playerName).trim()] }),
      signal: ac.signal
    });
    if (!lookup.ok) throw new Error(`查询角色 UUID 失败：HTTP ${lookup.status}`);
    const profiles = await lookup.json();
    const p = Array.isArray(profiles) ? profiles[0] : null;
    if (!p || !p.id) throw new Error(`皮肤站不存在角色「${playerName}」`);
    const uuid = String(p.id).replace(/-/g, '');

    // 第二步：UUID → 带签名 textures 属性的 profile
    const q = opts.withUnsigned === false ? '?unsigned=true' : '?unsigned=false';
    const prof = await fetchFn(`${root}/sessionserver/session/minecraft/profile/${uuid}${q}`, {
      headers: { 'User-Agent': 'mc-next/0.3' }, signal: ac.signal
    });
    if (!prof.ok) throw new Error(`读取角色 profile 失败：HTTP ${prof.status}`);
    const data = await prof.json();
    const props = data.properties || [];
    const tp = props.find(x => x.name === 'textures' && x.value) || props[0];
    if (!tp || !tp.value) throw new Error('profile 中缺少 textures 属性，无法取得皮肤');
    const textures = decodeTexturesProperty(tp.value);
    return {
      ok: true, apiRoot: root,
      profileId: uuid, profileName: p.name || String(playerName),
      ...textures, rawProfile: { id: data.id, name: data.name }
    };
  } finally { clearTimeout(timer); }
}

/** 下载远端皮肤图片为 Buffer（真实网络，失败抛出） */
async function downloadSkinImage(url, opts = {}) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('皮肤 URL 必须是 http(s) 绝对地址');
  const fetchFn = opts.fetchImpl || fetch;
  const resp = await fetchFn(url, { signal: opts.signal, headers: { 'User-Agent': 'mc-next/0.3' } });
  if (!resp.ok) throw new Error(`皮肤图片下载失败：HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const info = inspectSkin(buf);
  if (!info.ok) return { ok: false, error: `远端皮肤不合法：${info.error}`, url };
  return { ok: true, buf, info, dataUrl: toDataUrl(buf), url };
}

/**
 * 上传自定义皮肤到皮肤站开放 API。
 * 必须显式提供 endpoint + token；未提供则抛 NO_UPLOAD_CONFIG，不假装成功。
 * 支持两种常见约定：multipart 字段名 skin / 或 JSON base64（bodyMode）。
 */
async function uploadSkin(opts = {}) {
  const endpoint = String(opts.endpoint || '').trim();
  const token = String(opts.token || '').trim();
  if (!endpoint) {
    const e = new Error('未配置上传 API 端点：LittleSkin 官方未公开稳定的一键上传 REST API，请在皮肤页填写你所用皮肤站（或自建 Blessing Skin + User API 插件）的开放端点');
    e.code = 'NO_UPLOAD_CONFIG'; throw e;
  }
  if (!/^https:\/\//i.test(endpoint)) {
    const e = new Error('上传端点必须是 https 绝对地址'); e.code = 'INVALID_ENDPOINT'; throw e;
  }
  if (!token) {
    const e = new Error('未配置 API Token：请在皮肤站用户中心生成访问令牌后填入');
    e.code = 'NO_TOKEN'; throw e;
  }
  let buf = opts.buf;
  if (!buf && opts.filePath) buf = fs.readFileSync(opts.filePath);
  if (!buf) { const e = new Error('缺少皮肤文件'); e.code = 'NO_FILE'; throw e; }
  const info = inspectSkin(buf);
  if (!info.ok) { const e = new Error(info.error); e.code = 'INVALID_SKIN'; throw e; }

  const fetchFn = opts.fetchImpl || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 30000);
  try {
    let body, headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'User-Agent': 'mc-next/0.3' };
    if (opts.bodyMode === 'json') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        player: opts.player || null, model: opts.model || 'auto-detect',
        skin: toDataUrl(buf), sha256: info.sha256
      });
    } else {
      const fd = new FormData();
      fd.append(opts.fieldName || 'skin', new Blob([buf], { type: 'image/png' }), 'skin.png');
      if (opts.player) fd.append('player', opts.player);
      if (opts.model && opts.model !== 'auto-detect') fd.append('model', opts.model);
      body = fd;
    }
    const resp = await fetchFn(endpoint, { method: 'POST', headers, body, signal: ac.signal });
    const text = await resp.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 保留原文 */ }
    // 只有 HTTP 2xx 且未被响应体明确标记失败，才算成功
    const bodySaysFail = parsed && (parsed.ok === false || parsed.success === false || parsed.code === 'error');
    if (!resp.ok || bodySaysFail) {
      return {
        ok: false, status: resp.status, endpoint,
        error: `上传被拒绝：HTTP ${resp.status}${parsed && parsed.message ? ' - ' + parsed.message : ''}`,
        response: parsed || text.slice(0, 500)
      };
    }
    return {
      ok: true, status: resp.status, endpoint,
      sha256: info.sha256, size: buf.length,
      response: parsed || text.slice(0, 500),
      note: '已收到皮肤站的成功响应；实际生效以皮肤站侧角色材质为准'
    };
  } finally { clearTimeout(timer); }
}

module.exports = {
  PNG_SIG, VALID_SIZES,
  inspectSkin, toDataUrl, loadLocalSkin,
  decodeTexturesProperty, normalizeRoot, fetchSkinFromAuthlib, downloadSkinImage, uploadSkin
};
