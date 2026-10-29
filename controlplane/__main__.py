import argparse
import asyncio
import os
import secrets
import socket

import psutil
import uvicorn

from .api import create_app


async def serve(args):
    if not all(1 <= p <= 65535 for p in (args.port, args.gateway_port)):
        raise ValueError("Ports must be 1..65535")
    os.umask(0o077)
    app = create_app(
        args.state,
        dashboard_address=args.dashboard_address,
        gateway_port=args.gateway_port,
    )
    app.state.instance_metadata = {
        "pid": os.getpid(),
        "pid_started": psutil.Process().create_time(),
        "instance_id": secrets.token_urlsafe(32),
        "port": args.port,
        "gateway_port": args.gateway_port,
    }
    sockets = []
    # Keep existing local listeners; optionally add a dashboard-only LAN socket.
    listeners = [
        ("127.0.0.1", port) for port in dict.fromkeys((args.port, args.gateway_port))
    ]
    if args.dashboard_address:
        import ipaddress

        address = ipaddress.IPv4Address(args.dashboard_address)
        if not address.is_private or address.is_loopback or address.is_unspecified:
            raise ValueError(
                "Dashboard address must be a specific private LAN IPv4 address"
            )
        listeners.append((str(address), args.port))
    try:
        for address, port in listeners:
            sock = socket.socket()
            sockets.append(sock)
            if os.name == "nt":
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((address, port))
            sock.listen(128)

        class Server(uvicorn.Server):
            def handle_exit(self, sig, frame):
                app.state.manager.stopping = True
                super().handle_exit(sig, frame)

        server = Server(
            uvicorn.Config(
                app, log_level="info", access_log=False, timeout_graceful_shutdown=30
            )
        )
        app.state.request_shutdown = lambda: setattr(server, "should_exit", True)
        await server.serve(sockets=sockets)
    finally:
        for sock in sockets:
            sock.close()


def main():
    parser = argparse.ArgumentParser(
        description="Menagerie local inference control plane"
    )
    parser.add_argument("--state")
    parser.add_argument("--port", type=int, default=8017)
    parser.add_argument("--gateway-port", type=int, default=8001)
    parser.add_argument(
        "--dashboard-address",
        default=os.environ.get("MENAGERIE_DASHBOARD_ADDRESS"),
        help="Additional private LAN IPv4 dashboard listener (inference remains loopback-only)",
    )
    asyncio.run(serve(parser.parse_args()))


if __name__ == "__main__":
    main()
