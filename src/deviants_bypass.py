import html
import json
import re
import sys
from curl_cffi import requests


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def fetch_page(url: str) -> tuple[int, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    response = requests.get(
        url,
        impersonate="chrome120",
        headers=headers,
        timeout=30,
        allow_redirects=True,
    )
    return response.status_code, response.text


def extract_title(page: str) -> str | None:
    for pattern in [
        r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"',
        r"<title>(.*?)</title>",
    ]:
        match = re.search(pattern, page, re.I | re.S)
        if match:
            return html.unescape(match.group(1)).strip()
    return None


def normalize_url(value: str) -> str:
    return html.unescape(value.replace("\\/", "/").replace("\\u0026", "&")).strip()


def extract_candidates(page: str) -> list[str]:
    candidates: list[str] = []
    patterns = [
        r'<meta[^>]+property="og:video(?::secure_url)?"[^>]+content="([^"]+)"',
        r'<source[^>]+src="([^"]+\.(?:m3u8|mp4)[^"]*)"',
        r'"(?:videoUrl|video_url|playback_url|file|src|url|hls|hlsUrl|stream_url)"\s*:\s*"([^"]+)"',
        r"(https?://[^\s\"'<>]+?\.(?:m3u8|mp4)[^\s\"'<>]*)",
    ]

    for pattern in patterns:
        for match in re.findall(pattern, page, re.I):
            url = normalize_url(match)
            if not url.startswith("http"):
                continue
            candidates.append(url)

    deduped: list[str] = []
    seen: set[str] = set()
    for url in candidates:
        if url in seen:
            continue
        seen.add(url)
        deduped.append(url)
    return deduped


def score_url(url: str) -> tuple[int, int, int]:
    lower = url.lower()
    quality = 0
    quality_match = re.search(r"(\d{3,4})p", lower)
    if quality_match:
        quality = int(quality_match.group(1))

    direct_mp4 = 1 if ".mp4" in lower else 0
    preferred_host = 1 if "deviants.com" in lower else 0
    return (preferred_host, direct_mp4, quality)


def pick_best(candidates: list[str]) -> str | None:
    if not candidates:
        return None
    return max(candidates, key=score_url)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        return

    url = sys.argv[1]
    try:
        status, page = fetch_page(url)
        if status >= 400:
            print(json.dumps({"error": f"HTTP {status}"}))
            return

        if "cf-mitigated" in page or "Just a moment..." in page:
            print(json.dumps({"error": "Cloudflare challenge"}))
            return

        title = extract_title(page)
        candidates = extract_candidates(page)
        best = pick_best(candidates)
        if not best:
            print(json.dumps({"error": "No video URL found", "title": title}))
            return

        print(json.dumps({"video_url": best, "video_urls": candidates, "title": title}))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))


if __name__ == "__main__":
    main()
