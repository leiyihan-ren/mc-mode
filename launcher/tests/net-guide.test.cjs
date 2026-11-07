'use strict';
/**
 * 模块一（0.4.0）：P2P 容错诊断与真实网络配置向导单元测试。
 * 不伪造连接状态：用 RoomManager.status() 形态的真实字段 + 日志行做诊断；
 * 断言握手失败弹窗标题、排查步骤、分平台命令与官方链接均为真实内容。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../engine/net/guide.cjs');

const runningStatus = (over = {}) => ({
  connected: false, running: true, virtualIp: null, peers: [],
  reason: null, uptimeMs: 12000, logs: [], ...over
});

// ---------------------------------------------------------------- 向导数据真实性

test('NETWORK_GUIDE 结构完整且链接均为真实 https 地址', () => {
  assert.equal(g.NETWORK_GUIDE.version, '0.4.0');
  assert.ok(g.NETWORK_GUIDE.steps.length >= 6);
  assert.ok(g.NETWORK_GUIDE.ports.some(p => p.proto === 'UDP' && p.port === '11010'));
  assert.ok(g.NETWORK_GUIDE.commands.windows.lines.length >= 2);
  assert.ok(g.NETWORK_GUIDE.commands.linux.lines.some(l => l.includes('ufw')));
  assert.ok(g.NETWORK_GUIDE.commands.verify.lines.some(l => l.includes('easytier-cli')));
  for (const l of g.NETWORK_GUIDE.links) {
    assert.match(l.url, /^https:\/\//);
    assert.ok(l.url.includes('easytier.cn') || l.url.includes('github.com/EasyTier'));
  }
  assert.ok(g.NETWORK_GUIDE.notes.length >= 2);
});

test('GUIDE_LINKS / PORTS 无占位符、含关键 11010 端口与官方文档', () => {
  assert.equal(g.GUIDE_LINKS.docs.url, 'https://easytier.cn/guide/network/port-forward.html');
  assert.ok(g.PORTS.some(p => p.proto === 'UDP' && p.port === '11010'));
  assert.ok(g.PORTS.some(p => !p.inbound && p.port === '15888'), 'RPC 端口应标注无需对外放行');
  for (const s of g.BASE_STEPS) assert.ok(s.title && s.detail && s.id);
});

// ---------------------------------------------------------------- 证据提取 / 分类

test('collectEvidence 读取真实 status 字段与 {t,line} 日志', () => {
  const ev = g.collectEvidence(runningStatus({
    virtualIp: '10.144.144.1', peers: [{ ipv4: '10.144.144.1' }],
    logs: [{ t: 1, line: 'connect timeout after 1.999s' }, { t: 2, line: 'retrying peer' }]
  }), null, { role: 'host', networkName: 'mcnext-abc' });
  assert.equal(ev.running, true);
  assert.equal(ev.connected, false);
  assert.equal(ev.virtualIp, '10.144.144.1');
  assert.equal(ev.peerCount, 1);
  assert.equal(ev.logLines, 2);
  assert.equal(ev.matched.timeout, true);
  assert.equal(ev.room.role, 'host');
});

test('collectEvidence 精确识别 tun / dns / auth 日志模式', () => {
  assert.equal(g.collectEvidence(null, ['open /dev/net/tun: permission denied'], {}).matched.tun, true);
  assert.equal(g.collectEvidence(null, ['failed to resolve host public.easytier.cn'], {}).matched.dns, true);
  assert.equal(g.collectEvidence(null, ['authentication failed: network secret mismatch'], {}).matched.auth, true);
  // 仅出现节点地址，不应误判为 DNS 失败
  assert.equal(g.collectEvidence(null, ['connecting to tcp://public.easytier.cn:11010'], {}).matched.dns, false);
});

test('classify 覆盖各失败类别与已连接', () => {
  assert.equal(g.classify({ running: false, reason: '联机进程未启动' }, { running: false, matched: {}, peerCount: 0 }), 'not-running');
  assert.equal(g.classify({ running: false, reason: '未找到 easytier-cli' }, { running: false, matched: {}, peerCount: 0 }), 'binary-missing');
  assert.equal(g.classify({}, { running: true, connected: true, peerCount: 2, matched: {} }), 'connected');
  assert.equal(g.classify({}, { running: true, connected: false, peerCount: 0, reason: 'CLI 查询失败', matched: {} }), 'cli-failure');
  assert.equal(g.classify({}, { running: true, peerCount: 0, matched: { tun: true } }), 'tun-missing');
  assert.equal(g.classify({}, { running: true, peerCount: 0, matched: { dns: true } }), 'node-unreachable');
  assert.equal(g.classify({}, { running: true, peerCount: 0, matched: { timeout: true } }), 'timeout-udp');
  assert.equal(g.classify({}, { running: true, peerCount: 0, matched: {} }), 'no-peers');
});

// ---------------------------------------------------------------- 诊断主函数：握手失败弹窗

test('握手超时且无 peer：shouldPrompt=true，标题含「请检查防火墙/路由器 UDP 限制」', () => {
  const r = g.diagnoseHandshake({ status: runningStatus(), room: { role: 'host' } });
  assert.equal(r.failed, true);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-peers');
  assert.equal(r.isHandshakeFailure, true);
  assert.equal(r.timedOut, true);
  assert.equal(r.shouldPrompt, true);
  assert.ok(r.title.includes('请检查防火墙/路由器 UDP 限制'));
  assert.equal(r.notice, '请检查防火墙/路由器 UDP 限制');
  assert.equal(r.severity, 'error');
});

test('失败弹窗给出可执行排查步骤（防火墙置顶）+ 分平台命令 + 官方链接', () => {
  const r = g.diagnoseHandshake({ status: runningStatus({ logs: [{ line: 'connect timeout after 2.0s' }] }) });
  assert.equal(r.code, 'timeout-udp');
  assert.ok(r.steps.length >= 6);
  assert.equal(r.steps[0].n, 1);
  assert.equal(r.steps[0].focused, true);
  assert.ok(r.steps.some(s => s.id === 'firewall'));
  assert.ok(r.steps.some(s => s.id === 'router'));
  assert.ok(r.steps.some(s => s.id === 'relay'));
  assert.ok(r.steps.some(s => s.id === 'verify'));
  assert.ok(r.commands.windows.lines.some(l => l.includes('11010')));
  assert.ok(r.links.every(l => /^https:\/\//.test(l.url)));
  assert.ok(r.ports.some(p => p.proto === 'UDP'));
});

test('未达超时阈值不弹窗（避免启动瞬间误报）', () => {
  const r = g.diagnoseHandshake({ status: runningStatus({ uptimeMs: 3000 }) });
  assert.equal(r.timedOut, false);
  assert.equal(r.shouldPrompt, false);
  assert.equal(r.failed, true);
});

test('thresholdMs 可配置；elapsedMs 显式传入优先于 uptimeMs', () => {
  const r = g.diagnoseHandshake({ status: runningStatus(), elapsedMs: 4000, thresholdMs: 3000 });
  assert.equal(r.elapsedMs, 4000);
  assert.equal(r.timedOut, true);
  assert.equal(r.shouldPrompt, true);
});

test('未运行 / 二进制缺失不算握手失败，不弹 UDP 提示', () => {
  const notRunning = g.diagnoseHandshake({ status: { running: false, connected: false, reason: '联机进程未启动' } });
  assert.equal(notRunning.shouldPrompt, false);
  assert.equal(notRunning.isHandshakeFailure, false);
  assert.equal(notRunning.notice, null);
  const noBin = g.diagnoseHandshake({ status: { running: false, connected: false, reason: '未找到 easytier-cli，无法读取状态' } });
  assert.equal(noBin.code, 'binary-missing');
  assert.equal(noBin.shouldPrompt, false);
});

test('各种失败类别均带 UDP 提示与聚焦步骤', () => {
  const cases = [
    ['connect timeout after 1.9s', 'timeout-udp'],
    ['open /dev/net/tun: permission denied', 'tun-missing'],
    ['failed to resolve host peer.example', 'node-unreachable'],
    ['authentication failed: network secret mismatch', 'secret-mismatch']
  ];
  for (const [line, code] of cases) {
    const r = g.diagnoseHandshake({ status: runningStatus({ logs: [{ line }] }) });
    assert.equal(r.code, code, line);
    assert.ok(r.title.includes('请检查防火墙/路由器 UDP 限制'), line);
    assert.equal(r.shouldPrompt, true);
    assert.ok(r.steps.length > 0);
  }
});

// ---------------------------------------------------------------- 已连接 / 签名

test('真实 CLI 回报虚拟 IP 与 peer 时判定已连接，不弹窗、不返回步骤', () => {
  const r = g.diagnoseHandshake({
    status: {
      connected: true, running: true, virtualIp: '10.144.144.1', uptimeMs: 20000,
      peers: [{ id: '4110229792', hostname: 'host-a', ipv4: '10.144.144.1', cost: 'Local' }],
      logs: [{ line: 'peer connected' }]
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.failed, false);
  assert.equal(r.code, 'connected');
  assert.equal(r.shouldPrompt, false);
  assert.equal(r.notice, null);
  assert.deepEqual(r.steps, []);
  assert.equal(r.evidence.virtualIp, '10.144.144.1');
  assert.equal(r.evidence.peerCount, 1);
});

test('signature 稳定且随状态变化（供前端去重）', () => {
  const a = g.diagnoseHandshake({ status: runningStatus() });
  const b = g.diagnoseHandshake({ status: runningStatus() });
  assert.equal(a.signature, b.signature);
  const c = g.diagnoseHandshake({ status: runningStatus({ peers: [{ ipv4: '10.144.144.2' }] }) });
  assert.notEqual(a.signature, c.signature);
  assert.match(a.signature, /^[0-9a-f]{12}$/);
});

test('diagnoseHandshake 空输入不崩溃且如实返回未运行', () => {
  const r = g.diagnoseHandshake();
  assert.equal(r.code, 'not-running');
  assert.equal(r.shouldPrompt, false);
  assert.equal(r.evidence.running, false);
});
