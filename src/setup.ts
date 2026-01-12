import type { ParseModeFlavor } from "@grammyjs/parse-mode"
import type { Context } from "grammy"

import { hydrateReply } from "@grammyjs/parse-mode"
import express from "express"
import { Bot, webhookCallback } from "grammy"
import { API_ROOT, BOT_TOKEN, WEBHOOK_PORT, WEBHOOK_URL, ADMIN_ID } from "./environment"

export const bot = new Bot<ParseModeFlavor<Context>>(BOT_TOKEN, {
	client: { apiRoot: API_ROOT },
	botInfo: undefined,
})

bot.use(hydrateReply)

export const server = express()

server.use(express.json())

if (WEBHOOK_URL) {
	server.use(webhookCallback(bot, "express"))

	console.log(`Starting bot with root ${API_ROOT}...`)
	server.listen(WEBHOOK_PORT, async () => {
		await bot.api.setWebhook(WEBHOOK_URL)
		await bot.api.setMyCommands([
			{ command: "formats", description: "Check available formats" },
		])

		await bot.api.setMyCommands(
			[
				{ command: "formats", description: "Check available formats" },
				{ command: "cookie", description: "Upload cookies info" },
				{ command: "clear", description: "Clear cookies" },
			],
			{ scope: { type: "chat", chat_id: ADMIN_ID } },
		)
		console.log(`Webhook set to ${WEBHOOK_URL}`)

		const me = await bot.api.getMe()
		console.log(`Bot started as @${me.username} on :${WEBHOOK_PORT}`)
	})
} else {
	console.log(`Starting bot in POLLING mode with root ${API_ROOT}...`)
	bot.start({
		drop_pending_updates: true,
		allowed_updates: ["message", "callback_query", "my_chat_member"],
		onStart: async (me) => {
			await bot.api.setMyCommands([
				{ command: "formats", description: "Check available formats" },
			])

			await bot.api.setMyCommands(
				[
					{ command: "formats", description: "Check available formats" },
					{ command: "cookie", description: "Upload cookies info" },
					{ command: "clear", description: "Clear cookies" },
				],
				{ scope: { type: "chat", chat_id: ADMIN_ID } },
			)
			console.log(`Bot started as @${me.username} (Polling)`)
		},
	})
}
