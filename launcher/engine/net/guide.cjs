'use strict';
/**
 * engine/net/guide.cjs — 【0.4.0 模块一】真实 P2P 联机容错 / 网络配置向导
 *
 * 背景（诚实边界）：沙盒没有 /dev/net/tun、loopback UDP 打洞超时，
 * 双节点真实握手无法在 CI 内完成。本模块绝不伪造「已连接」，而是：
 *  - 只依据 RoomManager.status() 的真实字段（running / connected / virtualIp /
 *    peers / reason / logs / uptimeMs）做诊断
 *  - 握手失败时给出分平台、可执行的排查步骤 + 真实官方文档链接
 *  - 前端据此弹窗，标题明确「请检查防火墙/路由器 UDP 限制」
 *
 * 所有命令与端口来自 EasyTier 官方文档 / 服务端部署指南（TCP/UDP 11010），
 * 不含任何编造的连接状态。纯函数 + 常量模块，无 IO，可独立单测。
 */
const crypto = require('crypto');

const HANDSHAKE_TIMEOUT_MS = 10000; // 运行超过 10s 仍无 peer 视为握手未成功

/** 真实官方文档 / 项目地址（已核验可访问） */
const GUIDE_LINKS = {
  home: { id: 'home', name: 'EasyTier 官网', url: 'https://easytier.cn' },
  docs: { id: 'docs', name: 'EasyTier 官方文档 · 端口转发与网络配置', url: 'https://easytier.cn/guide/network/port-forward.html' },
  github: { id: 'github', name: 'EasyTier GitHub 仓库', url: 'https://github.com/EasyTier/EasyTier' },
  releases: { id: 'releases', name: 'EasyTier Releases（下载对应平台二进制）', url: 'https://github.com/EasyTier/EasyTier/releases' }
};

/** 真实需要关注的端口（11010 为官方服务端指南的公共节点入口） */
const PORTS = [
  { proto: 'UDP', port: '11010', use: 'P2P 打洞辅助与数据传输（最关键，常被防火墙拦截）', inbound: true },
  { proto: 'TCP', port: '11010', use: '公共节点握手与中继', inbound: true },
  { proto: 'UDP', port: '11011 / 11012', use: '按 -l,--listeners 额外配置的监听端口（如有）', inbound: true },
  { proto: 'TCP', port: '15888', use: 'easytier-cli 本机 RPC 管理端口，仅 127.0.0.1，无需对外放行', inbound: false }
];

/** 分平台可执行命令（真实语法，复制到管理员终端执行） */
const COMMANDS = {
  windows: {
    label: 'Windows（管理员 PowerShell）',
    lines: [
      'New-NetFirewallRule -DisplayName "EasyTier UDP 11010" -Direction Inbound -Protocol UDP -LocalPort 11010 -Action Allow',
      'New-NetFirewallRule -DisplayName "EasyTier TCP 11010" -Direction Inbound -Protocol TCP -LocalPort 11010 -Action Allow',
      'Get-NetFirewallRule | Where-Object { $_.DisplayName -like "*EasyTier*" }',
      'Test-NetConnection -ComputerName public.easytier.cn -Port 11010'
    ]
  },
  macos: {
    label: 'macOS（终端）',
    lines: [
      'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /path/to/easytier-core',
      'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp /path/to/easytier-core',
      'sudo pfctl -sr | grep 11010',
      'nc -vz -u public.easytier.cn 11010'
    ]
  },
  linux: {
    label: 'Linux（终端）',
    lines: [
      'sudo ufw allow 11010/udp && sudo ufw allow 11010/tcp',
      'sudo firewall-cmd --permanent --add-port=11010/udp --add-port=11010/tcp && sudo firewall-cmd --reload',
      'sudo ss -lunp | grep easytier',
      'ls -l /dev/net/tun && sudo modprobe tun'
    ]
  },
  verify: {
    label: '组网状态验证（所有平台通用）',
    lines: [
      'easytier-cli -p 127.0.0.1:15888 -o json node',
      'easytier-cli -p 127.0.0.1:15888 -o json peer',
      'easytier-cli -p 127.0.0.1:15888 -o json route'
    ]
  }
};

