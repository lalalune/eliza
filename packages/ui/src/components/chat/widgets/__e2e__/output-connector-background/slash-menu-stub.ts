export function splitLeadingSlashCommand(text) {
  const match = /^(\/[\w-]+)(?=\s|$)/.exec(text);
  return match ? { command: match[1], rest: text.slice(match[1].length) } : null;
}
