import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { downloadFromInfo, getInfo } from "@resync-tv/yt-dlp"
import { InlineKeyboard, InputFile } from "grammy"
import { deleteMessage, errorMessage, notifyAdminError } from "./bot-util"
import { cobaltMatcher, cobaltResolver } from "./cobalt"
import { link, t, tiktokArgs, impersonateArgs, jsRuntimeArgs } from "./constants"
import {
	ADMIN_ID,
	ALLOW_GROUPS,
	ALWAYS_DOWNLOAD_BEST,
	API_ROOT,
	COOKIE_FILE,
	cookieArgs,
	WHITELISTED_IDS,
} from "./environment"
import { getThumbnail, urlMatcher, getVideoMetadata, generateThumbnail } from "./media-util"
import { Queue } from "./queue"
import { bot } from "./setup"
import { translateText } from "./translate"
import { Updater } from "./updater"
import { chunkArray, removeHashtagsMentions, cleanUrl } from "./util"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"

const execFilePromise = promisify(execFile)

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

const spawnPromise = (
	command: string,
	args: string[],
	onData?: (data: string) => void,
) => {
	return new Promise<void>((resolve, reject) => {
		const process = spawn(command, args)
		process.stdout.on("data", (d) => onData?.(d.toString()))
		process.stderr.on("data", (d) => onData?.(d.toString()))
		process.on("close", (code) => {
			if (code === 0) resolve()
			else reject(new Error(`Process exited with code ${code}`))
		})
	})
}

const safeGetInfo = async (url: string, args: string[]) => {
	const runtimeArgs = args.includes("--js-runtimes") ? args : [...jsRuntimeArgs, ...args]
	const runtimeArgsWithCache = runtimeArgs.includes("--no-cache-dir")
		? runtimeArgs
		: [...runtimeArgs, "--no-cache-dir"]
	console.log("Running yt-dlp with:", runtimeArgsWithCache)
	const { stdout } = await execFilePromise("yt-dlp", [url, ...runtimeArgsWithCache])
	// Split by newline and try to parse the first valid JSON line
	const lines = stdout.split("\n").filter((l) => l.trim().length > 0)
	for (const line of lines) {
		try {
			return JSON.parse(line)
		} catch {}
	}
	throw new Error("No valid JSON found in yt-dlp output")
}

const fileExists = async (path: string, minSize = 1) => {
	try {
		const info = await stat(path)
		return info.size >= minSize
	} catch {
		return false
	}
}

