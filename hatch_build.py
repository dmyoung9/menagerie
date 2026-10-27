"""Build the dashboard into wheels; runtime installations do not need Node."""
from pathlib import Path
import shutil
import subprocess

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        if self.target_name != "wheel":
            return
        npm = shutil.which("npm")
        if not npm:
            raise RuntimeError("Building Menagerie from source requires Node.js 22+ and npm. Install a prebuilt wheel to run without Node.")
        frontend = Path(self.root) / "frontend"
        subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=frontend, check=True)
        subprocess.run([npm, "run", "build"], cwd=frontend, check=True)
        build_data["force_include"][str(frontend / "dist")] = "controlplane/static"
        for name in ("index.ts", "discovery.ts", "package.json", "settings.json"):
            build_data["force_include"][str(Path(self.root) / "plugins/opencode" / name)] = f"controlplane/opencode_plugin/{name}"
