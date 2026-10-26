import csv
import io
import subprocess
import time
import os
from pathlib import Path
import psutil

_cpu_previous = {}


def sample():
    mem, swap = psutil.virtual_memory(), psutil.swap_memory()
    disk = psutil.disk_usage(Path.home())
    result = {"ts": time.time(), "cpu_count": len(psutil.Process().cpu_affinity()) if hasattr(psutil.Process(), "cpu_affinity") else psutil.cpu_count(), "cpu_percent": psutil.cpu_percent(), "ram_total_mib": mem.total / 1048576,
              "ram_available_mib": mem.available / 1048576, "swap_used_mib": swap.used / 1048576,
              "load_average": list(os.getloadavg()), "disk_free_gib": disk.free / 1024**3, "disk_total_gib": disk.total / 1024**3,
              "gpus": [], "processes": [], "errors": []}
    def query(kind, fields):
        p = subprocess.run(["nvidia-smi", f"--query-{kind}={fields}", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=4)
        if p.returncode:
            raise ValueError(p.stderr.strip()[:200])
        return list(csv.reader(io.StringIO(p.stdout)))
    def num(value):
        try:
            return float(value.strip())
        except ValueError:
            return None
    try:
        for row in query("gpu", "index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,clocks.current.sm"):
            result["gpus"].append(dict(zip(("index", "name", "total_mib", "used_mib", "free_mib", "utilization", "temperature", "power_w", "clock_mhz"), [int(row[0]), row[1].strip()] + [num(v) for v in row[2:]])))
        for row in query("compute-apps", "pid,process_name,used_memory"):
            result["processes"].append({"pid": int(row[0]), "name": row[1].strip(), "gpu_mib": num(row[2])})
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        result["errors"].append(str(exc))
    return result


def process_sample(pid):
    try:
        root = psutil.Process(pid)
        procs = [root] + root.children(recursive=True)
        rss = swap = cpu = 0
        pids = []
        for p in procs:
            try:
                pids.append(p.pid)
                rss += p.memory_info().rss
                swap += getattr(p.memory_full_info(), "swap", 0)
                now = time.monotonic()
                times = p.cpu_times()
                elapsed, total = _cpu_previous.get(p.pid, (now, times.user + times.system))
                if now > elapsed:
                    cpu += 100 * (times.user + times.system - total) / (now - elapsed)
                _cpu_previous[p.pid] = (now, times.user + times.system)
            except (psutil.Error, OSError):
                pass
        return {"rss_mib": rss / 1048576, "swap_mib": swap / 1048576, "cpu_percent": cpu, "pids": pids}
    except psutil.Error:
        return {"rss_mib": None, "swap_mib": None, "pids": []}
