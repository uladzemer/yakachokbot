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
import os from "node:os"
import { randomUUID } from "node:crypto"
import { InlineKeyboard, InputFile } from "grammy"
import type { NextFunction, Request, Response } from "express"
import VOTClient, {
	VOTWorkerClient,
} from "../vendor/node_modules/@vot.js/node/dist/client.js"
import { getVideoData } from "../vendor/node_modules/@vot.js/node/dist/utils/videoData.js"
import { cookieFormatExample, mergeCookieContent } from "./cookies"
import { deleteMessage, errorMessage, notifyAdminError } from "./bot-util"
import { cobaltMatcher, cobaltResolver } from "./cobalt"
import { bold, code, link, t, tiktokArgs, impersonateArgs, jsRuntimeArgs } from "./constants"
import { getErrorLogs, logErrorEntry } from "./error-log"
import {
	ADMIN_ID,
	ALLOW_GROUPS,
	ALWAYS_DOWNLOAD_BEST,
	API_ROOT,
	ADMIN_ONLY,
	CLEANUP_INTERVAL_HOURS,
	CLEANUP_MAX_AGE_HOURS,
	ADMIN_DASHBOARD_TOKEN,
	ADMIN_DASHBOARD_USER,
	ADMIN_DASHBOARD_PASSWORD,
	COOKIE_FILE,
	cookieArgs,
	STORAGE_DIR,
	BANS_FILE,
	LINKS_FILE,
	ACTIVITY_FILE,
	SYSTEM_HISTORY_FILE,
	PROXY_FILE,
	USERS_FILE,
	YTDL_PROXY,
	YOUTUBE_FETCH_POT,
	YOUTUBE_PO_TOKEN,
	YOUTUBE_POT_PROVIDER_URL,
	YOUTUBE_POT_DISABLE_INNERTUBE,
	WHITELISTED_IDS,
	VOT_REQUEST_LANG,
	VOT_RESPONSE_LANG,
	VOT_WORKER_HOST,
	VOT_WORKER_FALLBACK_SECONDS,
	VOT_STATUS_VERBOSE,
	VOT_LIVELY_VOICE,
	VOT_OAUTH_TOKEN,
	VOT_MAX_WAIT_SECONDS,
} from "./environment"
import { getThumbnail, urlMatcher, getVideoMetadata, generateThumbnail } from "./media-util"
import { Queue } from "./queue"
import { bot, server } from "./setup"
import { translateText } from "./translate"
import { Updater } from "./updater"
import { chunkArray, removeHashtagsMentions, cleanUrl, cutoffWithNotice } from "./util"
import { readJsonFile, writeFileAtomic } from "./file-util"
import { execFile, spawn, type ExecFileOptions } from "node:child_process"

const TEMP_PREFIX = "yakachokbot-"
const AUDIO_LOUDNORM_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11"
const AUDIO_LOUDNORM_MUSIC_FILTER = "loudnorm=I=-14:TP=-1.0:LRA=11"
const TRANSLATION_AUDIO_FILTER = "alimiter=limit=0.9"
const SPONSORBLOCK_BASE_URL = "https://sponsor.ajay.app"
const SPONSORBLOCK_TIMEOUT_MS = 15000
const SPONSORBLOCK_FETCH_RETRIES = 3
const SPONSORBLOCK_MIN_GAP_SECONDS = 0.3
const SPONSORBLOCK_DEFAULT_CATEGORIES = ["sponsor"]
const SPONSORBLOCK_ALL_CATEGORIES = [
	"sponsor",
	"selfpromo",
	"interaction",
	"intro",
	"outro",
	"preview",
	"poi_highlight",
	"filler",
	"music_offtopic",
]

const isAllSponsorCategoriesSelected = (categories?: string[]) => {
	if (!Array.isArray(categories) || categories.length === 0) return false
	const selected = new Set(categories)
	return SPONSORBLOCK_ALL_CATEGORIES.every((category) => selected.has(category))
}
const cleanupIntervalHours = Number.isFinite(CLEANUP_INTERVAL_HOURS)
	? Math.max(1, CLEANUP_INTERVAL_HOURS)
	: 6
const cleanupMaxAgeHours = Number.isFinite(CLEANUP_MAX_AGE_HOURS)
	? Math.max(1, CLEANUP_MAX_AGE_HOURS)
	: 12

const ensureStorageDir = async () => {
	try {
		await mkdir(STORAGE_DIR, { recursive: true })
	} catch (error) {
		console.error("Failed to create storage dir:", error)
	}
}

const notifyAdminLog = async (title: string, error: unknown) => {
	if (ADMIN_ONLY) return
	try {
		const details =
			error instanceof Error ? error.stack || error.message : String(error)
		logErrorEntry({ context: title, error: details }).catch((logError) => {
			console.error("Failed to log error entry:", logError)
		})
		const message = [
			bold(title),
			code(cutoffWithNotice(details)),
		].join("\n\n")
		await bot.api.sendMessage(ADMIN_ID, message, { parse_mode: "HTML" })
	} catch (notifyError) {
		console.error("Failed to notify admin:", notifyError)
	}
}

const redactUrl = (value: string) => {
	try {
		const parsed = new URL(value)
		parsed.search = ""
		parsed.hash = ""
		return parsed.toString()
	} catch {
		return value
	}
}

const logTranslate = (message: string, details?: Record<string, unknown>) => {
	if (details && Object.keys(details).length > 0) {
		console.log(`[TRANSLATE] ${message}`, details)
	} else {
		console.log(`[TRANSLATE] ${message}`)
	}
}

const createTranslationUnsupportedError = (details?: string) => {
	const error = new Error("TRANSLATION_UNSUPPORTED")
	;(error as any).code = "TRANSLATION_UNSUPPORTED"
	;(error as any).userMessage = "Перевод для этой площадки не поддерживается."
	if (details) {
		;(error as any).details = details
	}
	return error
}

const isTranslationUnsupportedError = (error: unknown) => {
	if (!error) return false
	const message = error instanceof Error ? error.message : String(error)
	if ((error as any)?.code === "TRANSLATION_UNSUPPORTED") return true
	if (message === "TRANSLATION_UNSUPPORTED") return true
	return /unknown service|unsupported link|unsupported service|not supported/i.test(
		message,
	)
}

const getTranslationUnsupportedMessage = (error: unknown) => {
	const message =
		(error as any)?.userMessage ||
		"Перевод для этой площадки не поддерживается."
	return message
}

const formatVerboseStatus = (
	base: string,
	details?: Record<string, unknown>,
) => {
	if (!VOT_STATUS_VERBOSE) return base
	const timeValue =
		details?.time ?? details?.elapsed ?? details?.total ?? undefined
	if (!timeValue) return base
	return `${base}\nВремя: ${timeValue}`
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
	const redirects = new Map<number, number>()
	return async (
		ctx: any,
		messageId: number,
		text: string,
		options?: { force?: boolean },
	) => {
		const force = options?.force === true
		const resolvedId = redirects.get(messageId) ?? messageId
		const now = Date.now()
		const last = lastUpdates.get(resolvedId) || 0
		if (!force && now - last < 1500) return
		lastUpdates.set(resolvedId, now)
		try {
			await ctx.api.editMessageText(ctx.chat.id, resolvedId, text, {
				parse_mode: "HTML",
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (VOT_STATUS_VERBOSE) {
				console.warn("[WARN] Failed to edit status message", {
					messageId,
					resolvedId,
					error: message,
				})
			}
			if (/message is not modified/i.test(message)) return
			if (
				/message to edit not found|message can't be edited|message_id_invalid|bad request/i.test(
					message,
				)
			) {
				try {
					const threadId =
						ctx.message?.message_thread_id ||
						ctx.callbackQuery?.message?.message_thread_id
					const sent = await ctx.reply(text, {
						message_thread_id: threadId,
					})
					if (sent?.message_id) {
						redirects.set(messageId, sent.message_id)
						redirects.set(sent.message_id, sent.message_id)
						lastUpdates.set(sent.message_id, now)
					}
				} catch {}
			}
		}
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

type UserProfile = {
	id: number
	username?: string
	first_name?: string
	last_name?: string
	language_code?: string
	is_bot?: boolean
	last_seen?: string
	chat_id?: number
	requests?: number
	downloads?: number
}

type BanEntry = {
	id: number
	at: number
	by: number
	reason?: string
}

type UserReport = {
	id: string
	userId: number
	chatId: number
	messageId?: number
	context?: string
	error?: string
	promptText?: string
	createdAt: number
}

const users = new Map<number, UserProfile>()
let usersLoaded = false
let usersSaveTimer: NodeJS.Timeout | undefined

const bans = new Map<number, BanEntry>()
let bansLoaded = false

const userReports = new Map<string, UserReport>()

const userLinks = new Map<number, LinkHistoryEntry[]>()
let userLinksLoaded = false
let userLinksSaveTimer: NodeJS.Timeout | undefined

let activitySaveTimer: NodeJS.Timeout | undefined

const systemHistory: SystemHistoryEntry[] = []
let systemHistoryLoaded = false
let systemHistorySaveTimer: NodeJS.Timeout | undefined

type UserStatsSnapshot = {
	generatedAt: string
	usersTotal: number
	bannedTotal: number
	active24h: number
	active7d: number
	active30d: number
	requestsTotal: number
	downloadsTotal: number
	queuePending: number
	queueActive: number
	activeJobs: number
	activeUsers: number
	topUsers: Array<{
		id: number
		label: string
		requests: number
		downloads: number
		lastSeen?: string
	}>
}

type UserListEntry = {
	id: number
	label: string
	username?: string
	firstName?: string
	lastName?: string
	requests: number
	downloads: number
	lastSeen?: string
	chatId?: number
	banned?: boolean
	banAt?: string
	banReason?: string
}

type LinkHistoryEntry = {
	id: string
	userId: number
	url: string
	status: "requested" | "queued" | "success" | "error"
	at: string
	error?: string
}

type SystemHistoryEntry = {
	at: string
	load1: number
	memPercent: number
}

const loadUsers = async () => {
	if (usersLoaded) return
	usersLoaded = true
	const data = await readJsonFile(
		USERS_FILE,
		{ users: {} } as { users?: Record<string, UserProfile> },
		{ label: "users", backupOnError: true },
	)
	const entries = data?.users ?? {}
	for (const [key, value] of Object.entries(entries)) {
		const id = Number.parseInt(key)
		if (Number.isNaN(id)) continue
		users.set(id, { ...value, id })
	}
}

const saveUsers = async () => {
	try {
		const entries: Record<string, UserProfile> = {}
		for (const [id, profile] of users.entries()) {
			entries[String(id)] = profile
		}
		await writeFileAtomic(USERS_FILE, JSON.stringify({ users: entries }, null, 2))
	} catch (error) {
		console.error("Failed to save users:", error)
	}
}

const scheduleUsersSave = () => {
	if (usersSaveTimer) return
	usersSaveTimer = setTimeout(() => {
		usersSaveTimer = undefined
		saveUsers().catch((error) => {
			console.error("Failed to save users:", error)
		})
	}, 2000)
}

const incrementUserCounter = async (
	userId: number,
	field: "requests" | "downloads",
) => {
	await loadUsers()
	const existing = users.get(userId) || { id: userId }
	const next = (existing[field] ?? 0) + 1
	users.set(userId, { ...existing, [field]: next })
	scheduleUsersSave()
}

const loadBans = async () => {
	if (bansLoaded) return
	bansLoaded = true
	const data = await readJsonFile(
		BANS_FILE,
		{ bans: {} } as { bans?: Record<string, BanEntry> },
		{ label: "bans", backupOnError: true },
	)
	const entries = data?.bans ?? {}
	for (const [key, value] of Object.entries(entries)) {
		const id = Number.parseInt(key)
		if (Number.isNaN(id)) continue
		bans.set(id, { ...value, id })
	}
}

const saveBans = async () => {
	try {
		const entries: Record<string, BanEntry> = {}
		for (const [id, entry] of bans.entries()) {
			entries[String(id)] = entry
		}
		await writeFileAtomic(BANS_FILE, JSON.stringify({ bans: entries }, null, 2))
	} catch (error) {
		console.error("Failed to save bans:", error)
	}
}

const loadUserLinks = async () => {
	if (userLinksLoaded) return
	userLinksLoaded = true
	const data = await readJsonFile(
		LINKS_FILE,
		{ links: {} } as { links?: Record<string, LinkHistoryEntry[]> },
		{ label: "links", backupOnError: true },
	)
	for (const [key, value] of Object.entries(data?.links ?? {})) {
		const id = Number.parseInt(key)
		if (Number.isNaN(id)) continue
		if (!Array.isArray(value)) continue
		const list = value
			.filter(
				(entry) =>
					typeof entry?.url === "string" &&
					typeof entry?.status === "string" &&
					typeof entry?.at === "string",
			)
			.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
		userLinks.set(id, list.slice(0, 200))
	}
}

const saveUserLinks = async () => {
	try {
		const entries: Record<string, LinkHistoryEntry[]> = {}
		for (const [id, list] of userLinks.entries()) {
			entries[String(id)] = list
		}
		await writeFileAtomic(LINKS_FILE, JSON.stringify({ links: entries }, null, 2))
	} catch (error) {
		console.error("Failed to save user links:", error)
	}
}

const scheduleUserLinksSave = () => {
	if (userLinksSaveTimer) return
	userLinksSaveTimer = setTimeout(() => {
		userLinksSaveTimer = undefined
		saveUserLinks().catch((error) => {
			console.error("Failed to save user links:", error)
		})
	}, 2000)
}

const saveActivitySnapshot = async () => {
	try {
		const jobs = Array.from(jobMeta.values()).map((job) => ({
			id: job.id,
			userId: job.userId,
			url: job.url,
			state: job.state,
		}))
		const payload = {
			updatedAt: new Date().toISOString(),
			pending: queue.getPendingCount(),
			active: queue.getActiveCount(),
			jobs,
		}
		await writeFileAtomic(ACTIVITY_FILE, JSON.stringify(payload, null, 2))
	} catch (error) {
		console.error("Failed to save activity snapshot:", error)
	}
}

const scheduleActivitySave = () => {
	if (activitySaveTimer) return
	activitySaveTimer = setTimeout(() => {
		activitySaveTimer = undefined
		saveActivitySnapshot().catch((error) => {
			console.error("Failed to save activity snapshot:", error)
		})
	}, 1000)
}

const loadSystemHistory = async () => {
	if (systemHistoryLoaded) return
	systemHistoryLoaded = true
	const data = await readJsonFile(
		SYSTEM_HISTORY_FILE,
		{ samples: [] } as { samples?: SystemHistoryEntry[] },
		{ label: "system history", backupOnError: true },
	)
	if (Array.isArray(data?.samples)) {
		systemHistory.push(...data.samples)
	}
}

const saveSystemHistory = async () => {
	try {
		await writeFileAtomic(
			SYSTEM_HISTORY_FILE,
			JSON.stringify({ samples: systemHistory }, null, 2),
		)
	} catch (error) {
		console.error("Failed to save system history:", error)
	}
}

const scheduleSystemHistorySave = () => {
	if (systemHistorySaveTimer) return
	systemHistorySaveTimer = setTimeout(() => {
		systemHistorySaveTimer = undefined
		saveSystemHistory().catch((error) => {
			console.error("Failed to save system history:", error)
		})
	}, 2000)
}

const recordSystemSample = async () => {
	await loadSystemHistory()
	const totalMem = os.totalmem()
	const freeMem = os.freemem()
	const usedMem = totalMem - freeMem
	const memPercent = totalMem ? (usedMem / totalMem) * 100 : 0
	const load = os.loadavg()
	systemHistory.push({
		at: new Date().toISOString(),
		load1: load[0] ?? 0,
		memPercent,
	})
	const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
	while (true) {
		const first = systemHistory[0]
		if (!first) break
		if (Date.parse(first.at) >= cutoff) break
		systemHistory.shift()
	}
	if (systemHistory.length > 10080) {
		systemHistory.splice(0, systemHistory.length - 10080)
	}
	scheduleSystemHistorySave()
}

const startSystemHistoryCollector = () => {
	recordSystemSample().catch((error) => {
		console.error("Failed to record system sample:", error)
	})
	setInterval(() => {
		recordSystemSample().catch((error) => {
			console.error("Failed to record system sample:", error)
		})
	}, 60 * 1000).unref()
}

const isBanned = async (userId: number) => {
	await loadBans()
	return bans.has(userId)
}

const parseCookieStats = (content: string) => {
	const lines = content.split(/\r?\n/)
	const now = Math.floor(Date.now() / 1000)
	let total = 0
	let expired = 0
	let session = 0
	let earliestExpiry: number | undefined
	let latestExpiry: number | undefined

	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed) continue
		if (trimmed.startsWith("#") && !trimmed.startsWith("#HttpOnly_")) {
			continue
		}
		const parts = trimmed.split("\t")
		if (parts.length < 7) continue
		total += 1
		const rawExpiry = Number.parseInt(parts[4] || "0", 10)
		if (!Number.isFinite(rawExpiry) || rawExpiry <= 0) {
			session += 1
			continue
		}
		if (rawExpiry < now) {
			expired += 1
		}
		if (earliestExpiry === undefined || rawExpiry < earliestExpiry) {
			earliestExpiry = rawExpiry
		}
		if (latestExpiry === undefined || rawExpiry > latestExpiry) {
			latestExpiry = rawExpiry
		}
	}

	return {
		total,
		expired,
		session,
		earliestExpiry: earliestExpiry
			? new Date(earliestExpiry * 1000).toISOString()
			: undefined,
		latestExpiry: latestExpiry
			? new Date(latestExpiry * 1000).toISOString()
			: undefined,
	}
}

const buildProxyStatus = async () => {
	const envValue = YTDL_PROXY.trim()
	let fileValue = ""
	let fileMeta: { size: number; updatedAt: string } | undefined
	try {
		const stats = await stat(PROXY_FILE)
		if (stats.isFile()) {
			fileValue = (await readFile(PROXY_FILE, "utf-8")).trim()
			fileMeta = {
				size: stats.size,
				updatedAt: stats.mtime.toISOString(),
			}
		}
	} catch {}
	const active = fileValue || envValue || ""
	const source = fileValue ? "file" : envValue ? "env" : "none"
	return {
		active,
		source,
		fileValue,
		envValue,
		fileMeta,
	}
}

const readProxyValue = async () => {
	const fromEnv = YTDL_PROXY.trim()
	try {
		const stored = (await readFile(PROXY_FILE, "utf-8")).trim()
		if (stored) return stored
	} catch {}
	return fromEnv
}

const getProxyArgs = async () => {
	const proxy = await readProxyValue()
	return proxy ? ["--proxy", proxy] : []
}

const logUserLink = async (
	userId: number | undefined,
	url: string,
	status: LinkHistoryEntry["status"],
	error?: string,
) => {
	if (!userId || !url) return
	await loadUserLinks()
	const normalized = cleanUrl(url)
	const list = userLinks.get(userId) ?? []
	const entry: LinkHistoryEntry = {
		id: randomUUID(),
		userId,
		url: normalized,
		status,
		at: new Date().toISOString(),
		error: error ? cutoffWithNotice(String(error)) : undefined,
	}
	list.unshift(entry)
	if (list.length > 200) list.length = 200
	userLinks.set(userId, list)
	scheduleUserLinksSave()
}

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")

const buildUserStatsSnapshot = async (): Promise<UserStatsSnapshot> => {
	await loadUsers()
	await loadBans()
	const now = Date.now()
	const dayMs = 24 * 60 * 60 * 1000
	const active24h = Array.from(users.values()).filter((u) => {
		if (!u.last_seen) return false
		return now - Date.parse(u.last_seen) <= dayMs
	}).length
	const active7d = Array.from(users.values()).filter((u) => {
		if (!u.last_seen) return false
		return now - Date.parse(u.last_seen) <= 7 * dayMs
	}).length
	const active30d = Array.from(users.values()).filter((u) => {
		if (!u.last_seen) return false
		return now - Date.parse(u.last_seen) <= 30 * dayMs
	}).length

	let requestsTotal = 0
	let downloadsTotal = 0
	for (const profile of users.values()) {
		requestsTotal += profile.requests ?? 0
		downloadsTotal += profile.downloads ?? 0
	}

	const topUsers = Array.from(users.values())
		.sort((a, b) => (b.requests ?? 0) - (a.requests ?? 0))
		.slice(0, 10)
		.map((u) => ({
			id: u.id,
			label: formatUserLabel(u),
			requests: u.requests ?? 0,
			downloads: u.downloads ?? 0,
			lastSeen: u.last_seen,
		}))

	const activeJobs = Array.from(jobMeta.values()).filter(
		(job) => job.state === "active",
	)
	const activeUsers = new Set(activeJobs.map((job) => job.userId)).size

	return {
		generatedAt: new Date().toISOString(),
		usersTotal: users.size,
		bannedTotal: bans.size,
		active24h,
		active7d,
		active30d,
		requestsTotal,
		downloadsTotal,
		queuePending: queue.getPendingCount(),
		queueActive: queue.getActiveCount(),
		activeJobs: activeJobs.length,
		activeUsers,
		topUsers,
	}
}

const buildUserList = async (): Promise<UserListEntry[]> => {
	await loadUsers()
	await loadBans()
	const list = Array.from(users.values()).map((u) => {
		const ban = bans.get(u.id)
		return {
			id: u.id,
			label: formatUserLabel(u),
			username: u.username,
			firstName: u.first_name,
			lastName: u.last_name,
			requests: u.requests ?? 0,
			downloads: u.downloads ?? 0,
			lastSeen: u.last_seen,
			chatId: u.chat_id,
			banned: Boolean(ban),
			banAt: ban ? new Date(ban.at).toISOString() : undefined,
			banReason: ban?.reason,
		}
	})
	list.sort((a, b) => {
		const aTime = a.lastSeen ? Date.parse(a.lastSeen) : 0
		const bTime = b.lastSeen ? Date.parse(b.lastSeen) : 0
		if (aTime !== bTime) return bTime - aTime
		return (b.requests ?? 0) - (a.requests ?? 0)
	})
	return list
}

const getUserLinks = async (userId: number) => {
	await loadUserLinks()
	return userLinks.get(userId) ?? []
}

const getAllLinks = async () => {
	await loadUserLinks()
	const all: Array<LinkHistoryEntry & { userId: number }> = []
	for (const [userId, list] of userLinks.entries()) {
		for (const entry of list) {
			all.push({ ...entry, userId })
		}
	}
	all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
	return all
}

const requireDashboardAuth = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	const token = ADMIN_DASHBOARD_TOKEN.trim()
	const user = ADMIN_DASHBOARD_USER.trim()
	const password = ADMIN_DASHBOARD_PASSWORD
	if (!token && !(user && password)) {
		res.status(403).send("Admin auth is not configured.")
		return
	}

	const header = req.header("authorization") || ""
	if (header.toLowerCase().startsWith("basic ")) {
		const encoded = header.slice(6).trim()
		try {
			const decoded = Buffer.from(encoded, "base64").toString("utf8")
			const [basicUser, basicPass] = decoded.split(":")
			if (basicUser === user && basicPass === password) {
				next()
				return
			}
		} catch {}
		res.setHeader("WWW-Authenticate", "Basic realm=\"Yakachokbot Admin\"")
		res.status(401).send("Unauthorized")
		return
	}

	const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
	const queryToken =
		typeof req.query.token === "string" ? req.query.token.trim() : ""
	const provided = bearer || queryToken
	if (provided && provided === token) {
		next()
		return
	}
	res.setHeader("WWW-Authenticate", "Basic realm=\"Yakachokbot Admin\"")
	res.status(401).send("Unauthorized")
}

const safeGetInfoWithFallback = async (
	url: string,
	args: string[],
	signal?: AbortSignal,
	skipJsRuntime = false,
	fallbackArgs: string[][] = [],
	proxyArgsOverride?: string[],
) => {
	let lastError: unknown
	const hasProxyArg =
		args.includes("--proxy") ||
		fallbackArgs.some((entry) => entry.includes("--proxy"))
	const proxyArgs =
		proxyArgsOverride ??
		(hasProxyArg ? [] : await getProxyArgs())
	const proxyFallbacks =
		proxyArgs.length > 0 ? [...fallbackArgs, proxyArgs] : fallbackArgs
	try {
		return await safeGetInfo(url, args, signal, skipJsRuntime)
	} catch (error) {
		lastError = error
	}
	if (proxyArgs.length > 0) {
		console.log("[DEBUG] Retrying yt-dlp with proxy for info fetch")
	}
	for (const extraArgs of proxyFallbacks) {
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

const trimTrailingUrlPunctuation = (value: string) =>
	value.replace(/[)\].,!?:;]+$/g, "")

const extractUrlsFromMessage = (message: any) => {
	const text = message?.text || message?.caption || ""
	const entities = Array.isArray(message?.entities)
		? message.entities
		: Array.isArray(message?.caption_entities)
			? message.caption_entities
			: []
	const urls: string[] = []
	for (const entity of entities) {
		if (
			entity?.type === "url" &&
			typeof entity.offset === "number" &&
			typeof entity.length === "number"
		) {
			urls.push(text.slice(entity.offset, entity.offset + entity.length))
			continue
		}
		if (entity?.type === "text_link" && typeof entity.url === "string") {
			urls.push(entity.url)
		}
	}
	if (urls.length === 0 && text) {
		const matches = text.match(/https?:\/\/\S+/g)
		if (matches) urls.push(...matches)
	}
	return urls.map(trimTrailingUrlPunctuation).filter(Boolean)
}

const extractMessageUrls = (ctx: any) => extractUrlsFromMessage(ctx.message)

const isYouTubeUrl = (url: string) => {
	try {
		return urlMatcher(url, "youtube.com") || urlMatcher(url, "youtu.be")
	} catch {
		return false
	}
}

const extractYouTubeVideoId = (url: string) => {
	try {
		const parsed = new URL(url)
		const host = parsed.hostname.toLowerCase()
		if (host.endsWith("youtu.be")) {
			const id = parsed.pathname.split("/").filter(Boolean)[0]
			return id || null
		}
		if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
			const v = parsed.searchParams.get("v")
			if (v) return v
			const parts = parsed.pathname.split("/").filter(Boolean)
			if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") {
				return parts[1] || null
			}
		}
		return null
	} catch {
		return null
	}
}

const fetchSponsorSegments = async (
	videoId: string,
	categories: string[] = SPONSORBLOCK_DEFAULT_CATEGORIES,
) => {
	const normalizedCategories =
		Array.isArray(categories) && categories.length > 0
			? categories
			: SPONSORBLOCK_DEFAULT_CATEGORIES
	const categoriesParam = encodeURIComponent(JSON.stringify(normalizedCategories))
	const apiUrl = `${SPONSORBLOCK_BASE_URL}/api/skipSegments?videoID=${encodeURIComponent(videoId)}&categories=${categoriesParam}`

	let lastError: unknown
	for (let attempt = 1; attempt <= SPONSORBLOCK_FETCH_RETRIES; attempt += 1) {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), SPONSORBLOCK_TIMEOUT_MS)
		try {
			const res = await fetch(apiUrl, {
				signal: controller.signal,
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				},
			})
			if (res.status === 404) return []
			if (!res.ok) {
				throw new Error(`SponsorBlock HTTP ${res.status}`)
			}
			const data = await res.json()
			if (!Array.isArray(data)) return []
			const ranges: Array<[number, number]> = []
			for (const entry of data) {
				const segment = entry?.segment
				if (!Array.isArray(segment) || segment.length < 2) continue
				const start = Number(segment[0])
				const end = Number(segment[1])
				if (!Number.isFinite(start) || !Number.isFinite(end)) continue
				if (end <= start) continue
				ranges.push([start, end])
			}
			return ranges
		} catch (error) {
			lastError = error
			const name = (error as any)?.name
			const message = error instanceof Error ? error.message : String(error)
			const transient =
				name === "AbortError" ||
				/timed? ?out|network|fetch failed|socket|econnreset|etimedout/i.test(
					message,
				)
			if (!transient || attempt >= SPONSORBLOCK_FETCH_RETRIES) {
				throw error
			}
			const delayMs = 1000 * attempt
			console.warn("[WARN] SponsorBlock fetch transient error, retrying", {
				attempt,
				delayMs,
				error: message,
			})
			await sleepMs(delayMs)
		} finally {
			clearTimeout(timeout)
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("SponsorBlock fetch failed")
}

