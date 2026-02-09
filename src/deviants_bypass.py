import html
import json
import re
import sys
import urllib.parse
from curl_cffi import requests


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def fetch_page(url: str, session: requests.Session | None = None) -> tuple[int, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    client = session if session is not None else requests
    response = client.get(
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


def canonical_deviants_page_url(url: str) -> str:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return url
    path = parsed.path or ""
    if "/get_file/" not in path:
        return url

    parts = [part for part in path.split("/") if part]
    # Typical form:
    # /get_file/<n>/<hash>/<bucket>/<video_id>/<video_id>_720p.mp4/
    video_id = ""
    if len(parts) >= 2:
        for part in reversed(parts):
            if part.isdigit() and len(part) >= 4:
                video_id = part
                break
            match = re.match(r"^(\d{4,})_", part)
            if match:
                video_id = match.group(1)
                break
    if not video_id:
        return url
    return f"{parsed.scheme or 'https'}://{parsed.netloc or 'www.deviants.com'}/videos/{video_id}/"


def kvs_get_license_token(license_code: str) -> list[int]:
    code = license_code.replace("$", "")
    license_values = [int(char) for char in code]
    modlicense = code.replace("0", "1")
    center = len(modlicense) // 2
    fronthalf = int(modlicense[: center + 1])
    backhalf = int(modlicense[center:])
    modlicense = str(4 * abs(fronthalf - backhalf))[: center + 1]
    return [
        (license_values[index + offset] + current) % 10
        for index, current in enumerate(map(int, modlicense))
        for offset in range(4)
    ]


def kvs_get_real_url(video_url: str, license_code: str) -> str:
    if not video_url.startswith("function/0/"):
        return video_url

    parsed = urllib.parse.urlparse(video_url[len("function/0/") :])
    license_token = kvs_get_license_token(license_code)
    urlparts = parsed.path.split("/")
    if len(urlparts) < 4:
        return video_url[len("function/0/") :]

    hash_len = 32
    hash_part = urlparts[3][:hash_len]
    indices = list(range(hash_len))
    accum = 0
    for src in reversed(range(hash_len)):
        accum += license_token[src]
        dest = (src + accum) % hash_len
        indices[src], indices[dest] = indices[dest], indices[src]
    urlparts[3] = "".join(hash_part[index] for index in indices) + urlparts[3][hash_len:]
    return urllib.parse.urlunparse(parsed._replace(path="/".join(urlparts)))


def extract_kvs_video_urls(page: str) -> list[str]:
    license_match = re.search(r"license_code:\s*'([^']+)'", page)
    if not license_match:
        return []
    license_code = license_match.group(1).strip()
    if not license_code:
        return []

    raw_urls = re.findall(r"video_(?:url|alt_url\d*):\s*'([^']+)'", page)
    urls: list[str] = []
    for raw in raw_urls:
        value = normalize_url(raw)
        if not value:
            continue
        resolved = kvs_get_real_url(value, license_code)
        normalized = normalize_url(resolved)
        if normalized.startswith("http"):
            urls.append(normalized)
    return urls


def extract_candidates(page: str) -> list[str]:
    candidates: list[str] = extract_kvs_video_urls(page)
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


def resolve_get_file_url(session: requests.Session, referer: str, url: str) -> str | None:
    try:
        response = session.get(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "*/*",
                "Referer": referer,
            },
            impersonate="chrome120",
            timeout=10,
            allow_redirects=True,
        )
        status = response.status_code
        final_url = str(response.url or "").strip()
        content_type = (response.headers.get("content-type") or "").lower()
        if status >= 400:
            return None
        if "video/" not in content_type and ".mp4" not in final_url.lower():
            return None
        return final_url or url
    except Exception:
        return None


def score_url(url: str) -> tuple[int, int, int, int, int, int, int]:
    lower = url.lower()
    parsed = urllib.parse.urlparse(url)
    path = (parsed.path or "").lower()
    query = urllib.parse.parse_qs(parsed.query)

    # Prefer actual video URLs and avoid preview images.
    is_video = 1 if ("/get_file/" in path or re.search(r"\.(mp4|m3u8|mov|webm)(?:/?$)", path)) else 0
    is_image = 1 if re.search(r"\.(jpg|jpeg|png|webp)(?:/?$)", path) else 0
    is_mjedge = 1 if parsed.hostname and parsed.hostname.endswith("mjedge.net") else 0
    direct_mp4 = 1 if re.search(r"\.mp4(?:/?$)", path) else 0
    is_get_file = 1 if "/get_file/" in path else 0
    is_preview = 1 if "preview" in path or path.endswith(".jpg") else 0
    preferred_host = 1 if "deviants.com" in lower else 0

    br = 10**9
    try:
        br_raw = query.get("br", [None])[0]
        if br_raw:
            br = int(br_raw)
        else:
            rs_raw = query.get("rs", [None])[0]
            if rs_raw and rs_raw.endswith("k"):
                br = int(rs_raw[:-1])
    except Exception:
        br = 10**9

    quality = 0
    quality_match = re.search(r"(\d{3,4})p", lower)
    if quality_match:
        quality = int(quality_match.group(1))

    # Max tuple: real video URL first, then non-image/non-preview, then quality hints.
    return (
        is_video,
        1 - is_image,
        1 - is_preview,
        is_get_file,
        direct_mp4,
        preferred_host + is_mjedge,
        -br + quality,
    )


def pick_best(candidates: list[str]) -> str | None:
    if not candidates:
        return None
    return max(candidates, key=score_url)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        return

    url = sys.argv[1]
    page_url = canonical_deviants_page_url(url)
    try:
        session = requests.Session()
        status, page = fetch_page(page_url, session)
        if status >= 400:
            print(json.dumps({"error": f"HTTP {status}"}))
            return

        if "cf-mitigated" in page or "Just a moment..." in page:
            print(json.dumps({"error": "Cloudflare challenge"}))
            return

        title = extract_title(page)
        raw_candidates = extract_candidates(page)
        candidates: list[str] = []
        for candidate in raw_candidates:
            if "/get_file/" in candidate:
                resolved = resolve_get_file_url(session, page_url, candidate)
                if resolved:
                    candidates.append(resolved)
            candidates.append(candidate)
        best = pick_best(candidates)
        if not best:
            print(json.dumps({"error": "No video URL found", "title": title}))
            return

        print(json.dumps({"video_url": best, "video_urls": candidates, "title": title}))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))


if __name__ == "__main__":
    main()
