'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVersionManifest, filterReleases, filterSnapshots, compareVersions } = require('../engine/manifest');

const SAMPLE = {
  latest: { release: '1.21.11', snapshot: '26w05a' },
  versions: [
    { id: '1.21.11', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/aaa/1.21.11.json', sha1: 'a'.repeat(40), releaseTime: '2026-01-01T00:00:00Z' },
    { id: '1.21.1', type: 'release', url: 'u1', sha1: 'b'.repeat(40) },
    { id: '1.21', type: 'release', url: 'u2', sha1: 'c'.repeat(40) },
    { id: '1.14.4-pre1', type: 'snapshot', url: 'u3', sha1: 'd'.repeat(40) },
    { id: 'b1.7.3', type: 'old_beta', url: 'u4', sha1: 'e'.repeat(40) },
    { id: 'a1.0.14', type: 'old_alpha', url: 'u5', sha1: 'f'.repeat(40) },
    { id: '26.1', type: 'release', url: 'u6', sha1: '0'.repeat(40) }
  ]
};

test('解析 version_manifest_v2', () => {
  const m = parseVersionManifest(SAMPLE);
  assert.equal(m.latest.release, '1.21.11');
  assert.equal(m.versions.length, 7);
  assert.equal(m.versions[0].type, 'release');
});

test('非法结构抛错', () => {
  assert.throws(() => parseVersionManifest(null));
  assert.throws(() => parseVersionManifest({ versions: 'x' }));
  assert.throws(() => parseVersionManifest({}));
});

test('过滤正式版', () => {
  const m = parseVersionManifest(SAMPLE);
  const rel = filterReleases(m);
  assert.equal(rel.length, 4); // 1.21.11 / 1.21.1 / 1.21 / 26.1
  // 排序：26.1 应排最前（新版本号体系 > 1.x）
  assert.equal(rel[0].id, '26.1');
  assert.equal(rel[rel.length - 1].id, '1.21');
});

test('过滤快照', () => {
  const m = parseVersionManifest(SAMPLE);
  assert.equal(filterSnapshots(m).length, 1);
});

test('版本号比较', () => {
  assert.ok(compareVersions('1.21.11', '1.21.1') > 0);
  assert.ok(compareVersions('1.21.1', '1.21') > 0);
  assert.ok(compareVersions('26.1', '1.21.11') > 0, '26.x 新版本号大于 1.x');
  assert.ok(compareVersions('1.21', '1.20.6') > 0);
  assert.ok(compareVersions('1.14', '1.14.4') < 0);
  assert.equal(compareVersions('1.21', '1.21'), 0);
  assert.ok(compareVersions('1.14', '1.14-pre1') > 0, '正式 > pre');
});
