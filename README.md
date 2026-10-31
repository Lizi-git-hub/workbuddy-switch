<p align="center">
  <img src="public/icon-transparent.png" alt="Buddy Switch 图标" width="120" />
</p>

<h1 align="center">Buddy Switch</h1>

<p align="center">
  <b>WorkBuddy · CodeBuddy · TraeWork · Qoder 多账号工作台</b><br />
  把「现在登的是哪个号」变成一次点击
</p>

<p align="center">
  <strong>简体中文</strong> ·
  <a href="README.en.md">English</a>
</p>

一个**本地运行**的多账号工作台：把 **WorkBuddy / CodeBuddy / TraeWork / Qoder** 三条产品线、**6 个作用域**的账号收在一处——扫码登录、一键切号、签到与积分、用量统计、会话副本同步。所有数据只放在你自己的机器上。

|  |  |
| --- | --- |
| 🪪 **6 个作用域一屏管完** | 三条产品线 × 国内 / 国际，各有独立账号库；切号带实时进度，写失败自动回滚 |
| ✅ **该做的事自己冒出来** | 概览把「要重新登录 / 今日未签到 / 积分将过期 / 客户端没开」列成待办，点一下处理完 |
| 📊 **用量与积分看得见** | Token、积分、缓存命中率、按账号 / 按模型 / 按会话拆分，全在一屏 |
| 🔁 **会话副本不丢** | 同一份会话在各账号的副本：谁落后、谁分叉，内容指纹 + 加法同步 |

> ⚠️ **非官方 · 非商业**：与 WorkBuddy、CodeBuddy、TraeWork、Qoder 及其权利人不存在隶属、授权、赞助或背书关系。它会读写本机客户端的认证数据、按你的配置自动发起请求。使用前请读完 **[免责声明](docs/policies/DISCLAIMER.md)**。

## 界面预览

<table>
  <thead>
    <tr><th>概览（浅色）</th><th>概览（深色）</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><img src="docs/images/overview-light.png" alt="概览页（浅色）" /></td>
      <td><img src="docs/images/overview-dark.png" alt="概览页（深色）" /></td>
    </tr>
  </tbody>
</table>

<table>
  <thead>
    <tr><th>WorkBuddy 账号（浅色）</th><th>WorkBuddy 账号（深色）</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><img src="docs/images/workbuddy-accounts-light.png" alt="WorkBuddy 账号页（浅色）" /></td>
      <td><img src="docs/images/workbuddy-accounts-dark.png" alt="WorkBuddy 账号页（深色）" /></td>
    </tr>
  </tbody>
</table>

<table>
  <thead>
    <tr><th>用量 · 趋势（浅色）</th><th>用量 · 趋势（深色）</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><img src="docs/images/usage-trend-light.png" alt="用量趋势（浅色）" /></td>
      <td><img src="docs/images/usage-trend-dark.png" alt="用量趋势（深色）" /></td>
    </tr>
  </tbody>
</table>

<details>
<summary><b>更多截图（会话同步 / 设置 / TraeWork 账号 / Qoder 账号）</b></summary>

<table>
  <thead>
    <tr><th>会话副本（浅色）</th><th>会话副本（深色）</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><img src="docs/images/sessions-light.png" alt="会话页（浅色）" /></td>
      <td><img src="docs/images/sessions-dark.png" alt="会话页（深色）" /></td>
    </tr>
  </tbody>
</table>

<table>
  <thead>
    <tr><th>设置（浅色）</th><th>设置（深色）</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><img src="docs/images/settings-light.png" alt="设置页（浅色）" /></td>
      <td><img src="docs/images/settings-dark.png" alt="设置页（深色）" /></td>
    </tr>
  </tbody>
</table>

<table>
  <thead>
    <tr><th>TraeWork 账号（浅色）</th><th>TraeWork 账号（深色）</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><img src="docs/images/trae-accounts-light.png" alt="TraeWork 账号页（浅色）" /></td>
      <td><img src="docs/images/trae-accounts-dark.png" alt="TraeWork 账号页（深色）" /></td>
    </tr>
  </tbody>
</table>

<table>
  <thead>
    <tr><th>Qoder 账号（浅色）</th><th>Qoder 账号（深色）</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><img src="docs/images/qoder-accounts-light.png" alt="Qoder 账号页（浅色）" /></td>
      <td><img src="docs/images/qoder-accounts-dark.png" alt="Qoder 账号页（深色）" /></td>
    </tr>
  </tbody>
</table>

</details>

> 图由 `scripts/gen-readme-shots.mjs` 从演示构建（`VITE_DEMO_MODE=1`）自动生成，账号、积分与请求记录均为虚构数据；界面改版后重跑一次即可同步。

