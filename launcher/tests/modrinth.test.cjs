'use strict';
/** 【0.6.0 模块四】Modrinth 真实 API 解析 / 依赖补全 / sha512 安装断言 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const M = require('../engine/modrinth/client.cjs');

const sha = (s) => crypto.createHash('sha512').update(Buffer.from(s)).digest('hex');
const resp = (body, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(body) });

const HITS = [{
  project_id: 'AANobbMI', slug: 'sodium', title: 'Sodium',
  description: 'A Fabric mod designed to improve frame rates',
  project_type: 'mod', icon_url: 'https://cdn.modrinth.com/data/sodium/icon.png',
  downloads: 12345678, follows: 42000, categories: ['fabric', 'optimization'],
  versions: ['1.21.1'], latest_version: '1.21.1', author: 'CaffeineMC',
  date_modified: '2026-01-01T00:00:00Z'
}];
const VERSIONS = [{
  id: 'v-sodium-1', project_id: 'AANobbMI', name: 'Sodium 0.6.9',
  version_number: '0.6.9', version_type: 'release',
  loaders: ['fabric'], game_versions: ['1.21.1'],
  dependencies: [{ project_id: 'P7dR8mSH', version_id: null, dependency_type: 'required' }],
  files: [{
    url: 'https://cdn.modrinth.com/data/sodium/sodium.jar',
    filename: 'sodium-fabric-0.6.9.jar', primary: true, size: 7,
    hashes: { sha512: sha('SODIUM_JAR'), sha1: 'a'.repeat(40) }
  }],
  date_published: '2026-01-01T00:00:00Z'
}];
const FABRIC_API_VERSION = {
  id: 'v-fabric-api-1', project_id: 'P7dR8mSH', name: 'Fabric API 0.105',
  version_number: '0.105', version_type: 'release',
  loaders: ['fabric'], game_versions: ['1.21.1'], dependencies: [],
  files: [{
    url: 'https://cdn.modrinth.com/data/fabric-api/fabric-api.jar',
    filename: 'fabric-api-0.105.jar', primary: true, size: 12,
    hashes: { sha512: sha('FABRIC_API_JAR') }
  }]
};

// ==================== 真实 API URL / facets ====================
test('buildSearchUrl 生成 Modrinth v2 真实 facets（AND 组 / 版本 / 加载器）', () => {
  const u = new URL(M.buildSearchUrl({ query: 'sodium', projectType: 'mod', mcVersion: '1.21.1', loader: 'fabric', limit: 10 }));
  assert.equal(u.origin + u.pathname, 'https://api.modrinth.com/v2/search');
  assert.deepEqual(JSON.parse(u.searchParams.get('facets')), [
    ['project_type:mod'], ['versions:1.21.1'], ['categories:fabric']
  ]);
  assert.equal(u.searchParams.get('query'), 'sodium');
  assert.equal(u.searchParams.get('limit'), '10');
  assert.equal(u.searchParams.get('index'), 'relevance');
});

test('光影搜索不附加 loader facet；limit 被夹取到 1..50', () => {
  const u = new URL(M.buildSearchUrl({ projectType: 'shader', loader: 'fabric', limit: 9999 }));
  assert.deepEqual(JSON.parse(u.searchParams.get('facets')), [['project_type:shader']]);
  assert.equal(u.searchParams.get('limit'), '50');
  assert.equal(new URL(M.buildSearchUrl({ limit: -5 })).searchParams.get('limit'), '1');
});

test('parseSearchResponse 规范化真实 hits 字段', () => {
  const r = M.parseSearchResponse({ total_hits: 1, hits: HITS });
  assert.equal(r.total, 1);
  assert.equal(r.hits[0].projectId, 'AANobbMI');
  assert.equal(r.hits[0].downloads, 12345678);
  assert.equal(r.hits[0].sourceUrl, 'https://modrinth.com/mod/sodium');
});

test('searchProjects 真实发起请求并带 User-Agent；HTTP 失败明确报错', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = { url, init }; return resp({ total_hits: 1, hits: HITS }); };
  const r = await M.searchProjects({ query: 'sodium', mcVersion: '1.21.1' }, { fetchImpl });
  assert.equal(r.hits.length, 1);
  assert.match(seen.url, /api\.modrinth\.com\/v2\/search/);
  assert.match(seen.init.headers['User-Agent'], /MC-Next/);
  assert.equal(r.url, seen.url);
  await assert.rejects(
    () => M.searchProjects({}, { fetchImpl: async () => resp({}, false, 503) }),
    /Modrinth 搜索失败 HTTP 503/);
});

// ==================== 版本解析 ====================
test('projectVersionsUrl 带真实 JSON 数组过滤参数', () => {
  const u = new URL(M.projectVersionsUrl('AANobbMI', { mcVersion: '1.21.1', loader: 'fabric' }));
  assert.equal(u.pathname, '/v2/project/AANobbMI/version');
  assert.deepEqual(JSON.parse(u.searchParams.get('game_versions')), ['1.21.1']);
  assert.deepEqual(JSON.parse(u.searchParams.get('loaders')), ['fabric']);
});

test('parseVersions / primaryFile / sha512 小写归一化', () => {
  const vs = M.parseVersions(VERSIONS);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].dependencies[0].projectId, 'P7dR8mSH');
  const f = M.primaryFile(vs[0]);
  assert.equal(f.filename, 'sodium-fabric-0.6.9.jar');
  assert.equal(f.sha512, sha('SODIUM_JAR'));
  assert.equal(M.primaryFile(M.parseVersions([{ id: 'x', files: [] }])[0]), null);
});

test('selectVersion 优先匹配 MC 版本 + 加载器 + release', () => {
  const versions = M.parseVersions([
    { id: 'old', version_type: 'release', loaders: ['forge'], game_versions: ['1.20.1'], files: [{ url: 'u', filename: 'a.jar', primary: true }] },
    { id: 'alpha', version_type: 'alpha', loaders: ['fabric'], game_versions: ['1.21.1'], files: [{ url: 'u', filename: 'b.jar', primary: true }] },
    { id: 'best', version_type: 'release', loaders: ['fabric'], game_versions: ['1.21.1'], files: [{ url: 'u', filename: 'c.jar', primary: true }] }
  ]);
  assert.equal(M.selectVersion(versions, { mcVersion: '1.21.1', loader: 'fabric' }).id, 'best');
});

test('fetchVersions 返回版本列表与自动选中的版本', async () => {
  const r = await M.fetchVersions({ projectId: 'AANobbMI', mcVersion: '1.21.1', loader: 'fabric' },
    { fetchImpl: async () => resp(VERSIONS) });
  assert.equal(r.versions.length, 1);
  assert.equal(r.selected.id, 'v-sodium-1');
  await assert.rejects(() => M.fetchVersions({}, {}), /缺少 projectId/);
});

// ==================== 依赖补全 ====================
test('resolveDependencies 递归解析必需依赖，并报告缺失项', async () => {
  const version = M.parseVersions(VERSIONS)[0];
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/project/P7dR8mSH/version')) return resp([FABRIC_API_VERSION]);
    return resp({}, false, 404);
  };
  const deps = await M.resolveDependencies(version, { fetchImpl, mcVersion: '1.21.1', loader: 'fabric' });
  assert.equal(deps.length, 1);
  assert.equal(deps[0].ok, true);
  assert.equal(deps[0].projectId, 'P7dR8mSH');
  assert.ok(deps[0].files[0].url.includes('fabric-api'));
  assert.ok(urls.some(u => u.includes('/project/P7dR8mSH/version')));
});

test('依赖按 version_id 精确拉取；循环依赖不会死循环', async () => {
  const v = M.parseVersions([{
    id: 'A', project_id: 'A', version_type: 'release', loaders: [], game_versions: [],
    dependencies: [{ version_id: 'B', dependency_type: 'required' }],
    files: [{ url: 'u', filename: 'a.jar', primary: true }]
  }])[0];
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    return resp({
      id: url.includes('/version/B') ? 'B' : 'A', project_id: 'X', version_type: 'release',
      loaders: [], game_versions: [],
      dependencies: [{ version_id: 'B', dependency_type: 'required' }],
      files: [{ url: 'u', filename: 'b.jar', primary: true }]
    });
  };
  const deps = await M.resolveDependencies(v, { fetchImpl, limit: 10 });
  assert.equal(deps.length, 1, '环被 visited 集合截断');
  assert.equal(calls, 1);
});

test('依赖解析不到时明确 missing，不静默丢弃前置', async () => {
  const version = M.parseVersions(VERSIONS)[0];
  const deps = await M.resolveDependencies(version, { fetchImpl: async () => resp({}, false, 404) });
  assert.equal(deps.length, 1);
  assert.equal(deps[0].missing, true);
  assert.match(deps[0].reason, /未找到匹配/);
});

// ==================== 文件名安全 ====================
test('safeFileName 防路径穿越 / 空名 / ..', () => {
  assert.equal(M.safeFileName('../../evil.jar'), 'evil.jar');
  assert.equal(M.safeFileName('/etc/passwd'), 'passwd');
  assert.equal(M.safeFileName('..'), 'resource.jar');
  assert.equal(M.safeFileName('sodium fabric 1.0.jar'), 'sodium_fabric_1.0.jar');
});

// ==================== 真实落盘安装 ====================
function mockDownload(bytes) {
  return async (url, dest) => { fs.writeFileSync(dest, bytes[url]); };
}

test('installProject 主文件 + 依赖真实落到 mods/，sha512 校验通过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-modrinth-'));
  const bytes = {
    'https://cdn.modrinth.com/data/sodium/sodium.jar': Buffer.from('SODIUM_JAR'),
    'https://cdn.modrinth.com/data/fabric-api/fabric-api.jar': Buffer.from('FABRIC_API_JAR')
  };
  const fetchImpl = async (url) => url.includes('/project/P7dR8mSH/version')
    ? resp([FABRIC_API_VERSION]) : resp({}, false, 404);
  const events = [];
  const r = await M.installProject({
    gameDir: dir, projectType: 'mod', project: HITS[0], version: M.parseVersions(VERSIONS)[0],
    q: { mcVersion: '1.21.1', loader: 'fabric' },
    fetchImpl, downloadImpl: mockDownload(bytes),
    onProgress: p => events.push(p.phase)
  });
  assert.equal(r.ok, true);
  assert.equal(r.dir, path.join(dir, 'mods'));
  assert.equal(r.installed.length, 2);
  assert.equal(r.installed[0].dependency, false);
  assert.equal(r.installed[1].dependency, true);
  assert.equal(fs.readFileSync(path.join(dir, 'mods', 'sodium-fabric-0.6.9.jar'), 'utf8'), 'SODIUM_JAR');
  assert.equal(fs.readFileSync(path.join(dir, 'mods', 'fabric-api-0.105.jar'), 'utf8'), 'FABRIC_API_JAR');
  assert.equal(r.installed[0].sha512, sha('SODIUM_JAR'));
  assert.ok(events.includes('download') && events.includes('done'));
  assert.equal(fs.readdirSync(path.join(dir, 'mods')).some(f => f.endsWith('.part')), false);
});

test('sha512 不符时拒绝安装、清理临时文件并明确报错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-modrinth-'));
  const version = M.parseVersions(VERSIONS)[0];
  version.dependencies = [];
  const r = await M.installProject({
    gameDir: dir, projectType: 'mod', version,
    fetchImpl: async () => resp({}),
    downloadImpl: async (url, dest) => fs.writeFileSync(dest, Buffer.from('TAMPERED')),
    q: {}
  });
  assert.equal(r.ok, false);
  assert.equal(r.installed.length, 0);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0].error, /SHA-512 不符/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'mods')), []);
});

test('光影安装落到 shaderpacks/，缺失依赖如实上报', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-modrinth-'));
  const shader = M.parseVersions([{
    id: 'sh', project_id: 'SH', version_type: 'release', loaders: [], game_versions: ['1.21.1'],
    dependencies: [{ project_id: 'MISSING', dependency_type: 'required' }],
    files: [{ url: 'https://cdn/shader.zip', filename: 'bsl.zip', primary: true, hashes: { sha512: sha('SHADER') } }]
  }])[0];
  const r = await M.installProject({
    gameDir: dir, projectType: 'shader', version: shader,
    q: { mcVersion: '1.21.1' },
    fetchImpl: async () => resp({}, false, 404),
    downloadImpl: mockDownload({ 'https://cdn/shader.zip': Buffer.from('SHADER') })
  });
  assert.equal(r.dir, path.join(dir, 'shaderpacks'));
  assert.equal(fs.existsSync(path.join(dir, 'shaderpacks', 'bsl.zip')), true);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].missing, true);
});
