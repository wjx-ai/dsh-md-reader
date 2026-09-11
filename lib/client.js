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
		const PANEL_ID = "md-reader-panel";
		const WRAP_MARK = Symbol.for("dsh-md-reader.openWorkspacePath.wrap");
		const PANEL_WIDTH_MIN = 320;
		const PANEL_WIDTH_MAX = 860;
		const PANEL_WIDTH_DEFAULT = 460;

		/** @param value - 任意字符串。 @returns 是否是 Markdown 文件路径。 */
		function isMarkdownPath(value) {
			return MARKDOWN_PATH_PATTERN.test(String(value || "").trim());
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
			content: "",
			history: [],
			historyIndex: -1,
			siblings: []
		});

		/** 只持久化面板宽度（内容不落 localStorage）。 */
		const prefsStore = clientStore.createSnapshotStore({ width: PANEL_WIDTH_DEFAULT }, {
			persist: { name: "md-reader.panel.v1" }
		});

		/** 读回持久化宽度时做一次夹取。 */
		if (typeof prefsStore.getSnapshot().width !== "number") prefsStore.set({ width: PANEL_WIDTH_DEFAULT });

		/** @param px - 期望宽度。 @returns 夹取后的宽度。 */
		function clampWidth(px) {
			return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(px)));
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
				Object.defineProperty(namespace, "openWorkspacePath", {
					configurable: true,
					enumerable: true,
					get() {
						return async (request) => {
							const path = request && typeof request.path === "string" ? request.path : "";
							if (isMarkdownPath(path)) {
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
						if (!isMarkdownPath(path)) return;
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
						state.content = data.content || "";
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
				if (snapshot.path && !snapshot.content && !snapshot.loading) void loadDoc(snapshot.path, { push: false });
			};
			const setWidth = (px) => {
				prefsStore.set({ width: clampWidth(px) });
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
					const result = ctx.remote.session.openWorkspacePath({ path: String(path || "") });
					void Promise.resolve(result).catch((error) => console.error("[md-reader] 系统打开失败:", error));
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
					if (!snapshot.dir || !MARKDOWN_PATH_PATTERN.test(value)) return void 0;
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
							hooks: { reader: docStore, prefs: prefsStore, track: trackStore },
							openReader,
							closeReader,
							showReader,
							setWidth,
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
		 */
		const MdReaderPanel = react.memo(function MdReaderPanel(props) {
			const { useReader, usePrefs, useTrack, closeReader, showReader, setWidth, navigateHistory, reloadDoc, openNative, mentionsResolver } = props;
			const visible = useReader((state) => state.visible);
			const prefsWidth = usePrefs((state) => state.width);
			const track = useTrack((state) => state.width);
			const trackObserved = useTrack((state) => state.observed);
			const path = useReader((state) => state.path);
			const name = useReader((state) => state.name);
			const size = useReader((state) => state.size);
			const mtime = useReader((state) => state.mtime);
			const content = useReader((state) => state.content);
			const loading = useReader((state) => state.loading);
			const error = useReader((state) => state.error);
			const canBack = useReader((state) => state.historyIndex > 0);
			const canForward = useReader((state) => state.historyIndex >= 0 && state.historyIndex < state.history.length - 1);
			const sawTrackRef = react.useRef(false);

			react.useEffect(() => {
				ensureTrackObserver();
			}, []);

			// 轨道宽可用时精确贴合轨道；否则回退持久化宽度（浮层兼容模式）。
			const trackLive = trackObserved && track > 0;
			const width = trackLive ? track : prefsWidth;
			sawTrackRef.current = visible && trackLive ? true : visible ? sawTrackRef.current : false;

			// 会话切换等场景会让 AppFrame 收起详情轨道：此时跟随关闭面板。
			react.useEffect(() => {
				if (visible && sawTrackRef.current && !trackLive) closeReader();
			}, [visible, trackLive, closeReader]);

			react.useEffect(() => {
				if (visible && path && !content && !loading && !error) reloadDoc();
			}, [visible, path, content, loading, error, reloadDoc]);

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

			const body = loading
				? jsx("div", {
						style: { padding: "32px 24px", color: "var(--dsw-alias-label-tertiary, #8f959e)", fontSize: 13 },
						children: "加载中…"
					})
				: error
					? jsx("div", {
							style: {
								margin: "24px 20px",
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
					: jsx(primitives.MarkdownText, {
							text: content,
							streaming: false,
							labels: LABELS,
							fileMentions: mentionsResolver()
						});

			return jsx("div", {
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
							jsx("button", { key: "reload", type: "button", title: "重新读取", onClick: reloadDoc, style: headerButtonStyle, children: "⟳" }),
							jsx("button", { key: "native", type: "button", title: "用系统默认程序打开", onClick: () => openNative(path), style: headerButtonStyle, children: "↗" }),
							jsx("button", { key: "close", type: "button", title: "关闭", onClick: closeReader, style: headerButtonStyle, children: "×" })
						]
					}),
					jsx("div", {
						key: "subheader",
						title: path || "",
						style: {
							display: "flex",
							alignItems: "center",
							gap: 10,
							padding: "6px 14px",
							borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))",
							color: "var(--dsw-alias-label-caption, #8f959e)",
							fontSize: 11,
							whiteSpace: "nowrap",
							overflow: "hidden"
						},
						children: [
							jsx("span", { key: "path", style: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }, children: path || "" }),
							jsx("span", { key: "meta", style: { flexShrink: 0 }, children: formatMeta(size, mtime) })
						]
					}),
					jsx("div", {
						key: "body",
						style: {
							flex: 1,
							minHeight: 0,
							overflowY: "auto",
							overscrollBehavior: "contain"
						},
						children: body
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
