# DeepSeek 网页聊天 · DSH 插件

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-4D6BFE)
![tests](https://img.shields.io/badge/tests-18%20suites%20%C2%B7%200%20deps-brightgreen)

把 **chat.deepseek.com**（DeepSeek 网页版）的对话记录同步进 DSH 的 Web 界面，并在同一个窗口里
直接继续聊天——不用再切到浏览器。左侧面板栏多出一个「聊天」图标，会话标题栏多出一个
**聊天 / 工作** 切换开关，和 ChatGPT 桌面版的 聊天 ⇄ 工作 是一个意思。

> 想先看「产品向」的介绍（亮点、架构图、三步安装）？见 👉 [产品介绍.md](产品介绍.md)。

```
┌─ 侧栏 ─┬────────────── 聊天面板 ──────────────┐
│  ▣ 插件 │  [ 聊天 | 工作 ]   ⟳ 同步  ＋ 新对话  │
│  ▤ 聊天 │ ┌─────────┬───────────────────────┐ │
│         │ │ 搜索…    │  你: …                │ │
│         │ │ 会话 A   │  DeepSeek: …          │ │
│         │ │ 会话 B   │  ▍                   │ │
│         │ └─────────┴───────────────────────┘ │
└─────────┴─────────────────────────────────────┘
```

- **聊天模式** = 这个插件面板，走你自己的 chat.deepseek.com 账号，历史记录与网页版一致。
- **工作模式** = DSH 原本的 Agent 会话（工具、文件、终端……），两者互不干扰。
- 切换只改变中间显示哪一栏，**不会**新建或销毁会话，来回切是瞬时的。

---

## 安装

三种装法，任选其一。装完都要**重启 DSH**：宿主半边是 ESM，只有新进程才会加载新的代际。

**① 插件市场（推荐）** —— 装一次市场，之后在 DSH 里「设置 → 插件市场」搜索本插件一键安装：

```bash
dsh plugin --profile web add dshmarket   # 需要 dsh web 0.1.0-rc.6 及以上
# 然后重启 dsh web
```

**② 命令行 / 插件页** —— 包名、Git 地址、tarball 或本地绝对路径都接受：

```bash
dsh plugin --profile desktop add dsh-deepseek-web-chat
# 或未发布时直接指向仓库 / 本目录：
dsh plugin --profile desktop add github:ardeyouxipianyi/dsh-deepseek-web-chat
dsh plugin --profile desktop add C:/Users/p/Documents/deepseek-harness/default-workspace/dsh-deepseek-web-chat
```

> 桌面版需先初始化一次 profile，并**完全退出**后再执行 `dsh plugin --profile desktop …`。
> 也可以让 DSH 里的 Agent 执行：`plugin_manager action=install_bundle target=<本目录绝对路径>`。

**③ 本仓库开发** —— 本目录以 `link:` 方式挂在桌面配置里（`dsh.profile.bundles` 的最后一项），
所以**改工作区代码就是改插件**：客户端半边刷新页面即可生效，宿主半边（`lib/index.js`、
`lib/deepseek.js`）必须重启 DSH。没有构建步骤，`lib/client.js` 是手写产物、由宿主直接发布。

```powershell
# 跑测试（18 个套件，零依赖，用 DSH 自带 Node）
node test-surface.mjs   # …test-*.mjs 都在包根目录
```

## 配置令牌（一次性）

插件需要你自己的网页版登录令牌才能读你的对话。令牌只存在本机，只用于向
`chat.deepseek.com` 发请求。

1. 浏览器打开并登录 <https://chat.deepseek.com>。
2. `F12` → **Console**，粘贴回车：

   ```js
   JSON.parse(localStorage.getItem('userToken')).value
   ```

3. 复制打印出来的令牌，切到 DSH 的「聊天」面板，粘贴进输入框，点 **保存并验证**。

输入框也接受整段 `Authorization: Bearer …`，或直接粘贴 `userToken` 的整段 JSON——会自动解开。

> **令牌会过期。** 过期后面板顶部会出现红色提示，按上面三步重新取一次即可。
> 点「清除令牌」会删除本机文件。

令牌存放位置：`%USERPROFILE%\.dsh\dsh-deepseek-web-chat\vault.json`（仅当前用户可读）。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 会话同步 | 拉取网页版的会话列表（最多 500 条），带标题与时间 |
| 历史回看 | 打开任一会话，读取完整的问答记录 |
| 本地缓存 | 同步结果落在 `cache.json`，离线也能看，最多缓存 200 个会话 |
| 继续聊天 | 在已有会话里接着发消息，网页版刷新后能看到（同一条会话） |
| 新建会话 | 「＋ 新对话」在 DeepSeek 侧建一个新会话再发消息 |
| 深度思考 / 联网搜索 | 对应网页版的两个开关 |
| 模型选择 | `default` / `expert` / `vision` |
| 流式输出 | 逐字返回；思考内容折叠显示在回答上方 |
| 自动续写 | 上游把长回答截断时（`INCOMPLETE` / `auto_continue`）自动调 `/chat/continue` 接着写，最多 8 轮 |
| 可中断 | 生成中点「停止」，会中断上游请求 |
| 添加附件 | 点 composer 左侧「＋」选择文件，或把文件拖到聊天面板；上传后可移除附件，也支持仅发送文件 |
| 拖拽上传 | 拖入文件时显示整窗投放提示；多个文件会逐个开始上传（最多 10 个、单个 100 MB） |
| 网页版附件协议 | Host 获取专属 PoW、multipart 上传并轮询至可用；附件 ID 随同回合发送到网页版接口 |
| 按文件内容追问 | 附件留在会话里：首轮之后继续提问，Host 仍会把该会话的附件 ID 一并送到上游，所以模型始终读得到文档内容（上游自己**不**保留文件，见下） |
| 文件解析状态 | 上传后 chip 显示 解析中… / 解析失败 / 文件大小；解析未完成时发送会被拦下（`409`），不会再出现「发出去了却一片空白」 |

拖拽时可把一个或多个文件放到聊天面板内（**窗口任意位置**都可投放，见「拖放不白屏」），面板会显示投放提示并逐个上传；也可使用输入框旁的「＋」选择文件。上传成功后附件以 chips 显示，发送后仍留在 composer 里：这份对话一直带着这些文件，因此后续追问不需要重新上传，想断开时点 chip 上的 × 即可（Host 会照做，见 `/chat` 的 `detachFiles`）。即使不输入文字也可发送附件。当前限制为最多 10 个附件、单文件 100 MB。
| 聊天气泡 | 你的提问靠右、DeepSeek 的回答靠左，各自成气泡 |
| 侧栏「聊天」页签 | 侧栏 任务 / 频道 之间多一个「聊天」页签，专放网页版对话记录，与工作区会话列表互不干扰（第三方页签行，检测不到时自动退回普通面板，见下） |
| 只有一份列表 | 同一份对话记录**永远不会同时出现两次**：侧栏停在「聊天」时列表在侧栏，切回「任务」时列表回到面板左列 |
| 干净正文 | 搜索簿记（`搜索到 N 个网页`、`DEEP_SEARCH`、工具调用记账）与免责声明 `TIP` 不会混进正文；`[reference:N]` / `[citation:N]` 引用标记会被剥掉（网页端把它渲染成可点击芯片，这里没有来源面板，留着只是噪音） |

---

## 架构

一个包、两个半边，靠 DSH 的 `dsh.bundle.patch` + `dsh.client` 同时挂载：

```
dsh-deepseek-web-chat/
├── package.json          # dsh.bundle.patch + dsh.client（platform: web）+ dsh-plugin 关键词
├── cordis.patch.yml      # 往 profile 里 insert 一行：id deepseek-web-chat
├── icon.svg              # 插件列表与市场里的图标（package.json.icon）
├── LICENSE               # MIT
├── PUBLISHING.md         # 推到 GitHub / 发 npm / 上架插件市场的步骤
├── contrib/              # 给 awesome-dsh-plugin 清单用的 YAML 条目
├── lib/
│   ├── index.js          # 【Host 半边】HTTP 路由 + SSE 转发 + 本地缓存
│   ├── deepseek.js       # chat.deepseek.com 客户端（会话列表 / 历史 / 补全 / SSE 归约）
│   ├── pow.js            # DeepSeekHashV1 工作量证明（纯 JS，无依赖）
│   ├── vault.js          # 令牌保险箱（0600，原子写）
│   └── client.js         # 【浏览器半边】手写 lazy-CJS bundle，无构建步骤
├── locale/{zh,en}.json   # 插件列表里的显示名
├── test-pow.mjs          # PoW 官方向量自测
├── test-sse.mjs          # 用真实抓包回放 SSE 归约
├── test-envelope.mjs     # 初始化信封的正文是「前缀」而非重放（含短回答只有信封的场景）
├── test-history.mjs      # 用真实 history_messages 抓包验证历史解析（fragments 按类型分流）
├── test-search.mjs       # 用真实「联网搜索」抓包验证簿记/引用标记不外泄
├── test-continue.mjs     # 用真实的「截断 + 续写」两轮抓包验证自动续写判定
├── test-api.mjs          # 浏览器半边的 URL 拼装（query string 不能被吞掉）
├── test-citations.mjs    # 引用标记 [reference:N]/[citation:N] 必须在渲染前剥掉
├── test-markdown.mjs     # markdown 渲染器的块级/行内分支（含 CJK 软换行）
├── test-think.mjs        # 推理行：折叠摘要算法、展开行为、24px 行高几何
├── test-paging.mjs       # 会话列表翻页：游标闭区间、去重、has_more 撒谎也终止
├── test-i18n.mjs         # 中英字典完整性：无缺键、无死键、无绕过字典的硬编码文案
├── test-style.mjs        # 样式表只用真实主题 token，且类名都有定义
├── test-panel.mjs        # 「同一时刻只有一处画会话列表」的归属规则
├── test-surface.mjs      # 聊天/工作表面：持久化、幂等、以真实面板为准的对齐、每面各自的位置记忆（49 条断言）
├── test-load.mjs         # 整个客户端 bundle 完整装载一次 + 对最小 ctx 调 apply（12 条断言）
├── test-render.mjs       # 真组件真的画一遍：加载/就绪/附件 chip 各状态 + 厂级作用域里误用 t() 的静态扫描
└── test-chat-route.mjs   # Host 路由级：客户端断开必须 abort 上游、新回合顶掉旧回合、协议版本一致
```

### 测试与预览工具

`tools/` 下的脚本不进包运行时，只服务于开发期核对：

| 脚本 | 作用 |
| --- | --- |
| `lift.mjs` | 从 `lib/client.js` 里**提升**出真实函数源码段（括号配平需跳过字符串/模板串/注释/正则字面量），供测试与预览复用 |
| `build-preview.mjs` | 渲染合成样本，输出 `_preview/preview.html`，用无头浏览器量折叠态几何 |
| `build-expanded-preview.mjs` | 把 `useState` 桩成 `expanded=true`，输出展开态 |
| `build-live-preview.mjs` | 拉真实 `/sessions` + `/messages` 渲染，输出 `_preview/live.html` |
| `dump-theme-tokens.mjs` / `extract-theme-css.mjs` | 从主题包里导出 token 词汇表与 CSS，喂给 `test-style.mjs` |

三个预览脚本都**调用** `lift.mjs` 提升出来的真实函数，而不是复制一份标记：复制的那一份已经漂移过一次
（其中一份扫描器缺正则字符类处理，markdown 段被截断在 `{2,}` 上）。

### 浏览器半边

`lib/client.js` 走 DSH 的 lazy-CJS 协议（`window.__ModuleLoader__.load({id, factory})`），
**没有构建步骤**，外部依赖只有平台自带的 `react`。它占了三个官方 slot，并额外接了一个
第三方页签（见下）：

| Slot | 作用 |
| --- | --- |
| `sidebar.panellist`（list，`id: 'deepseek-web-chat'`） | 左侧面板栏的图标；面板栏自己画按钮，插件只画图形 |
| `main`（keyed，`key: 'deepseek-web-chat'`） | 聊天面板本体 |
| `conversation.header.leading`（single，原本空着） | 标题前的 **聊天 / 工作** 开关，没开会话时也在 |

（另有 `ctx.inject(['shortcuts'], …)` 注册的两个切换命令，见下。）

模式切换用的是 DSH 自己的原语：`ctx.layout.selectPanel('deepseek-web-chat')` 进聊天，
`selectPanel(null)` 回 Agent 会话（`null` 就是「回到 Conversation」）。所以不需要任何
DOM 技巧，也不会盖掉自带界面。

#### 「表面（surface）」轴：从 ChatGPT 桌面端反推来的四个机制

聊天 / 工作在这份实现里是一个**独立的表面轴**，既不等于 Agent 的工作模式，也不挂在某个
会话上。这一点是照着 ChatGPT/Codex 桌面端做的——那边 `codexAppMode: 'chat' | 'work' |
'codex'` 是应用级表面，而 plan/default 只是**单轮**的元数据。值得抄的不是它的字段名，而是
下面四条行为（都能在 `test-surface.mjs` 里单独验证）：

| 机制 | ChatGPT 桌面端 | 这里 |
| --- | --- | --- |
| 选择独立于会话持久化 | `localStorage['home-composer-mode-v1']` | `localStorage['dsh-deepseek-web-chat.surface.v1']`，重载后回到你离开的那一面 |
| 幂等切换 | `if (i === n && !a) return;` | `surfaceStore.select()` 先过 `isSameSurface()`，点当前那一面不重新导航 |
| 先持久化再导航 | 存完再改路由，路由变化才执行切换 | 先写 localStorage，再 `selectPanel` |
| 每个模式各记一个位置 | 记住 `location`，回来时恢复 | `…locations.v1` 里记 `{sessionId}`，回来时重开那个会话；**记的那个会话没了就开新对话**，绝不回到过期线程 |

两个额外的细节，都是踩过的坑：

- **列表还没同步时不能判断「位置没了」**。那会儿「查不到」只是「还不知道」，当时就决定的话
  会把人误丢进新对话。所以这种情况下把恢复**推迟到第一次同步成功之后**
  （`pendingChatRestore`），而不是靠猜。
- **面板 key 还没注册时 `selectPanel` 会抛**。它是从一个 `onClick` 里调的，所以这里吞掉异常
  当作 no-op：「界面还没准备好」而不是让点击炸掉。选择已经先写进 localStorage，下次启动会重试。

快捷键与开关是同一段代码：`Alt+1` = 聊天，`Alt+2` = 工作（macOS 用平台惯例的 `Ctrl+1/2`），
注册成两个命令（`deepseek-web-chat.switchToChat` / `switchToWork`），对应桌面端的
`codex.command.switchToChat` / `switchToWork`。`shortcuts` 服务是 `ctx.inject(['shortcuts'], …)`
**按需注入**的，所以没有这个服务的组合里面板和开关照常工作。

特意**没有**照搬的一条：把表面塞进 `history.state`。DSH 自己管 URL 和路由，插件不碰它。

会话状态存在 React 之外的 `store` 里——面板切到「工作」时组件会卸载，状态留在外面才能
切回来瞬间恢复、且不会每次重新同步。正在生成的请求同理，放在 `flight` 里，切面板不会丢。

#### 侧栏「聊天」页签（非官方挂载点）

侧栏里的 `任务 | 频道` 这一行**不是 DSH 自带的**，而是第三方插件
`@michengai/dsh-im-connect` 接管 `sidebar.workspaces` 后自己画的。它同时在该 slot 的
occupant 上挂了一个未公开的注册表（`__dshNativeTabs`），其它插件可以往里 `insert` 页签。

DSH 官方**没有**在这一行插页签的 slot，所以这里做的是**特性探测 + 优雅降级**：

1. 从 `ctx.slots.entriesOfSlot('sidebar.workspaces')` 找到 occupant，读 `__dshNativeTabs` /
   `component.__dshNativeTabs`；找不到就什么都不做（剩余功能完全不受影响，面板照常用）。
2. 找到就 `registry.insert({ id: 'deepseek-web-chat-tab', order: 10, label, render })`——
   `order: 10` 夹在「任务」与「频道」（order 20）之间。页签体只放网页版对话记录，
   点条目 = 打开该会话并把主区切到聊天面板。
3. 同时监听 `dsh-native-sidebar-change` 事件（im-connect 换页签时会广播），以便它重建
   页签行后把我们的页签重新插回去。

**只有一份列表**：外壳只渲染**当前选中**的页签体，所以「页签体在挂载中」就等于「列表正在
侧栏里显示」。清单组件挂载时置 `tabVisible: true`、卸载时置回 `false`，面板据此决定要不要
画自己那一列（`state.tabVisible ? null : dswc-side`）。侧栏停在「聊天」时列表在侧栏、切回
「任务」时列表回到面板左列，**任何时刻都只有一份**——早期版本两边同时画，用户看到的正是
两份一模一样的列表。

脆弱点（写在这里以免以后当 bug 查）：注册表未公开、随 im-connect 版本可能变化；若
im-connect 检测到 Codex UI 侧栏而自我解包，整个 任务/频道 行会消失，此时页签也一并消失，
但面板、图标与 聊天/工作 开关仍在。

#### URL 拼装（踩过的坑）

`api(path)` 必须返回 `pathname + search`。最初只返回了 `pathname`，于是
`/messages?sessionId=…` 到 Host 时参数已经没了，Host 回 `400 缺少 sessionId`；而
`/sessions?count=500&refresh=1` 因为 Host 对这两个参数有默认值，看起来「正常」，
把问题藏了很久。`test-api.mjs` 用真实 bundle 源码跑这条路径（变异测试：改回
`.pathname` 该套件立刻失败）。

### Host 半边

九条路由挂在 `/dsh-deepseek-web-chat` 前缀下：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 令牌状态、用户信息、模型列表、缓存统计 |
| POST | `/token` | 校验并保存令牌 |
| POST | `/token/clear` | 删除令牌 |
| GET | `/sessions?count=&refresh=` | 会话列表（`refresh=0` 只读缓存） |
| GET | `/messages?sessionId=&refresh=` | 某个会话的全部消息 |
| POST | `/session/new` | 在 DeepSeek 侧新建会话 |
| POST | `/chat` | 发一条消息，SSE 流式返回（body 另可带 `refFileIds`、`attachments`、`detachFiles`） |
| POST | `/upload` | 接受单个文件原始字节，转发给 DeepSeek，短暂等待后返回真实解析 `status` + `settled` |
| GET | `/files?file_ids=` | 查询已上传附件的状态 |

`/chat` 的请求体里与附件有关的三个字段：

- `refFileIds`：这一轮**新挂上**的附件 ID（面板不再重复发送整份列表，见下）；
- `attachments`：仅用于本地快照显示的 `{name}` 列表，上游看不到；
- `detachFiles: true`：明确表示「这份对话不再需要这些文件」，Host 会清掉该会话的记忆。

Host 侧把 `refFileIds` 与**该会话记忆的 ID**（`cache.files[sessionId]`）合并后才发给上游，并逐个核对：上游已经不再列出的 ID（过期/被删）会被剔除，不会让之后每一轮都失败；仍在解析的要等到终态，否则不写 SSE 头就回 `409`。

每条路由都自己过一遍同源检查（Host 必须是回环地址、拒绝 `sec-fetch-site: cross-site`、
Origin 要么没有要么与 Host 一致）。因为这是存 bearer 令牌的接口，不能只靠「在本地」就放心。

**为什么要 Host 中转而不是浏览器直连？** 浏览器直连 chat.deepseek.com 会被 CORS 挡下，
而且令牌就暴露在页面 JS 里了。Host 侧持有令牌、解决 PoW、转发 SSE，浏览器只跟本机说话。

### 工作量证明

`/api/v0/chat/completion` 要求 `x-ds-pow-response` 头，内容是一段已解出的挑战。
DeepSeekHashV1 是 **跳过了第 0 轮的 SHA3-256**（只跑 Keccak-f[1600] 的 1..23 轮），
Node 内置的 `crypto` 没有这个变体，所以 `lib/pow.js` 是手写的：

- 状态用两个 `Uint32Array(25)`（高低 32 位）而不是 BigInt——搜索要试十万次量级，
  BigInt 会慢到不可用。
- 前缀的整块先吸收一次，之后每个候选只 XOR 尾部、置换一轮。
- 每 1024 次让出事件循环并检查 `AbortSignal`，不会卡死 Host 进程。

实测约 15 µs/候选，真实难度 144000 约 **2 秒**。`test-pow.mjs` 用官方 WASM 导出的
四个哈希向量 + 三个求解用例验证：

```powershell
node test-pow.mjs   # ALL PASS
```

### 自动续写

上游并不会一次性把长回答发完：它先返回一轮，末尾用 `response/status = INCOMPLETE`
（有时外加 `auto_continue: true`）告诉调用方「还没写完」，然后必须再 POST
`/api/v0/chat/continue` 才能拿到剩下的部分。**如果不处理，用户拿到的是一条静默截断的回答**——
因为那一轮照样会以正常的 `event: finish` / `event: close` 收尾，看起来毫无异常。

两个容易踩的点，都由真实抓包（`tests/raw_stream_samples/continue-thinking-snapshot-replay-20260405`，
completion 649 KB + continue 137 KB）证实：

- **`event: close` 不代表回答结束。** 第 1 轮就是以 `close` 结尾的，但仍然要续写。
  只有 `response/status` 出现 `FINISHED` / `CONTENT_FILTER` 才算终态。
- **`ready` 事件顶层的 `response_message_id` 是续写的必需参数**，而它不携带任何正文，
  所以「不是正文帧就跳过」的写法会把这个 id 丢掉，导致续写请求发不出去。

```powershell
node test-sse.mjs        # 5 个真实抓包回放（含思考/正文分流、空格保留、控制词不外泄）
node test-continue.mjs   # 真实两轮抓包：第 1 轮必须请求续写，第 2 轮必须不请求
node test-envelope.mjs   # 短回答只存在于初始化信封里时的正文保全 + 第二轮信封快照去重
node test-history.mjs    # 真实 history_messages 抓包：用户问句取 REQUEST、正文取 RESPONSE、
                         # 思维链取 THINK（并且不许混进正文）
node test-search.mjs     # 真实「联网搜索」抓包：簿记/模式词/结果载荷/免责声明都不进正文
node test-api.mjs        # 浏览器半边 URL 拼装：query string 必须活着到 Host
node test-citations.mjs  # 渲染前的引用标记剥离（含被拆到两个 delta 的标记、真实抓包正文）
node test-load.mjs       # 3542 行客户端 bundle 完整求值一次 + 最小 ctx 调 apply：模块级笔误无处可藏
node test-render.mjs     # 真组件在加载/就绪/附件 chip 各状态下真的画一遍：渲染期异常当场现形
node test-chat-route.mjs # 路由级：客户端断开必须 abort 上游 completion，新回合必须顶掉旧回合
```

### 初始化信封里的正文不能丢

`message` 事件的第一帧是**整个 response 的初始化信封**，里面 `fragments[].content` 已经带了
回答的开头。它没有 `p` 路径，容易被当成「历史快照、跳过」——**而那正是短回答唯一的载体**：
一个只回「收到」的回合，信封之后没有任何 delta 帧，丢了信封就是空回答。

真实抓包还证实信封是**前缀**而不是重放（后续 delta 从信封结尾接着写），所以不能丢；
但**同一回合第二轮**的信封是**快照重放**（实测第 2 轮信封 50099 字符里，有 50097 字符是
第 1 轮已经发过的思考），照单全收会把思考重复一遍。`lib/deepseek.js` 里的 `newTail()`
就是为这两件事同时存在的：既是前缀就补上新增的尾巴，是重放就一个字符都不加。

```powershell
node test-envelope.mjs   # 14 条断言：短回答存活、前缀补齐、快照只取新尾巴、全长思考不重复
```

### 引用标记在渲染前剥掉

联网搜索的正文里真的带着 `[reference:0]`、`[citation:11]` 这类标记——它们**不是解析漏出来的
簿记**，而是上游正文本身（网页端把每个标记画成一个可点击的数字芯片，链到右侧来源面板）。
本插件没有来源面板，留着就只是一串噪音，所以剥掉。

剥的位置在**渲染前**（`lib/client.js` 的 `stripCitations`，被 `renderRich` 调用），不在解析时：

- 一个标记可能被拆到两个 SSE delta 里（`[refe` + `rence:0]`），逐块剥离的解析器看不见它，
  看见了也容易顺手吃掉真文本；在拼好的整串上剥就没有这个问题。
- 存下来的记录仍然忠于上游，将来若要补一个来源面板，数据还在。

```powershell
node test-citations.mjs  # 10 个用例 + 真实抓包正文 + 被拆开的标记（变异测试：改回原样即失败）
```

`test-history.mjs` 里那条「`[reference:N]` 必须留在正文里」的断言**不是矛盾**：它锁的是
**解析层**不许动正文（那一层的缺陷是漏出簿记），剥离发生在更靠后的展示层。

### 输出格式对齐 Agent 模式

网页版回答要看起来和 Agent 模式的回答一样，光用同一批主题 token 不够——**结构、变体、
数值**都得对得上。官方的 markdown 渲染器在 `@deepseek-ai/dsh-client-ui-primitives` 里，
而插件开发规范明令禁止新插件 require 任何 Harness Client 包（那是平台内部的构建产物，
随时会变），所以这里是把官方实现**读出来复刻**，不是 import。

对照出来的差异（都已按官方改正）：

| 项目 | 官方（Agent 模式） | 插件原来 | 现在 |
| --- | --- | --- | --- |
| 回答列宽 | `clamp(680px, 列宽 × .64, 920px)` | 死值 `748px` | 容器查询 `clamp(680px, 64cqw, 920px)` |
| 代码块 | CodeCard 变体（`10px 18px 8px 22px` 头部、正文同底色、两个 24×24 图标按钮） | 旧横幅变体（有色横幅、文字「复制」） | CodeCard 变体（含自动换行开关） |
| 粗体 | `font-weight: 600` | 继承 UA 的 700 | `600` |
| 列表 | `start` 属性、任务列表 checkbox、loose 列表保留 `<p>` | 有序列表一律从 1 数、`[ ]` 当字面文本、空行拆成两个列表 | 全部支持 |
| 链接 | 只有 `http(s)` 加 `target=_blank`；标签内可嵌标记 | 无条件 `_blank`；`` [`x`](u) `` 显示反引号 | 已对齐 |
| 表格 | 列数 ≥ 4 用 `md-table-wide`（悬停才出滚动条） | 一律自动换行容器 | `data-wide` 分流 + 列对齐 |
| 推理行 | 折叠成 24px 摘要行（`separator` 2px 圆点 + 省略号摘要），点击展开；流式时摘要取**最后一个已完成段落**的首行 | 纯文本块、默认全展开 | 等价的可折叠 `ThinkRow` |
| 缺失构造 | setext 标题、缩进代码块、硬换行、图片、autolink、脚注、转义 | 全部当普通文本 | 全部支持 |

两处**有意保留的偏离**，都不是疏漏：

- **软换行不插空格**。官方把 mdast 文本节点原样输出，内部的 `\n` 由 HTML 折叠成一个空格，
  所以官方在中文软换行处**会**出现一个空格。这里保留字面 `\n`（浏览器同样折叠），
  但对中文读者来说，模型几乎不会对中文硬换行，两种写法在实际输出里看不出差别；
  真按官方那样显式插空格，反而会在中文句子中间多出一个空格。
- **引用标记仍然剥掉**（上一节）。官方渲染器根本不认识 `[reference:N]`，Agent 模式的回答
  里也从不会出现它——它是网页版正文自带的，剥掉只会更接近 Agent 模式。

```powershell
node test-markdown.mjs   # 56 条断言：块级 / 行内 / 表格 / 任务列表 / 硬换行 / 代码卡与彩色分词
node test-think.mjs      # 29 条断言：折叠摘要 / 展开 / 流式播报 / 24px 行高
node test-style.mjs      # 60 个 token、98 个类：无越界 token、无裸色值、无死规则
node test-i18n.mjs       # 74 个键：中英对齐、无死键、无硬编码文案
```

改样式时有个坑值得记一笔：`test-style.mjs` 判断「代码里用到的类都有定义」时，必须用
**词法扫描**（跳过注释与正则字面量）来收集类名。`INLINE_PATTERN` 这个正则字面量内部
就含反引号和引号，按引号配对的朴素扫描会在它中间误开一个模板串，把后面几百行真实代码
全吞掉——那样十几个**正在使用**的类会被报成「未定义/死规则」。

### 拖放不白屏：整窗接管，而不是只挂在面板上

原来是往 `.dswc-root` 上挂 `onDragEnter/onDragOver/onDragLeave/onDrop`。**拖到面板以外的
任何地方**（左轨、header、侧栏列表、Agent 会话区），那些事件根本不到这个节点上，没人
`preventDefault()`，浏览器就执行它的默认动作——把被拖入的本地文件当成导航目标**打开**，
整个 DSH 界面因此变成一张白页，看起来就是「一把文件拖进去就卡死」。

修法是 `installFileDropGuard(document)`（`lib/client.js`）在**捕获阶段**接管整窗：

- `dragenter` / `dragover` / `drop` / `dragleave` 四个监听器挂在 `document` 上，
  `capture: true`，所以任何目标都不可能在它之前把事件用掉；
- 只有真的拖进了文件（`dataTransfer.types` 含 `'Files'`）才 `preventDefault()`；
  拖着文字/链接/元素时会原样放行，不劫持别的拖放；
- `drop` 认领时 `preventDefault()` + `stopImmediatePropagation()` 双保险，再交回
  `uploadDroppedFiles()` 逐个上传；`drop` 上除了 `types` 还多看一次 `dataTransfer.files`
  ——那是整件事里唯一猜错就无法挽回的时刻（猜错就是白页）。**拖入文件夹**会被识别出来并明确报错
  （`upload.folder`：「请拖入文件而不是文件夹」），而不是上传一个 0 字节的假文件；
- 投放提示改成**整窗覆盖层**（`position: fixed`），因为可投放的区域现在就是整个窗口；
  离开窗口时（`relatedTarget === null`）才收起。
- 面板卸载时把四个监听器一起摘掉（`dispose`），不会在别的界面留下幽灵监听。

```powershell
node test-panel.mjs   # 整窗守卫：轨道上的拖放也被认领、非文件拖放不受影响、
                      # 文件夹被拒、四个监听器都能摘掉；另有「同一时刻只有一处画会话列表」
```

### 代码块：像 Agent 模式那样彩色，标题锁在卡片里

网页版和 DSH 自己的 Agent 模式都给代码上色；这个插件以前是把源码原样塞进 `<pre>`，所以
同样的回答在这里是黑白、在那边是彩色。现在 `renderCode()` 用一个**手写分词器**产出
`dswc-tok-*` 片段（关键字 / 字符串 / 数字 / 注释 / 函数 / 参数 / 标点），颜色一律来自主题
自己发布的 shiki 自定义属性（`--shiki-token-keyword` 等，与 DSH 的 CodeBlock 同一套），
所以跟随亮/暗主题，也不需要引入 shiki（零依赖、无构建）。

- 语言表覆盖 `js/ts/jsx/tsx/python/java/c/cpp/cs/go/rust/ruby/php/sql/shell/yaml/json/toml/
  ini/css/scss/html/xml/markdown/matlab/r/…`，未收录的语言按通用规则上色，仍保证**逐字符原样**
  （测试里对「每个字符都还在」有断言）；
- 工具条现在是**三个** 24px 图标按钮：自动换行、复制、**下载**（`snippet.<ext>`，扩展名按语言给）；
- 标题栏是 `position: sticky; top: 0`，但 `.dswc-codeblock` 加了 `overflow: hidden`：
  DSH 自己的 `.block` 故意不裁剪（见 `CodeBlock.module.css` 的注释「overflow:hidden 会杀掉
  sticky banner」），可它粘的是**面板滚动容器**，于是长代码往下滚时标题会浮出卡片、压到周围
  UI 上——用户看到的就是「露出，不是严格置顶锁定」。这里改成裁剪：标题严格锁在卡片顶部圆角内，
  代价是不再跟随视口。

```powershell
node test-markdown.mjs   # 分词的类别、逐字符保真、注释优先于运算符、未知语言原样
```

### 切换表面：以真实面板为准，而不是自己记的那份

`surfaceStore` 以前只信自己记的 `current`。但中间那栏**不只**由这个开关控制：点插件自己的
轨道图标、或外壳把面板交给别的视图，都会在 `select()` 之外把面板换掉。这时 `current` 已经过期，
幂等守卫 `isSameSurface()` 会以为「已经在那儿了」，于是**切换被静默丢掉**——这正是「点历史对话、
点顶部切换按钮有时候没反应」。

现在 `select()` 先做一次 `syncSurface()`：读真实状态 `layout.panelInfo.activePanelId`
（`null`/别的 id 就是工作态），用事实覆盖记忆，再走「幂等 → 导航 → 记录」。附带两点：

- 导航**成功之后**才写记忆：`selectPanel` 在键还没注册时抛错，那次失败不再被记成「已在聊天」；
- header 开关在 `activePanelId` 变化时同步一次记忆，所以外壳换的面板也会被记住，刷新后回到原处。

```powershell
node test-surface.mjs   # 49 条断言：含「面板被外壳拿走 → 记忆自动纠正 → 下一次切换不再被吞」
```

---

## 已知限制

- 文件上传目前接受浏览器 File API 可提供的文件；拖放**在窗口任意位置**都能投放（不是只认聊天面板那小块），或点输入框旁的「＋」选择。拖入时会显示整窗投放提示；多文件会逐个上传，发送后 chips 继续留在 composer 里（这份对话一直带着它们）。单文件上限 100 MB，composer 最多 10 个附件。
- 附件在会话里的存活方式：DeepSeek 上游**不**把文件存进会话，后续回合如果不带 `ref_file_ids`，模型就看不到文档（实测：刚读过文件的会话里追问坐标，模型回答「当前对话中没有包含这两点的图像数据」）。网页版之所以能一直追问，是因为附件跟着对话走；这里由 Host 按会话记住 ID 并在每轮重发（`cache.files`），点 chip 的 × 则照常断掉（`detachFiles`）。
- **只能读、写你自己账号里的会话**——插件用的是你的网页版令牌，没有别的权限。
- DeepSeek 的网页接口没有公开文档，字段可能变；出错时面板会显示原文。
- 浏览器在文件已经抵达 DeepSeek 后取消等待，无法撤销上游已经创建的文件；上传路由会停止后续解析轮询。
- 一个会话只有在**通过本插件发过消息**之后才会进本地缓存；纯网页版新开的会话要
  点一次「⟳ 同步对话」。
- 缓存是「最近 200 个会话」，更早的会从本地淘汰（网页版上还在）。
- 会话列表**翻页取全**：`fetch_page` 单页上限 100（`count=101` 直接回 `ILLEGAL_COUNT`，
  500 也一样），翻页游标是 `lte_cursor.updated_at=<已见到的最旧一条的时间戳>`，
  并且必须带上 `lte_cursor.pinned`。游标是**闭区间**，边界那一条会重复返回，靠 id 去重。
  实测 4 次请求走完 329 个会话。上限 12 页（1200 个会话）只是防跑飞的保险。
- 侧栏「聊天」页签挂的是 im-connect 的未公开注册表；它升级后若改名，页签会消失，
  但面板与 聊天/工作 开关不受影响（代码里是特性探测，不是硬依赖）。
- **改 Host 半边（`lib/index.js`、`lib/deepseek.js`）后必须重启 DSH**：ESM 模块缓存
  不会因为文件变动而重载，`plugin_manager` 的禁用/启用也不会重新 import。浏览器半边
  `lib/client.js` 由 `dsh-client-hmr` 的 `/plugins/events` 自动重载，无需重启。
  因为两半的生效时机不同，`/state` 会回一个 `protocol` 版本号，客户端拿它跟自己的
  `PROTOCOL` 比对；不一致时面板会直接显示「插件后端仍是旧版本，请重启」——否则这种
  「一半是新的」状态看起来就像普通 bug（对话打开是空的、报 400），改前端永远修不好。
- 同步来的思维链默认**折叠成一行**（与 Agent 模式的推理行一致，点击展开）；展开后很长的思考
  （实测有 3000+ 字）会比较占地方。

## 测试

十八套件都在包目录里，用 DSH 自带的 Node 跑（`$DSH_HOME\dsh-runtimes\...\node.exe`），
全部离线、不需要令牌：

| 套件 | 钉住的行为 |
| --- | --- |
| `test-pow.mjs` | 4 个官方 DeepSeekHashV1 哈希向量 + 求解 + 请求头字段 |
| `test-sse.mjs` | 5 份真实抓包的 fragment 归类（思维链不混进正文） |
| `test-continue.mjs` | 真实截断样本必须续写、完成样本必须不续写 |
| `test-envelope.mjs` | 初始化信封里的正文不能丢 |
| `test-history.mjs` | 历史记录只取 REQUEST/RESPONSE，簿记不进正文 |
| `test-citations.mjs` | `stripCitations` 剥掉 `[reference:N]`（含跨 delta 的半个标记） |
| `test-search.mjs` | 联网搜索的 TOOL_SEARCH/TIP 不进正文 |
| `test-markdown.mjs` | markdown 渲染器 56 条断言（块级 / 行内 / 表格 / 任务列表 / 硬换行 / 代码卡的三个工具按钮与彩色分词：关键字、字符串、数字、注释、函数、参数，未知语言原样输出） |
| `test-think.mjs` | 推理行 29 条断言（折叠摘要取「最后一个已完成段落」、展开渲染全链、24px 行高） |
| `test-paging.mjs` | 会话列表翻页 15 条断言（走完全部历史、游标闭区间去重、`has_more` 撒谎也不会转圈） |
| `test-i18n.mjs` | 中英字典（74 键）：无缺键/死键、两侧键集相同、没有绕过字典的硬编码文案 |
| `test-style.mjs` | 样式表只用真实主题 token、类名都有定义（60 个 token、98 个类） |
| `test-api.mjs` | `api()` 保留查询串（丢掉就报「缺少 sessionId」） |
| `test-chat-route.mjs` | 宿主路由 + 上传不被已读完的 request.signal 误取消 + 停止按钮中止上游 + 解析未完成 409 + 会话记住附件（追问仍带 ID、`detachFiles` 断得掉）+ 协议版本一致 |
| `test-panel.mjs` | 「同一时刻只有一处画会话列表」+ 整窗拖放守卫（轨道上的拖放也认领、非文件拖放不受影响、文件夹被拒、监听器可摘） |
| `test-surface.mjs` | 聊天/工作表面 49 条断言（`surfaceStore` 从真实 bundle 里提升出来跑）：默认面、可选面导航后重载回到原面、幂等切换、未落地的切换不记入记忆、以真实面板 `panelInfo.activePanelId` 为准对齐（侧栏/外壳把面板拿走也不会让开关「没反应」）、每面各自的位置记忆、位置失效回退新对话、列表未同步时推迟判断 |
| `test-load.mjs` | 3542 行客户端 bundle 用真实 `window.__ModuleLoader__.load` 握手完整求值一次，再对最小 `ctx` 调一次 `apply()`：`sidebar.panellist` / 键控 `main` / header 开关都注册到位，`shortcuts` 按需注入 |
| `test-render.mjs` | 真组件真的画一遍 15 条断言（加载中 / 就绪 / 已解析附件 chip / 解析失败 chip / 带 markdown+思维链+引用的完整对话 / 令牌设置卡片 / 两个侧栏座位），另加静态扫描：厂级作用域的辅助函数调用 `t()` 却没绑定它就必须失败。装载测试只证明文件能求值，画不出来照样是整块白面板 |

`test-i18n.mjs` 值得单独说一句：`ctx.locale.bind(NS)` 在缺键时**返回键名本身而不抛错**，
所以少一个键的后果是界面上出现 `think.title` 这样的字样，而不是一条报错——另外两套测试
都看不见它（`test-style.mjs` 只管 CSS 类名，`test-think.mjs` 只管行行为）。它同时抓
「硬编码兜底文案」：`describe(error) || '同步失败'` 这种写法在英文界面下会漏出中文，
而这正是这套测试第一次跑时就抓到的真实缺陷（连同 `'host unreachable'`、`'读取对话失败'`、
`'生成失败'`、`'保存失败'` 共五处）。

## 卸载

```powershell
# 在 DSH 里：
#   plugin_manager action=remove_bundle target=dsh-deepseek-web-chat
```

再手动删掉 `%USERPROFILE%\.dsh\dsh-deepseek-web-chat\`（里面是令牌和缓存）。
