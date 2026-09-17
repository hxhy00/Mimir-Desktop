# 发布流程

本文说明如何产出并发布 Mimir-Desktop 的安装包。**发布由 git tag 自动触发**，无需手动上传产物。

> 前置依赖与本地构建见 [DEVELOPMENT.md](./DEVELOPMENT.md)；提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 一、发布机制总览

```
本地打 tag（v0.x.y） → push tag → GitHub Actions 触发
                                        ↓
                          三平台并行构建（mac / win / linux）
                                        ↓
                             上传产物为 Artifact
                                        ↓
                        GitHub Release 自动创建并附带全部产物
```

工作流定义：`.github/workflows/release.yml`，触发条件为 **push 形如 `v*` 的 tag**。

---

## 二、产物矩阵

| 平台 | 构建命令 | 产物 |
|---|---|---|
| macOS | `build:mac` | `.dmg`、`.zip` |
| Windows | `build:win` | `.exe`（portable 与 nsis，靠 `-setup` 后缀区分） |
| Linux | `build:linux` | `.AppImage`、`.deb` |

产物命名：`${productName}-${arch}.${ext}`，即如 `Mimir-arm64.dmg`。**文件名不带版本号**——版本信息由 Release 的 tag 表达，不在文件名里重复。

---

## 三、发布步骤

### 1. 确认 `main` 处于可发布状态

```bash
git checkout main
git pull
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
```

### 2. 决定版本号

遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`v<主>.<次>.<修订>`

- **主版本**：不兼容的重大变更
- **次版本**：向下兼容的新功能
- **修订**：向下兼容的问题修复

### 3. 打 tag 并推送

```bash
git tag v0.1.0
git push origin v0.1.0
```

> 推送 tag 即触发发布，请确认版本号无误再执行。

### 4. 观察 CI 结果

在 GitHub 仓库的 **Actions** 页查看 `Build and Release` 工作流。三个平台全部构建成功后，Release 会自动创建（`draft: false`、`prerelease: false`），并**自动生成 Release Notes**。

### 5. 发布后核对

- [ ] Release 页面包含三平台全部产物
- [ ] 在某台机器实际下载安装，确认可正常启动
- [ ] 应用内「设置 → 关于」显示的版本与 tag 一致

---

## 四、本地构建（不发版）

仅想本地验证打包时：

```bash
pnpm build:mac     # 或 build:win / build:linux
```

产物输出到 `dist/`。`--publish never` 保证不会误触发上传。

---

## 五、签名与公证

本仓库**未使用 Apple Developer 账号**（本机自用 / 团队内部分发场景）。macOS 配置走 **ad-hoc 签名**（`identity: null`），能让本机直接打开，避免 Gatekeeper 报「已损坏」。

- 分发给他人的 macOS 用户首次打开可能需**右键 → 打开**，或执行 `xattr -dr com.apple.quarantine /Applications/Mimir.app`。
- 若未来接入正式签名与公证，需在 `electron-builder.yml` 的 `mac` 段补充 `identity`、`notarize` 配置，并在 CI 注入证书密钥。

---

## 六、常见问题

| 现象 | 原因与处理 |
|---|---|
| tag 推送后 CI 未触发 | 确认 tag 以 `v` 开头（如 `v0.1.0`），且已 `git push origin <tag>` |
| macOS 报「已损坏，无法打开」 | ad-hoc 签名未生效或下载残留隔离属性，执行 `xattr -dr com.apple.quarantine` |
| Windows 两个 `.exe` 重名 | 已由 `-setup` 后缀规避；若修改产物名需同步检查命名冲突 |
| Release 产物缺失某平台 | 查看 Actions 中对应 job 的失败日志，通常是该平台的构建依赖问题 |
