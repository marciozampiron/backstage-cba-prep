#!/usr/bin/env python3
# Bounded process-GROUP runner (#111 r3-F2, r4-F2): every credential-bearing command and every
# local helper invocation the provisioning script makes after the SHA binding goes through here.
#
# The command starts as the leader of its OWN process group with stdout/stderr captured to FILES
# (never a command substitution — a pipe held open by a surviving grandchild blocks the parent
# long after the child died). On deadline the WHOLE GROUP is terminated: SIGTERM, grace, then
# SIGKILL to the GROUP regardless of what the leader did, repeated until the group is provably
# empty. Round 4 closed the hole this ordering had: the old loop stopped escalating as soon as
# the LEADER exited, so a descendant that ignored SIGTERM never received SIGKILL and could keep
# using the operator's credentials after the script had already refused.
#
# Exit codes: the command's own code on completion; 124 on deadline with the group provably
# empty; 125 on deadline with SURVIVORS (the caller must treat this as indeterminate and stop).
import os
import signal
import subprocess
import sys
import time

GRACE_SECONDS = 10
POLL_SECONDS = 0.05
EXIT_TIMEOUT = 124
EXIT_SURVIVORS = 125


def group_alive(pgid):
    """True while ANY process still carries this group id.

    Signal 0 only probes. The leader must be REAPED before this is meaningful: a zombie still
    occupies the process table and would answer as alive forever. PermissionError means a process
    exists that this uid may not signal — alive, and not something to wish away.
    """
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def reap_leader(proc, pgid):
    """Terminate and REAP the leader, so group_alive() stops seeing its zombie."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=GRACE_SECONDS)
            return
        except subprocess.TimeoutExpired:
            continue
    try:
        proc.wait(timeout=GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        pass


def kill_group(pgid):
    """Escalate to the WHOLE GROUP until it is provably empty. Independent of the leader.

    SIGKILL is re-sent every poll: a descendant may ignore SIGTERM, and one that was forking at
    the moment of the first signal must still be reached. Returns True when the group is empty.
    """
    deadline = time.monotonic() + GRACE_SECONDS
    while time.monotonic() < deadline:
        if not group_alive(pgid):
            return True
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            return True
        time.sleep(POLL_SECONDS)
    return not group_alive(pgid)


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
        pgid = proc.pid  # start_new_session makes the child its own group leader
        try:
            rc = proc.wait(timeout=int(seconds))
        except subprocess.TimeoutExpired:
            reap_leader(proc, pgid)
            if not kill_group(pgid):
                print('REFUSED: processes SURVIVED the deadline kill — the result is indeterminate', file=sys.stderr)
                return EXIT_SURVIVORS
            return EXIT_TIMEOUT
        # A command that finished on time may still have left the group populated (a daemonized
        # grandchild). Nothing may outlive this call: sweep, then report the command's own code.
        if group_alive(pgid) and not kill_group(pgid):
            print('REFUSED: processes SURVIVED after the command completed — the result is indeterminate', file=sys.stderr)
            return EXIT_SURVIVORS
        return rc


if __name__ == '__main__':
    sys.exit(main())
