/** A private migration link can resume the same isolated demo history on a new origin. */
export function sessionFromHandoff(hash: string): string | null {
  const match = /^#resume-session=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(hash);
  return match?.[1]?.toLowerCase() ?? null;
}