const mergeSponsorSegments = (segments: Array<[number, number]>, duration?: number) => {
	const sorted = [...segments].sort((a, b) => a[0] - b[0])
	const merged: Array<[number, number]> = []
	for (const [rawStart, rawEnd] of sorted) {
		let start = Math.max(0, rawStart)
		let end = Math.max(start, rawEnd)
		if (typeof duration === "number") {
			start = Math.min(start, duration)
			end = Math.min(end, duration)
		}
		if (end <= start) continue
		const last = merged[merged.length - 1]
		if (last && start <= last[1] + 0.01) {
			last[1] = Math.max(last[1], end)
		} else {
			merged.push([start, end])
		}
	}
	return merged
}

const buildKeepRanges = (segments: Array<[number, number]>, duration: number) => {
	const keep: Array<[number, number]> = []
	let cursor = 0
	for (const [start, end] of segments) {
		if (start - cursor > SPONSORBLOCK_MIN_GAP_SECONDS) {
			keep.push([cursor, start])
		}
		cursor = Math.max(cursor, end)
		if (cursor >= duration) break
	}
	if (duration - cursor > SPONSORBLOCK_MIN_GAP_SECONDS) {
		keep.push([cursor, duration])
	}
	return keep
}

const trimVideoByRangesFilterFallback = async (
	inputPath: string,
	ranges: Array<[number, number]>,
	outputPath: string,
	container: string,
	signal?: AbortSignal,
) => {
	const chunks: string[] = []
	const concatInputs: string[] = []
	for (const [index, [start, end]] of ranges.entries()) {
		chunks.push(
			`[0:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`,
		)
		chunks.push(
			`[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`,
		)
		concatInputs.push(`[v${index}][a${index}]`)
	}
	chunks.push(
		`${concatInputs.join("")}concat=n=${ranges.length}:v=1:a=1[vout][aout]`,
	)
	const args = [
		"-y",
		"-i",
		inputPath,
		"-filter_complex",
		chunks.join(";"),
		"-map",
		"[vout]",
		"-map",
		"[aout]",
	]
	if (container === "webm") {
		args.push(
			"-c:v",
			"libvpx-vp9",
			"-crf",
			"33",
			"-b:v",
			"0",
			"-row-mt",
			"1",
			"-cpu-used",
			"4",
			"-c:a",
			"libopus",
			"-b:a",
			"128k",
		)
	} else {
		args.push(
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"23",
			"-c:a",
			"aac",
			"-b:a",
			"160k",
		)
		if (container === "mp4") {
			args.push("-movflags", "+faststart")
		}
	}
	args.push(outputPath)
	await spawnPromise("ffmpeg", args, undefined, signal)
}

const trimVideoByRanges = async (
	inputPath: string,
	ranges: Array<[number, number]>,
	outputPath: string,
	container: string,
	signal?: AbortSignal,
	copyOnly = false,
) => {
	const validRanges = ranges.filter(
		([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end - start >= 0.35,
	)
	if (validRanges.length === 0) {
		throw new Error("No valid ranges for SponsorBlock trim")
	}
	const partFiles: string[] = []
	const partTsFiles: string[] = []
	let mp4TsConcatSucceeded = false
	for (const [index, [start, end]] of validRanges.entries()) {
		const partPath = `${inputPath}.sb_part_${index}.${container}`
		const args = [
			"-y",
			"-ss",
			`${start}`,
			"-to",
			`${end}`,
			"-i",
			inputPath,
			"-c",
			"copy",
			"-avoid_negative_ts",
			"make_zero",
			"-reset_timestamps",
			"1",
		]
		if (container === "mp4") {
			args.push("-movflags", "+faststart")
		}
		args.push(partPath)
		await spawnPromise("ffmpeg", args, undefined, signal)
		if (await fileExists(partPath, 1024)) {
			partFiles.push(partPath)
		}
	}
	if (partFiles.length === 0) {
		throw new Error("SponsorBlock trim produced no valid parts")
	}
	if (partFiles.length === 1) {
		await spawnPromise("ffmpeg", ["-y", "-i", partFiles[0], "-c", "copy", outputPath], undefined, signal)
		try {
			await unlink(partFiles[0])
		} catch {}
		return
	}
	const concatPath = `${inputPath}.sb_concat.txt`
	const concatContent = partFiles.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n")
	await writeFile(concatPath, concatContent)
	const concatArgs = [
		"-y",
		"-f",
		"concat",
		"-safe",
		"0",
		"-fflags",
		"+genpts",
		"-avoid_negative_ts",
		"make_zero",
		"-i",
		concatPath,
		"-c",
		"copy",
	]
	if (container === "mp4") {
		concatArgs.push("-movflags", "+faststart")
	}
	concatArgs.push(outputPath)
	try {
		await spawnPromise("ffmpeg", concatArgs, undefined, signal)
	} catch (copyConcatError) {
		if (copyOnly) {
			if (container === "mp4") {
				try {
					for (const partFile of partFiles) {
						const tsPath = `${partFile}.ts`
						await spawnPromise(
							"ffmpeg",
							[
								"-y",
								"-i",
								partFile,
								"-c",
								"copy",
								"-bsf:v",
								"h264_mp4toannexb",
								"-f",
								"mpegts",
								tsPath,
							],
							undefined,
							signal,
						)
						if (await fileExists(tsPath, 1024)) {
							partTsFiles.push(tsPath)
						}
					}
					if (partTsFiles.length >= 2) {
						const concatProtocol = `concat:${partTsFiles
							.map((file) => file.replace(/\|/g, "\\|"))
							.join("|")}`
						await spawnPromise(
							"ffmpeg",
							[
								"-y",
								"-i",
								concatProtocol,
								"-c",
								"copy",
								"-bsf:a",
								"aac_adtstoasc",
								"-movflags",
								"+faststart",
								outputPath,
							],
							undefined,
							signal,
						)
						mp4TsConcatSucceeded = true
					}
				} catch (copyTsConcatError) {
					console.warn("[WARN] SponsorBlock: mp4 ts concat copy failed", {
						error:
							copyTsConcatError instanceof Error
								? copyTsConcatError.message
								: String(copyTsConcatError),
					})
				}
				if (mp4TsConcatSucceeded) {
					// Keep stream copy behavior for "all categories" mode without re-encode.
				} else {
					throw copyConcatError
				}
			}
			if (!mp4TsConcatSucceeded) {
				throw copyConcatError
			}
		}
			if (!copyOnly || !mp4TsConcatSucceeded) {
				console.warn("[WARN] SponsorBlock: concat copy failed, retrying with re-encode", {
					container,
					error:
						copyConcatError instanceof Error
							? copyConcatError.message
							: String(copyConcatError),
				})
				const reencodeArgs = [
					"-y",
					"-f",
					"concat",
					"-safe",
					"0",
					"-fflags",
					"+genpts",
					"-avoid_negative_ts",
					"make_zero",
					"-i",
					concatPath,
				]
				if (container === "webm") {
					reencodeArgs.push(
						"-c:v",
						"libvpx-vp9",
						"-crf",
						"33",
						"-b:v",
						"0",
						"-row-mt",
						"1",
						"-cpu-used",
						"4",
						"-c:a",
						"libopus",
						"-b:a",
						"128k",
					)
				} else {
					reencodeArgs.push(
						"-c:v",
						"libx264",
						"-preset",
						"veryfast",
						"-crf",
						"23",
						"-c:a",
						"aac",
						"-b:a",
						"160k",
					)
					if (container === "mp4") {
						reencodeArgs.push("-movflags", "+faststart")
					}
				}
				reencodeArgs.push(outputPath)
				try {
					await spawnPromise("ffmpeg", reencodeArgs, undefined, signal)
				} catch (reencodeConcatError) {
					console.warn("[WARN] SponsorBlock: concat re-encode failed, retrying trim via filter_complex", {
						container,
						error:
							reencodeConcatError instanceof Error
								? reencodeConcatError.message
								: String(reencodeConcatError),
					})
					await trimVideoByRangesFilterFallback(
						inputPath,
						validRanges,
						outputPath,
						container,
						signal,
					)
				}
			}
		}
	for (const file of partFiles) {
		try {
			await unlink(file)
		} catch {}
	}
	for (const file of partTsFiles) {
		try {
			await unlink(file)
		} catch {}
	}
	try {
		await unlink(concatPath)
	} catch {}
}

const isYandexVtransUrl = (url: string) => {
	try {
		const parsed = new URL(url)
		const host = parsed.hostname.toLowerCase()
		if (!host.endsWith("yandex.net")) return false
		if (!host.includes("vtrans")) return false
		const path = parsed.pathname.toLowerCase()
		if (!path.includes("/tts/")) return false
		return (
			path.endsWith(".mp3") ||
			path.endsWith(".m4a") ||
			path.endsWith(".aac") ||
			path.endsWith(".ogg") ||
			path.endsWith(".opus")
		)
	} catch {
		return false
	}
}

type VotClientMode = "direct" | "worker"

const getVotClient = (() => {
	let direct: VOTClient | null = null
	let worker: VOTWorkerClient | null = null
	return (mode: VotClientMode) => {
		if (mode === "worker") {
			if (!worker) {
				worker = new VOTWorkerClient({
					host: VOT_WORKER_HOST,
					apiToken: VOT_OAUTH_TOKEN || undefined,
				})
			}
			return worker
		}
		if (!direct) {
			direct = new VOTClient({
				apiToken: VOT_OAUTH_TOKEN || undefined,
			})
		}
		return direct
	}
})()

const parseDurationSeconds = (value: unknown) => {
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value <= 0) return undefined
		if (value > 1000 && value % 1000 === 0) {
			return Math.max(1, Math.round(value / 1000))
		}
		return Math.max(1, Math.round(value))
	}
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	if (!trimmed) return undefined
	const hmsMatch = trimmed.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/)
	if (hmsMatch) {
		const parts = hmsMatch.slice(1).map((part) => Number.parseInt(part, 10))
		if (parts.some((part) => Number.isNaN(part))) return undefined
		if (parts.length === 3) {
			const [hours, minutes, seconds] = parts
			return Math.max(1, hours * 3600 + minutes * 60 + seconds)
		}
		const [minutes, seconds] = parts
		return Math.max(1, minutes * 60 + seconds)
	}
	const numericMatch = trimmed.match(/(\d+)\s*(сек|sec|seconds|s|мин|min|minutes|m)?/i)
	if (!numericMatch) return undefined
	const amount = Number.parseInt(numericMatch[1], 10)
	if (Number.isNaN(amount) || amount <= 0) return undefined
	const unit = (numericMatch[2] || "").toLowerCase()
	if (unit.startsWith("м") || unit.startsWith("min")) return amount * 60
	return amount
}

const pickRetryDelaySeconds = (data: any) => {
	const candidates = [
		data?.remainingTime,
		data?.remaining_time,
		data?.retryAfter,
		data?.retry_after,
		data?.retryIn,
		data?.retry_in,
		data?.waitTime,
		data?.wait_time,
	]
	for (const candidate of candidates) {
		const parsed = parseDurationSeconds(candidate)
		if (parsed) return parsed
	}
	if (typeof data?.message === "string") {
		const parsed = parseDurationSeconds(data.message)
		if (parsed) return parsed
	}
	return undefined
}

const pickVotAudioUrl = (response: any) => {
	const candidates = [
		response?.result?.url,
		response?.result?.audioUrl,
		response?.result?.audio_url,
		response?.url,
		response?.audioUrl,
		response?.audio_url,
	]
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.startsWith("http")) {
			return candidate
		}
	}
	if (Array.isArray(response?.result?.urls)) {
		const urlCandidate = response.result.urls.find(
			(item: any) => typeof item === "string" && item.startsWith("http"),
		)
		if (urlCandidate) return urlCandidate
	}
	if (Array.isArray(response?.result)) {
		for (const item of response.result) {
			if (typeof item?.url === "string" && item.url.startsWith("http")) {
				return item.url
			}
		}
	}
	return undefined
}

const translateWithVot = async (
	url: string,
	ctx: any,
	statusMessageId?: number,
	signal?: AbortSignal,
) => {
	let mode: VotClientMode = VOT_WORKER_HOST ? "worker" : "direct"
	const startedAt = Date.now()
	const livelyRequested = VOT_LIVELY_VOICE
	let livelyEnabled = Boolean(VOT_LIVELY_VOICE && VOT_OAUTH_TOKEN)
	const baseRequestLang = VOT_REQUEST_LANG
	const preferEnglishForLively = livelyEnabled && baseRequestLang === "auto"
	let requestLang = preferEnglishForLively ? "en" : baseRequestLang
	let waitedSeconds = 0
	let attempts = 0
	const formatStatus = (base: string) =>
		formatVerboseStatus(base, {
			time: `${Math.round((Date.now() - startedAt) / 1000)}s`,
		})
	const waitWithCountdown = async (
		makeText: (remaining: number) => string,
		totalSeconds: number,
	) => {
		if (!statusMessageId || totalSeconds <= 0) {
			if (totalSeconds > 0) {
				await sleepMs(totalSeconds * 1000)
			}
			return
		}
		const step =
			totalSeconds >= 30 ? 5 : totalSeconds >= 10 ? 2 : 1
		let remaining = totalSeconds
		while (remaining > 0) {
			if (signal?.aborted) throw new Error("Cancelled")
			await updateMessage(ctx, statusMessageId, formatStatus(makeText(remaining)))
			const sleepFor = Math.min(step, remaining)
			await sleepMs(sleepFor * 1000)
			remaining -= sleepFor
		}
	}
	const fallbackAfterSeconds =
		Number.isFinite(VOT_WORKER_FALLBACK_SECONDS) && VOT_WORKER_FALLBACK_SECONDS > 0
			? VOT_WORKER_FALLBACK_SECONDS
			: 180
	let videoData: any
	try {
		videoData = await getVideoData(url)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/unknown service|unsupported link/i.test(message)) {
			throw createTranslationUnsupportedError(message)
		}
		throw error
	}
	logTranslate("start", {
		mode,
		url: redactUrl(url),
		requestLang,
		baseRequestLang,
		responseLang: VOT_RESPONSE_LANG,
		livelyRequested,
		livelyEnabled,
	})
	if (preferEnglishForLively && statusMessageId) {
		await updateMessage(
			ctx,
			statusMessageId,
			formatStatus("Живой голос: пробуем исходный язык EN..."),
		)
	}
		if (livelyRequested && !livelyEnabled && statusMessageId) {
			await updateMessage(
				ctx,
				statusMessageId,
				formatStatus(
					"Живой голос запрошен, но OAuth токен не задан — используем обычный перевод.",
				),
			)
		}
	const maxWaitSeconds =
		Number.isFinite(VOT_MAX_WAIT_SECONDS) && VOT_MAX_WAIT_SECONDS > 0
			? VOT_MAX_WAIT_SECONDS
			: 300
	while (true) {
		if (signal?.aborted) throw new Error("Cancelled")
		const client = getVotClient(mode)
		let response: any
		try {
			response = await client.translateVideo({
				videoData,
				requestLang,
				responseLang: VOT_RESPONSE_LANG,
				extraOpts: livelyEnabled ? { useLivelyVoice: true } : undefined,
				shouldSendFailedAudio: true,
			})
		} catch (error: any) {
			const data = error?.data
			const message = String(error?.message || data?.message || "")
			if (/unsupported service|not supported|unknown service/i.test(message)) {
				throw createTranslationUnsupportedError(message)
			}
			if (livelyEnabled) {
				const authRequired =
					data?.status === 7 || /auth required|oauth|token/i.test(message)
				if (authRequired) {
					livelyEnabled = false
					if (requestLang !== baseRequestLang) {
						requestLang = baseRequestLang
					}
					logTranslate("lively_fallback", {
						mode,
						url: redactUrl(url),
						reason: message,
					})
						if (statusMessageId) {
							await updateMessage(
								ctx,
								statusMessageId,
								formatStatus(
									"Живой голос недоступен, переключаюсь на обычный перевод...",
								),
							)
						}
					await sleepMs(1000)
					continue
				}
				const livelyNotAllowed =
					/обычная озвучка|only.*(обычная|regular)|unknown (source|language)/i.test(
						message,
					)
				if (livelyNotAllowed) {
					livelyEnabled = false
					if (requestLang !== baseRequestLang) {
						requestLang = baseRequestLang
					}
					logTranslate("lively_fallback", {
						mode,
						url: redactUrl(url),
						reason: message,
					})
						if (statusMessageId) {
							await updateMessage(
								ctx,
								statusMessageId,
								formatStatus(
									"Живой голос недоступен для этого видео, переключаюсь на обычный перевод...",
								),
							)
						}
					await sleepMs(1000)
					continue
				}
			}
			const shouldRetry =
				Boolean(data?.shouldRetry) ||
				(typeof data?.message === "string" &&
					/попробуйте позже|try again/i.test(data.message))
			if (shouldRetry) {
				attempts += 1
				const remainingSeconds = pickRetryDelaySeconds(data)
				const intervalSeconds = Math.min(
					remainingSeconds && remainingSeconds > 0 ? remainingSeconds : 15,
					60,
				)
				waitedSeconds += intervalSeconds
				if (waitedSeconds > maxWaitSeconds) {
					throw new Error("Translation timed out")
				}
				if (
					mode === "worker" &&
					waitedSeconds >= fallbackAfterSeconds &&
					VOT_WORKER_HOST
				) {
					mode = "direct"
					logTranslate("switch_to_direct", {
						waitedSeconds,
						fallbackAfterSeconds,
						requestLang,
						url: redactUrl(url),
					})
						if (statusMessageId) {
							await updateMessage(
								ctx,
								statusMessageId,
								formatStatus(
									"Очередь worker слишком длинная, переключаюсь на прямой VOT...",
								),
							)
						}
					await sleepMs(1000)
					continue
				}
					if (statusMessageId) {
						await updateMessage(
							ctx,
							statusMessageId,
							formatStatus("Перевод готовится, ждём"),
						)
					}
					logTranslate("retry", {
						mode,
						requestLang,
						wait: intervalSeconds,
						attempt: attempts,
						url: redactUrl(url),
						reason: data?.message,
					})
					await waitWithCountdown(
						() => "Перевод готовится, ждём",
						intervalSeconds,
					)
					continue
				}
			throw error
		}
		const audioUrl = pickVotAudioUrl(response)
			if (audioUrl) {
				logTranslate("audio_url", {
					mode,
					requestLang,
					url: redactUrl(url),
					audioUrl: redactUrl(audioUrl),
					waitedSeconds,
					totalSeconds: Math.round((Date.now() - startedAt) / 1000),
				})
			return audioUrl
		}
		if (response?.translated === false) {
			const remainingRaw = Number(
				response?.remainingTime ?? response?.remaining_time,
			)
			const intervalSeconds = Number.isFinite(remainingRaw) && remainingRaw > 0
				? Math.min(remainingRaw, 60)
				: 10
			waitedSeconds += intervalSeconds
			if (waitedSeconds > maxWaitSeconds) {
				throw new Error("Translation timed out")
			}
				if (statusMessageId) {
					await updateMessage(
						ctx,
						statusMessageId,
						formatStatus("Перевод готовится, ждём"),
					)
				}
				logTranslate("queued", {
					mode,
					requestLang,
					wait: intervalSeconds,
					waitedSeconds,
					url: redactUrl(url),
				})
				await waitWithCountdown(() => "Перевод готовится, ждём", intervalSeconds)
				continue
			}
		const message =
			typeof response?.message === "string" && response.message.trim()
				? response.message
				: undefined
		if (message) throw new Error(message)
		throw new Error("Перевод недоступен")
	}
}

const normalizeDelimitedList = (value: string) =>
	value
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean)

const YOUTUBE_FETCH_POT_OPTIONS = new Set(["auto", "always", "never"])
const youtubeFetchPotPolicy = (() => {
	const value = YOUTUBE_FETCH_POT.trim().toLowerCase()
	if (!value) return ""
	if (YOUTUBE_FETCH_POT_OPTIONS.has(value)) return value
	console.warn(`[WARN] Unknown YOUTUBE_FETCH_POT value: ${YOUTUBE_FETCH_POT}`)
	return ""
})()
const youtubePoTokenValue = normalizeDelimitedList(YOUTUBE_PO_TOKEN).join(",")
const youtubePotProviderUrl = YOUTUBE_POT_PROVIDER_URL.trim()
const youtubePotDisableInnertube = ["1", "true", "yes"].includes(
	YOUTUBE_POT_DISABLE_INNERTUBE.trim().toLowerCase(),
)
const youtubePotProviderArgs = (() => {
	if (!youtubePotProviderUrl) return []
	const params = [`base_url=${youtubePotProviderUrl}`]
	if (youtubePotDisableInnertube) {
		params.push("disable_innertube=1")
	}
	return ["--extractor-args", `youtubepot-bgutilhttp:${params.join(";")}`]
})()

const youtubeExtractorArgs = (() => {
	const args = [
		"--extractor-args",
		"youtube:player_client=tv,web_safari",
		"--remote-components",
		"ejs:github",
	]
	if (youtubePoTokenValue) {
		args.push("--extractor-args", `youtube:po_token=${youtubePoTokenValue}`)
	}
	if (youtubeFetchPotPolicy) {
		args.push("--extractor-args", `youtube:fetch_pot=${youtubeFetchPotPolicy}`)
	}
	if (youtubePotProviderArgs.length > 0) {
		args.push(...youtubePotProviderArgs)
	}
	return args
})()

const tiktokShortMatcher = (url: string) => {
	try {
		const parsed = new URL(url)
		const host = parsed.hostname.toLowerCase()
		if (host === "vt.tiktok.com" || host === "vm.tiktok.com") return true
		if (host.endsWith("tiktok.com") && /^\/t\//.test(parsed.pathname)) return true
		return false
	} catch {
		return false
	}
}

const resolveTiktokShortUrl = async (url: string) => {
	if (!tiktokShortMatcher(url)) return url
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 5000)
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			redirect: "follow",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				Accept: "text/html",
			},
		})
		if (res.body) {
			try {
				await res.body.cancel()
			} catch {}
		}
		const resolved = res.url || url
		if (resolved && resolved !== url) {
			console.log(`[DEBUG] Resolved TikTok short URL: ${url} -> ${resolved}`)
			return cleanUrl(resolved)
		}
		return url
	} catch (e) {
		console.warn("TikTok short URL resolve error", e)
		return url
	} finally {
		clearTimeout(timeout)
	}
}

const facebookShareMatcher = (url: string) => {
	try {
		const parsed = new URL(url)
		const host = parsed.hostname.toLowerCase()
		if (host === "fb.watch") return true
		if (host.endsWith("facebook.com")) {
			const path = parsed.pathname.toLowerCase()
			if (path.startsWith("/share/")) return true
			if (path === "/share.php" || path === "/sharer.php") return true
			if (path === "/story.php") return true
		}
		return false
	} catch {
		return false
	}
}

const facebookShareReelMatcher = (url: string) => {
	try {
		const parsed = new URL(url)
		if (!parsed.hostname.toLowerCase().endsWith("facebook.com")) return false
		return parsed.pathname.toLowerCase().startsWith("/share/r/")
	} catch {
		return false
	}
}

const unwrapFacebookRedirectUrl = (url: string) => {
	try {
		const parsed = new URL(url)
		const host = parsed.hostname.toLowerCase()
		if (host.endsWith("facebook.com") && parsed.pathname === "/l.php") {
			const target = parsed.searchParams.get("u")
			if (target) return target
		}
		return url
	} catch {
		return url
	}
}

const isFacebookLoginUrl = (url: string) => {
	try {
		const parsed = new URL(url)
		if (!parsed.hostname.endsWith("facebook.com")) return false
		const path = parsed.pathname.toLowerCase()
		return (
			path.startsWith("/login") ||
			path === "/login.php" ||
			path.includes("/checkpoint/") ||
			path.startsWith("/privacy/consent")
		)
	} catch {
		return false
	}
}

const extractFacebookLoginTarget = (url: string) => {
	try {
		const parsed = new URL(url)
		if (!parsed.hostname.endsWith("facebook.com")) return undefined
		const next = parsed.searchParams.get("next")
		const cont = parsed.searchParams.get("continue")
		const target = next || cont
		if (target) return target
		return undefined
	} catch {
		return undefined
	}
}

const extractFacebookStoryFbid = (url: string) => {
	try {
		const parsed = new URL(url)
		return parsed.searchParams.get("story_fbid") || undefined
	} catch {
		return undefined
	}
}

const extractFacebookStoryTargetFromLoginUrl = (url: string) => {
	try {
		const parsed = new URL(url)
		if (!parsed.hostname.endsWith("facebook.com")) return undefined
		const next = parsed.searchParams.get("next")
		const cont = parsed.searchParams.get("continue")
		const target = next || cont
		if (!target) return undefined
		const unwrapped = unwrapFacebookRedirectUrl(target)
		const storyFbid = extractFacebookStoryFbid(unwrapped)
		if (!storyFbid) return undefined
		return {
			storyFbid,
			target: unwrapped,
		}
	} catch {
		return undefined
	}
}

const extractFacebookExpectedStoryFbid = (url: string) => {
	return (
		extractFacebookStoryFbid(url) ||
		extractFacebookStoryTargetFromLoginUrl(url)?.storyFbid ||
		undefined
	)
}

