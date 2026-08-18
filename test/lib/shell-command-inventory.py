#!/usr/bin/env python3
# External-command inventory for a bash script (#111 r6-F3, r7-F4).
#
# TWO STAGES, so this is not one more regex guessing at shell syntax:
#   1. `bash --pretty-print` — BASH'S OWN PARSER re-emits the script in canonical form: comments
#      gone, keywords and case arms separated, redirects and array literals regular. A file bash
#      cannot parse is refused outright rather than half-inventoried.
#   2. `shlex` with punctuation_chars over that canonical text, tracking command position through
#      the constructs that are NOT calls (case subjects and arms, for-in lists, array literals,
#      redirect targets) and through the ones that are (wrappers like `command`/`env`/`timeout`,
#      absolute paths, dynamic command names).
#
# It reports: every external program the script can execute, by program name; `DYNAMIC_COMMAND`
# when a command name comes from a variable, which no allowlist should ever contain.
#
# HONEST BOUNDARY. This guards against DRIFT — a new external call arriving unnoticed — and makes
# any deliberate addition visible in the diff of a pinned list. It is not a defense against the
# author of the very file it inventories, who could edit the allowlist in the same commit; that
# is what review is for.
import re
import shlex
import shutil
import subprocess
import sys

SEPARATORS = {';', '|', '||', '&', '&&', '(', ')', '{', '}', ';;'}
KEYWORDS = {'if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'esac', 'function', '[[', ']]'}
BUILTINS = {
    'local', 'return', 'exit', 'set', 'export', 'trap', 'read', 'shift', 'unset',
    'source', '.', 'cd', 'pwd', 'test', '[', 'echo', 'printf', 'umask', 'true', 'false',
    'break', 'continue', 'wait', 'declare', 'readonly', 'shopt', ':',
}
# Wrappers keep command position OPEN: whatever follows them is itself a command. `command`,
# `exec` and `eval` are here rather than in BUILTINS — `command curl ...` really does call curl.
WRAPPERS = {
    'command', 'builtin', 'exec', 'eval', 'env', 'nohup', 'timeout', 'xargs', 'sudo', 'doas',
    'nice', 'ionice', 'stdbuf', 'setsid', 'time', 'watch', 'flock', 'chroot', 'unshare',
}
REDIRECTS = re.compile(r'^\d*(>>?|<<?|>&|<&|&>)$')
ASSIGNMENT = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*\+?=')


def substitution_bodies(text):
    """Every `$( ... )` body, at any depth — a command substitution inside a quoted word is ONE
    shlex token, so `"$(head -n1 "$M")"` would otherwise hide a real call."""
    out = []
    i = 0
    while True:
        i = text.find('$(', i)
        if i < 0:
            return out
        depth, j = 1, i + 2
        while j < len(text) and depth:
            if text[j] == '(':
                depth += 1
            elif text[j] == ')':
                depth -= 1
            j += 1
        body = text[i + 2:j - 1]
        out.append(body)
        out.extend(substitution_bodies(body))
        i = j


def normalize(path):
    proc = subprocess.run(['bash', '--pretty-print', path], capture_output=True, text=True)
    if proc.returncode != 0:
        print(f'REFUSED: bash could not parse {path}', file=sys.stderr)
        raise SystemExit(2)
    return proc.stdout


def inventory(text):
    # shlex discards newlines, so without this every line after the first would read as arguments
    # of the previous command. Inserted inside a quoted string the `;` is just a character, so it
    # cannot change how a quoted chunk tokenizes.
    text = text.replace('\n', ' ; ')
    lex = shlex.shlex(text, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    try:
        tokens = list(lex)
    except ValueError:
        print('REFUSED: the canonical text could not be tokenized', file=sys.stderr)
        raise SystemExit(2)

    found = set()
    at_command = True
    in_wrapper = False
    var_budget = 0
    skip_next = False       # `env -u NAME`, a redirect target, a `for` variable
    case_state = None       # 'subject' -> until `in`; 'arm' -> until `)`
    depth_skip = 0          # inside an array literal `A=( ... )`
    prev = None

    for tok in tokens:
        if depth_skip:
            if tok == '(':
                depth_skip += 1
            elif tok == ')':
                depth_skip -= 1
                at_command = True
            prev = tok
            continue
        if case_state == 'subject':
            if tok == 'in':
                case_state = 'arm'
            prev = tok
            continue
        if case_state == 'arm':
            # Arm patterns are words, not commands; the body starts after `)`.
            if tok == ')':
                case_state = None
                at_command = True
            prev = tok
            continue
        if skip_next:
            skip_next = False
            prev = tok
            continue
        if tok == 'case':
            case_state = 'subject'
            at_command = False
            prev = tok
            continue
        if tok == ';;':
            case_state = 'arm'
            prev = tok
            continue
        if tok == 'for':
            skip_next = True            # the loop variable
            at_command = False
            prev = tok
            continue
        if tok == 'in':
            # The for-in list: words until the statement ends.
            at_command = False
            prev = tok
            continue
        if tok in SEPARATORS or tok in KEYWORDS:
            at_command, in_wrapper = True, False
            prev = tok
            continue
        if REDIRECTS.match(tok):
            skip_next = True
            prev = tok
            continue
        if at_command:
            if ASSIGNMENT.match(tok):
                if tok.endswith('=') or tok.endswith('=('):
                    pass
                prev = tok
                continue
            if tok == '(' and prev is not None and ASSIGNMENT.match(prev):
                depth_skip = 1
                prev = tok
                continue
            if tok in WRAPPERS:
                found.add(tok)
                in_wrapper, var_budget = True, 1
                prev = tok
                continue
            if tok.startswith('-'):
                if in_wrapper and tok in ('-u', '--unset'):
                    skip_next = True
                prev = tok
                continue
            if in_wrapper:
                # A wrapper's own arguments before its command word: `timeout 5 cmd`,
                # `timeout "$T" cmd`. ONE variable-shaped argument is consumed as a duration; a
                # second one is the command name, and is reported as dynamic.
                if re.fullmatch(r'\d+[smhd]?', tok):
                    prev = tok
                    continue
                if tok.startswith('$') and var_budget:
                    var_budget -= 1
                    prev = tok
                    continue
            if '/' in tok and not tok.startswith('$'):
                found.add(tok.rsplit('/', 1)[1])
            elif tok.startswith('$'):
                found.add('DYNAMIC_COMMAND')
            else:
                found.add(tok)
            at_command, in_wrapper = False, False
        prev = tok
    return found


def main():
    if len(sys.argv) != 2:
        print('usage: shell-command-inventory.py <script>', file=sys.stderr)
        return 2
    path = sys.argv[1]
    with open(path, encoding='utf-8') as f:
        functions = set(re.findall(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\)', f.read(), re.M))

    canonical = normalize(path)
    raw = set(inventory(canonical))
    for body in substitution_bodies(canonical):
        raw |= inventory(body)

    out = set()
    for tok in raw:
        if tok == 'DYNAMIC_COMMAND':
            out.add(tok)
            continue
        if tok in BUILTINS or tok in functions:
            continue
        if not re.fullmatch(r'[a-z][a-z0-9_.-]*', tok):
            continue
        if shutil.which(tok) is None:
            continue
        out.add(tok)
    for name in sorted(out):
        print(name)
    return 0


if __name__ == '__main__':
    sys.exit(main())
