"""Opt-in disposable Docker acceptance. Synthetic state only; no inference/GPU."""

import argparse
import json
import subprocess
import time
import uuid


def check(image: str, user: str = "1000:1000"):
    uid, gid = (int(value) for value in user.split(":"))
    if uid <= 0 or gid < 0:
        raise ValueError("Select a non-root UID and a numeric GID")
    prefix = "menagerie-check-" + uuid.uuid4().hex[:12]
    volume, network, name = prefix + "-data", prefix + "-net", prefix + "-app"

    def docker(*args, script=None, check=True):
        result = subprocess.run(
            ["docker", *args], input=script, text=True, capture_output=True, timeout=120
        )
        if check and result.returncode:
            raise RuntimeError(
                "Disposable container check failed; inspect the isolated Docker operation locally"
            )
        return result

    def execute(script):
        return docker("exec", "-i", name, "python", "-", script=script).stdout

    def start(lan=True):
        # Bridge peers simulate the trusted LAN. The production template uses
        # host networking and requires an explicitly configured host address.
        docker(
            "run",
            "-d",
            "--name",
            name,
            "--network",
            network,
            "--user",
            user,
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--mount",
            f"type=volume,src={volume},dst=/data,volume-nocopy",
            *(
                (
                    "--entrypoint",
                    "/bin/sh",
                    image,
                    "-c",
                    'export MENAGERIE_DASHBOARD_ADDRESS="$(hostname -i)"; exec /usr/bin/tini -- /usr/local/bin/menagerie-container',
                )
                if lan
                else (image,)
            ),
        )

    def ready():
        for _ in range(100):
            result = docker(
                "exec",
                name,
                "python",
                "-c",
                'import urllib.request; urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://127.0.0.1:8017/health",timeout=1).close()',
                check=False,
            )
            if result.returncode == 0:
                return
            time.sleep(0.2)
        raise RuntimeError("Container did not become ready")

    verify = """import json,os,urllib.request
from pathlib import Path
assert os.getuid() != 0
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def get(path):
    return opener.open('http://127.0.0.1:8017'+path,timeout=5).read()
status=json.loads(get('/api/status'))
assert status['settings']['max_queue']==17
assert Path('/data/model-sentinel').read_bytes()==b'synthetic-model-placeholder'
assert b'<html' in get('/').lower()
assert Path('/usr/share/menagerie/source.tar.gz').is_file()
assert json.loads(get('/v1/models'))['data']==[]
"""
    try:
        metadata = json.loads(docker("image", "inspect", image).stdout)[0]
        if metadata["Config"]["User"] != "1000:1000":
            raise RuntimeError("The shipped image must default to its non-root user")
        docker("volume", "create", volume)
        docker("network", "create", network)
        docker(
            "run",
            "--rm",
            "--user",
            "0:0",
            "--mount",
            f"type=volume,src={volume},dst=/data,volume-nocopy",
            "--entrypoint",
            "python",
            image,
            "-c",
            'import os,sys; os.chown("/data",int(sys.argv[1]),int(sys.argv[2]))',
            str(uid),
            str(gid),
        )
        start(lan=False)
        ready()
        address = docker("exec", name, "hostname", "-i").stdout.strip()
        docker(
            "run",
            "--rm",
            "-i",
            "--network",
            network,
            "-e",
            "TARGET=" + address,
            "--entrypoint",
            "python",
            image,
            "-",
            script="""import os,urllib.request,urllib.error
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for port in [8017,8001]:
    try: opener.open('http://'+os.environ['TARGET']+':'+str(port)+'/health',timeout=2)
    except urllib.error.URLError: pass
    else: raise AssertionError('Default image listener was exposed to a peer')
""",
        )
        docker("stop", "--time", "90", name)
        docker("rm", name)
        start()
        ready()
        execute("""import json,urllib.request
from pathlib import Path
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
status=json.load(opener.open('http://127.0.0.1:8017/api/status'))
settings=status['settings']; settings['max_queue']=17
request=urllib.request.Request('http://127.0.0.1:8017/api/settings',data=json.dumps(settings).encode(),headers={'Content-Type':'application/json','X-Menagerie-Token':status['csrf_token']})
opener.open(request).close()
Path('/data/model-sentinel').write_bytes(b'synthetic-model-placeholder')
""")
        execute(verify)
        address = docker("exec", name, "hostname", "-i").stdout.strip()
        peer = """import os,urllib.request,urllib.error
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
base='http://'+os.environ['TARGET']+':8017'
assert b'<html' in opener.open(base+'/').read().lower()
for path in ['/models','/v1','/v1/models']:
    try: opener.open(base+path)
    except urllib.error.HTTPError as e: assert e.code==403
    else: raise AssertionError('LAN inference was exposed')
try: opener.open('http://'+os.environ['TARGET']+':8001/v1/models',timeout=2)
except urllib.error.URLError: pass
else: raise AssertionError('Gateway was exposed to a peer')
"""
        docker(
            "run",
            "--rm",
            "-i",
            "--network",
            network,
            "-e",
            "TARGET=" + address,
            "--entrypoint",
            "python",
            image,
            "-",
            script=peer,
        )
        docker("restart", "--time", "90", name)
        ready()
        execute(verify)
        docker("stop", "--time", "90", name)
        state = json.loads(docker("inspect", name).stdout)[0]["State"]
        if state["ExitCode"] not in (0, 143) or state["OOMKilled"]:
            raise RuntimeError("Container did not shut down cleanly")
        docker("rm", name)
        start()
        ready()
        execute(verify)
        print(
            "PASS: non-root container, bundled dashboard/source, loopback gateway, LAN inference denial, restart/replacement persistence and clean shutdown; no inference performed"
        )
    finally:
        docker("rm", "-f", name, check=False)
        docker("network", "rm", network, check=False)
        docker("volume", "rm", volume, check=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="Explicit locally built image tag")
    parser.add_argument(
        "--user",
        default="1000:1000",
        help="Container UID:GID; Unraid template uses 99:100",
    )
    args = parser.parse_args()
    check(args.image, args.user)
