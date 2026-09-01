/**
 * A shell word that is safe to transport through `cmux send` 0.62.2.
 *
 * cmux expands the two characters `\\n`, `\\r`, and `\\t` into key events
 * before the target shell parses quoting. Traditional `$'…'` escaping is
 * therefore unsafe for multiline prompts: its escaped newline submits part of
 * the launch command. Encode each dynamic value first, then decode it inside a
 * command substitution. Base64 never contains a backslash or shell quote, so
 * cmux cannot reinterpret prompt bytes as terminal input.
 */
export function decodedShellWord(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  // Command substitution strips every trailing newline from its output. Add a
  // non-newline sentinel inside the substitution, then remove only that byte
  // with zsh parameter expansion outside it. The resulting quoted word keeps
  // the decoded value byte-identical, including one or more final newlines.
  return `"\${\${:-$(printf %s '${encoded}' | /usr/bin/base64 -D; printf x)}%x}"`;
}
