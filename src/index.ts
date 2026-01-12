import { readdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { downloadFromInfo, getInfo } from "@resync-tv/yt-dlp"
import { InlineKeyboard, InputFile } from "grammy"
import { deleteMessage, errorMessage } from "./bot-util"
import { cobaltMatcher, cobaltResolver } from "./cobalt"
import { link, t, tiktokArgs, impersonateArgs } from "./constants"
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
import { chunkArray, removeHashtagsMentions } from "./util"
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
	console.log("Running yt-dlp with:", args)
	const { stdout } = await execFilePromise("yt-dlp", [url, ...args])
	// Split by newline and try to parse the first valid JSON line
	const lines = stdout.split("\n").filter((l) => l.trim().length > 0)
	for (const line of lines) {
		try {
			return JSON.parse(line)
		} catch {}
	}
	throw new Error("No valid JSON found in yt-dlp output")
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
const updater = new Updater()
const requestCache = new Map<string, { url: string; title?: string }>()

const downloadAndSend = async (
	ctx: any,
	url: string,
	quality: string,
	isRawFormat = false,
	statusMessageId?: number,
	overrideTitle?: string,
	replyToMessageId?: number,
) => {
	const tempFilePath = resolve("/tmp", `${randomUUID()}.mp4`)
	const tempThumbPath = resolve("/tmp", `${randomUUID()}.jpg`)
	const threadId = ctx.message?.message_thread_id || ctx.callbackQuery?.message?.message_thread_id
	
	try {
		const isTiktok = urlMatcher(url, "tiktok.com")
		const additionalArgs = isTiktok ? tiktokArgs : []

		let formatArgs: string[] = []
		if (isRawFormat) {
			formatArgs = ["-f", quality]
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
			await updateMessage(ctx, statusMessageId, "Fetching video info...")
		}

		const info = await safeGetInfo(url, [
			"--dump-json",
			...formatArgs,
			"--no-warnings",
			"--no-playlist",
			...(await cookieArgs()),
			...additionalArgs,
			...impersonateArgs,
		])

		const title = overrideTitle || removeHashtagsMentions(info.title)
		const caption = link(title || "Video", url)

		if (quality !== "audio") {
			const vcodec = info.vcodec || ""
			const isGoodCodec = /avc|h264|hevc|h265/i.test(vcodec)

			if (!isGoodCodec) {
				formatArgs.push("--recode-video", "mp4")
			} else {
				formatArgs.push("--merge-output-format", "mp4")
			}
		}

		if (quality === "audio") {
			if (statusMessageId) {
				await updateMessage(
					ctx,
					statusMessageId,
					`Processing: <b>${title}</b>\nStatus: Downloading audio...`,
				)
			}
			const stream = downloadFromInfo(info, "-", formatArgs)
			const audio = new InputFile(stream.stdout)

			if (statusMessageId) {
				await updateMessage(
					ctx,
					statusMessageId,
					`Processing: <b>${title}</b>\nStatus: Uploading...`,
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
				reply_to_message_id: replyToMessageId,
				message_thread_id: threadId,
			})
			if (statusMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat.id, statusMessageId)
				} catch {}
			}
		} else {
			let progressText = "Downloading..."
			const onProgress = (data: string) => {
				if (!statusMessageId) return

				if (data.includes("[download]") && data.includes("%")) {
					const match = data.match(/(\d+\.\d+)%/)
					if (match) progressText = `Downloading: ${match[1]}%`
				} else if (data.includes("[Merger]")) {
					progressText = "Merging audio and video..."
				} else if (data.includes("[VideoConvertor]")) {
					progressText = "Converting to MP4..."
				}

				updateMessage(
					ctx,
					statusMessageId,
					`Processing: <b>${title}</b>\nStatus: ${progressText}`,
				)
			}

			await spawnPromise(
				"yt-dlp",
				[
					url,
					...formatArgs,
					"-o",
					tempFilePath,
					"--no-warnings",
					"--no-playlist",
					...(await cookieArgs()),
					...additionalArgs,
					...impersonateArgs,
				],
				onProgress,
			)

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
					`Processing: <b>${title}</b>\nStatus: Uploading...`,
				)
			}

			await ctx.replyWithChatAction("upload_video")
			await ctx.replyWithVideo(video, {
				caption,
				parse_mode: "HTML",
				supports_streaming: true,
				duration,
				width,
				height,
				thumbnail: thumbFile,
				reply_to_message_id: replyToMessageId,
				message_thread_id: threadId,
			})

			if (statusMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat.id, statusMessageId)
				} catch {}
			}
		}
		console.log(`[SUCCESS] Sent video to chat ${ctx.chat.id}`)
	} catch (error) {
		console.error(`[ERROR] Failed to download/send ${url}:`, error)
		const msg = `Error: ${error instanceof Error ? error.message : "Unknown error"}`
		if (statusMessageId) {
			await updateMessage(ctx, statusMessageId, msg)
		} else if (ctx.callbackQuery) {
			await ctx.editMessageText(msg)
		} else if (ctx.chat.type === "private") {
			await ctx.reply(msg)
		}
	} finally {
		try {
			await unlink(tempFilePath)
			await unlink(tempThumbPath)
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
		await unlink(COOKIE_FILE)
		await ctx.reply("Cookies deleted successfully.")
	} catch (error) {
		await ctx.reply("No cookies found or could not delete.")
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

	const processing = await ctx.reply("Updating cookies...")
	try {
		const file = await ctx.api.getFile(doc.file_id)
		const absPath = resolve("/var/lib/telegram-bot-api", bot.token, file.file_path)
		const newContent = await readFile(absPath, "utf-8")

		let currentContent = ""
		try {
			currentContent = await readFile(COOKIE_FILE, "utf-8")
		} catch {}

		// Ensure there's a newline between old and new content
		const separator = currentContent.length > 0 && !currentContent.endsWith("\n") ? "\n" : ""
		await writeFile(COOKIE_FILE, currentContent + separator + newContent)
		
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

		await ctx.reply(`DEBUG ERROR: ${error instanceof Error ? error.message : "Unknown"}${debugInfo}`)
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

bot.command("formats", async (ctx) => {
	const args = ctx.match?.split(/\s+/)
	const url = args?.[0]
	const requestedFormat = args?.[1]

	if (!url) {
		return ctx.reply("Usage: /formats <url> [format_id]\nExample: /formats <url> 137+140")
	}

	if (requestedFormat) {
		const processing = await ctx.reply(
			`Queuing download for format: ${requestedFormat}...`,
		)
		queue.add(async () => {
			await downloadAndSend(
				ctx,
				url,
				requestedFormat,
				true,
				processing.message_id,
				undefined,
				ctx.message.message_id,
			)
		})
		return
	}

	const processing = await ctx.reply("Fetching formats...")
	try {
		const info = await safeGetInfo(url, ["--dump-json", "--no-warnings", "--no-playlist", ...(await cookieArgs())])

		if (!info.formats || info.formats.length === 0) {
			await ctx.reply("No formats found.")
			return
		}

		// Header
		let output =
			"ID | EXT | RES | FPS | SIZE | VCODEC | ACODEC\n" +
			"---|-----|-----|-----|------|--------|-------\n"

		// Rows
		for (const f of info.formats) {
			const filesize = f.filesize
				? `${(f.filesize / 1024 / 1024).toFixed(1)}MiB`
				: f.filesize_approx
					? `~${(f.filesize_approx / 1024 / 1024).toFixed(1)}MiB`
					: "N/A"

			const vcodec =
				f.vcodec && f.vcodec !== "none"
					? f.vcodec.split(".")[0]
					: f.acodec !== "none"
						? "audio"
						: "none"

			const acodec =
				f.acodec && f.acodec !== "none" ? f.acodec.split(".")[0] : "none"

			const fps = f.fps ? f.fps : ""
			const res = f.resolution || (f.width ? `${f.width}x${f.height}` : "audio")

			output += `${f.format_id} | ${f.ext} | ${res} | ${fps} | ${filesize} | ${vcodec} | ${acodec}\n`
		}

		if (output.length > 4000) {
			const buffer = Buffer.from(output, "utf-8")
			await ctx.replyWithDocument(new InputFile(buffer, "formats.txt"), {
				caption: `Available formats for: ${info.title}`,
			})
		} else {
			await ctx.replyWithHTML(`<pre>${output}</pre>`)
		}
	} catch (error) {
		await ctx.reply(`Error: ${error instanceof Error ? error.message : "Unknown"}`)
	} finally {
		await deleteMessage(processing)
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
	const [url] = ctx.entities("url")
	if (!url) return await next()

	console.log(`[DEBUG] Received URL in chat ${ctx.chat.id} (${ctx.chat.type}): ${url.text}`)

	const isPrivate = ctx.chat.type === "private"
	const threadId = ctx.message.message_thread_id
	let processingMessage: any

	if (isPrivate) {
		processingMessage = await ctx.replyWithHTML(t.processing, {
			disable_notification: true,
			reply_to_message_id: ctx.message.message_id,
		})
	}

	let autoDeleteProcessingMessage = true

	if (isPrivate && ctx.chat.id !== ADMIN_ID) {
		ctx
			.forwardMessage(ADMIN_ID, { disable_notification: true })
			.then(async (forwarded) => {
				await bot.api.setMessageReaction(
					forwarded.chat.id,
					forwarded.message_id,
					[{ type: "emoji", emoji: "🤝" }],
				)
			})
	}

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

			if (resolved.status === "redirect") {
				await ctx.replyWithHTML(link("Resolved content URL", resolved.url), {
					reply_to_message_id: ctx.message.message_id,
					message_thread_id: threadId,
				})
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
			...(await cookieArgs()),
			...additionalArgs,
			...impersonateArgs,
		])

		const title = bypassTitle || removeHashtagsMentions(info.title)

		// If group chat OR always download best is enabled -> Auto download
		if (!isPrivate || ALWAYS_DOWNLOAD_BEST) {
			autoDeleteProcessingMessage = false
			queue.add(async () => {
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
			return
		}

		const requestId = randomUUID().split("-")[0]
		requestCache.set(requestId, { url: url.text, title })
		// Expire cache after 1 hour
		setTimeout(() => requestCache.delete(requestId), 3600000)

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
	}
})

bot.on("callback_query:data", async (ctx) => {
	const data = ctx.callbackQuery.data
	if (!data.startsWith("d:")) return await ctx.answerCallbackQuery()

	const [, requestId, quality] = data.split(":")
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
		await ctx.answerCallbackQuery({ text: "Cancelled" })
		return await ctx.deleteMessage()
	}

	await ctx.answerCallbackQuery({ text: "Queued for download..." })
	await ctx.editMessageText(
		`Downloading ${quality === "b" ? "Best" : quality}...`,
	)

	queue.add(async () => {
		await downloadAndSend(
			ctx,
			url,
			quality,
			false,
			ctx.callbackQuery.message?.message_id,
			title,
			ctx.callbackQuery.message?.reply_to_message?.message_id,
		)
	})
})
bot.on("message:text", async (ctx) => {
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
