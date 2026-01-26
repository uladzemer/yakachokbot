import {
	mkdir,
	readdir,
	readFile,
	rm,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { InlineKeyboard, InputFile } from "grammy"
import { cookieFormatExample, mergeCookieContent } from "./cookies"
import { deleteMessage, errorMessage, notifyAdminError } from "./bot-util"
import { cobaltMatcher, cobaltResolver } from "./cobalt"
import { bold, code, link, t, tiktokArgs, impersonateArgs, jsRuntimeArgs } from "./constants"
import {
	ADMIN_ID,
	ALLOW_GROUPS,
	ALWAYS_DOWNLOAD_BEST,
	API_ROOT,
	CLEANUP_INTERVAL_HOURS,
	CLEANUP_MAX_AGE_HOURS,
	COOKIE_FILE,
	cookieArgs,
	WHITELISTED_IDS,
} from "./environment"
import { getThumbnail, urlMatcher, getVideoMetadata, generateThumbnail } from "./media-util"
import { Queue } from "./queue"
import { bot } from "./setup"
import { translateText } from "./translate"
import { Updater } from "./updater"
import { chunkArray, removeHashtagsMentions, cleanUrl, cutoffWithNotice } from "./util"
import { execFile, spawn, type ExecFileOptions } from "node:child_process"

const TEMP_PREFIX = "yakachokbot-"
const cleanupIntervalHours = Number.isFinite(CLEANUP_INTERVAL_HOURS)
	? Math.max(1, CLEANUP_INTERVAL_HOURS)
	: 6
const cleanupMaxAgeHours = Number.isFinite(CLEANUP_MAX_AGE_HOURS)
	? Math.max(1, CLEANUP_MAX_AGE_HOURS)
	: 12

const notifyAdminLog = async (title: string, error: unknown) => {
	try {
		const details =
			error instanceof Error ? error.stack || error.message : String(error)
		const message = [
			bold(title),
			code(cutoffWithNotice(details)),
		].join("\n\n")
		await bot.api.sendMessage(ADMIN_ID, message, { parse_mode: "HTML" })
	} catch (notifyError) {
		console.error("Failed to notify admin:", notifyError)
	}
}

process.on("unhandledRejection", (reason) => {
	notifyAdminLog("Unhandled promise rejection", reason)
})

process.on("uncaughtException", (error) => {
	notifyAdminLog("Uncaught exception", error)
})

const cleanupTempDirs = async () => {
	const now = Date.now()
	const maxAgeMs = cleanupMaxAgeHours * 60 * 60 * 1000
	try {
		const entries = await readdir("/tmp", { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			if (!entry.name.startsWith(TEMP_PREFIX)) continue
			const fullPath = resolve("/tmp", entry.name)
			try {
				const info = await stat(fullPath)
				if (now - info.mtimeMs < maxAgeMs) continue
				await rm(fullPath, { recursive: true, force: true })
			} catch (error) {
				console.error("Temp cleanup error:", error)
			}
		}
	} catch (error) {
		console.error("Temp cleanup error:", error)
	}
}

const execFilePromise = (
	command: string,
	args: string[],
	options: ExecFileOptions & { signal?: AbortSignal } = {},
) => {
	return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		let settled = false
		const execOptions: ExecFileOptions & { signal?: AbortSignal } = {
			encoding: "utf8",
			...options,
		}
		const child = execFile(command, args, execOptions, (error, stdout, stderr) => {
			if (settled) return
			settled = true
			if (error) return reject(error)
			resolve({ stdout: String(stdout), stderr: String(stderr) })
		})

		const signal = options.signal
		if (!signal) return
		if (signal.aborted) {
			settled = true
			child.kill()
			return reject(new Error("Cancelled"))
		}
		const onAbort = () => {
			if (settled) return
			settled = true
			child.kill()
			reject(new Error("Cancelled"))
		}
		signal.addEventListener("abort", onAbort, { once: true })
		child.on("exit", () => signal.removeEventListener("abort", onAbort))
	})
}

const updateMessage = (() => {
	const lastUpdates = new Map<number, number>()
	return async (ctx: any, messageId: number, text: string) => {
		const now = Date.now()
		const last = lastUpdates.get(messageId) || 0
		if (now - last < 1500) return
		lastUpdates.set(messageId, now)
		try {
			await ctx.api.editMessageText(ctx.chat.id, messageId, text, {
				parse_mode: "HTML",
			})
		} catch {}
	}
})()

const sendStatusMessage = async (
	ctx: any,
	text: string,
	replyToMessageId?: number,
	threadId?: number,
) => {
	try {
		return await ctx.reply(text, {
			reply_to_message_id: replyToMessageId,
			message_thread_id: threadId,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (message.includes("message to be replied not found")) {
			return await ctx.reply(text, {
				message_thread_id: threadId,
			})
		}
		throw error
	}
}

const lastBotMenuMessages = new Map<string, number>()

const getChatKey = (ctx: any) => {
	const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id
	if (!chatId) return undefined
	const threadId =
		ctx.message?.message_thread_id ||
		ctx.callbackQuery?.message?.message_thread_id
	return `${chatId}:${threadId ?? "main"}`
}

const deletePreviousMenuMessage = async (ctx: any) => {
	const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id
	if (!chatId) return
	const key = getChatKey(ctx)
	if (!key) return
	const previousId = lastBotMenuMessages.get(key)
	if (!previousId) return
	try {
		await ctx.api.deleteMessage(chatId, previousId)
	} catch {}
	lastBotMenuMessages.delete(key)
}

const trackMenuMessage = (ctx: any, message: any) => {
	const key = getChatKey(ctx)
	if (!key || !message?.message_id) return
	lastBotMenuMessages.set(key, message.message_id)
}

const deleteUserMessage = async (ctx: any) => {
	if (!ctx.message?.message_id) return
	try {
		await ctx.deleteMessage()
	} catch {}
}

const spawnPromise = (
	command: string,
	args: string[],
	onData?: (data: string) => void,
	signal?: AbortSignal,
) => {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Cancelled"))
		let stderrBuffer = ""
		let stdoutBuffer = ""
		const process = spawn(command, args)
		process.stdout.on("data", (d) => {
			const text = d.toString()
			onData?.(text)
			stdoutBuffer = (stdoutBuffer + text).slice(-4000)
		})
		process.stderr.on("data", (d) => {
			const text = d.toString()
			onData?.(text)
			stderrBuffer = (stderrBuffer + text).slice(-4000)
		})
		const onAbort = () => {
			process.kill()
			reject(new Error("Cancelled"))
		}
		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true })
			process.on("close", () => signal.removeEventListener("abort", onAbort))
		}
		process.on("close", (code) => {
			if (code === 0) return resolve()
			if (stderrBuffer.trim() || stdoutBuffer.trim()) {
				console.error("[ERROR] Process failed", {
					command,
					args,
					code,
					stderrTail: stderrBuffer.trim(),
					stdoutTail: stdoutBuffer.trim(),
				})
			}
			const details = stderrBuffer.trim() || stdoutBuffer.trim()
			reject(
				new Error(
					`Process exited with code ${code}${details ? `: ${details}` : ""}`,
				),
			)
		})
	})
}

const getFlatPlaylistEntries = async (
	url: string,
	args: string[],
	signal?: AbortSignal,
) => {
	try {
		const normalizedPlaylistUrl = url.replace(/\/+$/, "")
		const isErome = /(^|\.)erome\.com$/i.test(new URL(normalizedPlaylistUrl).hostname)
		const { stdout } = await execFilePromise(
			"yt-dlp",
			[
				url,
				"--flat-playlist",
				"--dump-json",
				"--no-warnings",
				"-q",
				"--no-progress",
				...args,
			],
			{ signal },
		)
		const lines = stdout.split("\n").filter((l) => l.trim().length > 0)
		const entries: { url: string; title?: string }[] = []
		const seen = new Set<string>()
		for (const line of lines) {
			try {
				const data = JSON.parse(line)
				if (data?._type === "playlist") continue
				const rawUrl =
					typeof data?.url === "string" && /^https?:\/\//i.test(data.url)
						? data.url
						: data?.webpage_url
				if (!rawUrl) continue
				const normalized = String(rawUrl).trim()
				const normalizedEntry = normalized.replace(/\/+$/, "")
				if (normalizedEntry === normalizedPlaylistUrl) continue
				if (!normalized || seen.has(normalized)) continue
				seen.add(normalized)
				let title = data?.title
				if (isErome) {
					const playlistTitle =
						typeof data?.playlist_title === "string"
							? data.playlist_title
							: typeof data?.playlist === "string"
								? data.playlist
								: ""
					if (playlistTitle) {
						title = `${playlistTitle} (${entries.length + 1})`
					}
				}
				entries.push({ url: normalized, title })
			} catch {}
		}
		return entries
	} catch (error) {
		console.warn("[WARN] Failed to get flat playlist entries", {
			url: cleanUrl(url),
			error: error instanceof Error ? error.message : String(error),
		})
		return []
	}
}

const safeGetInfo = async (
	url: string,
	args: string[],
	signal?: AbortSignal,
	skipJsRuntime = false,
) => {
	const runtimeArgs =
		skipJsRuntime || args.includes("--js-runtimes")
			? args
			: [...jsRuntimeArgs, ...args]
	const runtimeArgsWithCache = runtimeArgs.includes("--no-cache-dir")
		? runtimeArgs
		: [...runtimeArgs, "--no-cache-dir"]
	console.log("Running yt-dlp with:", runtimeArgsWithCache)
	const { stdout } = await execFilePromise(
		"yt-dlp",
		[url, ...runtimeArgsWithCache],
		{ signal },
	)
	// Split by newline and try to parse the first valid JSON line
	const lines = stdout.split("\n").filter((l) => l.trim().length > 0)
	for (const line of lines) {
		try {
			return JSON.parse(line)
		} catch {}
	}
	throw new Error("No valid JSON found in yt-dlp output")
}

const safeGetInfoWithFallback = async (
	url: string,
	args: string[],
	signal?: AbortSignal,
	skipJsRuntime = false,
	fallbackArgs: string[][] = [],
) => {
	let lastError: unknown
	try {
		return await safeGetInfo(url, args, signal, skipJsRuntime)
	} catch (error) {
		lastError = error
	}
	for (const extraArgs of fallbackArgs) {
		try {
			return await safeGetInfo(
				url,
				[...args, ...extraArgs],
				signal,
				skipJsRuntime,
			)
		} catch (error) {
			lastError = error
		}
	}
	throw lastError instanceof Error ? lastError : new Error("No valid info")
}

const fileExists = async (path: string, minSize = 1) => {
	try {
		const info = await stat(path)
		return info.size >= minSize
	} catch {
		return false
	}
}

const formatBytes = (bytes: number) => {
	if (!Number.isFinite(bytes) || bytes <= 0) return ""
	const units = ["B", "KiB", "MiB", "GiB", "TiB"]
	let value = bytes
	let unitIndex = 0
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024
		unitIndex += 1
	}
	const precision = value >= 10 || unitIndex === 0 ? 0 : 1
	return `${value.toFixed(precision)}${units[unitIndex]}`
}

const parseHmsToSeconds = (value: string) => {
	const match = value.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/)
	if (!match) return undefined
	const hours = Number(match[1])
	const minutes = Number(match[2])
	const seconds = Number(match[3])
	if (
		!Number.isFinite(hours) ||
		!Number.isFinite(minutes) ||
		!Number.isFinite(seconds)
	) {
		return undefined
	}
	return hours * 3600 + minutes * 60 + seconds
}

const isYouTubeUrl = (url: string) => {
	try {
		return urlMatcher(url, "youtube.com") || urlMatcher(url, "youtu.be")
	} catch {
		return false
	}
}

const youtubeExtractorArgs = [
	"--extractor-args",
	"youtube:player_client=tv,web_safari",
	"--remote-components",
	"ejs:github",
]

const soraMatcher = (url: string) => url.includes("sora.chatgpt.com")

const resolveSora = async (url: string) => {
	try {
		const { stdout } = await execFilePromise("python3", [
			"src/sora_bypass.py",
			url,
		])
		return JSON.parse(stdout)
	} catch (e) {
		console.error("Sora resolve error", e)
		return { error: "Failed to run bypass script" }
	}
}

const xfreeMatcher = (url: string) => url.includes("xfree.com")

const resolveXfree = async (url: string) => {
	try {
		const { stdout } = await execFilePromise("python3", [
			"src/xfree_bypass.py",
			url,
		])
		return JSON.parse(stdout)
	} catch (e) {
		console.error("Xfree resolve error", e)
		return { error: "Failed to run bypass script" }
	}
}

const pinterestMatcher = (url: string) => {
	try {
		return urlMatcher(url, "pinterest.com") || urlMatcher(url, "pin.it")
	} catch {
		return false
	}
}

const resolvePinterest = async (url: string) => {
	try {
		const { stdout } = await execFilePromise("python3", [
			"src/pinterest_bypass.py",
			url,
			COOKIE_FILE,
		])
		return JSON.parse(stdout)
	} catch (e) {
		console.error("Pinterest resolve error", e)
		return { error: "Failed to run bypass script" }
	}
}

