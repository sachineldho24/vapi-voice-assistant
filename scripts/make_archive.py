#!/usr/bin/env python3
"""Build the submission archive reproducibly.

Packaging has been the most error-prone step in this repo: an archive built by
hand on Windows once carried backslash entry names, which the ZIP format does
not permit and which CPython's extractor turns into single literally-named
files on POSIX, and a second one shipped stale against edited sources. This
script removes both failure modes and proves the secret files are absent.

    python scripts/make_archive.py

Writes ../Kapture_Finance_Maya_Final_Submission.zip and verifies, before it
returns 0, that every entry uses forward slashes, that no excluded path leaked
in, and that each entry's stored size equals the file on disk.
"""
from __future__ import annotations

import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(ROOT), "Kapture_Finance_Maya_Final_Submission.zip")

EXCLUDED_DIRS = {"node_modules", "logs", "recordings", ".git"}
EXCLUDED_FILES = {".env"}
EXCLUDED_SUFFIXES = (".zip", ".mp4", ".mp3", ".log")


def collect() -> list[str]:
    members: list[str] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDED_DIRS)
        for name in sorted(filenames):
            if name in EXCLUDED_FILES or name.endswith(EXCLUDED_SUFFIXES):
                continue
            absolute = os.path.join(dirpath, name)
            members.append(os.path.relpath(absolute, ROOT).replace(os.sep, "/"))
    return members


def main() -> int:
    members = collect()
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as archive:
        for member in members:
            archive.write(os.path.join(ROOT, member.replace("/", os.sep)), member)

    problems: list[str] = []
    with zipfile.ZipFile(OUT) as archive:
        names = archive.namelist()
        problems += [f"backslash entry: {n}" for n in names if "\\" in n]
        for part in EXCLUDED_DIRS | EXCLUDED_FILES:
            problems += [f"excluded path leaked: {n}" for n in names if part in n.split("/")]
        for info in archive.infolist():
            disk = os.path.join(ROOT, info.filename.replace("/", os.sep))
            actual = os.path.getsize(disk)
            if actual != info.file_size:
                problems.append(f"stale entry {info.filename}: zip={info.file_size} disk={actual}")

    print(f"{OUT}\n{len(names)} entries, {os.path.getsize(OUT)} bytes")
    if problems:
        print("\nFAILED:")
        for problem in problems:
            print(f"  {problem}")
        return 1
    print("forward slashes only, no excluded paths, every entry matches its source")
    return 0


if __name__ == "__main__":
    sys.exit(main())
