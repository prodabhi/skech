/**
 * Token marks.
 *
 * Drawn here rather than fetched, for the same reason the Bitcoin mark is:
 * an icon that arrives over the network is a third-party request on every
 * load, a blank square while it lands, and a broken square when it does not.
 * These are the official glyphs, simplified to what reads at twenty pixels.
 *
 * Each sets its own colours, so they look the same on either theme.
 */

type MarkProps = { className?: string };

const box = "shrink-0";

export function EthereumMark({ className }: MarkProps) {
  return (
    <svg aria-hidden="true" className={`${box} ${className ?? ""}`} viewBox="0 0 32 32">
      <circle cx="16" cy="16" fill="#627EEA" r="16" />
      <path d="M16 4.5v8.4l7.1 3.2z" fill="#fff" fillOpacity=".6" />
      <path d="M16 4.5 8.9 16.1l7.1-3.2z" fill="#fff" />
      <path d="M16 21.5v6l7.1-9.9z" fill="#fff" fillOpacity=".6" />
      <path d="M16 27.5v-6L8.9 17.6z" fill="#fff" />
      <path d="m16 20.1 7.1-4-7.1-3.2z" fill="#fff" fillOpacity=".2" />
      <path d="m8.9 16.1 7.1 4v-7.2z" fill="#fff" fillOpacity=".6" />
    </svg>
  );
}

export function UsdcMark({ className }: MarkProps) {
  return (
    <svg aria-hidden="true" className={`${box} ${className ?? ""}`} viewBox="0 0 32 32">
      <circle cx="16" cy="16" fill="#2775CA" r="16" />
      <path
        d="M20.5 18.5c0-2.4-1.4-3.2-4.3-3.5-2-.3-2.4-.8-2.4-1.8 0-1 .7-1.6 2.1-1.6 1.3 0 2 .4 2.3 1.5.1.2.3.4.5.4h1.1c.3 0 .5-.2.5-.5v-.1a3.6 3.6 0 0 0-3.2-2.9V8.4c0-.3-.2-.5-.6-.6h-1c-.3 0-.5.2-.6.6V10a3.5 3.5 0 0 0-3.2 3.4c0 2.3 1.4 3.2 4.2 3.5 1.9.3 2.5.7 2.5 1.9 0 1.1-1 1.9-2.3 1.9-1.8 0-2.4-.8-2.6-1.8 0-.3-.3-.4-.5-.4h-1.1c-.3 0-.5.2-.5.5v.1c.3 1.7 1.4 2.9 3.5 3.2v1.6c0 .3.2.5.6.6h1c.3 0 .5-.2.6-.6V22a3.7 3.7 0 0 0 3.4-3.5z"
        fill="#fff"
      />
      <path
        d="M13.1 24.9a9 9 0 0 1 0-17 .6.6 0 0 0 .4-.6v-.9c0-.3-.1-.4-.4-.4h-.1a11 11 0 0 0 0 20.8h.2c.3-.1.4-.3.4-.6v-.9c0-.2-.2-.4-.5-.4zm5.9-18.9h-.2c-.3.1-.4.3-.4.6v.9c0 .3.2.5.4.6a9 9 0 0 1 0 17 .6.6 0 0 0-.4.6v.9c0 .3.1.4.4.4h.2a11 11 0 0 0 0-20.9z"
        fill="#fff"
      />
    </svg>
  );
}