const threadsMatcher = (url: string) =>
	url.includes("threads.com") || url.includes("threads.net")

const getThreadsUsername = (url: string) => {
	const match = url.match(/threads\.(?:net|com)\/@([^/?#]+)/i)
	if (!match) return ""
	const username = match[1]?.trim() || ""
	if (!username) return ""
	return username.startsWith("@") ? username : `@${username}`
}

const resolveThreads = async (url: string) => {
	try {
		const { stdout } = await execFilePromise("python3", [
			"src/threads_bypass.py",
			url,
		])
		return JSON.parse(stdout)
	} catch (e) {
		console.error("Threads resolve error", e)
		return { error: "Failed to run bypass script" }
	}
}

type FallbackAttempt = {
	label: string
	args: string[]
}

const getRefererHeaderArgs = (referer?: string) => {
	if (!referer) return []
	try {
		new URL(referer)
		return ["--add-header", `Referer: ${referer}`]
	} catch {
		return []
	}
}

const buildGenericFallbacks = (referer?: string): FallbackAttempt[] => {
	const attempts: FallbackAttempt[] = [
		{
			label: "Пробуем другой метод (generic)...",
			args: ["--force-generic-extractor"],
		},
	]
	const refererArgs = getRefererHeaderArgs(referer)
	if (refererArgs.length > 0) {
		attempts.push({
			label: "Пробуем другой метод (generic + referer)...",
			args: ["--force-generic-extractor", ...refererArgs],
		})
	}
	return attempts
}

const shouldTryGenericFallback = (url: string) => {
	if (!url) return false
	if (isYouTubeUrl(url)) return false
	if (urlMatcher(url, "tiktok.com")) return false
	if (urlMatcher(url, "instagram.com") || urlMatcher(url, "instagr.am"))
		return false
	if (threadsMatcher(url) || soraMatcher(url) || xfreeMatcher(url)) return false
	return true
}

const sendPhotoUrls = async (
	ctx: any,
	photoUrls: string[],
	caption: string,
	threadId?: number,
	replyToMessageId?: number,
) => {
	if (photoUrls.length === 0) return
	if (photoUrls.length === 1) {
		await ctx.replyWithPhoto(photoUrls[0], {
			caption,
			parse_mode: "HTML",
			reply_to_message_id: replyToMessageId,
			message_thread_id: threadId,
		})
		return
	}
	const groups = chunkArray(10, photoUrls)
	let isFirst = true
	for (const group of groups) {
		const media = group.map((url, index) => ({
			type: "photo" as const,
			media: url,
			caption: isFirst && index === 0 ? caption : undefined,
			parse_mode: isFirst && index === 0 ? "HTML" : undefined,
		}))
		try {
			await ctx.api.sendMediaGroup(ctx.chat.id, media, {
				reply_to_message_id: replyToMessageId,
				message_thread_id: threadId,
			})
			isFirst = false
		} catch (error) {
			console.error("Failed to send media group, fallback to single photos", error)
			for (const [index, url] of group.entries()) {
				const withCaption = isFirst && index === 0
				try {
					await ctx.replyWithPhoto(url, {
						caption: withCaption ? caption : undefined,
						parse_mode: withCaption ? "HTML" : undefined,
						reply_to_message_id: replyToMessageId,
						message_thread_id: threadId,
					})
				} catch (photoError) {
					console.error("Failed to send Threads photo", photoError)
				}
				if (withCaption) isFirst = false
			}
		}
	}
}

const queue = new Queue(10)
const MAX_GLOBAL_TASKS = 10
const MAX_USER_URLS = 3
type JobMeta = {
	id: string
	userId: number
	url: string
	lockId: string
	state: "pending" | "active"
	cancel: () => void
}
const jobMeta = new Map<string, JobMeta>()
type UrlLockState = { lockId: string; state: "reserved" | "active" }
const userUrlLocks = new Map<number, Map<string, UrlLockState>>()

const normalizeUrl = (url: string) => cleanUrl(url).trim()

const lockUserUrl = (userId: number, url: string) => {
	const normalized = normalizeUrl(url)
	const current = userUrlLocks.get(userId) ?? new Map<string, UrlLockState>()
	const existing = current.get(normalized)
	if (existing) {
		return { ok: false, normalized, lockId: existing.lockId }
	}
	const lockId = randomUUID()
	current.set(normalized, { lockId, state: "reserved" })
	userUrlLocks.set(userId, current)
	return { ok: true, normalized, lockId }
}

const activateUserUrlLock = (userId: number, url: string, lockId: string) => {
	const normalized = normalizeUrl(url)
	const current = userUrlLocks.get(userId)
	if (!current) return
	const existing = current.get(normalized)
	if (!existing || existing.lockId !== lockId) return
	current.set(normalized, { lockId, state: "active" })
}

const unlockUserUrl = (userId: number, url: string, lockId?: string) => {
	const normalized = normalizeUrl(url)
	const current = userUrlLocks.get(userId)
	if (!current) return
	const existing = current.get(normalized)
	if (!existing) return
	if (lockId && existing.lockId !== lockId) return
	current.delete(normalized)
	if (current.size === 0) userUrlLocks.delete(userId)
}

const getUserUrlSet = (userId: number) => {
	return new Set(userUrlLocks.get(userId)?.keys() ?? [])
}

const getQueueBlockReason = (userId: number, url: string, lockId?: string) => {
	if (jobMeta.size >= MAX_GLOBAL_TASKS) {
		return "Слишком много задач на сервере. Попробуйте позже."
	}
	const normalized = normalizeUrl(url)
	const existingLock = userUrlLocks.get(userId)?.get(normalized)
	if (existingLock) {
		if (existingLock.lockId !== lockId) {
			return "Эта ссылка уже в обработке. Дождитесь завершения."
		}
		if (existingLock.state === "active") {
			return "Эта ссылка уже в обработке. Дождитесь завершения."
		}
	}
	const userUrls = getUserUrlSet(userId)
	if (!existingLock && userUrls.size >= MAX_USER_URLS) {
		return "Можно одновременно обрабатывать не более 3 разных ссылок."
	}
	return undefined
}

const enqueueJob = (
	userId: number,
	url: string,
	lockId: string,
	executor: (signal: AbortSignal) => Promise<void>,
) => {
	const normalized = normalizeUrl(url)
	const jobId = randomUUID()
	const controller = new AbortController()
	jobMeta.set(jobId, {
		id: jobId,
		userId,
		url: normalized,
		lockId,
		state: "pending",
		cancel: () => controller.abort(),
	})
	activateUserUrlLock(userId, normalized, lockId)
	queue.add(async () => {
		const meta = jobMeta.get(jobId)
		if (meta) meta.state = "active"
		try {
			await executor(controller.signal)
		} finally {
			jobMeta.delete(jobId)
			unlockUserUrl(userId, normalized, lockId)
		}
	}, jobId)
	return jobId
}

const cancelUserJobs = (userId: number) => {
	const removed = queue.remove((entry) => jobMeta.get(entry.id)?.userId === userId)
	for (const entry of removed) {
		const meta = jobMeta.get(entry.id)
		if (meta) {
			unlockUserUrl(meta.userId, meta.url, meta.lockId)
			jobMeta.delete(entry.id)
		}
	}
	let activeCancelled = 0
	for (const meta of jobMeta.values()) {
		if (meta.userId === userId && meta.state === "active") {
			meta.cancel()
			activeCancelled++
		}
	}
	const remainingActive = Array.from(jobMeta.values()).filter(
		(job) => job.userId === userId,
	).length
	return { removedCount: removed.length, activeCancelled, remainingActive }
}

const cancelUserRequests = (userId: number) => {
	let removed = 0
	for (const [requestId, cached] of requestCache.entries()) {
		if (cached.userId === userId) {
			requestCache.delete(requestId)
			if (cached.lockId) {
				unlockUserUrl(userId, getCacheLockUrl(cached), cached.lockId)
			}
			removed++
		}
	}
	return removed
}

const scheduleRequestExpiry = (requestId: string) => {
	setTimeout(() => {
		const cached = requestCache.get(requestId)
		if (!cached) return
		requestCache.delete(requestId)
		if (cached.userId && cached.lockId) {
			unlockUserUrl(cached.userId, getCacheLockUrl(cached), cached.lockId)
		}
	}, 3600000)
}
const updater = new Updater()
cleanupTempDirs().catch((error) =>
	console.error("Temp cleanup error:", error),
)
setInterval(() => {
	cleanupTempDirs().catch((error) =>
		console.error("Temp cleanup error:", error),
	)
}, cleanupIntervalHours * 60 * 60 * 1000).unref()
type RequestCacheEntry = {
	url: string
	sourceUrl?: string
	title?: string
	formats?: any[]
	userId?: number
	lockId?: string
}
type FormatEntry = {
	format: any
	meta: {
		hasVideo: boolean
		hasAudio: boolean
		vcodec: string
		acodec: string
		codecLabel: string
		bitrate: string
		isDash: boolean
		isHls: boolean
		isMhtml: boolean
	}
}

const requestCache = new Map<string, RequestCacheEntry>()

const getCacheLockUrl = (cached: RequestCacheEntry) =>
	cached.sourceUrl || cached.url

const getFormatMeta = (format: any): FormatEntry["meta"] => {
	const formatText = `${format.format_note || ""}`.toLowerCase()
	const formatLine = `${format.format || ""}`.toLowerCase()
	const protocol = `${format.protocol || ""}`.toLowerCase()
	const ext = `${format.ext || ""}`.toLowerCase()
	const hasVideo = format.vcodec && format.vcodec !== "none"
	const hasAudio = format.acodec && format.acodec !== "none"
	const vcodec =
		format.vcodec && format.vcodec !== "none" ? format.vcodec.split(".")[0] : "none"
	const acodec =
		format.acodec && format.acodec !== "none" ? format.acodec.split(".")[0] : "none"
	const codecLabel = [hasVideo ? vcodec : "", hasAudio ? acodec : ""]
		.filter(Boolean)
		.join("+")
	const bitrate =
		typeof format.tbr === "number"
			? `${Math.round(format.tbr)}k`
			: typeof format.vbr === "number"
				? `${Math.round(format.vbr)}k`
			: typeof format.abr === "number"
				? `${Math.round(format.abr)}k`
				: ""
	const isHls =
		protocol.includes("m3u8") ||
		protocol.includes("hls") ||
		formatText.includes("hls") ||
		formatLine.includes("hls")
	const isMhtml =
		protocol.includes("mhtml") ||
		ext === "mhtml" ||
		`${format.format_id || ""}`.startsWith("sb") ||
		formatText.includes("storyboard") ||
		formatLine.includes("storyboard")
	const isDash =
		format.protocol === "dash" ||
		formatText.includes("dash") ||
		formatLine.includes("dash") ||
		(hasVideo && !hasAudio) ||
		(!hasVideo && hasAudio)

	return {
		hasVideo,
		hasAudio,
		vcodec,
		acodec,
		codecLabel,
		bitrate,
		isDash,
		isHls,
		isMhtml,
	}
}

const splitFormatEntries = (formats: any[]) => {
	const formatEntries: FormatEntry[] = formats.map((format) => ({
		format,
		meta: getFormatMeta(format),
	}))
	const dashEntries: FormatEntry[] = []
	const hlsEntries: FormatEntry[] = []
	const mhtmlEntries: FormatEntry[] = []
	for (const entry of formatEntries) {
		if (entry.meta.isMhtml) {
			mhtmlEntries.push(entry)
		} else if (entry.meta.isHls) {
			hlsEntries.push(entry)
		} else {
			dashEntries.push(entry)
		}
	}
	return { formatEntries, dashEntries, hlsEntries, mhtmlEntries }
}

const buildFormatButtonText = (entry: FormatEntry) => {
	const f = entry.format
	const { codecLabel, bitrate, isDash } = entry.meta
	const filesize = f.filesize
		? `${(f.filesize / 1024 / 1024).toFixed(1)}MiB`
		: f.filesize_approx
			? `~${(f.filesize_approx / 1024 / 1024).toFixed(1)}MiB`
			: "N/A"
	const res = f.resolution || (f.width ? `${f.width}x${f.height}` : "")

	let buttonText = f.format_id
	if (res) {
		buttonText += ` ${res}`
	} else if (f.acodec !== "none" && f.vcodec === "none") {
		buttonText += " audio"
	}
	if (isDash) {
		buttonText += " dash"
	}
	if (codecLabel) {
		buttonText += ` ${codecLabel}`
	}
	if (bitrate) {
		buttonText += ` ${bitrate}`
	}
	buttonText += ` (${filesize})`

	// Truncate to 60 characters if too long
	if (buttonText.length > 60) {
		buttonText = `${buttonText.substring(0, 57)}...`
	}
	console.log("Button text:", buttonText)
	return buttonText
}

const buildFormatFilenameLabel = (format: any) => {
	const entry: FormatEntry = { format, meta: getFormatMeta(format) }
	const f = entry.format
	const { codecLabel, bitrate, isDash } = entry.meta
	const filesize = f.filesize
		? `${(f.filesize / 1024 / 1024).toFixed(1)}MiB`
		: f.filesize_approx
			? `~${(f.filesize_approx / 1024 / 1024).toFixed(1)}MiB`
			: "N/A"
	const res = f.resolution || (f.width ? `${f.width}x${f.height}` : "")

	let label = f.format_id || "format"
	if (res) {
		label += ` ${res}`
	} else if (f.acodec !== "none" && f.vcodec === "none") {
		label += " audio"
	}
	if (isDash) {
		label += " dash"
	}
	if (codecLabel) {
		label += ` ${codecLabel}`
	}
	if (bitrate) {
		label += ` ${bitrate}`
	}
	label += ` (${filesize})`
	return label
}

const estimateFormatSize = (format: any, duration?: number) => {
	if (typeof format?.filesize === "number" && format.filesize > 0) {
		return format.filesize
	}
	if (typeof format?.filesize_approx === "number" && format.filesize_approx > 0) {
		return format.filesize_approx
	}
	if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
		const tbr =
			typeof format?.tbr === "number"
				? format.tbr
				: typeof format?.vbr === "number"
					? format.vbr
					: typeof format?.abr === "number"
						? format.abr
						: undefined
		if (typeof tbr === "number" && Number.isFinite(tbr) && tbr > 0) {
			return Math.round((tbr * 1000 * duration) / 8)
		}
	}
	return undefined
}

const getFormatSuggestionLabel = (
	entry: FormatEntry,
	sizeBytes?: number,
) => {
	const f = entry.format
	const { codecLabel, bitrate, isDash, isHls } = entry.meta
	const res = f.resolution || (f.width ? `${f.width}x${f.height}` : "")
	const sizeLabel = sizeBytes ? formatBytes(sizeBytes) : ""
	let label = f.format_id || "format"
	if (res) {
		label += ` ${res}`
	}
	if (isHls) label += " hls"
	if (isDash) label += " dash"
	if (codecLabel) label += ` ${codecLabel}`
	if (bitrate) label += ` ${bitrate}`
	if (sizeLabel) label += ` (${sizeLabel})`
	return label
}

const pickBestFormatUnderLimit = (
	formats: any[],
	duration: number | undefined,
	maxBytes: number,
) => {
	const entries = formats.map((format) => ({
		format,
		meta: getFormatMeta(format),
	}))
	const candidates = entries
		.map((entry) => ({
			entry,
			size: estimateFormatSize(entry.format, duration),
		}))
		.filter((item) => typeof item.size === "number" && item.size <= maxBytes)

	if (candidates.length === 0) return undefined

	const scored = candidates.map((item) => {
		const { entry, size } = item
		const resScore = Number(entry.format?.height || 0)
		const hasAudio = entry.meta.hasAudio
		const hasVideo = entry.meta.hasVideo
		const score =
			(hasVideo ? 1000 : 0) +
			(hasAudio ? 500 : 0) +
			(entry.meta.isHls ? 200 : 0) +
			resScore +
			Math.round((size || 0) / (1024 * 1024))
		return { entry, size, score }
	})

	scored.sort((a, b) => b.score - a.score)
	return scored[0]
}

const buildFormatSuggestions = (
	formats: any[],
	duration: number | undefined,
	maxBytes: number,
	limit = 3,
) => {
	const entries = formats.map((format) => ({
		format,
		meta: getFormatMeta(format),
	}))
	const candidates = entries
		.map((entry) => ({
			entry,
			size: estimateFormatSize(entry.format, duration),
		}))
		.filter((item) => typeof item.size === "number" && item.size <= maxBytes)
		.sort((a, b) => (b.size || 0) - (a.size || 0))

	return candidates.slice(0, limit).map((item) => ({
		entry: item.entry,
		size: item.size,
		label: getFormatSuggestionLabel(item.entry, item.size),
	}))
}

const sanitizeFilePart = (value: string, fallback: string) => {
	const cleaned = value
		.trim()
		.replace(/\s+/g, "_")
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.replace(/_+/g, "_")
	return cleaned || fallback
}

const resolveTitle = (info: any, isTiktok: boolean) => {
	const rawTitle = (removeHashtagsMentions(`${info?.title || ""}`.trim()) ?? "").trim()
	const normalizedTitle = rawTitle.toLowerCase()
	if (rawTitle && (!isTiktok || normalizedTitle !== "tiktok video")) {
		return rawTitle
	}
	if (isTiktok) {
		const uploader = `${info?.uploader || info?.uploader_id || info?.creator || ""}`
			.trim()
		if (uploader) {
			return uploader.startsWith("@") ? uploader : `@${uploader}`
		}
	}
	return ""
}

const buildFormatsTable = (entries: FormatEntry[]) => {
	let output =
		"ID | EXT | RES | FPS | TBR | SIZE | VCODEC | ACODEC | PROTO | NOTE\n" +
		"---|-----|-----|-----|-----|------|--------|--------|-------|-----\n"
	for (const entry of entries) {
		const f = entry.format
		const { vcodec, acodec, bitrate } = entry.meta
		const filesize = f.filesize
			? `${(f.filesize / 1024 / 1024).toFixed(1)}MiB`
			: f.filesize_approx
				? `~${(f.filesize_approx / 1024 / 1024).toFixed(1)}MiB`
				: "N/A"
		const fps = f.fps ? f.fps : ""
		const res = f.resolution || (f.width ? `${f.width}x${f.height}` : "audio")
		const proto = f.protocol || ""
		const note = f.format_note || ""
		const tbrLabel = bitrate || "N/A"

		output += `${f.format_id} | ${f.ext} | ${res} | ${fps} | ${tbrLabel} | ${filesize} | ${vcodec} | ${acodec} | ${proto} | ${note}\n`
	}
	return output
}

const sendFormatSelector = async (
	ctx: any,
	requestId: string,
	title: string,
	dashCount: number,
	hlsCount: number,
	mhtmlCount: number,
	hasMp3: boolean,
) => {
	await deletePreviousMenuMessage(ctx)
	const keyboard = new InlineKeyboard()
	keyboard.text(`DASH (${dashCount})`, `f:${requestId}:dash`)
	keyboard.text(`HLS (${hlsCount})`, `f:${requestId}:hls`).row()
	if (hasMp3) {
		keyboard.text("MP3", `f:${requestId}:mp3`)
	}
	if (mhtmlCount > 0) {
		keyboard.text(`MHTML (${mhtmlCount})`, `f:${requestId}:mhtml`)
	}

	const threadId = ctx.message?.message_thread_id || ctx.callbackQuery?.message?.message_thread_id
	const menuMessage = await ctx.reply(`Выберите список форматов для: ${title}`, {
		reply_markup: keyboard,
		message_thread_id: threadId,
	})
	trackMenuMessage(ctx, menuMessage)
}

const sendFormatSection = async (
	ctx: any,
	requestId: string,
	title: string,
	label: string,
	entries: FormatEntry[],
	allowCombine = true,
) => {
	if (entries.length === 0) {
		await ctx.reply(`No ${label} formats found.`)
		return
	}

	const threadId = ctx.message?.message_thread_id || ctx.callbackQuery?.message?.message_thread_id
	if (entries.length > 100) {
		const output = `${label} formats\n${buildFormatsTable(entries)}`
		const buffer = Buffer.from(output.trim(), "utf-8")
		await ctx.replyWithDocument(new InputFile(buffer, "formats.txt"), {
			caption: `Too many ${label} formats. Available formats for: ${title}`,
			message_thread_id: threadId,
		})
		const keyboard = new InlineKeyboard()
		keyboard.text("Назад", `f:${requestId}:back`).row()
		if (allowCombine) {
			keyboard.text("Объединить форматы", `c:${requestId}`).row()
		}
		await deletePreviousMenuMessage(ctx)
		const menuMessage = await ctx.reply(`Actions for: ${title}`, {
			reply_markup: keyboard,
			message_thread_id: threadId,
		})
		trackMenuMessage(ctx, menuMessage)
		return
	}

	const keyboard = new InlineKeyboard()
	for (const entry of entries) {
		keyboard
			.text(buildFormatButtonText(entry), `d:${requestId}:${entry.format.format_id}`)
			.row()
	}
	if (allowCombine) {
		keyboard.text("Объединить форматы", `c:${requestId}`).row()
	}
	keyboard.text("Назад", `f:${requestId}:back`).row()
	await deletePreviousMenuMessage(ctx)
	const menuMessage = await ctx.reply(`Select ${label} format for: ${title}`, {
		reply_markup: keyboard,
		message_thread_id: threadId,
	})
	trackMenuMessage(ctx, menuMessage)
}

const sendCombineVideoSection = async (
	ctx: any,
	requestId: string,
	title: string,
	entries: FormatEntry[],
) => {
	if (entries.length === 0) {
		await ctx.reply("No video-only formats available to combine.")
		return
	}
	const threadId = ctx.message?.message_thread_id || ctx.callbackQuery?.message?.message_thread_id
	if (entries.length > 100) {
		const output = `Video-only formats\n${buildFormatsTable(entries)}`
		const buffer = Buffer.from(output.trim(), "utf-8")
		await ctx.replyWithDocument(new InputFile(buffer, "formats.txt"), {
			caption: `Too many video formats. Available formats for: ${title}`,
			message_thread_id: threadId,
		})
		const keyboard = new InlineKeyboard()
		keyboard.text("Назад", `f:${requestId}:dash`).row()
		await deletePreviousMenuMessage(ctx)
		const menuMessage = await ctx.reply("Actions for combine:", {
			reply_markup: keyboard,
			message_thread_id: threadId,
		})
		trackMenuMessage(ctx, menuMessage)
		return
	}

	const keyboard = new InlineKeyboard()
	for (const entry of entries) {
		keyboard
			.text(buildFormatButtonText(entry), `cv:${requestId}:${entry.format.format_id}`)
			.row()
	}
	keyboard.text("Назад", `f:${requestId}:dash`).row()
	await deletePreviousMenuMessage(ctx)
	const menuMessage = await ctx.reply(`Select video format to combine for: ${title}`, {
		reply_markup: keyboard,
		message_thread_id: threadId,
	})
	trackMenuMessage(ctx, menuMessage)
}

const sendCombineAudioSection = async (
	ctx: any,
	requestId: string,
	title: string,
	videoId: string,
	entries: FormatEntry[],
) => {
	if (entries.length === 0) {
		await ctx.reply("No audio-only formats available to combine.")
		return
	}
	const threadId = ctx.message?.message_thread_id || ctx.callbackQuery?.message?.message_thread_id
	if (entries.length > 100) {
		const output = `Audio-only formats\n${buildFormatsTable(entries)}`
		const buffer = Buffer.from(output.trim(), "utf-8")
		await ctx.replyWithDocument(new InputFile(buffer, "formats.txt"), {
			caption: `Too many audio formats. Available formats for: ${title}`,
			message_thread_id: threadId,
		})
		const keyboard = new InlineKeyboard()
		keyboard.text("Назад", `c:${requestId}`).row()
		await deletePreviousMenuMessage(ctx)
		const menuMessage = await ctx.reply("Actions for combine:", {
			reply_markup: keyboard,
			message_thread_id: threadId,
		})
		trackMenuMessage(ctx, menuMessage)
		return
	}

	const keyboard = new InlineKeyboard()
	for (const entry of entries) {
		keyboard
			.text(
				buildFormatButtonText(entry),
				`ca:${requestId}:${videoId}:${entry.format.format_id}`,
			)
			.row()
	}
	keyboard.text("Назад", `c:${requestId}`).row()
	await deletePreviousMenuMessage(ctx)
	const menuMessage = await ctx.reply(`Select audio format to combine for: ${title}`, {
		reply_markup: keyboard,
		message_thread_id: threadId,
	})
	trackMenuMessage(ctx, menuMessage)
}

const isAbortError = (error: unknown) =>
	error instanceof Error && error.message === "Cancelled"

const downloadAndSend = async (
	ctx: any,
	url: string,
	quality: string,
	isRawFormat = false,
	statusMessageId?: number,
	overrideTitle?: string,
	replyToMessageId?: number,
	signal?: AbortSignal,
	forceAudio = false,
	formatLabelTail?: string,
	forceHls = false,
	sourceUrl?: string,
	skipPlaylist = false,
) => {
	if (signal?.aborted) return
	const tempBaseId = randomUUID()
	const tempDir = resolve("/tmp", `yakachokbot-${tempBaseId}`)
	await mkdir(tempDir, { recursive: true })
	let tempFilePath = resolve(tempDir, "video.mp4")
	const tempThumbPath = resolve(tempDir, "thumb.jpg")
	const threadId = ctx.message?.message_thread_id || ctx.callbackQuery?.message?.message_thread_id
	let selectedQuality = quality
	let selectedIsRawFormat = isRawFormat
	let selectedForceHls = forceHls
	let selectedFormatLabelTail = formatLabelTail
	
	try {
		const isTiktok = urlMatcher(url, "tiktok.com")
		const isInstagram =
			urlMatcher(url, "instagram.com") || urlMatcher(url, "instagr.am")
		const isErome = urlMatcher(url, "erome.com")
		const isDirectHls = /\.m3u8(\?|$)/i.test(url)
		let forceHlsDownload = selectedForceHls || isDirectHls
		const additionalArgs = isTiktok ? tiktokArgs : []
		const resumeArgs = isErome ? ["--no-continue"] : []
		const isYouTube = isYouTubeUrl(url)
		const cookieArgsList = await cookieArgs()
		const youtubeArgs = isYouTube ? youtubeExtractorArgs : []

		let isMp3Format = selectedIsRawFormat && selectedQuality === "mp3"
		let isAudioRequest =
			selectedQuality === "audio" || isMp3Format || forceAudio

		if (isErome && !skipPlaylist) {
			const entries = await getFlatPlaylistEntries(
				url,
				[
					...cookieArgsList,
					...additionalArgs,
					...impersonateArgs,
					...youtubeArgs,
				],
				signal,
			)
			if (entries.length > 1) {
				if (statusMessageId) {
					try {
						await ctx.api.deleteMessage(ctx.chat.id, statusMessageId)
					} catch {}
				}
				for (const [index, entry] of entries.entries()) {
					if (signal?.aborted) return
					const processing = await sendStatusMessage(
						ctx,
						`Скачиваем ${index + 1}/${entries.length}...`,
						replyToMessageId,
						threadId,
					)
					await downloadAndSend(
						ctx,
						entry.url,
						quality,
						isRawFormat,
						processing.message_id,
						entry.title || overrideTitle,
						replyToMessageId,
						signal,
						forceAudio,
						formatLabelTail,
						forceHls,
						sourceUrl || url,
						true,
					)
				}
				return
			}
		}

		if (isDirectHls && !isAudioRequest) {
			const title = overrideTitle || "Video"
			const captionUrl = sourceUrl || url
			const caption = link(title, cleanUrl(captionUrl))
			if (statusMessageId) {
				await updateMessage(
					ctx,
					statusMessageId,
					`Обработка: <b>${title}</b>\nСтатус: Скачиваем...`,
				)
			}
			const ffmpegArgs = [
				"-y",
				"-user_agent",
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				"-headers",
				`Referer: ${captionUrl}\r\n`,
				"-i",
				url,
				"-c",
				"copy",
				"-bsf:a",
				"aac_adtstoasc",
				"-movflags",
				"+faststart",
				tempFilePath,
			]
			await spawnPromise("ffmpeg", ffmpegArgs, undefined, signal)
			const metadata = await getVideoMetadata(tempFilePath)
			await generateThumbnail(tempFilePath, tempThumbPath)
			const thumbFile = (await fileExists(tempThumbPath, 256))
				? new InputFile(tempThumbPath)
				: undefined
			if (statusMessageId) {
				await updateMessage(
					ctx,
					statusMessageId,
					`Обработка: <b>${title}</b>\nСтатус: Отправляем...`,
				)
			}
			await ctx.replyWithChatAction("upload_video")
			await ctx.replyWithVideo(new InputFile(tempFilePath), {
				caption,
				parse_mode: "HTML",
				supports_streaming: true,
				duration: metadata.duration,
				width: metadata.width,
				height: metadata.height,
				thumbnail: thumbFile,
				message_thread_id: threadId,
			})
			if (statusMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat.id, statusMessageId)
				} catch {}
			}
			if (replyToMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat.id, replyToMessageId)
				} catch {}
			}
			return
		}

		let formatArgs: string[] = []
		let fallbackFormatArgs: string[] | undefined
		if (selectedIsRawFormat) {
			if (isMp3Format) {
				formatArgs = ["-f", "251", "-x", "--audio-format", "mp3"]
			} else {
				formatArgs = ["-f", selectedQuality]
			}
		} else if (selectedQuality === "audio") {
			formatArgs = ["-x", "--audio-format", "mp3"]
		} else if (isDirectHls) {
			formatArgs = ["-f", "best"]
		} else if (selectedQuality === "b") {
			if (isYouTube) {
				formatArgs = [
					"-f",
					"bestvideo[protocol=https][vcodec~='^avc1'][ext=mp4]+bestaudio[protocol=https][ext=m4a]/best[protocol=https][ext=mp4]/best[protocol=https]",
				]
				fallbackFormatArgs = [
					"-f",
					"best[protocol*=m3u8][vcodec~='^avc1'][acodec~='^mp4a']/best[protocol*=m3u8][vcodec~='^avc1']/bestvideo[vcodec~='^avc1'][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
				]
			} else if (isErome) {
				formatArgs = ["-f", "best[ext=mp4]/best"]
			} else {
				formatArgs = [
					"-f",
					"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
				]
			}
		} else {
			if (isYouTube) {
				formatArgs = [
					"-f",
					`bestvideo[protocol=https][height<=${selectedQuality}][vcodec~='^avc1'][ext=mp4]+bestaudio[protocol=https][ext=m4a]/best[protocol=https][height<=${selectedQuality}][ext=mp4]/best[protocol=https][height<=${selectedQuality}]`,
				]
				fallbackFormatArgs = [
					"-f",
					`best[height<=${selectedQuality}][protocol*=m3u8][vcodec~='^avc1'][acodec~='^mp4a']/best[height<=${selectedQuality}][protocol*=m3u8][vcodec~='^avc1']/bestvideo[height<=${selectedQuality}][vcodec~='^avc1'][ext=mp4]+bestaudio[ext=m4a]/best[height<=${selectedQuality}][ext=mp4]/best[height<=${selectedQuality}]`,
				]
			} else {
				formatArgs = [
					"-f",
					`bestvideo[height<=${selectedQuality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${selectedQuality}][ext=mp4]/best[height<=${selectedQuality}]`,
				]
			}
		}

		console.log(
			`[QUEUE] Starting download: ${url} (Quality: ${selectedQuality}) in chat ${ctx.chat.id}`,
		)

		if (statusMessageId) {
			await updateMessage(ctx, statusMessageId, "Получаем информацию о видео...")
		}

		const skipJsRuntimeForInfo =
			isYouTube &&
			(forceHlsDownload ||
				formatArgs.some((arg) => arg.includes("protocol*=m3u8")))
		const fallbackSourceUrl = sourceUrl || url
		const genericFallbacks = shouldTryGenericFallback(fallbackSourceUrl)
			? buildGenericFallbacks(fallbackSourceUrl)
			: []
		const info = await safeGetInfoWithFallback(
			url,
			[
				"--dump-json",
				...formatArgs,
				"--no-warnings",
				"--no-playlist",
				...resumeArgs,
				...cookieArgsList,
				...additionalArgs,
				...impersonateArgs,
				...youtubeArgs,
			],
			signal,
			skipJsRuntimeForInfo,
			genericFallbacks.map((attempt) => attempt.args),
		)

		const resolvedTitle = resolveTitle(info, isTiktok)
		const title = overrideTitle || resolvedTitle
		const captionUrl = sourceUrl || url
		const caption = link(title || "Video", cleanUrl(captionUrl))
		const infoDuration =
			typeof info.duration === "number" && Number.isFinite(info.duration)
				? info.duration
				: undefined
		const safeTitle = sanitizeFilePart(title || "video", "video")
		const formatTail = selectedFormatLabelTail
			? sanitizeFilePart(selectedFormatLabelTail, "")
			: ""
		const dashFileBase = formatTail ? `${safeTitle}_${formatTail}` : ""
		const maxUploadSize = 2 * 1024 * 1024 * 1024
		const sizeCandidates: number[] = []
		if (typeof info.filesize === "number") sizeCandidates.push(info.filesize)
		if (typeof info.filesize_approx === "number")
			sizeCandidates.push(info.filesize_approx)
		if (Array.isArray(info.requested_formats)) {
			let summed = 0
			let hasSize = false
			for (const format of info.requested_formats) {
				const formatSize =
					typeof format?.filesize === "number"
						? format.filesize
						: typeof format?.filesize_approx === "number"
							? format.filesize_approx
							: 0
				if (formatSize > 0) {
					summed += formatSize
					hasSize = true
				}
			}
			if (hasSize) sizeCandidates.push(summed)
		}
		const estimatedSize = sizeCandidates.length
			? Math.max(...sizeCandidates)
			: 0
		let estimatedSizeLabel = estimatedSize ? formatBytes(estimatedSize) : ""

		let maxEstimatedFromFormats = 0
		const formatsArray = Array.isArray(info.formats) ? info.formats : []
		for (const format of formatsArray) {
			const size = estimateFormatSize(format, infoDuration)
			if (typeof size === "number" && size > maxEstimatedFromFormats) {
				maxEstimatedFromFormats = size
			}
		}

		if (estimatedSize >= maxUploadSize || maxEstimatedFromFormats >= maxUploadSize) {
			const suggestions = buildFormatSuggestions(
				formatsArray,
				infoDuration,
				maxUploadSize,
			)
			const bestAlt = pickBestFormatUnderLimit(
				formatsArray,
				infoDuration,
				maxUploadSize,
			)
			if (bestAlt) {
				const altLabel = getFormatSuggestionLabel(bestAlt.entry, bestAlt.size)
				selectedQuality = `${bestAlt.entry.format.format_id}`
				selectedIsRawFormat = true
				selectedForceHls = bestAlt.entry.meta.isHls
				selectedFormatLabelTail = altLabel
				if (typeof bestAlt.size === "number") {
					estimatedSizeLabel = formatBytes(bestAlt.size)
				}
				const suggestionText = suggestions.length
					? `\nДругие варианты ≤2ГБ:\n${suggestions.map((s) => `• ${s.label}`).join("\n")}`
					: ""
				if (statusMessageId) {
					await updateMessage(
						ctx,
						statusMessageId,
						`Файл слишком большой для Telegram (${formatBytes(maxUploadSize)}). Берём вариант: ${altLabel}${suggestionText}`,
					)
				} else if (ctx.callbackQuery) {
					await ctx.editMessageText(
						`Файл слишком большой для Telegram (${formatBytes(maxUploadSize)}). Берём вариант: ${altLabel}${suggestionText}`,
					)
				}
			} else {
				const suggestionText = suggestions.length
					? `\nДоступные варианты ≤2ГБ:\n${suggestions.map((s) => `• ${s.label}`).join("\n")}`
					: ""
				const limitMessage =
					"Можно загрузить файлы до 2ГБ." +
					suggestionText +
					"\nИспользуйте /formats для выбора."
				if (statusMessageId) {
					await updateMessage(ctx, statusMessageId, limitMessage)
				} else if (ctx.callbackQuery) {
					await ctx.editMessageText(limitMessage)
				} else {
					await ctx.reply(limitMessage)
				}
				return
			}
		}

		forceHlsDownload = selectedForceHls || isDirectHls
		isMp3Format = selectedIsRawFormat && selectedQuality === "mp3"
		isAudioRequest = selectedQuality === "audio" || isMp3Format || forceAudio
		formatArgs = []
		fallbackFormatArgs = undefined
		if (selectedIsRawFormat) {
			if (isMp3Format) {
				formatArgs = ["-f", "251", "-x", "--audio-format", "mp3"]
			} else {
				formatArgs = ["-f", selectedQuality]
			}
		} else if (selectedQuality === "audio") {
			formatArgs = ["-x", "--audio-format", "mp3"]
		} else if (isDirectHls) {
			formatArgs = ["-f", "best"]
		} else if (selectedQuality === "b") {
			if (isYouTube) {
				formatArgs = [
					"-f",
					"bestvideo[protocol=https][vcodec~='^avc1'][ext=mp4]+bestaudio[protocol=https][ext=m4a]/best[protocol=https][ext=mp4]/best[protocol=https]",
				]
				fallbackFormatArgs = [
					"-f",
					"best[protocol*=m3u8][vcodec~='^avc1'][acodec~='^mp4a']/best[protocol*=m3u8][vcodec~='^avc1']/bestvideo[vcodec~='^avc1'][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
				]
			} else if (isErome) {
				formatArgs = ["-f", "best[ext=mp4]/best"]
			} else {
				formatArgs = [
					"-f",
					"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
				]
			}
		} else {
			if (isYouTube) {
				formatArgs = [
					"-f",
					`bestvideo[protocol=https][height<=${selectedQuality}][vcodec~='^avc1'][ext=mp4]+bestaudio[protocol=https][ext=m4a]/best[protocol=https][height<=${selectedQuality}][ext=mp4]/best[protocol=https][height<=${selectedQuality}]`,
				]
				fallbackFormatArgs = [
					"-f",
					`best[height<=${selectedQuality}][protocol*=m3u8][vcodec~='^avc1'][acodec~='^mp4a']/best[height<=${selectedQuality}][protocol*=m3u8][vcodec~='^avc1']/bestvideo[height<=${selectedQuality}][vcodec~='^avc1'][ext=mp4]+bestaudio[ext=m4a]/best[height<=${selectedQuality}][ext=mp4]/best[height<=${selectedQuality}]`,
				]
			} else {
				formatArgs = [
					"-f",
					`bestvideo[height<=${selectedQuality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${selectedQuality}][ext=mp4]/best[height<=${selectedQuality}]`,
				]
			}
		}

		let requestedFormats = Array.isArray(info.requested_formats)
			? info.requested_formats
			: []
		const selectedFormat = formatsArray.find(
			(format) => `${format?.format_id}` === selectedQuality,
		)
		if (selectedIsRawFormat && selectedFormat) {
			requestedFormats = [selectedFormat]
		}
		const isCombined = selectedIsRawFormat && requestedFormats.length > 1
		let outputContainer: "mp4" | "webm" | "mkv" | "mhtml" = "mp4"
		let audioTranscodeCodec: "aac" | "opus" | null = null
		let audioTranscodeBitrate = "256k"
		const formatNote = `${info.format_note || ""}`.toLowerCase()
		const formatLine = `${info.format || ""}`.toLowerCase()
		const formatProtocol = `${info.protocol || ""}`.toLowerCase()
		let resolvedVideoCodec = info.vcodec || ""
		const isMhtml =
			info.ext === "mhtml" ||
			`${info.format_id || ""}`.startsWith("sb") ||
			formatProtocol.includes("mhtml") ||
			formatNote.includes("storyboard") ||
			formatLine.includes("storyboard")
		const hlsPreferredByFormatArgs = formatArgs.some((arg) =>
			arg.includes("protocol*=m3u8"),
		)
		const isHlsDownload =
			forceHlsDownload ||
			(!isMhtml &&
				(hlsPreferredByFormatArgs ||
					formatProtocol.includes("m3u8") ||
					formatProtocol.includes("hls") ||
					requestedFormats.some((format: any) => {
						const protocol = `${format?.protocol || ""}`.toLowerCase()
						return protocol.includes("m3u8") || protocol.includes("hls")
					})))
		const hlsPoTokenArgs =
			isYouTube && isHlsDownload
				? ["--extractor-args", "youtube:fetch_pot=always"]
				: []

		if (!isAudioRequest) {
			const vcodec = info.vcodec || ""
			const acodec = info.acodec || ""
			let combinedVideoCodec = vcodec
			let combinedAudioCodec = acodec
			if (isMhtml) {
				outputContainer = "mhtml"
			} else if (isCombined) {
				const videoFormat = requestedFormats.find(
					(f: any) => f.vcodec && f.vcodec !== "none",
				)
				const audioFormat = requestedFormats.find(
					(f: any) => f.acodec && f.acodec !== "none",
				)
				combinedVideoCodec = videoFormat?.vcodec || vcodec
				combinedAudioCodec = audioFormat?.acodec || acodec
				resolvedVideoCodec = combinedVideoCodec
				const isAv1Video = /av01/i.test(combinedVideoCodec)
				const isWebmVideo = /vp0?8|vp0?9|av01/i.test(combinedVideoCodec)
				const isWebmAudio = /opus|vorbis/i.test(combinedAudioCodec)
				const isMp4Video = /avc|h264|hevc|h265/i.test(combinedVideoCodec)
				const isMp4Audio = /mp4a|aac/i.test(combinedAudioCodec)

				if (isAv1Video && isWebmAudio) {
					outputContainer = "mp4"
					audioTranscodeCodec = "aac"
					audioTranscodeBitrate = "320k"
				} else if (isWebmVideo && isWebmAudio) {
					outputContainer = "webm"
				} else if ((isMp4Video && isMp4Audio) || (isAv1Video && isMp4Audio)) {
					outputContainer = "mp4"
				} else if (isMp4Video || isAv1Video) {
					outputContainer = "mp4"
					audioTranscodeCodec = "aac"
					if (isWebmAudio) {
						audioTranscodeBitrate = "320k"
					}
				} else if (isWebmVideo) {
					outputContainer = "webm"
					audioTranscodeCodec = "opus"
				} else {
					outputContainer = "mkv"
				}
				if (isInstagram) {
					outputContainer = "mp4"
					if (audioTranscodeCodec === "opus") {
						audioTranscodeCodec = "aac"
						audioTranscodeBitrate = "256k"
					}
				}
			} else {
				outputContainer = info.ext === "webm" ? "webm" : info.ext === "mkv" ? "mkv" : "mp4"
			}

			const videoBase = dashFileBase || safeTitle
			tempFilePath = resolve(tempDir, `${videoBase}.${outputContainer}`)

			if (!isMhtml) {
				formatArgs.push("--merge-output-format", outputContainer)
			}
		}
		if (!formatArgs.includes("--no-cache-dir")) {
			formatArgs.push("--no-cache-dir")
		}
		if (fallbackFormatArgs && !fallbackFormatArgs.includes("--no-cache-dir")) {
			fallbackFormatArgs.push("--no-cache-dir")
		}
		const formatArgsBase = [...formatArgs]
		const usesHlsPreferred =
			formatArgsBase.some((arg) => arg.includes("protocol*=m3u8")) ||
			isHlsDownload
		if (usesHlsPreferred) {
			formatArgs.push(
				"--downloader",
				"ffmpeg",
				"--hls-prefer-ffmpeg",
				"--retries",
				"1",
				"--fragment-retries",
				"1",
				"--abort-on-unavailable-fragment",
			)
		}

		if (isAudioRequest) {
			const downloadArgs = formatArgs.includes("--js-runtimes")
				? formatArgs
				: [...jsRuntimeArgs, ...formatArgs]
			const audioBase = dashFileBase || "audio"
			if (isMp3Format) {
				tempFilePath = resolve(tempDir, `${audioBase}.mp3`)
			} else if (info.ext && info.ext !== "none") {
				tempFilePath = resolve(tempDir, `${audioBase}.${info.ext}`)
			}
			if (statusMessageId) {
				await updateMessage(
					ctx,
					statusMessageId,
					`Обработка: <b>${title}</b>\nСтатус: Скачиваем аудио...`,
				)
			}
			await spawnPromise(
				"yt-dlp",
				[
					url,
					...downloadArgs,
					"-o",
					tempFilePath,
					"--no-part",
					"--no-warnings",
					"--no-playlist",
					...cookieArgsList,
					...additionalArgs,
					...impersonateArgs,
					...youtubeArgs,
				],
				undefined,
				signal,
			)
			const audio = new InputFile(tempFilePath)

			if (statusMessageId) {
				await updateMessage(
					ctx,
					statusMessageId,
					`Обработка: <b>${title}</b>\nСтатус: Отправляем...`,
				)
			}
			await ctx.replyWithChatAction("upload_voice")
			await ctx.replyWithAudio(audio, {
				caption,
				parse_mode: "HTML",
				performer: info.uploader,
				title: title || info.title,
				thumbnail: getThumbnail(info.thumbnails),
				duration: info.duration,
				message_thread_id: threadId,
			})
			if (statusMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat.id, statusMessageId)
				} catch {}
			}
			if (replyToMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat.id, replyToMessageId)
				} catch {}
			}
		} else {
			const skipJsRuntime = isYouTube && isHlsDownload
			const downloadArgs =
				formatArgs.includes("--js-runtimes") || skipJsRuntime
					? formatArgs
					: [...jsRuntimeArgs, ...formatArgs]
			const downloadArgsNative =
				formatArgsBase.includes("--js-runtimes") || skipJsRuntime
					? formatArgsBase
					: [...jsRuntimeArgs, ...formatArgsBase]
				let progressText = "Скачиваем..."
				let fileSize = estimatedSizeLabel
				let downloadedSize = ""
				let lastProgressAt = Date.now()
				let progressBuffer = ""
				let lastPercentValue: number | null = null
				let progressStage: "download" | "muxing" | "converting" = "download"
			const durationSeconds =
				typeof info.duration === "number" && info.duration > 0
					? info.duration
					: undefined
			const containerLabel = outputContainer.toUpperCase()
			const muxingLabel = `Муксинг в ${containerLabel}...`
			const convertingLabel = `Конвертируем в ${containerLabel}...`
			const handleProgressLine = (line: string) => {
				if (!statusMessageId) return
				const trimmed = line.trim()
				if (!trimmed) return
				const lower = trimmed.toLowerCase()
				lastProgressAt = Date.now()

				if (
					trimmed.includes("[Merger]") ||
					lower.includes("merging formats into") ||
					(lower.includes("[ffmpeg]") && lower.includes("merge"))
				) {
						progressStage = "muxing"
						progressText = muxingLabel
						lastPercentValue = null
						return updateMessage(
						ctx,
						statusMessageId,
						`Обработка: <b>${title}</b>\nСтатус: ${progressText}`,
					)
				}

				if (
					trimmed.includes("[VideoConvertor]") ||
					lower.includes("converting") ||
					(lower.includes("[ffmpeg]") && lower.includes("conversion"))
				) {
						progressStage = "converting"
						progressText = convertingLabel
						lastPercentValue = null
						return updateMessage(
						ctx,
						statusMessageId,
						`Обработка: <b>${title}</b>\nСтатус: ${progressText}`,
					)
				}

				if (progressStage !== "download") return

					if (trimmed.includes("[download]")) {
						const sizeMatch = trimmed.match(/of\s+(?:~?\s*)?([\d.,]+\s*\w+B)/)
						if (sizeMatch?.[1]) {
							fileSize = sizeMatch[1]
						}

						const percentageMatch = trimmed.match(/(\d+(?:[.,]\d+)?)%/)
						const percentValueRaw = percentageMatch?.[1]
						if (percentValueRaw) {
							const rawPercent = Number.parseFloat(
								percentValueRaw.replace(",", "."),
							)
							if (
								Number.isFinite(rawPercent) &&
								(lastPercentValue === null || rawPercent >= lastPercentValue)
							) {
								lastPercentValue = rawPercent
							}
							let nextText = `Скачиваем: ${percentValueRaw}%`
							if (fileSize) {
								nextText += ` из ${fileSize}`
							}
							if (percentValueRaw === "100.0" && isCombined) {
								nextText = muxingLabel
							}
							progressText = nextText
						}
						return updateMessage(
							ctx,
							statusMessageId,
							`Обработка: <b>${title}</b>\nСтатус: ${progressText}`,
						)
					}

					const timeMatch = trimmed.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/)
					const timeValue = timeMatch?.[1]
						if (timeValue && durationSeconds) {
							const timeSeconds = parseHmsToSeconds(timeValue)
						if (typeof timeSeconds === "number") {
							const percent = Math.min(
								100,
								(timeSeconds / durationSeconds) * 100,
							)
							const percentLabel = percent.toFixed(1).replace(/\.0$/, "")
							if (
								lastPercentValue !== null &&
								percent + 0.1 < lastPercentValue
							) {
								return
							}
							lastPercentValue = percent
							let nextText = `Скачиваем: ${percentLabel}%`
							const sizeMatch = trimmed.match(
								/size=\s*([0-9.]+\s*[A-Za-z]+B)/,
							)
							if (sizeMatch?.[1]) {
								downloadedSize = sizeMatch[1].replace(/\s+/g, "")
							}
							if (fileSize) {
								nextText += ` из ${fileSize}`
							} else if (downloadedSize) {
								nextText += ` (${downloadedSize})`
							}
							progressText = nextText
							return updateMessage(
							ctx,
							statusMessageId,
							`Обработка: <b>${title}</b>\nСтатус: ${progressText}`,
						)
					}
				}
			}

			const onProgress = (data: string) => {
				if (!statusMessageId) return
				progressBuffer += data
				const lines = progressBuffer.split(/\r?\n|\r/)
				progressBuffer = lines.pop() || ""
				for (const line of lines) {
					handleProgressLine(line)
				}
			}

			let statusHeartbeat: NodeJS.Timeout | undefined
			if (statusMessageId) {
				statusHeartbeat = setInterval(() => {
					const isStale = Date.now() - lastProgressAt > 15000
					if (!isStale) return
					updateMessage(
						ctx,
						statusMessageId,
						`Обработка: <b>${title}</b>\nСтатус: ${progressText} (все еще работаем)`,
					)
				}, 15000)
			}

			const runDownload = async (
				args: string[],
				extraArgs: string[],
					cookieArgsOverride: string[] = cookieArgsList,
				) => {
					lastPercentValue = null
					await spawnPromise(
					"yt-dlp",
					[
						url,
						...args,
						...resumeArgs,
						"-o",
						tempFilePath,
						"--no-part",
						"--no-warnings",
						"--no-playlist",
						...cookieArgsOverride,
						...additionalArgs,
						...extraArgs,
					],
					onProgress,
					signal,
				)
			}

			let downloadSucceeded = false
			let lastDownloadError: unknown = null
			if (isYouTube && isHlsDownload) {
				const hlsAttempts = [
					{
						label: `Обработка: <b>${title}</b>\nСтатус: HLS: пробуем без cookies...`,
						extraArgs: [...hlsPoTokenArgs],
						cookies: [] as string[],
					},
					{
						label: `Обработка: <b>${title}</b>\nСтатус: HLS: пробуем с cookies...`,
						extraArgs: [...hlsPoTokenArgs, ...impersonateArgs, ...youtubeArgs],
						cookies: cookieArgsList,
					},
				]
				for (const attempt of hlsAttempts) {
					if (statusMessageId) {
						await updateMessage(ctx, statusMessageId, attempt.label)
					}
					try {
						await runDownload(downloadArgs, attempt.extraArgs, attempt.cookies)
						downloadSucceeded = true
						break
					} catch (error) {
						lastDownloadError = error
						if (
							!downloadSucceeded &&
							downloadArgsNative !== downloadArgs
						) {
							if (statusMessageId) {
								await updateMessage(
									ctx,
									statusMessageId,
									`Обработка: <b>${title}</b>\nСтатус: HLS: пробуем без ffmpeg...`,
								)
							}
							try {
								await runDownload(
									downloadArgsNative,
									attempt.extraArgs,
									attempt.cookies,
								)
								downloadSucceeded = true
								break
							} catch (nativeError) {
								lastDownloadError = nativeError
							}
						}
					}
					if (downloadSucceeded) break
				}
			} else {
				const baseExtraArgs = [
					...hlsPoTokenArgs,
					...impersonateArgs,
					...youtubeArgs,
				]
				try {
					await runDownload(downloadArgs, baseExtraArgs, cookieArgsList)
					downloadSucceeded = true
				} catch (error) {
					lastDownloadError = error
					for (const attempt of genericFallbacks) {
						if (statusMessageId) {
							await updateMessage(
								ctx,
								statusMessageId,
								`Обработка: <b>${title}</b>\nСтатус: ${attempt.label}`,
							)
						}
						try {
							await runDownload(
								[...downloadArgs, ...attempt.args],
								baseExtraArgs,
								cookieArgsList,
							)
							downloadSucceeded = true
							break
						} catch (fallbackError) {
							lastDownloadError = fallbackError
						}
					}
				}
			}

			if (!downloadSucceeded) {
				if (!fallbackFormatArgs) {
					throw lastDownloadError instanceof Error
						? lastDownloadError
						: new Error("Download failed")
				}
				const retryArgs =
					fallbackFormatArgs.includes("--js-runtimes") || skipJsRuntime
						? fallbackFormatArgs
						: [...jsRuntimeArgs, ...fallbackFormatArgs]
				if (statusMessageId) {
					await updateMessage(
						ctx,
						statusMessageId,
						`Обработка: <b>${title}</b>\nСтатус: HLS недоступен, пробуем другое...`,
					)
				}
				await runDownload(
					retryArgs,
					[...hlsPoTokenArgs, ...impersonateArgs, ...youtubeArgs],
					cookieArgsList,
				)
				downloadSucceeded = true
			}
			if (statusHeartbeat) clearInterval(statusHeartbeat)

			const hasVideoTrack = info.vcodec && info.vcodec !== "none"
			const needsAudioFix =
				(isTiktok || isInstagram) &&
				hasVideoTrack &&
				!isMhtml &&
				outputContainer === "mp4" &&
				!isMp3Format &&
				quality !== "audio"

			if (needsAudioFix && !audioTranscodeCodec) {
				audioTranscodeCodec = "aac"
			}

			if (audioTranscodeCodec && !isMhtml && !isMp3Format && quality !== "audio") {
				const outputBasePath = tempFilePath
				const audioFixedPath = resolve(
					tempDir,
					`audio-fixed.${outputContainer}`,
				)
				try {
					if (statusMessageId) {
						await updateMessage(
							ctx,
							statusMessageId,
							`Обработка: <b>${title}</b>\nСтатус: Конвертируем аудио...`,
						)
					}
					const ffmpegArgs = [
						"-y",
						"-i",
						tempFilePath,
						"-c:v",
						"copy",
						"-c:a",
						audioTranscodeCodec === "aac" ? "aac" : "libopus",
					]
					if (audioTranscodeCodec === "aac") {
						ffmpegArgs.push(
							"-profile:a",
							"aac_low",
							"-b:a",
							audioTranscodeBitrate,
							"-ar",
							"48000",
						)
						if (outputContainer === "mp4") {
							ffmpegArgs.push("-movflags", "+faststart")
						}
					} else {
						ffmpegArgs.push("-b:a", "160k")
					}
					ffmpegArgs.push(audioFixedPath)
					await spawnPromise(
						"ffmpeg",
						ffmpegArgs,
						undefined,
						signal,
					)
					if (await fileExists(audioFixedPath, 1024)) {
						await unlink(outputBasePath)
						try {
							await rename(audioFixedPath, outputBasePath)
							tempFilePath = outputBasePath
						} catch {
							tempFilePath = audioFixedPath
						}
					} else {
						await unlink(audioFixedPath)
					}
				} catch (error) {
					console.error("Audio convert error:", error)
					try {
						await unlink(audioFixedPath)
					} catch {}
				}
			}

			if (isMhtml) {
				const fileBase = sanitizeFilePart(title || "mhtml", "mhtml")
				const namedPath = resolve(tempDir, `${fileBase}.mhtml`)
				if (namedPath !== tempFilePath) {
					try {
						await rename(tempFilePath, namedPath)
						tempFilePath = namedPath
					} catch (error) {
						console.error("MHTML rename error:", error)
					}
				}
				if (statusMessageId) {
					await updateMessage(
						ctx,
						statusMessageId,
						`Обработка: <b>${title}</b>\nСтатус: Отправляем...`,
					)
				}
				await ctx.replyWithChatAction("upload_document")
				await ctx.replyWithDocument(new InputFile(tempFilePath), {
					caption,
					parse_mode: "HTML",
					message_thread_id: threadId,
				})
			} else {
				if (outputContainer !== "mp4") {
					if (statusMessageId) {
						await updateMessage(
							ctx,
							statusMessageId,
							`Обработка: <b>${title}</b>\nСтатус: Отправляем...`,
						)
					}
					await ctx.replyWithChatAction("upload_document")
					await ctx.replyWithDocument(new InputFile(tempFilePath), {
						caption,
						parse_mode: "HTML",
						message_thread_id: threadId,
					})
				} else {
					// Get metadata directly from the file
					const metadata = await getVideoMetadata(tempFilePath)
					const width = metadata.width || info.width
					const height = metadata.height || info.height
					const duration = metadata.duration || info.duration
					const isAv1Video = /av01|av1/i.test(resolvedVideoCodec)

					// Generate local thumbnail to ensure correct aspect ratio in Telegram
					await generateThumbnail(tempFilePath, tempThumbPath)
					const thumbFile = (await fileExists(tempThumbPath, 256))
						? new InputFile(tempThumbPath)
						: undefined
					if (!thumbFile) {
						console.warn("[WARN] Thumbnail not available, sending without it", {
							url: cleanUrl(url),
							title,
							tempThumbPath,
						})
					}

					const video = new InputFile(tempFilePath)

					if (statusMessageId) {
						await updateMessage(
							ctx,
							statusMessageId,
							`Обработка: <b>${title}</b>\nСтатус: Отправляем...`,
						)
					}

					await ctx.replyWithChatAction("upload_video")
					const supportsStreaming =
						outputContainer === "mp4" && !isTiktok && !isAv1Video
					await ctx.replyWithVideo(video, {
						caption,
						parse_mode: "HTML",
						supports_streaming: supportsStreaming,
						duration,
						width,
						height,
						thumbnail: thumbFile,
						message_thread_id: threadId,
					})
				}
			}

			if (statusMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat.id, statusMessageId)
				} catch {}
			}

			if (replyToMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat.id, replyToMessageId)
				} catch {}
			}
		}
		console.log(`[SUCCESS] Sent video to chat ${ctx.chat.id}`)
	} catch (error) {
		if (isAbortError(error)) return
		console.error(`[ERROR] Failed to download/send ${url}:`, error)
		await notifyAdminError(
			ctx.chat,
			`URL: ${cleanUrl(url)}`,
			error instanceof Error ? error.message : "Unknown error",
		)
		const msg = "Ошибка."
		if (statusMessageId) {
			await updateMessage(ctx, statusMessageId, msg)
		} else if (ctx.callbackQuery) {
			await ctx.editMessageText(msg)
		} else if (ctx.chat.type === "private") {
			await ctx.reply(msg)
		}
	} finally {
		try {
			await rm(tempDir, { recursive: true, force: true })
		} catch {}
	}
}

