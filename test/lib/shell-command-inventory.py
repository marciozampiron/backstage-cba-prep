#!/usr/bin/env python3
# Structural command inventory for a bash script (#111 r6-F3).
#
# The regex scanner this replaces tripped on prose and case arms, and a fragile guard only teaches
# people to loosen it. This uses `shlex` with punctuation_chars, which understands quoting: a
# quoted string — including an embedded Python body — is ONE token and can never look like a
# command, and `;`/`|`/`&`/`(`/`)` are separate tokens, so command position is structural rather
# than guessed.
#
# Prints one command name per line: every token that appears where bash would start a command.
# Callers compare that set against their allowlist in BOTH directions.
import re
import shlex
import shutil
import sys

# Tokens that introduce a new command position when they precede one.
SEPARATORS = {';', '|', '||', '&', '&&', '(', ')', '{', '}', ';;', '\n'}
KEYWORDS = {
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
    'in', 'function', 'time', '!', '[[', ']]', '{', '}',
}
# Shell builtins and syntax that are not external commands.
BUILTINS = {
    'local', 'return', 'exit', 'set', 'export', 'trap', 'read', 'shift', 'unset', 'eval',
    'source', '.', 'cd', 'pwd', 'test', '[', 'echo', 'printf', 'umask', 'true', 'false',
    'break', 'continue', 'wait', 'exec', 'declare', 'readonly', 'shopt', 'command', ':',
}


def substitution_bodies(text):
    """Every `$( ... )` body, at any nesting depth, as its own snippet.

    A command substitution inside double quotes is ONE shlex token, so its commands would be
    invisible — `"$(head -n1 "$M")"` really does invoke `head`. Depth counting finds the matching
    paren instead of a regex guessing at it.
    """
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


def logical_lines(text):
    """Statement boundaries, which shlex discards: continuations joined, one entry per line."""
    joined = re.sub(r'\\\n', ' ', text)
    return [ln for ln in joined.split('\n') if ln.strip() and not ln.lstrip().startswith('#')]


def inventory(text):
    found = set()
    snippets = logical_lines(text)
    for body in substitution_bodies(text):
        snippets.extend(logical_lines(body))
    for line in snippets:
        lex = shlex.shlex(line, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        try:
            tokens = list(lex)
        except ValueError:
            # A line whose quoting does not close on its own (a quoted string spanning lines, as
            # the inline Python bodies do) is not a statement boundary this pass can judge; the
            # substitution walk and the other lines still cover the file.
            continue
        at_command = True
        for tok in tokens:
            if tok in SEPARATORS or tok in KEYWORDS:
                at_command = True
                continue
            if at_command:
                # Assignments (`X=1 cmd`) keep command position open; so does a redirect target.
                if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', tok) or tok.startswith('<') or tok.startswith('>'):
                    continue
                found.add(tok)
                at_command = False
    return found


def main():
    if len(sys.argv) != 2:
        print('usage: shell-command-inventory.py <script>', file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding='utf-8') as f:
        text = f.read()

    # Functions this script defines are not external programs.
    functions = set(re.findall(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\)', text, re.M))

    out = set()
    for tok in inventory(text):
        if tok in BUILTINS or tok in functions:
            continue
        # A candidate is only an EXTERNAL COMMAND if it names a real program. Case-arm words,
        # flags, numbers and variable expansions do not resolve, and are not calls.
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
