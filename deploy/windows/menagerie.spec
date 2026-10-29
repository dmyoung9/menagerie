# Build only on native Windows, from the reviewed wheel installed in the build env.
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, copy_metadata

root = Path(SPECPATH)
datas, binaries, hiddenimports = collect_all('controlplane')
for package in ('fastapi', 'uvicorn', 'httpx', 'psutil', 'huggingface-hub', 'tqdm'):
    datas += copy_metadata(package, recursive=True)
hiddenimports += ['uvicorn.logging', 'uvicorn.loops.auto', 'uvicorn.protocols.http.auto',
                  'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan.on']

def application(entry, name, console):
    a = Analysis([str(root / entry)], pathex=[], binaries=binaries, datas=datas,
                 hiddenimports=hiddenimports, hookspath=[], runtime_hooks=[], excludes=[], noarchive=False)
    pyz = PYZ(a.pure)
    exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name=name, debug=False,
              bootloader_ignore_signals=False, strip=False, upx=False, console=console)
    return a, exe

gui, launcher = application('launcher_entry.py', 'Menagerie', False)
cli, command = application('cli_entry.py', 'menagerie-cli', True)
coll = COLLECT(launcher, command, gui.binaries, gui.datas, cli.binaries, cli.datas,
               strip=False, upx=False, name='Menagerie')
