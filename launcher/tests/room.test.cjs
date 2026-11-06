'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../engine/net/room.cjs');

test('邀请码编码/解码：往返一致且含真实密钥', () => {
  const { room, inviteCode } = R.createRoom({ networkName: 'mcnext-abc', networkSecret: 'S3cr3t', mcVersion: '1.20.1' });
  assert.ok(inviteCode.startsWith(R.INVITE_PREFIX + '.'));
  const d = R.decodeInvite(inviteCode);
  assert.equal(d.networkName, 'mcnext-abc');
  assert.equal(d.networkSecret, 'S3cr3t');
  assert.equal(d.mcVersion, '1.20.1');
  assert.equal(d.hostVirtualIp, room.hostVirtualIp);
  assert.ok(Array.isArray(d.sharedNodes));
});

test('邀请码防篡改：改一个字符 / 校验和错误 / 缺字段全部拒绝', () => {
  const { inviteCode } = R.createRoom();
  const parts = inviteCode.split('.');
  assert.throws(() => R.decodeInvite(inviteCode.slice(0, -1) + 'x'), /校验和|格式/);
  assert.throws(() => R.decodeInvite(`${parts[0]}.${parts[1]}.00000000`), /校验和/);
  assert.throws(() => R.decodeInvite('MCNX.abc.def'), /格式/);
  const noSecret = Buffer.from(JSON.stringify({ v: 1, n: 'x' })).toString('base64url');
  const sum = R.checksum(Buffer.from(noSecret, 'base64url'));
  assert.throws(() => R.decodeInvite(`${R.INVITE_PREFIX}.${noSecret}.${sum}`), /缺少网络名/);
  assert.throws(() => R.decodeInvite(''), /格式/);
});

test('创建房间生成真随机网络名/密钥，两个房间不重复', () => {
  const a = R.createRoom(), b = R.createRoom();
  assert.notEqual(a.room.networkSecret, b.room.networkSecret);
  assert.notEqual(a.room.networkName, b.room.networkName);
  assert.equal(a.room.role, 'host');
  assert.match(a.room.hostVirtualIp, /^10\.144\.144\.1$/);
  assert.match(a.room.networkSecret, /[A-Za-z0-9_-]{10,}/);
});

test('加入房间：角色为 guest、虚拟 IP 为 null（不伪造已分配）', () => {
  const { inviteCode } = R.createRoom({ networkSecret: 'k', hostVirtualIp: '10.144.144.1' });
  const { room } = R.joinRoom(inviteCode);
  assert.equal(room.role, 'guest');
  assert.equal(room.virtualIp, null);
  assert.equal(room.subnet, '10.144.144');
  assert.equal(room.networkSecret, 'k');
  assert.ok(room.joinedAt);
});

test('buildCoreArgs 生成 EasyTier 真实参数：房主 -i，访客 -d，含 -p/--hostname/-r', () => {
  const host = R.createRoom({ networkName: 'n', networkSecret: 's', sharedNodes: ['tcp://node.example:11010'] }).room;
  const ha = R.buildCoreArgs(host, { hostname: 'pc-a' });
  assert.ok(ha.includes('--network-name') && ha.includes('n'));
  assert.ok(ha.includes('--network-secret') && ha.includes('s'));
  assert.equal(ha[ha.indexOf('-i') + 1], '10.144.144.1/24');
  assert.ok(ha.includes('-p') && ha.includes('tcp://node.example:11010'));
  assert.equal(ha[ha.indexOf('--hostname') + 1], 'pc-a');
  assert.ok(ha.includes('-r'));

  const guest = R.joinRoom(R.encodeInvite(host)).room;
  const ga = R.buildCoreArgs(guest, { extraPeers: ['udp://127.0.0.1:11010'], noTun: true, listeners: ['udp://0.0.0.0:11010'] });
  assert.ok(ga.includes('-d'), '访客用 DHCP');
  assert.ok(!ga.includes('-i'));
  assert.ok(ga.includes('udp://127.0.0.1:11010'));
  assert.ok(ga.includes('--no-tun'));
  assert.ok(ga.includes('-l'));
});

test('CLI 输出解析：对象/数组/NDJSON、虚拟 IP 与成员提取', () => {
  const node = { ipv4_addr: '10.144.144.1/24', hostname: 'host-a', peer_id: 1 };
  assert.equal(R.extractVirtualIp(node), '10.144.144.1');
  assert.equal(R.extractVirtualIp({ ipv4: '10.144.144.1/24' }), '10.144.144.1');
  assert.equal(R.extractVirtualIp([{ virtual_ip: '10.144.144.9' }]), '10.144.144.9');
  assert.equal(R.extractVirtualIp({}), null, '无字段时返回 null，不编造');
  assert.equal(R.parseCliJson(''), null);
  assert.equal(R.parseCliJson('{"a":1}\n{"a":2}').length, 2);

  const peers = R.extractPeers({ peers: [
    { peer_id: 1, hostname: 'host-a', ipv4: '10.144.144.1', cost: 1 },
    { peer_id: 2, hostname: 'host-b', virtual_ipv4: '10.144.144.2/24' }
  ] });
  assert.equal(peers.length, 2);
  assert.equal(peers[0].ipv4, '10.144.144.1');
  assert.equal(peers[1].ipv4, '10.144.144.2');
  assert.equal(peers[1].id, 2);
  assert.deepEqual(R.extractPeers(null), []);
});

