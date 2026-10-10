import { Avatar, Style } from "@dicebear/core";
import dylan from "@dicebear/styles/dylan.json" with { type: "json" };
import styles from "./crowd.module.css";

/**
 * Four other players, mid-drawing: a line each, with the face that drew it at its head.
 *
 * The faces are the same "Dylan" avatars the game gives everyone (ui/app/src/lib/avatar.ts), from the same style
 * and the same generator, so the strangers on this page are drawn the way the strangers in the game are. They are
 * made once when this module loads, on the server, and ship as part of the markup.
 */

const style = new Style(dylan);
const faceOf = (seed: string) => new Avatar(style, { seed }).toDataUri();

/*
  Lines in a 160 x 96 field. Each one ends where its face sits, so the two are placed from the same numbers and
  cannot drift apart. The hues are spread far enough to stay distinct against the sand behind them.
*/
const PLAYERS = [
  { seed: "ava", hue: 226, d: "M6 66 C 30 60, 50 46, 74 48 S 112 30, 132 20", end: [132, 20] },
  { seed: "nilo", hue: 150, d: "M6 78 C 28 76, 52 68, 72 70 S 110 58, 128 50", end: [128, 50] },
  { seed: "rue", hue: 28, d: "M6 52 C 26 44, 48 50, 70 38 S 108 40, 126 34", end: [126, 34] },
  { seed: "obi", hue: 288, d: "M6 88 C 30 86, 54 84, 76 80 S 114 74, 130 70", end: [130, 70] },
] as const;

const FIELD = { width: 160, height: 96 };

export function Crowd() {
  return (
    <div className={styles.crowd}>
      <svg aria-hidden="true" className={styles.lines} fill="none" viewBox={`0 0 ${FIELD.width} ${FIELD.height}`}>
        {PLAYERS.map(player => (
          <path
            d={player.d}
            key={player.seed}
            stroke={`oklch(0.62 0.17 ${player.hue})`}
            strokeLinecap="round"
            strokeOpacity={player.hue === 226 ? 1 : 0.72}
            strokeWidth={player.hue === 226 ? 2.6 : 2}
          />
        ))}
      </svg>
      {PLAYERS.map(player => (
        // eslint-disable-next-line @next/next/no-img-element -- an inline SVG data URI: there is no file for next/image to fetch, size or optimise.
        <img
          alt=""
          aria-hidden="true"
          className={styles.face}
          key={player.seed}
          src={faceOf(player.seed)}
          style={{
            left: `${(player.end[0] / FIELD.width) * 100}%`,
            top: `${(player.end[1] / FIELD.height) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}
