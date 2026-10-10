"""Launch the packaged native UI; catch missing deployment libraries and QML errors.

This verifies startup only. It cannot prove streaming latency or hardware decode.
"""
from pathlib import Path
import os
import re
import subprocess
import sys

executable = Path(sys.argv[1]).resolve()
environment = dict(os.environ)
# Do not let the development SDK mask missing packaged dependencies.
for key in ("QT_PLUGIN_PATH", "QT_QPA_PLATFORM_PLUGIN_PATH", "QML2_IMPORT_PATH", "QML_IMPORT_PATH", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH"):
    environment.pop(key, None)
process = subprocess.Popen([str(executable)], cwd=executable.parent, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
early_exit = False
try:
    output, _ = process.communicate(timeout=10)
    early_exit = True
except subprocess.TimeoutExpired:
    process.terminate()
    try:
        output, _ = process.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        output, _ = process.communicate()

match = re.search(r"Redirecting log output to ([^\r\n]+)", output)
if match and Path(match.group(1)).is_file():
    output += "\n" + Path(match.group(1)).read_text(errors="replace")
failures = [line for line in output.splitlines() if re.search(
    r"QQmlApplicationEngine failed|ReferenceError:|TypeError:|Cannot assign|is not a type|module .+ is not installed|Could not load the Qt platform plugin|Library not loaded", line)]
if early_exit or failures:
    print(output[-10000:])
    sys.exit("Packaged client failed startup validation.")
print("PASS: packaged native client remained running and emitted no QML/deployment errors.")