bot.use(async (ctx, next) => {
	if (ctx.chat?.type === "private") {
		return await next()
	}

	const isGroup = ["supergroup", "group"].includes(ctx.chat?.type ?? "")
	if (ALLOW_GROUPS && isGroup) {
		return await next()
	}
})

bot.command("cookie", async (ctx) => {
	if (ctx.from?.id !== ADMIN_ID) return
	await deleteUserMessage(ctx)
	await ctx.reply(
		"Отправьте один или несколько файлов cookies.txt (текстом). Я объединю их в общий список для разных площадок.",
	)
})

bot.command("clear", async (ctx) => {
	if (ctx.from?.id !== ADMIN_ID) return
	await deleteUserMessage(ctx)
	try {
		const removed = queue.clear()
		for (const entry of removed) {
			const meta = jobMeta.get(entry.id)
			if (meta) {
				unlockUserUrl(meta.userId, meta.url, meta.lockId)
				jobMeta.delete(entry.id)
			}
		}
		for (const meta of jobMeta.values()) {
			if (meta.state === "active") {
				meta.cancel()
			}
		}
		requestCache.clear()
		await unlink(COOKIE_FILE)
		await ctx.reply("Cookies deleted, queue cleared, and request cache reset.")
	} catch (error) {
		const removed = queue.clear()
		for (const entry of removed) {
			const meta = jobMeta.get(entry.id)
			if (meta) {
				unlockUserUrl(meta.userId, meta.url, meta.lockId)
				jobMeta.delete(entry.id)
			}
		}
		for (const meta of jobMeta.values()) {
			if (meta.state === "active") {
				meta.cancel()
			}
		}
		requestCache.clear()
		await ctx.reply("Queue and cache cleared. Cookies file was not found.")
	}
})

