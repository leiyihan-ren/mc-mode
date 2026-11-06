'use strict';
/**
 * engine/world/nbt.cjs — Minecraft level.dat 的 NBT 解析器（零外部依赖，手写实现）
 *
 * 支持 TAG 0~12（含 LongArray / IntArray），自动识别 gzip（level.dat 标准格式）。
 * BigInt 用于 Long，避免种子被 JS Number 截断；提供 toPlain 做安全序列化。
 */
const zlib = require('zlib');

const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12
};

class NbtReader {
  constructor(buf) { this.b = buf; this.p = 0; }
  need(n) {
    if (this.p + n > this.b.length) throw new Error(`NBT 数据截断：需要 ${n} 字节，剩余 ${this.b.length - this.p}`);
  }
  u8() { this.need(1); return this.b.readUInt8(this.p++); }
  i8() { this.need(1); return this.b.readInt8(this.p++); }
  i16() { this.need(2); const v = this.b.readInt16BE(this.p); this.p += 2; return v; }
  u16() { this.need(2); const v = this.b.readUInt16BE(this.p); this.p += 2; return v; }
  i32() { this.need(4); const v = this.b.readInt32BE(this.p); this.p += 4; return v; }
  i64() { this.need(8); const v = this.b.readBigInt64BE(this.p); this.p += 8; return v; }
  f32() { this.need(4); const v = this.b.readFloatBE(this.p); this.p += 4; return v; }
  f64() { this.need(8); const v = this.b.readDoubleBE(this.p); this.p += 8; return v; }
  str() {
    const len = this.u16();
    this.need(len);
    const s = this.b.subarray(this.p, this.p + len).toString('utf8');
    this.p += len;
    return s;
  }
  array(len, reader) {
    const out = new Array(len);
    for (let i = 0; i < len; i++) out[i] = reader.call(this);
    return out;
  }
  payload(type, depth = 0) {
    if (depth > 64) throw new Error('NBT 嵌套过深（>64），疑似恶意数据');
    switch (type) {
      case TAG.BYTE: return this.i8();
      case TAG.SHORT: return this.i16();
      case TAG.INT: return this.i32();
      case TAG.LONG: return this.i64();
      case TAG.FLOAT: return this.f32();
      case TAG.DOUBLE: return this.f64();
      case TAG.BYTE_ARRAY: return Buffer.from(this.array(this.i32(), this.i8));
      case TAG.STRING: return this.str();
      case TAG.LIST: {
        const elem = this.u8();
        const len = this.i32();
        if (len < 0 || len > 1e7) throw new Error(`NBT List 长度异常: ${len}`);
        if (elem === TAG.END) return [];
        return this.array(len, () => this.payload(elem, depth + 1));
      }
      case TAG.COMPOUND: {
        const out = {};
        for (;;) {
          const t = this.u8();
          if (t === TAG.END) break;
          const name = this.str();
          out[name] = this.payload(t, depth + 1);
        }
        return out;
      }
      case TAG.INT_ARRAY: return this.array(this.i32(), this.i32);
      case TAG.LONG_ARRAY: return this.array(this.i32(), this.i64);
      default: throw new Error(`未知 NBT TAG 类型: ${type} (offset=${this.p})`);
    }
  }
  root() {
    const type = this.u8();
    const name = this.str();
    const value = this.payload(type);
    return { type, name, value, bytesRead: this.p };
  }
}

/** 自动解压 gzip / 原样返回未压缩数据 */
function decompress(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  return buf;
}

/** 解析 NBT 字节流 → 根对象 */
function parseNbt(input) {
  const r = new NbtReader(decompress(input));
  return r.root();
}

/** BigInt 递归转 Number/字符串，保证 JSON.stringify 不炸 */
function toPlain(v) {
  if (typeof v === 'bigint') return Number(v) <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString();
  if (Buffer.isBuffer(v)) return { __bytes: v.length };
  if (Array.isArray(v)) return v.map(toPlain);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = toPlain(v[k]);
    return o;
  }
  return v;
}

function num(v, fallback = 0) {
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 从根 compound 取 Data（兼容 Data 缺失的老格式） */
function dataOf(root) {
  const v = root && root.value;
  if (!v || typeof v !== 'object') return {};
  return v.Data && typeof v.Data === 'object' ? v.Data : v;
}

/**
 * 从 level.dat 提取世界摘要。
 * 注意：Time 是「世界内游戏时间 tick」而非真实游玩时长；真实累计游玩时长来自 stats/*.json，
 * 由 manager.cjs 另行读取，这里不做臆测。
 */
function levelSummary(input) {
  const root = parseNbt(input);
  const d = dataOf(root);
  const ver = d.Version && typeof d.Version === 'object' ? d.Version : {};
  const modKeys = Object.keys(d).filter(k => /fml|forge|fabric|quilt|neoforge|modlist|modded/i.test(k));
  let modList = [];
  for (const k of modKeys) {
    const v = d[k];
    if (v && typeof v === 'object') {
      for (const inner of ['ModList', 'mods', 'modsList', 'Registries']) {
        if (Array.isArray(v[inner])) modList = modList.concat(v[inner].map(x =>
          typeof x === 'string' ? x : (x && (x.modId || x.id || x.name)) || JSON.stringify(toPlain(x))));
      }
    }
  }
  return {
    name: d.LevelName || null,
    seed: typeof d.RandomSeed === 'bigint' ? d.RandomSeed.toString() : String(d.RandomSeed ?? ''),
    gameTimeTicks: num(d.Time, 0),
    gameDays: Math.floor(num(d.Time, 0) / 24000),
    dayTimeTicks: num(d.DayTime, 0),
    lastPlayed: typeof d.LastPlayed === 'bigint' ? Number(d.LastPlayed) : num(d.LastPlayed, 0),
    gameType: num(d.GameType, 0),
    gameTypeName: ['生存', '创造', '冒险', '旁观'][num(d.GameType, 0)] || '未知',
    difficulty: num(d.Difficulty, 2),
    hardcore: !!d.hardcore,
    allowCommands: !!d.allowCommands,
    version: ver.Name || ver.Id || null,
    versionId: num(ver.Id, null),
    versionSeries: ver.Series || null,
    spawn: { x: num(d.SpawnX), y: num(d.SpawnY), z: num(d.SpawnZ) },
    moddedFlags: modKeys,
    modList: [...new Set(modList.filter(Boolean))],
    rawDataKeys: Object.keys(d)
  };
}

module.exports = { TAG, NbtReader, decompress, parseNbt, toPlain, dataOf, levelSummary, num };
