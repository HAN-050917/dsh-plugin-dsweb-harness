# 发布指南 · Publishing

这个仓库已经按 DSH 插件市场的收录要求整理好了（`package.json` 的 `dsh.bundle` / `dsh.client`、
`icon.svg`、`locale/{zh,en}.json` 的 `meta`、MIT 许可证、`dsh-plugin` 关键词）。
下面是从本机推到 GitHub、发到 npm、再上架市场的完整步骤。

---

## 0. 先确认三件事

```bash
node --check lib/index.js && node --check lib/client.js   # 语法
for f in test-*.mjs; do node "$f" || echo "FAIL $f"; done # 19 个套件必须全绿
npm pack --dry-run                                         # 该发的文件：lib/ locale/ cordis.patch.yml icon.svg README LICENSE
```

`dsh.client` 声明了但 `dsh.bundle` 缺失的包**不可安装**——本仓库两者都有，这是市场 CI
最常见的退回理由，已经避开。

## 1. 推到 GitHub

仓库地址已按 `<你的用户名>/dsh-deepseek-web-chat` 写在 `package.json` 里
（`repository` / `homepage` / `bugs`）；如果用户名不是 `HAN-050917`，先全局替换。

```bash
# 在 GitHub 上先建好空仓库（不要勾选 README），然后：
git remote add origin https://github.com/HAN-050917/dsh-plugin-dsweb-harness.git
git push -u origin main
```

**别忘了给仓库加 `dsh-plugin` topic**（Settings → Topics）。市场 CI 会检查它。

## 2. 发到 npm（可选，但强烈建议）

市场只从**精选清单**安装，清单里的包如果能在 npm 上找到预构建版本，用户就不必跑构建脚本
（pnpm ≥10 默认拦依赖脚本，源码安装要求用户先在插件页点「允许脚本并重试」）。

```bash
npm login                 # 需要 npm 账号
npm publish --access public
```

`repository` 字段是**承重结构**：市场 CI 用它验证 npm 上的包能映射回清单里的仓库，
所以第 1 步的地址必须是最终仓库地址。

## 3. 上架插件市场

市场 App（`dshmarket`）读的是**精选清单**，不是它自己的仓库：

- 目录：<https://awesome-dsh-plugin.com/plugins.json>（每次打开实时拉取）
- 提交方式：给 **awesome-dsh-plugin/awesome-dsh-plugin** 提 PR，**每个插件一个 YAML 文件**：
  `data/plugins/<owner>__<repo>.yml`

Fork → 新建下面这个文件 → 提 PR（一次 PR 最多 3 个条目）：

```yaml
# data/plugins/HAN-050917__dsh-plugin-dsweb-harness.yml
url: https://github.com/HAN-050917/dsh-plugin-dsweb-harness
name: HAN-050917/dsh-plugin-dsweb-harness
category: ui
description:
  en: Sync and continue your chat.deepseek.com conversations inside DSH, with a ChatGPT-style chat/work switch.
  zh: 把 chat.deepseek.com 的对话同步进 DSH，并在这里直接继续聊天；聊天/工作 切换与 ChatGPT 桌面版同构。
```

同一份内容也放在本仓库的 `contrib/awesome-dsh-plugin.yml`，方便复制。

CI 顺序：每个 PR ≤3 条 → `dsh.bundle` 存在 → 仓库创建满 1 天 → awesome-lint 与站点构建。
合并后站点和市场通常在一天内自动出现该插件。

## 4. 用户可以怎么装

```bash
# ① 市场（先装市场本体）
dsh plugin --profile web add dshmarket      # 需要 dsh web ≥ 0.1.0-rc.6
# 之后在 DSH「设置 → 插件市场」搜索 deepseek 一键安装

# ② 命令行
dsh plugin --profile desktop add dsh-deepseek-web-chat
dsh plugin --profile desktop add github:HAN-050917/dsh-plugin-dsweb-harness
```

装完**重启 DSH**：宿主半边是 ESM，只有新进程才会加载新的 JS 代际。

## 5. 之后发新版本

```bash
npm version patch        # 或 minor / major，同时自动打 tag
git push --follow-tags
npm publish --access public
```

市场按「npm 版本号或固定 commit 与 HEAD 的差异」检测更新；已安装的用户升级方式是
**先卸载再安装**（插件页没有版本选择器）。

## 6.（可选）截图轮播

市场用 `screenshots.json`（与 `package.json` 同目录）做 AppStore 式轮播：

```json
{ "screenshots": ["docs/shot-1.png", "docs/shot-2.png"] }
```

规则：**1–8 张**，相对路径；绝对 URL 只能是 GitHub 域名下的 https
（`raw.githubusercontent.com`、`user-images.githubusercontent.com`、`camo.githubusercontent.com`、
`github.com` 附件），第三方图床会被拒。放进本仓库 `docs/` 再提交即可。

## 7. 安全检查（发布前）

```bash
grep -rn "sk-\|Bearer \|userToken" lib/ locale/ | grep -v "'Authorization'" || true
git log --all --stat | grep -i "\.env\|token\|vault" || true
```

令牌**不进仓库**：本插件把令牌写在本机 `%USERPROFILE%\.dsh\dsh-deepseek-web-chat\vault.json`，
仓库里没有任何凭据；`_probe/`、`fixtures/` 里也只有抓包样本，没有账号信息。
