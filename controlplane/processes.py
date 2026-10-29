"""Owned process trees: POSIX sessions or Windows kill-on-close Job Objects."""

import asyncio
import contextlib
import os
import signal
import subprocess
import time

import psutil

_jobs = {}


def exit_reason(code):
    if os.name == "nt":
        reasons = {
            0xC0000135: "required DLL missing; reinstall the verified engine and check its prerequisites",
            0xC000007B: "incompatible executable/DLL architecture; use a matching Windows x64 build",
            0xC0000142: "DLL initialization failed; check engine and driver compatibility",
            0xC000001D: "CPU instruction unavailable; choose a compatible engine build",
        }
        unsigned = code & 0xFFFFFFFF
        if unsigned in reasons:
            return f"0x{unsigned:08X}: {reasons[unsigned]}"
    return str(code)


class WindowsJob:
    def __init__(self):
        import ctypes
        from ctypes import wintypes as w

        class Basic(ctypes.Structure):
            _fields_ = [
                ("process_time", ctypes.c_int64),
                ("job_time", ctypes.c_int64),
                ("flags", w.DWORD),
                ("min_working", ctypes.c_size_t),
                ("max_working", ctypes.c_size_t),
                ("active", w.DWORD),
                ("affinity", ctypes.c_size_t),
                ("priority", w.DWORD),
                ("scheduling", w.DWORD),
            ]

        class Limits(ctypes.Structure):
            _fields_ = [
                ("basic", Basic),
                ("io", ctypes.c_uint64 * 6),
                ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t),
                ("peak_process", ctypes.c_size_t),
                ("peak_job", ctypes.c_size_t),
            ]

        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": ([ctypes.c_void_p, w.LPCWSTR], w.HANDLE),
            "SetInformationJobObject": (
                [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD],
                w.BOOL,
            ),
            "AssignProcessToJobObject": ([w.HANDLE, w.HANDLE], w.BOOL),
            "OpenProcess": ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
            "OpenThread": ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
            "ResumeThread": ([w.HANDLE], w.DWORD),
            "CloseHandle": ([w.HANDLE], w.BOOL),
        }
        for name, (args, result) in signatures.items():
            fn = getattr(self.api, name)
            fn.argtypes, fn.restype = args, result
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = Limits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.api.SetInformationJobObject(
            self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())

    def attach_and_resume(self, pid):
        import ctypes

        # The primary thread is still suspended: descendants cannot race assignment.
        handle = self.api.OpenProcess(0x0100 | 0x0001, False, pid)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not self.api.AssignProcessToJobObject(self.handle, handle):
                raise ctypes.WinError(ctypes.get_last_error())
            self.pid_started = psutil.Process(pid).create_time()
            threads = psutil.Process(pid).threads()
            if len(threads) != 1:
                raise RuntimeError("Suspended worker did not have exactly one thread")
            thread = self.api.OpenThread(0x0002, False, threads[0].id)
            if not thread:
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                if self.api.ResumeThread(thread) == 0xFFFFFFFF:
                    raise ctypes.WinError(ctypes.get_last_error())
            finally:
                self.api.CloseHandle(thread)
        finally:
            self.api.CloseHandle(handle)

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


async def spawn(*argv, **kwargs):
    job = WindowsJob() if os.name == "nt" else None
    proc = None
    try:
        options = (
            {"creationflags": 0x00000004 | subprocess.CREATE_NEW_PROCESS_GROUP}
            if job
            else {"start_new_session": True}
        )
        if job:
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 0  # Preserve a console for Ctrl+Break, but hide it.
            options["startupinfo"] = startup
        # PyInstaller sets its own DLL directory. Do not leak bundled Python
        # libraries into an external engine's loader search path.
        if job:
            import ctypes
            import sys

            dll = ctypes.WinDLL("kernel32", use_last_error=True)
            # Inherited by children; never let a missing DLL or crash dialog
            # turn a bounded capability probe into an invisible modal prompt.
            dll.SetErrorMode(0x0001 | 0x0002 | 0x8000)
            dll.SetDllDirectoryW.argtypes = [ctypes.c_wchar_p]
            dll.SetDllDirectoryW(None)
        try:
            creation = asyncio.create_task(
                asyncio.create_subprocess_exec(*argv, **kwargs, **options)
            )
            try:
                proc = await asyncio.shield(creation)
            except asyncio.CancelledError:
                # Recover the handle before propagating cancellation. Otherwise
                # Windows can leave an unassigned suspended worker behind.
                proc = await creation
                if job:
                    proc.kill()
                else:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(proc.pid, signal.SIGKILL)
                await proc.wait()
                raise
        finally:
            if job and getattr(sys, "frozen", False):
                dll.SetDllDirectoryW(sys._MEIPASS)
        if job:
            job.attach_and_resume(proc.pid)
            _jobs[proc.pid] = job
        return proc
    except BaseException:
        if job:
            job.close()
        if proc and proc.returncode is None:
            proc.kill()
            await proc.wait()
        raise


def owned(deployment):
    try:
        p = psutil.Process(deployment["pid"])
        return (
            p.is_running()
            and p.status() != psutil.STATUS_ZOMBIE
            and abs(p.create_time() - deployment["pid_started"]) < 0.01
            and (p.pid in _jobs if os.name == "nt" else os.getpgid(p.pid) == p.pid)
        )
    except (KeyError, TypeError, psutil.Error, ProcessLookupError):
        return False


def release(pid):
    job = _jobs.pop(pid, None)
    if job:
        job.close()


async def terminate(deployment, grace=20):
    pid = deployment.get("pid")
    if owned(deployment):
        with contextlib.suppress(ProcessLookupError, OSError):
            if os.name == "nt":
                import ctypes

                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                # A windowed daemon has no console. Temporarily attach to the
                # worker's hidden console to deliver its graceful break event.
                attached = kernel.AttachConsole(pid)
                try:
                    os.kill(pid, signal.CTRL_BREAK_EVENT)
                finally:
                    if attached:
                        kernel.FreeConsole()
            else:
                os.killpg(pid, signal.SIGTERM)
        deadline = time.monotonic() + grace
        while owned(deployment) and time.monotonic() < deadline:
            await asyncio.sleep(0.1)
        if os.name != "nt" and owned(deployment):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(pid, signal.SIGKILL)
    job = _jobs.get(pid)
    if os.name != "nt" or (
        job and abs(job.pid_started - deployment.get("pid_started", 0)) < 0.01
    ):
        release(pid)
