# Mimir Desktop

<p align="center">
  <img src="src/assets/logo.png" alt="Mimir Desktop" width="120" />
</p>

<p align="center"><b>以 Agent 为核心的一站式科研工作台 · 桌面版</b></p>

<p align="center">文献 · 论文 · 实验 · 图表 · 组会 · 会议截稿 · GPU 服务器 · 语音输入</p>

> 把科研里「查文献、读论文、跑实验、写论文、做汇报」这些事，交给一个能用自然语言指挥的 AI 助手。
> 它能直接操作你的科研空间：搜论文、存文献、编译 LaTeX、生成组会 PPT、盯会议截稿——你说需求，它干活，副作用都会先问你。

---

## 下载安装

到 [**Releases**](https://github.com/hxhy00/Mimir-Desktop/releases) 页面下载对应系统的安装包：

| 系统 | 下载 |
|---|---|
| macOS (Apple Silicon) | `Mimir-arm64.dmg` |
| Windows | `Mimir-arm64-setup.exe` / `Mimir-arm64.exe`（便携版） |
| Linux | `Mimir-arm64.AppImage` / `Mimir-amd64.deb` |

### macOS 安装提示「已损坏，无法打开」？

这是 macOS 对**没有苹果开发者公证**应用的安全拦截，不是文件真的坏了。本项目的安装包未付费做苹果公证，首次打开需要放行一次，两种方法任选：

**方法一：右键打开（最简单）**

1. 把 `Mimir.app` 拖进「应用程序」文件夹
2. 在「应用程序」里**按住 Control 键点击**（或鼠标右键）Mimir 图标
3. 菜单里点「**打开**」→ 弹窗里再点「**打开**」
4. 之后正常双击打开即可，只需操作这一次

**方法二：终端命令（一次清除）**

```bash
xattr -cr /Applications/Mimir.app
```

执行后直接双击打开。

> 仍然报错？确认应用在「应用程序」目录里（不要从 dmg 里直接跑），再执行方法二。

### 首次启动配置

1. 打开 Mimir → 右下角「设置」→「模型管理」→「添加模型」
2. 填入任意 **OpenAI 兼容接口**的地址、模型 ID 和 API Key（DeepSeek / OpenAI / 自建网关 / 本地推理都行），点「测试并添加」
3. 选好科研空间目录（默认 `~/Mimir`），开始对话

---

## 能做什么

| 模块 | 一句话说明 |
|---|---|
| **对话** | 自然语言总入口：查文献、写笔记、编译论文、做 PPT 都在这说 |
| **文献库** | arXiv + 网页双来源搜索、PDF 阅读、笔记、BibTeX、订阅 |
| **论文** | LaTeX 多文件编辑 + 真实编译 + 错误一键 AI 修复 |
| **实验** | 实验记录、指标可视化、训练进度 |
| **图表** | 图片管理、从 PDF 提图、LaTeX 引用同步 |
| **组会** | 从论文与实验自动生成 16:9 PPT |
| **会议截稿** | CCF 会议 deadline 倒计时、星标提醒 |
| **服务器** | SSH 连接 + GPU 显存监控 + 远程终端 |
| **记录** | 成长时间线（里程碑 / 论文 / 实验） |

Agent 侧的关键能力：

- **子代理委派**：复杂任务自动派给「研究员 / 写作编辑 / 实验管理员」等专业角色，过程可见
- **上下文治理**：长对话自动摘要压缩，按真实 token 计量，不会聊着聊着失忆或爆预算
- **权限与安全**：沙箱档位 + 批准卡，写盘前必过确认；控制平面永远硬拒绝
- **产物验收**：生成的文件以卡片形式出现在气泡下方，一键打开
- **多会话并行**：A 会话生成时切到 B 会话继续聊，互不阻塞
- **语音输入**：本地离线识别（SenseVoice）或浏览器引擎

---

## 从源码运行

```bash
# 环境要求：Node.js ≥ 22，包管理器 pnpm
pnpm install        # 安装依赖
pnpm dev            # 开发模式
pnpm build          # 构建产物
pnpm test           # 全量测试（离线，无需 API Key）
```

本机打包：

```bash
pnpm build:mac      # macOS：dmg + zip
pnpm build:win      # Windows：nsis + portable
pnpm build:linux    # Linux：AppImage + deb
```

---

## 常见问题

<details>
<summary><b>macOS 打开报「已损坏」（见上方安装一节的详细教程）</b></summary>

右键 → 打开；或终端执行 `xattr -cr /Applications/Mimir.app`。
</details>

<details>
<summary><b>Dock / 启动台里图标显示异常或没更新</b></summary>

macOS 会缓存图标。替换新版本后如果图标没变，终端执行：

```bash
killall Dock && killall Finder
```

或注销重新登录。
</details>

<details>
<summary><b>LaTeX 编译报引擎缺失</b></summary>

「设置 → 语音与资源」里一键下载内置 **Tectonic** 单文件引擎（免安装、跨平台），或使用本机已有的 latexmk。
</details>

<details>
<summary><b>搜索论文时偶发等待较久</b></summary>

主检索走 OpenAlex（快），仅「按最新提交排序」依赖 arXiv 官方接口——它有官方 3 秒/次的限速，遇到限流会自动熔断稍后恢复，不需要处理。
</details>

---

## 参与开发

架构设计、构建避坑、测试体系、权限安全模型等工程细节见 **[DEVELOPMENT.md](./DEVELOPMENT.md)**。

## 相关项目

- [dsh-Mimir-Academic-research](https://github.com/1692775560/dsh-Mimir-Academic-research) —— 本项目的前身：以 DeepSeek Harness 为宿主的科研工作台插件。Mimir Desktop 是其工程化重写的独立桌面版。

## License

[MIT](https://opensource.org/licenses/MIT)（见 `package.json` 的 `license` 字段）
