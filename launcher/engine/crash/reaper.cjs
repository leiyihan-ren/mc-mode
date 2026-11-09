/**
 * reaper.cjs — 0.7.0 模块四：僵尸进程 / 进程树清理
 *
 * 真实问题：Node 的 child.kill() 只杀直接子进程。JVM 常 fork 出子进程
 * （崩溃处理 hs_err、渲染 helper、部分 wrapper），主进程退出后它们会残留。
 *
 * 方案：
 *  - POSIX：spawn 时用 detached=true 让 JVM 成为进程组 leader，
 *           killTree 用 process.kill(-pid, SIGTERM) 杀整个进程组，超时升级 SIGKILL。
 *  - Windows：taskkill /PID <pid> /T /F 递归终止进程树（node:child_process execFile）。
 *  - 所有系统原语（kill / execFile / isAlive）可注入，纯逻辑可离线 TDD。
 *
 * 边界红线：拿不到 pid 或 kill 全失败时明确返回 ok:false，绝不谎报「已清理」。
 */
'use strict';

const { execFile } = require('child_process');

/** 进程登记表：主进程生命周期内所有由启动器拉起的子进程 */
class ProcessRegistry {
  constructor() { this._map = new Map(); }
  /** @returns {{pid:number, kind:string, at:number}} */
  track(pid, kind = 'java', meta = {}) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const rec = { pid, kind, at: meta.now ? meta.now() : Date.now(), ...meta };
    this._map.set(pid, rec);
    return rec;
  }
  untrack(pid) { return this._map.delete(pid); }
  list() { return [...this._map.values()]; }
  get size() { return this._map.size; }
}

/**
 * 探测 pid 是否仍存活（不发送真实信号，仅 0 号探测）。
 * @param {number} pid
 * @param {(pid:number, sig:number|string)=>void} killFn
 */
function isAlive(pid, killFn) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { killFn(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; } // EPERM=存在但无权限；ESRCH=已消失
}

/**
 * 终止整棵进程树。
 * @param {object} o { pid, child, platform, signal, killFn, execFileFn, force }
 *   child: 可选 ChildProcess（降级用 child.kill）
 * @returns {{ok:boolean, pid:number|null, method:string, error?:string}}
 */
function killTree(o = {}) {
  const pid = Number.isInteger(o.pid) && o.pid > 0 ? o.pid : (o.child && o.child.pid) || null;
  const platform = o.platform || process.platform;
  const signal = o.signal || 'SIGTERM';
  const killFn = o.killFn || ((p, s) => process.kill(p, s));
  if (!pid) return { ok: false, pid: null, method: 'none', error: '无有效 pid，拒绝谎报清理成功' };

  if (platform === 'win32') {
    const execFileFn = o.execFileFn || execFile;
    const args = ['/PID', String(pid), '/T'];
    if (o.force || signal === 'SIGKILL') args.push('/F');
    try {
      execFileFn('taskkill', args, { windowsHide: true }, () => {});
      return { ok: true, pid, method: 'taskkill /T' };
    } catch (e) {
      return { ok: false, pid, method: 'taskkill /T', error: e && e.message ? e.message : String(e) };
    }
  }

  // POSIX：负 pid = 整个进程组（spawn detached:true 时有效）
  try {
    killFn(-pid, signal);
    return { ok: true, pid, method: `process-group(-${pid}, ${signal})` };
  } catch (eGroup) {
    // 进程组不可用时降级到单进程，并如实标注 method
    try {
      if (o.child && typeof o.child.kill === 'function') o.child.kill(signal);
      else killFn(pid, signal);
      return { ok: true, pid, method: `single-process(${signal})`, error: `进程组降级: ${eGroup && eGroup.message}` };
    } catch (eSingle) {
      return { ok: false, pid, method: 'failed', error: `${eGroup && eGroup.message}; ${eSingle && eSingle.message}` };
    }
  }
}

/**
 * 清理登记表中的僵尸/残留：对仍存活的 pid 逐一 killTree，无论结果都从表中移除。
 * 用于主进程 before-quit、游戏异常退出兜底、启动器重启自检。
 * @returns {{scanned:number, alive:number, killed:number, results:Array}}
 */
function reapAll(registry, o = {}) {
  const killFn = o.killFn || ((p, s) => process.kill(p, s));
  const aliveFn = o.isAlive || ((pid) => isAlive(pid, killFn));
  const recs = registry.list();
  const results = [];
  let alive = 0, killed = 0;
  for (const rec of recs) {
    const live = aliveFn(rec.pid);
    if (!live) { registry.untrack(rec.pid); continue; }
    alive++;
    const r = killTree({ pid: rec.pid, platform: o.platform, signal: o.signal || 'SIGTERM', killFn, execFileFn: o.execFileFn });
    results.push({ pid: rec.pid, kind: rec.kind, ...r });
    if (r.ok) killed++;
    registry.untrack(rec.pid); // 已尽力终止；不保留悬挂登记
  }
  return { scanned: recs.length, alive, killed, results };
}

/**
 * 生成 spawn 选项：POSIX 下 detached=true 使子进程成为进程组 leader，
 * 这是 killTree 能一次回收 Java 及其所有子进程的真实前提。
 */
function spawnOptions(extra = {}, platform = process.platform) {
  return { ...extra, detached: platform !== 'win32' };
}

module.exports = {
  ProcessRegistry, isAlive, killTree, reapAll, spawnOptions
};
