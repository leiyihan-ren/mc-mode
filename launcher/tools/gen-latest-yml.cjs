'use strict';
/**
 * gen-latest-yml.cjs — 0.6.0 模块五/六：生成 electron-builder 兼容的 latest.yml
 *
 * 自动更新链路的最后一环：桌面端 updater.checkForUpdate() 会去读 Release 上的
 * /releases/latest/download/latest.yml，因此这里必须产出「真实产物字节」的
 * base64(sha512) 与 size，不能手写哈希、不能伪造版本。
 *
 * 用法: node tools/gen-latest-yml.cjs [输出路径]
 * 默认输出: release/latest.yml（与 AppImage / tar.gz 同目录，供发布脚本上传）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PKG = require('../package.json');
const RELEASE_CFG = require('../config/release.json');

/** 读真实文件字节，产出 electron-builder files[] 条目 */
function fileEntry(file, name) {
  const buf = fs.readFileSync(file);
  return {
    url: name,
    sha512: crypto.createHash('sha512').update(buf).digest('base64'),
    size: buf.length
  };
}

function buildLatestYml(opts = {}) {
  const version = opts.version || PKG.version;
  const cfg = opts.release || RELEASE_CFG;
  const dir = opts.distDir || path.join(ROOT, 'release');
  const assets = cfg.assets;
  const files = (opts.files || [
    [path.join(dir, assets.appImage), assets.appImage],
    [path.join(dir, assets.tarGz), assets.tarGz]
  ]).map(([file, name]) => fileEntry(file, name));
  if (!files.length) throw new Error('至少需要一份真实桌面产物才能生成 latest.yml');

  const primary = files[0];
  const lines = [
    `version: ${version}`,
    `tag: ${cfg.tag}`,
    'files:',
    ...files.flatMap(f => [
      `  - url: ${f.url}`,
      `    sha512: ${f.sha512}`,
      `    size: ${f.size}`
    ]),
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${(opts.releaseDate || new Date().toISOString())}'`
  ];
  return lines.join('\n') + '\n';
}

if (require.main === module) {
  const out = process.argv[2] || path.join(ROOT, 'release', 'latest.yml');
  const text = buildLatestYml();
  fs.writeFileSync(out, text);
  console.log(`[gen] ${out}`);
  process.stdout.write(text);
}

module.exports = { buildLatestYml, fileEntry };