/** 通用排查步骤（真实、可执行，按优先级排序） */
const BASE_STEPS = [
  {
    id: 'firewall',
    title: '放行本机防火墙的 UDP / TCP 11010',
    detail: 'EasyTier 依赖 UDP 打洞，若系统防火墙拦截 UDP 入站，握手会一直超时。按下方对应平台命令放行后重启联机核心。',
    commandKey: 'windows'
  },
  {
    id: 'router',
    title: '检查路由器 / 光猫的 UDP 限制与 NAT 类型',
    detail: '在路由器管理页开启 UPnP 或 NAT-PMP；若处于对称型 NAT（NAT4）或运营商 CGNAT（无公网 IP），直连打洞大概率失败，需要公网中继节点。'
  },
  {
    id: 'shared-node',
    title: '确认公共共享节点可达',
    detail: '默认使用 tcp://public.easytier.cn:11010。若该节点被网络策略阻断或 DNS 解析失败，可在有公网 IP 的服务器自建节点，并把邀请码/房间参数中的共享节点替换为 tcp://<你的公网IP>:11010。'
  },
  {
    id: 'relay',
    title: '（跨网/复杂 NAT）部署公网中继节点',
    detail: '在公网服务器运行 easytier-core --network-name <名> --network-secret <密钥> -l tcp://0.0.0.0:11010 -l udp://0.0.0.0:11010，并在服务器安全组放行 TCP/UDP 11010；所有成员用 -p tcp://<公网IP>:11010 连接。'
  },
  {
    id: 'secret',
    title: '核对网络名与网络密钥完全一致',
    detail: '房主与成员必须来自同一份邀请码（MCET1.xxxx.yyyy），网络名 network-name 与 network-secret 任一不一致都无法加入同一虚拟网。'
  },
  {
    id: 'version',
    title: '确认双方 EasyTier 版本一致',
    detail: '不同大版本的 easytier-core 可能无法互通。用 easytier-core --version 核对，统一下载同一 Release 的二进制。'
  },
  {
    id: 'tun',
    title: '检查 TUN 虚拟网卡设备（如未使用 --no-tun）',
    detail: 'Linux 需存在 /dev/net/tun 且当前用户有权限；Windows 需安装 WinTun 驱动；Android 需授予 VPN 权限。缺少 TUN 时可用 --no-tun 降级，但部分转发能力会受限。'
  },
  {
    id: 'verify',
    title: '用 easytier-cli 读取真实状态（不要凭 UI 猜测）',
    detail: '启动后执行下方「组网状态验证」命令：node 有虚拟 IP、peer 出现远端成员，才算真正打通。仅有进程 PID 不等于已连接。',
    commandKey: 'verify'
  }
];

