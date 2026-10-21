#!/usr/bin/env python3
# Runs tools/bench/dvrcadence.py against the two fixtures that
# dvr_mux_writes_the_cadence_fixture (tests/test_dvr_mux.cpp) writes via
# DvrMux: a clean on-grid recording and one with a single off-grid hold.
# DEPENDS test_dvr_mux in tests/CMakeLists.txt makes that test run first;
# without it (e.g. `ctest -R test_dvrcadence` alone in a fresh build dir)
# the fixtures do not exist yet, so run() below fails with a clear message
# instead of handing subprocess a missing path and tracing back.
import os
import subprocess
import sys

TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "bench",
                     "dvrcadence.py")


def run(path, *extra_args):
    if not os.path.exists(path):
        sys.exit(f"fixture missing: {path} (run ctest -R test_dvr_mux first)")
    return subprocess.run([sys.executable, TOOL, path, *extra_args],
                           capture_output=True, text=True)


def check_on_grid_histogram(out):
    assert "x1=3" in out, out
    assert "x2=1" in out, out
    assert "x3=1" in out, out


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: test_dvrcadence.py <clean.mp4> <offgrid.mp4>")
    clean_path, offgrid_path = sys.argv[1], sys.argv[2]

    r = run(clean_path)
    assert r.returncode == 0, r.stdout + r.stderr
    check_on_grid_histogram(r.stdout)
    assert "off-grid: 0" in r.stdout, r.stdout
    assert "(inferred)" in r.stdout, r.stdout

    r = run(offgrid_path)
    assert r.returncode == 1, r.stdout + r.stderr
    check_on_grid_histogram(r.stdout)
    assert "off-grid: 1 at sample 5" in r.stdout, r.stdout
    assert "(inferred)" in r.stdout, r.stdout

    # Same file, grid pinned explicitly: same counts, "(given)" instead.
    r = run(offgrid_path, "--grid-us", "20000")
    assert r.returncode == 1, r.stdout + r.stderr
    check_on_grid_histogram(r.stdout)
    assert "off-grid: 1 at sample 5" in r.stdout, r.stdout
    assert "(given)" in r.stdout, r.stdout

    print("ok")


if __name__ == "__main__":
    main()
