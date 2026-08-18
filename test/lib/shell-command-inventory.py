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
import subprocess
import sys

SEPARATORS = {';', '|', '||', '&', '&&', '(', ')', '{', '}', ';;'}
KEYWORDS = {'if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'function', '[[', ']]'}
BUILTINS = {
    'local', 'return', 'exit', 'set', 'export', 'trap', 'read', 'shift', 'unset',
    'source', '.', 'cd', 'pwd', 'test', '[', 'echo', 'printf', 'umask', 'true', 'false',
    'break', 'continue', 'wait', 'declare', 'readonly', 'shopt', ':',
}
# Wrappers keep command position OPEN: whatever follows them is itself a command. Each one gets
# its OWN rule (r8-F1) — a single generic "skip one variable argument" budget let
# `command "$CMD"` and `eval "$CMD"` pass as if the variable were a duration:
#   immediate — the very next non-flag word IS the command, so a variable there is DYNAMIC.
#   duration  — consumes exactly one duration argument (`timeout 5 cmd`, `timeout "$T" cmd`).
#   env       — consumes options and VAR=value assignments; `-S` embeds a whole command line and
#               is refused outright.
#   forbidden — `eval` runs text this analyzer cannot follow; it is reported, never inventoried.
WRAPPER_MODES = {
    'command': 'immediate', 'builtin': 'immediate', 'exec': 'immediate', 'nohup': 'immediate',
    'sudo': 'immediate', 'doas': 'immediate', 'nice': 'immediate', 'ionice': 'immediate',
    'stdbuf': 'immediate', 'setsid': 'immediate', 'time': 'immediate', 'flock': 'immediate',
    'chroot': 'immediate', 'unshare': 'immediate', 'xargs': 'immediate', 'watch': 'immediate',
    'timeout': 'duration',
    'env': 'env',
    'eval': 'forbidden',
}
WRAPPERS = set(WRAPPER_MODES)
# Shells whose `-c` argument is more shell: the body is inventoried too, so a call cannot hide
# one interpreter deep. A Python `-c` body is Python, not shell — outside this analyzer's reach
# and covered instead by `python3 -I` plus an explicit no-subprocess assertion in the test.
SHELLS = {'bash', 'sh', 'dash', 'ksh', 'zsh'}
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
    # An ARRAY LITERAL holds words, never commands: `A=( "$x" "$y" )`. bash --pretty-print puts
    # one on a single line, so dropping those lines is exact — and cannot unbalance a paren
    # counter the way stateful tracking did (r8-F1).
    text = '\n'.join(
        line for line in text.split('\n')
        if not re.match(r'^\s*[A-Za-z_][A-Za-z0-9_]*\+?=\(.*\)\s*;?\s*$', line)
    )
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
    wrapper_mode = None     # per-wrapper rule in force, see WRAPPER_MODES
    duration_used = False
    skip_next = False       # `env -u NAME`, a redirect target, a `for` variable
    case_state = None       # 'subject' -> until `in`; 'arm' -> until `)`
    case_depth = 0          # `esac` must POP: without it the last `;;` swallowed the rest of the
                            # file, which is exactly how an appended call went unseen (r8-F1)
    shell_cmd = False       # the current command is a shell; watch for its `-c` body
    capture_shell_body = False
    prev = None

    for tok in tokens:
        if tok == 'esac':
            # FIRST, before the case-state branches: an `arm` branch that swallowed `esac` left
            # the stack open and every later statement unread — which is how an appended call
            # went unseen (r8-F1, found by instrumenting the tail of this very script).
            case_depth = max(0, case_depth - 1)
            case_state = 'arm' if case_depth else None
            at_command = not case_depth
            prev = tok
            continue
        if case_state == 'subject':
            if tok == 'in':
                case_state = 'arm'
            prev = tok
            continue
        if case_state == 'arm':
            if tok == ')':
                case_state = None
                at_command = True
            prev = tok
            continue
        if capture_shell_body:
            # `bash -c '<shell>'`: the body is more shell, so inventory it too (r8-F1).
            found |= inventory(tok)
            capture_shell_body = False
            prev = tok
            continue
        if skip_next:
            skip_next = False
            prev = tok
            continue
        if tok == 'case':
            case_state, at_command = 'subject', False
            case_depth += 1
            prev = tok
            continue
        if tok == ';;':
            case_state = 'arm' if case_depth else None
            at_command = not case_depth
            prev = tok
            continue
        if tok == 'for':
            skip_next, at_command = True, False
            prev = tok
            continue
        if tok == 'in':
            at_command = False
            prev = tok
            continue
        if tok in SEPARATORS or tok in KEYWORDS:
            at_command, wrapper_mode, shell_cmd = True, None, False
            duration_used = False
            prev = tok
            continue
        if REDIRECTS.match(tok):
            skip_next = True
            prev = tok
            continue
        if shell_cmd and tok == '-c':
            capture_shell_body = True
            prev = tok
            continue
        if at_command:
            if ASSIGNMENT.match(tok):
                prev = tok
                continue
            if tok in WRAPPERS:
                found.add(tok)
                wrapper_mode = WRAPPER_MODES[tok]
                duration_used = False
                if wrapper_mode == 'forbidden':
                    # `eval` executes text no static analysis can follow. It is reported by a name
                    # no allowlist will carry, so its presence alone fails the comparison.
                    found.add('EVAL_UNANALYZABLE')
                prev = tok
                continue
            if tok.startswith('-'):
                if wrapper_mode == 'env':
                    if tok in ('-u', '--unset'):
                        skip_next = True
                    elif tok in ('-S', '--split-string') or tok.startswith('-S'):
                        # `env -S 'cmd args'` smuggles a whole command line past every rule here.
                        found.add('ENV_SPLIT_STRING')
                prev = tok
                continue
            if wrapper_mode == 'env' and ASSIGNMENT.match(tok):
                prev = tok
                continue
            if wrapper_mode == 'duration' and not duration_used:
                # EXACTLY the duration: a literal, or one variable. Whatever follows is the
                # command — including a variable, which is then reported as dynamic.
                if re.fullmatch(r'\d+[smhd]?', tok) or tok.startswith('$'):
                    duration_used = True
                    prev = tok
                    continue
            # Command word.
            if '/' in tok and not tok.startswith('$'):
                name = tok.rsplit('/', 1)[1]
                found.add(name)
                shell_cmd = name in SHELLS
            elif tok.startswith('$'):
                # Under `command`/`exec`/`env`/`xargs`/… this IS the command name, and under no
                # wrapper at all it still is: either way the name is unknowable (r8-F1).
                found.add('DYNAMIC_COMMAND')
                shell_cmd = False
            else:
                found.add(tok)
                shell_cmd = tok in SHELLS
            at_command, wrapper_mode = False, None
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
        # NO PATH resolution (r8-F1): a command missing from THIS runner must not vanish from the
        # inventory — that would make the guarantee depend on what happens to be installed.
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.+-]*', tok):
            continue
        out.add(tok)
    for name in sorted(out):
        print(name)
    return 0


if __name__ == '__main__':
    sys.exit(main())
