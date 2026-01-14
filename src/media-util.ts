import type { ytDlpInfo } from "@resync-tv/yt-dlp"
import { InputFile } from "grammy"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFilePromise = promisify(execFile)

export const urlMatcher = (url: string, matcher: string) => {
	const parsed = new URL(url)
	return parsed.hostname.endsWith(matcher)
}

export const getVideoMetadata = async (filePath: string) => {
	try {
		const { stdout } = await execFilePromise("ffprobe", [
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=width,height,duration,sample_aspect_ratio",
			"-of",
			"json",
			filePath,
		])
		const data = JSON.parse(stdout)
		const stream = data.streams?.[0]

		if (!stream) return {}

		let width = Number(stream.width)
		const height = Number(stream.height)
		const duration = stream.duration ? Math.ceil(Number(stream.duration)) : undefined

		// Handle Sample Aspect Ratio (SAR) if present (e.g. "16:9", "64:45")
		// SAR tells us that pixels aren't square. Display Width = Width * SAR.
		if (stream.sample_aspect_ratio && stream.sample_aspect_ratio !== "N/A") {
			const parts = stream.sample_aspect_ratio.split(":")
			if (parts.length === 2) {
				const num = Number(parts[0])
				const den = Number(parts[1])
				if (num > 0 && den > 0 && num !== den) {
					// We usually keep height constant and adjust width for display aspect ratio
					width = Math.round(width * (num / den))
				}
			}
		}

		return { width, height, duration }
	} catch (e) {
		console.error("ffprobe error:", e)
		return {}
	}
}

export const generateThumbnail = async (videoPath: string, thumbnailPath: string) => {
	try {
		// Extract a frame at 00:00:01, scale to max 320px width/height while keeping aspect ratio
		await execFilePromise("ffmpeg", [
			"-y",
			"-i",
			videoPath,
			"-ss",
			"00:00:01",
			"-vframes",
			"1",
			"-vf",
			"scale='min(320,iw)':-1",
			"-q:v",
			"2",
			thumbnailPath,
		])
		return thumbnailPath
	} catch (e) {
		console.error("ffmpeg thumbnail generation error:", e)
		return undefined
	}
}

/**
 * Gets a fitting thumbnail for the `sendAudio` method.
 *
 * https://core.telegram.org/bots/api#sendaudio
 */
export const getThumbnail = (thumbnails?: ytDlpInfo.Thumbnail[]) => {
	if (!thumbnails) return undefined

	const MAX_SIZE = 320

	// Thumbnail sizes go from smallest to largest
	const reversed = [...thumbnails].reverse()

	const match = reversed.find((thumbnail) => {
		const { width, height, resolution } = thumbnail

		if (width && height) {
			return width <= MAX_SIZE && height <= MAX_SIZE
		}

		if (resolution) {
			const [w, h] = resolution.split("x").map((n) => Number.parseInt(n))
			if (!w || !h) return false

			return w <= MAX_SIZE && h <= MAX_SIZE
		}

		return false
	})

	if (match) return new InputFile({ url: match.url })
}
