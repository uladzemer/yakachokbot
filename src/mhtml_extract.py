import mimetypes
import os
import sys
from email import policy
from email.parser import BytesParser
from urllib.parse import urlparse


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: mhtml_extract.py <input.mhtml> <output.html>")
        return 2

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, "rb") as handle:
        message = BytesParser(policy=policy.default).parse(handle)

    html_body = None
    resources = {}
    output_dir = os.path.dirname(output_path) or "."
    base_name = os.path.splitext(os.path.basename(output_path))[0]
    resources_dir = os.path.join(output_dir, f"{base_name}_files")
    os.makedirs(resources_dir, exist_ok=True)
    used_names = set()

    def safe_name(name: str) -> str:
        clean = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)
        if not clean:
            clean = "resource"
        candidate = clean
        counter = 1
        while candidate in used_names:
            counter += 1
            candidate = f"{clean}_{counter}"
        used_names.add(candidate)
        return candidate

    for part in message.walk():
        if part.is_multipart():
            continue
        content_type = part.get_content_type()
        if content_type == "text/html" and html_body is None:
            html_body = part.get_content()
            if isinstance(html_body, bytes):
                charset = part.get_content_charset() or "utf-8"
                html_body = html_body.decode(charset, errors="replace")
            continue

        payload = part.get_payload(decode=True)
        if not payload:
            continue

        content_id = part.get("Content-ID")
        content_location = part.get("Content-Location")
        ext = mimetypes.guess_extension(content_type) or ".bin"

        filename = None
        if content_location:
            parsed = urlparse(content_location)
            location_name = os.path.basename(parsed.path) or "resource"
            filename = safe_name(location_name)
        elif content_id:
            filename = safe_name(f"cid-{content_id.strip('<>')}{ext}")

        if not filename:
            filename = safe_name(f"resource{ext}")

        if not filename.lower().endswith(ext.lower()):
            filename += ext

        file_path = os.path.join(resources_dir, filename)
        with open(file_path, "wb") as handle:
            handle.write(payload)

        rel_path = os.path.relpath(file_path, output_dir)
        if content_id:
            resources[f"cid:{content_id.strip('<>')}"] = rel_path
        if content_location:
            resources[content_location] = rel_path

    if html_body is None:
        print("No HTML part found in MHTML.")
        return 1

    for key, value in resources.items():
        html_body = html_body.replace(key, value)

    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write(html_body)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