// Handle cookies.txt upload (Admin only)
bot.on("message:document", async (ctx) => {
	console.log(`Received document from: ${ctx.from.id} (Admin: ${ADMIN_ID})`)
	console.log(`File: ${ctx.message.document.file_name}, Mime: ${ctx.message.document.mime_type}`)

	if (ctx.from.id !== ADMIN_ID) {
		console.log("Ignored: Not admin")
		return
	}

	const doc = ctx.message.document
	if (!doc.file_name?.endsWith(".txt") && doc.mime_type !== "text/plain") {
		console.log("Ignored: Not a text file")
		return
	}

	const processing = await ctx.reply("Обновляем cookies...")
	try {
		const file = await ctx.api.getFile(doc.file_id)
		if (!file.file_path) {
			throw new Error("File path not available from Telegram API.")
		}
		const absPath = resolve("/var/lib/telegram-bot-api", bot.token, file.file_path)
		const newContent = await readFile(absPath, "utf-8")
		let existingContent = ""
		try {
			existingContent = await readFile(COOKIE_FILE, "utf-8")
		} catch {}

		const mergeResult = mergeCookieContent(existingContent, newContent)
		await writeFile(COOKIE_FILE, mergeResult.content)

		const warnings: string[] = []
		if (mergeResult.incomingCookieLines === 0) {
			warnings.push("В файле не найдено cookie-строк.")
		} else if (mergeResult.invalidIncoming > 0) {
			warnings.push(
				`Некорректные строки: ${mergeResult.invalidIncoming}. Пример формата: ${cookieFormatExample}`,
			)
		}
		if (mergeResult.incomingHttpOnlyLines > 0) {
			warnings.push(
				`HttpOnly-строки сохранены: ${mergeResult.incomingHttpOnlyLines}`,
			)
		}

		const details = [
			`Добавлено: ${mergeResult.addedCookies}`,
			`Всего: ${mergeResult.totalCookies}`,
			`Location: ${COOKIE_FILE}`,
		]
		const suffix = warnings.length > 0 ? `\n${warnings.join("\n")}` : ""

		console.log("Cookies merge stats:", {
			added: mergeResult.addedCookies,
			total: mergeResult.totalCookies,
			incoming: mergeResult.incomingCookieLines,
			invalid: mergeResult.invalidIncoming,
			httpOnly: mergeResult.incomingHttpOnlyLines,
		})

		await ctx.reply(`Cookies объединены и сохранены.\n${details.join("\n")}${suffix}`)
	} catch (error) {
		console.error(error)
		let debugInfo = ""
		try {
			const rootDir = "/var/lib/telegram-bot-api"
			const files = await readdir(rootDir)
			debugInfo += `\nContents of ${rootDir}: ${files.join(", ")}`
			
			// Try to list inside token dir if it exists
			const tokenDir = resolve(rootDir, bot.token)
			const tokenFiles = await readdir(tokenDir)
			debugInfo += `\nContents of ${tokenDir}: ${tokenFiles.join(", ")}`
		} catch (e) {
			debugInfo += `\nFailed to list dirs: ${e instanceof Error ? e.message : "Unknown"}`
		}

		console.error(`DEBUG ERROR: ${error instanceof Error ? error.message : "Unknown"}${debugInfo}`)
		await ctx.reply("Ошибка.")
	} finally {
		await deleteMessage(processing)
	}
})

