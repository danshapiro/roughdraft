/** Conservative semantic cleanup: absorb only short islands between edits. */
export function shouldMergeDiffGap(
  gap: string,
  leftEditSize: number,
  rightEditSize: number,
): boolean {
  if (gap.length > 24 || /[\r\n]|[.!?;][)\]"'”’]*\s/u.test(gap)) return false;
  if ((gap.match(/[\p{L}\p{N}\p{M}_]+/gu)?.length ?? 0) > 2) return false;
  return gap.length <= leftEditSize && gap.length <= rightEditSize;
}
