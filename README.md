# Minecraft Java 版 · 客户端全版本目录

> 收录自 2009 年 Pre-classic 至 2026 年最新版本的全部 Minecraft Java 版客户端，含所有远古版与快照版。
>
> - **数据来源**：Mojang 官方版本清单 version_manifest_v2.json（piston-meta.mojang.com）
> - **收录版本数**：920 个（含全部远古版与快照版）
> - **最新正式版**：`26.3`（2026-09-15）
> - **最新快照**：`26.4-snapshot-5`（2026-10-20）
> - **目录生成日期**：2026-10-23
> - 官方可下载客户端：920 个；官方服务端：853 个

## 版本统计

| 时代 | 版本数 | 时间跨度 |
|---|---|---|
| [Pre-classic（前经典版）](pre-classic/index.md) | 5 | 2009-05-13 ~ 2009-05-16 |
| [Classic（经典版）](classic/index.md) | 4 | 2009-05-16 ~ 2009-12-21 |
| [Infdev（无限开发版）](infdev/index.md) | 1 | 2010-06-15 ~ 2010-06-15 |
| [Alpha（Alpha 版）](alpha/index.md) | 25 | 2010-07-08 ~ 2010-12-02 |
| [Beta（Beta 版）](beta/index.md) | 26 | 2010-12-19 ~ 2011-09-18 |
| [Release（正式版）](release/index.md) | 103 | 2011-11-17 ~ 2026-09-15 |
| [Snapshot（快照 / 预发布版）](snapshot/index.md) | 756 | 2012-07-25 ~ 2026-10-20 |
| **合计** | **920** | 2009-05-13 ~ 2026-10-20 |

## 目录结构

```
.
├── README.md            # 本文件
├── versions.json        # 机器可读完整目录（含 SHA1 / 大小 / 官方下载地址）
├── scripts/download.py  # 原版一键下载工具（自动校验 SHA1）
├── scripts/modloader.py  # 模组加载器一键安装工具
├── modloaders/          # Fabric / Quilt / Forge / NeoForge 模组加载器目录
├── pre-classic/         # 前经典版（rd-*）
├── classic/             # 经典版（c0.*）
├── infdev/              # Infdev
├── alpha/               # Alpha 版（a1.*）
├── beta/                # Beta 版（b1.*）
├── release/             # 正式版（1.0 → 1.21.11，及 2026 年起的新版本号 26.1 → 26.3）
└── snapshot/            # 快照、预发布版（pre-release）、候选版（rc），按年份拆分
```

## 如何使用

### 方式一：直接下载

各时代目录下的表格均附 Mojang 官方直链，点击即可下载。

### 方式二：一键脚本（推荐）

```bash
# 下载单个版本
python3 scripts/download.py 1.21.11

# 一次下载多个版本
python3 scripts/download.py c0.30_01c b1.7.3 1.8.9

# 下载某一时代的全部版本（会先提示总体积）
python3 scripts/download.py --era alpha

# 列出所有可用版本
python3 scripts/download.py --list
```

脚本会自动校验文件的 SHA1，确保与官方一致；重复下载会跳过已存在文件。

## 各时代说明

| 时代 | 说明 |
|---|---|
| Pre-classic | 2009 年 5 月，Notch 最早的私有原型（rd-*），仅数天 |
| Classic | 2009 年 5 月起首个公开版本，含创造/生存与多人测试 |
| Indev / Infdev | 2009-2010 年的无限地形开发阶段（官方清单仅收录个别代表版本） |
| Alpha | 2010 年 6-12 月，加入红石、多人服务器、下界等 |
| Beta | 2010 年 12 月-2011 年 9 月，加入成就、天气等 |
| Release | 2011 年 11 月 18 日 1.0 正式发布，沿用 1.x 编号至 1.21.11；2026 年起 Mojang 改为「年份.序号」编号（26.1 → 26.3） |
| Snapshot | 每周测试版，以及正式版前的 pre-release / release candidate |

## 注意事项

1. **关于文件体积**：全部客户端约 14.5 GB、全部服务端约 27.1 GB，远超 Git 仓库合理范围，因此本仓库收录**官方索引与直链**而非 jar 文件本体；请用上面的脚本按需下载。
2. **版权声明**：Minecraft 是 Mojang Studios 的商标，所有 jar 文件版权归 Mojang 所有。本仓库仅提供公开的版本元数据索引与官方下载链接，不重新分发任何游戏文件。
3. **客户端启动**：远古版本需要对应的 Java 版本（如 rd-* 需 Java 8，1.21.x 需 Java 21），各版本所需 Java 版本已记录在 versions.json 的 `java` 字段中。

## 全量文件归档（Release）

为防止版本提供商停止服务，本仓库的 **Releases → `files-archive`** 提供了已下载文件的全量存档：

| 内容 | 形式 | 大小 |
|---|---|---|
| 920 个客户端 jar | `archive-client-part-00` ~ `-07` | 14.5 GB |
| 全部资源文件（13001 个对象 + 索引） | `archive-assets.tar` | 1.8 GB |
| 版本 JSON | `archive-versions.tar` | 25 MB |
| 模组加载器安装包（Fabric/Quilt/Forge/NeoForge） | `archive-modloaders-part-*` | 37 GB |
| Mojang 官方 JRE（全平台组件） | `archive-java.tar` | 823 MB |
| 完整性清单 | `MANIFEST-mode.sha256` | — |

**还原方式**：

```bash
# 下载全部归档文件到同一目录后，按分类分别解包：
cat archive-client-part-*     | tar -xf -   # 还原 client/
tar -xf archive-assets.tar                  # 还原 assets/
tar -xf archive-versions.tar                # 还原 versions/
cat archive-modloaders-part-* | tar -xf -   # 还原 modloaders/
tar -xf archive-java.tar                    # 还原 java/
sha256sum -c MANIFEST-mode.sha256           # 校验完整性（应在 mc-files/ 根目录执行）
```

说明：约 584 个模组加载器的远古安装包已被官方 Maven 仓库永久删除（HTTP 404），
任何渠道均无法获取，故不在归档内；其余全部文件均可校验通过。
