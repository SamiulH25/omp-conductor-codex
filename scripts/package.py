#!/usr/bin/env python3
"""Package the self-contained plugin without development files or dependencies."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'plugin.json').read_text())
output = root / 'artifacts' / f"{manifest['name']}-{manifest['version']}.zip"
output.parent.mkdir(exist_ok=True)
files = [root / name for name in ('plugin.json', 'mcp.json', 'README.md', 'LICENSE', 'dist/server.mjs', 'dist/companion.mjs', '.agents/plugins/marketplace.json')]
for directory in ('bin', 'extensions', 'skills'):
    files.extend(p for p in (root / directory).rglob('*') if p.is_file())
with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
    for path in sorted(files):
        archive.write(path, f"{manifest['name']}/{path.relative_to(root)}")
print(output)