const extractFacebookMetaUrl = (html: string) => {
	const patterns = [
		/property=["']og:url["'][^>]*content=["']([^"']+)["']/i,
		/content=["']([^"']+)["'][^>]*property=["']og:url["']/i,
		/rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
		/href=["']([^"']+)["'][^>]*rel=["']canonical["']/i,
		/property=["']al:web:url["'][^>]*content=["']([^"']+)["']/i,
		/content=["']([^"']+)["'][^>]*property=["']al:web:url["']/i,
	]
	for (const pattern of patterns) {
		const match = html.match(pattern)
		if (match?.[1]) return match[1].replace(/&amp;/g, "&").trim()
	}
	return undefined
}

const resolveFacebookShareUrlViaCurl = async (url: string) => {
	const proxy = await readProxyValue()
	const proxyArgs = proxy ? ["--proxy", proxy] : []
	let cookieArgs: string[] = []
	try {
		const stats = await stat(COOKIE_FILE)
		if (stats.isFile()) {
			cookieArgs = ["-b", COOKIE_FILE]
		}
	} catch {}
	const args = [
		"-sS",
		"-L",
		"-o",
		"/dev/null",
		"-w",
		"%{url_effective}",
		"-A",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		...proxyArgs,
		...cookieArgs,
		url,
	]
	try {
		const { stdout } = await execFilePromise("curl", args, { timeout: 8000 })
		const resolved = stdout.trim()
		if (!resolved) return url
		if (isFacebookLoginUrl(resolved)) {
			const loginTarget = extractFacebookLoginTarget(resolved)
			if (loginTarget) {
				const target = unwrapFacebookRedirectUrl(loginTarget)
				if (target && !isFacebookLoginUrl(target)) {
					return cleanUrl(target)
				}
			}
		}
		if (!facebookShareMatcher(resolved) && !isFacebookLoginUrl(resolved)) {
			return cleanUrl(unwrapFacebookRedirectUrl(resolved))
		}
		return url
	} catch (e) {
		console.warn("Facebook share curl resolve error", e)
		return url
	}
}

const resolveFacebookShareUrl = async (url: string) => {
	if (!facebookShareMatcher(url) && !isFacebookLoginUrl(url)) return url
	if (isFacebookLoginUrl(url)) {
		const loginTarget = extractFacebookLoginTarget(url)
		if (loginTarget) {
			const target = unwrapFacebookRedirectUrl(loginTarget)
			if (target && !isFacebookLoginUrl(target)) {
				return cleanUrl(target)
			}
		}
	}
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 6000)
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			redirect: "follow",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				Accept: "text/html",
			},
		})
		let resolved = res.url || url
		resolved = unwrapFacebookRedirectUrl(resolved)
		if (isFacebookLoginUrl(resolved)) {
			const loginTarget = extractFacebookLoginTarget(resolved)
			if (loginTarget) {
				const target = unwrapFacebookRedirectUrl(loginTarget)
				if (target && !isFacebookLoginUrl(target)) {
					return cleanUrl(target)
				}
			}
		}
		if (
			resolved &&
			resolved !== url &&
			!facebookShareMatcher(resolved) &&
			!isFacebookLoginUrl(resolved)
		) {
			return cleanUrl(resolved)
		}

		const contentType = res.headers.get("content-type") || ""
		if (contentType.includes("text/html")) {
			const html = await res.text()
			const metaUrl = extractFacebookMetaUrl(html)
			if (metaUrl) {
				const metaResolved = unwrapFacebookRedirectUrl(metaUrl)
				if (isFacebookLoginUrl(metaResolved)) {
					const loginTarget = extractFacebookLoginTarget(metaResolved)
					if (loginTarget) {
						const target = unwrapFacebookRedirectUrl(loginTarget)
						if (target && !isFacebookLoginUrl(target)) {
							return cleanUrl(target)
						}
					}
				} else {
					return cleanUrl(metaResolved)
				}
			}
		} else if (res.body) {
			try {
				await res.body.cancel()
			} catch {}
		}
		return await resolveFacebookShareUrlViaCurl(url)
	} catch (e) {
		console.warn("Facebook share resolve error", e)
		return await resolveFacebookShareUrlViaCurl(url)
	} finally {
		clearTimeout(timeout)
	}
}

const facebookStoryMatcher = (url: string) => {
	try {
		const parsed = new URL(url)
		if (!parsed.hostname.endsWith("facebook.com")) return false
		return parsed.pathname.toLowerCase() === "/story.php"
	} catch {
		return false
	}
}

const resolveFacebookStory = async (url: string) => {
	try {
		const { stdout } = await execFilePromise("python3", [
			"src/facebook_story_bypass.py",
			url,
			COOKIE_FILE,
			PROXY_FILE,
		])
		const trimmed = stdout.trim()
		if (!trimmed) return { error: "Empty response from facebook story resolver" }
		return JSON.parse(trimmed)
	} catch (e) {
		console.error("Facebook story resolve error", e)
		return { error: "Failed to run facebook story resolver" }
	}
}

const isFacebookCdnVideoUrl = (url: string) => {
	try {
		const parsed = new URL(url)
		const host = parsed.hostname.toLowerCase()
		if (!host.endsWith("fbcdn.net")) return false
		return parsed.pathname.toLowerCase().includes(".mp4")
	} catch {
		return false
	}
}

const normalizeFacebookCdnVideoUrl = (url: string) => {
	try {
		const parsed = new URL(url)
		const host = parsed.hostname.toLowerCase()
		if (!host.endsWith("fbcdn.net")) return url
		if (!parsed.pathname.toLowerCase().includes(".mp4")) return url
		let changed = false
		for (const key of ["bytestart", "byteend"]) {
			if (parsed.searchParams.has(key)) {
				parsed.searchParams.delete(key)
				changed = true
			}
		}
		return changed ? parsed.toString() : url
	} catch {
		return url
	}
}

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

const pornoxoMatcher = (url: string) => {
	try {
		return urlMatcher(url, "pornoxo.com")
	} catch {
		return false
	}
}

const pornoxoPageMatcher = (url: string) => {
	try {
		const parsed = new URL(url)
		if (!parsed.hostname.endsWith("pornoxo.com")) return false
		return /\/videos\/\d+/.test(parsed.pathname) || /\/embed\/\d+\/\d+/.test(parsed.pathname)
	} catch {
		return false
	}
}

const resolvePornoxo = async (url: string) => {
	try {
		const { stdout } = await execFilePromise("python3", [
			"src/pornoxo_bypass.py",
			url,
		])
		const trimmed = stdout.trim()
		if (!trimmed) return { error: "Empty response from pornoxo resolver" }
		return JSON.parse(trimmed)
	} catch (e) {
		console.error("Pornoxo resolve error", e)
		return { error: "Failed to run pornoxo resolver" }
	}
}

const tiktokPhotoMatcher = (url: string) => {
	try {
		const parsed = new URL(url)
		return (
			parsed.hostname.endsWith("tiktok.com") &&
			/\/photo\/\d+/.test(parsed.pathname)
		)
	} catch {
		return false
	}
}

const resolveTiktokPhoto = async (url: string) => {
	try {
		const { stdout } = await execFilePromise("python3", [
			"src/tiktok_photo_bypass.py",
			url,
			COOKIE_FILE,
			PROXY_FILE,
		])
		const trimmed = stdout.trim()
		if (!trimmed) return { error: "Empty response from tiktok photo resolver" }
		return JSON.parse(trimmed)
	} catch (e) {
		console.error("TikTok photo resolve error", e)
		return { error: "Failed to run tiktok photo resolver" }
	}
}

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

const behanceMatcher = (url: string) => {
	try {
		return urlMatcher(url, "behance.net")
	} catch {
		return false
	}
}

const extractIframeSrc = (html: string) => {
	const match = html.match(/<iframe[^>]+src="([^"]+)"/i)
	if (!match) return undefined
	return match[1]?.replace(/&amp;/g, "&").trim()
}

const resolveBehance = async (url: string) => {
	const clean = cleanUrl(url)
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 8000)
	try {
		const res = await fetch(clean, {
			signal: controller.signal,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				Accept: "text/html",
			},
		})
		if (!res.ok) {
			return { error: `HTTP ${res.status}` }
		}
		const html = await res.text()
		const stateMatch = html.match(
			/<script type="application\/json" id="beconfig-store_state">(.*?)<\/script>/s,
		)
		let title: string | undefined
		if (stateMatch?.[1]) {
			try {
				const state = JSON.parse(stateMatch[1])
				title =
					typeof state?.project?.project?.name === "string"
						? state.project.project.name
						: undefined
				const modules: any[] = Array.isArray(state?.project?.project?.modules)
					? state.project.project.modules
					: []
				for (const module of modules) {
					if (module?.__typename === "EmbedModule") {
						const embedHtml =
							String(module.fluidEmbed || module.originalEmbed || "")
						const src = extractIframeSrc(embedHtml)
						if (src) {
							return { video_url: normalizeVimeoUrl(src), title }
						}
					}
				}
			} catch (e) {
				console.error("Behance parse error", e)
			}
		}
		const fallbackSrc = extractIframeSrc(html)
		if (fallbackSrc) {
			return { video_url: normalizeVimeoUrl(fallbackSrc), title }
		}
		return { error: "No embed found" }
	} catch (e) {
		console.error("Behance resolve error", e)
		return { error: "Failed to fetch Behance page" }
	} finally {
		clearTimeout(timeout)
	}
}

const ccvMatcher = (url: string) => {
	try {
		return (
			urlMatcher(url, "ccv.adobe.io") ||
			urlMatcher(url, "cdn-prod-ccv.adobe.com")
		)
	} catch {
		return false
	}
}

const extractCcvServerData = (html: string) => {
	const marker = "window.ccv$serverData"
	const startIndex = html.indexOf(marker)
	if (startIndex < 0) return undefined
	let inString = false
	let escapeNext = false
	let depth = 0
	let jsonStart = -1
	for (let i = startIndex; i < html.length; i += 1) {
		const ch = html[i]
		if (inString) {
			if (escapeNext) {
				escapeNext = false
			} else if (ch === "\\\\") {
				escapeNext = true
			} else if (ch === "\"") {
				inString = false
			}
			continue
		}
		if (ch === "\"") {
			inString = true
			continue
		}
		if (ch === "{") {
			if (depth === 0) jsonStart = i
			depth += 1
			continue
		}
		if (ch === "}") {
			if (depth > 0) depth -= 1
			if (depth === 0 && jsonStart >= 0) {
				const jsonText = html.slice(jsonStart, i + 1)
				try {
					return JSON.parse(jsonText)
				} catch (e) {
					console.error("CCV serverData parse error", e)
					return undefined
				}
			}
		}
	}
	return undefined
}

const extractHtmlSource = (html: string, type: "m3u8" | "mp4") => {
	const ext = type === "m3u8" ? "m3u8" : "mp4"
	const regex = new RegExp(`<source[^>]+src="([^"]+\\.${ext}[^"]*)"`, "i")
	const match = html.match(regex)
	if (!match?.[1]) return undefined
	return match[1]?.replace(/&amp;/g, "&").trim()
}

const resolveCcv = async (url: string) => {
	const clean = cleanUrl(url)
	if (/\\.(m3u8|mp4)(\\?|$)/i.test(clean)) {
		return { video_url: clean }
	}
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 8000)
	try {
		const res = await fetch(clean, {
			signal: controller.signal,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				Accept: "text/html",
			},
		})
		if (!res.ok) {
			return { error: `HTTP ${res.status}` }
		}
		const html = await res.text()
		const data = extractCcvServerData(html)
		const m3u8Url =
			typeof data?.m3u8URL === "string" ? data.m3u8URL.trim() : undefined
		const mp4Url =
			typeof data?.mp4URL === "string" ? data.mp4URL.trim() : undefined
		const sourceM3u8 = extractHtmlSource(html, "m3u8")
		const sourceMp4 = extractHtmlSource(html, "mp4")
		const videoUrl = m3u8Url || sourceM3u8 || mp4Url || sourceMp4
		if (!videoUrl) return { error: "No video sources found" }
		return { video_url: videoUrl }
	} catch (e) {
		console.error("CCV resolve error", e)
		return { error: "Failed to fetch CCV embed" }
	} finally {
		clearTimeout(timeout)
	}
}

type FallbackAttempt = {
	label: string
	args: string[]
}

const getRefererHeaderArgs = (referer?: string) => {
	if (!referer) return []
	try {
		const parsed = new URL(referer)
		const headers = [`Referer: ${referer}`]
		if (parsed.hostname.endsWith("vimeo.com")) {
			headers.push(`Origin: ${parsed.origin}`)
		}
		return headers.flatMap((header) => ["--add-header", header])
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
	if (urlMatcher(url, "pornoxo.com")) return false
	if (isVimeoUrl(url)) return false
	if (threadsMatcher(url) || soraMatcher(url) || xfreeMatcher(url)) return false
	return true
}

const isInstagramUrl = (url: string) =>
	urlMatcher(url, "instagram.com") || urlMatcher(url, "instagr.am")

const shouldAttachReferer = (url: string) =>
	urlMatcher(url, "ok.xxx") || urlMatcher(url, "vimeo.com")

const isVimeoUrl = (url: string) =>
	urlMatcher(url, "vimeo.com") || urlMatcher(url, "player.vimeo.com")

const normalizeVimeoUrl = (input: string) => {
	try {
		const parsed = new URL(input)
		if (parsed.hostname === "api.vimeo.com") {
			const match = parsed.pathname.match(/^\/videos\/(\d+)/)
			if (match) {
				return `https://vimeo.com/${match[1]}`
			}
		}
		if (parsed.hostname === "player.vimeo.com") {
			const match = parsed.pathname.match(/^\/video\/(\d+)/)
			if (match) {
				return `https://vimeo.com/${match[1]}`
			}
		}
		return input
	} catch {
		return input
	}
}

const isFormatUnavailableError = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	return /requested format is not available/i.test(message)
}

const isRateLimitError = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	return /http error 429|too many requests/i.test(message)
}

const isAuthError = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	return /http error 401|unauthorized|http error 403|forbidden/i.test(message)
}

const isFacebookTemporaryBlockError = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	return /facebook temporarily blocked|you have been temporarily blocked|you used this feature too often|вы временно заблокированы|слишком часто использовали эту функцию|\[facebook\].*cannot parse data/i.test(
		message,
	)
}

const getFacebookTemporaryBlockMessage = () =>
	"Facebook временно ограничил доступ к этой ссылке для текущего аккаунта/IP. Подождите 15-60 минут и попробуйте снова."

const sleepMs = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms))

let vimeoCooldownUntil = 0

const waitForVimeoCooldown = async () => {
	const now = Date.now()
	if (now >= vimeoCooldownUntil) return
	const delayMs = vimeoCooldownUntil - now
	console.warn("[WARN] Vimeo cooldown active, waiting...", {
		delaySeconds: Math.round(delayMs / 1000),
	})
	await sleepMs(delayMs)
}

const extendVimeoCooldown = (delayMs: number) => {
	vimeoCooldownUntil = Math.max(vimeoCooldownUntil, Date.now() + delayMs)
}

const withRateLimitRetry = async <T>(
	fn: () => Promise<T>,
	isVimeo: boolean,
	onRetry?: (delayMs: number, attempt: number) => Promise<void>,
) => {
	const maxAttempts = isVimeo ? 4 : 1
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			if (isVimeo) {
				await waitForVimeoCooldown()
			}
			return await fn()
		} catch (error) {
			if (isVimeo && isRateLimitError(error) && attempt < maxAttempts) {
				const delayMs = 30000 * Math.pow(2, attempt - 1)
				extendVimeoCooldown(delayMs)
				console.warn("[WARN] Vimeo rate limit, retrying...", {
					attempt,
					delaySeconds: Math.round(delayMs / 1000),
				})
				if (onRetry) {
					await onRetry(delayMs, attempt)
				}
				await sleepMs(delayMs)
				continue
			}
			throw error
		}
	}
	throw new Error("Failed after retries")
}

const fetchInstagramAuthor = async (url: string) => {
	const clean = cleanUrl(url)
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 4000)
	try {
		const res = await fetch(
			`https://www.instagram.com/oembed/?url=${encodeURIComponent(clean)}`,
			{ signal: controller.signal },
		)
		if (!res.ok) return undefined
		const data = (await res.json()) as {
			author_name?: string
			author_url?: string
		}
		const name =
			typeof data?.author_name === "string" ? data.author_name.trim() : ""
		const authorUrl =
			typeof data?.author_url === "string" ? data.author_url.trim() : ""
		if (!name) return undefined
		return { name, url: authorUrl || undefined }
	} catch {
		return undefined
	} finally {
		clearTimeout(timeout)
	}
}

const buildInstagramCaption = async (url: string) => {
	const clean = cleanUrl(url)
	const author = await fetchInstagramAuthor(clean)
	if (author?.name) {
		const safeName = escapeHtml(author.name)
		const authorLine = author.url
			? `Автор: ${link(safeName, author.url)}`
			: `Автор: ${safeName}`
		return `${authorLine}\n${link("Источник", clean)}`
	}
	return `Источник: ${link("Instagram", clean)}`
}

