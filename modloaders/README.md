# 模组加载器目录（客户端）

收录四大主流 Minecraft Java 版模组加载器，共覆盖 **1081** 个「MC 版本 × 加载器」组合。

| 加载器 | 定位 | 覆盖 MC 版本数 | 安装包 |
|---|---|---|---|
| [Fabric](fabric.md) | 轻量、更新快，社区生态最活跃，适合追求新版本与轻量模组 | 532 | [fabric-installer 1.1.2](https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar) |
| [Quilt](quilt.md) | Fabric 兼容生态，工具链更现代化，更新速度略慢于 Fabric | 441 | [quilt-installer 0.15.1](https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar) |
| [Forge](forge.md) | 最老牌、覆盖版本最全（1.1 ~ 26.3），大型模组包首选 | 78 | 见各版本表 |
| [NeoForge](neoforge.md) | Forge 1.20.2+ 的现代化分支，1.20.2 及以后版本的主力加载器 | 30 | 见各版本表 |

## 怎么选

- 想玩**最新版本**、模组少而精 → **Fabric**（或 Quilt）
- 玩**大型整合包**、覆盖老版本 → **Forge**（1.20.1 及以前）/**NeoForge**（1.20.2 及以后）
- 1.20.2+ 的模组大多同时提供 Forge/NeoForge/Fabric 版；1.20.1 及以前基本只有 Forge

## 一键下载安装

本仓库附带 `scripts/modloader.py`，可自动下载安装包并完成客户端安装：

```bash
# Fabric：安装 1.21.11 最新稳定版
python3 scripts/modloader.py fabric 1.21.11

# NeoForge：安装 1.21.11 最新版到指定目录
python3 scripts/modloader.py neoforge 1.21.11 --dir /path/to/game

# Forge：安装指定构建
python3 scripts/modloader.py forge 1.20.1 --build 47.1.79

# 列出某加载器可用的版本
python3 scripts/modloader.py list neoforge 1.21.11
```

> 数据来源：各加载器官网 Meta / Maven，生成日期 2026-10-23。完整机器可读数据见仓库根目录 `modloaders.json`。