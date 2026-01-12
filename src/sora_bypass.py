import sys
import json
import re
import html
from curl_cffi import requests

def resolve_savesora(url):
    """
    Try to resolve using savesora.com API to get watermark-free link
    """
    api_url = "https://savesora.com/api/download-video-new"
    headers = {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json, text/plain, */*', 
        'origin': 'https://savesora.com',
        'referer': 'https://savesora.com/'
    }
    try:
        # Use a standard browser impersonation
        r = requests.post(
            api_url, 
            json={"url": url}, 
            headers=headers, 
            impersonate="chrome120", 
            timeout=15
        )
        if r.status_code == 200:
            data = r.json()
            # Check various fields for the best URL
            candidates = []
            
            # Helper to add candidate
            def add(u):
                if u and isinstance(u, str) and u.startswith('http'):
                    candidates.append(u)

            # Prioritize potential no-watermark fields
            add(data.get('data', {}).get('noWatermarkUrl'))
            add(data.get('data', {}).get('nowm'))
            add(data.get('noWatermarkUrl'))
            add(data.get('nowm'))
            
            # Fallback to standard downloadUrl
            add(data.get('data', {}).get('downloadUrl'))
            add(data.get('data', {}).get('url'))
            add(data.get('downloadUrl'))
            add(data.get('url'))
            
            if candidates:
                return candidates[0] # Return the first found (highest priority)
    except Exception as e:
        # savesora might fail or be blocked, ignore and fallback to official method
        pass
    return None

def resolve_sora(url):
    # Result object
    result = {"video_url": None, "title": "Sora Video"}

    # 1. Try SaveSora first (for no-watermark)
    savesora_url = resolve_savesora(url)
    if savesora_url:
        result["video_url"] = savesora_url
        result["title"] = "Sora Video (via SaveSora)" # Indicate it's processed
        return result

    # 2. Fallback to Official Sora Parsing
    try:
        r = requests.get(url, impersonate="chrome120", timeout=30)
        
        if r.status_code != 200:
            return {"error": f"HTTP {r.status_code}"}

        video_url = None
        
        # 0. Try no_watermark from official JSON
        match = re.search(r'\\"no_watermark\\":\\\"(.*?)\\\"', r.text)
        if match and match.group(1) and match.group(1) != "null":
            video_url = match.group(1)

        # 1. Try standard downloadable_url
        if not video_url:
            match = re.search(r'\\"downloadable_url\\":\\\"(.*?)\\\"', r.text)
            if match:
                video_url = match.group(1)
            
        # 2. Try contentUrl
        if not video_url:
            match = re.search(r'\\"contentUrl\\":\\\"(.*?)\\\"', r.text)
            if match:
                video_url = match.group(1)
        
        # 3. Fallback: Aggressive MP4 search in HTML
        if not video_url:
            mp4_matches = re.findall(r'(https?://[^"\s]+\.mp4[^"\s]*)', r.text)
            if mp4_matches:
                # Find a likely candidate (e.g., from CDN or without 'thumbnail')
                for m in mp4_matches:
                    decoded_m = html.unescape(m.replace('\\u002F', '/').replace('\\"', '"').replace('\\u0026', '&'))
                    if "videos.openai.com" in decoded_m and "thumbnail" not in decoded_m:
                        video_url = decoded_m
                        break
                if not video_url: # If no specific match, take the first one
                    video_url = mp4_matches[0].replace('\\u002F', '/').replace('\\"', '"').replace('\\u0026', '&')

        if video_url:
            try:
                video_url = json.loads(f'"{video_url}"')
            except:
                video_url = video_url.replace('\\u002F', '/').replace('\\"', '"').replace('\\u0026', '&')

            result["video_url"] = html.unescape(video_url)
            
            # Try to find title
            title_match = re.search(r'\\"prompt\\":\\\"(.*?)\\\"', r.text)
            if title_match:
                 try:
                    title = json.loads(f'"{title_match.group(1)}"')[:100]
                    result["title"] = title
                 except:
                    pass
            return result
            
        return {"error": "No video URL found in HTML"}

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        sys.exit(1)
        
    url = sys.argv[1]
    # Normalize URL for consistency
    if "threads.com" in url:
        url = url.replace("threads.com", "threads.net")
        
    result = resolve_sora(url)
    print(json.dumps(result))
