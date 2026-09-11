/**
 * DSH Markdown 阅读插件 —— 宿主半身（Host half）
 *
 * 在 /api 前缀下注册两条只读 Fetch 路由（自带 Host/Origin 信任围栏与浏览器
 * cookie 鉴权，由 connection 服务统一执行）：
 *
 *   GET /api/md-reader/file?path=<绝对或相对路径>&base=<可选解析基目录>[&meta=1]
 *     读取一个 Markdown/文本文件，返回 { ok, kind:'text', path, dir, name, size, mtime, content }；
 *     图片（png jpg jpeg gif webp avif bmp ico svg）返回 { ok, kind:'image', mime, data(base64) }；
 *     meta=1 时只返回元信息（不含内容，供自动跟随轮询）。
 *
 *   GET /api/md-reader/list?dir=<目录>
 *     列出一个目录下的 Markdown 文件（供正文内文件提及的同步解析），
 *     返回 { ok, dir, entries: [{ name, path }], truncated }。
 *
 * 安全边界：
 *   - 扩展名白名单：.md .markdown .mdown .mkd .txt + 常见图片格式；
 *   - 大小上限：文本 2 MiB、图片 8 MiB、列表条目上限 500；
 *   - 相对路径只允许解析到「base 目录 / 已注册工作区根」之内（stat 命中为准）；
 *   - webServer 绑定到非回环地址时，绝对路径额外要求落在已注册工作区根内。
 *
 * 浏览器半身见 lib/client.js（dsh.client 声明见 package.json）。
 *
 * @module dsh-md-reader
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 允许阅读的扩展名（大小写不敏感）。 */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt']);
/** 允许内联预览的图片扩展名 → MIME。 */
const IMAGE_MIME = new Map([
	['.png', 'image/png'],
	['.jpg', 'image/jpeg'],
	['.jpeg', 'image/jpeg'],
	['.gif', 'image/gif'],
	['.webp', 'image/webp'],
	['.avif', 'image/avif'],
	['.bmp', 'image/bmp'],
	['.ico', 'image/vnd.microsoft.icon'],
	['.svg', 'image/svg+xml'],
]);
/** 单文件读取上限（文本）。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 单文件读取上限（图片内联预览）。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 目录列表条目上限。 */
const MAX_LIST_ENTRIES = 500;

/** @param status - HTTP 状态码。 @param payload - JSON 体。 */
function jsonResponse(status, payload) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	});
}

/** @param status - HTTP 状态码。 @param message - 面向人的错误说明。 */
function fail(status, message) {
	return jsonResponse(status, { ok: false, error: message });
}

/** @param value - 任意路径。 @returns 是否带允许阅读的扩展名。 */
function hasMarkdownExtension(value) {
	return MARKDOWN_EXTENSIONS.has(extname(String(value || '')).toLowerCase());
}

/**
 * 把一个请求目标解析为绝对路径。
 * 绝对路径原样 realpath；相对路径依次在 base 目录与各已注册工作区根下尝试，
 * 以 stat 命中常规文件为准。
 * @param rawPath - 查询参数 path。
 * @param baseDir - 查询参数 base（可选解析基目录，通常是当前会话 cwd）。
 * @param roots - 已注册工作区根目录数组。
 * @returns { path?: string, error?: string }
 */
async function resolveTarget(rawPath, baseDir, roots) {
	const raw = String(rawPath || '').trim();
	if (!raw) return { error: '缺少 path 参数' };
	let candidate = raw;
	if (!isAbsolute(candidate)) {
		const bases = [];
		if (baseDir) bases.push(baseDir);
		for (const root of roots) bases.push(root);
		let found;
		for (const base of bases) {
			if (!base) continue;
			const joined = join(base, candidate);
			try {
				const info = await stat(joined);
				if (info.isFile()) {
					found = joined;
					break;
				}
			} catch {}
		}
		if (!found) return { error: `相对路径无法在会话目录或已注册工作区中解析: ${raw}` };
		candidate = found;
	}
	try {
		return { path: await realpath(candidate) };
	} catch (error) {
		return {
			error: error && error.code === 'ENOENT'
				? `文件不存在: ${raw}`
				: `路径解析失败: ${String((error && error.message) || error)}`,
		};
	}
}

