/** Static, versioned transport shape. The Verifier supplies data, never Python code. */
export const STANDARD_REPRODUCER_ID = "standard-python-v1";

/** Runs inside a fresh gVisor container on the Lab's internal network. */
export const STANDARD_REPRODUCER_SCRIPT = `#!/usr/bin/env python3
import hashlib
import http.client
import json
import sys
from http.cookies import SimpleCookie
from urllib.parse import urlencode

def send(method, path, headers=None, body=None):
    connection = http.client.HTTPConnection("wordpress", 80, timeout=20)
    connection.request(method, path, body=body, headers=headers or {})
    response = connection.getresponse()
    data = response.read(1048577)
    if len(data) > 1048576:
        raise ValueError("response-too-large")
    result = response.status, response.getheaders(), data
    connection.close()
    return result

def main():
    with open("/run/wbh-reproduction/input.json", encoding="utf-8") as source:
        route = json.load(source)
    cookies = SimpleCookie()
    if route["role"] != "unauthenticated":
        login = urlencode({"log": route["username"], "pwd": route["password"],
                           "wp-submit": "Log In", "testcookie": "1"}).encode()
        status, headers, _ = send("POST", "/wp-login.php", {
            "Content-Type": "application/x-www-form-urlencoded",
            "Cookie": "wordpress_test_cookie=WP%20Cookie%20check"}, login)
        for name, value in headers:
            if name.lower() == "set-cookie":
                cookies.load(value)
        if status not in (301, 302, 303) or not any(
            name.startswith("wordpress_logged_in_") for name in cookies.keys()
        ):
            raise ValueError("lab-login-failed")
    results = []
    for index, step in enumerate(route["steps"]):
        if step["kind"] != "http":
            raise ValueError("browser-step-requires-harness-observer")
        headers = dict(step.get("headers", {}))
        if cookies:
            headers["Cookie"] = "; ".join(
                name + "=" + morsel.value for name, morsel in cookies.items())
        body = step.get("body")
        if body is not None:
            body = body.replace("{{USERNAME}}", route.get("username", ""))
            body = body.replace("{{PASSWORD}}", route.get("password", ""))
            body = body.encode("utf-8")
        status, response_headers, data = send(step["method"], step["path"], headers, body)
        for name, value in response_headers:
            if name.lower() == "set-cookie":
                cookies.load(value)
        text = data.decode("utf-8", errors="replace")
        results.append({"index": index, "statusCode": status,
                        "bodySha256": hashlib.sha256(data).hexdigest(),
                        "containsExpected": any(marker in text for marker in route["canaries"])})
    print(json.dumps({"schemaVersion": 1, "stepResults": results}, separators=(",", ":")))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(1)
`;
