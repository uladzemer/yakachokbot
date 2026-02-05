import { updateYTDLP } from "@resync-tv/yt-dlp"
import { Cron } from "croner"
import { YTDL_AUTOUPDATE } from "./environment"

export class Updater {
	public readonly enabled = YTDL_AUTOUPDATE
	public updating: Promise<void> | false = false

	#job: Cron | null = null

	constructor() {
		console.log("Auto-update is", this.enabled ? "enabled" : "disabled")
		if (!this.enabled) return

		this.#job = new Cron("20 4 * * *", () => void this.update("cron"))

		const initialDelayMs = 15000
		setTimeout(() => {
			void this.update("startup")
		}, initialDelayMs).unref()

		console.log(
			`Initial update scheduled in ${Math.round(initialDelayMs / 1000)}s`,
		)
		console.log("Next update scheduled at", this.#job.nextRun())
	}

	update = async (reason = "manual") => {
		if (this.updating) {
			console.log("yt-dlp update already in progress")
			return this.updating
		}
		const run = this.#update(reason)
		this.updating = run
		try {
			await run
		} finally {
			this.updating = false
		}
	}

	async #update(reason: string) {
		console.log(`updating yt-dlp (${reason})`)

		try {
			const result = await updateYTDLP()

			console.log(result.stdout)
			console.log("yt-dlp updated")
		} catch (error) {
			if (error instanceof Error) {
				console.error("yt-dlp update failed")
				console.error(error.message)
			}
		} finally {
			if (this.#job) {
				console.log("Next update scheduled at", this.#job.nextRun())
			}
		}
	}
}
