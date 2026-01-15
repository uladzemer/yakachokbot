import { t } from "./constants"

export const removeHashtagsMentions = (text?: string) => {
	if (!text) return

	return text.replaceAll(/[#@]\S+/g, "").trim()
}

export const chunkArray = <T>(chunkSize: number, array: T[]) => {
	const result = []

	for (let i = 0; i < array.length; i += chunkSize) {
		result.push(array.slice(i, i + chunkSize))
	}

	return result
}

export const cutoffWithNotice = (text: string) => {
	const noticeLength = t.cutoffNotice.length

	if (text.length > 4000 - noticeLength) {
		return text.slice(0, 4000 - noticeLength) + t.cutoffNotice
	}

	return text
}

export const cleanUrl = (url: string) => {
	try {
		const u = new URL(url)
		const keysToDelete = []
		for (const key of u.searchParams.keys()) {
			if (
				key.startsWith("utm_") ||
				[
					"igsh",
					"si",
					"fbclid",
					"gclid",
					"feature",
					"share",
					"ref",
					"ref_src",
					"ref_url",
					"list",
					"index",
					"start_radio",
					"rv",
					"pp",
					"ab_channel",
					"_t",
					"_r",
					"tt_from",
					"sender_device",
					"web_id",
					"is_from_webapp",
					"is_copy_url",
					"xmt",
				].includes(key)
			) {
				keysToDelete.push(key)
			}
		}
		keysToDelete.forEach((key) => u.searchParams.delete(key))
		return u.toString()
	} catch {
		return url
	}
}
