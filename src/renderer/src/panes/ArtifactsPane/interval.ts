import { plural } from '../../lib/plural'

/**
 * The scheduler's next interval, as a person would say it.
 *
 * Intervals are stored in fractional days precisely so a 10-minute learning
 * step and a 3-day review are distinguishable; this is the other half of that
 * decision — rounding a first-review interval to "0 days" would read as a bug.
 */
export function formatInterval(days: number | null): string {
  if (days === null) return 'unknown'

  const minutes = Math.round(days * 24 * 60)
  if (minutes < 60) return plural(Math.max(1, minutes), 'minute')
  if (minutes < 1440) return plural(Math.round(minutes / 60), 'hour')
  if (days < 30) return plural(Math.round(days), 'day')
  if (days < 365) return plural(Math.round(days / 30), 'month')
  return plural(Math.round(days / 365), 'year')
}
