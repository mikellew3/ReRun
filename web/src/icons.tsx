/**
 * Icons: rounded, outlined, 1.75px stroke (Lucide shapes), per the design system. Decorative
 * by default (aria-hidden); pass a label when the icon carries meaning on its own.
 */

const PATHS = {
  logo: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  play: ['M6 4l14 8-14 8z'],
  clock: ['M12 6v6l4 2'],
  wind: [
    'M12.8 19.6A2 2 0 1 0 14 16H2',
    'M17.5 8a2.5 2.5 0 1 1 2 4H2',
    'M9.8 4.4A2 2 0 1 1 11 8H2',
  ],
  injury: ['M3 12h4l3-8 4 16 3-8h4'],
  rain: ['M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2', 'M16 14v6', 'M8 14v6', 'M12 16v6'],
  dome: ['M3 20h18', 'M5 20v-6a7 7 0 0 1 14 0v6'],
  mountain: ['M8 3l4 8 5-5 5 15H2L8 3z'],
  trendUp: ['M22 7l-8.5 8.5-5-5L2 17', 'M16 7h6v6'],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number; label?: string }) {
  const { name, size = 16, label } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      className="icon"
    >
      {name === 'clock' && <circle cx="12" cy="12" r="10" />}
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