const renderMhtmlPreview = async (inputPath: string, outputBase: string) => {
	const htmlPath = `${outputBase}.html`
	let previewSource = inputPath
	try {
		await execFilePromise("python3", [
			"src/mhtml_extract.py",
			inputPath,
			htmlPath,
		])
		if (await fileExists(htmlPath, 16)) {
			previewSource = htmlPath
		}
	} catch (error) {
		console.error("MHTML HTML extract error:", error)
	}

	const fileUrl = pathToFileURL(previewSource).toString()
	const commonArgs = [
		"--headless",
		"--no-sandbox",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		"--no-first-run",
		"--no-default-browser-check",
		"--allow-file-access-from-files",
		"--window-size=1280,720",
		"--hide-scrollbars",
		"--virtual-time-budget=5000",
	]
	const pngPath = `${outputBase}.png`
	try {
		await execFilePromise("chromium", [
			...commonArgs,
			`--screenshot=${pngPath}`,
			fileUrl,
		])
		if (await fileExists(pngPath, 1024)) return pngPath
	} catch (error) {
		console.error("MHTML image render error:", error)
	}

	const pdfPath = `${outputBase}.pdf`
	try {
		await execFilePromise("chromium", [
			...commonArgs,
			`--print-to-pdf=${pdfPath}`,
			fileUrl,
		])
		if (await fileExists(pdfPath, 1024)) return pdfPath
	} catch (error) {
		console.error("MHTML PDF render error:", error)
	}

	return undefined
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
	"youtube:player_client=android_sdkless,web_safari",
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

const queue = new Queue(10)
const MAX_GLOBAL_TASKS = 10
const MAX_USER_URLS = 3
type JobMeta = { id: string; userId: number; url: string; lockId: string }
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
	executor: () => Promise<void>,
) => {
	const normalized = normalizeUrl(url)
	const jobId = randomUUID()
	jobMeta.set(jobId, { id: jobId, userId, url: normalized, lockId })
	activateUserUrlLock(userId, normalized, lockId)
	queue.add(async () => {
		try {
			await executor()
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
	const remainingActive = Array.from(jobMeta.values()).filter(
		(job) => job.userId === userId,
	).length
	return { removedCount: removed.length, remainingActive }
}

const cancelUserRequests = (userId: number) => {
	let removed = 0
	for (const [requestId, cached] of requestCache.entries()) {
		if (cached.userId === userId) {
			requestCache.delete(requestId)
			if (cached.lockId) unlockUserUrl(userId, cached.url, cached.lockId)
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
			unlockUserUrl(cached.userId, cached.url, cached.lockId)
		}
	}, 3600000)
}
const updater = new Updater()
type RequestCacheEntry = {
	url: string
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
	await ctx.reply(`Выберите список форматов для: ${title}`, {
		reply_markup: keyboard,
		message_thread_id: threadId,
	})
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
		if (allowCombine) {
			keyboard.text("Объединить форматы", `c:${requestId}`).row()
		}
		keyboard.text("Назад", `f:${requestId}:back`).row()
		await ctx.reply(`Actions for: ${title}`, {
			reply_markup: keyboard,
			message_thread_id: threadId,
		})
		return
	}

	const keyboard = new InlineKeyboard()
	if (allowCombine) {
		keyboard.text("Объединить форматы", `c:${requestId}`).row()
	}
	for (const entry of entries) {
		keyboard
			.text(buildFormatButtonText(entry), `d:${requestId}:${entry.format.format_id}`)
			.row()
	}
	keyboard.text("Назад", `f:${requestId}:back`).row()
	await ctx.reply(`Select ${label} format for: ${title}`, {
		reply_markup: keyboard,
		message_thread_id: threadId,
	})
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
		await ctx.reply("Actions for combine:", {
			reply_markup: keyboard,
			message_thread_id: threadId,
		})
		return
	}

	const keyboard = new InlineKeyboard()
	for (const entry of entries) {
		keyboard
			.text(buildFormatButtonText(entry), `cv:${requestId}:${entry.format.format_id}`)
			.row()
	}
	keyboard.text("Назад", `f:${requestId}:dash`).row()
	await ctx.reply(`Select video format to combine for: ${title}`, {
		reply_markup: keyboard,
		message_thread_id: threadId,
	})
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
		await ctx.reply("Actions for combine:", {
			reply_markup: keyboard,
			message_thread_id: threadId,
		})
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
	await ctx.reply(`Select audio format to combine for: ${title}`, {
		reply_markup: keyboard,
		message_thread_id: threadId,
	})
}