test('真实 EasyTier v2.6.4 CLI 输出夹具：字段对齐（非伪造数据）', () => {
  const nodeText = fs.readFileSync(path.join(__dirname, 'fixtures', 'easytier-node.json'), 'utf8');
  const peerText = fs.readFileSync(path.join(__dirname, 'fixtures', 'easytier-peer.json'), 'utf8');
  const node = R.parseCliJson(nodeText);
  const peer = R.parseCliJson(peerText);
  assert.equal(R.extractVirtualIp(node), '10.144.144.1');
  assert.ok(Array.isArray(peer), 'peer 子命令返回数组');
  const members = R.extractPeers(peer);
  assert.equal(members[0].hostname, 'host-a');
  assert.equal(members[0].ipv4, '10.144.144.1');
  assert.equal(node.version, '2.6.4-8428a89d', '夹具来自真实运行的 easytier-core 2.6.4');
  assert.equal(peer[0].version, '2.6.4-8428a89d');
});

test('RoomManager：未启动 / 无 CLI 时如实返回未连接', async () => {
  const m = new R.RoomManager({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'mcnet-')), corePath: null, cliPath: null });
  let s = await m.status();
  assert.equal(s.connected, false);
  assert.match(s.reason, /未启动/);
  assert.equal(s.virtualIp, null);
  const r = m.start(R.createRoom().room);
  assert.equal(r.ok, false);
  assert.match(r.error, /缺少 EasyTier/);
});

test('RoomManager 真实流程（注入 spawn/execFile）：启动 → 状态 → 停止', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnet2-'));
  const fakeProc = { pid: 4242, killed: false, stdout: null, stderr: null, on: () => {}, kill: () => { fakeProc.killed = true; } };
  const m = new R.RoomManager({
    root: tmp, corePath: '/bin/true', cliPath: '/bin/true',
    spawn: () => fakeProc,
    execFile: (bin, args, o, cb) => {
      const sub = args[args.length - 1];
      const out = sub === 'node'
        ? JSON.stringify({ ipv4: '10.144.144.1/24', hostname: 'host-a' })
        : JSON.stringify({ peers: [{ peer_id: 2, hostname: 'host-b', ipv4: '10.144.144.2' }] });
      cb(null, out, '');
    }
  });
  const { room } = R.createRoom();
  const started = m.start(room);
  assert.equal(started.ok, true);
  assert.equal(started.pid, 4242);
  assert.ok(started.args.includes('--network-name'));
  assert.equal(m.listRooms().length, 1, '房间已持久化');

  const st = await m.status();
  assert.equal(st.connected, true);
  assert.equal(st.virtualIp, '10.144.144.1');
  assert.equal(st.peers.length, 1);
  assert.equal(st.peers[0].hostname, 'host-b');
  assert.ok(st.running);

  assert.equal(m.stop().ok, true);
  assert.equal(fakeProc.killed, true);
  const after = await m.status();
  assert.equal(after.connected, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('CLI 命令失败时不伪造连接状态', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnet3-'));
  const p = { pid: 1, killed: false, on: () => {}, kill: () => {} };
  const m = new R.RoomManager({
    root: tmp, corePath: '/bin/true', cliPath: '/bin/true',
    spawn: () => p,
    execFile: (b, a, o, cb) => cb(new Error('connect ECONNREFUSED'), '', 'refused')
  });
  m.start(R.createRoom().room);
  const s = await m.status();
  assert.equal(s.connected, false);
  assert.match(s.reason, /CLI 查询失败/);
  assert.equal(s.virtualIp, null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('房间持久化：最多保留 20 条，密钥仅落本地', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnet4-'));
  const db = { rooms: Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, networkSecret: `s${i}` })) };
  R.saveRooms(tmp, db);
  const loaded = R.loadRooms(tmp);
  assert.equal(loaded.rooms.length, 25);
  const p = new R.RoomManager({ root: tmp, corePath: '/bin/true', cliPath: null, spawn: () => ({ pid: 1, on: () => {}, kill: () => {} }) });
  p._persist({ id: 'new', networkSecret: 'fresh' });
  const after = p.listRooms();
  assert.equal(after.length, 20);
  assert.equal(after[0].id, 'new');
  fs.rmSync(tmp, { recursive: true, force: true });
});