## 全景

```mermaid
flowchart TB
    subgraph SRC["3 条产品线 · 6 个作用域"]
        direction LR
        WB["WorkBuddy<br/>国内版 / 国际版"]
        TR["TraeWork<br/>国内版 / 国际版"]
        QD["Qoder<br/>国内版 / 国际版"]
    end
    subgraph CORE["本机核心 · ~/.buddy-switch/"]
        direction LR
        AC["账号库<br/>凭据 · 回收站"]
        AU["自动化<br/>签到 · 保活 · 轮换"]
        US["用量<br/>Token / 积分"]
        SE["会话副本<br/>内容指纹 · 加法同步"]
    end
    WB --> AC
    TR --> AC
    QD --> AC
    AC --- AU --- US --- SE
```

**三条硬纪律**，贯穿全部功能：数据只落本机、凭据只写客户端登录态（不代登录、不改上游协议）、任何写入前先备份。

## 两种形态

| 形态 | 获取方式 | 说明 |
| --- | --- | --- |
| **桌面 App** | 从源码构建（见下） | Tauri 打包，推荐日常使用 |
| **webui / Docker** | 从源码构建 | 与桌面 App 同一份前端产物，走本地 HTTP 通道；Docker 见 [Docker 部署](docs/guides/DOCKER.md) |

## 快速开始

**桌面 App（源码构建）**：前端产物在**编译期**被应用嵌入，顺序不能反。

```bash
npm install
npm run build                                    # 1) 前端 → dist/
cargo build --release -p buddy-switch-rust       # 2) 编译桌面应用
```

**webui（源码构建）**：

```bash
npm install
npm run build                                    # 1) 前端 → dist/
cargo build --release -p buddy-switch-server     # 2) 编译服务端（把 dist/ 嵌进去）
./target/release/buddy-switch                    # 3) 起服务并打开浏览器（默认 127.0.0.1:57890）
```

```bash
buddy-switch              # 起服务 + 打开浏览器
buddy-switch serve        # 只起服务（--port 指定端口）
buddy-switch status       # 终端查看当前账号
buddy-switch version      # 版本号
```

<details>
<summary><b>macOS 提示「已损坏」／「无法验证开发者」／切换时提示无权限</b></summary>

- **提示「BuddySwitch 已损坏，无法打开」**（Gatekeeper 对**已下载但未签名**的应用会给这句，而不是「无法验证开发者」）：
  把应用拖进「应用程序」后执行 `xattr -dr com.apple.quarantine /Applications/BuddySwitch.app`，再正常双击打开。
  这条命令只删「从网络下载」这个标记，不改动应用本身。
- 无法验证开发者：Finder 里按住 Control 点击应用 → 「打开」，或到「系统设置 → 隐私与安全性」→「仍要打开」。
- 切换账号需要写入客户端认证文件：在「系统设置 → 隐私与安全性」的 **App 管理**（或 **完全磁盘访问**）中授权 BuddySwitch，然后重启应用。设置页的「权限检测」可随时验证。
- webui 形态的权限跟随启动服务的终端进程。
- **macOS 反复弹出「允许访问钥匙串」**：客户端（Qoder / CodeBuddy IDE）的 Safe Storage 主密钥存在系统钥匙串里，首次读取必然要一次授权，点「始终允许」即可；同一进程内只会读一次（已缓存）。
  若每次操作都弹，通常是应用被移动过或重新安装导致签名身份变化 —— 在「钥匙串访问」里把该条目删除后，重开一次客户端与 BuddySwitch，重新授权一次即可。

</details>

## 6 个作用域（平台 × 区域）

顶栏左上角的作用域选择器决定「现在管哪一套账号」。作用域写进 URL（`/s/wb-cn/accounts`），刷新、分享、前进后退都留在原地；`⌘K` / `Ctrl+K` 跨作用域搜索，`⌘1`–`⌘6` 直接切换。

| 作用域 | 平台 | 区域 | 管理的客户端 |
| --- | --- | --- | --- |
| `wb-cn` | WorkBuddy | 国内版 | WorkBuddy 桌面端、CodeBuddy CN IDE / CLI、VS Code / JetBrains 的 CodeBuddy 插件 |
| `wb-global` | WorkBuddy | 国际版 | 同上（国际版客户端） |
| `trae-cn` | TraeWork | 国内版 | Trae CN |
| `trae-global` | TraeWork | 国际版 | Trae |
| `qoder-cn` | Qoder | 国内版 | Qoder CN 桌面版 / CLI |
| `qoder-global` | Qoder | 国际版 | Qoder 桌面版 / CLI |

