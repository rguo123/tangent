/** `3 cards` / `1 card`. Written out four times across the chip and the review
 *  intervals before it was written once here. */
export function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}
