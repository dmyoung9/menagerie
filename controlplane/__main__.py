import argparse
import asyncio
import os
import socket
import uvicorn
from .api import create_app


async def serve(args):
    os.umask(0o077)
    app = create_app(args.state, dashboard_address=args.dashboard_address)
    sockets = []
    # Keep existing local listeners; optionally add a dashboard-only LAN socket.
    listeners = [("127.0.0.1", port) for port in dict.fromkeys((args.port, args.gateway_port))]
    if args.dashboard_address:
        import ipaddress
        address = ipaddress.IPv4Address(args.dashboard_address)
        if not address.is_private or address.is_loopback or address.is_unspecified:
            raise ValueError("Dashboard address must be a specific private LAN IPv4 address")
        listeners.append((str(address), args.port))
    for address, port in listeners:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((address, port))
        sock.listen(128)
        sockets.append(sock)
    try:
        class Server(uvicorn.Server):
            def handle_exit(self, sig, frame):
                app.state.manager.stopping = True
                super().handle_exit(sig, frame)
        await Server(uvicorn.Config(app, log_level="info", access_log=False, timeout_graceful_shutdown=30)).serve(sockets=sockets)
    finally:
        for sock in sockets:
            sock.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Menagerie local inference control plane")
    parser.add_argument("--state")
    parser.add_argument("--port", type=int, default=8017)
    parser.add_argument("--gateway-port", type=int, default=8001)
    parser.add_argument("--dashboard-address", default=os.environ.get("MENAGERIE_DASHBOARD_ADDRESS"), help="Additional private LAN IPv4 dashboard listener (inference remains loopback-only)")
    asyncio.run(serve(parser.parse_args()))
