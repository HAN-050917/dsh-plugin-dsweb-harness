/**
 * Browser half of the DeepSeek Web Chat plugin.
 *
 * Hand-written in the lazy-CJS bundle protocol (`window.__ModuleLoader__.load`
 * with a factory returning cordis-plugin exports): no build step, and the only
 * external is `react` from the shell's frozen module table — no imports from
 * any `@deepseek-ai/dsh-client-*` package.
 *
 * What it contributes:
 *  - a `sidebar.panellist` glyph, which makes the sidebar own a 聊天 panel icon;
 *  - the `main` occupant for that panel id, i.e. the chat surface itself;
 *  - a 聊天 / 工作 switch in the free `conversation.header.leading` seat;
 *  - a 聊天 page inside the sidebar's 任务/频道 row, so the web-chat history is
 *    separated from the agent's workspace sessions (feature-detected: the row
 *    is injected by a third-party wrapper, not by DSH).
 *
 * The reserved `conversation` panel IS the agent (工作) mode, so the switch is
 * simply `ctx.layout.selectPanel('deepseek-web-chat')` ↔ `selectPanel(null)`.
 *
 * @module dsh-deepseek-web-chat/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-deepseek-web-chat',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'deepseek-web-chat';
    /** Panel id: the `sidebar.panellist` list id and the `main` key must match. */
    const PANEL_ID = 'deepseek-web-chat';
    /** Host route prefix (see lib/index.js). */
    const API = '/dsh-deepseek-web-chat';
    /**
     * Wire version this file expects from the host half.
     *
     * Only this half is hot-reloaded; `lib/index.js` is re-imported when DSH
     * restarts. A mismatch therefore means the host is running older code, and
     * the UI says so instead of presenting the old behaviour as a bug. Must
     * equal `PROTOCOL` in lib/index.js.
     *
     * 4: `/sessions` walks the whole history with `lte_cursor.updated_at`
     *    instead of stopping at the first 100-row page.
     * 5: `/upload` + `/files` + attachment-aware `/chat`. An old host has no
     *    file routes; a turn sent with `refFileIds` would be answered without
     *    the file, so the banner is mandatory rather than cosmetic.
     * 6: `/upload` answers with the file's real parse `status` instead of
     *    blocking on the parse, and `/chat` refuses a still-parsing attachment
     *    with 409. Against an old host the panel would poll for a status it
     *    never gets and refuse every send, so the mismatch must be visible.
     * 7: the host remembers a session's files, so questions asked after the
     *    first turn still read the document. An old host drops the file the
     *    moment the composer stops re-sending ids.
     */
    const PROTOCOL = 7;
    /** Composer attachment cap. Upstream allows 50; a chat composer wants fewer. */
    const MAX_ATTACHMENTS = 10;
    /**
     * Parse states a file never leaves. PENDING/PARSING (and the odd
     * `_CUSTOM_FROM_SHARE`) are the only unfinished ones, and a turn that
     * references one comes back as biz_code 9 with NO stream frames at all —
     * the empty answer this panel used to show for a Word attachment.
     */
    const FILE_DONE = new Set([
      'SUCCESS',
      'FAILED',
      'CONTENT_FILTER',
      'CONTENT_TOO_LONG',
      'CANCELLED',
      'CONTENT_EMPTY',
      '_CUSTOM_SYSTEM_ERROR_FAIL',
      '_CUSTOM_FROM_SHARE',
    ]);
    /** Upstream omits `status` on some records; that means the file is fine. */
    const fileSettled = (status) => !status || FILE_DONE.has(String(status).toUpperCase());
    const fileUsable = (status) => !status || String(status).toUpperCase() === 'SUCCESS';
    /** Poll budget for one attachment's parse (~2.5 min at POLL_MS). */
    const ATTACHMENT_POLLS = 100;
    const ATTACHMENT_POLL_MS = 1500;

    /* ================================================================ *
     * Dictionaries
     * ================================================================ */

    const zh = {
      'panel.title': '聊天',
      'panel.subtitle': 'DeepSeek 网页版',
      'panel.crashed': '聊天面板渲染出错（已拦下，未影响其他界面）',
      'panel.reset': '重画面板',
      'mode.chat': '聊天',
      'mode.work': '工作',
      'mode.chat.hint': '和 DeepSeek 网页版对话',
      'mode.work.hint': '回到 Agent 工作模式',
      'mode.blocked': '界面还没准备好',
      'action.refresh': '同步对话',
      'action.new': '新对话',
      'action.stop': '停止',
      'action.send': '发送',
      'action.clear': '清除令牌',
      'action.save': '保存并验证',
      'action.reload': '重新加载',
      'search.placeholder': '搜索对话',
      'tab.label': '聊天',
      'tab.needToken': '还没有配置令牌。打开聊天面板连接 DeepSeek 账号后，这里的对话记录就会出现。',
      'tab.openPanel': '打开聊天面板',
      'tab.sync': '同步对话',
      'composer.placeholder': '给 DeepSeek 发消息…（Enter 发送，Shift+Enter 换行）',
      'option.thinking': '深度思考',
      'option.search': '联网搜索',
      'model.label': '模型',
      'state.loading': '加载中…',
      'state.empty.sessions': '还没有同步到对话，点“同步对话”。',
      'state.empty.messages': '选择左侧的一个对话，或者开始一段新的对话。',
      'state.empty.inSidebar': '在左侧「聊天」页里选一个对话，或者开始一段新的对话。',
      'state.noMatch': '没有匹配的对话。',
      'state.thinking': '正在深度思考…',
      'state.solving': '正在准备请求…',
      'state.continuing': '回答过长，正在续写…',
      'state.filtered': '这条回答被 DeepSeek 的安全策略截断了，内容可能不完整。',
      'setup.title': '连接你的 DeepSeek 网页版账号',
      'setup.intro':
        'DSH 需要一个 chat.deepseek.com 的登录令牌，才能读取你的网页版对话记录并在这里继续聊天。令牌只保存在本机，不会上传到任何第三方。',
      'setup.step1': '在浏览器里打开并登录 chat.deepseek.com。',
      'setup.step2': '按 F12 打开开发者工具，切到 Console，粘贴下面这行并回车：',
      'setup.step3': '复制打印出来的令牌，粘贴到下面的输入框。',
      'setup.snippet': "JSON.parse(localStorage.getItem('userToken')).value",
      'setup.placeholder': '粘贴令牌（也接受完整的 Authorization: Bearer … 或整段 userToken JSON）',
      'setup.privacy': '令牌写入本机文件（仅当前用户可读），DSH 只在你发消息时代它向 chat.deepseek.com 发起请求。',
      'error.network': '网络请求失败，请检查网络后重试。',
      'error.send': '发送失败',
      'error.generate': '生成失败',
      'error.save': '保存失败',
      'error.sync': '同步对话失败',
      'error.messages': '读取这段对话失败',
      'error.token': '令牌无效或已过期，请重新获取。',
      'error.generic': '出错了',
      'error.stale': '插件后端仍是旧版本，请重启 DeepSeek Harness 后生效。',
      'upload.attach': '添加附件',
      'upload.remove': '移除附件',
      'upload.failed': '上传失败',
      'upload.limit': '附件数量已达上限',
      'upload.wait': '附件还在上传，请稍候',
      'upload.uploading': '上传中',
      'upload.parsing': '解析中…',
      'upload.notReady': '附件还在解析，请等解析完成后再发送',
      'upload.rejected': '这个附件没有解析成功，请移除后再发送',
      'upload.parseFailed': '解析失败',
      'upload.stuck': '这个附件解析太久了，请移除后重试',
      'upload.drop': '将文件拖到这里以上传',
      'upload.parsed': '已解析',
      'upload.kept': '这份对话会一直带着这些文件：继续追问不必重新上传，点 × 可以断开',
      'upload.folder': '请拖入文件，文件夹暂不支持',
      'code.copy': '复制',
      'code.copied': '已复制',
      'code.wrap': '自动换行',
      'code.unwrap': '关闭自动换行',
      'code.label': '代码',
      'code.download': '下载代码',
      'think.title': '思考',
      'think.running': '运行中',
    };

    const en = {
      'panel.title': 'Chat',
      'panel.subtitle': 'DeepSeek Web',
      'panel.crashed': 'The chat panel failed to render (contained — the rest of the app is fine)',
      'panel.reset': 'Redraw the panel',
      'mode.chat': 'Chat',
      'mode.work': 'Work',
      'mode.chat.hint': 'Talk to DeepSeek Web',
      'mode.work.hint': 'Back to Agent mode',
      'mode.blocked': 'The layout is not ready yet',
      'action.refresh': 'Sync chats',
      'action.new': 'New chat',
      'action.stop': 'Stop',
      'action.send': 'Send',
      'action.clear': 'Clear token',
      'action.save': 'Save and verify',
      'action.reload': 'Reload',
      'search.placeholder': 'Search chats',
      'tab.label': 'Chat',
      'tab.needToken': 'No token yet. Open the chat panel and connect a DeepSeek account — the conversation list shows up here.',
      'tab.openPanel': 'Open chat panel',
      'tab.sync': 'Sync chats',
      'composer.placeholder': 'Message DeepSeek… (Enter to send, Shift+Enter for a new line)',
      'option.thinking': 'Deep think',
      'option.search': 'Web search',
      'model.label': 'Model',
      'state.loading': 'Loading…',
      'state.empty.sessions': 'No chats synced yet — press “Sync chats”.',
      'state.empty.messages': 'Pick a chat on the left, or start a new one.',
      'state.empty.inSidebar': 'Pick a chat under the sidebar’s Chat tab, or start a new one.',
      'state.noMatch': 'No chat matches that search.',
      'state.thinking': 'Thinking…',
      'state.solving': 'Preparing the request…',
      'state.continuing': 'Long answer — writing the rest…',
      'state.filtered': 'DeepSeek’s safety filter cut this answer short, so it may be incomplete.',
      'setup.title': 'Connect your DeepSeek Web account',
      'setup.intro':
        'DSH needs a chat.deepseek.com session token to read your web chat history and continue those conversations here. The token stays on this machine.',
      'setup.step1': 'Open chat.deepseek.com in a browser and sign in.',
      'setup.step2': 'Press F12, open the Console tab, paste the line below and hit Enter:',
      'setup.step3': 'Copy the printed token and paste it into the field below.',
      'setup.snippet': "JSON.parse(localStorage.getItem('userToken')).value",
      'setup.placeholder': 'Paste the token (a full “Authorization: Bearer …” or userToken JSON also works)',
      'setup.privacy':
        'The token is stored in a local file readable only by your user account, and is sent to chat.deepseek.com only when you send a message.',
      'error.network': 'Network request failed — check your connection and try again.',
      'error.send': 'Could not send that message',
      'error.generate': 'Generation failed',
      'error.save': 'Could not save the token',
      'error.sync': 'Could not sync your chats',
      'error.messages': 'Could not load that chat',
      'error.token': 'The token is invalid or expired — please get a fresh one.',
      'error.generic': 'Something went wrong',
      'error.stale': 'The plugin backend is still an older build — restart DeepSeek Harness to apply it.',
      'upload.attach': 'Add attachments',
      'upload.remove': 'Remove attachment',
      'upload.failed': 'Upload failed',
      'upload.limit': 'Attachment limit reached',
      'upload.wait': 'Attachments are still uploading — hold on',
      'upload.uploading': 'Uploading',
      'upload.parsing': 'Parsing…',
      'upload.notReady': 'Attachments are still parsing — wait for them before sending',
      'upload.rejected': 'This attachment could not be parsed — remove it before sending',
      'upload.parseFailed': 'Parsing failed',
      'upload.stuck': 'This attachment took too long to parse — remove it and try again',
      'upload.drop': 'Drop files here to upload',
      'upload.parsed': 'Parsed',
      'upload.kept': 'This chat keeps these files: later questions use them without re-uploading, and × drops them',
      'upload.folder': 'Drop files, not folders',
      'code.copy': 'Copy',
      'code.copied': 'Copied',
      'code.wrap': 'Wrap lines',
      'code.unwrap': 'No wrap',
      'code.label': 'Code',
      'code.download': 'Download code',
      'think.title': 'Think',
      'think.running': 'Running',
    };

    /* ================================================================ *
     * Styles — theme tokens only, so light and dark both work.
     * ================================================================ */

    const CSS = `
.dswc-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit);
}
.dswc-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  min-height: 44px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dswc-brand { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dswc-brand-title { font-size: 14px; font-weight: 600; white-space: nowrap; }
.dswc-brand-sub {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dswc-spacer { flex: 1 1 auto; }
/* SegmentedControl.module.css: a 2px-gap grid on --dsw-alias-interactive-bg-hover
   with a raised --dsw-alias-bg-layer-1 thumb, tabs 28px tall at 13px/500. */
.dswc-seg {
  position: relative;
  display: inline-grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 2px;
  padding: 4px;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dswc-seg-btn {
  appearance: none;
  border: 0;
  margin: 0;
  height: 28px;
  padding: 0 16px;
  border-radius: var(--dsw-radius-sm, 8px);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
}
.dswc-seg-btn:hover { color: var(--dsw-alias-label-primary); }
.dswc-seg-btn[data-on="true"] {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-soft);
}
/* Button.module.css: 28px tall, --dsw-radius-sm, ghost by default and
   --dsw-alias-button-primary-fill for the one primary action. */
.dswc-btn {
  appearance: none;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 0 10px;
  cursor: pointer;
  white-space: nowrap;
}
.dswc-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dswc-btn:disabled { opacity: .5; cursor: default; }
/* Render-error card: the panel failed, but the reader still gets a sentence
   and a button instead of an unexplained blank region. */
.dswc-crash {
  margin: 48px auto 0;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 20px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-panel, 16px);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-soft);
}
.dswc-crash-title { color: var(--dsw-alias-state-error-primary); font-size: 13px; line-height: 20px; }
.dswc-crash-detail {
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-markdown-code);
  font-size: 12px;
  line-height: 18px;
  word-break: break-all;
}
.dswc-btn[data-variant="primary"] {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-foreground);
}
.dswc-btn[data-variant="primary"]:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));
}
.dswc-body { display: flex; flex: 1 1 auto; min-height: 0; }
.dswc-side {
  width: 240px;
  flex: 0 0 240px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--dsw-alias-border-l1);
}
.dswc-side-search { padding: 8px 10px; }
.dswc-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  padding: 6px 9px;
}
.dswc-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dswc-list { flex: 1 1 auto; overflow: auto; padding: 4px 6px 10px; }
.dswc-item {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  padding: 7px 9px;
  margin-bottom: 2px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dswc-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dswc-item[data-on="true"] { background: var(--dsw-alias-interactive-bg-hover-solid); font-weight: 600; }
.dswc-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
.dswc-root[data-dragging="true"] { position: relative; }
.dswc-drop-overlay {
  /* Document-wide zone: the guard claims file drags anywhere in the window, so
     the affordance has to cover the window too — not just the panel box. */
  position: fixed;
  z-index: 60;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  font-weight: 500;
  pointer-events: none;
}
/* The shipped transcript scrolls with a 16px top pad and a 32px side clearance
   (16px plus --dsh-composer-side-clearance, which is unset outside the composer
   subtree), and it is the container its reading column is measured against.
   This panel's main seat is a SIBLING of the conversation's seat, so
   --dsh-chat-user-width and --dsh-chat-content-width are never in scope here —
   reading them silently pinned every answer to the 748px fallback while agent
   mode resolves clamp(680px, 64% of the column, 920px). A container query
   reproduces that formula locally instead. */
.dswc-scroll {
  flex: 1 1 auto;
  overflow: auto;
  padding: 16px 32px;
  container-type: inline-size;
}
.dswc-thread {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: clamp(680px, 64cqw, 920px);
  margin: 0 auto;
}
/* Chat bubbles, matched to the shipped Chat surface: the user's turn is a
   right-aligned row inside a stack capped at 70.2% of the reading column,
   drawn on --dsw-specific-bubble with --dsw-radius-xl; an answer is NOT in a
   bubble at all — it is a left-aligned block of prose on the page background.
   Giving the assistant a card was the thing that read as "another app".
   Turns ride the shipped flow rhythm: 6px after a question, 16px after an
   answer (ChatView's --dsh-chat-flow-gap plus its response-segment bump). */
.dswc-turn { display: flex; }
.dswc-turn + .dswc-turn { margin-top: 16px; }
.dswc-turn[data-role="user"] + .dswc-turn { margin-top: 6px; }
.dswc-turn[data-role="user"] { flex-direction: column; align-items: flex-end; }
.dswc-turn[data-role="assistant"] { flex-direction: column; align-items: stretch; }
.dswc-turn[data-role="user"] .dswc-bubble { max-width: min(calc(clamp(680px, 64cqw, 920px) * .702), 82%); }
.dswc-bubble { min-width: 0; }
.dswc-turn[data-role="user"] .dswc-bubble {
  background: var(--dsw-specific-bubble);
  border-radius: var(--dsw-radius-xl, 20px);
  color: var(--dsw-alias-label-primary);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
  white-space: pre-wrap;
  word-break: break-word;
  padding: 10px 16px;
}
/* The user's own text is prose, not a markdown document: an answer may hold a
   real code block, but a question holds at most a filename. */
.dswc-turn[data-role="user"] .dswc-p { margin: 0; }
/* The answer side is a plain block, not a card: the shipped Chat surface puts
   an answer straight on the page background and only the question in a bubble.
   It is also the shipped answer column — a 16px-gapped flex column — so a
   reasoning row and the prose that follows it are spaced by the same rule the
   harness uses, not by an ad-hoc margin on the reasoning row. */
.dswc-answer { min-width: 0; max-width: 100%; flex: 1 1 auto; display: flex; flex-direction: column; gap: 16px; }
.dswc-text {
  min-width: 0;
  overflow-wrap: anywhere;
  font: var(--dsw-font-markdown-base, 14px/24px var(--dsw-font-family));
  color: var(--dsw-alias-label-primary);
}
.dswc-text > *:first-child, .dswc-text p:first-child { margin-top: 0 !important; }
.dswc-text > *:last-child, .dswc-text p:last-child { margin-bottom: 0 !important; }
/* The shipped markdown sheet sets bold runs to weight 600; without that rule
   every bold run in an answer falls back to the user agent's 700 and reads
   heavier than agent mode. */
.dswc-text strong { font-weight: 600; }
.dswc-text :where(h1, h2, h3, h4, h5, h6) strong { font-weight: inherit; }
.dswc-text :where(h1, h2, h3, h4, h5, h6) code { font: inherit; font-family: var(--ds-font-family-code); }
/* A heading immediately above a list is tightened, in both directions. */
.dswc-text :where(h4, h5, h6) + :where(ul, ol) { margin-top: 8px; }
.dswc-text :where(h4, h5, h6):has(+ :where(ul, ol)) { margin-bottom: 8px; }
.dswc-p { margin: 16px 0; }
.dswc-h1, .dswc-h2, .dswc-h3 { margin: 32px 0 16px; color: var(--dsw-alias-label-primary); }
.dswc-h1 { font: var(--dsw-font-markdown-h1, 700 21px/30px var(--dsw-font-family)); }
.dswc-h2 { font: var(--dsw-font-markdown-h2, 700 19px/28px var(--dsw-font-family)); }
.dswc-h3 { font: var(--dsw-font-markdown-h3, 700 18px/26px var(--dsw-font-family)); }
.dswc-h4 { font: var(--dsw-font-markdown-h4, 600 14px/24px var(--dsw-font-family)); margin: 16px 0; }
.dswc-h5, .dswc-h6 { font: var(--dsw-font-markdown-base-strong, 600 14px/24px var(--dsw-font-family)); margin: 16px 0; }
.dswc-md-list { margin: 16px 0; padding-left: 18px; }
.dswc-md-list li:not(:first-child) { margin-top: 6px; }
.dswc-md-list li::marker { line-height: 24px; color: var(--dsw-alias-label-secondary); }
.dswc-md-list li > .dswc-md-list { margin-top: 4px; }
.dswc-md-list li > *:first-child { margin-top: 0; }
.dswc-md-list li > *:last-child:not(.dswc-codeblock) { margin-bottom: 0; }
/* A nested ordered list is numbered inside its own line, the shipped way, so a
   nested item number does not hang outside the item it belongs to. */
.dswc-md-list .dswc-md-list ol { list-style-position: inside; padding-left: 0; }
.dswc-md-list .dswc-md-list ol li .dswc-p { display: inline; }
/* A loose item keeps its paragraph, and that paragraph keeps an 8px rhythm. */
.dswc-md-list li > .dswc-p { margin: 8px 0; }
/* A task list shows its checkbox where the bullet would be. */
.dswc-md-list.contains-task-list { list-style: none; padding-left: 4px; }
.dswc-text input[type="checkbox"] { margin: 0 8px 0 0; accent-color: var(--dsw-alias-label-secondary); }
.dswc-hr { display: block; border: none; height: .5px; margin: 32px 0; background: var(--dsw-alias-border-l2); }
.dswc-quote {
  margin: 16px 0 0;
  border-left: 2px solid var(--dsw-alias-label-caption);
  padding-left: 14px;
}
/* Links carry the shipped chrome: weight 500 on --dsw-alias-link, a
   transparent border that becomes a focus ring, and an underline only on
   hover/focus. The border-and-negative-margin pair is what keeps the ring from
   shifting the line it sits on. */
.dswc-link {
  color: var(--dsw-alias-link);
  font-weight: 500;
  position: relative;
  text-decoration: none;
  border-left: 3px solid rgb(255 255 255 / 0);
  border-right: 3px solid rgb(255 255 255 / 0);
  border-top: 2px solid rgb(255 255 255 / 0);
  border-bottom: 2px solid rgb(255 255 255 / 0);
  margin-left: -3px;
  margin-right: -3px;
}
.dswc-link:hover, .dswc-link:focus { outline: none; text-decoration: underline dotted var(--dsw-alias-link); text-underline-offset: 3px; }
.dswc-link:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.dswc-table-wrap { max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; margin: 16px 0; }
/* A four-column-or-wider table is wider than the reading column: the shipped
   sheet hides the overflow until the pointer is over it, then offers a
   scrollbar, so a wide table does not push the whole answer sideways. */
.dswc-table-wrap[data-wide="true"] { overflow-x: hidden; padding-bottom: var(--dsh-scrollbar-width, 5px); }
.dswc-table-wrap[data-wide="true"]:hover, .dswc-table-wrap[data-wide="true"]:focus-visible { overflow-x: scroll; padding-bottom: 0; }
.dswc-table { border-collapse: collapse; width: max-content; max-width: max-content; }
.dswc-table-wrap[data-wide="false"] .dswc-table { width: 100%; max-width: none; }
.dswc-table th {
  text-align: start;
  padding: 10px 16px;
  border-bottom: .5px solid var(--dsw-alias-border-l3);
  border-top: none;
  font: var(--dsw-font-markdown-table-head, 500 13px/22px var(--dsw-font-family));
  max-width: min(30vw, 320px);
  min-width: 100px;
}
.dswc-table td {
  padding: 10px 16px;
  border-bottom: .5px solid var(--dsw-alias-border-l2);
  font: var(--dsw-font-markdown-table, 13px/22px var(--dsw-font-family));
  max-width: min(30vw, 320px);
  min-width: 100px;
}
.dswc-table th:first-child, .dswc-table td:first-child { padding-left: 0; }
.dswc-table td:last-child { padding-right: 0; }
.dswc-table code { font-size: 11px; }
/* An image the answer embeds, drawn the shipped way: block-level, contained,
   on the page fill so a transparent PNG does not sit on the code-block tint. */
.dswc-image {
  display: block;
  width: auto;
  max-width: 100%;
  height: auto;
  margin: 0;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base);
  object-fit: contain;
}
.dswc-image-alt { color: var(--dsw-alias-label-tertiary); font-style: italic; }
.dswc-inline-code {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  font: var(--dsw-font-markdown-code, 12px/19px var(--ds-font-family-code));
  font-family: var(--ds-font-family-code);
  font-size: .875em !important;
  background-color: var(--dsw-alias-markdown-inline-code);
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
  padding: 0 5px;
}
/* The shipped answer surface does NOT use CodeBlock.module.css's tinted banner
   variant — the chat surface hands CodeBlock a toolbarLabels object, which
   switches it to the CodeCard variant: a header on the SAME fill as the body, a
   tertiary language label, two 24x24 icon buttons (wrap, copy), and a
   6px 22px 20px body that wraps by default and breaks words only when it has
   to. The banner variant (9px 14px tinted header, 16px body, break-all) is what
   this plugin drew before, and it is why a code block read as a different app. */
.dswc-codeblock {
  position: relative;
  /* The card is its own formatting context. Without this the header — which is
     sticky so a long block keeps its label and controls in view — sticks to the
     PANEL's scrollport instead, floats out of the card and lands on top of the
     surrounding UI. Overflow hidden confines it to the card it belongs to and
     clips the corners at the same time. */
  overflow: hidden;
  margin: 16px 0;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-markdown-code-block);
  border-radius: var(--dsw-radius-lg, 16px);
  font: var(--dsw-font-markdown-code-block, 11px/19px var(--ds-font-family-code));
}
.dswc-codeblock:not(:last-child) { margin-bottom: 11px; }
.dswc-codeblock-banner {
  position: sticky;
  top: 0;
  z-index: 6;
  background: var(--dsw-alias-markdown-code-block);
  border-top-left-radius: inherit;
  border-top-right-radius: inherit;
}
.dswc-codeblock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px 8px 22px;
  background: var(--dsw-alias-markdown-code-block);
  border-top-left-radius: inherit;
  border-top-right-radius: inherit;
  color: var(--dsw-alias-label-secondary);
  font: 11px/18px var(--dsw-font-family);
}
.dswc-codeblock-heading { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.dswc-codeblock-lang {
  color: var(--dsw-alias-label-tertiary);
  flex: none;
  font-family: var(--ds-font-family-code);
}
.dswc-codeblock-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.dswc-codeblock-action {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
}
.dswc-codeblock-action:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dswc-codeblock-action:focus-visible { outline: 1px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dswc-codeblock-action svg { display: block; }
.dswc-pre {
  margin: 0 !important;
  padding: 6px 22px 20px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: normal;
  overflow-wrap: anywhere;
  font: inherit;
  background: var(--dsw-alias-markdown-code-block);
  border-bottom-left-radius: var(--dsw-radius-lg, 16px);
  border-bottom-right-radius: var(--dsw-radius-lg, 16px);
}
/* The wrap toggle: when it is off, lines scroll instead of wrapping. */
.dswc-codeblock[data-wrap="false"] .dswc-pre { white-space: pre; overflow-wrap: normal; }
.dswc-code { font: inherit; background: none; padding: 0; }
/* Token colours. The theme ships the same shiki palette the web client colours
   code with — light on :root, the dark set under a body-level dark attribute —
   so reusing those custom properties gives the web client's colours in both
   themes without this plugin owning a palette (or a dark-mode rule of its own). */
.dswc-tok-kw { color: var(--shiki-token-keyword); }
.dswc-tok-str { color: var(--shiki-token-string); }
.dswc-tok-num { color: var(--shiki-token-constant); }
.dswc-tok-com { color: var(--shiki-token-comment); }
.dswc-tok-fn { color: var(--shiki-token-function); }
.dswc-tok-pun { color: var(--shiki-token-punctuation); }
.dswc-tok-par { color: var(--shiki-token-parameter); }
/* An empty fence draws a bare block, not a card around nothing: the shipped
   renderer skips the header entirely when there is no code to label. */
.dswc-plain-pre {
  margin: 16px 0;
  font: var(--dsw-font-markdown-code-block, 11px/19px var(--ds-font-family-code));
  font-family: var(--ds-font-family-code);
  overflow: auto;
}
/* Footnote definitions close the answer in their own section, the way the
   shipped renderer emits a data-footnotes section. */
.dswc-footnotes {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-markdown-base, 14px/24px var(--dsw-font-family));
  font-size: 13px;
}
.dswc-footnotes ol { margin: 0; padding-left: 18px; }
/* The reasoning disclosure, drawn like the shipped ReasoningRow: one 24px line
   — think glyph, the word 思考, a 2px dot, then the first line of the current
   paragraph — that expands to the whole chain. Collapsed is the default, which
   is the point: a synced chain can run to thousands of characters and would
   otherwise push the answer off-screen. Nothing is sliced away, so opening the
   row loses no text. Spacing above comes from the answer column's 16px gap, so
   the row carries no margin of its own — the shipped row does not either. */
.dswc-think { display: flex; flex-direction: column; }
.dswc-think:not([data-expanded]) {
  contain: size layout;
  height: calc(24px + var(--dsh-content-font-delta, 0px));
}
.dswc-think-disclosure { display: flex; flex-direction: column; width: 100%; min-width: 0; }
/* A long chain scrolls under its own header rather than pushing the row away. */
.dswc-think[data-expanded] .dswc-think-disclosure[data-open] .dswc-think-row {
  z-index: 1;
  background: var(--dsw-alias-bg-base);
  position: sticky;
  top: 0;
}
.dswc-think-row {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  height: calc(24px + var(--dsh-content-font-delta, 0px));
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition: color .1s ease;
}
.dswc-think-row:hover { color: var(--dsw-alias-label-secondary); }
.dswc-think-row:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.dswc-think-leading {
  position: relative;
  flex: none;
  width: calc(16px + var(--dsh-content-font-delta, 0px));
  height: calc(16px + var(--dsh-content-font-delta, 0px));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 6px;
}
.dswc-think-leading svg { width: calc(14px + var(--dsh-content-font-delta, 0px)); height: calc(14px + var(--dsh-content-font-delta, 0px)); }
/* Hover swaps the glyph for the chevron that says the row opens. */
.dswc-think-icon-idle { display: inline-flex; opacity: 1; transition: opacity .1s ease; }
.dswc-think-chevron-hover { position: absolute; inset: 0; margin: auto; opacity: 0; transition: opacity .1s ease; }
.dswc-think-row:hover .dswc-think-icon-idle { opacity: 0; }
.dswc-think-row:hover .dswc-think-chevron-hover { opacity: 1; }
.dswc-think-title {
  flex: none;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: inherit;
}
.dswc-think-separator {
  background: var(--dsw-alias-label-caption);
  border-radius: 1px;
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 8px;
}
.dswc-think-summary {
  min-width: 0;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap;
  flex: auto;
  overflow: hidden;
}
.dswc-think-summary-text { text-overflow: ellipsis; display: block; overflow: hidden; }
.dswc-think-body { padding: 4px 0 4px calc(22px + var(--dsh-content-font-delta, 0px)); min-width: 0; }
/* The opened chain is secondary text, the same 'compact' variant the shipped
   row hands its MarkdownText. */
.dswc-think-body .dswc-text {
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.dswc-visually-hidden {
  clip: rect(0 0 0 0);
  white-space: nowrap;
  width: 1px;
  height: 1px;
  position: absolute;
  overflow: hidden;
}
.dswc-note {
  margin: 8px 0;
  padding: 8px 11px;
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.6;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.dswc-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dswc-note[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dswc-note[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.dswc-caret {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--dsw-alias-brand-primary);
  animation: dswc-blink 1.05s steps(2, start) infinite;
}
@keyframes dswc-blink { to { visibility: hidden; } }
.dswc-composer {
  flex: 0 0 auto;
  padding: 8px 24px 18px;
}
.dswc-composer-inner { max-width: calc(var(--dsh-chat-user-width, 748px) + 32px); margin: 0 auto; }
/* The shipped composer is a --dsw-radius-panel card on --dsw-specific-input-major
   with --dsw-elevation-soft, sitting on a 36px fade of the page background so
   text scrolls under it instead of touching it. */
.dswc-composer { position: relative; }
.dswc-composer::before {
  content: "";
  position: absolute;
  inset: -36px 0 auto 0;
  height: 36px;
  pointer-events: none;
  background: linear-gradient(180deg, transparent 0, var(--dsw-alias-bg-base, transparent) 100%);
}
.dswc-box {
  position: relative;
  border: 0;
  border-radius: var(--dsw-radius-panel, 28px);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, transparent));
  box-shadow: var(--dsw-elevation-soft);
  padding: 8px 8px 6px;
}
.dswc-box:focus-within { box-shadow: var(--dsw-elevation-panel); }
.dswc-textarea {
  width: 100%;
  box-sizing: border-box;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  caret-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  font-family: var(--dsw-font-family);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  max-height: 220px;
  padding: 4px 6px 0 6px;
}
.dswc-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 4px;
}
/* Attachment chips: one row above the composer box, wrapping freely. */
.dswc-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
}
.dswc-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  height: 28px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dswc-chip[data-status="uploading"] { color: var(--dsw-alias-label-tertiary); }
.dswc-chip[data-status="error"] { color: var(--dsw-alias-state-error-primary); }
.dswc-chip-name {
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dswc-chip-size { color: var(--dsw-alias-label-tertiary); flex: none; }
.dswc-chip-x {
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 14px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
}
.dswc-chip-x:hover { color: var(--dsw-alias-label-primary); }
.dswc-file-input { display: none; }
/* Pill.module.css: 24px, fully rounded, --dsw-alias-label-secondary on
   --dsw-alias-bg-layer-2; active flips to the ghost-active fill + inset hairline. */
.dswc-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  border: none;
  border-radius: 999px;
  padding: 0 8px;
  cursor: pointer;
  user-select: none;
  background: var(--dsw-alias-bg-layer-2);
  font-family: inherit;
}
.dswc-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dswc-toggle[data-on="true"] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-button-ghost-active-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border);
}
.dswc-select {
  appearance: none;
  height: 24px;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 0 8px;
  cursor: pointer;
}
.dswc-setup { max-width: 620px; margin: 40px auto; padding: 0 24px; }
.dswc-setup h2 { font-size: 16px; margin: 0 0 10px; }
.dswc-setup p { font-size: 13px; line-height: 1.75; color: var(--dsw-alias-label-secondary); margin: 0 0 10px; }
.dswc-setup ol { margin: 0 0 14px; padding-left: 20px; }
.dswc-setup li { font-size: 13px; line-height: 1.9; }
.dswc-setup textarea {
  width: 100%;
  box-sizing: border-box;
  min-height: 74px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  padding: 9px 11px;
  resize: vertical;
}
.dswc-setup-row { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
.dswc-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dswc-pill[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.dswc-pill[data-tone="error"] { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.dswc-snippet {
  display: block;
  margin: 4px 0 12px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: .5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-markdown-inline-code);
  font: var(--dsw-font-markdown-code, 12px/19px var(--ds-font-family-code));
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  user-select: all;
  overflow-x: auto;
  white-space: pre;
}
.dswc-center {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  padding: 24px;
  text-align: center;
}
.dswc-mode-switch { display: inline-flex; align-items: center; }
/* The 聊天 tab that lives inside the sidebar's 任务/频道 row. The row itself
   belongs to whoever wrapped the workspace browser, so these element styles
   stay minimal and only theme the content we inject underneath it. */
.dswc-tab { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.dswc-tab-search { flex: none; padding: 8px 10px; }
.dswc-tab-list { flex: 1 1 auto; overflow: auto; padding: 2px 6px 10px; }
.dswc-tab-foot { flex: none; display: flex; gap: 6px; align-items: center; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dswc-tab-hint { padding: 12px 12px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary)); }
.dswc-tab-hint[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
`;

    /**
     * Inject once per document, deduped by the tag's plugin marker.
     *
     * A hot reload re-materializes this module without clearing the document, so
     * an early return on the marker alone would keep serving the PREVIOUS
     * stylesheet — the panel would render new markup against old CSS. Refresh the
     * text when it differs.
     */
    function injectStyles() {
      const marker = 'dsh-deepseek-web-chat/styles';
      if (typeof document === 'undefined') return;
      const existing = document.querySelector(`style[data-plugin-css="${marker}"]`);
      if (existing) {
        if (existing.textContent !== CSS) existing.textContent = CSS;
        return;
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-deepseek-web-chat';
      tag.dataset.pluginCss = marker;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ================================================================ *
     * Module-level store
     *
     * The `main` slot renders only the ACTIVE panel, so this component
     * unmounts whenever the user switches to 工作. Keeping the conversation
     * outside React means switching back is instant and never re-syncs.
     * ================================================================ */

    const store = {
      value: {
        phase: 'loading', // loading | ready | setup | error
        hasToken: false,
        tokenPreview: '',
        valid: null,
        user: null,
        error: '',
        modelTypes: [{ id: 'default', label: 'default' }],
        sessions: [],
        syncedAt: null,
        activeId: null,
        messages: {}, // sessionId -> [{role, content}]
        loadingSession: false,
        draft: '',
        /**
         * Attachment chips under the composer, each `{name, size, id, status}`.
         * `id` is set once /upload settles; a turn waits for every id before
         * sending, and refuses to send while any upload is still running.
         *
         * The chips outlive the turn that sent them: upstream keeps no file with
         * the session, so the host remembers this conversation's files and every
         * later turn re-sends the ids — the chips are what makes that visible
         * (and removable).
         */
        attachments: [],
        /**
         * A file that was sent and then removed must be FORGOTTEN upstream too,
         * otherwise the host would keep re-sending it from memory. Set when a
         * settled chip is removed, cleared once the host has taken the turn.
         */
        detachFiles: false,
        thinking: false,
        search: false,
        modelType: 'default',
        streaming: false,
        stream: null, // {sessionId, text, thinking, note, status}
        query: '',
        /**
         * Set when the host half is older than this file.
         *
         * Both halves ship from one directory, but only this one is
         * hot-reloaded; the host half changes only when DSH restarts and
         * re-imports the module. Comparing the host's reported `protocol`
         * against `PROTOCOL` below catches that half-updated state — otherwise
         * it shows up as a plausible-looking bug (an empty conversation, a 400)
         * that no amount of editing this file can fix. See `PROTOCOL`.
         */
        hostStale: false,
        /**
         * True once the sidebar's 聊天 page is registered with the row.
         *
         * The sidebar is the single authority for the conversation list: the
         * user asked for this panel's own column to go away now that 聊天 sits
         * in the sidebar row, so one list lives in one place. The panel is then
         * purely the conversation.
         *
         * Registration alone is NOT enough to hide the column. The row belongs
         * to another plugin and it does not always draw our page: it renders the
         * official tree instead while the sidebar is collapsed to the 56px rail,
         * and drops the whole row if its owner unwraps. In those states a
         * registration-time flag would hide the panel's column while the sidebar
         * showed nothing, leaving no list anywhere. So the column is hidden only
         * while the page is genuinely on screen (`tabLive`, driven by the page's
         * own mount and unmount), and `tabInstalled` only records that the
         * registration succeeded.
         */
        tabInstalled: false,
        tabLive: false,
      },
      listeners: new Set(),
      set(patch) {
        store.value = { ...store.value, ...patch };
        for (const listener of store.listeners) listener();
      },
      subscribe(listener) {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
    };

    function useStore() {
      const [, force] = React.useState(0);
      React.useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
      return store.value;
    }

    /** Shared between the panel's session column and the sidebar 聊天 page. */
    function filterSessions(state) {
      const needle = state.query.trim().toLowerCase();
      if (!needle) return state.sessions;
      return state.sessions.filter((session) => {
        const title = typeof session.title === 'string' ? session.title : '';
        return title.toLowerCase().includes(needle);
      });
    }

    /**
     * Does the panel draw its own session column?
     *
     * Exactly one surface owns the conversation list. While the sidebar's 聊天
     * page is MOUNTED it IS that surface — the panel then drops its column so
     * the same list is never drawn twice — and whenever the page is not on
     * screen (no sidebar row to host it, its owner unwrapped, or the sidebar
     * collapsed to the rail where that row draws the official tree instead) the
     * panel falls back to drawing the column itself. Kept as a named predicate
     * rather than an inline check so the rule is testable without mounting
     * React; see test-panel.mjs.
     */
    function showSessionColumn(state) {
      return !state.tabLive;
    }

    /** In-flight generation, kept outside React so a panel switch cannot orphan it. */
    const flight = { controller: null };

    /**
     * Translator handle. `send` and `stop` run outside React, so they reach
     * localized text through this instead of a hook. The locale service binds
     * against the ACTIVE locale at call time, so one binding survives switches.
     */
    let i18n = (key) => key;

    /* ================================================================ *
     * The 聊天 / 工作 surface
     *
     * Reverse-engineered from the ChatGPT/Codex desktop app, whose 聊天 / 工作 /
     * Codex switch is NOT the agent mode: it is a separate *surface* axis
     * (`codexAppMode: 'chat' | 'work' | 'codex'`, app-shared-30671c57ec82.js),
     * while plan/default stays per-turn metadata. The parts worth copying:
     *
     *  - the choice is persisted independently of any conversation
     *    (`localStorage['home-composer-mode-v1']`), so a reload returns you to
     *    the surface you left;
     *  - `if (i === n && !a) return;` — switching to the current surface is a
     *    no-op rather than a re-navigation;
     *  - persist first, navigate second: the route change performs the switch;
     *  - a LOCATION is remembered per surface and restored on re-entry; when
     *    that location is gone it falls back to a FRESH conversation, never a
     *    stale thread.
     *
     * ui-layout resets on reload ("Layout state resets on reload"), so the
     * persistence nothing else provides has to live here. Carrying the surface
     * in `history.state` is deliberately NOT copied: DSH owns the URL.
     * ================================================================ */

    /** The surface the user last chose, and each surface's remembered location. */
    const SURFACE_KEY = 'dsh-deepseek-web-chat.surface.v1';
    const LOCATION_KEY = 'dsh-deepseek-web-chat.locations.v1';

    /** Storage is a nicety here: a locked-down profile must not break the panel. */
    function storageGet(key) {
      try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(key);
      } catch (error) {
        return null;
      }
    }

    function storageSet(key, value) {
      try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(key, value);
      } catch (error) {
        /* quota or private mode: the switch still works, it just forgets */
      }
    }

    /** Which surface a persisted value names; anything else falls back to 工作. */
    function readSurface(raw) {
      return raw === 'chat' || raw === 'work' ? raw : 'work';
    }

    /** ChatGPT's `if (i === n && !a) return;` — already there is not a switch. */
    function isSameSurface(current, requested, force) {
      return !force && current === requested;
    }

    /**
     * Where a surface should land on re-entry: `{kind: 'session', id}` or
     * `{kind: 'new'}`.
     *
     * A remembered session that is no longer in the list is treated as GONE and
     * answered with a fresh conversation — the same fallback ChatGPT makes
     * (`_L(e, null); startNewConversation()`). The caller must not ask this
     * question before the list has been fetched, or "not known yet" reads as
     * "gone" and drops the user into a new chat by mistake.
     */
    function recallTarget(locations, which, sessions) {
      const memory = locations && typeof locations === 'object' ? locations[which] : null;
      const id = memory && typeof memory.sessionId === 'string' ? memory.sessionId : '';
      if (!id) return { kind: 'new' };
      const known = Array.isArray(sessions) && sessions.some((row) => row && row.id === id);
      return known ? { kind: 'session', id } : { kind: 'new' };
    }

    const surfaceStore = {
      layout: null,
      current: 'work',
      locations: { chat: null, work: null },
      loaded: false,
      /** A remembered chat session still waiting for the list to arrive. */
      pendingChatRestore: false,

      /** The switch needs `ctx.layout`; it is inert (a no-op) until bound. */
      bind(layout) {
        this.layout = layout;
      },

      load() {
        if (this.loaded) return this.current;
        this.loaded = true;
        this.current = readSurface(storageGet(SURFACE_KEY));
        let saved = null;
        try {
          const raw = storageGet(LOCATION_KEY);
          saved = raw ? JSON.parse(raw) : null;
        } catch (error) {
          saved = null;
        }
        this.locations = {
          chat: saved && typeof saved.chat === 'object' ? saved.chat : null,
          // 工作's location belongs to the Conversation, which owns its own
          // session; the slot is kept so a surface that does hand one in has
          // somewhere to put it (ChatGPT stores {location, selectedProject}).
          work: null,
        };
        return this.current;
      },

      persist() {
        storageSet(SURFACE_KEY, this.current);
        storageSet(LOCATION_KEY, JSON.stringify(this.locations));
      },

      /** Remember where a surface was left. */
      remember(which, location) {
        this.load();
        this.locations = { ...this.locations, [which]: location || null };
        this.persist();
      },

      /**
       * The surface the layout is ACTUALLY showing, or `undefined` when the
       * layout has not been bound / does not expose its state yet.
       *
       * `current` is this store's memory, and memory goes stale: the panel can
       * be taken away without `select()` ever running — the user clicks the
       * plugin's own rail entry, or DSH's rail hands the main panel to another
       * view. Comparing against a stale value then makes a real switch look like
       * "already there" and it silently does nothing, which is the reported
       * "切换按钮没反应 / 点历史对话没反应" bug. The live panel is the truth.
       */
      liveSurface() {
        const info = this.layout && this.layout.panelInfo;
        if (!info) return undefined;
        return info.activePanelId === PANEL_ID ? 'chat' : 'work';
      },

      /** Adopt the live panel as this store's memory, if it is known. */
      syncSurface() {
        const live = this.liveSurface();
        if (live === undefined || live === this.current) return live;
        this.load();
        this.current = live;
        this.persist();
        return live;
      },

      /**
       * Switch surface: guard, persist, then navigate.
       *
       * Returns whether anything changed. `selectPanel` throws while the key is
       * not registered, which is a no-op here rather than an exception thrown
       * out of an onClick — and, importantly, a failed navigation is not
       * remembered as if it had happened.
       */
      select(which, options = {}) {
        const { force = false, restore = true } = options;
        this.load();
        // Reconcile first: a switch away from a surface the layout already
        // left would otherwise be swallowed by the guard below.
        this.syncSurface();
        if (isSameSurface(this.current, which, force)) return false;
        if (this.layout) {
          try {
            this.layout.selectPanel(which === 'chat' ? PANEL_ID : null);
          } catch (error) {
            return false;
          }
        }
        this.current = which;
        this.persist();
        if (which === 'chat' && restore) this.restoreChatSession();
        return true;
      },

      /**
       * Reopen the chat location this surface was left on.
       *
       * Before the session list exists a missing id means "unknown", not "gone",
       * so the decision is deferred to the first successful sync instead of
       * guessing a fresh chat.
       */
      restoreChatSession() {
        if (store.value.syncedAt === null) {
          this.pendingChatRestore = true;
          return;
        }
        const target = recallTarget(this.locations, 'chat', store.value.sessions);
        if (target.kind === 'session') {
          if (target.id !== store.value.activeId) openSession(target.id);
          return;
        }
        // No memory, or the remembered session is gone: a fresh conversation
        // rather than whatever thread happened to be open.
        if (store.value.activeId !== null) startNewSession();
      },

      /**
       * Reopen the surface the user left, once the panel is registered.
       *
       * Only 聊天 needs acting on: 工作 is the default DSH state, so a reload
       * already lands there. The panel key is registered by a slot injection
       * that may not have run yet, so selection is retried briefly instead of
       * being allowed to throw.
       */
      restoreOnBoot() {
        const which = this.load();
        if (which !== 'chat' || !this.layout) return;
        let tries = 12;
        const attempt = () => {
          try {
            this.layout.selectPanel(PANEL_ID);
          } catch (error) {
            tries -= 1;
            if (tries > 0 && typeof setTimeout === 'function') setTimeout(attempt, 120);
            return;
          }
          this.restoreChatSession();
        };
        attempt();
      },
    };

    /* ================================================================ *
     * Host API
     * ================================================================ */

    function api(path) {
      const relative = String(path).replace(/^\/+/, '');
      if (typeof document === 'undefined') return `/${relative}`;
      // Keep the query: `/messages?sessionId=…` and `/sessions?count=…&refresh=…`
      // carry their parameters here, and `pathname` alone would silently drop
      // them — the host then answers 400 缺少 sessionId.
      const url = new URL(relative, document.baseURI);
      return `${url.pathname}${url.search}`;
    }

    async function request(path, options = {}) {
      const response = await fetch(api(`${API}${path}`), {
        cache: 'no-store',
        ...options,
        headers: {
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.headers || {}),
        },
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const error = new Error((payload && payload.error) || `HTTP ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    function describe(error) {
      if (error && error.payload && error.payload.error) return String(error.payload.error);
      if (error && typeof error.message === 'string' && error.message) return error.message;
      return null;
    }

    /**
     * Chip subtitle: transport/parse state while that matters, size once the
     * file is actually usable. Without this an attachment looked "done" the
     * moment the bytes were accepted, which is exactly how a Word upload turned
     * into a sent message with nothing behind it.
     *
     * Factory scope has no `t` — translations here go through `i18n`, which
     * apply() points at the bound translator. Using `t` here threw
     * `ReferenceError: t is not defined` the moment a chip was drawn, which
     * took the whole panel down with it; `test-render.mjs` pins that down.
     */
    function chipStatusText(chip) {
      if (chip.status === 'uploading') return i18n('upload.uploading');
      if (chip.status === 'error') return i18n('upload.failed');
      if (chip.status === 'timeout') return i18n('upload.parseFailed');
      if (chip.status && !fileSettled(chip.status)) return i18n('upload.parsing');
      if (chip.status && !fileUsable(chip.status)) return i18n('upload.parseFailed');
      // Usable: say so explicitly. "Only the bytes were transferred" is exactly
      // what the reader must not have to guess once the parse has landed.
      const size = chip.size != null ? formatBytes(chip.size) : '';
      const state = i18n('upload.parsed');
      return size ? `${state} · ${size}` : state;
    }

    /** Human file size for attachment chips ("12.3 KB"). */
    function formatBytes(size) {
      const n = Number(size);
      if (!Number.isFinite(n) || n < 0) return '';
      if (n < 1024) return `${n} B`;
      const units = ['KB', 'MB', 'GB'];
      let value = n;
      let unit = 'B';
      for (const next of units) {
        if (value < 1024) break;
        value /= 1024;
        unit = next;
      }
      return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
    }

    /* ================================================================ *
     * Actions
     * ================================================================ */

    async function loadState() {
      try {
        const payload = await request('/state');
        // A host that predates the handshake reports no protocol at all, which
        // is itself the answer: it is older than this file.
        const hostStale = Number(payload.protocol) !== PROTOCOL;
        store.set({
          phase: payload.hasToken ? 'ready' : 'setup',
          hasToken: Boolean(payload.hasToken),
          tokenPreview: payload.tokenPreview || '',
          valid: payload.valid === undefined ? null : payload.valid,
          user: payload.user || null,
          error: payload.error || '',
          hostStale,
          modelTypes:
            Array.isArray(payload.modelTypes) && payload.modelTypes.length
              ? payload.modelTypes
              : store.value.modelTypes,
          syncedAt: payload.syncedAt || null,
        });
      } catch (error) {
        store.set({ phase: 'error', error: describe(error) || i18n('error.network') });
      }
    }

    async function syncSessions({ silent = false } = {}) {
      if (!silent) store.set({ error: '' });
      try {
        // No `count` here: it is a page size upstream caps at 100, and the host
        // pages the whole history itself. Asking for 500 used to look like
        // "give me everything" while actually being rejected upstream.
        const payload = await request('/sessions?refresh=1');
        const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        store.set({ sessions, syncedAt: payload.syncedAt || null, phase: 'ready' });
        // A deferred surface restore can be decided now that the list is known.
        if (surfaceStore.pendingChatRestore) {
          surfaceStore.pendingChatRestore = false;
          surfaceStore.restoreChatSession();
        }
        return sessions;
      } catch (error) {
        // The host marks a rejected token with `authFailed`; testing the message
        // for 令牌 only worked while the wording was Chinese, so an English UI
        // would have shown a dead token as merely "sync failed".
        const authFailed = Boolean(error && error.payload && error.payload.authFailed);
        store.set({
          error: describe(error) || i18n('error.sync'),
          valid: authFailed ? false : store.value.valid,
        });
        return null;
      }
    }

    async function openSession(sessionId) {
      // The per-surface location memory: this is where 聊天 will be resumed.
      surfaceStore.remember('chat', { sessionId });
      // Attachments belong to the conversation they were added to; a switch
      // starts the composer empty (the host still remembers this session's
      // files, so switching back keeps the answers grounded).
      store.set({ activeId: sessionId, loadingSession: true, error: '', attachments: [], detachFiles: false });
      if (store.value.messages[sessionId]) store.set({ loadingSession: false });
      try {
        const payload = await request(`/messages?sessionId=${encodeURIComponent(sessionId)}&refresh=1`);
        store.set({
          messages: { ...store.value.messages, [sessionId]: payload.messages || [] },
          loadingSession: false,
        });
      } catch (error) {
        store.set({ loadingSession: false, error: describe(error) || i18n('error.messages') });
      }
    }

    function startNewSession() {
      // An explicit new chat is itself the memory: re-entering 聊天 must not
      // drag the previous thread back. Its files belong to the old thread, so
      // the composer drops them here rather than leaking them into the new one.
      surfaceStore.remember('chat', null);
      store.set({ activeId: null, error: '', stream: null, attachments: [], detachFiles: false });
    }

    /** POST /chat and pump the SSE body into the store. */
    async function send(prompt) {
      const text = prompt.trim();
      // A turn may be file-only: upstream accepts an empty prompt when
      // attachments are present, and rejects both empty (biz_code 6).
      const pending = store.value.attachments.filter((a) => a.id);
      if ((!text && pending.length === 0) || store.value.streaming) return;
      if (store.value.attachments.some((a) => !a.id && a.status !== 'error')) {
        store.set({ error: i18n('upload.wait') });
        return;
      }
      // Upstream answers a turn that references a still-parsing file with
      // biz_code 9 and no stream frames at all, so the turn has to be held back
      // here rather than sent into an empty answer.
      const unusable = store.value.attachments.find((a) => a.id && !fileUsable(a.status));
      if (unusable) {
        store.set({
          error: fileSettled(unusable.status) ? i18n('upload.rejected') : i18n('upload.notReady'),
        });
        return;
      }
      const sessionId = store.value.activeId;
      const controller = new AbortController();
      flight.controller = controller;
      // Snapshot the chips into the local echo: the snapshot turns carry
      // `names`, and the optimistic user bubble renders the same chips a synced
      // turn does. The chips themselves STAY in the composer — this conversation
      // keeps its files (upstream keeps none, so the host remembers them and
      // every later turn re-sends the ids), and the reader must still see what
      // the answers are grounded in, and be able to remove it.
      const sentAttachments = pending.map((a) => ({ id: a.id, name: a.name, size: a.size }));
      store.set({
        streaming: true,
        error: '',
        draft: '',
        stream: { sessionId, text: '', thinking: '', note: '', status: '' },
      });

      const finish = (patch) => {
        flight.controller = null;
        store.set({ streaming: false, stream: null, ...patch });
      };

      try {
        const response = await fetch(api(`${API}/chat`), {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionId || undefined,
            prompt: text,
            modelType: store.value.modelType,
            thinking: store.value.thinking,
            search: store.value.search,
            refFileIds: sentAttachments.map((a) => a.id),
            attachments: sentAttachments.map(({ name }) => ({ name })),
            detachFiles: store.value.detachFiles === true,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const raw = await response.text();
          let message = `HTTP ${response.status}`;
          try {
            message = JSON.parse(raw).error || message;
          } catch {
            /* keep the status text */
          }
          throw new Error(message);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let settled = null;
        let answer = '';
        let reasoning = '';

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            const line = frame.startsWith('data:') ? frame.slice(5).trim() : '';
            if (!line) continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            const current = store.value.stream || { text: '', thinking: '', note: '', status: '' };
            if (event.type === 'session') {
              settled = event.sessionId;
              store.set({ activeId: event.sessionId, stream: { ...(store.value.stream || current), sessionId: event.sessionId } });
            } else if (event.type === 'phase') {
              store.set({ stream: { ...current, status: event.phase === 'pow' ? 'pow' : event.phase } });
            } else if (event.type === 'continue') {
              store.set({ stream: { ...current, status: 'continuing' } });
            } else if (event.type === 'text') {
              answer += event.text;
              store.set({ stream: { ...current, text: answer, status: 'streaming' } });
            } else if (event.type === 'thinking') {
              reasoning += event.text;
              store.set({ stream: { ...current, thinking: reasoning } });
            } else if (event.type === 'note') {
              store.set({ stream: { ...current, note: event.text || '' } });
            } else if (event.type === 'status') {
              // CONTENT_FILTER is terminal: upstream replaced the answer with a
              // canned refusal, so the panel owes the reader that caveat.
              store.set({
                stream: { ...current, status: event.status || current.status, filtered: event.status === 'CONTENT_FILTER' },
              });
            } else if (event.type === 'error') {
              throw Object.assign(new Error(event.error || i18n('error.generate')), { authFailed: event.authFailed });
            }
          }
        }

        if (settled) {
          const live = store.value.stream || {};
          const list = Array.isArray(store.value.messages[settled]) ? store.value.messages[settled].slice() : [];
          list.push({ role: 'user', content: text, names: sentAttachments.map((a) => a.name) });
          if (answer || live.note || live.filtered) {
            // The live stream object is dropped on finish, so anything the reader
            // still needs (auto-continue cutoff, safety-filter caveat) rides along
            // on the committed message instead of vanishing with it.
            list.push({
              role: 'assistant',
              content: answer,
              note: live.note || '',
              filtered: Boolean(live.filtered),
            });
          }
          store.set({ messages: { ...store.value.messages, [settled]: list }, detachFiles: false });
          if (answer) syncSessions({ silent: true });
        }
        finish(settled ? { activeId: settled } : {});
      } catch (error) {
        if (controller.signal.aborted) {
          finish({});
          return;
        }
        const message = error && error.authFailed ? null : describe(error);
        finish({
          error: error && error.authFailed ? i18n('error.token') : message || i18n('error.send'),
          valid: error && error.authFailed ? false : store.value.valid,
        });
      }
    }

    function stop() {
      if (flight.controller) flight.controller.abort();
    }

    /** Fire-and-forget one attachment upload; the chip tracks its own state. */
    async function uploadAttachment(file) {
      if (!file || store.value.attachments.length >= MAX_ATTACHMENTS) {
        if (store.value.attachments.length >= MAX_ATTACHMENTS) store.set({ error: i18n('upload.limit') });
        return;
      }
      const chip = {
        uploadKey: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        size: file.size,
        id: '',
        status: 'uploading',
      };
      store.set({ attachments: [...store.value.attachments, chip], error: '' });
      try {
        const response = await fetch(api(`${API}/upload`), {
          method: 'POST',
          cache: 'no-store',
          headers: {
            // Raw bytes with metadata in headers — see handleUpload's comment
            // on why the body is not multipart and not JSON.
            'content-type': file.type ? file.type : 'application/octet-stream',
            'x-file-name': encodeURIComponent(file.name),
          },
          body: file,
        });
        const raw = await response.text();
        let payload = null;
        try { payload = JSON.parse(raw); } catch { /* handled below */ }
        if (!response.ok || !payload || !payload.file || !payload.file.id) {
          const detail = (payload && payload.error) || `HTTP ${response.status}`;
          throw Object.assign(new Error(detail), { payload });
        }
        const status = payload.file.status ? payload.file.status : 'SUCCESS';
        const attachments = store.value.attachments.map((entry) =>
          entry.uploadKey === chip.uploadKey ? { ...entry, id: payload.file.id, status } : entry,
        );
        store.set({ attachments });
        // The host deliberately answers without waiting the parse out, so a
        // Word/PDF attachment comes back PENDING or PARSING and stays unusable
        // until upstream finishes. Track it here instead of blocking the picker.
        if (!fileSettled(status)) void pollAttachment(chip.uploadKey, payload.file.id);
      } catch (error) {
        const attachments = store.value.attachments.map((entry) =>
          entry.uploadKey === chip.uploadKey ? { ...entry, status: 'error' } : entry,
        );
        store.set({ attachments, error: describe(error) || i18n('upload.failed') });
      }
    }

    /**
     * Follow one attachment until upstream finishes parsing it.
     *
     * A document can take tens of seconds (a 2MB .docx measured ~16s), so the
     * chip has to stay visible and honest instead of looking uploaded while
     * the send button silently produces nothing.
     */
    async function pollAttachment(uploadKey, fileId) {
      const patch = (status) =>
        store.set({
          attachments: store.value.attachments.map((entry) =>
            entry.uploadKey === uploadKey ? { ...entry, status } : entry,
          ),
        });
      for (let attempt = 0; attempt < ATTACHMENT_POLLS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, ATTACHMENT_POLL_MS));
        // The chip may have been removed while the parse was running.
        if (!store.value.attachments.some((entry) => entry.uploadKey === uploadKey)) return;
        let record = null;
        try {
          const payload = await request(`/files?file_ids=${encodeURIComponent(fileId)}`);
          record = payload && Array.isArray(payload.files) ? payload.files[0] : null;
        } catch {
          continue; // transient: keep polling until the budget runs out
        }
        if (!record) continue;
        const status = record.status ? record.status : 'SUCCESS';
        patch(status);
        if (fileSettled(status)) return;
      }
      patch('timeout');
      store.set({ error: i18n('upload.stuck') });
    }

    function removeAttachment(index) {
      const attachments = store.value.attachments.slice();
      const removed = attachments.splice(index, 1)[0];
      // Removing a chip that already went upstream has to reach the host, or its
      // per-session memory would keep feeding that file to every later turn.
      store.set({ attachments, detachFiles: Boolean(removed && removed.id) || store.value.detachFiles });
    }

    /* ================================================================ *
     * Rendering helpers
     * ================================================================ */

    /**
     * Caveats that belong to an answer rather than to the live stream: the
     * auto-continue cutoff and the safety-filter marker. Rendered from both the
     * live turn and a committed one so the wording survives the switch.
     */
    function caveats(t, source, keyPrefix) {
      const nodes = [];
      if (source && source.note) {
        nodes.push(h('div', { className: 'dswc-note', key: `${keyPrefix}-note` }, source.note));
      }
      if (source && source.filtered) {
        nodes.push(
          h('div', { className: 'dswc-note', 'data-tone': 'warn', key: `${keyPrefix}-filtered` }, t('state.filtered')),
        );
      }
      return nodes;
    }

    /**
     * Drop the web app's inline source markers.
     *
     * A search answer arrives with `[reference:N]` glued to the sentences that
     * used source N; chat.deepseek.com turns each one into a numbered chip that
     * opens its source panel. This plugin does not port that panel, so the bare
     * marker is noise on the sentence — the user's screenshot of a search answer
     * was mostly `[reference:0][reference:1]…[reference:24]`.
     *
     * This is deliberately NOT a divergence from the agent surface. Agent answers
     * never carry these markers (nothing in the shipped renderer knows about
     * them — `case "text"` prints its input verbatim), so removing them moves a
     * web answer closer to how an agent answer reads, which is the goal.
     *
     * Only the marker form is removed: a model that writes `[citation needed]`
     * or `[reference: see the appendix]` as prose keeps it, because the payload
     * has to look like a source number. The second pass catches a marker whose
     * number is malformed (`[reference:abc]`), which upstream does emit, while
     * still refusing anything long enough to be a sentence.
     * It runs at RENDER time, not while parsing, because a marker can be split
     * across two SSE deltas (`[refe` + `rence:0]`) — the transcript keeps the
     * original text so a source panel could still be built from it later.
     */
    function stripCitations(text) {
      return String(text)
        .replace(/\s*\[(?:reference|citation)\s*:\s*\d+\]/gi, '')
        .replace(/\s*\[(?:reference|citation)\s*:\s*[^\]\n]{1,12}\]/gi, '');
    }

    /*
     * ---------- markdown ----------
     *
     * Harness answers are drawn by `@deepseek-ai/dsh-client-ui-primitives`
     * (MarkdownText + CodeBlock). A plugin may not import that package, and its
     * class names are content-hashed, so this is a hand-written renderer aimed at
     * the same target: the block rhythm, the `--dsw-font-markdown-*` composite
     * fonts, code blocks on `--dsw-alias-markdown-code-block` inside a
     * `--dsw-radius-lg` shell with a language banner and a copy button, `.5px`
     * borders on inline code, and weight-500 links that only underline on hover.
     *
     * It is deliberately a small CommonMark subset: fenced code, ATX headings,
     * paragraphs, ordered/unordered lists (one nesting level per indent step),
     * blockquotes, tables, thematic breaks, and inline code / strong / em / del /
     * links. DeepSeek answers are written in that subset in practice, and the
     * fallback for anything else is the literal text, never a broken layout.
     */

    /**
     * Soft-wrapped lines keep their newline, the way the shipped renderer does.
     *
     * Its `case "text": return node.value` prints the mdast text verbatim, and
     * the newlines inside it are ordinary whitespace to HTML — so two source
     * lines render as one line separated by a single space. Joining with the
     * newline (rather than collapsing here) is what makes the browser's own
     * whitespace folding produce that space, including between two CJK
     * characters, where a hand-rolled "no space inside CJK" rule would drop it
     * and quietly reflow the answer.
     */
    function softJoin(parts) {
      return parts.join('\n');
    }

    /* Alternation order is the whole game here: the image form must be tried
       before the link form, `***` before `**` before `*`, and a backtick run
       before any emphasis so `a *b* c` inside code stays literal.
       The lookbehind is what makes a backslash escape work: without it the
       `*` in `\*text\*` opens emphasis and the backslash leaks into the output
       as a literal character. */
    const INLINE_PATTERN = /(?<!\\)(`+[^`\n]*`+|!\[[^\]\n]*\]\([^)\s]+\)|\[[^\]\n]+\]\([^)\s]+\)|<https?:\/\/[^>\s]+>|\*\*\*[^*\n]+?\*\*\*|\*\*[^\n]+?\*\*|__[^_\n]+?__|~~[^\n]+?~~|\*[^*\n]+?\*|_[^_\n]+?_)/g;

    const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!>~|])/g;

    /** A backslash escape renders as the literal character it protects. */
    function unescapeInline(text) {
      return text.replace(ESCAPABLE, '$1');
    }

    /**
     * The shipped renderer runs every href through `sanitizeUrl` and only gives
     * `http:`/`https:` a `target="_blank"`, so a `javascript:` link is inert and
     * an in-page `#anchor` does not open a new window.
     */
    function safeHref(raw) {
      const href = String(raw).trim();
      if (/^(?:https?|mailto):/i.test(href)) return href;
      if (/^[#/?]/.test(href)) return href;
      return '';
    }

    function renderInline(text, keyPrefix) {
      const nodes = [];
      const pattern = new RegExp(INLINE_PATTERN.source, 'g');
      let cursor = 0;
      let match;
      let index = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > cursor) nodes.push(unescapeInline(text.slice(cursor, match.index)));
        const token = match[0];
        const key = `${keyPrefix}-i${index}`;
        if (token.charAt(0) === '`') {
          const ticks = /^`+/.exec(token)[0].length;
          nodes.push(h('code', { className: 'dswc-inline-code', key }, token.slice(ticks, -ticks)));
        } else if (token.slice(0, 2) === '![') {
          const image = /^!\[([^\]\n]*)\]\(([^)\s]+)\)$/.exec(token);
          const src = safeHref(image[2]);
          nodes.push(
            src
              ? h('img', { className: 'dswc-image', key, src, alt: image[1], loading: 'lazy' })
              : h('span', { className: 'dswc-image-alt', key }, image[1] || token),
          );
        } else if (token.charAt(0) === '<') {
          const url = token.slice(1, -1);
          nodes.push(
            h(
              'a',
              { className: 'dswc-link', key, href: url, target: '_blank', rel: 'noopener noreferrer' },
              url,
            ),
          );
        } else if (token.slice(0, 3) === '***') {
          nodes.push(h('strong', { key }, h('em', {}, token.slice(3, -3))));
        } else if (token.slice(0, 2) === '**' || token.slice(0, 2) === '__') {
          nodes.push(h('strong', { key }, renderInline(token.slice(2, -2), `${key}-s`)));
        } else if (token.slice(0, 2) === '~~') {
          nodes.push(h('del', { key }, renderInline(token.slice(2, -2), `${key}-d`)));
        } else if (token.charAt(0) === '*' || token.charAt(0) === '_') {
          nodes.push(h('em', { key }, renderInline(token.slice(1, -1), `${key}-e`)));
        } else {
          const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(token);
          const href = safeHref(link[2]);
          // A label may hold its own inline markup: `[**a**](url)` is bold text,
          // not the literal four characters.
          const label = renderInline(link[1], `${key}-l`);
          if (!href) {
            nodes.push(h('span', { key }, label));
          } else if (/^https?:/i.test(href)) {
            nodes.push(
              h('a', { className: 'dswc-link', key, href, target: '_blank', rel: 'noopener noreferrer' }, label),
            );
          } else {
            nodes.push(h('a', { className: 'dswc-link', key, href }, label));
          }
        }
        cursor = match.index + token.length;
        index += 1;
      }
      if (cursor < text.length) nodes.push(unescapeInline(text.slice(cursor)));
      return nodes;
    }

    /**
     * A fenced block, drawn like the shipped CodeBlock: a language banner that
     * sticks to the top of the scroll area, and a copy button that says so.
     * `navigator.clipboard` is unavailable in some embedded contexts, so the
     * fallback is the old textarea + execCommand path; a failed copy still
     * flips the label, because a button that silently does nothing is worse.
     */
    /* 14px line-art, drawn to match the shipped toolbar glyphs: a stroked
       outline for copy/check, a solid block with a return arrow for wrapping. */
    function CopyIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        [
          h('rect', { key: 'a', x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.2 }),
          h('path', { key: 'b', d: 'M10.5 3.5v-.4A1.6 1.6 0 0 0 8.9 1.5H3.6A1.6 1.6 0 0 0 2 3.1v5.3a1.6 1.6 0 0 0 1.6 1.6h.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        ],
      );
    }

    function CheckIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 8.6l3.2 3.2L13 5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    /* Tray-with-arrow, drawn from the shipped glyph's geometry: the same 1.2
       stroke weight as copy/check, so the three buttons in one toolbar look
       like one set. */
    function DownloadIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        [
          h('path', { key: 'a', d: 'M8 2.2v7.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
          h('path', { key: 'b', d: 'M5.2 6.8L8 9.6l2.8-2.8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          h('path', { key: 'c', d: 'M3 11.4v1.4a1.2 1.2 0 0 0 1.2 1.2h7.6a1.2 1.2 0 0 0 1.2-1.2v-1.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        ],
      );
    }

    /* The icon depicts the action, not the state: while wrapping is on the
       button offers "no wrap" (straight lines), matching the shipped toolbar's
       `wrapped ? IconNowrapFill : IconWrapFill` pairing. */
    function WrapIcon(props) {
      if (props && props.nowrap) {
        return h(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          [
            h('path', { key: 'a', d: 'M2 4.5h12M2 8h7M2 11.5h12', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
          ],
        );
      }
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        [
          h('path', { key: 'a', d: 'M2 4.5h12', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
          h('path', { key: 'b', d: 'M2 8h8.5a2.5 2.5 0 0 1 0 5H8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
          h('path', { key: 'c', d: 'M9.6 11.4L7.9 13l1.7 1.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          h('path', { key: 'd', d: 'M2 13h4.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        ],
      );
    }

    /* ------------------------------------------------------------------
     * Fenced-code colouring
     *
     * The shipped chat surface colours code with a shiki grammar and publishes
     * the palette as custom properties (the `.dswc-tok-*` rules in the
     * stylesheet read them). What follows is a hand-written scanner instead of
     * a grammar: keywords, strings, numbers, comments, calls and punctuation
     * are what make a fence legible, and a language it does not know is left
     * completely alone rather than coloured wrongly.
     * ------------------------------------------------------------------ */

    /** Token kind → stylesheet class. `''` means plain: no span is emitted. */
    const TOKEN_CLASS = {
      kw: 'dswc-tok-kw',
      str: 'dswc-tok-str',
      num: 'dswc-tok-num',
      com: 'dswc-tok-com',
      fn: 'dswc-tok-fn',
      pun: 'dswc-tok-pun',
      par: 'dswc-tok-par',
    };

    /** Words the C-family languages — and their many lookalikes — reserve. */
    const C_WORDS = ('abstract as assert async await auto bool break byte case catch chan char class const constexpr continue data '
      + 'default defer delete do double elif else enum except explicit export extends extern false final finally float for foreach '
      + 'friend from func function get global go goto if impl implements import in inline instanceof int interface is lambda let '
      + 'long map match mutable namespace new nullptr object operator override package private protected protocol public raise '
      + 'readonly record ref register repeat require return sealed select self short signed sizeof static struct super switch '
      + 'template this throw trait true try type typedef typealias typeof union unsigned use using val var virtual void volatile '
      + 'when where while with yield').split(' ');

    /**
     * One rule set per language family. `words` is the reserved list; `line` and
     * `block` are comment markers; `strings` are quote pairs to scan, longest
     * first; `escape` says whether a backslash escapes; `calls` colours any
     * `name(` as a function; `dollars` colours `$name`; `keys` colours
     * `name:` / `name=` as a parameter; `upper` matches keywords
     * case-insensitively (SQL); `markup` switches to tag scanning.
     */
    const CODE_RULES = {
      clike: {
        words: C_WORDS, line: ['//'], block: [['/*', '*/']], strings: ['"', "'", '`'], escape: true, preproc: '#', calls: true,
      },
      python: {
        words: ('False None True and as assert async await break class continue def del elif else except finally for from global if '
          + 'import in is lambda nonlocal not or pass raise return try while with yield match case self').split(' '),
        line: ['#'], block: [], strings: ['"""', "'''", '"', "'"], escape: true, calls: true,
      },
      shell: {
        words: ('alias case do done elif else esac export fi for function if in local read return select set source then until while '
          + 'echo printf cd exit').split(' '),
        line: ['#'], block: [], strings: ['"', "'"], escape: true, dollars: true,
      },
      matlab: {
        words: ('break case catch classdef continue else elseif end events for function global if methods otherwise parfor persistent '
          + 'properties return spmd switch try while').split(' '),
        line: ['%'], block: [['%{', '%}']], strings: ["'"], escape: false, calls: true,
      },
      json: { words: ['true', 'false', 'null'], line: ['//'], block: [['/*', '*/']], strings: ['"'], escape: true },
      yaml: {
        words: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'], line: ['#'], block: [], strings: ['"', "'"], escape: false, keys: true,
      },
      sql: {
        words: ('add all alter and any as asc between by case cast check column commit create delete desc distinct drop else end exists '
          + 'foreign from group having in index inner insert into is join key left like limit not null on or order outer primary '
          + 'references right select set table then union unique update values view when where with').split(' '),
        line: ['--'], block: [['/*', '*/']], strings: ["'"], escape: false, upper: true,
      },
      css: { line: [], block: [['/*', '*/']], strings: ['"', "'"], escape: true, atrule: true, keys: true },
      markup: { line: [], block: [['<!--', '-->']], markup: true },
      plain: {},
    };

    /** Fence info string → rule set. Anything unmapped is drawn as plain text. */
    const CODE_ALIASES = {
      c: 'clike', cc: 'clike', cpp: 'clike', cxx: 'clike', h: 'clike', hpp: 'clike', cs: 'clike', csharp: 'clike',
      java: 'clike', js: 'clike', jsx: 'clike', javascript: 'clike', mjs: 'clike', cjs: 'clike', ts: 'clike', tsx: 'clike',
      typescript: 'clike', go: 'clike', rust: 'clike', rs: 'clike', swift: 'clike', kotlin: 'clike', kt: 'clike',
      objectivec: 'clike', objc: 'clike', php: 'clike', perl: 'clike', pl: 'clike', r: 'clike', lua: 'clike',
      less: 'clike', sass: 'clike', scss: 'clike', groovy: 'clike', dart: 'clike',
      py: 'python', python: 'python', python3: 'python',
      sh: 'shell', shell: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', dockerfile: 'shell', makefile: 'shell',
      powershell: 'shell', ps1: 'shell',
      matlab: 'matlab', octave: 'matlab',
      json: 'json', jsonc: 'json',
      yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', conf: 'yaml', nginx: 'yaml', properties: 'yaml',
      sql: 'sql',
      css: 'css',
      html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
      markdown: 'plain', md: 'plain', plaintext: 'plain', text: 'plain', txt: 'plain', log: 'plain',
    };

    /** The file name a downloaded fence should carry. */
    const CODE_EXTENSIONS = {
      clike: 'txt', python: 'py', shell: 'sh', matlab: 'm', json: 'json', yaml: 'yml', sql: 'sql', css: 'css', markup: 'html',
    };

    /** Long info strings whose own name is not a usable file extension. */
    const CODE_LONG_EXTENSIONS = {
      javascript: 'js', typescript: 'ts', python: 'py', shell: 'sh', bash: 'sh', zsh: 'sh', powershell: 'ps1',
      matlab: 'm', csharp: 'cs', kotlin: 'kt', objectivec: 'm', ruby: 'rb', perl: 'pl', yaml: 'yml', markdown: 'md',
      plaintext: 'txt', text: 'txt', dockerfile: 'dockerfile', makefile: 'makefile', graphql: 'graphql', nginx: 'conf',
    };

    /** Last resort when an info string maps to no language the scanner knows. */
    const CODE_FALLBACK_EXTENSION = 'txt';

    /**
     * `python` → `snippet.py`, `jsx` → `snippet.jsx`, `unknown` → `snippet.txt`.
     * A short info string is already an extension as often as not (`py`, `rs`,
     * `cpp`), so it is trusted; a long one is looked up, then its family is.
     */
    function codeFileName(lang) {
      const clean = String(lang || '').toLowerCase().replace(/[^a-z0-9+#]/g, '');
      if (!clean) return `snippet.${CODE_FALLBACK_EXTENSION}`;
      const family = CODE_ALIASES[clean];
      const extension = CODE_LONG_EXTENSIONS[clean]
        || (clean.length <= 5 ? clean : '')
        || (family ? CODE_EXTENSIONS[family] : '')
        || CODE_FALLBACK_EXTENSION;
      return `snippet.${extension}`;
    }

    /**
     * Split `code` into `[kind, text]` pairs, merging runs of the same kind.
     * One left-to-right pass: comments are claimed before operators (so `//` is
     * not two slashes), strings before identifiers, numbers before punctuation,
     * and everything else falls through as plain text — which is what keeps an
     * unhandled construct readable instead of mangled.
     */
    function codeTokens(code, rules) {
      const out = [];
      const length = code.length;
      const add = (kind, text) => {
        if (!text) return;
        const last = out[out.length - 1];
        if (last && last[0] === kind) last[1] += text;
        else out.push([kind, text]);
      };
      const words = rules.words || [];
      const isWord = (text) => (rules.upper ? words.includes(text.toUpperCase()) : words.includes(text));
      const wordChar = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$' || c === '@';
      const digit = (c) => c >= '0' && c <= '9';
      const space = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
      let i = 0;
      while (i < length) {
        const ch = code[i];
        // Comments first: block pairs, then to-end-of-line markers.
        let eaten = 0;
        for (const pair of rules.block || []) {
          if (code.startsWith(pair[0], i)) {
            const end = code.indexOf(pair[1], i + pair[0].length);
            const stop = end === -1 ? length : end + pair[1].length;
            add('com', code.slice(i, stop));
            eaten = stop - i;
            break;
          }
        }
        if (!eaten) {
          for (const marker of rules.line || []) {
            if (code.startsWith(marker, i)) {
              const nl = code.indexOf('\n', i);
              const stop = nl === -1 ? length : nl;
              add('com', code.slice(i, stop));
              eaten = stop - i;
              break;
            }
          }
        }
        if (eaten) {
          i += eaten;
          continue;
        }
        // A preprocessor directive owns its whole line (`#include <stdio.h>`).
        if (rules.preproc && ch === rules.preproc) {
          const lineStart = code.lastIndexOf('\n', i - 1) + 1;
          if (/^[ \t]*$/.test(code.slice(lineStart, i))) {
            const nl = code.indexOf('\n', i);
            const stop = nl === -1 ? length : nl;
            add('par', code.slice(i, stop));
            i = stop;
            continue;
          }
        }
        // Markup: `<div class="x">` — name, attributes, quoted values, angles.
        if (rules.markup && ch === '<') {
          let j = i + 1;
          add('pun', '<');
          if (code[j] === '/') {
            add('pun', '/');
            j += 1;
          }
          let tag = '';
          while (j < length && /[-A-Za-z0-9_:.]/.test(code[j])) {
            tag += code[j];
            j += 1;
          }
          add('kw', tag);
          while (j < length && code[j] !== '>') {
            if (space(code[j])) {
              add('', code[j]);
              j += 1;
              continue;
            }
            if (code[j] === '=' || code[j] === '/') {
              add('pun', code[j]);
              j += 1;
              continue;
            }
            if (code[j] === '"' || code[j] === "'") {
              const quote = code[j];
              let k = j + 1;
              while (k < length && code[k] !== quote) k += 1;
              add('str', code.slice(j, Math.min(k + 1, length)));
              j = Math.min(k + 1, length);
              continue;
            }
            let attribute = '';
            while (j < length && !space(code[j]) && code[j] !== '=' && code[j] !== '>') {
              attribute += code[j];
              j += 1;
            }
            add('par', attribute);
          }
          if (j < length) {
            add('pun', '>');
            j += 1;
          }
          i = j;
          continue;
        }
        // Strings: the longest quote pair wins, so `"""` is not three `"`.
        let quoted = false;
        for (const quote of rules.strings || []) {
          if (!code.startsWith(quote, i)) continue;
          let j = i + quote.length;
          while (j < length) {
            if (rules.escape && code[j] === '\\') {
              j += 2;
              continue;
            }
            if (!rules.escape && quote.length === 1 && code[j] === quote && code[j + 1] === quote) {
              j += 2;
              continue;
            }
            if (code.startsWith(quote, j)) {
              j += quote.length;
              break;
            }
            if (quote.length === 1 && code[j] === '\n') break;
            j += 1;
          }
          add('str', code.slice(i, Math.min(j, length)));
          i = Math.min(j, length);
          quoted = true;
          break;
        }
        if (quoted) continue;
        // Numbers, including 0x/0b forms, fractions and exponents.
        if (digit(ch)) {
          let j = i;
          if (ch === '0' && /[xX]/.test(code[j + 1] || '')) {
            j += 2;
            while (j < length && /[0-9a-fA-F_]/.test(code[j])) j += 1;
          } else if (ch === '0' && /[bB]/.test(code[j + 1] || '')) {
            j += 2;
            while (j < length && /[01_]/.test(code[j])) j += 1;
          } else {
            while (j < length && (digit(code[j]) || code[j] === '_')) j += 1;
            if (code[j] === '.' && digit(code[j + 1] || '')) {
              j += 1;
              while (j < length && (digit(code[j]) || code[j] === '_')) j += 1;
            }
            if (/[eE]/.test(code[j] || '') && /[0-9+-]/.test(code[j + 1] || '')) {
              j += 1;
              if (/[+-]/.test(code[j])) j += 1;
              while (j < length && digit(code[j])) j += 1;
            }
          }
          add('num', code.slice(i, j));
          i = j;
          continue;
        }
        // Identifiers: keywords, variables, and calls (a name before `(`).
        if (wordChar(ch)) {
          let j = i;
          while (j < length && wordChar(code[j])) j += 1;
          const text = code.slice(i, j);
          let k = j;
          while (k < length && (code[k] === ' ' || code[k] === '\t')) k += 1;
          if (isWord(text)) add('kw', text);
          else if (rules.dollars && ch === '$') add('par', text);
          else if (rules.keys && (code[j] === ':' || code[j] === '=')) add('par', text);
          else if (rules.calls && code[k] === '(') add('fn', text);
          else add('', text);
          i = j;
          continue;
        }
        // Whitespace and anything else: a run of operators/brackets reads better
        // as one token than as a span per character.
        if (space(ch)) {
          add('', ch);
          i += 1;
          continue;
        }
        let j = i;
        while (j < length && !space(code[j]) && !wordChar(code[j]) && code[j] !== '"' && code[j] !== "'" && code[j] !== '`') j += 1;
        add('pun', code.slice(i, j));
        i = j;
      }
      return out;
    }

    /**
     * Colour one fence. Unknown or plain languages come back untouched, so a
     * fence the scanner has no rules for renders exactly as it did before.
     */
    function renderCode(code, lang) {
      const rules = CODE_RULES[CODE_ALIASES[String(lang || '').toLowerCase()]] || CODE_RULES.plain;
      if (Object.keys(rules).length === 0) return code;
      const tokens = codeTokens(code, rules);
      if (tokens.length < 2) return code;
      return tokens.map(([kind, text], index) => (kind ? h('span', { className: TOKEN_CLASS[kind], key: `tok-${index}` }, text) : text));
    }

    /* Languages the shipped highlighter knows. An unknown info string is not
       shown raw — the toolbar falls back to the word "Code", exactly as the
       shipped one does, so ```` ```my notes ```` does not print as a fake tag. */
    const HIGHLIGHTED = new Set([
      'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'docker', 'dockerfile', 'go', 'graphql', 'html', 'http',
      'java', 'javascript', 'js', 'json', 'jsx', 'kotlin', 'less', 'lua', 'makefile', 'markdown', 'matlab', 'md', 'nginx',
      'objectivec', 'perl', 'php', 'plaintext', 'powershell', 'python', 'py', 'r', 'ruby', 'rust', 'sass', 'scss',
      'shell', 'sh', 'sql', 'swift', 'toml', 'ts', 'tsx', 'typescript', 'xml', 'yaml', 'yml', 'zsh',
    ]);

    /**
     * A fenced block, drawn like the shipped CodeBlock in its CodeCard variant —
     * the variant the chat surface actually uses, because `markdownLabels(t)`
     * hands CodeBlock a `toolbarLabels` object. That means: the header sits on
     * the SAME fill as the body (not the tinted banner of the other variant), the
     * language label is tertiary, and the actions are 24x24 icon buttons —
     * wrap, copy, download — with no visible chrome until hovered.
     *
     * The header is sticky but the card clips it (`overflow: hidden` in the
     * stylesheet), so it stops at the card's own edges instead of riding up over
     * the surrounding conversation.
     *
     * `navigator.clipboard` is unavailable in some embedded contexts, so the
     * fallback is the old textarea + execCommand path; a failed copy still flips
     * the icon, because a button that silently does nothing is worse.
     */
    function CodeBlock(props) {
      const [copied, setCopied] = React.useState(false);
      const [wrapped, setWrapped] = React.useState(true);
      const copy = () => {
        const done = () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(props.code).then(done, done);
            return;
          }
        } catch (error) {
          /* fall through to the textarea path */
        }
        try {
          const area = document.createElement('textarea');
          area.value = props.code;
          area.setAttribute('readonly', 'readonly');
          area.style.position = 'fixed';
          area.style.top = '-1000px';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          document.body.removeChild(area);
        } catch (error) {
          /* the icon still flips: the user asked, we tried */
        }
        done();
      };
      /* An object URL rather than a data URL: a long fence blows past what a
         data URL can carry, and the browser gets a real file name back. */
      const download = () => {
        try {
          const url = URL.createObjectURL(new Blob([props.code], { type: 'text/plain;charset=utf-8' }));
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = codeFileName(props.lang);
          anchor.rel = 'noopener';
          document.body.appendChild(anchor);
          anchor.click();
          document.body.removeChild(anchor);
          window.setTimeout(() => URL.revokeObjectURL(url), 0);
        } catch (error) {
          /* a browser that refuses the blob still leaves the code selectable */
        }
      };
      const label = HIGHLIGHTED.has(String(props.lang || '').toLowerCase()) ? props.lang : i18n('code.label');
      return h('div', { className: 'dswc-codeblock', 'data-wrap': wrapped ? 'true' : 'false' }, [
        h('div', { className: 'dswc-codeblock-banner', key: 'banner' }, [
          h('div', { className: 'dswc-codeblock-head', key: 'head' }, [
            h('div', { className: 'dswc-codeblock-heading', key: 'heading' }, [
              h('span', { className: 'dswc-codeblock-lang', key: 'lang' }, label),
            ]),
            h('div', { className: 'dswc-codeblock-actions', key: 'actions' }, [
              h(
                'button',
                {
                  className: 'dswc-codeblock-action',
                  key: 'wrap',
                  type: 'button',
                  'aria-label': wrapped ? i18n('code.unwrap') : i18n('code.wrap'),
                  'aria-pressed': wrapped,
                  onClick: () => setWrapped(!wrapped),
                },
                h(WrapIcon, { nowrap: wrapped }),
              ),
              h(
                'button',
                {
                  className: 'dswc-codeblock-action',
                  key: 'copy',
                  type: 'button',
                  'aria-label': copied ? i18n('code.copied') : i18n('code.copy'),
                  onClick: copy,
                },
                copied ? h(CheckIcon, {}) : h(CopyIcon, {}),
              ),
              h(
                'button',
                {
                  className: 'dswc-codeblock-action',
                  key: 'download',
                  type: 'button',
                  'aria-label': i18n('code.download'),
                  onClick: download,
                },
                h(DownloadIcon, {}),
              ),
            ]),
          ]),
        ]),
        h('pre', { className: 'dswc-pre', key: 'pre' }, h('code', { className: 'dswc-code' }, renderCode(props.code, props.lang))),
      ]);
    }

    /**
     * Block-level markdown: returns an array of React nodes.
     *
     * The shape mirrors the shipped `renderNode` switch, including the parts a
     * "good enough" subset usually drops and that real answers do use: setext
     * headings, hard breaks, indented code, task lists, `start` on an ordered
     * list, loose lists, and column alignment. A construct that is not handled
     * here falls back to literal text — never to a broken layout.
     */
    function renderRich(text, keyPrefix) {
      const lines = stripCitations(text).replace(/\r\n?/g, '\n').split('\n');
      const blocks = [];
      /* Footnote definitions are hoisted: the reference and its definition are
         rarely adjacent, so they are collected here and emitted as one section. */
      const definitions = new Map();
      const key = () => `${keyPrefix}-b${blocks.length}`;
      const itemPattern = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
      const taskPattern = /^\[([ xX])\]\s+(.*)$/;

      /* `3.` numbers from three. The shipped renderer sets `start` for exactly
         this case, so a list that begins mid-count does not restart at one. */
      const listStart = (marker, ordered) => (ordered ? Number(/^(\d+)/.exec(marker)[1]) : 1);

      /* A blank line does not end a list when another item follows at the same
         indent: that is a LOOSE list, one list whose items each keep a real
         paragraph. Returning -1 means the blank line really does end it. */
      const nextLooseItem = (from, baseIndent, ordered) => {
        let probe = from;
        while (probe < lines.length && !lines[probe].trim()) probe += 1;
        if (probe === from) return -1;
        const match = itemPattern.exec(lines[probe]);
        if (!match || match[1].length !== baseIndent || /\d/.test(match[2]) !== ordered) return -1;
        return probe;
      };

      const parseList = (start) => {
        const first = itemPattern.exec(lines[start]);
        const baseIndent = first[1].length;
        const ordered = /\d/.test(first[2]);
        const items = [];
        let loose = false;
        let i = start;
        while (i < lines.length) {
          const match = itemPattern.exec(lines[i]);
          if (!match) {
            const looseNext = lines[i].trim() ? -1 : nextLooseItem(i + 1, baseIndent, ordered);
            if (looseNext !== -1) {
              loose = true;
              i = looseNext;
              continue;
            }
            const previous = items[items.length - 1];
            if (previous && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
              previous.lines.push(lines[i].trim());
              i += 1;
              continue;
            }
            break;
          }
          if (match[1].length < baseIndent) break;
          if (match[1].length > baseIndent) {
            // A deeper item belongs to the item above it, whatever its marker:
            // `- 嵌套` under `2. 乙` is a nested list, not the end of this one.
            const nested = parseList(i);
            items[items.length - 1].children.push(nested.node);
            i = nested.next;
            continue;
          }
          if (/\d/.test(match[2]) !== ordered) break;
          const task = taskPattern.exec(match[3]);
          items.push({
            lines: task ? [task[2]] : [match[3]],
            checked: task ? task[1].toLowerCase() === 'x' : null,
            children: [],
          });
          i += 1;
        }
        const anyTask = items.some((item) => item.checked !== null);
        const children = items.map((item, index) => {
          const body = renderInline(softJoin(item.lines), `${keyPrefix}-li${index}`);
          if (item.checked === null) {
            return h('li', { key: `li${index}` }, [...body, ...item.children]);
          }
          const box = h('input', { key: 'box', type: 'checkbox', checked: item.checked, disabled: true });
          // The shipped renderer folds the checkbox into the item's first
          // paragraph; a loose item's paragraph is a real <p>, so the box has to
          // go inside it to sit on the same line as the text.
          if (loose) {
            return h('li', { className: 'task-list-item', key: `li${index}` }, [
              h('p', { key: 'p' }, [box, ' ', ...body]),
              ...item.children,
            ]);
          }
          return h('li', { className: 'task-list-item', key: `li${index}` }, [box, ' ', ...body, ...item.children]);
        });
        const tag = ordered ? 'ol' : 'ul';
        const props = { className: `dswc-md-list${anyTask ? ' contains-task-list' : ''}`, key: 'list' };
        if (ordered && listStart(first[2], ordered) !== 1) props.start = listStart(first[2], ordered);
        return { node: h(tag, props, children), next: i };
      };

      const splitRow = (line) =>
        line
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());

      /* `|:--|:-:|--:|` — the shipped renderer puts the alignment on each cell
         as an inline style, so a centered column is centered. */
      const alignments = (row) =>
        row.map((cell) => {
          const left = cell.startsWith(':');
          const right = cell.endsWith(':');
          if (left && right) return 'center';
          if (right) return 'right';
          if (left) return 'left';
          return null;
        });

      /* A hard break is two trailing spaces or a trailing backslash. The shipped
         renderer emits `[<br/>, "\n"]` for it, so the break is a real element
         and the source newline survives beside it. */
      const HARD_BREAK = /(?: {2,}|\\)$/;

      let index = 0;
      while (index < lines.length) {
        const line = lines[index];

        /* A fence of three or more backticks or tildes. The info string is only
           its first word — ```` ```js title=app.js ```` is javascript, not a tag
           called "js title=app.js". */
        const fence = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
        if (fence) {
          const marker = fence[1].charAt(0);
          const closer = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{3,}\\s*$`);
          const code = [];
          index += 1;
          while (index < lines.length && !closer.test(lines[index])) {
            code.push(lines[index]);
            index += 1;
          }
          index += 1; /* the closing fence, or end of input for a truncated stream */
          const lang = /^[\w-]+/.exec(fence[2].trim());
          // An empty fence draws a bare <pre>, not a card with an empty body.
          if (!code.length) {
            blocks.push(h('pre', { className: 'dswc-plain-pre', key: key() }, h('code', {}, '')));
            continue;
          }
          blocks.push(
            h(CodeBlock, {
              key: key(),
              code: code.join('\n'),
              lang: lang ? lang[0] : '',
            }),
          );
          continue;
        }

        /* Four spaces of indent inside a paragraph run is an indented code
           block. It has no info string, so it draws with no language label. */
        if (/^ {4,}\S/.test(line)) {
          const code = [];
          while (index < lines.length && (/^ {4,}/.test(lines[index]) || !lines[index].trim())) {
            code.push(lines[index].replace(/^ {4}/, ''));
            index += 1;
          }
          while (code.length && !code[code.length - 1].trim()) code.pop();
          blocks.push(h(CodeBlock, { key: key(), code: code.join('\n'), lang: '' }));
          continue;
        }

        if (!line.trim()) {
          index += 1;
          continue;
        }

        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
          blocks.push(h('hr', { className: 'dswc-hr', key: key() }));
          index += 1;
          continue;
        }

        /* A setext heading is the ATX form written with an underline: text
           followed by `===` (h1) or `---` (h2). It has to be tested before the
           thematic break, which `---` alone also matches. */
        if (index + 1 < lines.length && line.trim() && !/^\s*[-*+]\s/.test(line) && !/^\s*\|/.test(line)) {
          const underline = /^\s*(=+|-+)\s*$/.exec(lines[index + 1]);
          if (underline && !/^\s*$/.test(line)) {
            const level = underline[1].charAt(0) === '=' ? 1 : 2;
            blocks.push(
              h(`h${level}`, { className: `dswc-h${level}`, key: key() }, renderInline(line.trim(), key())),
            );
            index += 2;
            continue;
          }
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          const level = heading[1].length;
          blocks.push(
            h(`h${level}`, { className: `dswc-h${level}`, key: key() }, renderInline(heading[2].trim(), key())),
          );
          index += 1;
          continue;
        }

        if (/^\s*\|/.test(line) && index + 1 < lines.length && /^[\s:|-]*-[\s:|-]*$/.test(lines[index + 1].trim())) {
          const header = splitRow(line);
          const aligns = alignments(splitRow(lines[index + 1]));
          const rows = [];
          index += 2;
          while (index < lines.length && /^\s*\|/.test(lines[index])) {
            rows.push(splitRow(lines[index]));
            index += 1;
          }
          const cellStyle = (column) => (aligns[column] ? { textAlign: aligns[column] } : undefined);
          const head = h('thead', { key: 'head' }, [
            h(
              'tr',
              { key: 'tr' },
              header.map((cell, column) =>
                h('th', { key: `h${column}`, style: cellStyle(column) }, renderInline(cell, `th${column}`)),
              ),
            ),
          ]);
          const body = rows.map((row, rowIndex) =>
            h(
              'tr',
              { key: `r${rowIndex}` },
              header.map((_, column) =>
                h(
                  'td',
                  { key: `d${column}`, style: cellStyle(column) },
                  renderInline(row[column] || '', `td${rowIndex}-${column}`),
                ),
              ),
            ),
          );
          /* Four or more columns is wider than the reading column: the shipped
             renderer marks that case `md-table-wide` and only then scrolls. */
          const wide = (aligns.length || header.length) >= 4;
          blocks.push(
            h(
              'div',
              { className: 'dswc-table-wrap', 'data-wide': wide ? 'true' : 'false', key: key() },
              h('table', { className: 'dswc-table' }, [head, h('tbody', { key: 'body' }, body)]),
            ),
          );
          continue;
        }

        if (/^\s*>/.test(line)) {
          const quoted = [];
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            quoted.push(lines[index].replace(/^\s*>\s?/, ''));
            index += 1;
          }
          blocks.push(h('blockquote', { className: 'dswc-quote', key: key() }, renderRich(quoted.join('\n'), `${keyPrefix}-q${blocks.length}`)));
          continue;
        }

        if (itemPattern.test(line)) {
          const list = parseList(index);
          blocks.push(list.node);
          index = list.next;
          continue;
        }

        /* A footnote definition (`[^1]: text`) is collected into the trailing
           section rather than printed where it was written. */
        const footnote = /^\[\^([^\]\n]+)\]:\s*(.*)$/.exec(line);
        if (footnote) {
          definitions.set(footnote[1], footnote[2]);
          index += 1;
          continue;
        }

        const paragraph = [];
        while (index < lines.length) {
          const current = lines[index];
          if (
            !current.trim() ||
            /^\s*```/.test(current) ||
            /^\s*~~~/.test(current) ||
            /^\s*>/.test(current) ||
            /^#{1,6}\s+/.test(current) ||
            /^\s*(?:`{3,}|~{3,})/.test(current) ||
            /^\[\^[^\]\n]+\]:/.test(current) ||
            /^ {4,}\S/.test(current) ||
            itemPattern.test(current)
          ) {
            break;
          }
          paragraph.push(current);
          index += 1;
        }
        if (paragraph.length) {
          /* A hard break splits the paragraph into separate inline runs joined by
             a real <br>, the way the shipped renderer emits one; a soft break
             keeps the newline and lets the browser fold it to a space. */
          const runs = [[]];
          paragraph.forEach((line) => {
            const hard = HARD_BREAK.test(line);
            runs[runs.length - 1].push(line.replace(HARD_BREAK, '').trim());
            if (hard) runs.push([]);
          });
          const content = [];
          runs.forEach((run, runIndex) => {
            if (runIndex > 0) content.push(h('br', { key: `br${runIndex}` }));
            content.push(...renderInline(softJoin(run), `${keyPrefix}-p${blocks.length}-${runIndex}`));
          });
          blocks.push(h('p', { className: 'dswc-p', key: key() }, content));
        } else {
          index += 1;
        }
      }

      /* Footnotes close the answer the way the shipped renderer closes it: a
         `data-footnotes` section, one list item per definition, in first-use
         order. Definitions are hoisted here because the reference and the
         definition are rarely adjacent. */
      if (definitions.size) {
        const order = [];
        const seen = new Set();
        const scan = (node) => {
          if (typeof node === 'string') {
            for (const match of node.matchAll(/\[\^([^\]\n]+)\]/g)) {
              if (!seen.has(match[1])) {
                seen.add(match[1]);
                order.push(match[1]);
              }
            }
            return;
          }
          if (Array.isArray(node)) node.forEach(scan);
        };
        scan(text);
        const used = order.length ? order : [...definitions.keys()];
        blocks.push(
          h('section', { className: 'dswc-footnotes', 'data-footnotes': 'true', key: key() }, [
            h('hr', { key: 'rule' }),
            h(
              'ol',
              { key: 'list' },
              used.map((id, position) =>
                h('li', { key: `fn${position}`, id: `fn-${id}` }, renderInline(definitions.get(id) || '', `fn${position}`)),
              ),
            ),
          ]),
        );
      }
      return blocks;
    }

    /* ================================================================ *
     * Reasoning disclosure
     * ================================================================ */

    /* 14px line-art, traced from the shipped glyphs: the think swirl, and the
       two chevrons the disclosure row swaps in on hover and on open. */
    function ThinkIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1 }, [
        h('path', {
          key: 'a',
          d: 'M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z',
          stroke: 'currentColor',
        }),
        h('path', {
          key: 'b',
          d: 'M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z',
          stroke: 'currentColor',
        }),
        h('path', {
          key: 'c',
          d: 'M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z',
          fill: 'currentColor',
        }),
      ]);
    }

    function ChevronDownIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1 }, h('path', { d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6', stroke: 'currentColor' }));
    }

    function ChevronUpIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1 }, h('path', { d: 'M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10', stroke: 'currentColor' }));
    }

    /**
     * First line of the text, which is the settled summary.
     */
    function firstLine(text) {
      const newline = text.indexOf('\n');
      return newline === -1 ? text : text.slice(0, newline);
    }

    /**
     * First line of the last COMPLETED paragraph.
     *
     * While the chain is still streaming its final paragraph is half a sentence,
     * so the preview would flicker as each token lands. This walks the paragraph
     * breaks instead and keeps the newest paragraph that has already ended.
     */
    function latestCompletedParagraphFirstLine(text) {
      let summary = '';
      let paragraphStart = 0;
      const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
      for (;;) {
        const nextParagraph = separator.exec(text);
        const paragraphEnd = nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf('\n');
        const newline = text.indexOf('\n', paragraphStart);
        if (newline !== -1 && newline <= paragraphEnd) {
          const candidate = text.slice(paragraphStart, newline).trim();
          if (candidate !== '') summary = candidate;
        }
        if (nextParagraph === null) return summary;
        paragraphStart = nextParagraph.index + nextParagraph[0].length;
      }
    }

    /**
     * One assistant reasoning block, collapsed until the reader opens it.
     *
     * Drawn like the shipped ReasoningRow: a 24px line carrying the think glyph,
     * the word 思考, a 2px dot and the first line of the current paragraph, which
     * expands to the full chain in secondary typography. Collapsed is the default
     * because a synced chain can run to thousands of characters; nothing is
     * sliced, so opening it loses no text.
     */
    function ThinkRow(props) {
      const { text, running, t } = props;
      const [expanded, setExpanded] = React.useState(false);
      const summaryText = running ? latestCompletedParagraphFirstLine(text) : firstLine(text);
      // The summary is a single line, so the markers of a bolded phrase would
      // show as literal asterisks.
      const summary = summaryText.split('**').join('');
      const toggle = () => setExpanded((open) => !open);
      const collapsed = summary
        ? [
            h('span', { className: 'dswc-think-separator', key: 'sep', 'aria-hidden': 'true' }),
            h('span', { className: 'dswc-think-summary', key: 'sum' }, h('span', { className: 'dswc-think-summary-text' }, summary)),
          ]
        : null;
      const row = h(
        'div',
        {
          className: 'dswc-think-row',
          'data-disclosure-row': 'true',
          'data-expandable': 'true',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': expanded,
          onClick: toggle,
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggle();
          },
        },
        [
          h('span', { className: 'dswc-think-leading', key: 'lead' },
            expanded
              ? h(ChevronUpIcon, { key: 'up' })
              : [
                  h('span', { className: 'dswc-think-icon-idle', key: 'idle' }, h(ThinkIcon)),
                  h('span', { className: 'dswc-think-chevron-hover', key: 'hover' }, h(ChevronDownIcon)),
                ]),
          h('span', { className: 'dswc-think-title', key: 'title' }, t('think.title')),
          expanded ? null : collapsed,
        ],
      );
      return h(
        'div',
        {
          className: 'dswc-think',
          'data-variant': 'think',
          'data-state': running ? 'running' : 'ok',
          'data-expanded': expanded ? 'true' : undefined,
        },
        [
          running ? h('span', { className: 'dswc-visually-hidden', key: 'live' }, t('think.running')) : null,
          h('div', { className: 'dswc-think-disclosure', key: 'disc', 'data-open': expanded ? 'true' : undefined }, [
            row,
            expanded
              ? h('div', { className: 'dswc-think-body', key: 'body' }, h('div', { className: 'dswc-text' }, renderRich(text, 'think')))
              : null,
          ]),
        ],
      );
    }

    /**
     * The compact 聊天 / 工作 switch — presentational only.
     *
     * It is a segmented control over the surface axis; every transition goes
     * through `surfaceStore.select` so the guard, the persistence and the
     * location memory cannot be bypassed by one of the three places this is
     * mounted (header, sidebar page, sidebar row). DSH's own primitives behind
     * it: `layout.selectPanel(null)` is "return to the Conversation" (工作) and
     * selecting our id is the chat surface.
     */
    function ModeSwitch(props) {
      const { active, onSelect, t } = props;
      const button = (id, key) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dswc-seg-btn',
            'data-on': String(active === id),
            'aria-pressed': active === id,
            title: t(key === 'chat' ? 'mode.chat.hint' : 'mode.work.hint'),
            onClick: () => onSelect(id),
          },
          t(key === 'chat' ? 'mode.chat' : 'mode.work'),
        );
      return h('div', { className: 'dswc-seg dswc-mode-switch', role: 'tablist' }, [
        button('chat', 'chat'),
        button('work', 'work'),
      ]);
    }

    /* ================================================================ *
     * Sidebar glyph
     * ================================================================ */

    function PanelGlyph({ size, active }) {
      return h(
        'svg',
        {
          width: size || 18,
          height: size || 18,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { opacity: active ? 1 : 0.75 },
          'aria-hidden': 'true',
        },
        [
          h('path', {
            key: 'bubble',
            d: 'M21 12a8 8 0 0 1-8 8H8l-5 3 1.2-4.2A8 8 0 1 1 21 12Z',
          }),
          h('path', { key: 'mark', d: 'M8.5 11.5h7M8.5 8.5h4.5' }),
        ],
      );
    }

    /* ================================================================ *
     * Setup card
     * ================================================================ */

    function SetupCard({ t, state, actions }) {
      const [value, setValue] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);

      const save = async () => {
        if (!value.trim() || busy) return;
        setBusy(true);
        setNote(null);
        try {
          await request('/token', { method: 'POST', body: JSON.stringify({ token: value }) });
          setValue('');
          await actions.loadState();
          await actions.syncSessions({ silent: true });
          setNote({ tone: 'ok', text: '已连接。' });
        } catch (error) {
          setNote({ tone: 'error', text: describe(error) || i18n('error.save') });
        } finally {
          setBusy(false);
        }
      };

      const lead = React.useRef(null);
      React.useEffect(() => {
        if (lead.current) lead.current.focus();
      }, []);

      return h('div', { className: 'dswc-setup' }, [
        h('h2', { key: 'h' }, t('setup.title')),
        h('p', { key: 'p' }, t('setup.intro')),
        h(
          'ol',
          { key: 'ol' },
          [
            h('li', { key: 's1' }, t('setup.step1')),
            h('li', { key: 's2' }, [
              t('setup.step2'),
              h('code', { className: 'dswc-snippet', key: 'snip' }, t('setup.snippet')),
            ]),
            h('li', { key: 's3' }, t('setup.step3')),
          ],
        ),
        h('textarea', {
          key: 'ta',
          ref: lead,
          value,
          spellCheck: false,
          placeholder: t('setup.placeholder'),
          onChange: (event) => setValue(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
          },
        }),
        h('div', { className: 'dswc-setup-row', key: 'row' }, [
          h(
            'button',
            {
              type: 'button',
              className: 'dswc-btn',
              'data-variant': 'primary',
              disabled: busy || !value.trim(),
              onClick: save,
            },
            busy ? t('state.loading') : t('action.save'),
          ),
          state.error ? h('span', { className: 'dswc-note', 'data-tone': 'error' }, state.error) : null,
          note ? h('span', { className: 'dswc-note', 'data-tone': note.tone }, note.text) : null,
        ]),
        h('p', { key: 'privacy', style: { marginTop: '14px' } }, t('setup.privacy')),
      ]);
    }

    /* ================================================================ *
     * Chat panel
     * ================================================================ */

    function hasFileDrag(event) {
      const types = event && event.dataTransfer && event.dataTransfer.types;
      return Boolean(types && Array.from(types).includes('Files'));
    }

    function uploadDroppedFiles(fileList, upload) {
      for (const file of Array.from(fileList || [])) upload(file);
    }

    /** True when the transfer carries a folder — folders have no bytes to send. */
    function hasDroppedDirectory(dataTransfer) {
      for (const item of Array.from((dataTransfer && dataTransfer.items) || [])) {
        if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') continue;
        let entry = null;
        try {
          entry = item.webkitGetAsEntry();
        } catch {
          entry = null;
        }
        if (entry && entry.isDirectory) return true;
      }
      return false;
    }

    /**
     * Claim every file drop in the document while the chat surface is mounted.
     *
     * The panel's own zone only covers `.dswc-root`. A file released anywhere
     * else — the rail, the header, the padding around the panel — used to fall
     * through to the browser's default action, which navigates the whole window
     * to the dropped file and leaves a blank, unresponsive page. That is the
     * "拖进去就卡死" report.
     *
     * DSH's own composer installs the same document-level guard (see
     * `@deepseek-ai/dsh-client-ui-attachment`), but the composer is unmounted
     * while 聊天 owns the main panel, so the chat surface has to own it here.
     * Claiming in the capture phase also stops the shell from quietly attaching
     * the same file to the Agent composer behind this panel.
     */
    function installFileDropGuard(handlers) {
      const claim = (event) => {
        if (!hasFileDrag(event)) return null;
        event.preventDefault();
        event.stopImmediatePropagation();
        return event.dataTransfer;
      };
      const onDragEnter = (event) => {
        if (claim(event)) handlers.setActive(true);
      };
      const onDragOver = (event) => {
        const transfer = claim(event);
        if (!transfer) return;
        transfer.dropEffect = 'copy';
        handlers.setActive(true);
      };
      const onDragLeave = (event) => {
        if (!claim(event)) return;
        const leftViewport =
          event.clientX <= 0 ||
          event.clientY <= 0 ||
          event.clientX >= window.innerWidth ||
          event.clientY >= window.innerHeight;
        const onBackdrop = event.target === document.documentElement || event.target === document.body;
        if (onBackdrop && leftViewport) handlers.setActive(false);
      };
      const onDrop = (event) => {
        const transfer = event.dataTransfer;
        // `types` is the documented signal, but a browser that only fills it in
        // at drop time would let the file through to the default action — the
        // blank page this guard exists to prevent. `files` is the belt to that
        // braces, and the drop is the one event where guessing wrong is fatal.
        const carriesFiles = hasFileDrag(event) || Boolean(transfer && transfer.files && transfer.files.length);
        if (!carriesFiles) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        handlers.setActive(false);
        handlers.onFiles(transfer);
      };
      const reset = () => handlers.setActive(false);
      document.addEventListener('dragenter', onDragEnter, true);
      document.addEventListener('dragover', onDragOver, true);
      document.addEventListener('dragleave', onDragLeave, true);
      document.addEventListener('drop', onDrop, true);
      window.addEventListener('dragend', reset);
      window.addEventListener('blur', reset);
      return () => {
        document.removeEventListener('dragenter', onDragEnter, true);
        document.removeEventListener('dragover', onDragOver, true);
        document.removeEventListener('dragleave', onDragLeave, true);
        document.removeEventListener('drop', onDrop, true);
        window.removeEventListener('dragend', reset);
        window.removeEventListener('blur', reset);
      };
    }

    function ChatPanel(props) {
      const { t, actions, layout } = props;
      const state = useStore();
      const scrollRef = React.useRef(null);
      const textareaRef = React.useRef(null);
      /** Hidden input[type=file] behind the ＋ attachment button. */
      const fileInputRef = React.useRef(null);
      const [draggingFiles, setDraggingFiles] = React.useState(false);
      // First mount: read the host state, then pull the chat list.
      React.useEffect(() => {
        if (store.value.phase === 'loading') {
          (async () => {
            await actions.loadState();
            if (store.value.hasToken) await actions.syncSessions({ silent: true });
          })();
        }
      }, []);

      // A drop anywhere in the window belongs to this composer — see
      // installFileDropGuard for why the guard is document-wide.
      React.useEffect(
        () =>
          installFileDropGuard({
            setActive: setDraggingFiles,
            onFiles: (dataTransfer) => {
              // A folder has no bytes to send; refusing it beats uploading the
              // empty placeholder the browser hands over for a directory.
              if (hasDroppedDirectory(dataTransfer)) {
                store.set({ error: t('upload.folder') });
                return;
              }
              const files = Array.from((dataTransfer && dataTransfer.files) || []);
              if (!files.length) return;
              uploadDroppedFiles(files, actions.uploadAttachment);
            },
          }),
        [],
      );

      // Keep the thread pinned to the bottom while streaming.
      const streamText = state.stream ? state.stream.text : '';
      React.useEffect(() => {
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [streamText, state.activeId, state.loadingSession]);

      const sessions = filterSessions(state);

      const messages = state.activeId ? state.messages[state.activeId] || [] : [];
      const streamingHere =
        state.streaming && (!state.stream || !state.stream.sessionId || state.stream.sessionId === state.activeId);

      const submit = () => {
        const value = store.value.draft;
        const hasAttachments = store.value.attachments.some((attachment) => attachment.id);
        if ((!value.trim() && !hasAttachments) || state.streaming) return;
        actions.send(value);
      };

      if (state.phase === 'loading') {
        return h('div', { className: 'dswc-root' }, h('div', { className: 'dswc-center' }, t('state.loading')));
      }

      if (state.phase === 'error' && !state.hasToken) {
        return h(
          'div',
          { className: 'dswc-root' },
          h('div', { className: 'dswc-center' }, [
            h('div', { key: 'm' }, `${t('error.generic')}: ${state.error}`),
            h(
              'button',
              { key: 'b', type: 'button', className: 'dswc-btn', style: { marginTop: '10px' }, onClick: actions.loadState },
              t('action.reload'),
            ),
          ]),
        );
      }

      if (!state.hasToken) {
        return h(
          'div',
          { className: 'dswc-root' },
          h('div', { className: 'dswc-head' }, [
            h(
              'div',
              { className: 'dswc-brand', key: 'brand' },
              h('span', { className: 'dswc-brand-title' }, t('panel.title')),
              h('span', { className: 'dswc-brand-sub' }, t('panel.subtitle')),
            ),
            h('div', { className: 'dswc-spacer' }),
            h(ModeSwitch, {
              key: 'seg',
              t,
              active: 'chat',
              onSelect: (id) => surfaceStore.select(id === 'work' ? 'work' : 'chat'),
            }),
          ]),
          h(SetupCard, { t, state, actions }),
        );
      }

      const thread = [];
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const isUser = message.role === 'user';
        const parts = [];
        // Synced turns carry their reasoning in a separate THINK fragment.
        // It is shown the same way as a live turn's thinking, and kept out
        // of the body so a reopened session does not read as if the model
        // had said its private reasoning out loud.
        if (!isUser && message.reasoning) {
          parts.push(h(ThinkRow, { key: 'k', text: String(message.reasoning), running: false, t }));
        }
        // Attachments: synced turns carry file records, locally sent turns only
        // the display names. Chips read the same either way.
        const fileChips = isUser
          ? (Array.isArray(message.files) ? message.files : [])
              .map((file, i) => ({ label: file && file.fileName ? file.fileName : (message.names && message.names[i]) || (file && file.id) || '', size: file && file.size }))
              .filter((chip) => chip.label)
          : (message.names || []).map((name) => ({ label: name, size: null }));
        if (fileChips.length) {
          parts.push(
            h(
              'div',
              { className: 'dswc-chips', key: 'files' },
              fileChips.map((chip, i) =>
                h(
                  'span',
                  { className: 'dswc-chip', key: `${chip.label}:${i}` },
                  h('span', { className: 'dswc-chip-name', title: chip.label }, chip.label),
                  chip.size != null ? h('span', { className: 'dswc-chip-size' }, formatBytes(chip.size)) : null,
                ),
              ),
            ),
          );
        }
        parts.push(h('div', { className: 'dswc-text', key: 't' }, renderRich(String(message.content || ''), `m${index}`)));
        parts.push(...caveats(t, message, `m${index}`));
        // The question sits in a bubble on the right; the answer is plain prose
        // like the shipped Chat surface, which draws no bubble around an answer.
        thread.push(
          h('div', { className: 'dswc-turn', 'data-role': isUser ? 'user' : 'assistant', key: `m${index}` }, [
            isUser ? h('div', { className: 'dswc-bubble' }, parts) : h('div', { className: 'dswc-answer' }, parts),
          ]),
        );
      }
      if (streamingHere) {
        const live = state.stream || {};
        const parts = [];
        if (live.thinking) parts.push(h(ThinkRow, { key: 'k', text: String(live.thinking), running: true, t }));
        if (live.text) {
          parts.push(
            h('div', { className: 'dswc-text', key: 't' }, [
              ...renderRich(live.text, 'live'),
              h('span', { className: 'dswc-caret', key: 'caret' }),
            ]),
          );
        } else {
          parts.push(
            h(
              'div',
              { className: 'dswc-text', key: 't', style: { color: 'var(--dsw-alias-label-secondary)' } },
              [
                live.status === 'pow' || live.status === 'pow-solving'
                  ? t('state.solving')
                  : live.status === 'continuing'
                    ? t('state.continuing')
                    : live.thinking
                      ? t('state.thinking')
                      : t('state.loading'),
              ],
            ),
          );
        }
        parts.push(...caveats(t, live, 'live'));
        thread.push(
          h('div', { className: 'dswc-turn', 'data-role': 'assistant', key: 'live' }, [
            h('div', { className: 'dswc-answer' }, parts),
          ]),
        );
      }

      return h('div', { className: 'dswc-root', 'data-dragging': String(draggingFiles) }, [
        draggingFiles ? h('div', { className: 'dswc-drop-overlay', key: 'drop-overlay' }, t('upload.drop')) : null,
        h('div', { className: 'dswc-head', key: 'head' }, [
          h(
            'div',
            { className: 'dswc-brand', key: 'brand' },
            h('span', { className: 'dswc-brand-title' }, t('panel.title')),
            state.user && state.user.email
              ? h('span', { className: 'dswc-brand-sub' }, state.user.email)
              : h('span', { className: 'dswc-brand-sub' }, t('panel.subtitle')),
          ),
          state.valid === false
            ? h('span', { className: 'dswc-pill', 'data-tone': 'error', key: 'valid' }, t('error.token'))
            : null,
          state.hostStale
            ? h('span', { className: 'dswc-pill', 'data-tone': 'error', key: 'stale' }, t('error.stale'))
            : null,
          h('div', { className: 'dswc-spacer', key: 'sp' }),
          h(ModeSwitch, {
            key: 'seg',
            t,
            active: 'chat',
            onSelect: (id) => surfaceStore.select(id === 'work' ? 'work' : 'chat'),
          }),
          h(
            'button',
            { type: 'button', className: 'dswc-btn', key: 'refresh', onClick: () => actions.syncSessions({}) },
            t('action.refresh'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dswc-btn',
              key: 'new',
              onClick: () => {
                actions.startNewSession();
                if (textareaRef.current) textareaRef.current.focus();
              },
            },
            t('action.new'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dswc-btn',
              key: 'settings',
              title: state.tokenPreview ? `…${state.tokenPreview}` : '',
              onClick: async () => {
                await request('/token/clear', { method: 'POST' }).catch(() => {});
                store.set({ hasToken: false, phase: 'setup', sessions: [], messages: {}, activeId: null });
              },
            },
            t('action.clear'),
          ),
        ]),
        h('div', { className: 'dswc-body', key: 'body' }, [
          // The sidebar's 聊天 page owns the list whenever it exists; this column
          // is only the fallback for a composition without one.
          showSessionColumn(state)
            ? h('div', { className: 'dswc-side', key: 'side' }, [
                h(
                  'div',
                  { className: 'dswc-side-search', key: 'search' },
                  h('input', {
                    className: 'dswc-input',
                    value: state.query,
                    placeholder: t('search.placeholder'),
                    onChange: (event) => store.set({ query: event.target.value }),
                  }),
                ),
                h(
                  'div',
                  { className: 'dswc-list', key: 'list' },
                  sessions.length === 0
                    ? h(
                        'div',
                        { style: { padding: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
                        state.sessions.length ? t('state.noMatch') : t('state.empty.sessions'),
                      )
                    : sessions.map((session) =>
                        h(
                          'button',
                          {
                            type: 'button',
                            key: session.id,
                            className: 'dswc-item',
                            'data-on': String(session.id === state.activeId),
                            title: session.title || session.id,
                            onClick: () => actions.openSession(session.id),
                          },
                          session.title || session.id,
                        ),
                      ),
                ),
              ])
            : null,
          h('div', { className: 'dswc-main', key: 'main' }, [
            h(
              'div',
              { className: 'dswc-scroll', key: 'scroll', ref: scrollRef },
              state.error
                ? h('div', { className: 'dswc-note', 'data-tone': 'error' }, state.error)
                : null,
              thread.length === 0 && !streamingHere
                ? h(
                    'div',
                    { className: 'dswc-center' },
                    // A chat is selected but came back empty while the host is
                    // old: saying "pick a chat" would be a lie, and the real
                    // cause (a half-updated plugin) is the one thing the user
                    // cannot see from here.
                    state.hostStale && state.activeId
                      ? t('error.stale')
                      : state.loadingSession
                        ? t('state.loading')
                        : state.tabLive
                          ? t('state.empty.inSidebar')
                          : t('state.empty.messages'),
                  )
                : h('div', { className: 'dswc-thread' }, thread),
            ),
            h(
              'div',
              { className: 'dswc-composer', key: 'composer' },
              h('div', { className: 'dswc-composer-inner' }, [
                state.attachments.length
                  ? h(
                      'div',
                      { className: 'dswc-chips', key: 'chips', title: t('upload.kept') },
                      state.attachments.map((chip, index) =>
                        h(
                          'span',
                          { className: 'dswc-chip', 'data-status': chip.status, key: chip.uploadKey || `${chip.name}:${index}` },
                          h('span', { className: 'dswc-chip-name', title: chip.name }, chip.name),
                          h('span', { className: 'dswc-chip-size' }, chipStatusText(chip)),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dswc-chip-x',
                              title: t('upload.remove'),
                              onClick: () => actions.removeAttachment(index),
                            },
                            '×',
                          ),
                        ),
                      ),
                    )
                  : null,
                h('div', { className: 'dswc-box', key: 'box' }, [
                  h('textarea', {
                    key: 'ta',
                    ref: textareaRef,
                    className: 'dswc-textarea',
                    rows: 1,
                    value: state.draft,
                    placeholder: t('composer.placeholder'),
                    onChange: (event) => store.set({ draft: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        submit();
                      }
                    },
                  }),
                  h('div', { className: 'dswc-controls', key: 'controls' }, [
                    h('input', {
                      key: 'file',
                      ref: fileInputRef,
                      type: 'file',
                      multiple: true,
                      className: 'dswc-file-input',
                      tabIndex: -1,
                      'aria-hidden': 'true',
                      onChange: (event) => {
                        const files = Array.from(event.target.files || []);
                        for (const file of files) actions.uploadAttachment(file);
                        event.target.value = '';
                      },
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dswc-toggle',
                        key: 'attach',
                        title: t('upload.attach'),
                        'aria-label': t('upload.attach'),
                        disabled: state.attachments.length >= MAX_ATTACHMENTS,
                        onClick: () => {
                          if (fileInputRef.current) fileInputRef.current.click();
                        },
                      },
                      '＋',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dswc-toggle',
                        'data-on': String(state.thinking),
                        onClick: () => store.set({ thinking: !state.thinking }),
                      },
                      t('option.thinking'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dswc-toggle',
                        'data-on': String(state.search),
                        onClick: () => store.set({ search: !state.search }),
                      },
                      t('option.search'),
                    ),
                    h(
                      'select',
                      {
                        className: 'dswc-select',
                        value: state.modelType,
                        title: t('model.label'),
                        onChange: (event) => store.set({ modelType: event.target.value }),
                      },
                      state.modelTypes.map((model) =>
                        h('option', { key: model.id, value: model.id }, model.label || model.id),
                      ),
                    ),
                    h('div', { className: 'dswc-spacer', key: 'sp' }),
                    state.streaming
                      ? h(
                          'button',
                          { type: 'button', className: 'dswc-btn', key: 'stop', onClick: actions.stop },
                          t('action.stop'),
                        )
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'dswc-btn',
                            key: 'send',
                            'data-variant': 'primary',
                            disabled:
                              !state.draft.trim() &&
                              state.attachments.every((a) => !a.id || !fileUsable(a.status)),
                            onClick: submit,
                          },
                          t('action.send'),
                        ),
                  ]),
                ]),
              ]),
            ),
          ]),
        ]),
      ]);
    }

    /* ================================================================ *
     * Sidebar tab (聊天) — isolation for the web-chat history
     *
     * The 任务 / 频道 row is NOT part of DSH: the third-party plugin
     * @michengai/dsh-im-connect wraps the `sidebar.workspaces` occupant and
     * publishes an undocumented registry on it (`__dshNativeTabs`) so other
     * plugins can add tabs to that row. There is no supported slot for a tab
     * there, so we feature-detect the registry, insert a tab at order 10
     * (between 任务 and 频道's order 20), and degrade silently to the normal
     * 聊天 panel when the registry is absent — never assume im-connect exists.
     * ================================================================ */

    const TAB_ID = 'deepseek-web-chat-tab';
    const TAB_ORDER = 10;

    /** Locate the tab registry, wherever the wrapper parked it. */
    function findNativeTabs(ctx) {
      try {
        const read = ctx.slots.entriesOfSlot || ctx.slots.entries;
        const entries = (read && read.call(ctx.slots, 'sidebar.workspaces')) || [];
        for (const entry of entries) {
          const registry =
            (entry && entry.__dshNativeTabs) ||
            (entry && entry.component && entry.component.__dshNativeTabs);
          if (registry && typeof registry.insert === 'function') return registry;
        }
      } catch {
        /* the seat may not exist in this composition */
      }
      return null;
    }

    /** The tab's body: the same sessions, isolated to the sidebar's 聊天 page. */
    function ChatTab(props) {
      const { t, actions, layout } = props;
      const state = useStore();

      // This page is often the first surface the user sees, so it primes the
      // store exactly like the panel does instead of rendering an empty list.
      React.useEffect(() => {
        if (store.value.phase === 'loading') {
          (async () => {
            await actions.loadState();
            if (store.value.hasToken) await actions.syncSessions({ silent: true });
          })();
        }
      }, []);

      // Being MOUNTED is what makes this page the list's owner — not merely
      // being registered with the row. The row renders the official tree while
      // the sidebar is collapsed to the rail, and this body is unmounted then,
      // which hands the list back to the panel's own column. Reading it from
      // the effect (not from registration) is what keeps a list on screen in
      // every state.
      React.useEffect(() => {
        store.set({ tabLive: true });
        return () => store.set({ tabLive: false });
      }, []);

      const openChat = () => surfaceStore.select('chat');

      if (!state.hasToken) {
        return h('div', { className: 'dswc-tab' }, [
          h('div', { className: 'dswc-tab-hint', key: 'hint' }, t('tab.needToken')),
          h(
            'div',
            { className: 'dswc-tab-foot', key: 'foot' },
            h('button', { type: 'button', className: 'dswc-btn', onClick: openChat }, t('tab.openPanel')),
          ),
        ]);
      }

      const sessions = filterSessions(state);
      return h('div', { className: 'dswc-tab' }, [
        state.hostStale
          ? h('div', { className: 'dswc-tab-hint', 'data-tone': 'error', key: 'stale' }, t('error.stale'))
          : null,
        h(
          'div',
          { className: 'dswc-tab-search', key: 'search' },
          h('input', {
            className: 'dswc-input',
            value: state.query,
            placeholder: t('search.placeholder'),
            onChange: (event) => store.set({ query: event.target.value }),
          }),
        ),
        h(
          'div',
          { className: 'dswc-tab-list', key: 'list' },
          sessions.length === 0
            ? h('div', { className: 'dswc-tab-hint' }, state.sessions.length ? t('state.noMatch') : t('state.empty.sessions'))
            : sessions.map((session) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: session.id,
                    className: 'dswc-item',
                    'data-on': String(session.id === state.activeId),
                    title: session.title || session.id,
                    onClick: () => {
                      actions.openSession(session.id);
                      openChat();
                    },
                  },
                  session.title || session.id,
                ),
              ),
        ),
        h('div', { className: 'dswc-tab-foot', key: 'foot' }, [
          h(
            'button',
            {
              type: 'button',
              className: 'dswc-btn',
              key: 'sync',
              disabled: state.loadingSession,
              onClick: () => actions.syncSessions({}),
            },
            t('tab.sync'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dswc-btn',
              key: 'new',
              onClick: () => {
                actions.startNewSession();
                openChat();
              },
            },
            t('action.new'),
          ),
          h(
            'button',
            { type: 'button', className: 'dswc-btn', key: 'open', onClick: openChat },
            t('tab.openPanel'),
          ),
        ]),
      ]);
    }

    /**
     * Insert the tab into the sidebar row, if such a row exists.
     *
     * Re-inserting under the same id replaces the entry, which is how the
     * label follows a locale switch without leaking registrations.
     */
    function mountSidebarTab(ctx, t, actions, layout) {
      let installed = null;
      let installedLabel = '';
      let waited = 0;
      let remove = () => {};

      /**
       * The row renders 任务 first, then any registry tab, then 频道 — UNLESS
       * the wrapper's own 频道 tab has not been inserted yet, in which case its
       * hardcoded fallback button is drawn before every registry tab. Waiting a
       * moment for it keeps 聊天 in the middle as intended, and giving up after
       * ~2s keeps the tab working in compositions that have no 频道 at all.
       */
      const channelsPending = (registry) => {
        if (waited >= 8 || typeof registry.getTabs !== 'function') return false;
        const tabs = registry.getTabs();
        if (Array.isArray(tabs) && tabs.some((item) => item && item.id === 'channels')) return false;
        waited += 1;
        return true;
      };

      const install = () => {
        const registry = findNativeTabs(ctx);
        if (!registry) return false;
        if (channelsPending(registry)) return false;
        const label = t('tab.label');
        // Re-inserting the same tab on every peer notification would make the
        // host re-render the whole row for nothing, so only do it on a change.
        if (registry === installed && label === installedLabel) return true;
        remove = registry.insert({
          id: TAB_ID,
          label,
          order: TAB_ORDER,
          render: (props) => h(ChatTab, { ...props, t, actions, layout }),
        });
        installed = registry;
        installedLabel = label;
        // The list now has a home in the sidebar, so the panel stops drawing
        // its own copy of it.
        store.set({ tabInstalled: true });
        return true;
      };

      ctx.effect(() => {
        install();
        const onPeers = () => install();
        const stopLocale = ctx.locale.subscribe(onPeers);
        const stopSlots =
          typeof ctx.slots.subscribe === 'function' ? ctx.slots.subscribe('sidebar.workspaces', onPeers) : () => {};
        window.addEventListener('dsh-native-sidebar-change', onPeers);
        // Load order between plugins is not guaranteed: retry briefly, then
        // rely on the peer event for anything that happens later.
        let retries = 0;
        const timer = window.setInterval(() => {
          install();
          if (installed || ++retries >= 20) window.clearInterval(timer);
        }, 250);
        return () => {
          window.clearInterval(timer);
          window.removeEventListener('dsh-native-sidebar-change', onPeers);
          stopLocale();
          stopSlots();
          remove();
          installed = null;
          installedLabel = '';
          store.set({ tabInstalled: false });
        };
      }, 'deepseek-web-chat: sidebar tab');
    }

    /* ================================================================ *
     * Plugin entry
     * ================================================================ */

    /**
     * The always-visible header switch.
     *
     * `conversation.header.leading` is a free single seat that renders without
     * a Session, so the 聊天 / 工作 control is reachable even from the empty
     * state — this is the ChatGPT-desktop-like affordance.
     */
    function HeaderModeSwitch({ t, layout, usePanelInfo }) {
      const active = usePanelInfo((info) => info.activePanelId);
      const current = active === PANEL_ID ? 'chat' : 'work';
      // The rail can move the panel without this store being asked, so the
      // remembered surface is re-read from the live panel here: a reload then
      // lands on the surface the user is actually looking at.
      React.useEffect(() => {
        surfaceStore.syncSurface();
      }, [active]);
      return h(ModeSwitch, {
        t,
        active: current,
        onSelect: (id) => surfaceStore.select(id === 'chat' ? 'chat' : 'work'),
      });
    }

    /**
     * A command that switches surface, mirroring ChatGPT's
     * `codex.command.switchToChat / switchToWork` — it registers the same pair
     * with stable accelerators next to the visual toggle, which is why the
     * desktop app is usable without ever finding the header control.
     *
     * Alt+1 / Alt+2 there; Ctrl+1 / Ctrl+2 on macOS, where Control is the
     * platform convention for this kind of cycling.
     */
    function surfaceCommand(which) {
      const chat = which === 'chat';
      const win = { code: chat ? 'Digit1' : 'Digit2', modifiers: ['alt'] };
      const mac = { code: chat ? 'Digit1' : 'Digit2', modifiers: ['control'] };
      return {
        id: chat ? 'deepseek-web-chat.switchToChat' : 'deepseek-web-chat.switchToWork',
        label: () => i18n(chat ? 'mode.chat' : 'mode.work'),
        aliases: chat ? ['deepseek chat', '聊天'] : ['agent', 'codex', '工作'],
        defaults: {
          'desktop:macos': mac,
          'desktop:windows': win,
          'desktop:linux': win,
          'web:macos': win,
          'web:windows': win,
        },
        regions: ['page', 'editable', 'terminal'],
        modals: [],
        resolve: () => {
          if (!surfaceStore.layout) return { status: 'blocked', reason: i18n('mode.blocked') };
          // Selecting the surface already on screen is a no-op, so the command
          // stays handled rather than reporting itself unavailable.
          return { status: 'handled', run: () => surfaceStore.select(which) };
        },
      };
    }

    /**
     * Last line of defence for the panel.
     *
     * A throw anywhere inside ChatPanel's render replaces the whole conversation
     * area with nothing: the sidebar keeps working, the main region goes blank,
     * and every control in it ("new conversation", history, the 聊天/工作
     * switch) appears dead because the tree that owns those handlers is gone.
     * That is exactly what a stray `t()` in a factory-scope helper did (see
     * chipStatusText), and the only way out was a page reload.
     *
     * With this boundary a render error degrades to a visible card — including
     * the message and a way to retry — instead of a silent blank panel, so the
     * user can at least see what happened and keep using the rest of the app.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        // Kept in the console as well: the card is for the reader, the stack is
        // for whoever has to fix it.
        console.error('[dsh-deepseek-web-chat] panel render failed', error);
      }

      render() {
        if (!this.state.error) return this.props.children;
        const detail = describe(this.state.error) || String(this.state.error && this.state.error.message);
        return h('div', { className: 'dswc-root' }, [
          h('div', { className: 'dswc-crash', key: 'crash' }, [
            h('div', { className: 'dswc-crash-title', key: 'title' }, i18n('panel.crashed')),
            h('div', { className: 'dswc-crash-detail', key: 'detail' }, detail),
            h(
              'button',
              {
                className: 'dswc-btn',
                key: 'retry',
                type: 'button',
                onClick: () => this.setState({ error: null }),
              },
              i18n('panel.reset'),
            ),
          ]),
        ]);
      }
    }

    function apply(ctx) {
      injectStyles();
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-web-chat: dictionaries');
      const t = ctx.locale.bind(NS);
      i18n = t;

      const actions = {
        loadState,
        syncSessions,
        openSession,
        startNewSession,
        send,
        stop,
        uploadAttachment,
        removeAttachment,
      };
      const layout = ctx.layout;

      // 1) The sidebar rail glyph — the rail owns the button, this draws it.
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 5,
            label: () => t('panel.title'),
            locale: NS,
          },
          PanelGlyph,
        ),
      );

      // 2) The panel itself, under the matching keyed `main` seat. The boundary
      //    keeps a render error from turning the whole region into dead space.
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, (slotProps) =>
          h(PanelBoundary, null, h(ChatPanel, { ...slotProps, t, actions, layout })),
        ),
      );

      // 3) The 聊天 / 工作 switch, in the header seat that needs no Session.
      ctx.slots.inject('conversation.header.leading', () =>
        ctx.slots.register({ name: 'conversation.header.leading' }, (slotProps) =>
          h(HeaderModeSwitch, { t, layout, usePanelInfo: slotProps.usePanelInfo }),
        ),
      );

      // 4) The 聊天 page in the sidebar's 任务/频道 row, when such a row exists.
      mountSidebarTab(ctx, t, actions, layout);

      // 5) The surface axis: persist the choice, then hand the switch its layout
      //    handle. Registered shortcuts reuse the very same transition, so the
      //    accelerator and the header control can never drift apart.
      surfaceStore.bind(layout);
      surfaceStore.load();
      ctx.inject(['shortcuts'], (scope) => {
        for (const which of ['chat', 'work']) {
          scope.effect(
            () => scope.shortcuts.register(surfaceCommand(which)),
            `deepseek-web-chat: ${which} shortcut`,
          );
        }
      });

      // 6) Reopen the surface the user left. DSH's layout resets on reload, so
      //    this is the only thing that remembers it.
      surfaceStore.restoreOnBoot();
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale', 'layout'];
    return module.exports;
  },
});