六个作用域**彼此独立**：独立账号库、独立客户端、独立配置。Trae 的两条老程序线（TraeWork / TraeCode）已被官方合并成同一个客户端，旧标识仅作兼容。

## 侧栏 5 个目的地

三个平台**逐条同构**：**概览 · 账号 · 用量 · 会话 · 设置**。入口按**能力门控**（不是平台分支）：缺哪个能力就不画哪个入口，URL 直达时给结构化空态。

| 目的地 | 一句话 |
| --- | --- |
| **概览** | 待处理清单（需重新登录 / 今日未签到 / 积分将过期 / 客户端未运行）+ 统计卡 + 近 14 天 Token 柱状图 + 其他作用域速览 |
| **账号** | 卡片 / 表格双视图、程序位切换、扫码或设备码登录、本机导入、签到、回收站（30 天）、客户端限流台账（WorkBuddy 专有） |
| **用量** | 一个工作台三个视图：趋势 · 会话 · 积分；参数条只有一条（时间范围 + 作用域） |
| **会话** | 同一份会话在各账号的副本：谁落后、谁分叉、同步给谁（**仅 WorkBuddy**） |
| **设置** | 九个分区：通用 · 账号与登录 · 签到与积分 · 网关 · 计划任务 · 客户端 · 权限与诊断 · 日志 · 备份与恢复 |

### 用量工作台

**趋势**视图包含：等效花费大数（按自设的模型单价把 token 折算成钱，支持峰谷分时计价，内置中国法定节假日表）、输入 / 输出 / 缓存命中率、每日 Token 柱状图（可按模型拆分，独立时间窗口）、按天日历热力图（最近一年）、用量波浪图、模型占比环形图（图例带各模型的四档明细）。

**会话**视图：会话排行（去重后的真实会话）、按账号汇总、记录数 × Token 散点。

**积分**视图：积分明细（按账号的窗口内消耗）、客户端账本（按模型拆分）、每日积分消耗曲线。

### 能力矩阵

| 能力 | WorkBuddy | TraeWork | Qoder |
| --- | :---: | :---: | :---: |
| 账号库 / 登录 / 本机导入 | ✅ 扫码 + 导入 | ✅ 网页登录 + JWT | ✅ 设备码 + PAT |
| 一键切程序位 | ✅ 5 个（4 可切换 + 1 只读探测） | ✅ 1 个（合并客户端） | ✅ 2 个（桌面版 / CLI） |
| 签到 / 积分 | ✅ 含自动旅行、自动轮换 | ✅ | ✅ 每日活动领取（campaigns）+ 套餐 / 额度 |
| 用量统计 | ✅ Token + 积分 | ✅ Token + 积分 | ✅ 仅积分（客户端本地把 token 计数恒记为 0） |
| 会话副本同步 | ✅ 内容指纹 + 加法同步 | — | — |

## 切换账号是怎么做的

```mermaid
flowchart LR
    A["选中账号"] --> B["备份当前登录态"] --> C["关闭客户端"] --> D["写入目标账号"] --> E["校验并重启"]
    D -->|"可选"| F["附带：会话复制<br/>记忆与连接器合并"]
```

- **先备份后写入**：认证文件、Trae 登录态快照、会话覆盖前，都会先留一份可回滚的副本。
- **写后校验**：写入失败自动还原；客户端运行中直接拒写，避免退出时把内存里的旧登录态写回覆盖。
- **删除是软的**：账号先进回收站保留 30 天，可随时恢复；永久删除才连带清凭据与快照。

## 自动化

计划任务支持**分钟粒度**时点（如 `09:37`）、多个时点，以及**随机抖动**（±5/15/30 分钟）——让每天的实际触发时刻错开，而不是整点齐发。

| 侧 | 任务 |
| --- | --- |
| WorkBuddy（6 类） | 签到 · 猫猫旅行 · 活跃地图 · Token 保活 · 开学季 · 夜猫子 |
| Trae（2 类） | 签到 · JWT 自动续期 |
| Qoder（2 类） | 签到 · 令牌保活 |

自动轮换（仅 WorkBuddy）是**独立的后台循环**，不是排程表里的一项——见下。

<details>
<summary><b>自动轮换策略（WorkBuddy，防积分过期）</b></summary>

后台定时把 **CodeBuddy CLI 后续启动**的默认账号设为「最紧迫」的账号（最早到期且仍有剩余积分）。依次判定：

1. 有效账号（查询成功、未过期、有剩余积分）
2. 紧迫度检查（最紧迫的剩余超过 `min_urgency_hours`，默认 72h → 不切）
3. 已是目标 → 不切
4. 冷却期（`cooldown_minutes`，默认 120）
5. 活跃保护（最近 `active_guard_minutes`，默认 30 内有对话 → 不切）
6. 价值过滤（剩余积分低于 `min_remaining_credits` → 不值得切）
7. 防抖动（差异小于 `min_gap_hours`，默认 24 → 不切）