bot.on("message:text", async (ctx, next) => {
	if (updater.updating === false) return await next()

	const maintenanceNotice = await ctx.replyWithHTML(t.maintenanceNotice)
	await updater.updating

	await deleteMessage(maintenanceNotice)
	await next()
})

const userState = new Map<number, string>()
const userPromptMessages = new Map<number, { chatId: number; messageId: number }>()

bot.command("formats", async (ctx) => {
	await deleteUserMessage(ctx)
	const userId = ctx.from?.id
	if (!userId) return
	const previousPrompt = userPromptMessages.get(userId)
	if (previousPrompt) {
		try {
			await ctx.api.deleteMessage(previousPrompt.chatId, previousPrompt.messageId)
		} catch {}
		userPromptMessages.delete(userId)
	}
	userState.set(userId, "waiting_for_formats_url")
	const prompt = await ctx.reply("Пришлите ссылку.")
	userPromptMessages.set(userId, { chatId: ctx.chat.id, messageId: prompt.message_id })
})

bot.command("cancel", async (ctx) => {
	await deleteUserMessage(ctx)
	const userId = ctx.from?.id
	if (!userId) return
	const removedRequests = cancelUserRequests(userId)
	const { removedCount, activeCancelled, remainingActive } = cancelUserJobs(userId)
	if (
		removedCount === 0 &&
		activeCancelled === 0 &&
		remainingActive === 0 &&
		removedRequests === 0
	) {
		await ctx.reply("У вас нет активных заданий.")
		return
	}
	await ctx.reply(
		`Отменено в очереди: ${removedCount}. Запрошена отмена активных: ${activeCancelled}. Активных в работе: ${remainingActive}.`,
	)
})

