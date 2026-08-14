#!/usr/bin/env python3
"""Create and activate one namespace without exposing its credentials."""

import argparse
import getpass
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "zettelkasten-namespace-provisioner/1.0"


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-url", required=True, help="Zettelkasten service origin")
    parser.add_argument("--name", required=True, help="Namespace name")
    parser.add_argument(
        "--output",
        type=pathlib.Path,
        help="Private output file (default: ~/.config/zettelkasten/namespaces/<name>.private.json)",
    )
    return parser.parse_args()


def request_json(url: str, admin_token: str, body: dict[str, object]) -> object:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": "Bearer " + admin_token,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        value = json.load(response)
    return value


def private_output(path: pathlib.Path) -> int:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)


def write_private(descriptor: int, value: dict[str, object]) -> None:
    data = (json.dumps(value, indent=2) + "\n").encode()
    os.ftruncate(descriptor, 0)
    os.lseek(descriptor, 0, os.SEEK_SET)
    while data:
        data = data[os.write(descriptor, data) :]
    os.fsync(descriptor)


def main() -> int:
    options = arguments()
    service_url = options.service_url.strip().rstrip("/")
    if not service_url.startswith(("https://", "http://")):
        raise ValueError("service URL must use HTTP or HTTPS")
    namespace_name = options.name.strip()
    if not namespace_name or len(namespace_name) > 100:
        raise ValueError("namespace name must contain 1 to 100 characters")

    output = options.output or (
        pathlib.Path.home()
        / ".config"
        / "zettelkasten"
        / "namespaces"
        / f"{urllib.parse.quote(namespace_name, safe='')}.private.json"
    )
    admin_token = os.environ.get("ZETTELKASTEN_SERVICE_ADMIN_TOKEN")
    if not admin_token:
        admin_token = getpass.getpass("Service admin token: ")
    if not admin_token:
        raise ValueError("service admin token is required")

    descriptor = private_output(output)
    created = False
    try:
        namespace = request_json(
            service_url + "/v1/admin/namespaces",
            admin_token,
            {"name": namespace_name},
        )
        if not isinstance(namespace, dict):
            raise ValueError("namespace creation returned a non-object response")
        namespace_id = namespace.get("namespaceID")
        capability = namespace.get("capabilityToken")
        if not isinstance(namespace_id, str) or not namespace_id.startswith("ns_"):
            raise ValueError("namespace creation returned an invalid namespace ID")
        if not isinstance(capability, str) or not capability:
            raise ValueError("namespace creation returned no capability")

        write_private(descriptor, namespace)
        created = True
        activation = request_json(
            service_url + f"/v1/admin/namespaces/{namespace_id}/activate",
            admin_token,
            {},
        )
        if activation != "active":
            raise ValueError("namespace activation did not return active state")
        namespace["state"] = activation
        write_private(descriptor, namespace)
    except Exception:
        if not created:
            os.close(descriptor)
            descriptor = -1
            output.unlink(missing_ok=True)
        raise
    finally:
        if descriptor >= 0:
            os.close(descriptor)

    print(f"Namespace created and activated; private credentials saved to {output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as error:
        if error.code == 403:
            detail = "request was rejected before or at the service authorization boundary"
        elif error.code == 401:
            detail = "service admin token was rejected"
        else:
            detail = f"service returned HTTP {error.code}"
        print(f"Namespace provisioning failed: {detail}.", file=sys.stderr)
        raise SystemExit(1)
    except (OSError, ValueError, urllib.error.URLError) as error:
        print(f"Namespace provisioning failed: {error}", file=sys.stderr)
        raise SystemExit(1)
