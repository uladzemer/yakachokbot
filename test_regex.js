const cobaltRegexes = [
	/^(?:https:\/\/)?(?:www\.)?tiktok\.com\/@\w+\/photo\/\d+.*/,
	/^(?:https:\/\/)?(?:www\.)?threads\.net\/@\w+\/post\/.+/,
]

const url = "https://www.threads.net/@papamakara/post/DTZ2oW5kt5n?xmt=AQF0qF_Y6evC672po60lxmxtqq-h45to6XYp9dx07hHabyK_O916H2VfrY_76v8GWskfHHw&slof=1"

const match = cobaltRegexes.findIndex((regex) => regex.test(url)) > -1
console.log("Match:", match)
