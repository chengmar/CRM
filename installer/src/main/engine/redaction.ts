const commonSecretPatterns: RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /(?<=\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi,
  /(?:ya29\.|EA[A-Za-z0-9]{8,})[A-Za-z0-9._-]+/g,
];

export function redactText(input: string, knownSecrets: string[] = []): string {
  let output = input;
  for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) {
    if (secret.length < 4) continue;
    output = output.split(secret).join("REDACTED");
  }
  for (const pattern of commonSecretPatterns) output = output.replace(pattern, "REDACTED");
  return output;
}