export default {
	inject: ['connection'],
	apply(ctx) {
		// 诊断标记：外部可通过该文件确认插件已在运行中的宿主内激活（热挂载验证）。
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			writeFileSync(
				join(here, '..', '.status.json'),
				`${JSON.stringify({ activatedAt: new Date().toISOString(), pid: process.pid, routes: ['/api/md-reader/file', '/api/md-reader/list'] }, null, 2)}\n`,
			);
		} catch {}

		/** 每请求刷新的已注册工作区根（注册表可能晚于本插件激活）。 */
		const workspaceRoots = () => {
			try {
				const registry = ctx.get('workspaceRegistry');
				if (!registry || typeof registry.list !== 'function') return [];
				return registry.list().map((workspace) => String(workspace.path)).filter(Boolean);
			} catch {
				return [];
			}
		};

		/** webServer 是否绑定在回环地址（缺服务时按回环处理）。 */
		const loopbackBind = () => {
			try {
				const webServer = ctx.get('webServer');
				return !webServer || webServer.host !== '0.0.0.0';
			} catch {
				return true;
			}
		};

		/** @param abs - 绝对路径。 @returns 是否落在某个工作区根内。 */
		const insideWorkspaceRoots = (abs) =>
			workspaceRoots().some((root) => {
				const rel = relative(root, abs);
				return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
			});

		/** GET /api/md-reader/file（meta=1 只回元信息；图片回 base64 内联数据） */
		async function handleFile(request) {
			try {
				const url = new URL(request.url);
				const resolved = await resolveTarget(url.searchParams.get('path'), url.searchParams.get('base') || '', workspaceRoots());
				if (resolved.error) return fail(400, resolved.error);
				const abs = resolved.path;
				const extension = extname(abs).toLowerCase();
				const mime = IMAGE_MIME.get(extension);
				if (!mime && !hasMarkdownExtension(abs)) {
					return fail(415, '仅支持阅读 Markdown/文本（.md .markdown .mdown .mkd .txt）与图片（png jpg jpeg gif webp avif bmp ico svg）');
				}
				let info;
				try {
					info = await stat(abs);
				} catch (error) {
					return fail(404, `读取文件信息失败: ${String((error && error.message) || error)}`);
				}
				if (!info.isFile()) return fail(400, '目标不是常规文件');
				const limit = mime ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
				if (info.size > limit) return fail(413, `文件过大（${info.size} 字节，上限 ${limit}）`);
				if (!loopbackBind() && !insideWorkspaceRoots(abs)) {
					return fail(403, '非回环绑定下仅允许阅读已注册工作区内的文件');
				}
				const meta = {
					ok: true,
					kind: mime ? 'image' : 'text',
					path: abs,
					dir: dirname(abs),
					name: basename(abs),
					size: info.size,
					mtime: info.mtime.toISOString(),
				};
				if (url.searchParams.has('meta')) return jsonResponse(200, meta);
				if (mime) {
					const buffer = await readFile(abs);
					return jsonResponse(200, { ...meta, mime, data: buffer.toString('base64') });
				}
				const content = await readFile(abs, 'utf8');
				return jsonResponse(200, { ...meta, content });
			} catch (error) {
				console.error('[md-reader] file route failed:', error);
				return fail(500, String((error && error.message) || error));
			}
		}

		/** GET /api/md-reader/list */
		async function handleList(request) {
			try {
				const url = new URL(request.url);
				const resolved = await resolveTarget(url.searchParams.get('dir'), '', workspaceRoots());
				if (resolved.error) return fail(400, resolved.error);
				const dir = resolved.path;
				let info;
				try {
					info = await stat(dir);
				} catch (error) {
					return fail(404, `读取目录信息失败: ${String((error && error.message) || error)}`);
				}
				if (!info.isDirectory()) return fail(400, '目标不是目录');
				if (!loopbackBind() && !insideWorkspaceRoots(dir)) {
					return fail(403, '非回环绑定下仅允许列出已注册工作区内的目录');
				}
				const dirents = await readdir(dir, { withFileTypes: true });
				const entries = dirents
					.filter((entry) => entry.isFile() && hasMarkdownExtension(entry.name))
					.map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
					.sort((a, b) => a.name.localeCompare(b.name));
				const truncated = entries.length > MAX_LIST_ENTRIES;
				return jsonResponse(200, {
					ok: true,
					dir,
					entries: truncated ? entries.slice(0, MAX_LIST_ENTRIES) : entries,
					truncated,
				});
			} catch (error) {
				console.error('[md-reader] list route failed:', error);
				return fail(500, String((error && error.message) || error));
			}
		}

		ctx.effect(
			() => {
				try {
					ctx.connection.fetch.register({ path: '/api/md-reader/file', methods: ['GET'], fetch: handleFile });
				} catch (error) {
					console.error('[md-reader] file route 注册失败:', error);
				}
			},
			'md-reader: file route',
		);
		ctx.effect(
			() => {
				try {
					ctx.connection.fetch.register({ path: '/api/md-reader/list', methods: ['GET'], fetch: handleList });
				} catch (error) {
					console.error('[md-reader] list route 注册失败:', error);
				}
			},
			'md-reader: list route',
		);
		console.log('[md-reader] routes registered: /api/md-reader/file, /api/md-reader/list');
	},
};
