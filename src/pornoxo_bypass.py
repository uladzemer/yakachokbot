import html
import json
import re
import sys
import urllib.request


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def fetch_html(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read().decode("utf-8", "ignore")


def extract_title(page: str) -> str | None:
    match = re.search(r"<title>(.*?)</title>", page, re.I | re.S)
    if not match:
        return None
    title = html.unescape(match.group(1)).strip()
    return title.replace("PornoXO.com - ", "").strip()


def extract_embed_url(page: str) -> str | None:
    match = re.search(r"https?://www\\.pornoxo\\.com/embed/\d+/\d+/?", page)
    if match:
        return match.group(0)
    match = re.search(
        r'embedUrl"\s*:\s*"(?P<url>https?:\\/\\/www\\.pornoxo\\.com\\/embed\\/\\d+\\/\\d+\\/?)"',
        page,
    )
    if match:
        return match.group("url").replace("\\/", "/")
    match = re.search(r"/embed/\d+/\d+/?", page)
    if match:
        return f"https://www.pornoxo.com{match.group(0)}"
    return None


def extract_sources(page: str):
    match = re.search(r"var\s+sources\s*=\s*(\[.*?\]);", page, re.S)
    if not match:
        return []
    raw = match.group(1)
    try:
        return json.loads(raw)
    except Exception:
        return []


def extract_multi_source(page: str) -> str | None:
    match = re.search(r"var\s+multiSource\s*=\s*'([^']*)'", page)
    if not match:
        return None
    value = match.group(1).strip()
    return value or None


def pick_best_source(sources: list[dict]) -> str | None:
    if not sources:
        return None
    for source in sources:
        if str(source.get("active", "")).lower() in ("true", "1"):
            if isinstance(source.get("src"), str):
                return source["src"]
    def score(item: dict) -> int:
        desc = str(item.get("desc", ""))
        match = re.search(r"(\d+)", desc)
        return int(match.group(1)) if match else 0
    best = max(sources, key=score)
    return best.get("src") if isinstance(best.get("src"), str) else None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        return

    url = sys.argv[1]
    try:
        page = fetch_html(url)
        title = extract_title(page)
        embed_url = url if "/embed/" in url else extract_embed_url(page)
        if not embed_url:
            print(json.dumps({"error": "Embed URL not found", "title": title}))
            return

        embed_page = fetch_html(embed_url)
        embed_title = extract_title(embed_page) or title
        multi = extract_multi_source(embed_page)
        if multi:
            print(json.dumps({"video_url": multi, "title": embed_title}))
            return
        sources = extract_sources(embed_page)
        if not sources:
            print(json.dumps({"error": "Sources not found", "title": embed_title}))
            return
        best = pick_best_source(sources)
        if not best:
            print(json.dumps({"error": "No valid sources", "title": embed_title}))
            return
        all_urls = [
            source["src"]
            for source in sources
            if isinstance(source, dict) and isinstance(source.get("src"), str)
        ]
        print(json.dumps({"video_url": best, "video_urls": all_urls, "title": embed_title}))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))


if __name__ == "__main__":
    main()
