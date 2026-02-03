import type { ParseModeFlavor } from "@grammyjs/parse-mode"
import type { Context } from "grammy"

import { hydrateReply } from "@grammyjs/parse-mode"
import express from "express"
import { Bot, webhookCallback } from "grammy"
import {
	ADMIN_ONLY,
	ADMIN_DASHBOARD_HOST,
	ADMIN_DASHBOARD_PORT,
	API_ROOT,
	BOT_TOKEN,
	WEBHOOK_PORT,
	WEBHOOK_URL,
	ADMIN_ID,
} from "./environment"
import { code, bold } from "./constants"
import { cutoffWithNotice } from "./util"
import { logErrorEntry } from "./error-log"

export const bot = new Bot<ParseModeFlavor<Context>>(BOT_TOKEN, {
	client: { apiRoot: API_ROOT },
	botInfo: undefined,
})

bot.use(hydrateReply)

bot.catch(async (err) => {
	if (ADMIN_ONLY) {
		console.error("Bot error (admin-only):", err)
		return
	}
	try {
		const title = bold("Ошибка бота.")
		const context = err.ctx?.update ? `Update: ${err.ctx.update.update_id}` : ""
		const details =
			err.error instanceof Error
				? err.error.stack || err.error.message
				: String(err.error)
		const message = [
			title,
			context,
			code(cutoffWithNotice(details)),
		]
			.filter(Boolean)
			.join("\n\n")
		logErrorEntry({
			context: "bot.catch",
			error: details,
		}).catch((logError) => {
			console.error("Failed to log error entry:", logError)
		})
		await bot.api.sendMessage(ADMIN_ID, message, { parse_mode: "HTML" })
	} catch (error) {
		console.error("Failed to notify admin about bot error:", error)
	}
})

export const server = express()

server.use(express.json())

const dashboardPort = Number.parseInt(ADMIN_DASHBOARD_PORT, 10)
const dashboardHost = ADMIN_DASHBOARD_HOST || "127.0.0.1"
const webhookPort = Number.parseInt(WEBHOOK_PORT, 10)

const defaultCommands = [
	{ command: "formats", description: "Показать доступные форматы" },
	{ command: "cancel", description: "Отменить все задания" },
]

const privateCommands = [
	...defaultCommands,
	{ command: "translate", description: "Перевести видео" },
]

const adminCommands = [
	{ command: "formats", description: "Показать доступные форматы" },
	{ command: "cancel", description: "Отменить все задания" },
	{ command: "translate", description: "Перевести видео" },
	{ command: "cookie", description: "Upload cookies info" },
	{ command: "clear", description: "Clear cookies" },
	{ command: "proxy", description: "Set proxy for yt-dlp" },
	{ command: "user", description: "Show user profile" },
	{ command: "ban", description: "Ban user by ID" },
	{ command: "unban", description: "Unban user by ID" },
	{ command: "stats", description: "Show user stats" },
	{ command: "send", description: "Send replied media to user" },
]

const setCommandsSafely = async () => {
	try {
		await bot.api.setMyCommands(defaultCommands)
		await bot.api.setMyCommands(privateCommands, {
			scope: { type: "all_private_chats" },
		})
	} catch (error) {
		console.error("Failed to set bot commands:", error)
	}
	try {
		await bot.api.setMyCommands(adminCommands, {
			scope: { type: "chat", chat_id: ADMIN_ID },
		})
	} catch (error) {
		console.error("Failed to set admin commands:", error)
	}
}

const startDashboardServer = () => {
	if (!Number.isFinite(dashboardPort) || dashboardPort <= 0) {
		console.warn("ADMIN_DASHBOARD_PORT is invalid, admin panel is disabled.")
		return
	}
	const httpServer = server.listen(dashboardPort, dashboardHost, () => {
		console.log(`Admin HTTP server listening on http://${dashboardHost}:${dashboardPort}`)
	})
	httpServer.on("error", (error) => {
		console.error("Admin HTTP server error:", error)
	})
}

if (ADMIN_ONLY) {
	startDashboardServer()
	console.log("Bot start skipped (ADMIN_ONLY=true).")
} else if (WEBHOOK_URL) {
	server.use(webhookCallback(bot, "express"))

	console.log(`Starting bot with root ${API_ROOT}...`)
	const httpServer = server.listen(webhookPort, () => {
		void (async () => {
			try {
				await bot.api.setWebhook(WEBHOOK_URL)
				await setCommandsSafely()
				console.log(`Webhook set to ${WEBHOOK_URL}`)
				const me = await bot.api.getMe()
				console.log(`Bot started as @${me.username} on :${webhookPort}`)
			} catch (error) {
				console.error("Failed to start webhook bot:", error)
			}
		})()
	})
	httpServer.on("error", (error) => {
		console.error("Webhook server error:", error)
	})

	if (
		Number.isFinite(dashboardPort) &&
		(dashboardPort !== webhookPort || dashboardHost !== "0.0.0.0")
	) {
		startDashboardServer()
	}
} else {
	console.log(`Starting bot in POLLING mode with root ${API_ROOT}...`)
	startDashboardServer()
	bot.start({
		drop_pending_updates: true,
		allowed_updates: ["message", "callback_query", "my_chat_member"],
		onStart: async (me) => {
			try {
				await setCommandsSafely()
				console.log(`Bot started as @${me.username} (Polling)`)
			} catch (error) {
				console.error("Failed to initialize polling bot:", error)
			}
		},
	})
}
