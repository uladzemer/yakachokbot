import sys
import json
import re
import html
import os
from urllib.parse import urlsplit
from curl_cffi import requests

def resolve_threads(url):
    COOKIE_FILE = "/app/storage/cookies.txt"
    
    # Normalize URL
    url = url.replace("threads.com", "threads.net")
    if "/post/" in url and "/t/" not in url:
        # Some tools prefer the /t/ format
        match = re.search(r'/post/([^/?]+)', url)
        if match:
            parsed = urlsplit(url)
            url = f"https://www.threads.net/t/{match.group(1)}"
            if parsed.query:
                url = f"{url}?{parsed.query}"

    def clean_url(value):
        if not value:
            return value
        value = value.replace("\\u0026", "&").replace("\\u002F", "/")
        value = value.replace("\\/", "/")
        return html.unescape(value)

    def is_image_url(value):
        if not value:
            return False
        lowered = value.lower()
        if "profile_pic" in lowered or "/t51.2885-19/" in lowered:
            return False
        return any(ext in lowered for ext in [".jpg", ".jpeg", ".png", ".webp"])

    def score_image_url(value):
        match = re.search(r"(?:p|s)(\\d+)x(\\d+)", value)
        if not match:
            return 0
        return int(match.group(1)) * int(match.group(2))

    def score_candidate(candidate):
        if not isinstance(candidate, dict):
            return 0
        width = candidate.get("width") or 0
        height = candidate.get("height") or 0
        if isinstance(width, int) and isinstance(height, int):
            return width * height
        return 0

    def pick_best_candidate(candidates):
        if not candidates:
            return None
        return max(candidates, key=score_candidate)

    def extract_shortcode(value):
        match = re.search(r'/t/([^/?#]+)', value)
        if match:
            return match.group(1)
        match = re.search(r'/post/([^/?#]+)', value)
        if match:
            return match.group(1)
        return None

    def find_media_by_code(obj, shortcode):
        if isinstance(obj, dict):
            code = obj.get("code") or obj.get("shortcode")
            if code == shortcode and (
                "carousel_media" in obj or "image_versions2" in obj
            ):
                return obj
            for v in obj.values():
                found = find_media_by_code(v, shortcode)
                if found:
                    return found
        elif isinstance(obj, list):
            for v in obj:
                found = find_media_by_code(v, shortcode)
                if found:
                    return found
        return None

    def extract_photos_from_media(media):
        if not isinstance(media, dict):
            return []
        photos = []
        if isinstance(media.get("carousel_media"), list):
            for item in media["carousel_media"]:
                candidates = (
                    item.get("image_versions2", {})
                    .get("candidates", [])
                )
                best = pick_best_candidate(candidates)
                if best and isinstance(best.get("url"), str):
                    photos.append(clean_url(best["url"]))
        else:
            candidates = (
                media.get("image_versions2", {})
                .get("candidates", [])
            )
            best = pick_best_candidate(candidates)
            if best and isinstance(best.get("url"), str):
                photos.append(clean_url(best["url"]))
        return photos

    def extract_video_from_media(media):
        if not isinstance(media, dict):
            return None
        versions = media.get("video_versions") or []
        best = pick_best_candidate(versions)
        if best and isinstance(best.get("url"), str):
            return clean_url(best["url"])
        for key in ["video_url", "playback_url"]:
            value = media.get(key)
            if isinstance(value, str) and value:
                return clean_url(value)
        return None

    def select_best_images(urls):
        from urllib.parse import urlparse, parse_qs

        groups = {}
        ordered_keys = []
        for url in urls:
            parsed = urlparse(url)
            query = parse_qs(parsed.query)
            key = query.get("ig_cache_key", [None])[0] or parsed.path
            if key not in groups:
                groups[key] = []
                ordered_keys.append(key)
            groups[key].append(url)

        best_urls = []
        for key in ordered_keys:
            candidates = groups[key]
            best_urls.append(max(candidates, key=score_image_url))
        return best_urls

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",
    }

    try:
        # Load cookies if available
        session = requests.Session()
        if os.path.exists(COOKIE_FILE):
            # Simple Netscape cookie parser for requests
            with open(COOKIE_FILE, 'r') as f:
                for line in f:
                    if not line.startswith('#') and line.strip():
                        parts = line.split('\t')
                        if len(parts) >= 7:
                            session.cookies.set(parts[5], parts[6].strip(), domain=parts[0])

        r = session.get(url, impersonate="chrome120", headers=headers, timeout=30)
        
        if r.status_code != 200:
            return {"error": f"HTTP {r.status_code}"}

        # 1. Parse data-sjs JSON payloads for embedded media URLs
        scripts = re.findall(
            r'<script[^>]*type="application/json"[^>]*data-sjs[^>]*>(.*?)</script>',
            r.text,
            re.DOTALL,
        )
        shortcode = extract_shortcode(url)
        video_urls = []
        image_urls = []
        for script in scripts:
            if "RelayPrefetchedStreamCache" not in script:
                continue
            try:
                payload = json.loads(script)
            except Exception:
                continue

            if shortcode:
                media = find_media_by_code(payload, shortcode)
                if media:
                    photo_urls = extract_photos_from_media(media)
                    if photo_urls:
                        return {"photo_urls": photo_urls, "title": "Threads Photos (SJS)"}
                    video_url = extract_video_from_media(media)
                    if video_url:
                        return {"video_url": video_url, "title": "Threads Video (SJS)"}

            stack = [payload]
            while stack:
                obj = stack.pop()
                if isinstance(obj, dict):
                    stack.extend(obj.values())
                elif isinstance(obj, list):
                    stack.extend(obj)
                elif isinstance(obj, str):
                    cleaned = clean_url(obj)
                    if not cleaned:
                        continue
                    if ".mp4" in cleaned or "m3u8" in cleaned:
                        if "fbcdn.net" in cleaned or "instagram" in cleaned:
                            video_urls.append(cleaned)
                    elif is_image_url(cleaned):
                        if "fbcdn.net" in cleaned or "instagram" in cleaned:
                            image_urls.append(cleaned)

        if video_urls:
            return {"video_url": video_urls[0], "title": "Threads Video (SJS)"}
        if image_urls:
            unique_images = []
            seen = set()
            for url in image_urls:
                if url in seen:
                    continue
                seen.add(url)
                unique_images.append(url)
            best_images = select_best_images(unique_images)
            return {"photo_urls": best_images, "title": "Threads Photos (SJS)"}

        # 2. Look for og:video
        match = re.search(r'property="og:video" content="(.*?)"', r.text)
        if match:
            return {"video_url": clean_url(match.group(1)), "title": "Threads Video"}

        match = re.search(r'property="og:video:secure_url" content="(.*?)"', r.text)
        if match:
            return {"video_url": clean_url(match.group(1)), "title": "Threads Video"}

        # 3. Look for any fbcdn .mp4 links (the ones you saw in DevTools)
        # They are often inside JSON-like strings in the HTML
        mp4_links = re.findall(r'https?://[^\s"\'\\]+?\.mp4[^\s"\'\\]*', r.text)
        if mp4_links:
            # Filter for Meta CDN
            meta_links = [l for l in mp4_links if "fbcdn.net" in l or "instagram" in l]
            if meta_links:
                # Take the first one and clean it
                return {"video_url": clean_url(meta_links[0]), "title": "Threads Video (CDN)"}

        # 4. Look for JSON-escaped mp4 links
        escaped_links = re.findall(r'https?:\\\\/\\\\/[^\\s"\\\\]+?\\.mp4[^\\s"\\\\]*', r.text)
        if escaped_links:
            meta_links = [l for l in escaped_links if "fbcdn.net" in l or "instagram" in l]
            if meta_links:
                return {"video_url": clean_url(meta_links[0]), "title": "Threads Video (CDN)"}

        # 5. Look for video_url/playback_url fields
        json_url_matches = re.findall(r'"(?:video_url|playback_url)"\s*:\s*"(.*?)"', r.text)
        for match_url in json_url_matches:
            cleaned = clean_url(match_url)
            if cleaned and ("fbcdn.net" in cleaned or "instagram" in cleaned):
                return {"video_url": cleaned, "title": "Threads Video (JSON)"}

        return {"error": "Could not find video link in Threads page. Please ensure you uploaded valid cookies."}

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        sys.exit(1)
    
    print(json.dumps(resolve_threads(sys.argv[1])))
