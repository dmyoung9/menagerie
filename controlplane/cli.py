"""Small local HTTP client for operations and recovery; the daemon owns lifecycle."""
import argparse
import json
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["status", "doctor", "models", "deployments", "backup", "stop"])
    parser.add_argument("id", nargs="?")
    parser.add_argument("--port", type=int, default=8017)
    args = parser.parse_args()
    base = f"http://127.0.0.1:{args.port}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(base + "/api/status") as response:
        status = json.load(response)
    if args.action in ("status", "doctor"):
        result = status if args.action == "status" else {"version": status["version"], "telemetry_age_s": __import__("time").time() - status["host"].get("ts", 0), "errors": status["host"].get("errors"), "pressure": status["host"].get("pressure"), "deployments": [{"alias": d["alias"], "state": d["state"]} for d in status["deployments"]]}
        result.pop("csrf_token", None)
    else:
        path = "/api/" + args.action if args.action in ("models", "deployments", "backup") else f"/api/deployments/{args.id}/stop"
        request = urllib.request.Request(base + path, data=b"{}" if args.action in ("backup", "stop") else None, headers={"Content-Type": "application/json", "X-Menagerie-Token": status["csrf_token"]})
        with opener.open(request) as response:
            result = json.load(response)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
