import { readdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { downloadFromInfo, getInfo } from "@resync-tv/yt-dlp"
import { InlineKeyboard, InputFile } from "grammy"
import { deleteMessage, errorMessage } from "./bot-util"
import { cobaltMatcher, cobaltResolver } from "./cobalt"
import { link, t, tiktokArgs } from "./constants"
import {
	ADMIN_ID,
	ALLOW_GROUPS,
	ALWAYS_DOWNLOAD_BEST,
	API_ROOT,
	COOKIE_FILE,
	cookieArgs,
	WHITELISTED_IDS,
} from "./environment"
import { getThumbnail, urlMatcher } from "./media-util"
import { Queue } from "./queue"
import { bot } from "./setup"
import { translateText } from "./translate"
import { Updater } from "./updater"
import { chunkArray, removeHashtagsMentions } from "./util"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFilePromise = promisify(execFile)

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

const queue = new Queue()
const updater = new Updater()
const requestCache = new Map<string, string>()

const downloadAndSend = async (
	ctx: any,
	url: string,
	quality: string,
	isRawFormat = false,
) => {
	const tempFilePath = resolve("/tmp", `${randomUUID()}.mp4`)
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

		if (quality !== "audio") {
			formatArgs.push("--recode-video", "mp4")
		}

		const info = await safeGetInfo(url, [
			"--dump-json",
			...formatArgs,
			"--no-warnings",
			"--no-playlist",
			...(await cookieArgs()),
			...additionalArgs,
		])

		const title = removeHashtagsMentions(info.title)
		const caption = link(title || "Video", url)

		if (quality === "audio") {
			const stream = downloadFromInfo(info, "-", formatArgs)
			const audio = new InputFile(stream.stdout)

			await ctx.replyWithChatAction("upload_voice")
			await ctx.replyWithAudio(audio, {
				caption,
				parse_mode: "HTML",
				performer: info.uploader,
				title: info.title,
				thumbnail: getThumbnail(info.thumbnails),
				duration: info.duration,
			})
		} else {
			await execFilePromise("yt-dlp", [
				url,
				...formatArgs,
				"-o",
				tempFilePath,
				"--no-warnings",
				"--no-playlist",
				...(await cookieArgs()),
				...additionalArgs,
			])

			const video = new InputFile(tempFilePath)

			await ctx.replyWithChatAction("upload_video")
			await ctx.replyWithVideo(video, {
				caption,
				parse_mode: "HTML",
				supports_streaming: true,
				duration: info.duration,
			})
		}
	} catch (error) {
		const msg = `Error: ${error instanceof Error ? error.message : "Unknown error"}`
		if (ctx.callbackQuery) {
			await ctx.editMessageText(msg)
		} else {
			await ctx.reply(msg)
		}
	} finally {
		try {
			await unlink(tempFilePath)
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
		console.log("File path from API:", file.file_path)
		
		// In local mode with mounted volumes, getFile returns the absolute path on disk relative to the bot API working dir.
		// We mounted the volume at /var/lib/telegram-bot-api
		// Expected structure: /var/lib/telegram-bot-api/<token>/<file_path>
		
		const absPath = resolve("/var/lib/telegram-bot-api", bot.token, file.file_path)
		console.log("Trying to read from:", absPath)

		const text = await readFile(absPath, "utf-8")
		await writeFile(COOKIE_FILE, text)
		
		await ctx.reply(`Cookies updated successfully!\nLocation: ${COOKIE_FILE}`)
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

//? filter out messages from non-whitelisted users
bot.on("message:text", async (ctx, next) => {
	if (WHITELISTED_IDS.length === 0) return await next()
	if (WHITELISTED_IDS.includes(ctx.from?.id)) return await next()

	const deniedResponse = await ctx.replyWithHTML(t.deniedMessage, {
		link_preview_options: { is_disabled: true },
	})

	await Promise.all([
		(async () => {
			if (ctx.from.language_code && ctx.from.language_code !== "en") {
				const translated = await translateText(
					t.deniedMessage,
					ctx.from.language_code,
				)
				if (translated === t.deniedMessage) return
				await bot.api.editMessageText(
					ctx.chat.id,
					deniedResponse.message_id,
					translated,
					{ parse_mode: "HTML", link_preview_options: { is_disabled: true } },
				)
			}
		})(),
		(async () => {
			const forwarded = await ctx.forwardMessage(ADMIN_ID, {
				disable_notification: true,
			})
			await bot.api.setMessageReaction(
				forwarded.chat.id,
				forwarded.message_id,
				[{ type: "emoji", emoji: "🖕" }],
			)
		})(),
	])
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
			try {
				await downloadAndSend(ctx, url, requestedFormat, true)
			} finally {
				await deleteMessage(processing)
			}
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

bot.on("message:text").on("::url", async (ctx, next) => {
	const [url] = ctx.entities("url")
	if (!url) return await next()

	const processingMessage = await ctx.replyWithHTML(t.processing, {
		disable_notification: true,
	})

	if (ctx.chat.id !== ADMIN_ID) {
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
					await bot.api.sendMediaGroup(ctx.chat.id, chunk)
				}

				return true
			}

			if (resolved.status === "redirect") {
				await ctx.replyWithHTML(link("Resolved content URL", resolved.url))
				return true
			}
		} catch (error) {
			console.error("Error resolving with cobalt", error)
		}
	}

	// Move queue logic to callback, here only prepare options
	try {
		const isTiktok = urlMatcher(url.text, "tiktok.com")
		const useCobalt = cobaltMatcher(url.text)
		const additionalArgs = isTiktok ? tiktokArgs : []

		if (useCobalt) {
			if (await useCobaltResolver()) {
				await deleteMessage(processingMessage)
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
		])

		if (ALWAYS_DOWNLOAD_BEST) {
			queue.add(async () => {
				try {
					await downloadAndSend(ctx, url.text, "b")
				} finally {
					await deleteMessage(processingMessage)
				}
			})
			return
		}

		const requestId = randomUUID().split("-")[0]
		requestCache.set(requestId, url.text)
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

		await ctx.reply(`Select quality for: ${removeHashtagsMentions(info.title)}`, {
			reply_markup: keyboard,
			reply_to_message_id: ctx.message.message_id,
		})
	} catch (error) {
		if (await useCobaltResolver()) {
			await deleteMessage(processingMessage)
			return
		}
		const msg =
			error instanceof Error
				? errorMessage(ctx.chat, error.message)
				: errorMessage(ctx.chat, `Couldn't process ${url}`)
		await msg
	} finally {
		await deleteMessage(processingMessage)
	}
})

bot.on("callback_query:data", async (ctx) => {
	const data = ctx.callbackQuery.data
	if (!data.startsWith("d:")) return await ctx.answerCallbackQuery()

	const [, requestId, quality] = data.split(":")
	const url = requestCache.get(requestId)

	if (!url) {
		await ctx.answerCallbackQuery({
			text: "Request expired or invalid.",
			show_alert: true,
		})
		return await ctx.deleteMessage()
	}

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
		try {
			await downloadAndSend(ctx, url, quality)
		} finally {
			await ctx.deleteMessage()
		}
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
