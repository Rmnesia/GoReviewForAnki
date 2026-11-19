"""Extract the bundled KataGo engine + analysis config from KaTrain.exe (PyInstaller CArchive)."""
import struct, os, sys, zlib
SRC = os.environ.get("KATRAIN_EXE", r"E:/Katrain/KaTrain.exe")
OUT = os.environ.get("ENGINE_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "engine"))
size = os.path.getsize(SRC)
with open(SRC, "rb") as f:
    f.seek(size - 8192); tail = f.read()
magic = b"MEI\x0c\x0b\x0a\x0b\x0e"
pos = tail.rfind(magic)
if pos < 0: sys.exit("PyInstaller cookie not found")
c = tail[pos:]
pkglen, tocoff, toclen, pyver = struct.unpack("!IIII", c[8:24])
base = size - pkglen
with open(SRC, "rb") as f:
    f.seek(base + tocoff); toc = f.read(toclen)
entries, i = [], 0
while i + 18 <= len(toc):
    (elen,) = struct.unpack("!I", toc[i:i+4])
    if elen < 18 or i + elen > len(toc): break
    off, clen, ulen, flag, typ = struct.unpack("!IIIBc", toc[i+4:i+18])
    name = toc[i+18:i+elen].split(b"\0")[0].decode("utf-8", "replace")
    entries.append((name, typ.decode(errors="replace"), off, clen, ulen, flag))
    i += elen
os.makedirs(OUT, exist_ok=True)
n = 0
with open(SRC, "rb") as f:
    for name, typ, off, clen, ulen, flag in entries:
        low = name.lower()
        if not (low.startswith("katrain\\katago\\") or low in ("opencl.dll",)):
            continue
        f.seek(base + off); data = f.read(clen)
        if flag: data = zlib.decompress(data)
        rel = name.replace("\\", "/").split("/")[-1]
        dst = os.path.join(OUT, rel)
        with open(dst, "wb") as o: o.write(data)
        print(f"  {rel:32s} {len(data):>9d} bytes")
        n += 1
print(f"Extracted {n} files -> {OUT}")
