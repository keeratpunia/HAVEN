"""
Recomputes the static numbers quoted in the progress report (see docs/report/FACTS.md).

Usage (from the repository root):  python docs/report/scripts/facts.py
Test counts are not computed here: they come from running the suites (FACTS.md, section B).
"""
from __future__ import annotations

import glob
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def tracked_lines(prefixes: list[str], exts=(".ts", ".tsx", ".sql")) -> int:
    files = [f for f in git("ls-files", *prefixes).splitlines() if f.endswith(exts)]
    return sum(len((ROOT / f).read_text(encoding="utf-8").splitlines()) for f in files)


def main() -> None:
    first = git("log", "--reverse", "--format=%h %ad", "--date=short", "main").splitlines()[0]
    last = git("log", "-1", "--format=%h %ad", "--date=short", "main")
    print(f"commits on main: {git('rev-list', '--count', 'main')} (first {first}, last {last})")

    areas = {
        "api (src)": ["apps/api/src"],
        "api (test)": ["apps/api/test"],
        "app (app, lib, components)": ["apps/mobile/app", "apps/mobile/lib", "apps/mobile/components"],
        "app e2e": ["apps/mobile/e2e"],
        "shared": ["packages/shared/src"],
        "ui": ["packages/ui/src"],
        "sql (migrations + pgTAP)": ["supabase/migrations", "supabase/tests"],
    }
    for name, prefixes in areas.items():
        print(f"lines {name}: {tracked_lines(prefixes)}")
    all_files = [
        f
        for f in git("ls-files").splitlines()
        if f.endswith((".ts", ".tsx", ".sql", ".mjs")) and not f.startswith("docs/report")
    ]
    total = sum(len((ROOT / f).read_text(encoding="utf-8").splitlines()) for f in all_files)
    print(f"lines total (.ts .tsx .sql .mjs, excluding docs/report): {total}")

    pat = re.compile(r"\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*['`\"](/[^'`\"]*)['`\"]", re.S)
    endpoints = set()
    for f in glob.glob(str(ROOT / "apps/api/src/**/*.ts"), recursive=True):
        if ".test." in f:
            continue
        for m in pat.finditer(Path(f).read_text(encoding="utf-8")):
            endpoints.add((m.group(1).upper(), m.group(2)))
    print(f"API endpoints (unique method + path): {len(endpoints)}")

    screens = [p for p in (ROOT / "apps/mobile/app").rglob("*.tsx") if p.name != "_layout.tsx"]
    print(f"app screen route files (excluding layouts): {len(screens)}")

    migrations = sorted((ROOT / "supabase/migrations").glob("*.sql"))
    sql = "".join(p.read_text(encoding="utf-8") for p in migrations)
    tables = sorted(set(re.findall(r"create table (?:if not exists )?haven\.(\w+)", sql, re.I)))
    print(f"migrations: {len(migrations)}; haven tables: {len(tables)}")

    decisions = re.findall(r"^### (DEC-\d{3})", (ROOT / "docs/DECISIONS.md").read_text(encoding="utf-8"), re.M)
    print(f"decisions: {len(decisions)} ({decisions[0]}..{decisions[-1]})")

    runner = (ROOT / "apps/api/src/jobs/runner.ts").read_text(encoding="utf-8")
    jobs = sorted(set(re.findall(r"\{ fn: '(\w+)'", runner)))
    print(f"scheduled jobs: {len(jobs)} {jobs}")

    kinds = set()
    for f in glob.glob(str(ROOT / "packages/shared/src/**/*.ts"), recursive=True) + glob.glob(
        str(ROOT / "apps/api/src/notify/*.ts")
    ):
        kinds.update(re.findall(r"'(N-[A-Z-]+)'", Path(f).read_text(encoding="utf-8")))
    print(f"notification kinds: {len(kinds)}")


if __name__ == "__main__":
    main()
