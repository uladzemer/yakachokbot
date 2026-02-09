import html
import json
import re
import sys
from urllib.parse import urljoin, urlparse


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def fetch_html(url: str) -> tuple[int, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    try:
        from curl_cffi import requests  # type: ignore

        response = requests.get(
            url,
            impersonate="chrome120",
            headers=headers,
            timeout=30,
            allow_redirects=True,
        )
        return response.status_code, response.text
    except Exception:
        import urllib.request

        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=15) as response:
            status = getattr(response, "status", 200)
            body = response.read().decode("utf-8", "ignore")
            return status, body


def extract_title(page: str) -> str | None:
    for pattern in [
        r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"',
        r'<meta[^>]+name="twitter:title"[^>]+content="([^"]+)"',
        r"<title>(.*?)</title>",
    ]:
        match = re.search(pattern, page, re.I | re.S)
        if match:
            return html.unescape(match.group(1)).strip()
    return None


def normalize_candidate(raw: str, base_url: str) -> str | None:
    value = (
        raw.replace("\\/", "/")
        .replace("\\u0026", "&")
        .replace("\\u003D", "=")
        .replace("&amp;", "&")
    )
    value = html.unescape(value).strip()
    if not value:
        return None

    if value.startswith("//"):
        value = f"https:{value}"
    elif value.startswith("/"):
        value = urljoin(base_url, value)

    if not value.startswith("http://") and not value.startswith("https://"):
        return None

    lowered = value.lower()
    if any(
        token in lowered
        for token in [
            "doubleclick.net",
            "googlesyndication.com",
            "google-analytics.com",
            "adservice.",
            "/ads/",
            ".vtt",
            ".srt",
        ]
    ):
        return None

    return value


def collect_candidates(page: str, base_url: str) -> list[str]:
    candidates: list[str] = []

    patterns = [
        r'<meta[^>]+property="og:video(?::secure_url)?"[^>]+content="([^"]+)"',
        r'<meta[^>]+name="twitter:player:stream"[^>]+content="([^"]+)"',
        r'<source[^>]+src="([^"]+)"',
        r'<video[^>]+src="([^"]+)"',
        r'<iframe[^>]+src="([^"]+)"',
        r'"(?:videoUrl|video_url|playback_url|stream_url|hlsUrl|hls_url|dash_url|file|src|url)"\s*:\s*"([^"]+)"',
        r"(https?://[^\s\"'<>]+)",
    ]

    for pattern in patterns:
        for match in re.findall(pattern, page, re.I):
            candidate = normalize_candidate(match, base_url)
            if candidate:
                candidates.append(candidate)

    seen: set[str] = set()
    unique: list[str] = []
    for item in candidates:
        if item in seen:
            continue
        seen.add(item)
        unique.append(item)
    return unique


def score_candidate(url: str, source_host: str) -> tuple[int, int, int, int]:
    lowered = url.lower()
    parsed = urlparse(url)
    host = parsed.hostname or ""

    is_media_like = int(
        any(ext in lowered for ext in [".mp4", ".m3u8", ".mpd", ".webm", ".mov"])
    )
    is_embed_like = int(any(tag in host for tag in ["vimeo.com", "youtube.com", "youtu.be"]))
    same_host = int(host == source_host or host.endswith(f".{source_host}"))

    quality = 0
    quality_match = re.search(r"(\d{3,4})p", lowered)
    if quality_match:
        quality = int(quality_match.group(1))

    return (is_media_like, is_embed_like, same_host, quality)


def pick_best(candidates: list[str], source_url: str) -> str | None:
    if not candidates:
        return None
    source_host = urlparse(source_url).hostname or ""
    return max(candidates, key=lambda item: score_candidate(item, source_host))


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        return

    url = sys.argv[1]
    try:
        status, page = fetch_html(url)
        if status >= 400:
            print(json.dumps({"error": f"HTTP {status}"}))
            return

        if "cf-mitigated" in page or "Just a moment..." in page:
            print(json.dumps({"error": "Cloudflare challenge"}))
            return

        title = extract_title(page)
        candidates = collect_candidates(page, url)
        best = pick_best(candidates, url)
        if not best:
            print(json.dumps({"error": "No media URL found", "title": title}))
            return

        print(json.dumps({"video_url": best, "video_urls": candidates, "title": title}))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))


if __name__ == "__main__":
    main()