/** 按诊断码追加的针对性提示 */
const CODE_HINTS = {
  'timeout-udp': {
    title: '检测到握手超时',
    summary: 'easytier-core 日志出现连接/握手超时，通常是 UDP 被防火墙或路由器丢弃，或公共节点不可达。',
    focus: ['firewall', 'router', 'shared-node', 'relay', 'verify']
  },
  'no-peers': {
    title: '核心已运行但迟迟没有远端成员',
    summary: '进程正常但 easytier-cli 的 peer 列表里只有本机，说明 NAT 穿透未成功，最常见原因是防火墙/路由器 UDP 限制。',
    focus: ['firewall', 'router', 'shared-node', 'secret', 'verify']
  },
  'tun-missing': {
    title: 'TUN 设备不可用',
    summary: '日志提示 tun/权限相关错误，虚拟网卡未能创建，需检查 /dev/net/tun 或使用 --no-tun 降级。',
    focus: ['tun', 'firewall', 'verify']
  },
  'node-unreachable': {
    title: '公共共享节点不可达',
    summary: '日志出现 DNS 解析失败或公共节点连接失败，需要更换/自建共享节点，并确认 outbound TCP/UDP 11010 未被阻断。',
    focus: ['shared-node', 'relay', 'firewall', 'verify']
  },
  'secret-mismatch': {
    title: '网络密钥 / 认证不匹配',
    summary: '日志出现认证或解密失败，通常是双方网络名/密钥不一致，或邀请码复制不完整。',
    focus: ['secret', 'version', 'verify']
  },
  'cli-failure': {
    title: 'easytier-cli 无法读取状态',
    summary: 'RPC 管理端口查询失败，可能是 core 未就绪、rpc-portal 不一致或 cli 二进制缺失；此时不能判定为「已连接」。',
    focus: ['verify', 'version']
  },
  'binary-missing': {
    title: 'EasyTier 运行时缺失',
    summary: '未找到 easytier-core / easytier-cli 二进制，联机核心根本没启动。请先放置运行时或安装同版本 Release。',
    focus: ['version', 'verify']
  },
  'not-running': {
    title: '联机核心未启动',
    summary: '当前没有运行中的 easytier-core 进程，先创建/加入房间并点击「启动联机」。',
    focus: []
  },
  'connected': {
    title: '组网已建立',
    summary: 'easytier-cli 已回报虚拟 IP 与远端成员，可以开始联机。',
    focus: []
  }
};

/** 完整向导（供 UI 随时手动打开，与诊断弹窗共用同一份真实数据） */
const NETWORK_GUIDE = {
  version: '0.4.0',
  title: '真实网络配置向导 · EasyTier P2P 联机',
  intro: '启动器内的「联机大厅」基于真实 EasyTier P2P VPN。沙盒/CI 环境无法完成双节点公网握手，因此本向导给出真实环境逐项排查步骤；所有状态一律以 easytier-cli 的真实输出为准，不伪造「已连接」。',
  ports: PORTS,
  steps: BASE_STEPS,
  commands: COMMANDS,
  links: Object.values(GUIDE_LINKS),
  notes: [
    '进程启动成功 ≠ 组网成功；虚拟 IP 与 peer 必须来自 easytier-cli -o json node / peer。',
    '邀请码内含网络密钥，仅私聊分享，不要公开张贴。',
    '若所有步骤都无效，可改用公网服务器中继，或改用 ZeroTier / Tailscale 等成熟方案做基准对比。'
  ]
};

/** 从状态与日志中提取证据（不编造，只做模式匹配与字段读取） */
function collectEvidence(status, logs, room) {
  const s = status || {};
  const lines = (Array.isArray(logs) ? logs : (s.logs || []))
    .map(l => (typeof l === 'string' ? l : (l && l.line) || '')).filter(Boolean);
  const text = lines.map(l => String(l).toLowerCase()).join('\n');
  const has = (re) => re.test(text);
  const peerCount = Array.isArray(s.peers) ? s.peers.length : 0;
  return {
    running: !!s.running,
    connected: !!s.connected,
    virtualIp: s.virtualIp || null,
    peerCount,
    reason: s.reason || null,
    logLines: lines.length,
    matched: {
      timeout: has(/timeout|timed out|connect timeout|握手超时/),
      tun: has(/tun|permission denied|operation not permitted|no such device|\/dev\/net\/tun/),
      dns: has(/dns error|failed to resolve|name resolution|failed to lookup|lookup error|unknown host/),
      auth: has(/auth|secret|decrypt|handshake fail|mismatch/),
      cli: has(/cli|rpc|portal/)
    },
    room: {
      role: (room && room.role) || null,
      networkName: (room && room.networkName) || null,
      sharedNodes: (room && room.sharedNodes) || []
    }
  };
}

