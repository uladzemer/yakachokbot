import { stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

const getVariable = (key: string, defaultValue?: string) => {
	const value = process.env[key]

	if (value) return value
	if (defaultValue !== undefined) return defaultValue

	throw new Error(`Environment variable ${key} is not set`)
}

export const YTDL_AUTOUPDATE =
	getVariable("YTDL_AUTOUPDATE", "true") !== "false"
export const WEBHOOK_PORT = getVariable("TELEGRAM_WEBHOOK_PORT", "8443")
export const WEBHOOK_URL = getVariable("TELEGRAM_WEBHOOK_URL", "")
export const API_ROOT = getVariable("TELEGRAM_API_ROOT")
export const BOT_TOKEN = getVariable("TELEGRAM_BOT_TOKEN")
export const ADMIN_ID = Number.parseInt(getVariable("ADMIN_ID"))
export const WHITELISTED_IDS = getVariable("WHITELISTED_IDS", "")
	.split(",")
	.map((id) => Number.parseInt(id))
	.filter((id) => !Number.isNaN(id))
export const ALLOW_GROUPS = getVariable("ALLOW_GROUPS", "true") !== "false"
export const OPENAI_API_KEY = getVariable("OPENAI_API_KEY", "")
export const COBALT_INSTANCE_URL = getVariable("COBALT_INSTANCE_URL", "")
export const YTDL_PROXY = getVariable("YTDL_PROXY", "")
export const ADMIN_DASHBOARD_TOKEN = getVariable("ADMIN_DASHBOARD_TOKEN", "")
export const ADMIN_DASHBOARD_PORT = getVariable("ADMIN_DASHBOARD_PORT", "3000")
export const ADMIN_DASHBOARD_HOST = getVariable("ADMIN_DASHBOARD_HOST", "127.0.0.1")
export const ADMIN_ONLY = getVariable("ADMIN_ONLY", "false") === "true"
export const ADMIN_DASHBOARD_USER = getVariable("ADMIN_DASHBOARD_USER", "")
export const ADMIN_DASHBOARD_PASSWORD = getVariable("ADMIN_DASHBOARD_PASSWORD", "")
export const ALWAYS_DOWNLOAD_BEST = getVariable("ALWAYS_DOWNLOAD_BEST", "false") !== "false"
export const VOT_REQUEST_LANG = getVariable("VOT_REQUEST_LANG", "auto")
export const VOT_RESPONSE_LANG = getVariable("VOT_RESPONSE_LANG", "ru")
export const VOT_WORKER_HOST = getVariable("VOT_WORKER_HOST", "")
export const VOT_WORKER_FALLBACK_SECONDS = Number.parseInt(
	getVariable("VOT_WORKER_FALLBACK_SECONDS", "180"),
)
export const VOT_STATUS_VERBOSE = getVariable("VOT_STATUS_VERBOSE", "false") === "true"
export const VOT_LIVELY_VOICE = getVariable("VOT_LIVELY_VOICE", "false") === "true"
export const VOT_OAUTH_TOKEN = getVariable("VOT_OAUTH_TOKEN", "")
export const VOT_MAX_WAIT_SECONDS = Number.parseInt(
	getVariable("VOT_MAX_WAIT_SECONDS", "900"),
)
export const CLEANUP_INTERVAL_HOURS = Number.parseInt(
	getVariable("CLEANUP_INTERVAL_HOURS", "6"),
)
export const CLEANUP_MAX_AGE_HOURS = Number.parseInt(
	getVariable("CLEANUP_MAX_AGE_HOURS", "12"),
)

export const STORAGE_DIR = getVariable("STORAGE_DIR", resolve(__dirname, "../storage"))
export const COOKIE_FILE = resolve(STORAGE_DIR, "cookies.txt")
export const PROXY_FILE = resolve(STORAGE_DIR, "proxy.txt")
export const USERS_FILE = resolve(STORAGE_DIR, "users.json")
export const BANS_FILE = resolve(STORAGE_DIR, "bans.json")
export const LINKS_FILE = resolve(STORAGE_DIR, "links.json")
export const ERRORS_FILE = resolve(STORAGE_DIR, "errors.json")
export const ACTIVITY_FILE = resolve(STORAGE_DIR, "activity.json")
export const SYSTEM_HISTORY_FILE = resolve(STORAGE_DIR, "system_history.json")
export const cookieArgs = async () => {
	try {
		const stats = await stat(COOKIE_FILE)
		if (stats.isFile()) {
			return ["--cookies", COOKIE_FILE]
		}
	} catch {}

	return []
}