const downloadPhotoInputFile = async (url: string, index: number) => {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 10000)
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
			},
		})
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`)
		}
		const buffer = await res.arrayBuffer()
		const filename = `photo_${index + 1}.jpg`
		return new InputFile(new Uint8Array(buffer), filename)
	} finally {
		clearTimeout(timeout)
	}
}

const sendPhotoUrls = async (
	ctx: any,
	photoUrls: string[],
	caption: string,
	threadId?: number,
	replyToMessageId?: number,
	forceUpload = false,
) => {
	const uniqueUrls = Array.from(
		new Set(
			photoUrls
				.map((url) => (typeof url === "string" ? url.trim() : ""))
				.filter(Boolean),
		),
	)
	if (uniqueUrls.length === 0) return
	if (uniqueUrls.length === 1) {
		const url = uniqueUrls[0]
		if (forceUpload) {
			try {
				const inputFile = await downloadPhotoInputFile(url, 0)
				await ctx.replyWithPhoto(inputFile, {
					caption,
					parse_mode: "HTML",
					reply_to_message_id: replyToMessageId,
					message_thread_id: threadId,
				})
				return
			} catch (error) {
				console.error("Failed to download single photo, fallback to URL", error)
			}
		}
		await ctx.replyWithPhoto(url, {
			caption,
			parse_mode: "HTML",
			reply_to_message_id: replyToMessageId,
			message_thread_id: threadId,
		})
		return
	}
	const groups = chunkArray(10, uniqueUrls)
	let isFirst = true
	let offset = 0
	for (const group of groups) {
		const media: Array<{
			type: "photo"
			media: string | InputFile
			caption?: string
			parse_mode?: string
		}> = []
		for (let i = 0; i < group.length; i += 1) {
			const url = group[i]
			let mediaValue: string | InputFile = url
			if (forceUpload) {
				try {
					const inputFile = await downloadPhotoInputFile(url, offset + i)
					mediaValue = inputFile
				} catch (error) {
					console.error("Failed to download photo, fallback to URL", error)
				}
			}
			media.push({
				type: "photo",
				media: mediaValue,
				caption: isFirst && i === 0 ? caption : undefined,
				parse_mode: isFirst && i === 0 ? "HTML" : undefined,
			})
		}
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
					let mediaValue: string | InputFile = url
					if (forceUpload) {
						try {
							mediaValue = await downloadPhotoInputFile(url, offset + index)
						} catch (photoError) {
							console.error("Failed to download photo, fallback to URL", photoError)
						}
					}
					await ctx.replyWithPhoto(mediaValue, {
						caption: withCaption ? caption : undefined,
						parse_mode: withCaption ? "HTML" : undefined,
						reply_to_message_id: replyToMessageId,
						message_thread_id: threadId,
					})
				} catch (photoError) {
					console.error("Failed to send photo", photoError)
				}
				if (withCaption) isFirst = false
			}
		}
		offset += group.length
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
	void incrementUserCounter(userId, "downloads")
	const normalized = normalizeUrl(url)
	void logUserLink(userId, normalized, "queued")
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
	scheduleActivitySave()
	activateUserUrlLock(userId, normalized, lockId)
	queue.add(async () => {
		const meta = jobMeta.get(jobId)
		if (meta) {
			meta.state = "active"
			scheduleActivitySave()
		}
		try {
			await executor(controller.signal)
		} finally {
			jobMeta.delete(jobId)
			unlockUserUrl(userId, normalized, lockId)
			scheduleActivitySave()
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
	if (removed.length > 0) {
		scheduleActivitySave()
	}
	let activeCancelled = 0
	for (const meta of jobMeta.values()) {
		if (meta.userId === userId && meta.state === "active") {
			meta.cancel()
			activeCancelled++
		}
	}
	if (activeCancelled > 0) {
		scheduleActivitySave()
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
startSystemHistoryCollector()
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
	externalAudioUrl?: string
	selectedQuality?: string
	selectedIsRawFormat?: boolean
	selectedForceAudio?: boolean
	selectedDashFormatLabel?: string
	selectedForceHls?: boolean
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
	preferHls = false,
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

	const muxed = candidates.filter(
		(item) => item.entry.meta.hasVideo && item.entry.meta.hasAudio,
	)
	const basePool = muxed.length > 0 ? muxed : candidates
	const hlsPool = preferHls
		? basePool.filter((item) => item.entry.meta.isHls)
		: []
	const selectedPool = hlsPool.length > 0 ? hlsPool : basePool
	selectedPool.sort((a, b) => {
		const sizeDelta = (b.size || 0) - (a.size || 0)
		if (sizeDelta !== 0) return sizeDelta
		const aHeight = Number(a.entry.format?.height || 0)
		const bHeight = Number(b.entry.format?.height || 0)
		return bHeight - aHeight
	})
	return selectedPool[0]
}

const buildFormatSuggestions = (
	formats: any[],
	duration: number | undefined,
	maxBytes: number,
	limit = 3,
	preferHls = false,
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
		.sort((a, b) => {
			if (preferHls && a.entry.meta.isHls !== b.entry.meta.isHls) {
				return a.entry.meta.isHls ? -1 : 1
			}
			const sizeDelta = (a.size || 0) - (b.size || 0)
			if (sizeDelta !== 0) return sizeDelta
			const aHeight = Number(a.entry.format?.height || 0)
			const bHeight = Number(b.entry.format?.height || 0)
			return bHeight - aHeight
		})

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

const isTransientTelegramSendError = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	return (
		/Network request for 'send(Video|Document)' failed/i.test(message) ||
		/invalid json response body|unexpected end of json input/i.test(message) ||
		/econnreset|etimedout|timed out|socket hang up|fetch failed|network/i.test(
			message,
		)
	)
}

const isTelegramBrokenJsonResponseError = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	return /invalid json response body|unexpected end of json input/i.test(message)
}

const runTelegramSendWithRetry = async <T>(
	action: string,
	send: () => Promise<T>,
	maxAttempts = 5,
) => {
	let lastError: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await send()
		} catch (error) {
			lastError = error
			if (isTelegramBrokenJsonResponseError(error)) {
				// Local telegram-bot-api may close response body after upload succeeded.
				console.warn(`[WARN] ${action} returned broken JSON response; treating as delivered`, {
					error: error instanceof Error ? error.message : String(error),
				})
				return undefined as T
			}
			if (!isTransientTelegramSendError(error) || attempt >= maxAttempts) {
				throw error
			}
			const delayMs = Math.min(60000, 4000 * attempt)
			console.warn(`[WARN] ${action} transient network error, retrying`, {
				attempt,
				maxAttempts,
				delayMs,
				error: error instanceof Error ? error.message : String(error),
			})
			await sleepMs(delayMs)
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error(`${action} failed after retries`)
}

const runWithPersistentChatAction = async <T>(
	ctx: any,
	chatAction: "upload_video" | "upload_document" | "upload_audio" | "upload_voice",
	send: () => Promise<T>,
	intervalMs = 4500,
) => {
	const pulse = async () => {
		try {
			await ctx.replyWithChatAction(chatAction)
		} catch {}
	}
	await pulse()
	const timer = setInterval(() => {
		void pulse()
	}, intervalMs)
	timer.unref?.()
	try {
		return await send()
	} finally {
		clearInterval(timer)
	}
}

const formatUserIdLinkHtml = (userId: number) =>
	`<a href="tg://user?id=${userId}">${userId}</a>`

const createUserReportPrompt = async (
	ctx: any,
	context?: string,
	error?: string,
) => {
	await ctx.reply(
		"Ошибка! разработчик уже в курсе, проверим, попробуем поправить.",
	)
}

const formatUserLabel = (profile: UserProfile) => {
	const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ")
	const username = profile.username ? `@${profile.username}` : ""
	if (name && username) return `${name} (${username})`
	return name || username || "Unknown"
}

const formatUserProfile = (profile: UserProfile, banEntry?: BanEntry) => {
	const lines = [
		`ID: ${profile.id}`,
		`Name: ${formatUserLabel(profile)}`,
		`Username: ${profile.username ? `@${profile.username}` : "—"}`,
		`Lang: ${profile.language_code || "—"}`,
		`Is bot: ${profile.is_bot ? "yes" : "no"}`,
		`Last seen: ${profile.last_seen || "—"}`,
		`Chat ID: ${profile.chat_id ?? "—"}`,
	]
	if (banEntry) {
		const at = new Date(banEntry.at).toISOString()
		const reason = banEntry.reason || "—"
		lines.push(`Banned: yes`, `Ban at: ${at}`, `Reason: ${reason}`)
	} else {
		lines.push("Banned: no")
	}
	return lines.join("\n")
}

const getUserFromArgs = async (ctx: any, args: string[]) => {
	if (ctx.message?.reply_to_message?.from) {
		const from = ctx.message.reply_to_message.from
		return {
			id: from.id,
			username: from.username,
			first_name: from.first_name,
			last_name: from.last_name,
			language_code: from.language_code,
			is_bot: from.is_bot,
		} as UserProfile
	}
	if (args.length === 0) return null
	const rawId = args[0]
	if (!rawId) return null
	const id = Number.parseInt(rawId, 10)
	if (Number.isNaN(id)) return null
	await loadUsers()
	return users.get(id) || { id }
}

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
	externalAudioUrl?: string,
	sponsorCutRequested = false,
	sponsorCategories?: string[],
) => {
	url = normalizeVimeoUrl(url)
	url = normalizeFacebookCdnVideoUrl(url)
	let overrideTitleResolved = overrideTitle
	if (sourceUrl) {
		sourceUrl = normalizeVimeoUrl(sourceUrl)
		sourceUrl = normalizeFacebookCdnVideoUrl(sourceUrl)
	}
	let expectedFacebookStoryFbid = extractFacebookExpectedStoryFbid(
		sourceUrl || url,
	)
	const resolvedFacebookUrl = await resolveFacebookShareUrl(url)
	if (resolvedFacebookUrl !== url) {
		console.log(
			`[DEBUG] Resolved Facebook share URL: ${url} -> ${resolvedFacebookUrl}`,
		)
		url = resolvedFacebookUrl
	}
	if (!expectedFacebookStoryFbid) {
		expectedFacebookStoryFbid = extractFacebookExpectedStoryFbid(url)
	}
	if (facebookStoryMatcher(url)) {
		const storyData = await resolveFacebookStory(url)
		if (storyData.video_url) {
			url = normalizeFacebookCdnVideoUrl(storyData.video_url)
			if (!overrideTitleResolved && storyData.title) {
				overrideTitleResolved = storyData.title
			}
		} else if (storyData.error) {
			console.error("Facebook story error:", storyData.error)
			if (isFacebookTemporaryBlockError(storyData.error)) {
				throw new Error(getFacebookTemporaryBlockMessage())
			}
		}
	}
	if (facebookShareReelMatcher(url)) {
		const storyData = await resolveFacebookStory(url)
		if (storyData.video_url) {
			url = normalizeFacebookCdnVideoUrl(storyData.video_url)
			if (!overrideTitleResolved && storyData.title) {
				overrideTitleResolved = storyData.title
			}
		} else if (storyData.error) {
			console.error("Facebook story error:", storyData.error)
			if (isFacebookTemporaryBlockError(storyData.error)) {
				throw new Error(getFacebookTemporaryBlockMessage())
			}
			console.warn(
				`[WARN] Facebook share/reel bypass failed, fallback to yt-dlp: ${storyData.error}`,
			)
		}
	}
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
	const externalAudio =
		typeof externalAudioUrl === "string" && externalAudioUrl.trim()
			? externalAudioUrl.trim()
			: undefined
	const externalAudioIsYandex = externalAudio
		? isYandexVtransUrl(externalAudio)
		: false
	
	try {
		const isTiktok = urlMatcher(url, "tiktok.com")
		const isInstagram =
			urlMatcher(url, "instagram.com") || urlMatcher(url, "instagr.am")
		const isErome = urlMatcher(url, "erome.com")
		const isVimeo = isVimeoUrl(url)
		const isPornoxo = pornoxoMatcher(url)
		const isDirectHls = /\.m3u8(\?|$)/i.test(url)
		let forceHlsDownload = selectedForceHls || isDirectHls
		const additionalArgs = isTiktok ? tiktokArgs : []
		const resumeArgs = isErome ? ["--no-continue"] : []
		const isYouTube = isYouTubeUrl(url)
		const cookieArgsList = await cookieArgs()
		const youtubeArgs = isYouTube ? youtubeExtractorArgs : []
		const proxyArgs = isVimeo || isPornoxo ? [] : await getProxyArgs()
		const vimeoArgs = isVimeo
			? [
					"--sleep-requests",
					"1",
					"--extractor-retries",
					"3",
					"--retry-sleep",
					"15",
					"--extractor-args",
					"vimeo:original_format_policy=never",
			]
			: []
		const resolveCaptionUrl = async (rawUrl: string) => {
			if (facebookShareMatcher(rawUrl)) {
				return await resolveFacebookShareUrl(rawUrl)
			}
			if (isTiktok && tiktokShortMatcher(rawUrl)) {
				return await resolveTiktokShortUrl(rawUrl)
			}
			return rawUrl
		}
		const refererArgs = shouldAttachReferer(sourceUrl || url)
			? getRefererHeaderArgs(sourceUrl || url)
			: []

		if (
			isFacebookCdnVideoUrl(url) &&
			!externalAudio &&
			!forceAudio &&
			!selectedIsRawFormat &&
			!forceHls
		) {
			const title = overrideTitleResolved || "Video"
			const rawCaptionUrl = sourceUrl || url
			const captionUrl = await resolveCaptionUrl(rawCaptionUrl)
			const caption = link(title, cleanUrl(captionUrl))
			if (statusMessageId) {
				await updateMessage(
					ctx,
					statusMessageId,
					`Обработка: <b>${title}</b>\nСтатус: Отправляем...`,
				)
			}
			await ctx.replyWithVideo(url, {
				caption,
				parse_mode: "HTML",
				message_thread_id: threadId,
				reply_to_message_id: replyToMessageId,
				supports_streaming: true,
			})
			return
		}

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
						entry.title || overrideTitleResolved,
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
			const title = overrideTitleResolved || "Video"
			const rawCaptionUrl = sourceUrl || url
			const captionUrl = await resolveCaptionUrl(rawCaptionUrl)
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
				`Referer: ${rawCaptionUrl}\r\n`,
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
				await runWithPersistentChatAction(ctx, "upload_video", () =>
					ctx.replyWithVideo(new InputFile(tempFilePath), {
						caption,
						parse_mode: "HTML",
						supports_streaming: true,
						duration: metadata.duration,
						width: metadata.width,
						height: metadata.height,
						thumbnail: thumbFile,
						message_thread_id: threadId,
					}),
				)
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
					formatArgs = [
						"-f",
						"251",
						"-x",
						"--audio-format",
						"mp3",
						"--postprocessor-args",
						`ffmpeg:-af ${AUDIO_LOUDNORM_MUSIC_FILTER}`,
					]
				} else {
					formatArgs = ["-f", selectedQuality]
				}
			} else if (selectedQuality === "audio") {
				formatArgs = [
					"-x",
					"--audio-format",
					"mp3",
					"--postprocessor-args",
					`ffmpeg:-af ${AUDIO_LOUDNORM_MUSIC_FILTER}`,
				]
			} else if (isDirectHls) {
			formatArgs = ["-f", "best"]
			} else if (selectedQuality === "b") {
				if (isYouTube) {
					formatArgs = [
						"-f",
						"bestvideo[protocol=https][vcodec^=avc1][ext=mp4]+bestaudio[protocol=https][ext=m4a]/best[protocol=https][ext=mp4]/best[protocol=https]",
					]
					fallbackFormatArgs = [
						"-f",
						"best[protocol*=m3u8][vcodec^=avc1][acodec^=mp4a]/best[protocol*=m3u8][vcodec^=avc1]/bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
					]
				} else if (isVimeo) {
					formatArgs = ["-f", "bestvideo+bestaudio/best"]
					fallbackFormatArgs = ["-f", "best"]
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
						`bestvideo[protocol=https][height<=${selectedQuality}][vcodec^=avc1][ext=mp4]+bestaudio[protocol=https][ext=m4a]/best[protocol=https][height<=${selectedQuality}][ext=mp4]/best[protocol=https][height<=${selectedQuality}]`,
					]
					fallbackFormatArgs = [
						"-f",
						`best[height<=${selectedQuality}][protocol*=m3u8][vcodec^=avc1][acodec^=mp4a]/best[height<=${selectedQuality}][protocol*=m3u8][vcodec^=avc1]/bestvideo[height<=${selectedQuality}][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/best[height<=${selectedQuality}][ext=mp4]/best[height<=${selectedQuality}]`,
					]
				} else if (isVimeo) {
					formatArgs = [
						"-f",
						`bestvideo[height<=${selectedQuality}]+bestaudio/best[height<=${selectedQuality}]`,
					]
					fallbackFormatArgs = [
						"-f",
						`best[height<=${selectedQuality}]/best`,
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

		const skipJsRuntimeForInfo = false
		const fallbackSourceUrl = sourceUrl || url
		const genericFallbacks = shouldTryGenericFallback(fallbackSourceUrl)
			? buildGenericFallbacks(fallbackSourceUrl)
			: []
		const vimeoCookieAttempts =
			isVimeo && cookieArgsList.length > 0 ? [[], cookieArgsList] : [cookieArgsList]
		const buildInfoArgs = (
			formatOverride?: string[],
			cookiesOverride: string[] = cookieArgsList,
		) => [
			"--dump-json",
			...(formatOverride ?? formatArgs),
			"--no-warnings",
			"--no-playlist",
			...resumeArgs,
			...cookiesOverride,
			...additionalArgs,
			...impersonateArgs,
			...youtubeArgs,
			...refererArgs,
			...vimeoArgs,
		]

		const infoFormatArgs = isVimeo ? [] : undefined
		const fetchInfoWithCookies = async (cookiesOverride: string[]) => {
			try {
				return await safeGetInfoWithFallback(
					url,
					buildInfoArgs(infoFormatArgs, cookiesOverride),
					signal,
					skipJsRuntimeForInfo,
					genericFallbacks.map((attempt) => attempt.args),
					proxyArgs,
				)
			} catch (error) {
				if (
					isFormatUnavailableError(error) &&
					(!infoFormatArgs || infoFormatArgs.length > 0 || formatArgs.length > 0)
				) {
					return await safeGetInfoWithFallback(
						url,
						buildInfoArgs([], cookiesOverride),
						signal,
						skipJsRuntimeForInfo,
						genericFallbacks.map((attempt) => attempt.args),
						proxyArgs,
					)
				}
				throw error
			}
		}
		const fetchInfoOnce = async () => {
			let lastError: unknown
			for (const cookiesOverride of vimeoCookieAttempts) {
				try {
					return await fetchInfoWithCookies(cookiesOverride)
				} catch (error) {
					lastError = error
					if (isVimeo && cookiesOverride.length === 0 && isAuthError(error)) {
						continue
					}
					throw error
				}
			}
			throw lastError instanceof Error
				? lastError
				: new Error("No valid info")
		}

		const maxInfoAttempts = isVimeo ? 4 : 1
		let info: any
		for (let attempt = 1; attempt <= maxInfoAttempts; attempt += 1) {
			try {
				info = await fetchInfoOnce()
				break
			} catch (error) {
				if (isVimeo && isRateLimitError(error) && attempt < maxInfoAttempts) {
					const delayMs = 30000 * Math.pow(2, attempt - 1)
					if (statusMessageId) {
						await updateMessage(
							ctx,
							statusMessageId,
							`Статус: Vimeo лимит, ждём ${Math.round(delayMs / 1000)}с...`,
						)
					}
					await sleepMs(delayMs)
					continue
				}
				throw error
			}
		}

		const infoResolvedTitle = resolveTitle(info, isTiktok)
		if (expectedFacebookStoryFbid && typeof info?.webpage_url === "string") {
			const actualFacebookStoryFbid = extractFacebookStoryFbid(info.webpage_url)
			if (
				actualFacebookStoryFbid &&
				actualFacebookStoryFbid !== expectedFacebookStoryFbid
			) {
				throw new Error(
					`Facebook story mismatch: expected story_fbid=${expectedFacebookStoryFbid}, got story_fbid=${actualFacebookStoryFbid}`,
				)
			}
		}
		const title = overrideTitleResolved || infoResolvedTitle
		const rawCaptionUrl = sourceUrl || url
		const captionUrl = await resolveCaptionUrl(rawCaptionUrl)
		const captionBase = link(title || "Video", cleanUrl(captionUrl))
		const caption = externalAudioIsYandex
			? `${captionBase}\nПеревод: Yandex`
			: captionBase
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
		const formatsArray: any[] = Array.isArray(info.formats) ? info.formats : []
		let requestedFormatsSummed = 0
		let hasRequestedFormatsSize = false
		if (Array.isArray(info.requested_formats)) {
			for (const format of info.requested_formats) {
				const formatSize =
					typeof format?.filesize === "number"
						? format.filesize
						: typeof format?.filesize_approx === "number"
							? format.filesize_approx
							: 0
				if (formatSize > 0) {
					requestedFormatsSummed += formatSize
					hasRequestedFormatsSize = true
				}
			}
		}
		const selectedRawSize = (() => {
			if (!selectedIsRawFormat || !selectedQuality) return 0
			const selectedIds = `${selectedQuality}`
				.split("+")
				.map((id) => id.trim())
				.filter(Boolean)
			if (selectedIds.length === 0) return 0
			let summed = 0
			let hasSize = false
			for (const selectedId of selectedIds) {
				const format = formatsArray.find(
					(item: { format_id?: string | number }) =>
						`${item?.format_id ?? ""}` === selectedId,
				)
				if (!format) continue
				const formatSize = estimateFormatSize(format, infoDuration)
				if (typeof formatSize === "number" && formatSize > 0) {
					summed += formatSize
					hasSize = true
				}
			}
			return hasSize ? summed : 0
		})()
		const estimatedSize =
			selectedRawSize ||
			(hasRequestedFormatsSize ? requestedFormatsSummed : 0) ||
			(typeof info.filesize === "number" ? info.filesize : 0) ||
			(typeof info.filesize_approx === "number" ? info.filesize_approx : 0)
		let estimatedSizeLabel = estimatedSize ? formatBytes(estimatedSize) : ""

			if (estimatedSize > 0 && estimatedSize >= maxUploadSize) {
			const suggestions = buildFormatSuggestions(
				formatsArray,
				infoDuration,
				maxUploadSize,
				8,
				isYouTube,
			)
			if (suggestions.length > 0) {
				const requestId = randomUUID().split("-")[0]
				const filteredFormats = formatsArray.filter((f: any) => f?.format_id)
				if (!requestId || filteredFormats.length === 0) {
					throw new Error("Failed to prepare alternative format selector")
				}
				const titleForMenu = title || info.title || "video"
				requestCache.set(requestId, {
					url,
					sourceUrl: sourceUrl || url,
					title: titleForMenu,
					formats: filteredFormats,
					userId: ctx.from?.id,
					externalAudioUrl,
				})
				scheduleRequestExpiry(requestId)

				const keyboard = new InlineKeyboard()
				for (const suggestion of suggestions) {
					const formatId = `${suggestion.entry.format?.format_id ?? ""}`.trim()
					if (!formatId) continue
					const buttonText =
						suggestion.label.length > 60
							? `${suggestion.label.substring(0, 57)}...`
							: suggestion.label
					keyboard.text(buttonText, `d:${requestId}:${formatId}`).row()
				}
				keyboard
					.text("Показать все HLS", `f:${requestId}:hls`)
					.text("Отмена", `d:${requestId}:cancel`)

				const oversizeMessage =
					`Файл слишком большой для Telegram (> ${formatBytes(maxUploadSize)}).\n` +
					"Выберите альтернативный формат кнопками ниже."
				if (statusMessageId) {
					await updateMessage(ctx, statusMessageId, oversizeMessage)
					await ctx.reply(`Альтернативные варианты для: ${titleForMenu}`, {
						reply_markup: keyboard,
						message_thread_id: threadId,
					})
				} else if (ctx.callbackQuery) {
					await ctx.editMessageText(oversizeMessage, {
						reply_markup: keyboard,
					})
				} else {
					await ctx.reply(`Альтернативные варианты для: ${titleForMenu}`, {
						reply_markup: keyboard,
						message_thread_id: threadId,
					})
				}
				return
			}
			{
				const suggestionsText = "\nНе удалось подобрать варианты с оценкой размера."
				const limitMessage =
					"Можно загрузить файлы до 2ГБ." +
					suggestionsText +
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
					"bestvideo[protocol=https][vcodec^=avc1][ext=mp4]+bestaudio[protocol=https][ext=m4a]/best[protocol=https][ext=mp4]/best[protocol=https]",
				]
				fallbackFormatArgs = [
					"-f",
					"best[protocol*=m3u8][vcodec^=avc1][acodec^=mp4a]/best[protocol*=m3u8][vcodec^=avc1]/bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
				]
			} else if (isVimeo) {
				formatArgs = ["-f", "bestvideo+bestaudio/best"]
				fallbackFormatArgs = ["-f", "best"]
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
					`bestvideo[protocol=https][height<=${selectedQuality}][vcodec^=avc1][ext=mp4]+bestaudio[protocol=https][ext=m4a]/best[protocol=https][height<=${selectedQuality}][ext=mp4]/best[protocol=https][height<=${selectedQuality}]`,
				]
				fallbackFormatArgs = [
					"-f",
					`best[height<=${selectedQuality}][protocol*=m3u8][vcodec^=avc1][acodec^=mp4a]/best[height<=${selectedQuality}][protocol*=m3u8][vcodec^=avc1]/bestvideo[height<=${selectedQuality}][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/best[height<=${selectedQuality}][ext=mp4]/best[height<=${selectedQuality}]`,
				]
			} else if (isVimeo) {
				formatArgs = [
					"-f",
					`bestvideo[height<=${selectedQuality}]+bestaudio/best[height<=${selectedQuality}]`,
				]
				fallbackFormatArgs = [
					"-f",
					`best[height<=${selectedQuality}]/best`,
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
			(format: { format_id?: string | number }) =>
				`${format?.format_id}` === selectedQuality,
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
			isYouTube && isHlsDownload && !youtubeFetchPotPolicy
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

			const explicitFormatId =
				typeof info?.format_id === "string" ? info.format_id : undefined
			const buildExplicitFormatArgs = (formatId: string) => {
				const args = ["-f", formatId]
				if (!isMhtml) {
					args.push("--merge-output-format", outputContainer)
				}
				if (!args.includes("--no-cache-dir")) {
					args.push("--no-cache-dir")
				}
				if (usesHlsPreferred) {
					args.push(
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
				return args
			}

		if (isAudioRequest) {
			const audioBase = dashFileBase || "audio"
			if (externalAudio) {
				tempFilePath = resolve(tempDir, `${audioBase}_translated.m4a`)
				if (statusMessageId) {
					await updateMessage(
						ctx,
						statusMessageId,
						`Обработка: <b>${title}</b>\nСтатус: Скачиваем перевод...`,
					)
				}
					await spawnPromise(
						"ffmpeg",
						[
							"-y",
							"-i",
							externalAudio,
							"-vn",
							"-af",
							TRANSLATION_AUDIO_FILTER,
							"-c:a",
							"aac",
							"-b:a",
							"192k",
						"-ar",
						"48000",
						tempFilePath,
					],
					undefined,
					signal,
				)
				if (!(await fileExists(tempFilePath, 1024))) {
					throw new Error("Translated audio download failed")
				}
			} else {
				const downloadArgs = formatArgs.includes("--js-runtimes")
					? formatArgs
					: [...jsRuntimeArgs, ...formatArgs]
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
						...refererArgs,
						...vimeoArgs,
					],
					undefined,
					signal,
				)
			}
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
				const skipJsRuntime = false
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
					const maxAttempts = isVimeo ? 3 : 1
					let lastError: unknown
					for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
						try {
							if (isVimeo) {
								await waitForVimeoCooldown()
							}
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
									...vimeoArgs,
								],
								onProgress,
								signal,
							)
							return
						} catch (error) {
							lastError = error
								if (isVimeo && isRateLimitError(error) && attempt < maxAttempts) {
									const delayMs = 30000 * Math.pow(2, attempt - 1)
								extendVimeoCooldown(delayMs)
								if (statusMessageId) {
									await updateMessage(
										ctx,
										statusMessageId,
										`Обработка: <b>${title}</b>\nСтатус: Vimeo лимит, ждём ${Math.round(delayMs / 1000)}с...`,
									)
								}
								await sleepMs(delayMs)
								continue
							}
							throw error
						}
					}
					if (lastError) throw lastError
				}

			let downloadSucceeded = false
			let lastDownloadError: unknown = null
			const baseExtraArgs = [
				...hlsPoTokenArgs,
				...impersonateArgs,
				...youtubeArgs,
				...refererArgs,
			]
			const runDownloadWithCookies = async (args: string[]) => {
				const cookieAttempts =
					isVimeo && cookieArgsList.length > 0
						? [[], cookieArgsList]
						: [cookieArgsList]
				let lastError: unknown
				for (const cookiesOverride of cookieAttempts) {
					try {
						await runDownload(args, baseExtraArgs, cookiesOverride)
						return
					} catch (error) {
						lastError = error
						if (isVimeo && cookiesOverride.length === 0 && isAuthError(error)) {
							continue
						}
						throw error
					}
				}
				throw lastError instanceof Error
					? lastError
					: new Error("Download failed")
			}
				if (isYouTube && isHlsDownload) {
					const hlsAttempts = [
						{
							label: `Обработка: <b>${title}</b>\nСтатус: HLS: пробуем с cookies...`,
							extraArgs: [...hlsPoTokenArgs, ...impersonateArgs, ...youtubeArgs],
							cookies: cookieArgsList,
						},
						{
							label: `Обработка: <b>${title}</b>\nСтатус: HLS: пробуем без cookies...`,
							extraArgs: [...hlsPoTokenArgs],
							cookies: [] as string[],
						},
					]
				if (proxyArgs.length > 0) {
					hlsAttempts.push(
						{
							label:
								`Обработка: <b>${title}</b>\nСтатус: HLS: пробуем через прокси без cookies...`,
							extraArgs: [...hlsPoTokenArgs, ...proxyArgs],
							cookies: [] as string[],
						},
						{
							label:
								`Обработка: <b>${title}</b>\nСтатус: HLS: пробуем через прокси с cookies...`,
							extraArgs: [
								...hlsPoTokenArgs,
								...proxyArgs,
								...impersonateArgs,
								...youtubeArgs,
							],
							cookies: cookieArgsList,
						},
					)
				}
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
				if (!downloadSucceeded) {
					const nextHlsFormats = formatsArray
						.map((format) => ({
							format,
							meta: getFormatMeta(format),
							size: estimateFormatSize(format, infoDuration),
						}))
						.filter(
							(item) =>
								item.meta.isHls &&
								item.meta.hasVideo &&
								item.meta.hasAudio &&
								typeof item.size === "number" &&
								item.size > 0 &&
								item.size <= maxUploadSize &&
								`${item.format?.format_id ?? ""}` !== `${selectedQuality ?? ""}`,
						)
						.sort((a, b) => (b.size || 0) - (a.size || 0))

					for (const nextHls of nextHlsFormats) {
						const nextHlsId = `${nextHls.format?.format_id ?? ""}`.trim()
						if (!nextHlsId) continue
						const nextHlsLabel = getFormatSuggestionLabel(
							{ format: nextHls.format, meta: nextHls.meta },
							nextHls.size,
						)
						const explicitArgs = buildExplicitFormatArgs(nextHlsId)
						const explicitDownloadArgs =
							explicitArgs.includes("--js-runtimes") || skipJsRuntime
								? explicitArgs
								: [...jsRuntimeArgs, ...explicitArgs]
						if (statusMessageId) {
							await updateMessage(
								ctx,
								statusMessageId,
								`Обработка: <b>${title}</b>\nСтатус: HLS недоступен, пробуем ${nextHlsLabel}...`,
							)
						}
						try {
							fileSize = ""
							downloadedSize = ""
							progressText = "Скачиваем..."
							await runDownload(
								explicitDownloadArgs,
								[
									...hlsPoTokenArgs,
									...impersonateArgs,
									...youtubeArgs,
									...refererArgs,
								],
								cookieArgsList,
							)
							selectedQuality = nextHlsId
							selectedIsRawFormat = true
							selectedForceHls = true
							selectedFormatLabelTail = nextHlsLabel
							if (typeof nextHls.size === "number") {
								estimatedSizeLabel = formatBytes(nextHls.size)
							}
							downloadSucceeded = true
							break
						} catch (nextHlsError) {
							lastDownloadError = nextHlsError
						}
					}
				}
			} else {
				if (isVimeo) {
					try {
						await runDownloadWithCookies(downloadArgs)
						downloadSucceeded = true
					} catch (error) {
						lastDownloadError = error
					}
				} else {
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
						if (!downloadSucceeded && proxyArgs.length > 0) {
							if (statusMessageId) {
								await updateMessage(
									ctx,
									statusMessageId,
									`Обработка: <b>${title}</b>\nСтатус: пробуем через прокси...`,
								)
							}
							console.log("[DEBUG] Retrying yt-dlp download via proxy")
							try {
								await runDownload(
									downloadArgs,
									[...baseExtraArgs, ...proxyArgs],
									cookieArgsList,
								)
								downloadSucceeded = true
							} catch (proxyError) {
								lastDownloadError = proxyError
							}
						}
					}
				}
			}

				if (!downloadSucceeded) {
					if (
						explicitFormatId &&
						isFormatUnavailableError(lastDownloadError)
					) {
						const explicitArgs = buildExplicitFormatArgs(explicitFormatId)
						const explicitDownloadArgs =
							explicitArgs.includes("--js-runtimes") || skipJsRuntime
								? explicitArgs
								: [...jsRuntimeArgs, ...explicitArgs]
						if (statusMessageId) {
							await updateMessage(
								ctx,
								statusMessageId,
								`Обработка: <b>${title}</b>\nСтатус: формат недоступен, пробуем другой...`,
							)
						}
						try {
							if (isVimeo) {
								await runDownloadWithCookies(explicitDownloadArgs)
							} else {
								fileSize = ""
								downloadedSize = ""
								progressText = "Скачиваем..."
								await runDownload(
									explicitDownloadArgs,
									[
										...hlsPoTokenArgs,
										...impersonateArgs,
										...youtubeArgs,
										...refererArgs,
									],
									cookieArgsList,
								)
							}
							downloadSucceeded = true
						} catch (explicitError) {
							lastDownloadError = explicitError
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
				fileSize = ""
				downloadedSize = ""
				progressText = "Скачиваем..."
				if (isVimeo) {
					await runDownloadWithCookies(retryArgs)
				} else {
					await runDownload(
						retryArgs,
						[
							...hlsPoTokenArgs,
							...impersonateArgs,
							...youtubeArgs,
							...refererArgs,
						],
						cookieArgsList,
					)
				}
				downloadSucceeded = true
			}
			if (statusHeartbeat) clearInterval(statusHeartbeat)

			let externalAudioApplied = false
			if (externalAudio && !isMhtml) {
				const translatedAudioPath = resolve(tempDir, "translated-audio.m4a")
				const audioStart = Date.now()
				logTranslate("audio_download_start", {
					chat: ctx.chat?.id,
					title,
					url: redactUrl(externalAudio),
				})
				if (statusMessageId) {
					await updateMessage(
						ctx,
						statusMessageId,
						`Обработка: <b>${title}</b>\nСтатус: Скачиваем перевод...`,
					)
				}
				await spawnPromise(
					"ffmpeg",
					[
						"-y",
						"-i",
						externalAudio,
						"-vn",
						"-c:a",
						"aac",
						"-b:a",
						"192k",
						"-ar",
						"48000",
						translatedAudioPath,
					],
					undefined,
					signal,
				)
				if (!(await fileExists(translatedAudioPath, 1024))) {
					logTranslate("audio_download_failed", {
						chat: ctx.chat?.id,
						title,
						url: redactUrl(externalAudio),
					})
					throw new Error("Translated audio download failed")
				}
				const translatedStats = await stat(translatedAudioPath).catch(() => null)
				logTranslate("audio_downloaded", {
					chat: ctx.chat?.id,
					title,
					bytes: translatedStats?.size,
					seconds: Math.round((Date.now() - audioStart) / 1000),
				})
				const muxContainer = outputContainer === "mp4" ? "mp4" : "mkv"
				const translatedBase = dashFileBase || safeTitle || "video"
				const translatedPath = resolve(
					tempDir,
					`${translatedBase}_translated.${muxContainer}`,
				)
				const hasOriginalAudio =
					(info.acodec && info.acodec !== "none") ||
					requestedFormats.some(
						(format: any) => format?.acodec && format.acodec !== "none",
					)
				if (statusMessageId) {
					await updateMessage(
						ctx,
						statusMessageId,
						`Обработка: <b>${title}</b>\nСтатус: Микшируем перевод...`,
					)
				}
				logTranslate("audio_mix_start", {
					chat: ctx.chat?.id,
					title,
					container: muxContainer,
					hasOriginalAudio,
				})
				const muxArgs = hasOriginalAudio
					? [
							"-y",
							"-i",
							tempFilePath,
							"-i",
							translatedAudioPath,
							"-filter_complex",
							`[0:a]${AUDIO_LOUDNORM_FILTER},volume=0.35[a0];[a0][1:a]amix=inputs=2:weights=0.35 1.0:normalize=0[a]`,
							"-map",
							"0:v:0",
							"-map",
							"[a]",
							"-c:v",
							"copy",
							"-c:a",
							"aac",
							"-b:a",
							"192k",
							"-shortest",
						]
					: [
							"-y",
							"-i",
							tempFilePath,
							"-i",
							translatedAudioPath,
							"-map",
							"0:v:0",
							"-map",
							"1:a:0",
							"-c:v",
							"copy",
							"-c:a",
							"aac",
							"-b:a",
							"192k",
							"-shortest",
						]
				if (muxContainer === "mp4") {
					muxArgs.push("-movflags", "+faststart")
				}
				muxArgs.push(translatedPath)
				await spawnPromise("ffmpeg", muxArgs, undefined, signal)
				if (await fileExists(translatedPath, 1024)) {
					try {
						await unlink(tempFilePath)
					} catch {}
					tempFilePath = translatedPath
					outputContainer = muxContainer
					externalAudioApplied = true
					logTranslate("audio_mix_done", {
						chat: ctx.chat?.id,
						title,
						container: muxContainer,
					})
				}
				try {
					await unlink(translatedAudioPath)
				} catch {}
			}

			const hasVideoTrack = info.vcodec && info.vcodec !== "none"
			const needsAudioFix =
				(isTiktok || isInstagram) &&
				hasVideoTrack &&
				!isMhtml &&
				outputContainer === "mp4" &&
				!isMp3Format &&
				quality !== "audio" &&
				!externalAudioApplied

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
						"-af",
						AUDIO_LOUDNORM_FILTER,
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

			if (sponsorCutRequested && isYouTube && !isAudioRequest && !isMhtml) {
				const videoId = extractYouTubeVideoId(sourceUrl || url)
				if (!videoId) {
					console.warn("[WARN] SponsorBlock: failed to extract video ID", {
						url: cleanUrl(sourceUrl || url),
					})
				} else {
					if (statusMessageId) {
						await updateMessage(
							ctx,
							statusMessageId,
							`Обработка: <b>${title}</b>\nСтатус: Ищем сегменты SponsorBlock...`,
						)
					}
					try {
						const segments = await fetchSponsorSegments(videoId, sponsorCategories)
						if (segments.length > 0) {
							const metadata = await getVideoMetadata(tempFilePath)
							const duration =
								metadata.duration ||
								(typeof info.duration === "number" ? info.duration : undefined)
							if (!duration) {
								console.warn("[WARN] SponsorBlock: missing duration, skipping trim", {
									url: cleanUrl(sourceUrl || url),
									videoId,
								})
							} else {
								const mergedSegments = mergeSponsorSegments(segments, duration)
								const keepRanges = buildKeepRanges(mergedSegments, duration)
								if (keepRanges.length === 0) {
									console.warn("[WARN] SponsorBlock: no keep ranges after merge", {
										url: cleanUrl(sourceUrl || url),
										videoId,
									})
								} else {
									if (statusMessageId) {
										await updateMessage(
											ctx,
											statusMessageId,
											`Обработка: <b>${title}</b>\nСтатус: Вырезаем сегменты...`,
										)
									}
										const sbBase = sanitizeFilePart(title || "video", "video")
										const trimmedPath = resolve(
											tempDir,
											`${sbBase}_sb.${outputContainer}`,
										)
										const copyOnlyTrim = isAllSponsorCategoriesSelected(
											sponsorCategories,
										)
										await trimVideoByRanges(
											tempFilePath,
											keepRanges,
											trimmedPath,
											outputContainer,
											signal,
											copyOnlyTrim,
										)
										if (await fileExists(trimmedPath, 1024)) {
											try {
												const trimmedMeta = await getVideoMetadata(trimmedPath)
												if (trimmedMeta.duration > 0) {
													tempFilePath = trimmedPath
												} else {
													console.warn(
														"[WARN] SponsorBlock: trimmed file has invalid duration, keeping original",
														{ path: trimmedPath },
													)
												}
											} catch (trimmedMetaError) {
												console.warn(
													"[WARN] SponsorBlock: trimmed file metadata check failed, keeping original",
													trimmedMetaError,
												)
											}
										}
									}
								}
							}
					} catch (error) {
						console.error("SponsorBlock trim error:", error)
					}
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
						await runWithPersistentChatAction(ctx, "upload_document", () =>
							runTelegramSendWithRetry("sendDocument", () =>
								ctx.replyWithDocument(new InputFile(tempFilePath), {
									caption,
									parse_mode: "HTML",
									message_thread_id: threadId,
								}),
							),
						)
					} else {
						if (outputContainer !== "mp4") {
					if (statusMessageId) {
						await updateMessage(
							ctx,
							statusMessageId,
							`Обработка: <b>${title}</b>\nСтатус: Отправляем...`,
						)
						}
							await runWithPersistentChatAction(ctx, "upload_document", () =>
								runTelegramSendWithRetry("sendDocument", () =>
									ctx.replyWithDocument(new InputFile(tempFilePath), {
										caption,
										parse_mode: "HTML",
										message_thread_id: threadId,
									}),
								),
							)
						} else {
					// Get metadata directly from the file
					const metadata = await getVideoMetadata(tempFilePath)
					const width = metadata.width || info.width
					const height = metadata.height || info.height
					const duration = metadata.duration || info.duration
					const isAv1Video = /av01|av1/i.test(resolvedVideoCodec)

						// Generate local thumbnail to ensure correct aspect ratio in Telegram
						await generateThumbnail(tempFilePath, tempThumbPath)
						const hasThumbFile = await fileExists(tempThumbPath, 256)
						if (!hasThumbFile) {
							console.warn("[WARN] Thumbnail not available, sending without it", {
								url: cleanUrl(url),
								title,
								tempThumbPath,
						})
					}

						if (statusMessageId) {
						await updateMessage(
							ctx,
							statusMessageId,
							`Обработка: <b>${title}</b>\nСтатус: Отправляем...`,
						)
					}

							const supportsStreaming =
								outputContainer === "mp4" && !isTiktok && !isAv1Video
							try {
								await runWithPersistentChatAction(ctx, "upload_video", () =>
									runTelegramSendWithRetry("sendVideo", () =>
										ctx.replyWithVideo(new InputFile(tempFilePath), {
											caption,
											parse_mode: "HTML",
											supports_streaming: supportsStreaming,
											duration,
											width,
											height,
											thumbnail: hasThumbFile
												? new InputFile(tempThumbPath)
												: undefined,
											message_thread_id: threadId,
										}),
									),
								)
							} catch (sendVideoError) {
						console.warn("[WARN] sendVideo failed, retrying as document", {
							url: cleanUrl(sourceUrl || url),
							error:
								sendVideoError instanceof Error
									? sendVideoError.message
									: String(sendVideoError),
						})
						if (statusMessageId) {
							await updateMessage(
								ctx,
								statusMessageId,
								`Обработка: <b>${title}</b>\nСтатус: Видео не отправилось, пробуем как файл...`,
							)
						}
							await runWithPersistentChatAction(ctx, "upload_document", () =>
								runTelegramSendWithRetry("sendDocument", () =>
									ctx.replyWithDocument(new InputFile(tempFilePath), {
										caption,
										parse_mode: "HTML",
										message_thread_id: threadId,
									}),
								),
							)
						}
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
		await logUserLink(ctx.from?.id, sourceUrl || url, "success")
		console.log(`[SUCCESS] Sent video to chat ${ctx.chat.id}`)
	} catch (error) {
		if (isAbortError(error)) return
		console.error(`[ERROR] Failed to download/send ${url}:`, error)
		await logUserLink(ctx.from?.id, sourceUrl || url, "error", String(error))
		await logErrorEntry({
			userId: ctx.from?.id,
			url: sourceUrl || url,
			context: "download/send",
			error: error instanceof Error ? error.message : String(error),
		})
		if (ctx.chat?.type === "private") {
			await createUserReportPrompt(
				ctx,
				`URL: ${cleanUrl(url)}`,
				error instanceof Error ? error.message : "Unknown error",
			)
		}
		await notifyAdminError(
			ctx.chat,
			`URL: ${cleanUrl(url)}`,
			error instanceof Error ? error.message : "Unknown error",
			ctx.from,
			ctx.message,
		)
				const msg = isFacebookTemporaryBlockError(error)
					? getFacebookTemporaryBlockMessage()
					: "Ошибка."
				if (statusMessageId) {
					await updateMessage(ctx, statusMessageId, msg)
				} else if (ctx.callbackQuery) {
					await ctx.editMessageText(msg)
				} else if (ctx.chat.type === "private") {
					await createUserReportPrompt(
						ctx,
						`URL: ${cleanUrl(url)}`,
						error instanceof Error ? error.message : "Unknown error",
					)
					await ctx.reply(msg)
				}
			} finally {
		try {
			await rm(tempDir, { recursive: true, force: true })
		} catch {}
	}
}

const runTranslatedDownload = async (params: {
	ctx: any
	url: string
	sourceUrl?: string
	statusMessageId?: number
	replyToMessageId?: number
	signal?: AbortSignal
	overrideTitle?: string
	externalAudioUrl?: string
	sponsorCutRequested?: boolean
	sponsorCategories?: string[]
}) => {
	const {
		ctx,
		url,
		sourceUrl,
		statusMessageId,
		replyToMessageId,
		signal,
		overrideTitle,
		externalAudioUrl,
		sponsorCutRequested = false,
		sponsorCategories,
	} = params
	const translateTarget = sourceUrl || url
	const resolvedTranslateTarget = await resolveFacebookShareUrl(translateTarget)
	const translateUrl =
		resolvedTranslateTarget !== translateTarget ? resolvedTranslateTarget : translateTarget
	if (translateUrl !== translateTarget) {
		console.log(
			`[DEBUG] Resolved Facebook share URL for translate: ${translateTarget} -> ${translateUrl}`,
		)
	}
	let audioUrl = externalAudioUrl
	const startedAt = Date.now()
	logTranslate("request", {
		chat: ctx.chat?.id,
		url: redactUrl(translateUrl),
		externalAudio: audioUrl ? redactUrl(audioUrl) : undefined,
	})
	try {
		if (!audioUrl) {
			if (statusMessageId) {
				await updateMessage(
					ctx,
					statusMessageId,
					formatVerboseStatus("Запрашиваем перевод...", {
						time: `${Math.round((Date.now() - startedAt) / 1000)}s`,
					}),
				)
			}
			audioUrl = await translateWithVot(translateUrl, ctx, statusMessageId, signal)
		}
		await downloadAndSend(
			ctx,
			url,
			"b",
			false,
			statusMessageId,
			overrideTitle,
			replyToMessageId,
			signal,
			false,
			undefined,
			false,
			sourceUrl,
			false,
			audioUrl,
			sponsorCutRequested,
			sponsorCategories,
		)
		logTranslate("complete", {
			chat: ctx.chat?.id,
			url: redactUrl(translateUrl),
			totalSeconds: Math.round((Date.now() - startedAt) / 1000),
		})
	} catch (error) {
		logTranslate("failed", {
			chat: ctx.chat?.id,
			url: redactUrl(translateUrl),
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}
}

bot.use(async (ctx, next) => {
	const from = ctx.from
	if (from?.id) {
		await loadUsers()
		const existing = users.get(from.id) || { id: from.id }
		const updated: UserProfile = {
			...existing,
			id: from.id,
			username: from.username ?? existing.username,
			first_name: from.first_name ?? existing.first_name,
			last_name: from.last_name ?? existing.last_name,
			language_code: from.language_code ?? existing.language_code,
			is_bot: from.is_bot ?? existing.is_bot,
			last_seen: new Date().toISOString(),
			chat_id: ctx.chat?.id ?? existing.chat_id,
		}
		users.set(from.id, updated)
		scheduleUsersSave()
		if (await isBanned(from.id)) {
			if (ctx.chat?.type === "private") {
				await ctx.reply("Вы заблокированы.")
			}
			return
		}
	}

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

bot.command("proxy", async (ctx) => {
	if (ctx.from?.id !== ADMIN_ID) return
	await deleteUserMessage(ctx)
	const text = ctx.message?.text || ""
	const args = text.split(/\s+/).slice(1)
	if (args.length === 0) {
		const current = await readProxyValue()
		if (current) {
			await ctx.reply(`Proxy: ${code(current)}`)
		} else {
			await ctx.reply(
				[
					"Proxy не задан.",
					"Формат: /proxy <scheme>://<user>:<pass>@<host>:<port>",
					"Примеры:",
					code("socks5://login:password@1.2.3.4:1080"),
					code("http://login:password@proxy.example.com:3128"),
					"Сброс: /proxy off",
				].join("\n"),
			)
		}
		return
	}
	const value = args.join(" ").trim()
	if (!value || value.toLowerCase() === "off" || value.toLowerCase() === "clear") {
		try {
			await unlink(PROXY_FILE)
		} catch {}
		await ctx.reply("Proxy очищен.")
		return
	}
	await writeFile(PROXY_FILE, value)
	await ctx.reply("Proxy обновлен.")
})

bot.command("send", async (ctx) => {
	if (ctx.from?.id !== ADMIN_ID) return
	await deleteUserMessage(ctx)
	const text = ctx.message?.text || ""
	const args = text.split(/\s+/).slice(1)
	const targetId = Number.parseInt(args[0] || "", 10)
	if (!Number.isFinite(targetId)) {
		await ctx.reply("Формат: ответить на медиа и написать /send <id>")
		return
	}
	const replied = ctx.message?.reply_to_message
	if (!replied) {
		await ctx.reply("Нужно ответить на сообщение с медиа.")
		return
	}
		try {
			await bot.api.copyMessage(targetId, replied.chat.id, replied.message_id)
			await ctx.reply(`Отправлено пользователю.\nID: ${targetId}`)
		} catch (error) {
		await ctx.reply("Не удалось отправить. Проверьте, что пользователь писал боту.")
		console.error("Failed to send admin media copy:", error)
	}
})

bot.command("user", async (ctx) => {
	if (ctx.from?.id !== ADMIN_ID) return
	await deleteUserMessage(ctx)
	const text = ctx.message?.text || ""
	const args = text.split(/\s+/).slice(1)
	const target = await getUserFromArgs(ctx, args)
	if (!target) {
		await ctx.reply("Формат: /user <id> (или ответом на сообщение)")
		return
	}
	await loadUsers()
	const profile = users.get(target.id) || target
	await loadBans()
	const banEntry = bans.get(target.id)
	let resolvedProfile = profile
	if (!profile.username && !profile.first_name) {
		try {
			const chat = await ctx.api.getChat(target.id)
			resolvedProfile = {
				...profile,
				id: chat.id,
				username: "username" in chat ? chat.username : undefined,
				first_name: "first_name" in chat ? chat.first_name : undefined,
				last_name: "last_name" in chat ? chat.last_name : undefined,
			}
		} catch {}
	}
	await ctx.reply(code(formatUserProfile(resolvedProfile, banEntry)))
})

bot.command("ban", async (ctx) => {
	if (ctx.from?.id !== ADMIN_ID) return
	await deleteUserMessage(ctx)
	const text = ctx.message?.text || ""
	const args = text.split(/\s+/).slice(1)
	const target = await getUserFromArgs(ctx, args)
	if (!target) {
		await ctx.reply("Формат: /ban <id> [причина] (или ответом на сообщение)")
		return
	}
	const reason = args.length > 1 ? args.slice(1).join(" ").trim() : ""
	await loadBans()
	bans.set(target.id, {
		id: target.id,
		at: Date.now(),
		by: ctx.from.id,
		reason: reason || undefined,
	})
	await saveBans()
	await ctx.reply(`Пользователь ${code(String(target.id))} заблокирован.`)
})

bot.command("unban", async (ctx) => {
	if (ctx.from?.id !== ADMIN_ID) return
	await deleteUserMessage(ctx)
	const text = ctx.message?.text || ""
	const args = text.split(/\s+/).slice(1)
	const target = await getUserFromArgs(ctx, args)
	if (!target) {
		await ctx.reply("Формат: /unban <id> (или ответом на сообщение)")
		return
	}
	await loadBans()
	if (bans.delete(target.id)) {
		await saveBans()
		await ctx.reply(`Пользователь ${code(String(target.id))} разблокирован.`)
		return
	}
	await ctx.reply(`Пользователь ${code(String(target.id))} не был в бане.`)
})

bot.command("stats", async (ctx) => {
	if (ctx.from?.id !== ADMIN_ID) return
	await deleteUserMessage(ctx)
	const snapshot = await buildUserStatsSnapshot()
	const topUsers = snapshot.topUsers.slice(0, 5).map((u, idx) => {
		return `${idx + 1}. ${u.label} (id: ${u.id}) — ${u.requests}`
	})

	const lines = [
		bold("Stats"),
		`Users: ${snapshot.usersTotal}`,
		`Banned: ${snapshot.bannedTotal}`,
		`Active 24h: ${snapshot.active24h}`,
		`Active 7d: ${snapshot.active7d}`,
		`Active 30d: ${snapshot.active30d}`,
		`Requests total: ${snapshot.requestsTotal}`,
		`Downloads total: ${snapshot.downloadsTotal}`,
		"",
		bold("Top users by requests"),
		topUsers.length ? topUsers.join("\n") : "—",
	]

	await ctx.reply(lines.join("\n"), { parse_mode: "HTML" })
})

server.get("/admin/stats.json", requireDashboardAuth, async (_req, res) => {
	try {
		const snapshot = await buildUserStatsSnapshot()
		res.json(snapshot)
	} catch (error) {
		console.error("Failed to build stats snapshot:", error)
		res.status(500).json({ error: "Failed to build stats snapshot" })
	}
})

server.get("/admin/stats", requireDashboardAuth, async (_req, res) => {
	try {
		const snapshot = await buildUserStatsSnapshot()
		const rows = snapshot.topUsers
			.map((u, index) => {
				const lastSeen = u.lastSeen ? escapeHtml(u.lastSeen) : "—"
				return `
          <tr>
            <td>${index + 1}</td>
            <td>${escapeHtml(u.label)}</td>
            <td>${u.id}</td>
            <td>${u.requests}</td>
            <td>${u.downloads}</td>
            <td>${lastSeen}</td>
          </tr>
        `
			})
			.join("")

		const html = `
      <!doctype html>
      <html lang="ru">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>User Stats</title>
          <style>
            :root {
              color-scheme: light;
              --bg: #f4f5f7;
              --card: #ffffff;
              --text: #101828;
              --muted: #667085;
              --accent: #0f7b6c;
              --border: #e4e7ec;
            }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
              background: linear-gradient(135deg, #eef2f3 0%, #e7ecef 40%, #f4f5f7 100%);
              color: var(--text);
            }
            header {
              padding: 28px 32px 12px;
            }
            h1 {
              margin: 0 0 6px;
              font-size: 28px;
              letter-spacing: -0.01em;
            }
            .meta {
              color: var(--muted);
              font-size: 14px;
            }
            .container {
              padding: 0 32px 32px;
              display: grid;
              gap: 16px;
            }
            .cards {
              display: grid;
              gap: 12px;
              grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            }
            .card {
              background: var(--card);
              border: 1px solid var(--border);
              border-radius: 14px;
              padding: 16px;
              box-shadow: 0 4px 12px rgba(16, 24, 40, 0.06);
            }
            .card h3 {
              margin: 0 0 6px;
              font-size: 12px;
              letter-spacing: 0.08em;
              text-transform: uppercase;
              color: var(--muted);
            }
            .card .value {
              font-size: 26px;
              font-weight: 600;
              color: var(--text);
            }
            .table-wrap {
              background: var(--card);
              border: 1px solid var(--border);
              border-radius: 16px;
              padding: 8px 16px 16px;
              overflow-x: auto;
              box-shadow: 0 6px 16px rgba(16, 24, 40, 0.08);
            }
            table {
              width: 100%;
              border-collapse: collapse;
              font-size: 14px;
            }
            th, td {
              padding: 12px 8px;
              border-bottom: 1px solid var(--border);
              text-align: left;
              white-space: nowrap;
            }
            th {
              font-size: 12px;
              text-transform: uppercase;
              letter-spacing: 0.06em;
              color: var(--muted);
            }
            tbody tr:hover {
              background: #f8fafc;
            }
            .pill {
              display: inline-block;
              padding: 2px 8px;
              background: rgba(15, 123, 108, 0.1);
              color: var(--accent);
              border-radius: 999px;
              font-weight: 600;
              font-size: 12px;
            }
            @media (max-width: 640px) {
              header, .container { padding: 20px; }
              h1 { font-size: 22px; }
            }
          </style>
        </head>
        <body>
          <header>
            <h1>User Stats</h1>
            <div class="meta">Обновлено: ${escapeHtml(snapshot.generatedAt)}</div>
          </header>
          <div class="container">
            <div class="cards">
              <div class="card">
                <h3>Всего пользователей</h3>
                <div class="value">${snapshot.usersTotal}</div>
              </div>
              <div class="card">
                <h3>Забанено</h3>
                <div class="value">${snapshot.bannedTotal}</div>
              </div>
              <div class="card">
                <h3>Активны 24h</h3>
                <div class="value">${snapshot.active24h}</div>
              </div>
              <div class="card">
                <h3>Активны 7d</h3>
                <div class="value">${snapshot.active7d}</div>
              </div>
              <div class="card">
                <h3>Активны 30d</h3>
                <div class="value">${snapshot.active30d}</div>
              </div>
              <div class="card">
                <h3>Requests</h3>
                <div class="value">${snapshot.requestsTotal}</div>
              </div>
              <div class="card">
                <h3>Downloads</h3>
                <div class="value">${snapshot.downloadsTotal}</div>
              </div>
              <div class="card">
                <h3>Top users</h3>
                <div class="value"><span class="pill">Top ${snapshot.topUsers.length}</span></div>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>User</th>
                    <th>ID</th>
                    <th>Requests</th>
                    <th>Downloads</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows || "<tr><td colspan=\"6\">Нет данных</td></tr>"}
                </tbody>
              </table>
            </div>
          </div>
        </body>
      </html>
    `

		res.setHeader("Content-Type", "text/html; charset=utf-8")
		res.send(html)
	} catch (error) {
		console.error("Failed to render stats dashboard:", error)
		res.status(500).send("Failed to render stats dashboard")
	}
})

server.get("/admin/users.json", requireDashboardAuth, async (_req, res) => {
	try {
		const usersList = await buildUserList()
		res.json({
			generatedAt: new Date().toISOString(),
			total: usersList.length,
			users: usersList,
		})
	} catch (error) {
		console.error("Failed to build users list:", error)
		res.status(500).json({ error: "Failed to build users list" })
	}
})

server.get("/admin/users", requireDashboardAuth, async (_req, res) => {
	try {
		const usersList = await buildUserList()
		const rows = usersList
			.map((u, index) => {
				const lastSeen = u.lastSeen ? escapeHtml(u.lastSeen) : "—"
				const name = escapeHtml(u.label)
				const username = u.username ? `@${escapeHtml(u.username)}` : "—"
				return `
          <tr>
            <td>${index + 1}</td>
            <td>${name}</td>
            <td>${username}</td>
            <td>${u.id}</td>
            <td>${u.requests}</td>
            <td>${u.downloads}</td>
            <td>${lastSeen}</td>
          </tr>
        `
			})
			.join("")

		const html = `
      <!doctype html>
      <html lang="ru">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Users</title>
          <style>
            :root {
              color-scheme: light;
              --bg: #f4f5f7;
              --card: #ffffff;
              --text: #101828;
              --muted: #667085;
              --accent: #0f7b6c;
              --border: #e4e7ec;
            }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
              background: linear-gradient(135deg, #eef2f3 0%, #e7ecef 40%, #f4f5f7 100%);
              color: var(--text);
            }
            header {
              padding: 28px 32px 12px;
            }
            h1 {
              margin: 0 0 6px;
              font-size: 28px;
              letter-spacing: -0.01em;
            }
            .meta {
              color: var(--muted);
              font-size: 14px;
            }
            .container {
              padding: 0 32px 32px;
              display: grid;
              gap: 16px;
            }
            .table-wrap {
              background: var(--card);
              border: 1px solid var(--border);
              border-radius: 16px;
              padding: 8px 16px 16px;
              overflow-x: auto;
              box-shadow: 0 6px 16px rgba(16, 24, 40, 0.08);
            }
            table {
              width: 100%;
              border-collapse: collapse;
              font-size: 14px;
            }
            th, td {
              padding: 12px 8px;
              border-bottom: 1px solid var(--border);
              text-align: left;
              white-space: nowrap;
            }
            th {
              font-size: 12px;
              text-transform: uppercase;
              letter-spacing: 0.06em;
              color: var(--muted);
            }
            tbody tr:hover {
              background: #f8fafc;
            }
            @media (max-width: 640px) {
              header, .container { padding: 20px; }
              h1 { font-size: 22px; }
            }
          </style>
        </head>
        <body>
          <header>
            <h1>Users</h1>
            <div class="meta">Всего: ${usersList.length}</div>
          </header>
          <div class="container">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>User</th>
                    <th>Username</th>
                    <th>ID</th>
                    <th>Requests</th>
                    <th>Downloads</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows || "<tr><td colspan=\"7\">Нет данных</td></tr>"}
                </tbody>
              </table>
            </div>
          </div>
        </body>
      </html>
    `

		res.setHeader("Content-Type", "text/html; charset=utf-8")
		res.send(html)
	} catch (error) {
		console.error("Failed to render users list:", error)
		res.status(500).send("Failed to render users list")
	}
})

server.get("/admin/users/:id/links.json", requireDashboardAuth, async (req, res) => {
	try {
		const userId = Number.parseInt(String(req.params.id || ""), 10)
		if (!Number.isFinite(userId)) {
			res.status(400).json({ error: "Invalid user id" })
			return
		}
		const links = await getUserLinks(userId)
		res.json({ userId, total: links.length, links })
	} catch (error) {
		console.error("Failed to get user links:", error)
		res.status(500).json({ error: "Failed to get user links" })
	}
})

server.get("/admin/links.json", requireDashboardAuth, async (req, res) => {
	try {
		const limit = Number.parseInt(String(req.query.limit || "200"), 10)
		const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 200
		const links = await getAllLinks()
		res.json({ total: links.length, links: links.slice(0, safeLimit) })
	} catch (error) {
		console.error("Failed to get links:", error)
		res.status(500).json({ error: "Failed to get links" })
	}
})

server.get("/admin/errors.json", requireDashboardAuth, async (_req, res) => {
	try {
		const errors = await getErrorLogs()
		res.json({ total: errors.length, errors })
	} catch (error) {
		console.error("Failed to load error logs:", error)
		res.status(500).json({ error: "Failed to load error logs" })
	}
})

server.get("/admin/cookies.json", requireDashboardAuth, async (req, res) => {
	try {
		const includeContent =
			String(req.query.content || "").trim().toLowerCase() === "1"
		try {
			const stats = await stat(COOKIE_FILE)
			if (!stats.isFile()) {
				res.json({ exists: false })
				return
			}
			const raw = await readFile(COOKIE_FILE, "utf-8")
			const summary = parseCookieStats(raw)
			res.json({
				exists: true,
				size: stats.size,
				updatedAt: stats.mtime.toISOString(),
				stats: summary,
				content: includeContent ? raw : undefined,
				example: cookieFormatExample,
			})
		} catch (error) {
			res.json({
				exists: false,
				error: error instanceof Error ? error.message : String(error),
				example: cookieFormatExample,
			})
		}
	} catch (error) {
		console.error("Failed to load cookies:", error)
		res.status(500).json({ error: "Failed to load cookies" })
	}
})

server.post("/admin/cookies.json", requireDashboardAuth, async (req, res) => {
	try {
		const content = typeof req.body?.content === "string" ? req.body.content : ""
		const mode = String(req.body?.mode || "append").toLowerCase()
		if (!content.trim()) {
			res.status(400).json({ error: "Empty content" })
			return
		}
		let result
		if (mode === "replace") {
			await ensureStorageDir()
			await writeFile(COOKIE_FILE, content)
			result = {
				addedCookies: 0,
				totalCookies: 0,
				incomingCookieLines: 0,
				invalidIncoming: 0,
				incomingHttpOnlyLines: 0,
				replaced: true,
			}
		} else {
			let existing = ""
			try {
				existing = await readFile(COOKIE_FILE, "utf-8")
			} catch {}
			const merged = mergeCookieContent(existing, content)
			await ensureStorageDir()
			await writeFile(COOKIE_FILE, merged.content)
			result = merged
		}
		const stats = await stat(COOKIE_FILE)
		const raw = await readFile(COOKIE_FILE, "utf-8")
		const summary = parseCookieStats(raw)
		res.json({
			ok: true,
			mode,
			result,
			size: stats.size,
			updatedAt: stats.mtime.toISOString(),
			stats: summary,
		})
	} catch (error) {
		console.error("Failed to update cookies:", error)
		res.status(500).json({ error: "Failed to update cookies" })
	}
})

server.post("/admin/cookies/delete", requireDashboardAuth, async (_req, res) => {
	try {
		await unlink(COOKIE_FILE)
		res.json({ ok: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			res.json({ ok: true })
			return
		}
		console.error("Failed to delete cookies:", error)
		res.status(500).json({ error: "Failed to delete cookies" })
	}
})

server.get("/admin/proxy.json", requireDashboardAuth, async (_req, res) => {
	try {
		const status = await buildProxyStatus()
		res.json({
			active: status.active,
			source: status.source,
			fileValue: status.fileValue,
			envValue: status.envValue,
			fileMeta: status.fileMeta,
		})
	} catch (error) {
		console.error("Failed to load proxy:", error)
		res.status(500).json({ error: "Failed to load proxy" })
	}
})

server.post("/admin/proxy.json", requireDashboardAuth, async (req, res) => {
	try {
		const value = typeof req.body?.value === "string" ? req.body.value.trim() : ""
		await ensureStorageDir()
		await writeFile(PROXY_FILE, value)
		const status = await buildProxyStatus()
		res.json({ ok: true, ...status })
	} catch (error) {
		console.error("Failed to update proxy:", error)
		res.status(500).json({ error: "Failed to update proxy" })
	}
})

server.post("/admin/proxy/delete", requireDashboardAuth, async (_req, res) => {
	try {
		await unlink(PROXY_FILE)
		const status = await buildProxyStatus()
		res.json({ ok: true, ...status })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			const status = await buildProxyStatus()
			res.json({ ok: true, ...status })
			return
		}
		console.error("Failed to delete proxy:", error)
		res.status(500).json({ error: "Failed to delete proxy" })
	}
})

server.get("/admin/system.json", requireDashboardAuth, (_req, res) => {
	try {
		const totalMem = os.totalmem()
		const freeMem = os.freemem()
		const usedMem = totalMem - freeMem
		const load = os.loadavg()
		res.json({
			uptime: os.uptime(),
			load1: load[0],
			load5: load[1],
			load15: load[2],
			memoryTotal: totalMem,
			memoryFree: freeMem,
			memoryUsed: usedMem,
			processRss: process.memoryUsage().rss,
		})
	} catch (error) {
		console.error("Failed to build system stats:", error)
		res.status(500).json({ error: "Failed to build system stats" })
	}
})

server.get("/admin/system-history.json", requireDashboardAuth, async (req, res) => {
	try {
		await loadSystemHistory()
		const hoursParam = req.query.hours ? Number(req.query.hours) : undefined
		const periodHours =
			Number.isFinite(hoursParam) && hoursParam && hoursParam > 0
				? Math.min(hoursParam, 168)
				: 24
		const cutoff = Date.now() - periodHours * 60 * 60 * 1000
		const samples = systemHistory.filter(
			(item) => Date.parse(item.at) >= cutoff,
		)
		res.json({ periodHours, total: samples.length, samples })
	} catch (error) {
		console.error("Failed to build system history:", error)
		res.status(500).json({ error: "Failed to build system history" })
	}
})

server.get("/admin/logout", (_req, res) => {
	res.setHeader("WWW-Authenticate", "Basic realm=\"Yakachokbot Admin\"")
	res.status(401).send("Logged out")
})

server.get("/admin/activity.json", requireDashboardAuth, async (_req, res) => {
	try {
		try {
			const raw = await readFile(ACTIVITY_FILE, "utf-8")
			const data = JSON.parse(raw)
			res.json(data)
			return
		} catch {}
		const jobs = Array.from(jobMeta.values()).map((job) => ({
			id: job.id,
			userId: job.userId,
			url: job.url,
			state: job.state,
		}))
		res.json({
			updatedAt: new Date().toISOString(),
			pending: queue.getPendingCount(),
			active: queue.getActiveCount(),
			jobs,
		})
	} catch (error) {
		console.error("Failed to build activity data:", error)
		res.status(500).json({ error: "Failed to build activity data" })
	}
})

server.post("/admin/users/:id/ban", requireDashboardAuth, async (req, res) => {
	try {
		const userId = Number.parseInt(String(req.params.id || ""), 10)
		if (!Number.isFinite(userId)) {
			res.status(400).json({ error: "Invalid user id" })
			return
		}
		const reason = typeof req.body?.reason === "string" ? req.body.reason : ""
		await loadBans()
		bans.set(userId, {
			id: userId,
			at: Date.now(),
			by: ADMIN_ID,
			reason: reason || undefined,
		})
		await saveBans()
		res.json({ ok: true })
	} catch (error) {
		console.error("Failed to ban user:", error)
		res.status(500).json({ error: "Failed to ban user" })
	}
})

server.post("/admin/users/:id/unban", requireDashboardAuth, async (req, res) => {
	try {
		const userId = Number.parseInt(String(req.params.id || ""), 10)
		if (!Number.isFinite(userId)) {
			res.status(400).json({ error: "Invalid user id" })
			return
		}
		await loadBans()
		bans.delete(userId)
		await saveBans()
		res.json({ ok: true })
	} catch (error) {
		console.error("Failed to unban user:", error)
		res.status(500).json({ error: "Failed to unban user" })
	}
})

server.post("/admin/users/:id/cancel", requireDashboardAuth, async (req, res) => {
	try {
		const userId = Number.parseInt(String(req.params.id || ""), 10)
		if (!Number.isFinite(userId)) {
			res.status(400).json({ error: "Invalid user id" })
			return
		}
		const removedRequests = cancelUserRequests(userId)
		const { removedCount, activeCancelled, remainingActive } = cancelUserJobs(userId)
		res.json({ ok: true, removedCount, activeCancelled, remainingActive, removedRequests })
	} catch (error) {
		console.error("Failed to cancel user jobs:", error)
		res.status(500).json({ error: "Failed to cancel user jobs" })
	}
})

server.get("/admin", requireDashboardAuth, async (_req, res) => {
	const html = `
    <!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Admin Panel</title>
        <style>
          :root {
            color-scheme: light;
            --bg: #f4f5f7;
            --card: #ffffff;
            --text: #101828;
            --muted: #667085;
            --accent: #0f7b6c;
            --border: #e4e7ec;
            --danger: #b42318;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
            background: linear-gradient(135deg, #eef2f3 0%, #e7ecef 40%, #f4f5f7 100%);
            color: var(--text);
          }
          header {
            padding: 24px 32px 12px;
          }
          h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.01em; }
          .meta { color: var(--muted); font-size: 14px; }
          .container { padding: 0 32px 32px; display: grid; gap: 16px; }
          .tabs { display: flex; gap: 8px; flex-wrap: wrap; }
          .tab-btn {
            border: 1px solid var(--border);
            background: var(--card);
            padding: 8px 12px;
            border-radius: 999px;
            cursor: pointer;
            font-weight: 600;
            color: var(--muted);
          }
          .tab-btn.active { color: var(--accent); border-color: rgba(15,123,108,0.4); }
          .panel { display: none; }
          .panel.active { display: block; }
          .cards {
            display: grid;
            gap: 12px;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          }
          .card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 14px;
            padding: 16px;
            box-shadow: 0 4px 12px rgba(16, 24, 40, 0.06);
          }
          .card h3 { margin: 0 0 6px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
          .card .value { font-size: 24px; font-weight: 600; }
          .table-wrap {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 8px 16px 16px;
            overflow-x: auto;
            box-shadow: 0 6px 16px rgba(16, 24, 40, 0.08);
          }
            table { width: 100%; border-collapse: collapse; font-size: 14px; table-layout: fixed; }
            th, td { padding: 10px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
            th[data-sort], th { overflow: hidden; text-overflow: ellipsis; }
            td { overflow: hidden; text-overflow: ellipsis; }
          th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
          tbody tr:hover { background: #f8fafc; }
          .actions { display: flex; gap: 6px; flex-wrap: wrap; }
          .btn {
            border: 1px solid var(--border);
            background: #fff;
            padding: 6px 10px;
            border-radius: 10px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
          }
          .btn.danger { color: var(--danger); border-color: rgba(180,35,24,0.4); }
          .btn.primary { color: var(--accent); border-color: rgba(15,123,108,0.4); }
          .search { padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; min-width: 220px; }
          .pager { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
          .pager select { padding: 6px 8px; border-radius: 10px; border: 1px solid var(--border); }
          .pagination { display: flex; gap: 6px; flex-wrap: wrap; }
          .pagination .page-btn {
            border: 1px solid var(--border);
            background: #fff;
            padding: 4px 8px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 12px;
          }
          .pagination .page-btn.active {
            border-color: rgba(15,123,108,0.4);
            color: var(--accent);
            font-weight: 700;
          }
          tr.highlight {
            background: rgba(15, 123, 108, 0.12) !important;
          }
          .chart-card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 12px 16px 16px;
            box-shadow: 0 6px 16px rgba(16, 24, 40, 0.08);
          }
          .chart-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 8px;
          }
          .chart-legend {
            display: flex;
            gap: 10px;
            font-size: 12px;
            color: var(--muted);
          }
          .chart-controls { display: flex; gap: 6px; flex-wrap: wrap; }
          .legend-item { display: inline-flex; align-items: center; gap: 6px; }
          .legend-dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
          .cookie-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
          .cookie-box { border: 1px solid var(--border); border-radius: 14px; padding: 12px; background: #fff; }
          .cookie-box h4 { margin: 0 0 6px; font-size: 13px; color: var(--muted); }
          .cookie-box .value { font-size: 16px; font-weight: 600; }
          .cookie-text { width: 100%; min-height: 180px; border: 1px solid var(--border); border-radius: 12px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 12px; }
          .cookie-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
          .proxy-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
          .proxy-box { border: 1px solid var(--border); border-radius: 14px; padding: 12px; background: #fff; }
          .proxy-box h4 { margin: 0 0 6px; font-size: 13px; color: var(--muted); }
          .proxy-box .value { font-size: 16px; font-weight: 600; word-break: break-all; }
          .proxy-text { width: 100%; min-height: 120px; border: 1px solid var(--border); border-radius: 12px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 12px; }
          .proxy-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
          @media (max-width: 640px) {
            header, .container { padding: 20px; }
            h1 { font-size: 22px; }
          }
        </style>
      </head>
      <body>
          <header>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
              <div>
                <h1 data-i18n="title">Admin Panel</h1>
                <div class="meta" id="meta" data-i18n="loading">Загрузка…</div>
              </div>
              <div class="actions">
                <select class="btn" id="lang-select">
                  <option value="ru">RUS</option>
                  <option value="en">ENG</option>
                </select>
                <button class="btn" id="logout-btn" data-i18n="logout">Выйти</button>
              </div>
            </div>
          </header>
        <div class="container">
          <div class="tabs">
            <button class="tab-btn active" data-tab="stats" data-i18n="tabStats">Статистика</button>
            <button class="tab-btn" data-tab="users" data-i18n="tabUsers">Пользователи</button>
            <button class="tab-btn" data-tab="links" data-i18n="tabLinks">История загрузок</button>
            <button class="tab-btn" data-tab="errors" data-i18n="tabErrors">Ошибки</button>
            <button class="tab-btn" data-tab="cookies" data-i18n="tabCookies">Куки</button>
            <button class="tab-btn" data-tab="proxy" data-i18n="tabProxy">Прокси</button>
          </div>

          <section class="panel active" id="panel-stats">
            <div class="cards" id="stats-cards"></div>
            <div class="cards" id="system-cards" style="margin-top:12px;"></div>
            <div class="chart-card" style="margin-top:12px;">
              <div class="chart-header">
                <strong data-i18n="chartTitle">Server load</strong>
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                  <div class="chart-controls">
                    <button class="btn" data-range="1" data-i18n="range1h">1ч</button>
                    <button class="btn" data-range="6" data-i18n="range6h">6ч</button>
                    <button class="btn" data-range="24" data-i18n="range24h">24ч</button>
                    <button class="btn" data-range="168" data-i18n="range7d">7д</button>
                  </div>
                  <div class="chart-legend">
                    <span class="legend-item"><span class="legend-dot" style="background:#0f7b6c;"></span><span data-i18n="chartLoad">Load 1m</span></span>
                    <span class="legend-item"><span class="legend-dot" style="background:#f39c12;"></span><span data-i18n="chartMem">Memory %</span></span>
                  </div>
                </div>
              </div>
              <canvas id="load-chart" height="120"></canvas>
            </div>
            <div class="actions" style="margin:14px 0 8px;">
              <div class="pager">
                <label data-i18n="rows">Rows:</label>
                <select id="perpage-activity">
                  <option value="10">10</option>
                  <option value="20">20</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
                <div class="pagination" id="pagination-activity"></div>
              </div>
            </div>
            <div class="table-wrap" style="margin-top:16px;">
              <table>
                <thead>
                  <tr>
                    <th style="width:60px;">#</th>
                    <th style="width:120px;" data-table="activity" data-sort="userId" data-type="number" data-i18n="colUser">User</th>
                    <th style="width:120px;" data-table="activity" data-sort="state" data-i18n="colState">State</th>
                    <th style="width:70%;" data-table="activity" data-sort="url" data-i18n="colUrl">URL</th>
                  </tr>
                </thead>
                <tbody id="activity-body"></tbody>
              </table>
            </div>
          </section>

          <section class="panel" id="panel-users">
            <div class="actions" style="margin-bottom:10px;">
              <input class="search" id="user-search" data-i18n-placeholder="searchUsers" placeholder="Поиск по имени, username или id" />
              <div class="pager">
                <label data-i18n="rows">Rows:</label>
                <select id="perpage-users">
                  <option value="10">10</option>
                  <option value="20">20</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
                <div class="pagination" id="pagination-users"></div>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style="width:60px;">#</th>
                    <th style="width:22%;" data-table="users" data-sort="label" data-i18n="colUser">User</th>
                    <th style="width:16%;" data-table="users" data-sort="username" data-i18n="colUsername">Username</th>
                    <th style="width:110px;" data-table="users" data-sort="id" data-type="number" data-i18n="colId">ID</th>
                    <th style="width:110px;" data-table="users" data-sort="requests" data-type="number" data-i18n="colRequests">Requests</th>
                    <th style="width:120px;" data-table="users" data-sort="downloads" data-type="number" data-i18n="colDownloads">Downloads</th>
                    <th style="width:160px;" data-table="users" data-sort="lastSeen" data-type="date" data-i18n="colLastSeen">Last seen</th>
                    <th style="width:90px;" data-table="users" data-sort="banned" data-type="boolean" data-i18n="colStatus">Status</th>
                    <th style="width:220px;" data-i18n="colActions">Actions</th>
                  </tr>
                </thead>
                <tbody id="users-body"></tbody>
              </table>
            </div>
          </section>

          <section class="panel" id="panel-links">
            <div class="actions" style="margin-bottom:10px;">
              <input class="search" id="links-user-id" data-i18n-placeholder="userIdOptional" placeholder="User ID (optional)" />
              <button class="btn primary" id="load-links" data-i18n="show">Показать</button>
              <div class="pager">
                <label data-i18n="rows">Rows:</label>
                <select id="perpage-links">
                  <option value="10">10</option>
                  <option value="20">20</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
                <div class="pagination" id="pagination-links"></div>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style="width:60px;">#</th>
                    <th style="width:160px;" data-table="links" data-sort="at" data-type="date" data-i18n="colTime">Time</th>
                    <th style="width:120px;" data-table="links" data-sort="userId" data-type="number" data-i18n="colUser">User</th>
                    <th style="width:120px;" data-table="links" data-sort="status" data-i18n="colStatus">Status</th>
                    <th style="width:40%;" data-table="links" data-sort="url" data-i18n="colUrl">URL</th>
                    <th style="width:25%;" data-table="links" data-sort="error" data-i18n="colError">Error</th>
                  </tr>
                </thead>
                <tbody id="links-body"></tbody>
              </table>
            </div>
          </section>

          <section class="panel" id="panel-errors">
            <div class="actions" style="margin-bottom:10px;">
              <div class="pager">
                <label data-i18n="rows">Rows:</label>
                <select id="perpage-errors">
                  <option value="10">10</option>
                  <option value="20">20</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
                <div class="pagination" id="pagination-errors"></div>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style="width:60px;">#</th>
                    <th style="width:160px;" data-table="errors" data-sort="at" data-type="date" data-i18n="colTime">Time</th>
                    <th style="width:120px;" data-table="errors" data-sort="userId" data-type="number" data-i18n="colUser">User</th>
                    <th style="width:25%;" data-table="errors" data-sort="context" data-i18n="colContext">Context</th>
                    <th style="width:20%;" data-table="errors" data-sort="url" data-i18n="colUrl">URL</th>
                    <th style="width:25%;" data-table="errors" data-sort="error" data-i18n="colError">Error</th>
                    <th style="width:10%;" data-i18n="colCopy">Copy</th>
                  </tr>
                </thead>
                <tbody id="errors-body"></tbody>
              </table>
            </div>
          </section>

          <section class="panel" id="panel-cookies">
            <div class="actions" style="margin-bottom:10px;">
              <div class="cookie-row">
                <button class="btn primary" id="cookies-load" data-i18n="btnLoad">Показать</button>
                <button class="btn" id="cookies-append" data-i18n="btnAppend">Догрузить</button>
                <button class="btn" id="cookies-replace" data-i18n="btnReplace">Заменить</button>
                <button class="btn" id="cookies-delete" data-i18n="btnDelete">Удалить</button>
              </div>
            </div>
            <div class="cookie-grid" id="cookies-stats"></div>
            <div style="margin-top:12px;">
              <textarea class="cookie-text" id="cookies-content" data-i18n-placeholder="cookiePlaceholder" placeholder="Paste cookies here..."></textarea>
              <div class="meta" id="cookies-example" style="margin-top:8px;"></div>
            </div>
          </section>

          <section class="panel" id="panel-proxy">
            <div class="actions" style="margin-bottom:10px;">
              <div class="proxy-row">
                <button class="btn primary" id="proxy-load" data-i18n="btnLoad">Показать</button>
                <button class="btn" id="proxy-save" data-i18n="btnSave">Сохранить</button>
                <button class="btn" id="proxy-clear" data-i18n="btnDisable">Отключить</button>
              </div>
            </div>
            <div class="proxy-grid" id="proxy-stats"></div>
            <div style="margin-top:12px;">
              <textarea class="proxy-text" id="proxy-value" data-i18n-placeholder="proxyPlaceholder" placeholder="socks5://user:pass@host:port"></textarea>
            </div>
          </section>
        </div>

        <script>
          const byId = (id) => document.getElementById(id);
          const meta = byId('meta');
          const tabs = document.querySelectorAll('.tab-btn');
          const panels = {
            stats: byId('panel-stats'),
            users: byId('panel-users'),
            links: byId('panel-links'),
            errors: byId('panel-errors'),
            cookies: byId('panel-cookies'),
            proxy: byId('panel-proxy'),
          };
          tabs.forEach(btn => btn.addEventListener('click', () => {
            tabs.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            Object.values(panels).forEach(p => p.classList.remove('active'));
            panels[btn.dataset.tab].classList.add('active');
            if (btn.dataset.tab === 'links') {
              const value = byId('links-user-id').value.trim();
              loadLinks(value);
            }
            if (btn.dataset.tab === 'cookies') {
              loadCookies(false);
            }
            if (btn.dataset.tab === 'proxy') {
              loadProxy();
            }
          }));

          const fmtTime = (iso) => {
            if (!iso) return '—';
            const d = new Date(iso);
            const pad = (v) => String(v).padStart(2, '0');
            const dd = pad(d.getDate());
            const month = pad(d.getMonth() + 1);
            const yyyy = d.getFullYear();
            const hh = pad(d.getHours());
            const mm = pad(d.getMinutes());
            return dd + '-' + month + '-' + yyyy + '-' + hh + '-' + mm;
          };
          const fmtBytes = (value) => {
            if (!Number.isFinite(value)) return '—';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let v = value;
            let idx = 0;
            while (v >= 1024 && idx < units.length - 1) {
              v /= 1024;
              idx++;
            }
            return v.toFixed(1) + ' ' + units[idx];
          };
          const fmtUptime = (seconds) => {
            if (!Number.isFinite(seconds)) return '—';
            const s = Math.floor(seconds);
            const days = Math.floor(s / 86400);
            const hours = Math.floor((s % 86400) / 3600);
            const mins = Math.floor((s % 3600) / 60);
            return (days ? days + 'd ' : '') + hours + 'h ' + mins + 'm';
          };
          const escapeHtml = (val) => String(val ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const truncateText = (val, maxLen) => {
            const text = String(val ?? '');
            if (text.length <= maxLen) return text;
            return text.slice(0, maxLen) + '…';
          };
          const state = { users: [], links: [], errors: [], activity: [] };
          const sortState = {};
          const pageState = {
            users: { page: 1, perPage: 10 },
            links: { page: 1, perPage: 10 },
            errors: { page: 1, perPage: 10 },
            activity: { page: 1, perPage: 10 },
          };
          const chartState = {
            load: [],
            mem: [],
            maxPoints: 240,
          };
          let historyHours = 24;
          const i18n = {
            ru: {
              title: 'Admin Panel',
              loading: 'Загрузка…',
              logout: 'Выйти',
              tabStats: 'Статистика',
              tabUsers: 'Пользователи',
              tabLinks: 'История загрузок',
              tabErrors: 'Ошибки',
              tabCookies: 'Куки',
              tabProxy: 'Прокси',
              rows: 'Строк:',
              chartTitle: 'Загрузка сервера',
              chartLoad: 'Нагрузка 1м',
              chartMem: 'Память %',
              range1h: '1ч',
              range6h: '6ч',
              range24h: '24ч',
              range7d: '7д',
              colUser: 'Пользователь',
              colUsername: 'Username',
              colId: 'ID',
              colRequests: 'Запросы',
              colDownloads: 'Загрузки',
              colLastSeen: 'Последняя активность',
              colStatus: 'Статус',
              colActions: 'Действия',
              colTime: 'Время',
              colUrl: 'Ссылка',
              colError: 'Ошибка',
              colContext: 'Контекст',
              colCopy: 'Копия',
              colState: 'Состояние',
              cookieExists: 'Файл',
              cookieSize: 'Размер',
              cookieUpdated: 'Обновлено',
              cookieTotal: 'Всего',
              cookieExpired: 'Просрочены',
              cookieSession: 'Сессионные',
              cookieEarliest: 'Ближайшее истечение',
              cookieLatest: 'Самое дальнее истечение',
              cookieExample: 'Пример формата:',
              cookiePlaceholder: 'Вставьте cookies сюда...',
              proxyActive: 'Активный',
              proxySource: 'Источник',
              proxyFile: 'Файл',
              proxyEnv: 'Переменная',
              proxyNone: 'Нет',
              proxyUpdated: 'Обновлено',
              proxySize: 'Размер',
              proxyPlaceholder: 'socks5://user:pass@host:port',
              show: 'Показать',
              btnLoad: 'Показать',
              btnAppend: 'Догрузить',
              btnReplace: 'Заменить',
              btnDelete: 'Удалить',
              btnSave: 'Сохранить',
              btnDisable: 'Отключить',
              msgEmptyContent: 'Пустой текст',
              confirmDeleteCookies: 'Удалить файл cookies?',
              searchUsers: 'Поиск по имени, username или id',
              userIdOptional: 'User ID (необязательно)',
              statusOk: 'OK',
              statusBanned: 'BANNED',
              statusMissing: 'Нет',
              btnBan: 'Бан',
              btnUnban: 'Разбан',
              btnLinks: 'Ссылки',
              btnCancel: 'Освободить',
              btnCopy: 'Копировать',
              btnCopied: 'Скопировано',
              emptyLinks: 'Нет данных',
              emptyErrors: 'Нет данных',
              emptyActivity: 'Нет активных задач',
              promptReason: 'Причина (необязательно):',
              cardUsers: 'Пользователи',
              cardBanned: 'Заблокированы',
              cardActive24: 'Активны 24ч',
              cardActive7: 'Активны 7д',
              cardActive30: 'Активны 30д',
              cardRequests: 'Запросы',
              cardDownloads: 'Загрузки',
              cardQueuePending: 'Очередь (ожид.)',
              cardQueueActive: 'Очередь (в работе)',
              cardActiveJobs: 'Активные задачи',
              cardActiveUsers: 'Активные пользователи',
              sysLoad1: 'Нагрузка 1м',
              sysLoad5: 'Нагрузка 5м',
              sysLoad15: 'Нагрузка 15м',
              sysMemUsed: 'Память (исп.)',
              sysMemFree: 'Память (своб.)',
              sysMemTotal: 'Память (всего)',
              sysUptime: 'Аптайм',
              sysRss: 'RSS процесса',
            },
            en: {
              title: 'Admin Panel',
              loading: 'Loading…',
              logout: 'Logout',
              tabStats: 'Stats',
              tabUsers: 'Users',
              tabLinks: 'Download history',
              tabErrors: 'Errors',
              tabCookies: 'Cookies',
              tabProxy: 'Proxy',
              rows: 'Rows:',
              chartTitle: 'Server load',
              chartLoad: 'Load 1m',
              chartMem: 'Memory %',
              range1h: '1h',
              range6h: '6h',
              range24h: '24h',
              range7d: '7d',
              colUser: 'User',
              colUsername: 'Username',
              colId: 'ID',
              colRequests: 'Requests',
              colDownloads: 'Downloads',
              colLastSeen: 'Last seen',
              colStatus: 'Status',
              colActions: 'Actions',
              colTime: 'Time',
              colUrl: 'URL',
              colError: 'Error',
              colContext: 'Context',
              colCopy: 'Copy',
              colState: 'State',
              cookieExists: 'File',
              cookieSize: 'Size',
              cookieUpdated: 'Updated',
              cookieTotal: 'Total',
              cookieExpired: 'Expired',
              cookieSession: 'Session',
              cookieEarliest: 'Earliest expiry',
              cookieLatest: 'Latest expiry',
              cookieExample: 'Format example:',
              cookiePlaceholder: 'Paste cookies here...',
              proxyActive: 'Active',
              proxySource: 'Source',
              proxyFile: 'File',
              proxyEnv: 'Env',
              proxyNone: 'None',
              proxyUpdated: 'Updated',
              proxySize: 'Size',
              proxyPlaceholder: 'socks5://user:pass@host:port',
              show: 'Show',
              btnLoad: 'Load',
              btnAppend: 'Append',
              btnReplace: 'Replace',
              btnDelete: 'Delete',
              btnSave: 'Save',
              btnDisable: 'Disable',
              msgEmptyContent: 'Empty content',
              confirmDeleteCookies: 'Delete cookies file?',
              searchUsers: 'Search by name, username or id',
              userIdOptional: 'User ID (optional)',
              statusOk: 'OK',
              statusBanned: 'BANNED',
              statusMissing: 'Missing',
              btnBan: 'Ban',
              btnUnban: 'Unban',
              btnLinks: 'Links',
              btnCancel: 'Cancel',
              btnCopy: 'Copy',
              btnCopied: 'Copied',
              emptyLinks: 'No data',
              emptyErrors: 'No data',
              emptyActivity: 'No active jobs',
              promptReason: 'Reason (optional):',
              cardUsers: 'Users',
              cardBanned: 'Banned',
              cardActive24: 'Active 24h',
              cardActive7: 'Active 7d',
              cardActive30: 'Active 30d',
              cardRequests: 'Requests',
              cardDownloads: 'Downloads',
              cardQueuePending: 'Queue pending',
              cardQueueActive: 'Queue active',
              cardActiveJobs: 'Active jobs',
              cardActiveUsers: 'Active users',
              sysLoad1: 'Load 1m',
              sysLoad5: 'Load 5m',
              sysLoad15: 'Load 15m',
              sysMemUsed: 'Memory used',
              sysMemFree: 'Memory free',
              sysMemTotal: 'Memory total',
              sysUptime: 'Uptime',
              sysRss: 'Process RSS',
            },
          };
          let lang = 'ru';

          const getValue = (row, key) => row?.[key];
          const sortList = (list, key, type, dir) => {
            const sign = dir === 'desc' ? -1 : 1;
            return [...list].sort((a, b) => {
              const av = getValue(a, key);
              const bv = getValue(b, key);
              if (type === 'number') return sign * ((Number(av) || 0) - (Number(bv) || 0));
              if (type === 'date') return sign * ((Date.parse(av || '') || 0) - (Date.parse(bv || '') || 0));
              if (type === 'boolean') return sign * ((av ? 1 : 0) - (bv ? 1 : 0));
              return sign * String(av ?? '').localeCompare(String(bv ?? ''), 'ru');
            });
          };

          const paginate = (list, table) => {
            const { page, perPage } = pageState[table];
            const total = list.length;
            const pages = Math.max(1, Math.ceil(total / perPage));
            const safePage = Math.min(Math.max(1, page), pages);
            const start = (safePage - 1) * perPage;
            const slice = list.slice(start, start + perPage);
            pageState[table].page = safePage;
            return { slice, total, pages, page: safePage };
          };

          const renderPagination = (table, pages, page) => {
            const container = byId('pagination-' + table);
            if (!container) return;
            if (pages <= 1) {
              container.innerHTML = '';
              return;
            }
            const buttons = [];
            const makeBtn = (label, p, active=false) =>
              '<button class=\"page-btn'+(active?' active':'')+'\" data-table=\"'+table+'\" data-page=\"'+p+'\">'+label+'</button>';
            buttons.push(makeBtn('«', 1));
            buttons.push(makeBtn('‹', Math.max(1, page - 1)));
            const start = Math.max(1, page - 2);
            const end = Math.min(pages, page + 2);
            for (let p = start; p <= end; p++) {
              buttons.push(makeBtn(String(p), p, p === page));
            }
            buttons.push(makeBtn('›', Math.min(pages, page + 1)));
            buttons.push(makeBtn('»', pages));
            container.innerHTML = buttons.join('');
          };

          const t = (key) => (i18n[lang] && i18n[lang][key]) || key;
          const applyI18n = () => {
            document.querySelectorAll('[data-i18n]').forEach(el => {
              const key = el.getAttribute('data-i18n');
              if (key) el.textContent = t(key);
            });
            document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
              const key = el.getAttribute('data-i18n-placeholder');
              if (key) el.setAttribute('placeholder', t(key));
            });
          };

          let selectedUserId = null;

          const renderUsers = (list) => {
            const { slice, pages, page } = paginate(list, 'users');
            renderPagination('users', pages, page);
            byId('users-body').innerHTML = slice.map((u, i) => {
              const statusLabel = u.banned ? t('statusBanned') : t('statusOk');
              const isSelected = selectedUserId && Number(selectedUserId) === Number(u.id);
              return '<tr>' +
                '<td>'+((page - 1) * pageState.users.perPage + i + 1)+'</td>' +
                '<td>'+escapeHtml(u.label)+'</td>' +
                '<td>'+(u.username ? '@'+escapeHtml(u.username) : '—')+'</td>' +
                '<td>'+u.id+'</td>' +
                '<td>'+u.requests+'</td>' +
                '<td>'+u.downloads+'</td>' +
                '<td>'+fmtTime(u.lastSeen)+'</td>' +
                '<td>'+statusLabel+'</td>' +
                '<td>' +
                  '<div class=\"actions\">' +
                    (u.banned
                      ? '<button class=\"btn primary\" data-action=\"unban\" data-id=\"'+u.id+'\">'+t('btnUnban')+'</button>'
                      : '<button class=\"btn danger\" data-action=\"ban\" data-id=\"'+u.id+'\">'+t('btnBan')+'</button>') +
                    '<button class=\"btn\" data-action=\"links\" data-id=\"'+u.id+'\">'+t('btnLinks')+'</button>' +
                    '<button class=\"btn\" data-action=\"cancel\" data-id=\"'+u.id+'\">'+t('btnCancel')+'</button>' +
                  '</div>' +
                '</td>' +
                '</tr>';
            }).join('');
            if (selectedUserId) {
              const rows = byId('users-body').querySelectorAll('tr');
              rows.forEach((row, idx) => {
                const item = slice[idx];
                if (item && Number(item.id) === Number(selectedUserId)) {
                  row.classList.add('highlight');
                }
              });
            }
          };

          const renderLinks = (list) => {
            const { slice, pages, page } = paginate(list, 'links');
            renderPagination('links', pages, page);
            byId('links-body').innerHTML = slice.map((l, i) => (
              '<tr>' +
                '<td>'+((page - 1) * pageState.links.perPage + i + 1)+'</td>' +
                '<td>'+fmtTime(l.at)+'</td>' +
                '<td>'+(l.userId ? '<button class=\"btn\" data-action=\"view-user\" data-id=\"'+l.userId+'\">'+l.userId+'</button>' : '—')+'</td>' +
                '<td>'+escapeHtml(l.status)+'</td>' +
                '<td>'+escapeHtml(l.url)+'</td>' +
                '<td>'+escapeHtml(l.error || '—')+'</td>' +
              '</tr>'
            )).join('') || '<tr><td colspan=\"6\">'+t('emptyLinks')+'</td></tr>';
          };

          const renderErrors = (list) => {
            const { slice, pages, page } = paginate(list, 'errors');
            renderPagination('errors', pages, page);
            byId('errors-body').innerHTML = slice.map((e, i) => (
              (() => {
                const rawError = e.error || '';
                const encodedError = encodeURIComponent(rawError);
                const preview = truncateText(rawError || '—', 200);
                const copyBtn = rawError
                  ? '<button class=\"btn\" data-action=\"copy-error\" data-error=\"' + encodedError + '\">' + t('btnCopy') + '</button>'
                  : '—';
                return (
              '<tr>' +
                '<td>'+((page - 1) * pageState.errors.perPage + i + 1)+'</td>' +
                '<td>'+fmtTime(e.at)+'</td>' +
                '<td>'+(e.userId ?? '—')+'</td>' +
                '<td>'+escapeHtml(e.context || '—')+'</td>' +
                '<td>'+escapeHtml(e.url || '—')+'</td>' +
                '<td>'+escapeHtml(preview)+'</td>' +
                '<td>'+copyBtn+'</td>' +
              '</tr>'
                );
              })()
            )).join('') || '<tr><td colspan=\"7\">'+t('emptyErrors')+'</td></tr>';
          };

          const renderActivity = (list) => {
            const { slice, pages, page } = paginate(list, 'activity');
            renderPagination('activity', pages, page);
            byId('activity-body').innerHTML = slice.map((j, i) => (
              '<tr>' +
                '<td>'+((page - 1) * pageState.activity.perPage + i + 1)+'</td>' +
                '<td>'+j.userId+'</td>' +
                '<td>'+escapeHtml(j.state)+'</td>' +
                '<td>'+escapeHtml(j.url)+'</td>' +
              '</tr>'
            )).join('') || '<tr><td colspan=\"4\">'+t('emptyActivity')+'</td></tr>';
          };

          async function loadStats() {
            const res = await fetch('/admin/stats.json');
            const data = await res.json();
            meta.textContent = 'Обновлено: ' + fmtTime(data.generatedAt);
            const cards = [
              [t('cardUsers'), data.usersTotal],
              [t('cardBanned'), data.bannedTotal],
              [t('cardActive24'), data.active24h],
              [t('cardActive7'), data.active7d],
              [t('cardActive30'), data.active30d],
              [t('cardRequests'), data.requestsTotal],
              [t('cardDownloads'), data.downloadsTotal],
              [t('cardQueuePending'), data.queuePending],
              [t('cardQueueActive'), data.queueActive],
              [t('cardActiveJobs'), data.activeJobs],
              [t('cardActiveUsers'), data.activeUsers],
            ];
            byId('stats-cards').innerHTML = cards.map(([k,v]) => (
              '<div class=\"card\"><h3>'+k+'</h3><div class=\"value\">'+v+'</div></div>'
            )).join('');
          }

          const drawChart = () => {
            const canvas = byId('load-chart');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const width = canvas.clientWidth || canvas.width;
            const height = canvas.height;
            canvas.width = width;
            ctx.clearRect(0, 0, width, height);
            const maxLoad = Math.max(1, ...chartState.load, ...chartState.mem);
            const padding = 10;
            const plotW = width - padding * 2;
            const plotH = height - padding * 2;
            const downsample = (data) => {
              if (data.length <= chartState.maxPoints) return data;
              const step = Math.ceil(data.length / chartState.maxPoints);
              const sampled = [];
              for (let i = 0; i < data.length; i += step) {
                sampled.push(data[i]);
              }
              return sampled;
            };
            const drawLine = (dataRaw, color) => {
              const data = downsample(dataRaw);
              if (!data.length) return;
              ctx.beginPath();
              data.forEach((val, i) => {
                const x = padding + (i / Math.max(1, data.length - 1)) * plotW;
                const y = padding + plotH - (val / maxLoad) * plotH;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
              });
              ctx.strokeStyle = color;
              ctx.lineWidth = 2;
              ctx.stroke();
            };
            drawLine(chartState.load, '#0f7b6c');
            drawLine(chartState.mem, '#f39c12');
          };

          async function loadSystem() {
            const res = await fetch('/admin/system.json');
            const data = await res.json();
            const cards = [
              [t('sysLoad1'), (data.load1 ?? 0).toFixed(2)],
              [t('sysLoad5'), (data.load5 ?? 0).toFixed(2)],
              [t('sysLoad15'), (data.load15 ?? 0).toFixed(2)],
              [t('sysMemUsed'), fmtBytes(data.memoryUsed)],
              [t('sysMemFree'), fmtBytes(data.memoryFree)],
              [t('sysMemTotal'), fmtBytes(data.memoryTotal)],
              [t('sysUptime'), fmtUptime(data.uptime)],
              [t('sysRss'), fmtBytes(data.processRss)],
            ];
            byId('system-cards').innerHTML = cards.map(([k,v]) => (
              '<div class=\"card\"><h3>'+k+'</h3><div class=\"value\">'+v+'</div></div>'
            )).join('');
          }

          async function loadSystemHistory() {
            const res = await fetch('/admin/system-history.json?hours=' + historyHours);
            const data = await res.json();
            const samples = data.samples || [];
            chartState.load = samples.map(s => s.load1 ?? 0);
            chartState.mem = samples.map(s => s.memPercent ?? 0);
            drawChart();
          }

          async function loadUsers() {
            const res = await fetch('/admin/users.json');
            const data = await res.json();
            const list = data.users || [];
            state.users = list;
            renderUsers(list);
            const search = byId('user-search');
            search.oninput = () => {
              const q = search.value.trim().toLowerCase();
              if (!q) return renderUsers(state.users);
              renderUsers(state.users.filter(u => (
                String(u.id).includes(q) ||
                (u.label || '').toLowerCase().includes(q) ||
                (u.username || '').toLowerCase().includes(q)
              )));
            };
          }

          async function loadErrors() {
            const res = await fetch('/admin/errors.json');
            const data = await res.json();
            const list = data.errors || [];
            state.errors = list;
            renderErrors(list);
          }

          const renderProxyStats = (payload) => {
            const sourceLabel = payload?.source === 'file'
              ? t('proxyFile')
              : payload?.source === 'env'
                ? t('proxyEnv')
                : t('proxyNone');
            const cards = [
              [t('proxyActive'), payload?.active || '—'],
              [t('proxySource'), sourceLabel],
              [t('proxyUpdated'), payload?.fileMeta?.updatedAt ? fmtTime(payload.fileMeta.updatedAt) : '—'],
              [t('proxySize'), payload?.fileMeta?.size ? fmtBytes(payload.fileMeta.size) : '—'],
            ];
            byId('proxy-stats').innerHTML = cards.map(([k, v]) => (
              '<div class=\"proxy-box\"><h4>'+k+'</h4><div class=\"value\">'+escapeHtml(v)+'</div></div>'
            )).join('');
            byId('proxy-value').value = payload?.fileValue || payload?.active || '';
          };

          async function loadProxy() {
            const res = await fetch('/admin/proxy.json');
            const data = await res.json();
            renderProxyStats(data);
          }

          const renderCookieStats = (payload) => {
            const stats = payload?.stats || {};
            const exists = Boolean(payload?.exists);
            const cards = [
              [t('cookieExists'), exists ? t('statusOk') : t('statusMissing')],
              [t('cookieSize'), exists ? fmtBytes(payload.size) : '—'],
              [t('cookieUpdated'), exists ? fmtTime(payload.updatedAt) : '—'],
              [t('cookieTotal'), Number.isFinite(stats.total) ? stats.total : '—'],
              [t('cookieExpired'), Number.isFinite(stats.expired) ? stats.expired : '—'],
              [t('cookieSession'), Number.isFinite(stats.session) ? stats.session : '—'],
              [t('cookieEarliest'), stats.earliestExpiry ? fmtTime(stats.earliestExpiry) : '—'],
              [t('cookieLatest'), stats.latestExpiry ? fmtTime(stats.latestExpiry) : '—'],
            ];
            byId('cookies-stats').innerHTML = cards.map(([k, v]) => (
              '<div class=\"cookie-box\"><h4>'+k+'</h4><div class=\"value\">'+v+'</div></div>'
            )).join('');
            if (payload?.example) {
              byId('cookies-example').textContent = t('cookieExample') + ' ' + payload.example;
            }
          };

          async function loadCookies(withContent) {
            const url = '/admin/cookies.json' + (withContent ? '?content=1' : '');
            const res = await fetch(url);
            const data = await res.json();
            renderCookieStats(data);
            if (withContent && typeof data.content === 'string') {
              byId('cookies-content').value = data.content;
            }
          }

          async function loadActivity() {
            const res = await fetch('/admin/activity.json');
            const data = await res.json();
            const list = data.jobs || [];
            state.activity = list;
            renderActivity(list);
          }

          async function loadLinks(userId) {
            const url = userId
              ? '/admin/users/' + userId + '/links.json'
              : '/admin/links.json';
            const res = await fetch(url);
            const data = await res.json();
            const list = data.links || [];
            state.links = list;
            renderLinks(list);
          }

          function attachSortHandlers() {
            document.querySelectorAll('th[data-sort]').forEach(th => {
              th.style.cursor = 'pointer';
              th.addEventListener('click', () => {
                const table = th.dataset.table;
                const key = th.dataset.sort;
                const type = th.dataset.type || 'text';
                if (!table || !key) return;
                const current = sortState[table] || { key: null, dir: 'asc' };
                const dir = current.key === key && current.dir === 'asc' ? 'desc' : 'asc';
                sortState[table] = { key, dir };
                const sorted = sortList(state[table] || [], key, type, dir);
                pageState[table].page = 1;
                if (table === 'users') renderUsers(sorted);
                if (table === 'links') renderLinks(sorted);
                if (table === 'errors') renderErrors(sorted);
                if (table === 'activity') renderActivity(sorted);
              });
            });
          }

          async function postAction(id, action) {
            await fetch('/admin/users/' + id + '/' + action, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
            await loadUsers();
          }

          byId('load-links').addEventListener('click', async () => {
            const value = byId('links-user-id').value.trim();
            pageState.links.page = 1;
            await loadLinks(value);
          });

          byId('users-body').addEventListener('click', async (event) => {
            const btn = event.target.closest('button');
            if (!btn) return;
            const id = btn.dataset.id;
            const action = btn.dataset.action;
            if (!id || !action) return;
            if (action === 'links') {
              byId('links-user-id').value = id;
              pageState.links.page = 1;
              await loadLinks(id);
              tabs.forEach(b => b.classList.remove('active'));
              document.querySelector('[data-tab=\"links\"]').classList.add('active');
              Object.values(panels).forEach(p => p.classList.remove('active'));
              panels.links.classList.add('active');
              return;
            }
            if (action === 'ban') {
              const reason = prompt(t('promptReason')) || '';
              await fetch('/admin/users/' + id + '/ban', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
              });
              await loadUsers();
              return;
            }
            if (action === 'unban' || action === 'cancel') {
              await postAction(id, action);
            }
          });

          byId('links-body').addEventListener('click', async (event) => {
            const btn = event.target.closest('button');
            if (!btn) return;
            const action = btn.dataset.action;
            const id = btn.dataset.id;
            if (action !== 'view-user' || !id) return;
            selectedUserId = id;
            const item = state.users.find(u => String(u.id) === String(id));
            if (item) {
              const idx = state.users.indexOf(item);
              pageState.users.page = Math.floor(idx / pageState.users.perPage) + 1;
            }
            tabs.forEach(b => b.classList.remove('active'));
            document.querySelector('[data-tab=\"users\"]').classList.add('active');
            Object.values(panels).forEach(p => p.classList.remove('active'));
            panels.users.classList.add('active');
            renderUsers(state.users);
          });

          byId('cookies-load').addEventListener('click', async () => {
            await loadCookies(true);
          });

          byId('cookies-append').addEventListener('click', async () => {
            const content = byId('cookies-content').value || '';
            if (!content.trim()) {
              alert(t('msgEmptyContent'));
              return;
            }
            await fetch('/admin/cookies.json', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode: 'append', content }),
            });
            await loadCookies(true);
          });

          byId('cookies-replace').addEventListener('click', async () => {
            const content = byId('cookies-content').value || '';
            if (!content.trim()) {
              alert(t('msgEmptyContent'));
              return;
            }
            await fetch('/admin/cookies.json', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode: 'replace', content }),
            });
            await loadCookies(true);
          });

          byId('cookies-delete').addEventListener('click', async () => {
            if (!confirm(t('confirmDeleteCookies'))) return;
            await fetch('/admin/cookies/delete', { method: 'POST' });
            byId('cookies-content').value = '';
            await loadCookies(false);
          });

          byId('proxy-load').addEventListener('click', async () => {
            await loadProxy();
          });

          byId('proxy-save').addEventListener('click', async () => {
            const value = byId('proxy-value').value || '';
            await fetch('/admin/proxy.json', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value }),
            });
            await loadProxy();
          });

          byId('proxy-clear').addEventListener('click', async () => {
            await fetch('/admin/proxy/delete', { method: 'POST' });
            await loadProxy();
          });

          byId('errors-body').addEventListener('click', async (event) => {
            const btn = event.target.closest('button');
            if (!btn) return;
            if (btn.dataset.action !== 'copy-error') return;
            const raw = btn.dataset.error || '';
            const text = decodeURIComponent(raw);
            if (!text) return;
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                const prev = btn.textContent;
                btn.textContent = t('btnCopied');
                setTimeout(() => {
                  btn.textContent = prev || t('btnCopy');
                }, 1200);
              } else {
                prompt('Copy error', text);
              }
            } catch {
              prompt('Copy error', text);
            }
          });

          byId('logout-btn').addEventListener('click', async () => {
            try {
              await fetch('/admin/logout', { credentials: 'include' });
            } catch {}
            window.location.href = '/admin';
          });

          document.querySelectorAll('[data-range]').forEach(btn => {
            btn.addEventListener('click', () => {
              const next = Number(btn.getAttribute('data-range') || '24');
              historyHours = Number.isFinite(next) ? next : 24;
              document.querySelectorAll('[data-range]').forEach(b => b.classList.remove('active'));
              btn.classList.add('active');
              loadSystemHistory();
            });
          });

          byId('lang-select').addEventListener('change', (event) => {
            lang = event.target.value || 'ru';
            applyI18n();
            renderUsers(state.users);
            renderLinks(state.links);
            renderErrors(state.errors);
            renderActivity(state.activity);
            loadStats();
            loadSystem();
            drawChart();
            loadCookies(false);
            loadProxy();
          });

          ['users','links','errors','activity'].forEach(table => {
            const select = byId('perpage-' + table);
            if (!select) return;
            select.value = String(pageState[table].perPage);
            select.addEventListener('change', () => {
              pageState[table].perPage = Number(select.value) || 10;
              pageState[table].page = 1;
              if (table === 'users') renderUsers(state.users);
              if (table === 'links') renderLinks(state.links);
              if (table === 'errors') renderErrors(state.errors);
              if (table === 'activity') renderActivity(state.activity);
            });
          });

          document.addEventListener('click', (event) => {
            const btn = event.target.closest('.page-btn');
            if (!btn) return;
            const table = btn.dataset.table;
            const page = Number(btn.dataset.page);
            if (!table || !page) return;
            pageState[table].page = page;
            if (table === 'users') renderUsers(state.users);
            if (table === 'links') renderLinks(state.links);
            if (table === 'errors') renderErrors(state.errors);
            if (table === 'activity') renderActivity(state.activity);
          });

          loadStats();
          loadSystem();
          loadSystemHistory();
          loadUsers();
          loadErrors();
          loadActivity();
          loadLinks('');
          attachSortHandlers();
          applyI18n();
          const defaultRange = document.querySelector('[data-range=\"24\"]');
          if (defaultRange) defaultRange.classList.add('active');
          setInterval(loadSystem, 5000);
          setInterval(loadSystemHistory, 60000);
        </script>
      </body>
    </html>
  `
	res.setHeader("Content-Type", "text/html; charset=utf-8")
	res.send(html)
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
const taskOptions = new Map<
	number,
	{
		url?: string
		replyToMessageId?: number
		translate?: boolean
		sponsor?: boolean
		sponsorCategories?: string[]
	}
>()

const buildTaskKeyboard = (prefix: string) => {
	return new InlineKeyboard().text("Да", `${prefix}:yes`).text("Нет", `${prefix}:no`)
}

const buildInlineSponsorDecisionKeyboard = (requestId: string) => {
	return new InlineKeyboard()
		.text("Без вырезки", `ds:${requestId}:none`)
		.row()
		.text("Только рекламу", `ds:${requestId}:sponsor`)
		.row()
		.text("Все фрагменты", `ds:${requestId}:all`)
}

const buildSponsorCategoriesKeyboard = () => {
	return new InlineKeyboard()
		.text("Только рекламную часть", "task:sponsor_categories:sponsor")
		.row()
		.text("Все фрагменты", "task:sponsor_categories:all")
}

const scheduleDeleteMessage = (
	message?: { chat: { id: number }; message_id: number },
	delayMs = 20000,
) => {
	if (!message?.chat?.id || !message?.message_id) return
	setTimeout(() => {
		void deleteMessage(message as any)
	}, delayMs)
}

const enqueueTranslateJob = async (
	ctx: any,
	userId: number,
	rawUrl: string,
	externalAudioUrl?: string,
	replyToMessageId?: number,
) => {
	const sourceUrl = normalizeFacebookCdnVideoUrl(normalizeVimeoUrl(rawUrl))
	void logUserLink(userId, sourceUrl, "requested")

	const lockResult = lockUserUrl(userId, sourceUrl)
	if (!lockResult.ok) {
		await ctx.reply("Эта ссылка уже в обработке. Дождитесь завершения.")
		return
	}
	void incrementUserCounter(userId, "requests")
	const lockId = lockResult.lockId
	const processing = await ctx.reply("Ставим перевод в очередь...")
		enqueueJob(userId, sourceUrl, lockId, async (signal) => {
			try {
				await runTranslatedDownload({
					ctx,
					url: sourceUrl,
				sourceUrl,
				statusMessageId: processing.message_id,
				replyToMessageId,
				signal,
					externalAudioUrl,
				})
			} catch (error) {
				if (isTranslationUnsupportedError(error)) {
					if (processing?.message_id) {
						await updateMessage(
							ctx,
							processing.message_id,
							getTranslationUnsupportedMessage(error),
							{ force: true },
						)
					} else {
						await ctx.reply(getTranslationUnsupportedMessage(error))
					}
					return
				}
				console.error("Translate error:", error)
				await logErrorEntry({
					userId,
					url: sourceUrl,
				context: "translate",
				error: error instanceof Error ? error.message : String(error),
			})
			if (processing?.message_id) {
				await updateMessage(ctx, processing.message_id, "Ошибка перевода.")
			}
			if (ctx.chat?.type === "private") {
				await createUserReportPrompt(
					ctx,
					`URL: ${cleanUrl(sourceUrl)}`,
					error instanceof Error ? error.message : "Translation error",
				)
			}
			await notifyAdminError(
				ctx.chat,
				`URL: ${cleanUrl(sourceUrl)}`,
				error instanceof Error ? error.message : "Translation error",
				ctx.from,
				ctx.message,
			)
		}
	})
}

const enqueueTaskJob = async (
	ctx: any,
	userId: number,
	rawUrl: string,
	options: { translate: boolean; sponsor: boolean; sponsorCategories?: string[] },
	replyToMessageId?: number,
) => {
	const sourceUrl = normalizeFacebookCdnVideoUrl(normalizeVimeoUrl(rawUrl))
	let sponsorCutRequested = options.sponsor
	let sponsorCategories = options.sponsorCategories
	if (sponsorCutRequested && !isYouTubeUrl(sourceUrl)) {
		sponsorCutRequested = false
		sponsorCategories = undefined
		await ctx.reply("SponsorBlock доступен только для YouTube. Продолжаем без вырезания.")
	}
	if (sponsorCutRequested && (!sponsorCategories || sponsorCategories.length === 0)) {
		sponsorCategories = SPONSORBLOCK_DEFAULT_CATEGORIES
	}
	void logUserLink(userId, sourceUrl, "requested")
	const lockResult = lockUserUrl(userId, sourceUrl)
	if (!lockResult.ok) {
		await ctx.reply("Эта ссылка уже в обработке. Дождитесь завершения.")
		return
	}
	void incrementUserCounter(userId, "requests")
	const lockId = lockResult.lockId
	const processing = await ctx.reply("Ставим задачу в очередь...")
	scheduleDeleteMessage(processing)
	enqueueJob(userId, sourceUrl, lockId, async (signal) => {
		if (options.translate) {
			try {
				await runTranslatedDownload({
					ctx,
					url: sourceUrl,
					sourceUrl,
					statusMessageId: processing.message_id,
					replyToMessageId,
					signal,
					sponsorCutRequested,
					sponsorCategories,
				})
			} catch (error) {
				if (isTranslationUnsupportedError(error)) {
					if (processing?.message_id) {
						await updateMessage(
							ctx,
							processing.message_id,
							getTranslationUnsupportedMessage(error),
							{ force: true },
						)
					} else {
						await ctx.reply(getTranslationUnsupportedMessage(error))
					}
					return
				}
				console.error("Translate task error:", error)
				await logErrorEntry({
					userId,
					url: sourceUrl,
					context: "task-translate",
					error: error instanceof Error ? error.message : String(error),
				})
				if (processing?.message_id) {
					await updateMessage(ctx, processing.message_id, "Ошибка перевода.")
				}
				if (ctx.chat?.type === "private") {
					await createUserReportPrompt(
						ctx,
						`URL: ${cleanUrl(sourceUrl)}`,
						error instanceof Error ? error.message : "Translation error",
					)
				}
				await notifyAdminError(
					ctx.chat,
					`URL: ${cleanUrl(sourceUrl)}`,
					error instanceof Error ? error.message : "Translation error",
					ctx.from,
					ctx.message,
				)
			}
			return
		}
		await downloadAndSend(
			ctx,
			sourceUrl,
			"b",
			false,
			processing.message_id,
			undefined,
			replyToMessageId,
			signal,
			false,
			undefined,
			false,
			sourceUrl,
			false,
			undefined,
			sponsorCutRequested,
			sponsorCategories,
		)
	})
}

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

bot.command("translate", async (ctx) => {
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
	userState.delete(userId)
	let urls = extractUrlsFromMessage(ctx.message)
	if (urls.length === 0 && ctx.message?.reply_to_message) {
		urls = extractUrlsFromMessage(ctx.message.reply_to_message)
	}
	const externalAudioUrl = urls.find(isYandexVtransUrl)
	const rawUrl = urls.find((item) => !isYandexVtransUrl(item))
	if (!rawUrl) {
		userState.set(userId, "waiting_for_translate_url")
		const prompt = await ctx.reply("Пришлите ссылку на видео для перевода.")
		userPromptMessages.set(userId, { chatId: ctx.chat.id, messageId: prompt.message_id })
		return
	}
	await enqueueTranslateJob(
		ctx,
		userId,
		rawUrl,
		externalAudioUrl,
		ctx.message?.message_id,
	)
})

bot.command("task", async (ctx) => {
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
	userState.delete(userId)
	taskOptions.set(userId, {
		translate: undefined,
		sponsor: undefined,
		sponsorCategories: undefined,
	})
	userState.set(userId, "waiting_for_task_url")
	const prompt = await ctx.reply("Пришлите ссылку на видео.")
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
			const urls = extractMessageUrls(ctx)
			const externalAudioUrl = urls.find(isYandexVtransUrl)
			const rawUrl =
				urls.find((item) => !isYandexVtransUrl(item)) ||
				(urls.length === 0 ? ctx.message.text : undefined)
		if (!rawUrl) {
			await ctx.reply("Invalid URL.")
			return
		}
		const sourceUrl = normalizeFacebookCdnVideoUrl(normalizeVimeoUrl(rawUrl))
		void logUserLink(userId, sourceUrl, "requested")

		const lockResult = lockUserUrl(userId, sourceUrl)
		if (!lockResult.ok) {
			await ctx.reply("Эта ссылка уже в обработке. Дождитесь завершения.")
			return
		}
		void incrementUserCounter(userId, "requests")
		const lockId = lockResult.lockId
		let keepLock = false
		const processing = await ctx.reply("Получаем форматы...")
		try {
			let downloadUrl = normalizeFacebookCdnVideoUrl(normalizeVimeoUrl(rawUrl))
			let bypassTitle: string | undefined
			let expectedFacebookStoryFbid = extractFacebookExpectedStoryFbid(sourceUrl)
			const isFacebookShareReelSource = facebookShareReelMatcher(sourceUrl)
			const resolvedFacebookUrl = await resolveFacebookShareUrl(downloadUrl)
			if (resolvedFacebookUrl !== downloadUrl) {
				console.log(
					`[DEBUG] Resolved Facebook share URL: ${downloadUrl} -> ${resolvedFacebookUrl}`,
				)
				downloadUrl = resolvedFacebookUrl
			}
			if (!expectedFacebookStoryFbid) {
				expectedFacebookStoryFbid = extractFacebookExpectedStoryFbid(downloadUrl)
			}
			if (facebookStoryMatcher(downloadUrl) || facebookShareReelMatcher(downloadUrl)) {
				const storyData = await resolveFacebookStory(downloadUrl)
				if (storyData.video_url) {
					downloadUrl = normalizeFacebookCdnVideoUrl(storyData.video_url)
					bypassTitle = storyData.title || "Facebook Story"
				} else if (storyData.error) {
					console.error("Facebook story error:", storyData.error)
					if (isFacebookTemporaryBlockError(storyData.error)) {
						throw new Error(getFacebookTemporaryBlockMessage())
					}
					// share/r links are often unstable for HTML parsing; let yt-dlp handle them as fallback
					if (facebookStoryMatcher(downloadUrl) && !isFacebookShareReelSource) {
						throw new Error(`Facebook story resolve failed: ${storyData.error}`)
					}
					console.warn(
						`[WARN] Facebook share/reel bypass failed, fallback to yt-dlp: ${storyData.error}`,
					)
				}
			}
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
					await logUserLink(userId, sourceUrl, "success")
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
					await logUserLink(userId, sourceUrl, "success")
					return
				}
			}
			const isBehance = behanceMatcher(downloadUrl)
			if (isBehance) {
				const behanceData = await resolveBehance(downloadUrl)
				if (behanceData.video_url) {
					downloadUrl = behanceData.video_url
					bypassTitle = behanceData.title
				} else if (behanceData.error) {
					console.error("Behance error:", behanceData.error)
				}
			}
			const isCcv = ccvMatcher(downloadUrl)
			if (isCcv) {
				const ccvData = await resolveCcv(downloadUrl)
				if (ccvData.video_url) {
					downloadUrl = ccvData.video_url
				} else if (ccvData.error) {
					console.error("CCV error:", ccvData.error)
				}
			}
			const isPornoxo = pornoxoMatcher(downloadUrl)
			const isPornoxoPage = pornoxoPageMatcher(downloadUrl)
			if (isPornoxoPage) {
				const pornoxoData = await resolvePornoxo(downloadUrl)
				if (pornoxoData.video_url) {
					downloadUrl = pornoxoData.video_url
					bypassTitle = pornoxoData.title
				} else if (pornoxoData.error) {
					console.error("Pornoxo error:", pornoxoData.error)
				}
			}
				const isYouTube = isYouTubeUrl(downloadUrl)
				const cookieArgsList = await cookieArgs()
				const youtubeArgs = isYouTube ? youtubeExtractorArgs : []
				const isTiktok = urlMatcher(downloadUrl, "tiktok.com")
				const isVimeo = isVimeoUrl(downloadUrl)
				const additionalArgs = isTiktok ? tiktokArgs : []
				const proxyArgs = isVimeo || isPornoxo ? [] : await getProxyArgs()
				const vimeoArgs = isVimeo
					? [
							"--sleep-requests",
							"1",
							"--extractor-retries",
							"3",
							"--retry-sleep",
							"15",
							"--extractor-args",
							"vimeo:original_format_policy=never",
						]
					: []
				const refererArgs = shouldAttachReferer(sourceUrl)
					? getRefererHeaderArgs(sourceUrl)
					: []
				const genericFallbacks = shouldTryGenericFallback(sourceUrl)
					? buildGenericFallbacks(sourceUrl)
					: []
				const vimeoCookieAttempts =
					isVimeo && cookieArgsList.length > 0
						? [[], cookieArgsList]
						: [cookieArgsList]
				const fetchInfoOnce = async () => {
					let lastError: unknown
					for (const cookiesOverride of vimeoCookieAttempts) {
						try {
							return await safeGetInfoWithFallback(
								downloadUrl,
								[
									"--dump-json",
									"--no-warnings",
									"--no-playlist",
									...cookiesOverride,
									...additionalArgs,
									...impersonateArgs,
									...youtubeArgs,
									...refererArgs,
									...vimeoArgs,
								],
								undefined,
								false,
								genericFallbacks.map((attempt) => attempt.args),
								proxyArgs,
							)
						} catch (error) {
							lastError = error
							if (isVimeo && cookiesOverride.length === 0 && isAuthError(error)) {
								continue
							}
							throw error
						}
					}
					throw lastError instanceof Error
						? lastError
						: new Error("No valid info")
				}
				const info = await withRateLimitRetry(fetchInfoOnce, isVimeo)
			if (expectedFacebookStoryFbid && typeof info?.webpage_url === "string") {
				const actualFacebookStoryFbid = extractFacebookStoryFbid(info.webpage_url)
				if (
					actualFacebookStoryFbid &&
					actualFacebookStoryFbid !== expectedFacebookStoryFbid
				) {
					throw new Error(
						`Facebook story mismatch: expected story_fbid=${expectedFacebookStoryFbid}, got story_fbid=${actualFacebookStoryFbid}`,
					)
				}
			}

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
				externalAudioUrl,
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
			await logErrorEntry({
				userId,
				url: sourceUrl,
				context: "formats",
				error: error instanceof Error ? error.message : String(error),
			})
			await ctx.reply(
				isFacebookTemporaryBlockError(error)
					? getFacebookTemporaryBlockMessage()
					: "Ошибка.",
			)
		} finally {
			if (!keepLock) {
				unlockUserUrl(userId, sourceUrl, lockId)
			}
			await deleteMessage(processing)
		}
		return
	}
	if (state === "waiting_for_task_url") {
		userState.delete(userId)
		const promptMessage = userPromptMessages.get(userId)
		if (promptMessage) {
			try {
				await ctx.api.deleteMessage(promptMessage.chatId, promptMessage.messageId)
			} catch {}
			userPromptMessages.delete(userId)
		}
		await deletePreviousMenuMessage(ctx)
		const replyToMessageId = ctx.message?.message_id
		await deleteUserMessage(ctx)
		const urls = extractMessageUrls(ctx)
		const rawUrl = urls[0] || ctx.message.text
		if (!rawUrl) {
			await ctx.reply("Invalid URL.")
			return
		}
		const prompt = await ctx.reply("Наложить перевод (Yandex)?", {
			reply_markup: buildTaskKeyboard("task:translate"),
		})
		userPromptMessages.set(userId, { chatId: ctx.chat.id, messageId: prompt.message_id })
		const current = taskOptions.get(userId) ?? {}
		taskOptions.set(userId, {
			...current,
			url: rawUrl,
			replyToMessageId,
			translate: undefined,
			sponsor: undefined,
			sponsorCategories: undefined,
		})
		return
	}
	if (state === "waiting_for_translate_url") {
		userState.delete(userId)
		const promptMessage = userPromptMessages.get(userId)
		if (promptMessage) {
			try {
				await ctx.api.deleteMessage(promptMessage.chatId, promptMessage.messageId)
			} catch {}
			userPromptMessages.delete(userId)
		}
		await deletePreviousMenuMessage(ctx)
		const replyToMessageId = ctx.message?.message_id
		await deleteUserMessage(ctx)
		const urls = extractMessageUrls(ctx)
		const externalAudioUrl = urls.find(isYandexVtransUrl)
		const rawUrl =
			urls.find((item) => !isYandexVtransUrl(item)) ||
			(urls.length === 0 ? ctx.message.text : undefined)
		if (!rawUrl) {
			await ctx.reply("Пришлите ссылку на видео для перевода.")
			return
		}
		await enqueueTranslateJob(ctx, userId, rawUrl, externalAudioUrl, replyToMessageId)
		return
	} else {
		await next()
	}
})

bot.on("my_chat_member", async (ctx) => {
	const status = ctx.myChatMember.new_chat_member.status
	const chatType = ctx.chat?.type
	if (status !== "member" && status !== "administrator") return

	if (chatType === "group" || chatType === "supergroup" || chatType === "channel") {
		try {
			await ctx.api.leaveChat(ctx.chat.id)
		} catch (error) {
			console.error("Failed to leave group:", error)
		}
		return
	}

	if (chatType === "private") {
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

	const urls = extractMessageUrls(ctx)
	if (urls.length === 0) return await next()
	const externalAudioUrl = urls.find(isYandexVtransUrl)
	const primaryUrl = urls.find((item) => !isYandexVtransUrl(item))
	const isPrivate = ctx.chat.type === "private"
	if (!primaryUrl) {
		if (isPrivate) {
			await ctx.reply("Нужна ссылка на видео (и при желании ссылку на перевод).", {
				reply_to_message_id: ctx.message.message_id,
				message_thread_id: ctx.message.message_thread_id,
			})
		}
		return
	}
	const url = { text: primaryUrl }

	console.log(`[DEBUG] Processing URL from ${ctx.chat.id}: ${url.text}`)
	url.text = normalizeVimeoUrl(url.text)
	url.text = normalizeFacebookCdnVideoUrl(url.text)
	const sourceUrl = url.text
	let expectedFacebookStoryFbid = extractFacebookExpectedStoryFbid(sourceUrl)
	if (!isFacebookCdnVideoUrl(url.text)) {
		const resolvedFacebookUrl = await resolveFacebookShareUrl(url.text)
		if (resolvedFacebookUrl !== url.text) {
			console.log(
				`[DEBUG] Resolved Facebook share URL: ${url.text} -> ${resolvedFacebookUrl}`,
			)
			url.text = resolvedFacebookUrl
		}
	}
	if (!expectedFacebookStoryFbid) {
		expectedFacebookStoryFbid = extractFacebookExpectedStoryFbid(url.text)
	}

	const threadId = ctx.message.message_thread_id
	let processingMessage: any
	const userId = ctx.from?.id
	if (!userId) return
	void logUserLink(userId, sourceUrl, "requested")
	const lockResult = lockUserUrl(userId, sourceUrl)
		if (!lockResult.ok) {
			await ctx.reply("Эта ссылка уже в обработке. Дождитесь завершения.", {
				reply_to_message_id: ctx.message.message_id,
				message_thread_id: threadId,
			})
			return
		}
	void incrementUserCounter(userId, "requests")
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
				let caption: string | undefined
				if (isInstagramUrl(url.text)) {
					caption = await buildInstagramCaption(url.text)
				}
				const mediaItems: Array<{
					type: "photo" | "video"
					media: string
					caption?: string
					parse_mode?: "HTML"
					supports_streaming?: boolean
				}> = resolved.picker
					.filter((p) => typeof p.url === "string" && p.url.length > 0)
					.map((p) => ({
						type: p.type === "photo" ? ("photo" as const) : ("video" as const),
						media: p.url,
						caption: undefined,
						parse_mode: undefined,
						...(p.type === "photo" ? {} : { supports_streaming: true }),
					}))

					const groups = chunkArray(10, mediaItems)
					for (const chunk of groups) {
						if (caption && chunk.length > 0) {
							const first = chunk[0]
							if (first) {
								chunk[0] = {
									...first,
									caption,
									parse_mode: "HTML",
								}
							}
						}
					await bot.api.sendMediaGroup(ctx.chat.id, chunk, {
						reply_to_message_id: ctx.message.message_id,
						message_thread_id: threadId,
					})
				}

				await logUserLink(userId, sourceUrl, "success")
				return true
			}

			if (resolved.status === "redirect" || resolved.status === "tunnel") {
				const caption = isInstagramUrl(url.text)
					? await buildInstagramCaption(url.text)
					: link(
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
				await logUserLink(userId, sourceUrl, "success")
				return true
			}
		} catch (error) {
			console.error("Error resolving with cobalt", error)
			await logErrorEntry({
				userId,
				url: sourceUrl,
				context: "cobalt",
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	// Move queue logic to callback, here only prepare options
	try {
		await deletePreviousMenuMessage(ctx)
		const resolvedTiktokUrl = await resolveTiktokShortUrl(url.text)
		if (resolvedTiktokUrl !== url.text) {
			url.text = resolvedTiktokUrl
		}
		let bypassTitle: string | undefined
		const isFacebookShareReelSource = facebookShareReelMatcher(sourceUrl)

		if (facebookStoryMatcher(url.text) || facebookShareReelMatcher(url.text)) {
			const storyData = await resolveFacebookStory(url.text)
			if (storyData.video_url) {
				url.text = normalizeFacebookCdnVideoUrl(storyData.video_url)
				bypassTitle = storyData.title || "Facebook Story"
			} else if (storyData.error) {
				console.error("Facebook story error:", storyData.error)
				if (isFacebookTemporaryBlockError(storyData.error)) {
					throw new Error(getFacebookTemporaryBlockMessage())
				}
				// share/r links are often unstable for HTML parsing; let yt-dlp handle them as fallback
				if (facebookStoryMatcher(url.text) && !isFacebookShareReelSource) {
					throw new Error(`Facebook story resolve failed: ${storyData.error}`)
				}
				console.warn(
					`[WARN] Facebook share/reel bypass failed, fallback to yt-dlp: ${storyData.error}`,
				)
			}
		}

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

		const isTiktokPhoto = tiktokPhotoMatcher(url.text)
		if (isTiktokPhoto) {
			const tiktokPhotoData = await resolveTiktokPhoto(url.text)
			if (
				Array.isArray(tiktokPhotoData.photo_urls) &&
				tiktokPhotoData.photo_urls.length > 0
			) {
				const captionSourceUrl = tiktokShortMatcher(sourceUrl)
					? await resolveTiktokShortUrl(sourceUrl)
					: sourceUrl
				const authorName =
					typeof tiktokPhotoData.author_name === "string"
						? tiktokPhotoData.author_name.trim()
						: ""
				const authorUsername =
					typeof tiktokPhotoData.author_username === "string"
						? tiktokPhotoData.author_username.trim()
						: ""
				const authorLabel = authorName || (authorUsername ? `@${authorUsername}` : "")
				const authorLink = authorUsername
					? link(escapeHtml(authorLabel), `https://www.tiktok.com/@${authorUsername}`)
					: escapeHtml(authorLabel)
				const caption = authorLabel
					? `Автор: ${authorLink}\n${link("Источник", cleanUrl(captionSourceUrl))}`
					: link("TikTok", cleanUrl(captionSourceUrl))
				await sendPhotoUrls(
					ctx,
					tiktokPhotoData.photo_urls,
					caption,
					threadId,
					ctx.message.message_id,
					true,
				)
				await logUserLink(userId, sourceUrl, "success")
				return
			}
			if (tiktokPhotoData.error) {
				console.error("TikTok photo error:", tiktokPhotoData.error)
			}
		}

		const isPornoxo = pornoxoMatcher(url.text)
		const isPornoxoPage = pornoxoPageMatcher(url.text)
		if (isPornoxoPage) {
			const pornoxoData = await resolvePornoxo(url.text)
			if (pornoxoData.video_url) {
				url.text = pornoxoData.video_url
				bypassTitle = pornoxoData.title
			} else if (pornoxoData.error) {
				console.error("Pornoxo error:", pornoxoData.error)
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
				await logUserLink(userId, sourceUrl, "success")
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
				await logUserLink(userId, sourceUrl, "success")
				return
			} else if (pinterestData.error) {
				console.error("Pinterest error:", pinterestData.error)
			}
		}
		const isBehance = behanceMatcher(url.text)
		if (isBehance) {
			const behanceData = await resolveBehance(url.text)
			if (behanceData.video_url) {
				url.text = behanceData.video_url
				bypassTitle = behanceData.title
			} else if (behanceData.error) {
				console.error("Behance error:", behanceData.error)
			}
		}
		const isCcv = ccvMatcher(url.text)
		if (isCcv) {
			const ccvData = await resolveCcv(url.text)
			if (ccvData.video_url) {
				url.text = ccvData.video_url
			} else if (ccvData.error) {
				console.error("CCV error:", ccvData.error)
			}
		}

		const isTiktok = urlMatcher(url.text, "tiktok.com")
		const isVimeo = isVimeoUrl(url.text)
		const useCobalt = cobaltMatcher(url.text)
		const additionalArgs = isTiktok ? tiktokArgs : []
		const isYouTube = isYouTubeUrl(url.text)
		const cookieArgsList = await cookieArgs()
		const youtubeArgs = isYouTube ? youtubeExtractorArgs : []
		const proxyArgs = isVimeo || isPornoxo ? [] : await getProxyArgs()
		const vimeoArgs = isVimeo
			? [
					"--sleep-requests",
					"1",
					"--extractor-retries",
					"3",
					"--retry-sleep",
					"15",
					"--extractor-args",
					"vimeo:original_format_policy=never",
				]
			: []
		const refererArgs = shouldAttachReferer(sourceUrl)
			? getRefererHeaderArgs(sourceUrl)
			: []

		if (useCobalt && !isSora) {
			if (await useCobaltResolver()) {
				return
			}
		}

		// Check available formats
		const genericFallbacks = shouldTryGenericFallback(sourceUrl)
			? buildGenericFallbacks(sourceUrl)
			: []
		const vimeoCookieAttempts =
			isVimeo && cookieArgsList.length > 0 ? [[], cookieArgsList] : [cookieArgsList]
		const fetchInfoOnce = async () => {
			let lastError: unknown
			for (const cookiesOverride of vimeoCookieAttempts) {
				try {
					return await safeGetInfoWithFallback(
						url.text,
						[
							"--dump-json",
							"--no-warnings",
							"-q",
							"--no-progress",
							"--no-playlist",
							...cookiesOverride,
							...additionalArgs,
							...impersonateArgs,
							...youtubeArgs,
							...refererArgs,
							...vimeoArgs,
						],
						undefined,
						false,
						genericFallbacks.map((attempt) => attempt.args),
						proxyArgs,
					)
				} catch (error) {
					lastError = error
					if (isVimeo && cookiesOverride.length === 0 && isAuthError(error)) {
						continue
					}
					throw error
				}
			}
			throw lastError instanceof Error
				? lastError
				: new Error("No valid info")
		}
		const info = await withRateLimitRetry(fetchInfoOnce, isVimeo)
		if (expectedFacebookStoryFbid && typeof info?.webpage_url === "string") {
			const actualFacebookStoryFbid = extractFacebookStoryFbid(info.webpage_url)
			if (
				actualFacebookStoryFbid &&
				actualFacebookStoryFbid !== expectedFacebookStoryFbid
			) {
				throw new Error(
					`Facebook story mismatch: expected story_fbid=${expectedFacebookStoryFbid}, got story_fbid=${actualFacebookStoryFbid}`,
				)
			}
		}

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
					false,
					externalAudioUrl,
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
			externalAudioUrl,
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

		keyboard.text("Translate (Yandex)", `tv:${requestId}`).row()
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
			await logErrorEntry({
				userId,
				url: sourceUrl || url.text,
				context: "message:url",
				error: error instanceof Error ? error.message : `Couldn't process ${url.text}`,
			})
			await createUserReportPrompt(
				ctx,
				`URL: ${cleanUrl(url.text)}`,
				error instanceof Error ? error.message : `Couldn't process ${url.text}`,
			)
			await notifyAdminError(
				ctx.chat,
				`URL: ${cleanUrl(url.text)}`,
				error instanceof Error ? error.message : `Couldn't process ${url.text}`,
				ctx.from,
				ctx.message,
			)
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
	if (data.startsWith("task:translate:")) {
		const userId = ctx.from?.id
		if (!userId) return await ctx.answerCallbackQuery()
		const value = data.split(":")[2]
		const translate = value === "yes"
		const current = taskOptions.get(userId)
		if (!current?.url) {
			return await ctx.answerCallbackQuery({
				text: "Ссылка устарела. Повторите /task.",
				show_alert: true,
			})
		}
		taskOptions.set(userId, { ...current, translate })
		try {
			await ctx.editMessageText("Убрать рекламные фрагменты?", {
				reply_markup: buildTaskKeyboard("task:sponsor"),
			})
		} catch {}
		return await ctx.answerCallbackQuery({ text: "Ок" })
	}
	if (data.startsWith("task:sponsor:")) {
		const userId = ctx.from?.id
		if (!userId) return await ctx.answerCallbackQuery()
		const value = data.split(":")[2]
		const sponsor = value === "yes"
		const current = taskOptions.get(userId)
		if (!current?.url) {
			return await ctx.answerCallbackQuery({
				text: "Ссылка устарела. Повторите /task.",
				show_alert: true,
			})
		}
		if (!sponsor) {
			const updated = { ...current, sponsor: false, sponsorCategories: undefined }
			taskOptions.set(userId, updated)
			userState.delete(userId)
			userPromptMessages.delete(userId)
			const replyToMessageId = updated.replyToMessageId
			const url = updated.url
			taskOptions.delete(userId)
			try {
				await ctx.editMessageText("Ставим задачу в очередь...", {
					reply_markup: new InlineKeyboard(),
				})
			} catch {}
			scheduleDeleteMessage(ctx.callbackQuery?.message as any)
			await enqueueTaskJob(
				ctx,
				userId,
				url,
				{
					translate: updated.translate ?? false,
					sponsor: updated.sponsor ?? false,
					sponsorCategories: updated.sponsorCategories,
				},
				replyToMessageId,
			)
			return await ctx.answerCallbackQuery({ text: "Ок" })
		}

		taskOptions.set(userId, {
			...current,
			sponsor: true,
			sponsorCategories: undefined,
		})
		try {
			await ctx.editMessageText("Что вырезать по SponsorBlock?", {
				reply_markup: buildSponsorCategoriesKeyboard(),
			})
		} catch {}
		return await ctx.answerCallbackQuery({ text: "Ок" })
	}
	if (data.startsWith("task:sponsor_categories:")) {
		const userId = ctx.from?.id
		if (!userId) return await ctx.answerCallbackQuery()
		const value = data.split(":")[2]
		const current = taskOptions.get(userId)
		if (!current?.url) {
			return await ctx.answerCallbackQuery({
				text: "Ссылка устарела. Повторите /task.",
				show_alert: true,
			})
		}
		const sponsorCategories =
			value === "all" ? SPONSORBLOCK_ALL_CATEGORIES : SPONSORBLOCK_DEFAULT_CATEGORIES
		const updated = {
			...current,
			sponsor: true,
			sponsorCategories,
		}
		taskOptions.set(userId, updated)
		userState.delete(userId)
		userPromptMessages.delete(userId)
		const replyToMessageId = updated.replyToMessageId
		const url = updated.url
		taskOptions.delete(userId)
		try {
			await ctx.editMessageText("Ставим задачу в очередь...", {
				reply_markup: new InlineKeyboard(),
			})
		} catch {}
		scheduleDeleteMessage(ctx.callbackQuery?.message as any)
		await enqueueTaskJob(
			ctx,
			userId,
			url,
			{
				translate: updated.translate ?? false,
				sponsor: updated.sponsor ?? false,
				sponsorCategories: updated.sponsorCategories,
			},
			replyToMessageId,
		)
		return await ctx.answerCallbackQuery({ text: "Ок" })
	}
	if (data.startsWith("ban:")) {
		if (ctx.from?.id !== ADMIN_ID) {
			return await ctx.answerCallbackQuery({
				text: "Not allowed",
				show_alert: true,
			})
		}
		const [, idText] = data.split(":")
		const targetId = Number.parseInt(idText || "", 10)
		if (!Number.isFinite(targetId)) {
			return await ctx.answerCallbackQuery({
				text: "Invalid user id",
				show_alert: true,
			})
		}
		await loadBans()
		bans.set(targetId, {
			id: targetId,
			at: Date.now(),
			by: ctx.from.id,
			reason: "inline",
		})
		await saveBans()
		try {
			await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() })
		} catch {}
		return await ctx.answerCallbackQuery({ text: "Пользователь заблокирован" })
	}
	if (data.startsWith("unban:")) {
		if (ctx.from?.id !== ADMIN_ID) {
			return await ctx.answerCallbackQuery({
				text: "Not allowed",
				show_alert: true,
			})
		}
		const [, idText] = data.split(":")
		const targetId = Number.parseInt(idText || "", 10)
		if (!Number.isFinite(targetId)) {
			return await ctx.answerCallbackQuery({
				text: "Invalid user id",
				show_alert: true,
			})
		}
		await loadBans()
		bans.delete(targetId)
		await saveBans()
		try {
			await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() })
		} catch {}
		return await ctx.answerCallbackQuery({ text: "Пользователь разблокирован" })
	}
	if (data.startsWith("report:")) {
		const [, reportId] = data.split(":")
		if (!reportId) {
			return await ctx.answerCallbackQuery({
				text: "Запрос устарел",
				show_alert: true,
			})
		}
		const report = userReports.get(reportId)
		if (!report) {
			return await ctx.answerCallbackQuery({
				text: "Запрос устарел",
				show_alert: true,
			})
		}
		if (ctx.from?.id !== report.userId) {
			return await ctx.answerCallbackQuery({
				text: "Not allowed",
				show_alert: true,
			})
		}
		userReports.delete(reportId)
		const adminText =
			report.promptText ||
			[
				"Возможно, нам нужно это исправить. Отправить разработчику?",
				"",
				`ID: <span class=\"tg-spoiler\">${formatUserIdLinkHtml(report.userId)}</span>`,
			].join("\n")
		const keyboard =
			report.userId !== ADMIN_ID
				? new InlineKeyboard().text("Ban user", `ban:${report.userId}`)
				: undefined
		await bot.api.sendMessage(ADMIN_ID, adminText, {
			parse_mode: "HTML",
			reply_markup: keyboard,
		})
		if (report.messageId) {
			try {
				await bot.api.forwardMessage(
					ADMIN_ID,
					report.chatId,
					report.messageId,
				)
			} catch {}
		}
		try {
			await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() })
		} catch {}
		return await ctx.answerCallbackQuery({ text: "Отправлено" })
	}
	if (data.startsWith("tv:")) {
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
			await ctx.answerCallbackQuery({
				text: "Request expired or invalid.",
				show_alert: true,
			})
			return
		}
		requestCache.delete(requestId)
		await deletePreviousMenuMessage(ctx)
		const processing = await ctx.reply("Ставим перевод в очередь...")
			enqueueJob(userId, getCacheLockUrl(cached), cached.lockId, async (signal) => {
				try {
					await runTranslatedDownload({
						ctx,
						url: cached.url,
					sourceUrl: cached.sourceUrl,
					statusMessageId: processing.message_id,
					replyToMessageId: ctx.callbackQuery.message?.message_id,
					signal,
						overrideTitle: cached.title,
						externalAudioUrl: cached.externalAudioUrl,
					})
				} catch (error) {
					if (isTranslationUnsupportedError(error)) {
						if (processing?.message_id) {
							await updateMessage(
								ctx,
								processing.message_id,
								getTranslationUnsupportedMessage(error),
								{ force: true },
							)
						} else {
							await ctx.reply(getTranslationUnsupportedMessage(error))
						}
						return
					}
					console.error("Translate callback error:", error)
					await logErrorEntry({
						userId,
						url: cached.sourceUrl || cached.url,
					context: "translate",
					error: error instanceof Error ? error.message : String(error),
				})
				if (processing?.message_id) {
					await updateMessage(ctx, processing.message_id, "Ошибка перевода.")
				}
				if (ctx.chat?.type === "private") {
					await createUserReportPrompt(
						ctx,
						`URL: ${cleanUrl(cached.sourceUrl || cached.url)}`,
						error instanceof Error ? error.message : "Translation error",
					)
				}
				await notifyAdminError(
					ctx.chat,
					`URL: ${cleanUrl(cached.sourceUrl || cached.url)}`,
					error instanceof Error ? error.message : "Translation error",
					ctx.from,
					ctx.message,
				)
			}
		})
		return await ctx.answerCallbackQuery({ text: "Поставлено в очередь..." })
	}
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
					false,
					cached.externalAudioUrl,
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
				false,
				cached.externalAudioUrl,
			)
		})
			return await ctx.answerCallbackQuery({ text: "Поставлено в очередь..." })
		}
		if (data.startsWith("ds:")) {
			const [, requestId, sponsorMode] = data.split(":")
			if (!requestId || !sponsorMode) {
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
			const userId = ctx.from?.id
			if (!userId) return
			if (cached.userId && cached.userId !== userId) {
				await ctx.answerCallbackQuery({
					text: "Это меню не для вас.",
					show_alert: true,
				})
				return
			}
			const selectedQuality = cached.selectedQuality
			if (!selectedQuality) {
				return await ctx.answerCallbackQuery({
					text: "Выберите качество заново.",
					show_alert: true,
				})
			}
			const effectiveLockId = cached.lockId
			if (!effectiveLockId) {
				await ctx.answerCallbackQuery({ text: "Request expired or invalid.", show_alert: true })
				return
			}
			const sponsorCutRequested = sponsorMode === "sponsor" || sponsorMode === "all"
			const sponsorCategories =
				sponsorMode === "all"
					? SPONSORBLOCK_ALL_CATEGORIES
					: sponsorMode === "sponsor"
						? SPONSORBLOCK_DEFAULT_CATEGORIES
						: undefined
			const lockUrl = getCacheLockUrl(cached)
			const blockReason = getQueueBlockReason(userId, lockUrl, effectiveLockId)
			if (blockReason) {
				await ctx.answerCallbackQuery({ text: blockReason, show_alert: true })
				return
			}
			const queuedQuality = selectedQuality
			const queuedIsRawFormat = cached.selectedIsRawFormat ?? false
			const queuedForceAudio = cached.selectedForceAudio ?? false
			const queuedDashFormatLabel = cached.selectedDashFormatLabel
			const queuedForceHls = cached.selectedForceHls ?? false
			const queuedUrl = cached.url
			const queuedTitle = cached.title
			const queuedSourceUrl = cached.sourceUrl
			const queuedExternalAudioUrl = cached.externalAudioUrl
			requestCache.delete(requestId)
			await ctx.answerCallbackQuery({ text: "Поставлено в очередь..." })
			await ctx.editMessageText(
				`Скачиваем ${queuedQuality === "b" ? "Лучшее" : queuedQuality}...`,
			)
			enqueueJob(userId, lockUrl, effectiveLockId, async (signal) => {
				await downloadAndSend(
					ctx,
					queuedUrl,
					queuedQuality,
					queuedIsRawFormat,
					ctx.callbackQuery.message?.message_id,
					queuedTitle,
					ctx.callbackQuery.message?.reply_to_message?.message_id,
					signal,
					queuedForceAudio,
					queuedDashFormatLabel,
					queuedForceHls,
					queuedSourceUrl,
					false,
					queuedExternalAudioUrl,
					sponsorCutRequested,
					sponsorCategories,
				)
			})
			return
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
	if (cached.userId && cached.userId !== userId) {
		await ctx.answerCallbackQuery({
			text: "Это меню не для вас.",
			show_alert: true,
		})
		return
	}
	let effectiveLockId = cached.lockId
	if (!effectiveLockId) {
		const newLock = lockUserUrl(userId, getCacheLockUrl(cached))
		if (!newLock.ok) {
			await ctx.answerCallbackQuery({
				text: "Эта ссылка уже в обработке. Дождитесь завершения.",
				show_alert: true,
			})
			return
		}
		effectiveLockId = newLock.lockId
		cached.lockId = effectiveLockId
		cached.userId = userId
		requestCache.set(requestId, cached)
	}
	const blockReason = getQueueBlockReason(
		userId,
		getCacheLockUrl(cached),
		effectiveLockId,
	)
	if (blockReason) {
		await ctx.answerCallbackQuery({ text: blockReason, show_alert: true })
		return
	}
		const sponsorStepEligible =
			isYouTubeUrl(cached.sourceUrl || cached.url) && !forceAudio && quality !== "audio"
		if (sponsorStepEligible) {
			cached.selectedQuality = quality
			cached.selectedIsRawFormat = isRawFormat
			cached.selectedForceAudio = forceAudio
			cached.selectedDashFormatLabel = dashFormatLabel
			cached.selectedForceHls = forceHls
			requestCache.set(requestId, cached)
			await ctx.answerCallbackQuery({ text: "Выберите режим SponsorBlock..." })
			await ctx.editMessageText("Вырезать SponsorBlock фрагменты?", {
				reply_markup: buildInlineSponsorDecisionKeyboard(requestId),
			})
			return
		}
		await ctx.answerCallbackQuery({ text: "Поставлено в очередь..." })
		await ctx.editMessageText(`Скачиваем ${quality === "b" ? "Лучшее" : quality}...`)
	if (!effectiveLockId) {
		await ctx.answerCallbackQuery({ text: "Request expired or invalid.", show_alert: true })
		return
	}
	requestCache.delete(requestId)
	enqueueJob(userId, url, effectiveLockId, async (signal) => {
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
			false,
			cached.externalAudioUrl,
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
