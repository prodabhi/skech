/**
 * Only the neutral fills change in dark mode. Three luminance masks keep the
 * brand blue and the up/down colours intact. Alpha is applied once, after the
 * recolouring, so overlapping masks cannot create fringes along PNG edges.
 * sRGB is explicit: the thresholds are measured against the artwork's palette.
 */
export function IllustrationPalette() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute"
      focusable="false"
      height="0"
      width="0"
    >
      <defs>
        <NeutralInkFilter id="illustration-dark-palette" />
        <NeutralInkFilter
          id="illustration-dark-palette-flat"
          paper="#35312b"
          sand="#35312b"
        />
      </defs>
    </svg>
  );
}

function NeutralInkFilter({
  id,
  paper = "#292725",
  sand = "#454039",
}: {
  id: string;
  paper?: string;
  sand?: string;
}) {
  return (
    <filter
      colorInterpolationFilters="sRGB"
      height="100%"
      id={id}
      width="100%"
      x="0%"
      y="0%"
    >
      <feComponentTransfer in="SourceGraphic" result="opaqueArtwork">
        <feFuncA tableValues="1 1" type="table" />
      </feComponentTransfer>
      <feColorMatrix
        in="SourceGraphic"
        type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 1 1 0 -2.4"
      />
      <feComponentTransfer result="sandMask">
        <feFuncA slope="64" type="linear" />
      </feComponentTransfer>
      <feFlood floodColor={sand} />
      <feComposite in2="sandMask" operator="in" result="sand" />

      <feColorMatrix
        in="SourceGraphic"
        type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 1 1 0 -2.7"
      />
      <feComponentTransfer result="paperMask">
        <feFuncA slope="64" type="linear" />
      </feComponentTransfer>
      <feFlood floodColor={paper} />
      <feComposite in2="paperMask" operator="in" result="paper" />

      <feColorMatrix
        in="SourceGraphic"
        type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1 -1 -1 0 0.8"
      />
      <feComponentTransfer result="inkMask">
        <feFuncA intercept="-0.1" slope="12" type="linear" />
      </feComponentTransfer>
      <feFlood floodColor="#e2d6c5" />
      <feComposite in2="inkMask" operator="in" result="ink" />

      <feMerge>
        <feMergeNode in="opaqueArtwork" />
        <feMergeNode in="sand" />
        <feMergeNode in="paper" />
        <feMergeNode in="ink" />
      </feMerge>
      <feComposite in2="SourceAlpha" operator="in" />
    </filter>
  );
}