**生效边界**：只更新后续会话使用的默认账号，不热切换当前会话——需 ACP 重新加载会话或重启 CLI。

</details>

<details>
<summary><b>应用级能力（六个作用域共用，不随作用域切换）</b></summary>

| 能力 | 说明 |
| --- | --- |
| 应用设置（顶栏 ⚙） | 主题（浅 / 深 / 纯黑 OLED / 跟随系统）、界面语言（简体中文 / English）、开机静默启动、关闭窗口进托盘 |
| 全局备份与恢复 | 一次覆盖全部作用域，按账号 / 配置分区勾选，**默认不含凭据** |
| Skill 管理 | 扫描 `skills/*/SKILL.md`，逐项启停（行级重写、其余字节原样保留），支持跨区域搬迁与 zip 导入 |
| 客户端设置托管 | 统一读写上游客户端自己的 `settings.json`：6 槽位规格表 + 格式指纹 + 字节级最小补丁 + 备份 / 恢复 / 差异对比 |
| 会话悬浮窗（仅桌面端） | 独立小窗展示跨来源的任务状态，只读、可点回原会话 |
| 运行日志 | 本工具**自己**的日志（`~/.buddy-switch/logs/runtime-YYYY-MM-DD.log`），在「设置 → 日志」里按级别 / 日期 / 关键字筛选、复制、打开目录、清空。保留 7 天，单文件 4 MiB、每天最多 4 个分片；写盘前脱敏凭据。`BUDDY_SWITCH_LOG_LEVEL=debug` 后重启可看逐请求明细 |

</details>

## 数据与隐私

- 全部数据落在本机 `~/.buddy-switch/`，不上传任何第三方服务；界面偏好只存本地。
- 账号库按作用域分家（如 `accounts.json` / `accounts.global.json`、`trae/checkin_accounts*.json`）。
- 导出备份**默认不含 token**；显式勾选并二次确认后才会写明文，页面同步警告该文件可直接用于登录。
- 运行日志留在本机，且**写盘前脱敏凭据**（token 参数、`Bearer` 值、JWT）。

## 开发

```mermaid
flowchart TB
    FE["src/ · React 19 + Vite<br/>5 目的地 · api.ts 双通道"] --> H["宿主：Tauri commands ｜ HTTP (axum)"]
    H --> CORE["crates/buddy-switch-core<br/>账号 · 认证 · 签到 · 会话 · 作用域"]
    CORE --> DATA[("~/.buddy-switch/")]
```

```bash
npm install
npm run tauri dev     # 桌面端开发
npm run build         # 前端构建 + 契约 / 作用域 / 平台门禁
npm run check:api     # 只校验前端 API 契约
```

```
crates/
  buddy-switch-core/     # 账号、认证、OAuth、进程、切换、会话、签到、区域、Trae / Qoder 模块
  buddy-switch-gateway/  # OpenAI / Anthropic 兼容网关
  buddy-switch-server/   # HTTP server + CLI（axum API + rust-embed 内嵌前端）
src-tauri/               # 桌面宿主（Tauri command 薄包装 + 托盘）
src/                     # 前端：components / pages / lib / locales
```

## 文档

完整索引在 [docs/README.md](docs/README.md)。最常翻的几份：

| 文档 | 讲什么 |
| --- | --- |
| [guides/DEVELOPMENT.md](docs/guides/DEVELOPMENT.md) | 环境要求、本地开发、门禁清单、发布流程、目录约定 |
| [guides/DOCKER.md](docs/guides/DOCKER.md) | 容器部署：源码构建、端口与安全、排障 |
| [policies/](docs/policies/) | 许可与免责声明 |

## 致谢

- **[changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch)**（MIT）—— 账号数据格式、多账号切换、积分与 Token 统计的实现基础。
- **[Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)** —— 把模型额度封装成 OpenAI 兼容接口的思路。

相关名称与商标归各自权利人所有。

## 许可

**[PolyForm Noncommercial License 1.0.0](./LICENSE)**：个人非商业使用允许，**商业使用不被授权**。

- 条款全文：[LICENSE](./LICENSE)，白话说明见 [docs/policies/LICENSING.md](docs/policies/LICENSING.md)（[English](docs/policies/LICENSING.en.md)）
- 完整免责声明：[docs/policies/DISCLAIMER.md](docs/policies/DISCLAIMER.md)（[English](docs/policies/DISCLAIMER.en.md)）
- 本项目为个人项目，不提供商业支持、SLA 或维护承诺。
