import sys
from email import policy
from email.parser import BytesParser


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: mhtml_extract.py <input.mhtml> <output.html>")
        return 2

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, "rb") as handle:
        message = BytesParser(policy=policy.default).parse(handle)

    html_body = None
    for part in message.walk():
        if part.get_content_type() == "text/html":
            html_body = part.get_content()
            break

    if html_body is None:
        print("No HTML part found in MHTML.")
        return 1

    if isinstance(html_body, bytes):
        charset = part.get_content_charset() or "utf-8"
        html_body = html_body.decode(charset, errors="replace")

    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write(html_body)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