bot.on("message:text", async (ctx, next) => {
	const userId = ctx.from?.id
	if (!userId) return await next()

	const state = userState.get(userId)
	if (state === "waiting_for_formats_url") {
		userState.delete(userId)
		const promptMessage = userPromptMessages.get(userId)
		if (promptMessage) {
			try {
				await ctx.api.deleteMessage(promptMessage.chatId, promptMessage.messageId)
			} catch {}
			userPromptMessages.delete(userId)
		}
		await deletePreviousMenuMessage(ctx)
		await deleteUserMessage(ctx)
		const url = ctx.message.text
		if (!url) {
			await ctx.reply("Invalid URL.")
			return
		}
		const sourceUrl = url

		const lockResult = lockUserUrl(userId, sourceUrl)
		if (!lockResult.ok) {
			await ctx.reply("Эта ссылка уже в обработке. Дождитесь завершения.")
			return
		}
		const lockId = lockResult.lockId
		let keepLock = false
		const processing = await ctx.reply("Получаем форматы...")
		try {
			let downloadUrl = url
			let bypassTitle: string | undefined
			const isThreads = threadsMatcher(downloadUrl)
			if (isThreads) {
				const threadsUsername = getThreadsUsername(sourceUrl)
				const threadsData = await resolveThreads(downloadUrl)
				if (threadsData.video_url) {
					downloadUrl = threadsData.video_url
					bypassTitle = threadsUsername || threadsData.title
				} else if (Array.isArray(threadsData.photo_urls)) {
					const caption = link(
						threadsUsername || "Threads",
						cleanUrl(sourceUrl),
					)
					await sendPhotoUrls(
						ctx,
						threadsData.photo_urls,
						caption,
						ctx.message?.message_thread_id,
						ctx.message?.message_id,
					)
					return
				}
			}
			const isPinterest = pinterestMatcher(downloadUrl)
			if (isPinterest) {
				const pinterestData = await resolvePinterest(downloadUrl)
				if (pinterestData.video_url) {
					downloadUrl = pinterestData.video_url
					bypassTitle = pinterestData.title
				} else if (Array.isArray(pinterestData.photo_urls)) {
					const caption = link(
						pinterestData.title || "Pinterest",
						cleanUrl(sourceUrl),
					)
					await sendPhotoUrls(
						ctx,
						pinterestData.photo_urls,
						caption,
						ctx.message?.message_thread_id,
						ctx.message?.message_id,
					)
					return
				}
			}
			const isYouTube = isYouTubeUrl(downloadUrl)
			const cookieArgsList = await cookieArgs()
			const youtubeArgs = isYouTube ? youtubeExtractorArgs : []
			const isTiktok = urlMatcher(downloadUrl, "tiktok.com")
			const additionalArgs = isTiktok ? tiktokArgs : []
			const genericFallbacks = shouldTryGenericFallback(sourceUrl)
				? buildGenericFallbacks(sourceUrl)
				: []
			const info = await safeGetInfoWithFallback(
				downloadUrl,
				[
					"--dump-json",
					"--no-warnings",
					"--no-playlist",
					...cookieArgsList,
					...additionalArgs,
					...impersonateArgs,
					...youtubeArgs,
				],
				undefined,
				false,
				genericFallbacks.map((attempt) => attempt.args),
			)

			if (!info.formats || info.formats.length === 0) {
				await ctx.reply("No formats found.")
				return
			}
			const formats = info.formats || []

			const requestId = randomUUID().split("-")[0]
			if (!requestId) {
				throw new Error("Failed to generate request ID.")
			}
				const filteredFormats = formats.filter((f: any) => f.format_id)
			const resolvedTitle = resolveTitle(info, isTiktok)
			const title = bypassTitle || resolvedTitle || info.title
			requestCache.set(requestId, {
				url: downloadUrl,
				sourceUrl,
				title,
				formats: filteredFormats,
				userId,
				lockId,
			})
			scheduleRequestExpiry(requestId)
			keepLock = true

			console.log(`[DEBUG] Total formats: ${formats.length}`)
			console.log(`[DEBUG] Filtered formats count: ${filteredFormats.length}`)
				console.log(
					`[DEBUG] Filtered format IDs: ${filteredFormats.map((f: any) => f.format_id).join(", ")}`,
				)

			const { dashEntries, hlsEntries, mhtmlEntries } =
				splitFormatEntries(filteredFormats)
				const hasMp3 = filteredFormats.some((f: any) => f.format_id === "251")

			await sendFormatSelector(
				ctx,
				requestId,
				title,
				dashEntries.length,
				hlsEntries.length,
				mhtmlEntries.length,
				hasMp3,
			)
		} catch (error) {
			console.error("Formats error:", error)
			await ctx.reply("Ошибка.")
		} finally {
			if (!keepLock) {
				unlockUserUrl(userId, sourceUrl, lockId)
			}
			await deleteMessage(processing)
		}
	} else {
		await next()
	}
})

