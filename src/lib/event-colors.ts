/**
 * FullCalendar colour props for an event. Busy events are filled with the
 * calendar colour; free events (like Motion) get a light tint of it, a
 * thin border in the colour and dark readable text, so they sit quietly
 * behind busy events. Mixing with the theme's background/foreground keeps
 * this right in dark mode too.
 */
export function eventColorProps(
  color: string,
  isFree?: boolean
): { backgroundColor: string; borderColor: string; textColor?: string } {
  if (!isFree) return { backgroundColor: color, borderColor: color };
  return {
    backgroundColor: `color-mix(in srgb, ${color} 14%, hsl(var(--background)))`,
    borderColor: `color-mix(in srgb, ${color} 60%, hsl(var(--background)))`,
    textColor: `color-mix(in srgb, ${color} 45%, hsl(var(--foreground)))`,
  };
}
