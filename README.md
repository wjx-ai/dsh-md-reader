# dsh-md-reader —— DSH Markdown 阅读插件

点击 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 会话中的 **Markdown
文件链接**（消息里的文件提及按钮、产物文件 chips）时，不再交给系统默认程序，
而是在 **浏览器右侧详情栏** 内以真正的三栏布局直接渲染阅读：

```
┌──────────┬────────────────────────────┬──────────────┐
│  侧边栏   │         会话区              │  MD 文档      │
│          │      （自动收窄）            │  （阅读面板）  │
└──────────┴────────────────────────────┴──────────────┘
```

![三栏阅读](docs/screenshot.png)

## 特性

- **真三栏布局**：打开文档时驱动 DSH 布局系统展开右侧详情轨道，会话区自动收窄；
  面板宽度精确跟随轨道（含框架自带的拖拽手柄调宽），不是浮层遮罩。
- **双半身架构**：宿主半身（Node）注册只读 HTTP 路由读文件；浏览器半身拦截点击、
  渲染面板，无需任何构建链（手写 lazy-CJS bundle）。
- **正文渲染复用平台组件**：使用 DSH 自带的 `MarkdownText` 渲染，明暗主题自动跟随。
- **正文内导航**：正文 inline-code 记号若匹配「当前文档同级的 Markdown 文件」或
  相对 MD 路径，点击后继续在面板内打开；面板自带历史后退/前进、重新读取。
- **保留原生出口**：标题栏 `↗` 随时用系统默认程序打开当前文件。
- **拦截互为兜底**：优先包装 `ctx.remote.session.openWorkspacePath`（覆盖一切走
  `openFile` 的链接），失败时退到 `document` 捕获阶段监听文件提及按钮。

## 安装

要求：Windows + 已安装并启动过一次 DSH（默认主目录 `%USERPROFILE%\.dsh`）。

**方式一：一键脚本**

```powershell
git clone https://github.com/wjx-ai/dsh-md-reader.git
cd dsh-md-reader
./install.ps1            # 自定义主目录：./install.ps1 -DshHome "D:\dsh-home"
```

脚本做两件事：复制插件到 `profiles\web\plugins\dsh-md-reader`；幂等地向
`profiles\web\cordis.patch.yml` 追加 insert 片段。它不修改 DSH 安装目录，
也不重启任何进程。

**方式二：手动**

1. 把本仓库的 `package.json` 与 `lib/` 复制到
   `%USERPROFILE%\.dsh\profiles\web\plugins\dsh-md-reader\`；
2. 在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 中追加：

   ```yaml
   - insert:
       - id: md-reader
         name: ./plugins/dsh-md-reader/lib/index.js
   ```

**生效**：DSH 运行中且 web profile `patchReload: live` 时，刷新浏览器页面即可；
否则重启 DSH 后刷新页面。

卸载：`./uninstall.ps1`（删除插件目录并清理 patch片段）。

## 使用

- 在会话里点击任意 `.md / .markdown / .mdown / .mkd / .txt` 文件链接 →
  右侧展开三栏阅读面板；
- 面板关闭后右下角保留 📖 悬浮入口，可重新打开最近文档；
- 面板内的文件提及（inline-code 文件名）可继续在面板内跳转，`‹ ›` 前进后退；
- 点击 × 或 `Esc` 外的任何时刻，均可用 `↗` 回到系统默认程序打开。

> 已知行为：右侧详情轨道由 DSH 布局系统管理，仅当「当前会话非空白」时可展开；
> 全新空白会话页（没有任何消息）下面板会退化为浮层样式。正常使用中
> （点击消息里的文件链接）会话必然非空白，三栏总是成立。

## 安全边界（宿主半身 API）

```
GET /api/md-reader/file?path=<绝对或相对路径>&base=<可选解析基目录>
GET /api/md-reader/list?dir=<目录>
```

- 扩展名白名单 `.md .markdown .mdown .mkd .txt`；单文件上限 2 MiB，列表上限 500 条；
- 相对路径只解析到「会话 cwd（base 参数）或已注册工作区根」之内；
- webServer 绑定非回环地址时，绝对路径额外要求落在已注册工作区根内；
- 路由挂在 `/api` 前缀下，经过 connection 服务的 Host/Origin 信任围栏与浏览器
  cookie 鉴权，未认证请求返回 401。

## 客户端 bundle 集成契约（E2E 踩坑实录）

手写 DSH client bundle 时，以下几点与直觉不符，错任何一条都会表现为
「插件加载成功但 slot 里只剩 `data-slot-error` 空壳」：

1. **`createSnapshotStore(state, options)` 的首参是状态对象本身**，不是
   zustand 风格的 `() => state` 工厂——传函数的话，函数本身会被当作初始
  状态存进去，之后一切 `update` 都静默失效。
2. **`require("react/jsx-runtime")` 必须解构**：`let jsx = require("react/jsx-runtime").jsx`。
   把命名空间对象绑定成 `jsx` 再调用，会在组件渲染时抛
   `TypeError: jsx is not a function`，被 SlotErrorBoundary 捕获后整个条目被
   abdicate（仅控制台一条 `slot entry crashed` 日志）。
3. **jsx 运行时的第三参是 `key` 而非 children**：children 必须放进 props
   （`jsx(type, { ...props, children })`），放在第三参会静默丢内容（不报错）。
4. **`MarkdownText` 的 `labels` 至少需要**
   `{ footnotes, code: { copyLabel, copiedLabel } }`，缺 `code` 会在渲染
   代码块时抛 `Cannot read properties of undefined (reading 'copyLabel')`。
5. **右侧详情栏是 single slot，被 ui-conversation 的 DetailsPanel 占用**，
   直接注册会整栏替换（丢失工具调用详情）。正确做法是：面板注册在
   `shell.overlay`（官方允许的 additive 列表槽），宽度与可见性与布局系统
   协同——打开文档时经 `ctx.layout.openDetails()` 展开真实栅格轨道，面板用
   `ResizeObserver` 跟随轨道宽度，关闭时 `closeDetails()` 收起。会话切换时
   AppFrame 会自动收起轨道，面板监听轨道宽度归零跟随关闭。
6. 调试手段：slot 崩溃只在控制台留下 `slot entry crashed in '<slot>':` 一条
   日志；可在 bundle 顶部临时安装 `console.error` 捕获 + 屏显来定位，定位后移除。

## 版本

- **1.1.0** 三栏布局：面板从固定浮层改为与 DSH 布局系统协同的详情栏形态；
  新增 📖 悬浮入口、会话切换自动收起；两半身 apply 全程防御式容错。
- **1.0.0** 首发版本：点击拦截 + 右侧浮层面板 + 只读路由。

## License

[MIT](LICENSE)