bot.on("my_chat_member", async (ctx) => {
	if (ctx.myChatMember.new_chat_member.status === "member" || ctx.myChatMember.new_chat_member.status === "administrator") {
		await ctx.replyWithHTML(
			`<b>Hello!</b> I'm ready to download videos here.\n\n` +
			`I work in <b>Silent Mode</b>: just send a link (TikTok, YouTube, Instagram, etc.), and I'll reply with the video. No commands needed!`,
		)
	}
})

bot.on("message:text").on("::url", async (ctx, next) => {
	const now = Math.floor(Date.now() / 1000)
	const msgDate = ctx.message.date
	const diff = now - msgDate

	console.log(`[DEBUG] Check: MsgDate=${msgDate}, Now=${now}, Diff=${diff}s. Chat=${ctx.chat.id}`)

	if (diff > 60) {
		console.log(`[IGNORE] Old message (age: ${Math.round(diff)}s) from ${ctx.chat.id}`)
		return
	}

	const [url] = ctx.entities("url")
	if (!url) return await next()

	console.log(`[DEBUG] Processing URL from ${ctx.chat.id}: ${url.text}`)
	const sourceUrl = url.text

	const isPrivate = ctx.chat.type === "private"
	const threadId = ctx.message.message_thread_id
	let processingMessage: any
	const userId = ctx.from?.id
	if (!userId) return
	const lockResult = lockUserUrl(userId, sourceUrl)
		if (!lockResult.ok) {
			await ctx.reply("Эта ссылка уже в обработке. Дождитесь завершения.", {
				reply_to_message_id: ctx.message.message_id,
				message_thread_id: threadId,
			})
			return
		}
	const lockId = lockResult.lockId
	let keepLock = false
	let lockTransferred = false
		let deleteIncomingMessage = false

	if (isPrivate) {
		processingMessage = await ctx.replyWithHTML(t.processing, {
			disable_notification: true,
			reply_to_message_id: ctx.message.message_id,
		})
	}

	let autoDeleteProcessingMessage = true

	const useCobaltResolver = async () => {
		try {
			const resolved = await cobaltResolver(url.text)

			if (resolved.status === "error") {
				throw resolved.error
			}

			if (resolved.status === "picker") {
				const mediaItems = resolved.picker
					.filter((p) => typeof p.url === "string" && p.url.length > 0)
					.map((p) => ({
						type: p.type === "photo" ? ("photo" as const) : ("video" as const),
						media: p.url,
						...(p.type === "photo" ? {} : { supports_streaming: true }),
					}))

				const groups = chunkArray(10, mediaItems)
				for (const chunk of groups) {
					await bot.api.sendMediaGroup(ctx.chat.id, chunk, {
						reply_to_message_id: ctx.message.message_id,
						message_thread_id: threadId,
					})
				}

				return true
			}

			if (resolved.status === "redirect" || resolved.status === "tunnel") {
				const caption = link(
					"Instagram", // Default title if Cobalt doesn't provide one
					cleanUrl(url.text),
				)
				const response = await fetch(resolved.url)
				const buffer = await response.arrayBuffer()
				const inputFile = new InputFile(new Uint8Array(buffer), resolved.filename)

				if (resolved.filename.endsWith(".mp4")) {
					await ctx.replyWithVideo(inputFile, {
						caption,
						parse_mode: "HTML",
						message_thread_id: threadId,
					})
				} else {
					await ctx.replyWithPhoto(inputFile, {
						caption,
						parse_mode: "HTML",
						message_thread_id: threadId,
					})
				}
				return true
			}
		} catch (error) {
			console.error("Error resolving with cobalt", error)
		}
	}

	// Move queue logic to callback, here only prepare options
	try {
		await deletePreviousMenuMessage(ctx)
		let bypassTitle: string | undefined

		const isSora = soraMatcher(url.text)
		if (isSora) {
			const soraData = await resolveSora(url.text)
			if (soraData.video_url) {
				url.text = soraData.video_url
				bypassTitle = soraData.title
			} else if (soraData.error) {
				console.error("Sora error:", soraData.error)
				// Don't throw here, let yt-dlp try as fallback
			}
		}

		const isXfree = xfreeMatcher(url.text)
		if (isXfree) {
			const xfreeData = await resolveXfree(url.text)
			if (xfreeData.video_url) {
				url.text = xfreeData.video_url
				bypassTitle = xfreeData.title
			} else if (xfreeData.error) {
				console.error("Xfree error:", xfreeData.error)
			}
		}

		const isThreads = threadsMatcher(url.text)
		if (isThreads) {
			const threadsUsername = getThreadsUsername(sourceUrl)
			const threadsData = await resolveThreads(url.text)
			if (threadsData.video_url) {
				url.text = threadsData.video_url
				bypassTitle = threadsUsername || threadsData.title
			} else if (Array.isArray(threadsData.photo_urls)) {
				const caption = link(
					threadsUsername || "Threads",
					cleanUrl(sourceUrl),
				)
				await sendPhotoUrls(
					ctx,
					threadsData.photo_urls,
					caption,
					threadId,
					ctx.message.message_id,
				)
				return
			} else if (threadsData.error) {
				console.error("Threads error:", threadsData.error)
			}
		}

		const isPinterest = pinterestMatcher(url.text)
		if (isPinterest) {
			const pinterestData = await resolvePinterest(url.text)
			if (pinterestData.video_url) {
				url.text = pinterestData.video_url
				bypassTitle = pinterestData.title
			} else if (Array.isArray(pinterestData.photo_urls)) {
				const caption = link(
					pinterestData.title || "Pinterest",
					cleanUrl(sourceUrl),
				)
				await sendPhotoUrls(
					ctx,
					pinterestData.photo_urls,
					caption,
					threadId,
					ctx.message.message_id,
				)
				return
			} else if (pinterestData.error) {
				console.error("Pinterest error:", pinterestData.error)
			}
		}

		const isTiktok = urlMatcher(url.text, "tiktok.com")
		const useCobalt = cobaltMatcher(url.text)
		const additionalArgs = isTiktok ? tiktokArgs : []
		const isYouTube = isYouTubeUrl(url.text)
		const cookieArgsList = await cookieArgs()
		const youtubeArgs = isYouTube ? youtubeExtractorArgs : []

		if (useCobalt && !isSora) {
			if (await useCobaltResolver()) {
				return
			}
		}

		// Check available formats
		const genericFallbacks = shouldTryGenericFallback(sourceUrl)
			? buildGenericFallbacks(sourceUrl)
			: []
		const info = await safeGetInfoWithFallback(
			url.text,
			[
				"--dump-json",
				"--no-warnings",
				"-q",
				"--no-progress",
				"--no-playlist",
				...cookieArgsList,
				...additionalArgs,
				...impersonateArgs,
				...youtubeArgs,
			],
			undefined,
			false,
			genericFallbacks.map((attempt) => attempt.args),
		)

		const resolvedTitle = resolveTitle(info, isTiktok)
			const title =
				bypassTitle ||
				resolvedTitle ||
				(removeHashtagsMentions(info.title) ?? "")

		// If group chat OR always download best is enabled -> Auto download
		if (!isPrivate || ALWAYS_DOWNLOAD_BEST) {
			autoDeleteProcessingMessage = false
			const blockReason = getQueueBlockReason(userId, sourceUrl, lockId)
			if (blockReason) {
				await ctx.reply(blockReason, {
					reply_to_message_id: ctx.message.message_id,
					message_thread_id: threadId,
				})
				return
			}
			enqueueJob(userId, sourceUrl, lockId, async (signal) => {
				await downloadAndSend(
					ctx,
					url.text,
					"b",
					false,
					processingMessage?.message_id,
					title,
					ctx.message.message_id,
					signal,
					false,
					undefined,
					false,
					sourceUrl,
				)
			})
			lockTransferred = true
			return
		}

		const requestId = randomUUID().split("-")[0]
		if (!requestId) {
			throw new Error("Failed to generate request ID")
		}
		requestCache.set(requestId, {
			url: url.text,
			sourceUrl,
			title,
			userId,
			lockId,
		})
		scheduleRequestExpiry(requestId)
		keepLock = true

		const formats = info.formats || []
		const availableHeights = new Set(
			formats.map((f: any) => f.height).filter((h: any) => typeof h === "number"),
		)

		const keyboard = new InlineKeyboard()
		keyboard.text("Best (Default)", `d:${requestId}:b`).row()

		if (availableHeights.has(2160))
			keyboard.text("4K (2160p)", `d:${requestId}:2160`).row()
		if (availableHeights.has(1440))
			keyboard.text("2K (1440p)", `d:${requestId}:1440`).row()
		if (availableHeights.has(1080))
			keyboard.text("1080p", `d:${requestId}:1080`).row()
		if (availableHeights.has(720))
			keyboard.text("720p", `d:${requestId}:720`).row()
		if (availableHeights.has(480))
			keyboard.text("480p", `d:${requestId}:480`).row()

		keyboard.text("Audio (MP3)", `d:${requestId}:audio`).row()
		keyboard.text("Cancel", `d:${requestId}:cancel`)

		await deletePreviousMenuMessage(ctx)
		const menuMessage = await ctx.reply(`Select quality for: ${title}`, {
			reply_markup: keyboard,
			reply_to_message_id: ctx.message.message_id,
			message_thread_id: threadId,
		})
		trackMenuMessage(ctx, menuMessage)
	} catch (error) {
		if (await useCobaltResolver()) {
			return
		}
		
		// Only send errors in private chats to avoid spamming groups
		if (isPrivate) {
			const msg =
				error instanceof Error
					? errorMessage(ctx.chat, error.message)
					: errorMessage(ctx.chat, `Couldn't process ${url.text}`)
			await msg
		} else {
			console.error(`Group silent fail for ${url.text}:`, error)
		}
	} finally {
		if (deleteIncomingMessage) {
			await deleteUserMessage(ctx)
		}
		if (autoDeleteProcessingMessage && processingMessage) {
			try {
				await deleteMessage(processingMessage)
			} catch {}
		}
		if (!keepLock && !lockTransferred) {
			unlockUserUrl(userId, sourceUrl, lockId)
		}
	}
})