/** 依据真实证据判定诊断码（优先级从具体到一般） */
function classify(status, ev) {
  // ev.reason 由 collectEvidence 填充；直接调用时也兼容从 status 读取
  const reason = String(ev.reason || (status && status.reason) || '').toLowerCase();
  if (!ev.running) {
    if (/未找到|缺少|二进制|easytier-core|easytier-cli/.test(reason)) return 'binary-missing';
    return 'not-running';
  }
  if (ev.connected && ev.peerCount > 0) return 'connected';
  if (/cli 查询失败|rpc/.test(reason)) return 'cli-failure';
  if (ev.matched.tun) return 'tun-missing';
  if (ev.matched.auth) return 'secret-mismatch';
  if (ev.matched.dns) return 'node-unreachable';
  if (ev.matched.timeout) return 'timeout-udp';
  return 'no-peers';
}

/** 生成带编号的排查步骤（通用 + 针对诊断码的聚焦项置顶） */
function buildSteps(code, ev) {
  const hint = CODE_HINTS[code] || CODE_HINTS['no-peers'];
  const focus = new Set(hint.focus || []);
  const ordered = [
    ...BASE_STEPS.filter(s => focus.has(s.id)),
    ...BASE_STEPS.filter(s => !focus.has(s.id))
  ];
  return ordered.map((s, i) => ({
    n: i + 1, id: s.id, title: s.title, detail: s.detail,
    commandKey: s.commandKey || null,
    focused: focus.has(s.id)
  }));
}

/**
 * 握手诊断主函数。
 * @param {object} input { status, logs, elapsedMs|uptimeMs, thresholdMs, room }
 * @returns 结构化诊断结果；shouldPrompt=true 时前端应弹窗
 */
function diagnoseHandshake(input = {}) {
  const status = input.status || {};
  const logs = input.logs || (status.logs || []);
  const room = input.room || {};
  const elapsedMs = Math.max(0, Number(input.elapsedMs ?? status.uptimeMs ?? 0) || 0);
  const thresholdMs = Math.max(0, Number(input.thresholdMs ?? HANDSHAKE_TIMEOUT_MS) || 0);
  const ev = collectEvidence(status, logs, room);
  const code = classify(status, ev);
  const hint = CODE_HINTS[code] || CODE_HINTS['no-peers'];
  const ok = code === 'connected';
  const isHandshakeFailure = !ok && code !== 'not-running' && code !== 'binary-missing';
  const timedOut = elapsedMs >= thresholdMs;
  const shouldPrompt = isHandshakeFailure && timedOut;

  // 用户明确要求：握手失败时提示「请检查防火墙/路由器 UDP 限制」
  const udpNotice = '请检查防火墙/路由器 UDP 限制';
  const title = ok
    ? '组网已建立'
    : isHandshakeFailure
      ? `联机握手失败：${udpNotice}`
      : hint.title;

  return {
    failed: !ok,
    ok,
    code,
    title,
    summary: hint.summary,
    severity: ok ? 'info' : (code === 'not-running' ? 'warning' : 'error'),
    isHandshakeFailure,
    elapsedMs,
    thresholdMs,
    timedOut,
    shouldPrompt,
    notice: isHandshakeFailure ? udpNotice : null,
    steps: ok ? [] : buildSteps(code, ev),
    commands: COMMANDS,
    ports: PORTS,
    links: Object.values(GUIDE_LINKS),
    evidence: ev,
    // 稳定签名，前端可用它避免同一个失败反复弹窗
    signature: crypto.createHash('sha1')
      .update(`${code}|${ev.running}|${ev.peerCount}|${ev.logLines}|${ev.reason || ''}`)
      .digest('hex').slice(0, 12)
  };
}

module.exports = {
  HANDSHAKE_TIMEOUT_MS, GUIDE_LINKS, PORTS, COMMANDS, BASE_STEPS, CODE_HINTS,
  NETWORK_GUIDE, collectEvidence, classify, buildSteps, diagnoseHandshake
};
