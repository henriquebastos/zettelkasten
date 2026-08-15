#!/usr/bin/env python3
"""Install Claude Code integration from a private namespace descriptor."""

import argparse
import getpass
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_SERVICE_URL = "https://zettelkasten.henriquebastos.net"
MARKETPLACE = "https://github.com/henriquebastos/zettelkasten.git"
PLUGIN = "zettelkasten-hierarchy@zettelkasten"
SUPPORTED_CLAUDE_VERSION = "2.1.227"
USER_AGENT = "zettelkasten-claude-installer/1.0"
EXCLUDED_CLAUDE_ENVIRONMENT = {
    "CAPABILITY_SIGNING_KEY",
    "CLOUDFLARE_API_TOKEN",
    "SERVICE_ADMIN_TOKEN",
    "ZETTELKASTEN_NAMESPACE_CAPABILITY",
    "ZETTELKASTEN_SERVICE_ADMIN_TOKEN",
}
NAMESPACE_ID = re.compile(
    r"^ns_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--namespace-file",
        type=pathlib.Path,
        default=pathlib.Path.home()
        / ".config"
        / "zettelkasten"
        / "namespaces"
        / "claude-code.private.json",
        help="private namespace descriptor to read or create",
    )
    parser.add_argument("--service-url", default=DEFAULT_SERVICE_URL)
    parser.add_argument("--claude", default="claude", help="Claude Code executable")
    parser.add_argument("--marketplace", default=MARKETPLACE)
    return parser.parse_args()


def valid_values(value: object) -> tuple[str, str]:
    if not isinstance(value, dict):
        raise ValueError("namespace file must contain a JSON object")
    namespace_id = value.get("namespaceID")
    capability = value.get("capabilityToken")
    if not isinstance(namespace_id, str) or not NAMESPACE_ID.fullmatch(namespace_id):
        raise ValueError("namespace file contains an invalid namespace ID")
    if not isinstance(capability, str) or not capability.startswith("zk1."):
        raise ValueError("namespace file contains an invalid namespace capability")
    return namespace_id, capability


def write_descriptor(path: pathlib.Path, namespace_id: str, capability: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(
            {
                "namespaceID": namespace_id,
                "name": "claude-code",
                "state": "active",
                "capabilityToken": capability,
            },
            output,
            indent=2,
        )
        output.write("\n")


def load_or_create_descriptor(path: pathlib.Path) -> tuple[str, str]:
    if not path.exists():
        namespace_id = input("Dedicated Claude Code namespace ID: ").strip()
        capability = getpass.getpass("Dedicated Claude Code namespace capability: ").strip()
        valid_values({"namespaceID": namespace_id, "capabilityToken": capability})
        write_descriptor(path, namespace_id, capability)

    if path.is_symlink() or not path.is_file():
        raise ValueError("namespace path must be a regular file, not a link")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise ValueError(f"namespace file must not be accessible by group or others (mode is {mode:04o})")
    return valid_values(json.loads(path.read_text()))


def request_json(request: urllib.request.Request) -> object:
    request.add_header("User-Agent", USER_AGENT)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def verify_service(service_url: str, namespace_id: str, capability: str) -> None:
    health = request_json(urllib.request.Request(service_url + "/health"))
    if health != {"ok": True}:
        raise ValueError("service health response is invalid")

    request = urllib.request.Request(
        service_url + f"/v1/namespaces/{namespace_id}/elements/resolve",
        data=json.dumps({"key": f"claude:installer-readiness:{uuid.uuid4()}"}).encode(),
        headers={
            "Authorization": "Bearer " + capability,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        request_json(request)
    except urllib.error.HTTPError as error:
        body = json.load(error)
        if error.code == 404 and body == {"code": "element_not_found"}:
            return
        if error.code == 401:
            raise ValueError("namespace ID and capability were rejected") from None
        raise ValueError(f"namespace validation returned HTTP {error.code}") from None
    raise ValueError("readiness probe unexpectedly resolved an existing element")


def claude_environment() -> dict[str, str]:
    return {key: value for key, value in os.environ.items() if key not in EXCLUDED_CLAUDE_ENVIRONMENT}


def run(command: list[str], environment: dict[str, str]) -> None:
    result = subprocess.run(command, check=False, env=environment)
    if result.returncode != 0:
        raise ValueError(f"command failed: {' '.join(command[:3])}")


def main() -> int:
    options = arguments()
    service_url = options.service_url.strip().rstrip("/")
    parsed_service_url = urllib.parse.urlparse(service_url)
    local_http = parsed_service_url.scheme == "http" and parsed_service_url.hostname in {
        "127.0.0.1",
        "localhost",
        "::1",
    }
    if (
        (parsed_service_url.scheme != "https" and not local_http)
        or not parsed_service_url.hostname
        or parsed_service_url.username
        or parsed_service_url.password
        or parsed_service_url.path not in ("", "/")
        or parsed_service_url.query
        or parsed_service_url.fragment
    ):
        raise ValueError("service URL must use HTTPS (HTTP is allowed only for loopback development)")
    namespace_id, capability = load_or_create_descriptor(options.namespace_file.expanduser())
    verify_service(service_url, namespace_id, capability)

    environment = claude_environment()
    version = subprocess.run(
        [options.claude, "--version"],
        check=False,
        capture_output=True,
        env=environment,
        text=True,
    )
    if version.returncode != 0 or not version.stdout.startswith(SUPPORTED_CLAUDE_VERSION + " "):
        raise ValueError(f"Claude Code {SUPPORTED_CLAUDE_VERSION} is required")

    run(
        [options.claude, "plugin", "marketplace", "add", options.marketplace, "--scope", "user"],
        environment,
    )
    run(
        [
            options.claude,
            "plugin",
            "install",
            PLUGIN,
            "--scope",
            "user",
            "--config",
            f"service_url={service_url}",
            "--config",
            f"namespace_id={namespace_id}",
        ],
        environment,
    )
    run([options.claude, "plugin", "update", PLUGIN, "--scope", "user"], environment)

    print("Claude Code plugin installed and its non-secret namespace settings validated.")
    print(f"Start Claude Code and run: /plugin configure {PLUGIN}")
    print(f"Set Namespace capability from the private file: {options.namespace_file.expanduser()}")
    print("Do not enter the service admin token. Restart Claude Code after configuration.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError, urllib.error.URLError) as error:
        print(f"Claude Code installation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
