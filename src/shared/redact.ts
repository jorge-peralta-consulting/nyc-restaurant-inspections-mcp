/** Remove secret values from text before it is logged or returned to the model. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let output = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) output = output.split(secret).join("[redacted]");
  }
  return output;
}
