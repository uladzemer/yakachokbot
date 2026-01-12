from curl_cffi import requests
import sys
import re
import json

def resolve_threads(url):
    try:
        # Threads/Instagram strongly prefers mobile user agents or specific impersonation
        r = requests.get(url, impersonate="chrome120", timeout=30)
        
        if r.status_code != 200:
            return {"error": f"HTTP {r.status_code}"}

        # Look for video in meta tags
        # <meta property="og:video" content="https://..." />
        match = re.search(r'property="og:video" content="(.*?)"', r.text)
        if not match:
             # Try variant with single quotes
             match = re.search(r"property='og:video' content='(.*?)'", r.text)
             
        if match:
            video_url = match.group(1).replace("&amp;", "&")
            return {
                "video_url": video_url,
                "title": "Threads Video"
            }
            
        # Try searching for any mp4 links in the script data
        mp4_links = re.findall(r'https?://[^\s"\'\\]+\.mp4[^\s"\'\\]*', r.text)
        if mp4_links:
             # Return the one that looks most like a CDN link (usually contains 'fbcdn')
             for link in mp4_links:
                 if "fbcdn" in link:
                     return {"video_url": link.replace("\\/", "/"), "title": "Threads Video"}
             return {"video_url": mp4_links[0].replace("\\/", "/"), "title": "Threads Video"}

        return {"error": "No video URL found in Threads page"}

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    url = sys.argv[1]
    # Ensure it's .net
    if "threads.com" in url:
        url = url.replace("threads.com", "threads.net")
    print(json.dumps(resolve_threads(url)))