const downloadAndSend = async (
	ctx: any,
	url: string,
	quality: string,
	isRawFormat = false,
	statusMessageId?: number,
	overrideTitle?: string,
	replyToMessageId?: number,
) => {
	const tempBaseId = randomUUID()
	const tempDir = resolve("/tmp", `telegram-ytdl-${tempBaseId}`)
	await mkdir(tempDir, { recursive: true })
	let tempFilePath = resolve(tempDir, "video.mp4")
	const tempThumbPath = resolve(tempDir, "thumb.jpg")
	const tempPreviewBase = resolve(tempDir, "preview")
	const threadId = ctx.message?.message_thread_id || ctx.callbackQuery?.message?.message_thread_id
	
	try {
		const isTiktok = urlMatcher(url, "tiktok.com")
		const isInstagram =
			urlMatcher(url, "instagram.com") || urlMatcher(url, "instagr.am")
		const additionalArgs = isTiktok ? tiktokArgs : []
		const isYouTube = isYouTubeUrl(url)
		const cookieArgsList = await cookieArgs()
		const youtubeArgs = isYouTube ? youtubeExtractorArgs : []

		const isMp3Format = isRawFormat && quality === "mp3"
		let formatArgs: string[] = []
		if (isRawFormat) {
			if (isMp3Format) {
				formatArgs = ["-f", "251", "-x", "--audio-format", "mp3"]
			} else {
				formatArgs = ["-f", quality]
			}
		} else if (quality === "audio") {
			formatArgs = ["-x", "--audio-format", "mp3"]
		} else if (quality === "b") {
			formatArgs = [
				"-f",
				"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
			]
		} else {
			formatArgs = [
				"-f",
				`bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${quality}][ext=mp4]/best[height<=${quality}]`,
			]
		}

		console.log(`[QUEUE] Starting download: ${url} (Quality: ${quality}) in chat ${ctx.chat.id}`)

		if (statusMessageId) {
			await updateMessage(ctx, statusMessageId, "Получаем информацию о видео...")
		}

		const info = await safeGetInfo(url, [
			"--dump-json",
			...formatArgs,
			"--no-warnings",
			"--no-playlist",
			...cookieArgsList,
			...additionalArgs,
			...impersonateArgs,
			...youtubeArgs,
		])

		const title = overrideTitle || removeHashtagsMentions(info.title)
		const caption = link(title || "Video", cleanUrl(url))
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
		if (estimatedSize >= maxUploadSize) {
			const limitMessage = "Можно загрузить файлы до 2ГБ"
			if (statusMessageId) {
				await updateMessage(ctx, statusMessageId, limitMessage)
			} else if (ctx.callbackQuery) {
				await ctx.editMessageText(limitMessage)
			} else {
				await ctx.reply(limitMessage)
			}
			return
		}

		const requestedFormats = Array.isArray(info.requested_formats)
			? info.requested_formats
			: []
		const isCombined = isRawFormat && requestedFormats.length > 1
		let outputContainer: "mp4" | "webm" | "mkv" = "mp4"
		const formatNote = `${info.format_note || ""}`.toLowerCase()
		const formatLine = `${info.format || ""}`.toLowerCase()
		const formatProtocol = `${info.protocol || ""}`.toLowerCase()
		const isMhtml =
			info.ext === "mhtml" ||
			`${info.format_id || ""}`.startsWith("sb") ||
			formatProtocol.includes("mhtml") ||
			formatNote.includes("storyboard") ||
			formatLine.includes("storyboard")

		if (quality !== "audio" && !isMp3Format) {
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
				const isWebmVideo = /vp0?8|vp0?9|av01/i.test(combinedVideoCodec)
				const isWebmAudio = /opus|vorbis/i.test(combinedAudioCodec)
				const isMp4Video = /avc|h264|hevc|h265/i.test(combinedVideoCodec)
				const isMp4Audio = /mp4a|aac/i.test(combinedAudioCodec)

				if (isWebmVideo && isWebmAudio) {
					outputContainer = "webm"
				} else if (isMp4Video && isMp4Audio) {
					outputContainer = "mp4"
				} else {
					outputContainer = "mkv"
				}
				if (isInstagram) {
					outputContainer = "mp4"
				}
			} else {
				outputContainer = info.ext === "webm" ? "webm" : info.ext === "mkv" ? "mkv" : "mp4"
			}

			if (outputContainer !== "mp4") {
				tempFilePath = resolve(tempDir, `video.${outputContainer}`)
			}

			if (!isMhtml) {
				formatArgs.push("--merge-output-format", outputContainer)
			}
		}
		if (!formatArgs.includes("--no-cache-dir")) {
			formatArgs.push("--no-cache-dir")
		}

		if (quality === "audio" || isMp3Format) {
			if (statusMessageId) {
				await updateMessage(
					ctx,
					statusMessageId,
					`Обработка: <b>${title}</b>\nСтатус: Скачиваем аудио...`,
				)
			}
			const stream = downloadFromInfo(info, "-", formatArgs)
			const audio = new InputFile(stream.stdout)

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
				title: info.title,
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
			let progressText = "Скачиваем..."
			let fileSize = ""
			let lastProgressAt = Date.now()
			const containerLabel = outputContainer.toUpperCase()
			const muxingLabel = `Муксинг в ${containerLabel}...`
			const convertingLabel = `Конвертируем в ${containerLabel}...`
			const onProgress = (data: string) => {
				if (!statusMessageId) return
				const lower = data.toLowerCase()
				lastProgressAt = Date.now()

				if (data.includes("[download]")) {
					const sizeMatch = data.match(/of\s+(?:~?\s*)?([\d.,]+\s*\w+B)/)
					if (sizeMatch?.[1]) {
						fileSize = sizeMatch[1]
					}

					const percentageMatch = data.match(/(\d+(?:[.,]\d+)?)%/)
					if (percentageMatch) {
						progressText = `Скачиваем: ${percentageMatch[1]}%`
						if (fileSize) {
							progressText += ` из ${fileSize}`
						}
						if (percentageMatch[1] === "100.0" && isCombined) {
							progressText = muxingLabel
						}
					}
				} else if (
					data.includes("[Merger]") ||
					lower.includes("merging formats into") ||
					(lower.includes("[ffmpeg]") && lower.includes("merge"))
				) {
					progressText = muxingLabel
				} else if (
					data.includes("[VideoConvertor]") ||
					lower.includes("converting") ||
					(lower.includes("[ffmpeg]") && lower.includes("conversion"))
				) {
					progressText = convertingLabel
				}

				updateMessage(
					ctx,
					statusMessageId,
					`Обработка: <b>${title}</b>\nСтатус: ${progressText}`,
				)
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

			try {
				await spawnPromise(
					"yt-dlp",
					[
						url,
						...formatArgs,
						"-o",
						tempFilePath,
						"--no-warnings",
						"--no-playlist",
						...cookieArgsList,
						...additionalArgs,
						...impersonateArgs,
						...youtubeArgs,
					],
					onProgress,
				)
			} finally {
				if (statusHeartbeat) clearInterval(statusHeartbeat)
			}

			const hasVideoTrack = info.vcodec && info.vcodec !== "none"
			if (
				(isTiktok || isInstagram) &&
				hasVideoTrack &&
				!isMhtml &&
				outputContainer === "mp4" &&
				!isMp3Format &&
				quality !== "audio"
			) {
				const audioFixedPath = resolve(tempDir, "audio-fixed.mp4")
				try {
					if (statusMessageId) {
						await updateMessage(
							ctx,
							statusMessageId,
							`Обработка: <b>${title}</b>\nСтатус: Конвертируем аудио...`,
						)
					}
					await spawnPromise("ffmpeg", [
						"-y",
						"-i",
						tempFilePath,
						"-c:v",
						"copy",
						"-c:a",
						"aac",
						"-profile:a",
						"aac_low",
						"-b:a",
						"256k",
						"-ar",
						"48000",
						"-movflags",
						"+faststart",
						audioFixedPath,
					])
					if (await fileExists(audioFixedPath, 1024)) {
						await unlink(tempFilePath)
						tempFilePath = audioFixedPath
					} else {
						await unlink(audioFixedPath)
					}
				} catch (error) {
					console.error("TikTok audio convert error:", error)
					try {
						await unlink(audioFixedPath)
					} catch {}
				}
			}

			if (isMhtml) {
				try {
					const previewPath = await renderMhtmlPreview(tempFilePath, tempPreviewBase)
					if (previewPath) {
						await ctx.replyWithChatAction("upload_document")
						await ctx.replyWithDocument(new InputFile(previewPath), {
							caption: "Preview",
							message_thread_id: threadId,
						})
					}
				} catch (error) {
					console.error("MHTML preview send error:", error)
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
				// Get metadata directly from the file
				const metadata = await getVideoMetadata(tempFilePath)
				const width = metadata.width || info.width
				const height = metadata.height || info.height
				const duration = metadata.duration || info.duration

				// Generate local thumbnail to ensure correct aspect ratio in Telegram
				await generateThumbnail(tempFilePath, tempThumbPath)
				const thumbFile = new InputFile(tempThumbPath)

				const video = new InputFile(tempFilePath)

				if (statusMessageId) {
					await updateMessage(
						ctx,
						statusMessageId,
						`Обработка: <b>${title}</b>\nСтатус: Отправляем...`,
					)
				}

				await ctx.replyWithChatAction("upload_video")
				const supportsStreaming = outputContainer === "mp4" && !isTiktok
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
	await ctx.reply("To update cookies, simply send the 'cookies.txt' file as a document in this chat.")
})

bot.command("clear", async (ctx) => {
	if (ctx.from?.id !== ADMIN_ID) return
	try {
		const removed = queue.clear()
		for (const entry of removed) {
			const meta = jobMeta.get(entry.id)
			if (meta) {
				unlockUserUrl(meta.userId, meta.url, meta.lockId)
				jobMeta.delete(entry.id)
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

		await writeFile(COOKIE_FILE, newContent)
		
		await ctx.reply(`Cookies appended successfully!\nLocation: ${COOKIE_FILE}`)
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

bot.command("formats", async (ctx) => {
	if (ctx.from?.id) {
		userState.set(ctx.from.id, "waiting_for_formats_url")
		await ctx.reply("Пришлите ссылку.")
	}
})

bot.command("cancel", async (ctx) => {
	const userId = ctx.from?.id
	if (!userId) return
	const removedRequests = cancelUserRequests(userId)
	const { removedCount, remainingActive } = cancelUserJobs(userId)
	if (removedCount === 0 && remainingActive === 0 && removedRequests === 0) {
		await ctx.reply("У вас нет активных заданий.")
		return
	}
	await ctx.reply(
		`Отменено заданий в очереди: ${removedCount}. Активных в работе: ${remainingActive}.`,
	)
})

bot.on("message:text", async (ctx, next) => {
	const userId = ctx.from?.id
	if (!userId) return await next()

	const state = userState.get(userId)
	if (state === "waiting_for_formats_url") {
		userState.delete(userId)
		const url = ctx.message.text
		if (!url) {
			await ctx.reply("Invalid URL.")
			return
		}

		const lockResult = lockUserUrl(userId, url)
		if (!lockResult.ok) {
			await ctx.reply("Эта ссылка уже в обработке. Дождитесь завершения.")
			return
		}
		const lockId = lockResult.lockId
		let keepLock = false
		const processing = await ctx.reply("Получаем форматы...")
		try {
			const isYouTube = isYouTubeUrl(url)
			const cookieArgsList = await cookieArgs()
			const youtubeArgs = isYouTube ? youtubeExtractorArgs : []
			const additionalArgs = urlMatcher(url, "tiktok.com") ? tiktokArgs : []
			const info = await safeGetInfo(url, [
				"--dump-json",
				"--no-warnings",
				"--no-playlist",
				...cookieArgsList,
				...additionalArgs,
				...impersonateArgs,
				...youtubeArgs,
			])

			if (!info.formats || info.formats.length === 0) {
				await ctx.reply("No formats found.")
				return
			}
			const formats = info.formats || []

			const requestId = randomUUID().split("-")[0]
			if (!requestId) {
				throw new Error("Failed to generate request ID.")
			}
			const filteredFormats = formats.filter((f) => f.format_id)
			requestCache.set(requestId, {
				url,
				title: info.title,
				formats: filteredFormats,
				userId,
				lockId,
			})
			scheduleRequestExpiry(requestId)
			keepLock = true

			console.log(`[DEBUG] Total formats: ${formats.length}`)
			console.log(`[DEBUG] Filtered formats count: ${filteredFormats.length}`)
			console.log(
				`[DEBUG] Filtered format IDs: ${filteredFormats.map((f) => f.format_id).join(", ")}`,
			)

			const { dashEntries, hlsEntries, mhtmlEntries } =
				splitFormatEntries(filteredFormats)
			const hasMp3 = filteredFormats.some((f) => f.format_id === "251")

			await sendFormatSelector(
				ctx,
				requestId,
				info.title,
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
				unlockUserUrl(userId, url, lockId)
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

	const isPrivate = ctx.chat.type === "private"
	const threadId = ctx.message.message_thread_id
	let processingMessage: any
	const userId = ctx.from?.id
	if (!userId) return
	const lockResult = lockUserUrl(userId, url.text)
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
				const photos = chunkArray(
					10,
					resolved.picker
						.filter((p) => p.type === "photo")
						.map((p) => ({
							type: "photo" as const,
							media: p.url,
						})),
				)

				for (const chunk of photos) {
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
		const info = await safeGetInfo(url.text, [
			"--dump-json",
			"--no-warnings",
			"-q",
			"--no-progress",
			"--no-playlist",
			...cookieArgsList,
			...additionalArgs,
			...impersonateArgs,
			...youtubeArgs,
		])

		const title = bypassTitle || removeHashtagsMentions(info.title)

		// If group chat OR always download best is enabled -> Auto download
		if (!isPrivate || ALWAYS_DOWNLOAD_BEST) {
			autoDeleteProcessingMessage = false
			const blockReason = getQueueBlockReason(userId, url.text, lockId)
			if (blockReason) {
				await ctx.reply(blockReason, {
					reply_to_message_id: ctx.message.message_id,
					message_thread_id: threadId,
				})
				return
			}
			enqueueJob(userId, url.text, lockId, async () => {
				await downloadAndSend(
					ctx,
					url.text,
					"b",
					false,
					processingMessage?.message_id,
					title,
					ctx.message.message_id,
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

		await ctx.reply(`Select quality for: ${title}`, {
			reply_markup: keyboard,
			reply_to_message_id: ctx.message.message_id,
			message_thread_id: threadId,
		})
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
		if (autoDeleteProcessingMessage && processingMessage) {
			try {
				await deleteMessage(processingMessage)
			} catch {}
		}
		if (!keepLock && !lockTransferred) {
			unlockUserUrl(userId, url.text, lockId)
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
			const blockReason = getQueueBlockReason(userId, cached.url, cached.lockId)
			if (blockReason) {
				await ctx.answerCallbackQuery({ text: blockReason, show_alert: true })
				return
			}
			if (!cached.lockId) {
				await ctx.answerCallbackQuery({ text: "Request expired or invalid.", show_alert: true })
				return
			}
			requestCache.delete(requestId)
			const processing = await ctx.reply("Ставим в очередь MP3...")
			enqueueJob(userId, cached.url, cached.lockId, async () => {
				await downloadAndSend(
					ctx,
					cached.url,
					"mp3",
					true,
					processing.message_id,
					cached.title,
					ctx.callbackQuery.message?.message_id,
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
		const blockReason = getQueueBlockReason(userId, cached.url, cached.lockId)
		if (blockReason) {
			await ctx.answerCallbackQuery({ text: blockReason, show_alert: true })
			return
		}
		if (!cached.lockId) {
			await ctx.answerCallbackQuery({ text: "Request expired or invalid.", show_alert: true })
			return
		}
		requestCache.delete(requestId)
		const processing = await ctx.reply(
			`Ставим в очередь формат: ${formatString}...`,
		)
		enqueueJob(userId, cached.url, cached.lockId, async () => {
			await downloadAndSend(
				ctx,
				cached.url,
				formatString,
				true,
				processing.message_id,
				cached.title,
				ctx.callbackQuery.message?.message_id,
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
			unlockUserUrl(cached.userId, cached.url, cached.lockId)
		}
		await ctx.answerCallbackQuery({ text: "Cancelled" })
		return await ctx.deleteMessage()
	}

	const predefinedQualities = ["b", "2160", "1440", "1080", "720", "480", "audio"]
	const isRawFormat = !predefinedQualities.includes(quality)
	const userId = ctx.from?.id
	if (!userId) return
	const blockReason = getQueueBlockReason(userId, url, cached.lockId)
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
	enqueueJob(userId, url, cached.lockId, async () => {
		await downloadAndSend(
			ctx,
			url,
			quality,
			isRawFormat,
			ctx.callbackQuery.message?.message_id,
			title,
			ctx.callbackQuery.message?.reply_to_message?.message_id,
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

