window.__ModuleLoader__.load({
	id: "dsh-md-reader",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsx = require("react/jsx-runtime").jsx || require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let clientStore = require("@deepseek-ai/dsh-client-store");
		//#region lib/types/client/index.js
		/**
		 * DSH Markdown 阅读插件 —— 浏览器半身（Client half）
		 *
		 * - 向 `shell.overlay`（全局浮层，点击穿透）注册一个右侧阅读面板与重新
		 *   打开的悬浮按钮；面板用平台静态表里的 MarkdownText 渲染正文，外观走
		 *   --dsw-alias-* 设计令牌，跟随明暗主题。
		 * - 拦截两层：
		 *   1) 包装 `ctx.remote.session.openWorkspacePath`——会话中所有文件链接
		 *      （正文里的文件提及按钮、消息尾部的产物文件 chips）的点击都会经
		 *      过它；目标是 Markdown 文件时改为在本面板打开，其余保持原生行为。
		 *   2) document 捕获阶段兜底监听：匹配 primitives 文件提及按钮
		 *      （class 含 fileMention、title 携带完整路径），远程包装失效时仍可
		 *      拦截。
		 * - 正文内容经本插件宿主半身的 /api/md-reader/file 读取（浏览器 cookie
		 *   鉴权随请求携带）。
		 */
		const MARKDOWN_PATH_PATTERN = /\.(md|markdown|mdown|mkd)$/i;
		const IMAGE_PATH_PATTERN = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
		/** 面板接管的文件路径（Markdown 与图片）。 */
		const READER_PATH_PATTERN = /\.(md|markdown|mdown|mkd|png|jpe?g|gif|webp|svg|bmp|ico|avif|html?htm?)$/i;
		const PANEL_ID = "md-reader-panel";
		const WRAP_MARK = Symbol.for("dsh-md-reader.openWorkspacePath.wrap");
		const PANEL_WIDTH_MIN = 320;
		const PANEL_WIDTH_MAX = 860;
		const PANEL_WIDTH_DEFAULT = 460;
		const FONT_SCALE_MIN = 0.7;
		const FONT_SCALE_MAX = 1.5;
		const FONT_SCALE_DEFAULT = 1;
		/** 自动跟随：面板可见时轮询宿主 meta 的间隔（毫秒）。 */
		const FOLLOW_INTERVAL_MS = 3000;

		/** @param value - 任意字符串。 @returns 是否是 Markdown 文件路径。 */
		function isMarkdownPath(value) {
			return MARKDOWN_PATH_PATTERN.test(String(value || "").trim());
		}

		/** @param value - 任意字符串。 @returns 是否是面板可接管的文件路径（md/图片）。 */
		function isReaderPath(value) {
			return READER_PATH_PATTERN.test(String(value || "").trim());
		}

		/** @param value - 任意字符串。 @returns 是否是图片路径。 */
		function isImagePath(value) {
			return IMAGE_PATH_PATTERN.test(String(value || "").trim());
		}

		/** 面板可见性、当前文档与历史的可观察存储。注意：首参是状态对象本身，不是工厂函数。 */
		const docStore = clientStore.createSnapshotStore({
			visible: false,
			loading: false,
			error: void 0,
			path: void 0,
			dir: void 0,
			name: void 0,
			size: 0,
			mtime: void 0,
			kind: "text",
			content: "",
			imageDataUrl: "",
			history: [],
			historyIndex: -1,
			siblings: []
		});

		/** 持久化面板偏好：宽度与字号缩放（内容不落 localStorage）。 */
		const prefsStore = clientStore.createSnapshotStore({
			width: PANEL_WIDTH_DEFAULT,
			fontScale: FONT_SCALE_DEFAULT
		}, {
			persist: { name: "md-reader.panel.v2" }
		});

		/** 读回持久化偏好时做类型校验与夹取。 */
		(function sanitizePrefs() {
			const snapshot = prefsStore.getSnapshot();
			const patch = {};
			if (typeof snapshot.width !== "number") patch.width = PANEL_WIDTH_DEFAULT;
			if (typeof snapshot.fontScale !== "number" || !Number.isFinite(snapshot.fontScale)) patch.fontScale = FONT_SCALE_DEFAULT;
			if (Object.keys(patch).length > 0) prefsStore.set(patch);
		})();

		/** @param px - 期望宽度。 @returns 夹取后的宽度。 */
		function clampWidth(px) {
			return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(px)));
		}

		/** @param scale - 期望字号缩放。 @returns 夹取后的缩放。 */
		function clampFontScale(scale) {
			return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(scale * 100) / 100));
		}

		/** @param lines - 围栏体内非空行。 @returns 是否整体构成一个 Markdown 表格。 */
		function isTableBlock(lines) {
			const nonEmpty = lines.filter((line) => line.trim() !== "");
			if (nonEmpty.length < 2) return false;
			for (let i = 0; i < nonEmpty.length; i += 1) {
				const trimmed = nonEmpty[i].trim();
				if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
				if (i === 1 && !/^\|[\s:|-]+\|$/.test(trimmed)) return false;
			}
			return true;
		}

		/**
		 * 把「包在代码围栏里的 Markdown 表格」还原为真表格：LLM 生成的文档常把
		 * 表格整个包进 ``` 围栏，MarkdownText 会把它渲染成带「复制代码」按钮的
		 * 代码块。仅当围栏体每一行都是表格行（| 开头 | 结尾、第二行为分隔行）
		 * 时才解开，其余围栏保持原样。
		 * @param markdown - 原始 Markdown 文本。
		 * @returns 展示用文本（围栏表格已解包）。
		 */
		function unwrapFencedTables(markdown) {
			const source = String(markdown || "");
			if (source.indexOf("|") < 0) return source;
			const lines = source.split(/\r?\n/);
			const out = [];
			let i = 0;
			while (i < lines.length) {
				const open = /^(\s{0,3})(`{3,}|~{3,})/.exec(lines[i]);
				if (!open) {
					out.push(lines[i]);
					i += 1;
					continue;
				}
				const fenceChar = open[2][0];
				const closePattern = new RegExp("^\\s{0,3}" + fenceChar + "{" + open[2].length + ",}\\s*$");
				let j = i + 1;
				const body = [];
				while (j < lines.length && !closePattern.test(lines[j])) {
					body.push(lines[j]);
					j += 1;
				}
				const closed = j < lines.length;
				if (closed && isTableBlock(body)) {
					for (const line of body) out.push(line);
					i = j + 1;
					continue;
				}
				const end = closed ? j : lines.length - 1;
				for (let k = i; k <= end; k += 1) out.push(lines[k]);
				i = end + 1;
			}
			return out.join("\n");
		}

		/**
		 * 以目录语义拼接路径（仅用于发起宿主解析请求，不做存在性判断）。
		 * @param dir - 基目录。
		 * @param token - 正文里写的相对/绝对路径记号。
		 * @returns 拼接结果；无法拼接时返回原记号。
		 */
		function joinPath(dir, token) {
			const value = String(token || "").trim();
			if (!dir || isAbsoluteLike(value)) return value;
			const separator = dir.includes("\\") ? "\\" : "/";
			const segments = dir.split(/[\\/]/);
			for (const part of value.split(/[\\/]/)) {
				if (part === "" || part === ".") continue;
				if (part === "..") {
					if (segments.length > 0) segments.pop();
					continue;
				}
				segments.push(part);
			}
			return segments.join(separator);
		}

		/** @param value - 路径记号。 @returns 是否是绝对路径（含 Windows 盘符）。 */
		function isAbsoluteLike(value) {
			return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\");
		}

		//#region apply
		/**
		 * 安装远程包装：Markdown 文件的打开请求改入本插件面板。
		 * @param ctx - 客户端根上下文。
		 * @param openReader - 打开阅读面板的动作。
		 * @returns 包装是否就位。
		 */
		function installRemoteWrap(ctx, openReader) {
			try {
				const namespace = ctx.remote && ctx.remote.session;
				if (!namespace) {
					console.warn("[md-reader] ctx.remote.session 不存在，跳过远程包装");
					return false;
				}
				if (namespace[WRAP_MARK] === true) return true;
				const original = namespace.openWorkspacePath;
				if (typeof original !== "function") {
					console.warn("[md-reader] openWorkspacePath 不是函数，跳过远程包装");
					return false;
				}
				nativeOpenOriginal = original;
				Object.defineProperty(namespace, "openWorkspacePath", {
					configurable: true,
					enumerable: true,
					get() {
						return async (request) => {
							const path = request && typeof request.path === "string" ? request.path : "";
							if (isReaderPath(path)) {
								try {
									openReader(path);
									return { ok: true, value: { opened: true } };
								} catch (error) {
									console.error("[md-reader] 面板打开失败，回退系统打开:", error);
									return original(request);
								}
							}
							return original(request);
						};
					}
				});
				try {
					Object.defineProperty(namespace, WRAP_MARK, { value: true, configurable: true });
				} catch {}
				console.log("[md-reader] openWorkspacePath 拦截已安装：Markdown 链接将打开右侧阅读面板");
				return true;
			} catch (error) {
				console.warn("[md-reader] 远程包装安装失败:", error);
				return false;
			}
		}

		/**
		 * 挂载 document 捕获阶段兜底监听（仅匹配 primitives 的文件提及按钮）。
		 * @param ctx - 客户端根上下文。
		 * @param openReader - 打开阅读面板的动作。
		 */
		function installClickFallback(ctx, openReader) {
			ctx.effect(() => {
				const handler = (event) => {
					try {
						if (event.defaultPrevented) return;
						const target = event.target;
						const button = target && target.closest ? target.closest("button") : null;
						if (!button) return;
						const className = typeof button.className === "string" ? button.className : "";
						if (!/(^|\s)\S*fileMention\S*(\s|$)/.test(className)) return;
						const path = button.getAttribute("title") || "";
						if (!isReaderPath(path)) return;
						event.stopPropagation();
						event.preventDefault();
						openReader(path);
					} catch (error) {
						console.error("[md-reader] 点击兜底处理失败:", error);
					}
				};
				document.addEventListener("click", handler, true);
				return () => document.removeEventListener("click", handler, true);
			}, "md-reader: click interception");
		}

		/**
		 * 客户端插件主体。
		 * @param ctx - 客户端根上下文。
		 */
		const inject = ["slots", "remote", "remote.session", "sessions", "layout"];

		/**
		 * 详情栏（右侧第三栏）宽度跟踪：栅格轨道由 AppFrame 的 layout store
		 * 驱动，面板通过 ResizeObserver 读取真实列宽并精确贴合；轨道关闭时
		 * 回退到本插件持久化的面板宽度。
		 */
		const trackStore = clientStore.createSnapshotStore({ width: 0, observed: false });

		/** 自动跟随开关与最近一次跟随刷新时刻（不落持久化）。 */
		const followStore = clientStore.createSnapshotStore({ on: true, flashedAt: 0 });

		/** 被包装前的原生 openWorkspacePath（供 ↗ 与能力回退使用，避免自截）。 */
		let nativeOpenOriginal = null;

		/** 把轨道宽度写入 trackStore（仅在数值变化时）。 */
		function setTrackWidth(width) {
			const snapshot = trackStore.getSnapshot();
			if (snapshot.width === width && snapshot.observed) return;
			trackStore.set({ width, observed: true });
		}

		/** 幂等安装轨道观察器：定位 AppFrame 的详情列元素并观察其尺寸。 */
		function ensureTrackObserver() {
			if (ensureTrackObserver.installed === true) return;
			ensureTrackObserver.installed = true;
			let attempts = 0;
			const tick = () => {
				const overlay = document.querySelector("[data-shell-overlay]");
				const column = overlay ? overlay.previousElementSibling : null;
				if (column) {
					const observer = new ResizeObserver(() => {
						setTrackWidth(Math.round(column.getBoundingClientRect().width));
					});
					observer.observe(column);
					setTrackWidth(Math.round(column.getBoundingClientRect().width));
					return;
				}
				attempts += 1;
				if (attempts <= 200) window.setTimeout(tick, 100);
			};
			try {
				tick();
			} catch {}
		}

		/** @param ctx - 客户端根上下文。 @returns 布局服务是否可用。 */
		function layoutAvailable(ctx) {
			try {
				return ctx.layout !== void 0 && typeof ctx.layout.openDetails === "function" && typeof ctx.layout.closeDetails === "function";
			} catch {
				return false;
			}
		}

		function apply(ctx) {
			const sessionCwd = () => {
				try {
					const snapshot = ctx.sessions.list.getSnapshot();
					const id = snapshot.current;
					const row = id === void 0 ? void 0 : snapshot.byId[id];
					return row && typeof row.cwd === "string" ? row.cwd : "";
				} catch {
					return "";
				}
			};

			/** 拉取并展示一个文档；push=false 用于历史导航。 */
			async function loadDoc(path, options) {
				const push = !(options && options.push === false);
				const base = options && typeof options.base === "string" ? options.base : sessionCwd();
				docStore.update((state) => {
					state.visible = true;
					state.loading = true;
					state.error = void 0;
				});
				try {
					const query = "/api/md-reader/file?path=" + encodeURIComponent(path) + (base ? "&base=" + encodeURIComponent(base) : "");
					const response = await fetch(query);
					let data;
					try {
						data = await response.json();
					} catch {}
					if (!response.ok || !data || data.ok !== true) {
						const message = data && data.error ? data.error : "HTTP " + String(response.status);
						if (isImagePath(path) && (response.status === 415 || /仅支持/.test(String(message)))) {
							// 宿主半身是旧版（无图片内联能力）：回退系统打开，不弹错误面板。
							console.warn("[md-reader] 宿主无图片预览能力，回退系统打开:", path);
							docStore.update((state) => {
								state.visible = false;
								state.loading = false;
							});
							if (layoutAvailable(ctx)) {
								try {
									ctx.layout.closeDetails();
								} catch {}
							}
							openNative(path);
							return;
						}
						docStore.update((state) => {
							state.loading = false;
							state.error = message;
						});
						return;
					}
					docStore.update((state) => {
						state.loading = false;
						state.error = void 0;
						state.path = data.path;
						state.dir = data.dir;
						state.name = data.name;
						state.size = data.size || 0;
						state.mtime = data.mtime;
						if (data.kind === "image") {
							state.kind = "image";
							state.imageDataUrl = "data:" + String(data.mime || "image/png") + ";base64," + String(data.data || "");
							state.content = "";
						} else {
							state.kind = "text";
							state.imageDataUrl = "";
							state.content = data.content || "";
						}
						if (push) {
							const trimmed = state.history.slice(0, state.historyIndex + 1);
							if (trimmed[trimmed.length - 1] !== data.path) {
								trimmed.push(data.path);
								state.history = trimmed;
								state.historyIndex = trimmed.length - 1;
							} else {
								state.historyIndex = trimmed.length - 1;
							}
						}
					});
					void loadSiblings(data.dir);
				} catch (error) {
					docStore.update((state) => {
						state.loading = false;
						state.error = String((error && error.message) || error);
					});
				}
			}

			/** 拉取当前文档目录下的 Markdown 同级文件（正文内提及的解析词表）。 */
			async function loadSiblings(dir) {
				if (!dir) return;
				try {
					const response = await fetch("/api/md-reader/list?dir=" + encodeURIComponent(dir));
					const data = await response.json();
					if (response.ok && data && data.ok === true) {
						docStore.update((state) => {
							state.siblings = data.entries || [];
						});
					}
				} catch {}
			}

			const openReader = (path, options) => {
				if (layoutAvailable(ctx)) {
					try {
						ctx.layout.openDetails();
					} catch (error) {
						window.__mdReaderLayoutError = String((error && error.stack) || error);
						console.warn("[md-reader] openDetails 失败:", error);
					}
				} else {
					window.__mdReaderLayoutError = "layout service unavailable";
				}
				ensureTrackObserver();
				void loadDoc(path, options);
			};
			const closeReader = () => {
				docStore.update((state) => {
					state.visible = false;
				});
				if (layoutAvailable(ctx)) {
					try {
						ctx.layout.closeDetails();
					} catch {}
				}
			};
			const showReader = () => {
				if (layoutAvailable(ctx)) {
					try {
						ctx.layout.openDetails();
					} catch {}
				}
				ensureTrackObserver();
				docStore.update((state) => {
					state.visible = true;
				});
				const snapshot = docStore.getSnapshot();
				if (snapshot.path && !snapshot.content && !snapshot.imageDataUrl && !snapshot.loading) void loadDoc(snapshot.path, { push: false });
			};
			const setWidth = (px) => {
				prefsStore.set({ width: clampWidth(px) });
			};
			const setFontScale = (scale) => {
				prefsStore.set({ fontScale: clampFontScale(scale) });
			};
			const setFollow = (on) => {
				followStore.set({ on: !!on });
			};
			/** 自动跟随：面板可见且开关开启时，检查磁盘 mtime，变了就无感重载。 */
			const checkFollow = async () => {
				const snapshot = docStore.getSnapshot();
				if (!snapshot.visible || !snapshot.path || snapshot.loading || !followStore.getSnapshot().on) return;
				try {
					const response = await fetch("/api/md-reader/file?path=" + encodeURIComponent(snapshot.path) + "&meta=1");
					const data = await response.json();
					if (response.ok && data && data.ok === true && data.mtime && data.mtime !== snapshot.mtime) {
						await loadDoc(snapshot.path, { push: false });
					}
				} catch {}
			};
			const navigateHistory = (delta) => {
				const snapshot = docStore.getSnapshot();
				const next = snapshot.historyIndex + delta;
				if (next < 0 || next >= snapshot.history.length) return;
				void loadDoc(snapshot.history[next], { push: false });
				docStore.update((state) => {
					state.historyIndex = next;
				});
			};
			const reloadDoc = () => {
				const snapshot = docStore.getSnapshot();
				if (snapshot.path) void loadDoc(snapshot.path, { push: false });
			};
			const openNative = (path) => {
				try {
					const fn = nativeOpenOriginal || (ctx.remote && ctx.remote.session ? ctx.remote.session.openWorkspacePath : void 0);
					if (typeof fn !== "function") {
						console.warn("[md-reader] 无可用的系统打开函数");
						return;
					}
					void Promise.resolve(fn({ path: String(path || "") })).catch((error) => console.error("[md-reader] 系统打开失败:", error));
				} catch (error) {
					console.error("[md-reader] 系统打开失败:", error);
				}
			};

			/** 正文内 inline-code 记号的同步解析：优先同级文件表，其次按当前目录拼接。 */
			const mentionsResolver = () => ({
				resolve(token) {
					const value = String(token || "").trim();
					if (!value) return void 0;
					const snapshot = docStore.getSnapshot();
					const siblings = snapshot.siblings || [];
					const lowered = value.toLowerCase();
					const matched = siblings.find((entry) => entry.path === value || entry.path.toLowerCase() === lowered)
						|| siblings.find((entry) => entry.name === value || entry.name.toLowerCase() === lowered);
					if (matched) {
						const target = matched.path;
						return {
							open: () => openReader(target),
							label: "在阅读面板中打开 " + matched.name,
							title: target
						};
					}
					if (!snapshot.dir || !READER_PATH_PATTERN.test(value)) return void 0;
					const joined = joinPath(snapshot.dir, value);
					return {
						open: () => openReader(joined),
						label: "在阅读面板中打开 " + value,
						title: joined
					};
				}
			});

			try {
				ctx.slots.inject("shell.overlay", () => ctx.slots.register(
					{
						name: "shell.overlay",
						id: PANEL_ID,
						order: 50,
						label: "Markdown 阅读器",
						inject: () => ({
							hooks: { reader: docStore, prefs: prefsStore, track: trackStore, follow: followStore },
							openReader,
							closeReader,
							showReader,
							setWidth,
							setFontScale,
							setFollow,
							checkFollow,
							navigateHistory,
							reloadDoc,
							openNative,
							mentionsResolver
						})
					},
					MdReaderPanel
				));
			} catch (error) {
				console.warn("[md-reader] 面板注册失败:", error);
			}

			try {
				ensureTrackObserver();
			} catch {}
			// 面板内表格版式覆写：宽表格不再 hover 才出现滚动，单元格允许收缩
			// 换行，让多列表格在窄栏里完整可见。
			try {
				if (document.getElementById("dsh-md-reader-style") === null) {
					const style = document.createElement("style");
					style.id = "dsh-md-reader-style";
					style.textContent = [
						// 表格呈现为 Word/Excel 风格的实线网格（表头底色 + 全边框 + 收缩换行）。
						".dsh-md-reader-body .md-table-wide{overflow-x:auto!important;padding-bottom:8px}",
						".dsh-md-reader-body table{border-collapse:collapse!important;width:100%!important;max-width:none!important;table-layout:fixed!important}",
						".dsh-md-reader-body th,.dsh-md-reader-body td{border:1px solid var(--dsw-alias-border-l3,#d0d3d9)!important;padding:6px 10px!important;min-width:0!important;max-width:none!important;word-break:break-word;overflow-wrap:anywhere;vertical-align:top;background:transparent!important}",
						".dsh-md-reader-body thead th{background:var(--dsw-alias-border-l3,#e6e8eb)!important;font-weight:600}",
						".dsh-md-reader-body table code{background:transparent!important;padding:0!important}",
						// 代码块不折行（横向滚动保对齐），并改用中文等宽字体让框线图精确对齐。
						".dsh-md-reader-body pre{white-space:pre!important;word-break:normal!important;overflow-wrap:normal!important;overflow-x:auto!important;font-family:'NSimSun','SimSun',monospace!important}",
						".dsh-md-reader-body pre code{white-space:pre!important;word-break:normal!important;font-family:inherit!important}"
					].join("\n");
					document.head.appendChild(style);
				}
			} catch {}
			const wrapped = installRemoteWrap(ctx, openReader);
			try {
				installClickFallback(ctx, openReader);
			} catch (error) {
				console.warn("[md-reader] 点击兜底监听安装失败:", error);
			}
			if (!wrapped) console.warn("[md-reader] 远程包装未生效，仅剩文件提及按钮的捕获兜底");
		}
		//#endregion

		//#region MdReaderPanel
		const LABELS = {
			footnotes: "脚注",
			code: { copyLabel: "复制代码", copiedLabel: "已复制" }
		};

		const headerButtonStyle = {
			appearance: "none",
			border: "none",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary, #646a73)",
			font: "inherit",
			fontSize: 15,
			lineHeight: 1,
			padding: "6px 8px",
			borderRadius: 6,
			cursor: "pointer"
		};

		/**
		 * 右侧阅读面板（含关闭态的悬浮入口）。
		 * 注入份额通过 slots.inject 的 inject 工厂以 props 形式送达。
		 *
		 * 宽度策略：打开文档时经 ctx.layout 打开 AppFrame 的真实详情栅格轨道
		 * （会话区随之收窄成三栏），面板用 ResizeObserver 跟随轨道宽度精确
		 * 贴合；轨道不可用（旧版本/无 layout 服务）时回退到本插件持久化宽度。
		 *
		 * 功能面：目录 TOC（渲染后扫描 h1–h6）、复制原文、字号缩放、自动跟随
		 * 磁盘变更（mtime 轮询）、图片内联预览、Esc 关闭、滚动位置保持。
		 */
		const MdReaderPanel = react.memo(function MdReaderPanel(props) {
			const { useReader, usePrefs, useTrack, useFollow, closeReader, showReader, setWidth, setFontScale, setFollow, checkFollow, navigateHistory, reloadDoc, openNative, mentionsResolver } = props;
			const visible = useReader((state) => state.visible);
			const prefsWidth = usePrefs((state) => state.width);
			const fontScale = usePrefs((state) => state.fontScale);
			const track = useTrack((state) => state.width);
			const trackObserved = useTrack((state) => state.observed);
			const followOn = useFollow((state) => state.on);
			const path = useReader((state) => state.path);
			const name = useReader((state) => state.name);
			const size = useReader((state) => state.size);
			const mtime = useReader((state) => state.mtime);
			const kind = useReader((state) => state.kind);
			const content = useReader((state) => state.content);
			const imageDataUrl = useReader((state) => state.imageDataUrl);
			const loading = useReader((state) => state.loading);
			const error = useReader((state) => state.error);
			const canBack = useReader((state) => state.historyIndex > 0);
			const canForward = useReader((state) => state.historyIndex >= 0 && state.historyIndex < state.history.length - 1);
			const [tocOpen, setTocOpen] = react.useState(false);
			const [outline, setOutline] = react.useState([]);
			const [copied, setCopied] = react.useState(false);
			const bodyRef = react.useRef(null);
			const headingElsRef = react.useRef([]);
			const scrollRef = react.useRef(0);
			const sawTrackRef = react.useRef(false);
			const copiedTimerRef = react.useRef(0);

			react.useEffect(() => {
				ensureTrackObserver();
			}, []);
			react.useEffect(
				() => () => {
					window.clearTimeout(copiedTimerRef.current);
				},
				[]
			);

			// 轨道宽可用时精确贴合轨道；否则回退持久化宽度（浮层兼容模式）。
			const trackLive = trackObserved && track > 0;
			const width = trackLive ? track : prefsWidth;
			sawTrackRef.current = visible && trackLive ? true : visible ? sawTrackRef.current : false;

			// 会话切换等场景会让 AppFrame 收起详情轨道：此时跟随关闭面板。
			react.useEffect(() => {
				if (visible && sawTrackRef.current && !trackLive) closeReader();
			}, [visible, trackLive, closeReader]);

			react.useEffect(() => {
				if (visible && path && !content && !imageDataUrl && !loading && !error) reloadDoc();
			}, [visible, path, content, imageDataUrl, loading, error, reloadDoc]);

			// 自动跟随：面板可见期间定期探测磁盘 mtime，变了就静默重载。
			react.useEffect(() => {
				if (!visible) return void 0;
				const timer = window.setInterval(() => {
					void checkFollow();
				}, FOLLOW_INTERVAL_MS);
				return () => window.clearInterval(timer);
			}, [visible, checkFollow]);

			// 文档切换回顶；同文档的跟随重载保留滚动位置不乱飞。
			react.useEffect(() => {
				scrollRef.current = 0;
				if (bodyRef.current) bodyRef.current.scrollTop = 0;
			}, [path]);
			react.useEffect(() => {
				if (bodyRef.current) bodyRef.current.scrollTop = scrollRef.current;
			}, [content]);

			// 目录：MarkdownText 不提供锚点 id，渲染完成后扫描正文 h1–h6 持有元素引用。
			react.useEffect(() => {
				if (kind !== "text" || loading || error) {
					setOutline([]);
					headingElsRef.current = [];
					return void 0;
				}
				const timer = window.setTimeout(() => {
					const root = bodyRef.current;
					if (!root) {
						setOutline([]);
						return;
					}
					const nodes = root.querySelectorAll("h1,h2,h3,h4,h5,h6");
					const items = [];
					const elements = [];
					for (let i = 0; i < nodes.length; i += 1) {
						const text = (nodes[i].textContent || "").trim();
						if (!text) continue;
						items.push({ level: Number(nodes[i].tagName.slice(1)) || 1, text });
						elements.push(nodes[i]);
					}
					headingElsRef.current = elements;
					setOutline(items);
				}, 160);
				return () => window.clearTimeout(timer);
			}, [content, kind, loading, error]);

			const copyContent = () => {
				const snapshot = docStore.getSnapshot();
				const value = String(snapshot.content || "");
				if (!value) return;
				const done = () => {
					setCopied(true);
					window.clearTimeout(copiedTimerRef.current);
					copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
				};
				const fallback = () => {
					try {
						const area = document.createElement("textarea");
						area.value = value;
						area.style.position = "fixed";
						area.style.opacity = "0";
						document.body.appendChild(area);
						area.select();
						let ok = false;
						try {
							ok = document.execCommand("copy");
						} catch {}
						document.body.removeChild(area);
						if (ok) done();
					} catch {}
				};
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done).catch(fallback);
					else fallback();
				} catch {
					fallback();
				}
			};

			const onKeyDown = (event) => {
				if (event.key !== "Escape") return;
				if (tocOpen) {
					setTocOpen(false);
					return;
				}
				closeReader();
			};

			// 围栏表格还原（内容仍是原文；复制原文/跟随均基于原文）。必须在
			// 任何提前 return 之前调用，保证 hooks 数量在两次渲染间一致。
			const display = react.useMemo(() => {
				try {
					return unwrapFencedTables(content);
				} catch {
					return content;
				}
			}, [content]);

			if (!visible) {
				// 详情轨道被占用（工具详情等）时收起悬浮入口，避免浮在别的面板上。
				if (trackObserved && track > 0) return null;
				return jsx("button", {
					type: "button",
					"aria-label": "Markdown 阅读器",
					title: "Markdown 阅读器",
					onClick: showReader,
					style: {
						position: "fixed",
						right: 20,
						bottom: 24,
						width: 40,
						height: 40,
						borderRadius: "50%",
						border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.10))",
						background: "var(--dsw-alias-bg-layer-1, #ffffff)",
						color: "var(--dsw-alias-label-primary, #1f2329)",
						fontSize: 18,
						lineHeight: 1,
						cursor: "pointer",
						pointerEvents: "auto",
						boxShadow: "0 6px 20px rgba(0,0,0,0.14)",
						zIndex: 60
					},
					children: "📖"
				});
			}

			const onDragStart = (event) => {
				event.preventDefault();
				const startX = event.clientX;
				const startWidth = width;
				const onMove = (moveEvent) => setWidth(startWidth + (startX - moveEvent.clientX));
				const onUp = () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
			};

			const isImage = kind === "image";
			const isHtml = kind === "html";
			const hasToc = !isImage && !isHtml && outline.length > 0;
			const smallButtonStyle = { ...headerButtonStyle, fontSize: 12, padding: "2px 7px" };

			const bodyInner = loading
				? jsx("div", {
						style: { padding: "32px 26px", color: "var(--dsw-alias-label-tertiary, #8f959e)", fontSize: 13 },
						children: "加载中…"
					})
				: error
					? jsx("div", {
							style: {
								margin: "24px 22px",
								padding: "12px 14px",
								borderRadius: 8,
								border: "1px solid var(--dsw-alias-state-error-primary, #d93026)",
								color: "var(--dsw-alias-state-error-primary, #d93026)",
								fontSize: 13,
								lineHeight: 1.6,
								whiteSpace: "pre-wrap",
								wordBreak: "break-all"
							},
							children: "无法阅读该文件：\n" + error
						})
					: isImage
						? jsx("div", {
								style: { minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
								children: jsx("img", {
									src: imageDataUrl,
									alt: name || "image",
									style: { maxWidth: "100%", maxHeight: "calc(100vh - 170px)", objectFit: "contain" }
								})
							})
						: isHtml
							? jsx("div", {
									style: { padding: "18px 0 48px", zoom: String(fontScale) },
									children: jsx("iframe", {
										srcdoc: content,
										title: name || "html preview",
										style: { width: "100%", height: "calc(100vh - 90px)", border: "none", display: "block" },
										sandbox: "allow-same-origin"
									})
								})
							: jsx("div", {
								style: { padding: "18px 28px 48px", maxWidth: 860, marginLeft: "auto", marginRight: "auto", zoom: String(fontScale) },
								children: jsx(primitives.MarkdownText, {
									text: display,
									streaming: false,
									labels: LABELS,
									fileMentions: mentionsResolver()
								})
							});

			const tocPanel = tocOpen && hasToc
				? jsx("div", {
						style: {
							position: "absolute",
							top: 10,
							left: 16,
							zIndex: 5,
							width: "min(300px, calc(100% - 32px))",
							maxHeight: "55%",
							overflowY: "auto",
							padding: "8px 6px",
							borderRadius: 10,
							border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.10))",
							background: "var(--dsw-alias-bg-layer-1, #ffffff)",
							boxShadow: "0 10px 30px rgba(0,0,0,0.16)"
						},
						children: outline.map((item, index) => jsx("button", {
							key: index,
							type: "button",
							title: item.text,
							onClick: () => {
								const el = headingElsRef.current[index];
								if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
							},
							style: {
								display: "block",
								width: "100%",
								textAlign: "left",
								appearance: "none",
								border: "none",
								background: "transparent",
								font: "inherit",
								fontSize: 12,
								lineHeight: 1.5,
								padding: "4px 8px",
								paddingLeft: 8 + Math.max(0, item.level - 1) * 14,
								borderRadius: 6,
								cursor: "pointer",
								color: "var(--dsw-alias-label-secondary, #555)",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							},
							children: item.text
						}))
					})
				: null;

			return jsx("div", {
				onKeyDown,
				style: {
					position: "fixed",
					top: 0,
					right: 0,
					bottom: 0,
					width,
					pointerEvents: "auto",
					display: "flex",
					flexDirection: "column",
					background: "var(--dsw-alias-bg-base, #ffffff)",
					borderLeft: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.10))",
					boxShadow: trackLive ? "none" : "-16px 0 40px rgba(0,0,0,0.14)",
					fontSize: 14
				},
				children: [
					trackLive ? null : jsx("div", {
						key: "handle",
						onPointerDown: onDragStart,
						style: {
							position: "absolute",
							left: -3,
							top: 0,
							bottom: 0,
							width: 6,
							cursor: "col-resize",
							zIndex: 2
						}
					}),
					jsx("div", {
						key: "header",
						style: {
							display: "flex",
							alignItems: "center",
							gap: 2,
							padding: "10px 12px 8px",
							borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))",
							background: "var(--dsw-alias-bg-layer-1, #ffffff)"
						},
						children: [
							jsx("button", { key: "back", type: "button", title: "后退", disabled: !canBack, onClick: () => navigateHistory(-1), style: { ...headerButtonStyle, opacity: canBack ? 1 : 0.4 }, children: "‹" }),
							jsx("button", { key: "forward", type: "button", title: "前进", disabled: !canForward, onClick: () => navigateHistory(1), style: { ...headerButtonStyle, opacity: canForward ? 1 : 0.4 }, children: "›" }),
							jsx("div", {
								key: "title",
								title: path || "",
								style: {
									flex: 1,
									minWidth: 0,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									fontWeight: 600,
									color: "var(--dsw-alias-label-primary, #1f2329)",
									padding: "0 6px"
								},
								children: name || "Markdown 阅读器"
							}),
							jsx("button", {
								key: "toc",
								type: "button",
								title: hasToc ? "目录（" + String(outline.length) + " 项）" : "本文档无标题",
								disabled: !hasToc,
								onClick: () => setTocOpen((value) => !value),
								style: {
									...headerButtonStyle,
									opacity: hasToc ? 1 : 0.35,
									color: tocOpen ? "var(--dsw-alias-brand-primary, #4d80ff)" : headerButtonStyle.color
								},
								children: "☰"
							}),
							jsx("button", {
								key: "copy",
								type: "button",
								title: isImage ? "图片无原文可复制" : copied ? "已复制" : "复制原文",
								disabled: isImage,
								onClick: copyContent,
								style: {
									...headerButtonStyle,
									opacity: isImage ? 0.35 : 1,
									color: copied ? "var(--dsw-alias-state-success-primary, #34a853)" : headerButtonStyle.color
								},
								children: copied ? "✓" : "⧉"
							}),
							jsx("button", { key: "reload", type: "button", title: "重新读取", onClick: reloadDoc, style: headerButtonStyle, children: "⟳" }),
							jsx("button", { key: "native", type: "button", title: "用系统默认程序打开", onClick: () => openNative(path), style: headerButtonStyle, children: "↗" }),
							jsx("button", { key: "close", type: "button", title: "关闭（Esc）", onClick: closeReader, style: headerButtonStyle, children: "×" })
						]
					}),
					jsx("div", {
						key: "subheader",
						title: path || "",
						style: {
							display: "flex",
							alignItems: "center",
							gap: 6,
							padding: "4px 12px",
							borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))",
							color: "var(--dsw-alias-label-caption, #8f959e)",
							fontSize: 11,
							whiteSpace: "nowrap",
							overflow: "hidden"
						},
						children: [
							jsx("span", { key: "path", style: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1 }, children: path || "" }),
							jsx("span", { key: "meta", style: { flexShrink: 0 }, children: formatMeta(size, mtime) }),
							jsx("span", { key: "spacer", style: { flex: 1 } }),
							jsx("button", { key: "fontDec", type: "button", title: "缩小字号（" + Math.round(fontScale * 100) + "%）", onClick: () => setFontScale(fontScale - 0.1), style: smallButtonStyle, children: "A-" }),
							jsx("button", { key: "fontInc", type: "button", title: "放大字号（" + Math.round(fontScale * 100) + "%）", onClick: () => setFontScale(fontScale + 0.1), style: smallButtonStyle, children: "A+" }),
							jsx("button", {
								key: "follow",
								type: "button",
								title: followOn ? "自动跟随文件变更：开（每 3 秒检查）" : "自动跟随文件变更：关",
								onClick: () => setFollow(!followOn),
								style: {
									...smallButtonStyle,
									color: followOn ? "var(--dsw-alias-brand-primary, #4d80ff)" : "var(--dsw-alias-label-tertiary, #b0b7c3)"
								},
								children: "⏱"
							})
						]
					}),
					jsx("div", {
						key: "body",
						ref: bodyRef,
						className: "dsh-md-reader-body",
						onScroll: (event) => {
							scrollRef.current = event.currentTarget.scrollTop;
						},
						style: {
							flex: 1,
							minHeight: 0,
							overflowY: "auto",
							overscrollBehavior: "contain",
							position: "relative"
						},
						children: [bodyInner, tocPanel]
					})
				]
			});
		});

		/** @param size - 字节数。 @param mtime - ISO 时间。 @returns 概要文本。 */
		function formatMeta(size, mtime) {
			const parts = [];
			if (typeof size === "number" && size > 0) {
				parts.push(size >= 1024 ? (size / 1024).toFixed(1) + " KB" : size + " B");
			}
			if (mtime) {
				try {
					parts.push(new Date(mtime).toLocaleString());
				} catch {}
			}
			return parts.join(" · ");
		}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		exports.MdReaderPanel = MdReaderPanel;
		return module.exports;
	}
});
