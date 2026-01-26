import sys
import json
import re
import html
import os
from urllib.parse import urlparse, quote
from http.cookiejar import MozillaCookieJar
from curl_cffi import requests


def _extract_meta(html_text, key):
    pattern = re.compile(
        r'<meta[^>]+(?:property|name)=["\\\']%s["\\\'][^>]+content=["\\\'](.*?)["\\\']'
        % re.escape(key),
        re.IGNORECASE,
    )
    match = pattern.search(html_text)
    if match:
        return html.unescape(match.group(1))
    return None


def _score_image(url):
    score = 0
    if "/originals/" in url:
        score += 5
    if "/736x/" in url or "/564x/" in url or "/474x/" in url:
        score += 2
    if re.search(r"/\\d+x/", url):
        score += 1
    return score, len(url)


def _normalize_image(url):
    try:
        parsed = urlparse(url)
        cleaned = parsed._replace(query="", fragment="").geturl()
        return cleaned
    except Exception:
        return url


def _load_cookies(path):
    if not path:
        return None
    try:
        if not os.path.exists(path):
            return None
        jar = MozillaCookieJar(path)
        jar.load(ignore_discard=True, ignore_expires=True)
        return jar
    except Exception:
        return None


def _get_cookie_value(jar, name, domains):
    if not jar:
        return None
    for cookie in jar:
        if cookie.name != name:
            continue
        if any(domain in cookie.domain for domain in domains):
            return cookie.value
    return None


def _extract_url_by_suffix(text, suffix):
    idx = text.find(suffix)
    if idx == -1:
        return None
    start = text.rfind("http", 0, idx)
    if start == -1:
        return None
    end = idx + len(suffix)
    while end < len(text) and text[end] not in ['"', "'", "\\\\", " ", "\\n", "\\r", "\\t"]:
        end += 1
    return text[start:end]


def _extract_video_url(text):
    mp4_matches = re.findall(r'https?://[^\s"\\\']+?\\.mp4[^\s"\\\']*', text)
    if mp4_matches:
        return html.unescape(mp4_matches[0])
    m3u8_matches = re.findall(r'https?://[^\s"\\\']+?\\.m3u8[^\s"\\\']*', text)
    if m3u8_matches:
        return html.unescape(m3u8_matches[0])
    m3u8_fallback = _extract_url_by_suffix(text, ".m3u8")
    if m3u8_fallback:
        return html.unescape(m3u8_fallback)
    return None


def _extract_pin_id(url):
    try:
        path = urlparse(url).path
        match = re.search(r"/pin/(\\d+)", path)
        if match:
            return match.group(1)
    except Exception:
        return None
    return None


def _find_media_urls(obj, video_urls, image_urls):
    if isinstance(obj, dict):
        for key, value in obj.items():
            if isinstance(value, str):
                if ".mp4" in value or ".m3u8" in value:
                    video_urls.append(value)
                elif "pinimg.com" in value:
                    image_urls.append(value)
            else:
                _find_media_urls(value, video_urls, image_urls)
    elif isinstance(obj, list):
        for item in obj:
            _find_media_urls(item, video_urls, image_urls)


def _get_pin_resource(url, cookies):
    pin_id = _extract_pin_id(url)
    if not pin_id:
        return None
    host = "www.pinterest.com"
    source_url = f"/pin/{pin_id}/"
    data = (
        '{"options":{"id":"%s","field_set_key":"detailed","fetch_visual_search_objects":true},'
        '"context":{}}' % pin_id
    )
    resource_url = (
        f"https://{host}/resource/PinResource/get/?source_url="
        f"{quote(source_url)}&data={quote(data)}"
    )
    csrf = _get_cookie_value(cookies, "csrftoken", ["pinterest.com"])
    headers = {
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": url,
        "Origin": "https://www.pinterest.com",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
    }
    if csrf:
        headers["X-CSRFToken"] = csrf
    r = requests.get(
        resource_url,
        impersonate="chrome120",
        headers=headers,
        timeout=30,
        cookies=cookies,
    )
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except Exception:
        return None


def resolve_pinterest(url, cookie_file=None):
    result = {"video_url": None, "photo_urls": None, "title": "Pinterest"}
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        )
    }
    cookies = _load_cookies(cookie_file)
    try:
        r = requests.get(
            url,
            impersonate="chrome120",
            headers=headers,
            timeout=30,
            cookies=cookies,
        )
        if r.status_code != 200:
            return {"error": f"HTTP {r.status_code}"}

        text = r.text

        title = _extract_meta(text, "og:title")
        if title:
            result["title"] = title

        video_url = _extract_meta(text, "og:video:secure_url") or _extract_meta(
            text, "og:video"
        )
        if not video_url:
            video_url = _extract_video_url(text)
        if video_url:
            result["video_url"] = html.unescape(video_url)
            return result

        image_url = _extract_meta(text, "og:image:secure_url") or _extract_meta(
            text, "og:image"
        )
        image_urls = []
        if image_url:
            image_urls.append(image_url)

        if not image_urls:
            pinimg_matches = re.findall(
                r'https?://i\\.pinimg\\.com[^\\s"\\\'<>]+', text
            )
            for match in pinimg_matches:
                image_urls.append(html.unescape(match))

        unique = []
        seen = set()
        for url_item in image_urls:
            cleaned = _normalize_image(url_item)
            if cleaned in seen:
                continue
            seen.add(cleaned)
            unique.append(cleaned)

        if unique:
            unique.sort(key=lambda u: _score_image(u), reverse=True)
            result["photo_urls"] = unique[:10]
            return result

        resource_data = _get_pin_resource(url, cookies)
        if resource_data:
            video_urls = []
            image_urls = []
            _find_media_urls(resource_data, video_urls, image_urls)
            if video_urls:
                result["video_url"] = html.unescape(video_urls[0])
                return result
            if image_urls:
                normalized = []
                seen = set()
                for item in image_urls:
                    cleaned = _normalize_image(item)
                    if cleaned in seen:
                        continue
                    seen.add(cleaned)
                    normalized.append(cleaned)
                if normalized:
                    normalized.sort(key=lambda u: _score_image(u), reverse=True)
                    result["photo_urls"] = normalized[:10]
                    return result

        return {"error": "No media URL found in HTML"}
    except Exception as exc:
        return {"error": str(exc)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        sys.exit(1)
    url = sys.argv[1]
    cookie_file = sys.argv[2] if len(sys.argv) > 2 else None
    print(json.dumps(resolve_pinterest(url, cookie_file)))