bot.on("callback_query:data", async (ctx) => {
	const data = ctx.callbackQuery.data
	if (data.startsWith("f:")) {
		const [, requestId, listType] = data.split(":")
		if (!requestId || !listType) {
			return await ctx.answerCallbackQuery({
				text: "Invalid request.",
				show_alert: true,
			})
		}
		const cached = requestCache.get(requestId)
		if (!cached?.formats) {
			await ctx.answerCallbackQuery({
				text: "Request expired or invalid.",
				show_alert: true,
			})
			return
		}

		const { dashEntries, hlsEntries, mhtmlEntries } =
			splitFormatEntries(cached.formats)
		if (listType === "dash") {
			await sendFormatSection(
				ctx,
				requestId,
				cached.title || "video",
				"DASH",
				dashEntries,
				true,
			)
		} else if (listType === "hls") {
			await sendFormatSection(
				ctx,
				requestId,
				cached.title || "video",
				"HLS",
				hlsEntries,
				false,
			)
		} else if (listType === "mhtml") {
			await sendFormatSection(
				ctx,
				requestId,
				cached.title || "video",
				"MHTML",
				mhtmlEntries,
				false,
			)
		} else if (listType === "mp3") {
			const hasMp3 = cached.formats.some((f) => f.format_id === "251")
			if (!hasMp3) {
				await ctx.answerCallbackQuery({
					text: "MP3 source not available.",
					show_alert: true,
				})
				return
			}
			const userId = ctx.from?.id
			if (!userId) return
			const blockReason = getQueueBlockReason(
				userId,
				getCacheLockUrl(cached),
				cached.lockId,
			)
			if (blockReason) {
				await ctx.answerCallbackQuery({ text: blockReason, show_alert: true })
				return
			}
			if (!cached.lockId) {
				await ctx.answerCallbackQuery({ text: "Request expired or invalid.", show_alert: true })
				return
			}
			requestCache.delete(requestId)
			await deletePreviousMenuMessage(ctx)
			const processing = await ctx.reply("Ставим в очередь MP3...")
			enqueueJob(userId, getCacheLockUrl(cached), cached.lockId, async (signal) => {
				await downloadAndSend(
					ctx,
					cached.url,
					"mp3",
					true,
					processing.message_id,
					cached.title,
					ctx.callbackQuery.message?.message_id,
					signal,
					false,
					undefined,
					false,
					cached.sourceUrl,
				)
			})
			return await ctx.answerCallbackQuery({ text: "Поставлено в очередь..." })
		} else if (listType === "back") {
			const hasMp3 = cached.formats.some((f) => f.format_id === "251")
			await sendFormatSelector(
				ctx,
				requestId,
				cached.title || "video",
				dashEntries.length,
				hlsEntries.length,
				mhtmlEntries.length,
				hasMp3,
			)
		} else {
			await ctx.answerCallbackQuery({
				text: "Unknown list type.",
				show_alert: true,
			})
			return
		}

		return await ctx.answerCallbackQuery()
	}
	if (data.startsWith("c:")) {
		const [, requestId] = data.split(":")
		if (!requestId) {
			return await ctx.answerCallbackQuery({
				text: "Invalid request.",
				show_alert: true,
			})
		}
		const cached = requestCache.get(requestId)
		if (!cached) {
			await ctx.answerCallbackQuery({
				text: "Request expired or invalid.",
				show_alert: true,
			})
			return await ctx.deleteMessage()
		}
		const { dashEntries } = splitFormatEntries(cached.formats || [])
		const videoEntries = dashEntries.filter(
			(entry) => entry.meta.hasVideo && !entry.meta.hasAudio,
		)
		await sendCombineVideoSection(
			ctx,
			requestId,
			cached.title || "video",
			videoEntries,
		)
		return await ctx.answerCallbackQuery()
	}
	if (data.startsWith("cv:")) {
		const [, requestId, videoId] = data.split(":")
		if (!requestId || !videoId) {
			return await ctx.answerCallbackQuery({
				text: "Invalid request.",
				show_alert: true,
			})
		}
		const cached = requestCache.get(requestId)
		if (!cached?.formats) {
			await ctx.answerCallbackQuery({
				text: "Request expired or invalid.",
				show_alert: true,
			})
			return await ctx.deleteMessage()
		}
		const { dashEntries } = splitFormatEntries(cached.formats)
		const audioEntries = dashEntries.filter(
			(entry) => entry.meta.hasAudio && !entry.meta.hasVideo,
		)
		await sendCombineAudioSection(
			ctx,
			requestId,
			cached.title || "video",
			videoId,
			audioEntries,
		)
		return await ctx.answerCallbackQuery()
	}
	if (data.startsWith("ca:")) {
		const [, requestId, videoId, audioId] = data.split(":")
		if (!requestId || !videoId || !audioId) {
			return await ctx.answerCallbackQuery({
				text: "Invalid request.",
				show_alert: true,
			})
		}
		const cached = requestCache.get(requestId)
		if (!cached?.formats) {
			await ctx.answerCallbackQuery({
				text: "Request expired or invalid.",
				show_alert: true,
			})
			return await ctx.deleteMessage()
		}
		const formatString = `${videoId}+${audioId}`
		const userId = ctx.from?.id
		if (!userId) return
		const blockReason = getQueueBlockReason(
			userId,
			getCacheLockUrl(cached),
			cached.lockId,
		)
		if (blockReason) {
			await ctx.answerCallbackQuery({ text: blockReason, show_alert: true })
			return
		}
		if (!cached.lockId) {
			await ctx.answerCallbackQuery({ text: "Request expired or invalid.", show_alert: true })
			return
		}
		requestCache.delete(requestId)
		await deletePreviousMenuMessage(ctx)
		const processing = await ctx.reply(
			`Ставим в очередь формат: ${formatString}...`,
		)
		enqueueJob(userId, getCacheLockUrl(cached), cached.lockId, async (signal) => {
			await downloadAndSend(
				ctx,
				cached.url,
				formatString,
				true,
				processing.message_id,
				cached.title,
				ctx.callbackQuery.message?.message_id,
				signal,
				false,
				undefined,
				false,
				cached.sourceUrl,
			)
		})
		return await ctx.answerCallbackQuery({ text: "Поставлено в очередь..." })
	}
	if (!data.startsWith("d:")) return await ctx.answerCallbackQuery()

	const [, requestId, quality] = data.split(":")
	if (!requestId || !quality) {
		return await ctx.answerCallbackQuery({
			text: "Invalid request.",
			show_alert: true,
		})
	}
	const cached = requestCache.get(requestId)

	if (!cached) {
		await ctx.answerCallbackQuery({
			text: "Request expired or invalid.",
			show_alert: true,
		})
		return await ctx.deleteMessage()
	}

	const { url, title } = cached

	if (quality === "cancel") {
		requestCache.delete(requestId)
		if (cached.lockId && cached.userId) {
			unlockUserUrl(cached.userId, getCacheLockUrl(cached), cached.lockId)
		}
		await ctx.answerCallbackQuery({ text: "Cancelled" })
		return await ctx.deleteMessage()
	}

	const predefinedQualities = ["b", "2160", "1440", "1080", "720", "480", "audio"]
	const isRawFormat = !predefinedQualities.includes(quality)
	const selectedFormat = cached.formats?.find(
		(f: any) => `${f?.format_id}` === quality,
	)
	const selectedMeta = selectedFormat ? getFormatMeta(selectedFormat) : undefined
	const dashFormatLabel =
		isRawFormat && selectedMeta?.isDash && !selectedMeta.isMhtml
			? buildFormatFilenameLabel(selectedFormat)
			: undefined
	const forceHls = !!selectedMeta?.isHls
	const forceAudio =
		!!selectedFormat &&
		selectedFormat.vcodec === "none" &&
		selectedFormat.acodec &&
		selectedFormat.acodec !== "none"
	const userId = ctx.from?.id
	if (!userId) return
	const blockReason = getQueueBlockReason(
		userId,
		getCacheLockUrl(cached),
		cached.lockId,
	)
	if (blockReason) {
		await ctx.answerCallbackQuery({ text: blockReason, show_alert: true })
		return
	}
	await ctx.answerCallbackQuery({ text: "Поставлено в очередь..." })
	await ctx.editMessageText(
		`Скачиваем ${quality === "b" ? "Лучшее" : quality}...`,
	)
	if (!cached.lockId) {
		await ctx.answerCallbackQuery({ text: "Request expired or invalid.", show_alert: true })
		return
	}
	requestCache.delete(requestId)
	enqueueJob(userId, url, cached.lockId, async (signal) => {
		await downloadAndSend(
			ctx,
			url,
			quality,
			isRawFormat,
			ctx.callbackQuery.message?.message_id,
			title,
			ctx.callbackQuery.message?.reply_to_message?.message_id,
			signal,
			forceAudio,
			dashFormatLabel,
			forceHls,
			cached.sourceUrl,
		)
	})
})
bot.on("message:text", async (ctx) => {
	// Ignore old messages in catch-all too
	if (Date.now() / 1000 - ctx.message.date > 120) return

	const response = await ctx.replyWithHTML(t.urlReminder)

	if (ctx.from.language_code && ctx.from.language_code !== "en") {
		const translated = await translateText(
			t.urlReminder,
			ctx.from.language_code,
		)
		if (translated === t.urlReminder) return
		await bot.api.editMessageText(
			ctx.chat.id,
			response.message_id,
			translated,
			{ parse_mode: "HTML", link_preview_options: { is_disabled: true } },
		)
	}
})
