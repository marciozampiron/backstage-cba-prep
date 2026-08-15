#!/usr/bin/env bash
# conformance-check probe: fails if the invoking shell's environment leaked into the child
if [ -n "$CBA_SECRET_PROBE" ]; then exit 1; fi
exit 0
