import csv
import io
import os
import subprocess
import time
from pathlib import Path

import psutil

from .host import executable

_cpu_previous = {}


def sample():
    mem, swap = psutil.virtual_memory(), psutil.swap_memory()
    disk = psutil.disk_usage(str(Path.home()))
    result = {
        "ts": time.time(),
        "cpu_count": len(psutil.Process().cpu_affinity())
        if hasattr(psutil.Process(), "cpu_affinity")
        else psutil.cpu_count(),
        "cpu_percent": psutil.cpu_percent(),
        "ram_total_mib": mem.total / 1048576,
        "ram_available_mib": mem.available / 1048576,
        "swap_used_mib": swap.used / 1048576,
        "disk_free_gib": disk.free / 1024**3,
        "disk_total_gib": disk.total / 1024**3,
        "gpus": [],
        "processes": [],
        "errors": [],
        # NVML reports host PIDs, which cannot safely be matched to this image's
        # isolated PID namespace. Keep global GPU metrics, not false per-model 0s.
        "gpu_process_attribution": os.environ.get("MENAGERIE_CONTAINER") != "1",
    }
    if hasattr(os, "getloadavg"):
        result["load_average"] = list(os.getloadavg())

    def query(kind, fields):
        p = subprocess.run(
            [
                executable("nvidia-smi") or "nvidia-smi",
                f"--query-{kind}={fields}",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=4,
            **(
                {"creationflags": subprocess.CREATE_NO_WINDOW}
                if os.name == "nt"
                else {}
            ),
        )
        if p.returncode:
            raise ValueError(p.stderr.strip()[:200])
        return list(csv.reader(io.StringIO(p.stdout)))

    def num(value):
        try:
            return float(value.strip())
        except ValueError:
            return None

    try:
        for row in query(
            "gpu",
            "index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,clocks.current.sm",
        ):
            result["gpus"].append(
                dict(
                    zip(
                        (
                            "index",
                            "name",
                            "total_mib",
                            "used_mib",
                            "free_mib",
                            "utilization",
                            "temperature",
                            "power_w",
                            "clock_mhz",
                        ),
                        [int(row[0]), row[1].strip()] + [num(v) for v in row[2:]],
                    )
                )
            )
        for row in query("compute-apps", "pid,process_name,used_memory"):
            result["processes"].append(
                {"pid": int(row[0]), "name": row[1].strip(), "gpu_mib": num(row[2])}
            )
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        result["errors"].append(str(exc))
        result["gpu_process_attribution"] = False
    return result


def gpu_process_usage(host, pids):
    if not host.get("gpus") or host.get("gpu_process_attribution") is False:
        return None
    values = [p["gpu_mib"] for p in host.get("processes", []) if p["pid"] in pids]
    return None if any(v is None for v in values) else sum(values)


def process_sample(pid):
    try:
        root = psutil.Process(pid)
        procs = [root] + root.children(recursive=True)
        rss = swap = cpu = 0
        swap_available = True
        pids = []
        for p in procs:
            try:
                pids.append(p.pid)
                rss += p.memory_info().rss
                memory = p.memory_full_info()
                if hasattr(memory, "swap"):
                    swap += memory.swap
                else:
                    swap_available = False
                now = time.monotonic()
                times = p.cpu_times()
                elapsed, total = _cpu_previous.get(
                    p.pid, (now, times.user + times.system)
                )
                if now > elapsed:
                    cpu += 100 * (times.user + times.system - total) / (now - elapsed)
                _cpu_previous[p.pid] = (now, times.user + times.system)
            except (psutil.Error, OSError):
                swap_available = False
                pass
        return {
            "rss_mib": rss / 1048576,
            "swap_mib": swap / 1048576 if swap_available else None,
            "cpu_percent": cpu,
            "pids": pids,
        }
    except psutil.Error:
        return {"rss_mib": None, "swap_mib": None, "pids": []}
