#!/usr/bin/env python3
# Bounded process-GROUP runner (#111 r3-F2): every external command the provisioning script runs
# goes through here. The command starts as the leader of its OWN process group with stdout/stderr
# captured to FILES (never a command substitution — a pipe held open by a surviving grandchild
# blocks the parent long after the child died). On deadline the WHOLE GROUP gets SIGTERM, a grace
# period, then SIGKILL — and the leader is REAPED before this process returns, so nothing keeps
# mutating behind a refusal that already reported INDETERMINATE. Exit 124 on timeout, else the
# command's own exit code.
import os
import signal
import subprocess
import sys

GRACE_SECONDS = 10


def main():
    if len(sys.argv) < 5:
        print('usage: bounded-run.py <seconds> <stdout-file> <stderr-file> <command...>', file=sys.stderr)
        return 2
    seconds = sys.argv[1]
    if not seconds.isdigit() or int(seconds) <= 0:
        print('REFUSED: the deadline must be a positive integer of seconds', file=sys.stderr)
        return 2
    out_path, err_path = sys.argv[2], sys.argv[3]
    cmd = sys.argv[4:]
    with open(out_path, 'wb') as out, open(err_path, 'wb') as err:
        proc = subprocess.Popen(cmd, stdout=out, stderr=err, start_new_session=True)
        try:
            return proc.wait(timeout=int(seconds))
        except subprocess.TimeoutExpired:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(proc.pid, sig)
                except ProcessLookupError:
                    break
                try:
                    proc.wait(timeout=GRACE_SECONDS)
                    break
                except subprocess.TimeoutExpired:
                    continue
            try:
                proc.wait(timeout=GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                pass
            return 124


if __name__ == '__main__':
    sys.exit(main())
