#!/bin/sh
# Builds the Chrome Web Store ZIP of the extension:  sh scripts/build-extension.sh [https://your.server]
# The store build differs from extension/ (the developer copy) in three ways:
#   - no "proxy", "webRequest", "webRequestAuthProvider" permissions — pages are read on the server through
#     the proxy list, so the extension never needs them (fewer permissions = a smoother store review)
#   - host access only to Facebook, localhost and the server (not <all_urls>); other servers ask at runtime
#   - the server URL is filled in already (default https://specter.monster)
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
SERVER="${1:-https://specter.monster}"
SERVER="${SERVER%/}"
OUT=dist
VERSION=$(python3 -c 'import json;print(json.load(open("extension/manifest.json"))["version"])')
ZIP="$OUT/fb-lead-finder-extension-$VERSION.zip"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cp -r extension/. "$TMP/"
python3 - "$TMP" "$SERVER" <<'PY'
import json, sys, pathlib
root, server = pathlib.Path(sys.argv[1]), sys.argv[2]
m = json.loads((root / "manifest.json").read_text())
drop = {"proxy", "webRequest", "webRequestAuthProvider"}
m["permissions"] = [p for p in m["permissions"] if p not in drop]
m["host_permissions"] = ["https://*.facebook.com/*", "http://localhost/*", "http://127.0.0.1/*", server + "/*"]
m["optional_host_permissions"] = ["https://*/*"]
# the dashboard helper (starts a search at once) runs on this server's dashboard
for cs in m["content_scripts"]:
    if "content/dashboard.js" in cs["js"]:
        cs["matches"] = sorted({server + "/*", "http://localhost/*", "http://127.0.0.1/*"})
(root / "manifest.json").write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n")
for f in ["background.js", "popup/popup.js", "popup/popup.html"]:
    p = root / f
    p.write_text(p.read_text().replace("http://localhost:3002", server))
print("permissions:", ", ".join(m["permissions"]))
print("hosts:", ", ".join(m["host_permissions"]))
PY

mkdir -p "$OUT"
rm -f "$ZIP"
(cd "$TMP" && python3 -c 'import zipfile,os,sys
z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)
for d,_,fs in os.walk("."):
    for f in fs:
        p=os.path.join(d,f)[2:]
        if not f.startswith("."): z.write(p,p)
z.close()' "$ROOT/$ZIP")
echo "built $ZIP ($(du -h "$ZIP" | cut -f1)) for $SERVER"
