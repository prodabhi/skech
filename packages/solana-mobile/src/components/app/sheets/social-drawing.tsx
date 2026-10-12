import { useEffect, useRef, useState } from 'react'
import { Linking, Pressable, Share, Text, View } from 'react-native'
import Svg, { Path, Rect } from 'react-native-svg'
import { playerName, type ProfileResponse, type PublicDrawing } from '@skech/core/social'
import { PlayerAvatar } from '@/components/app/player-avatar'
import { useChain } from '@/components/app/ink/chain-context'
import { Button, Spinner, useColors } from '@/components/ui'
import { socialMoney, socialRequest, useSocial } from '@/lib/social'
import { cn } from '@/lib/utils'

export function ShareDrawing({ player, drawing }: { player: string; drawing?: string }) {
  const [error, setError] = useState(false)
  const url = `https://skech.trade/?${drawing ? 'drawing' : 'player'}=${encodeURIComponent(drawing ?? player)}`
  return (
    <>
      <Button
        size="md"
        variant="secondary"
        onPress={() =>
          void Share.share({ title: drawing ? 'A drawing on skech' : 'Draw with me on skech', message: url }).catch(
            () => setError(true),
          )
        }
      >
        Share {drawing ? 'drawing' : 'profile'}
      </Button>
      {error ? <Text className="text-[13px] text-muted-foreground">Could not share. Try again.</Text> : null}
    </>
  )
}

/** Uses the web's 160 × 80 coordinate system for both strokes and chain-only bands. */
export function DrawingPreview({
  drawing,
  width = 160,
  height = 80,
}: {
  drawing: PublicDrawing
  width?: number | string
  height?: number
}) {
  const c = useColors()
  const strokes = drawing.pieces.flatMap((piece) => (piece.stroke ? [piece.stroke] : []))
  const points = strokes.flatMap((stroke) => stroke.pts.map((p) => ({ t: stroke.t0 + p.t, p: stroke.p0 + p.p })))
  if (!points.length) {
    const bands = drawing.pieces.flatMap((piece) =>
      piece.sections.map((s) => ({
        t: piece.openAt + s.second * 1000,
        lo: Number(s.lo) / 1e8,
        hi: Number(s.hi) / 1e8,
      })),
    )
    if (!bands.length) return <Text className="text-[12px] text-muted-foreground">Ink</Text>
    let t0 = Infinity,
      t1 = -Infinity,
      lo = Infinity,
      hi = -Infinity
    for (const b of bands) {
      t0 = Math.min(t0, b.t)
      t1 = Math.max(t1, b.t + 1000)
      lo = Math.min(lo, b.lo)
      hi = Math.max(hi, b.hi)
    }
    const sx = (t: number) => 10 + ((t - t0) / Math.max(1000, t1 - t0)) * 140
    const sy = (p: number) => 70 - ((p - lo) / Math.max(0.01, hi - lo)) * 60
    return (
      <Svg accessibilityLabel="Where the drawing was" width={width} height={height} viewBox="0 0 160 80">
        {bands.map((b, i) => (
          <Rect
            key={i}
            fill={c.brand}
            opacity={0.55}
            rx={2}
            x={sx(b.t)}
            y={sy(b.hi)}
            width={Math.max(3, sx(b.t + 1000) - sx(b.t) - 1)}
            height={Math.max(3, sy(b.lo) - sy(b.hi))}
          />
        ))}
      </Svg>
    )
  }
  let loT = Infinity,
    hiT = -Infinity,
    loP = Infinity,
    hiP = -Infinity
  for (const p of points) {
    loT = Math.min(loT, p.t)
    hiT = Math.max(hiT, p.t)
    loP = Math.min(loP, p.p)
    hiP = Math.max(hiP, p.p)
  }
  return (
    <Svg accessibilityLabel="The drawing" width={width} height={height} viewBox="0 0 160 80">
      {strokes.map((stroke, i) => (
        <Path
          key={i}
          d={stroke.pts
            .map(
              (p, j) =>
                `${j ? 'L' : 'M'}${(10 + ((stroke.t0 + p.t - loT) / Math.max(1000, hiT - loT)) * 140).toFixed(1)},${(70 - ((stroke.p0 + p.p - loP) / Math.max(0.01, hiP - loP)) * 60).toFixed(1)}`,
            )
            .join(' ')}
          fill="none"
          stroke={c.brand}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={4}
        />
      ))}
    </Svg>
  )
}

export function DrawingDetail({
  id,
  onBack,
  onPlayer,
}: {
  id: string
  onBack: () => void
  onPlayer: (player: string) => void
}) {
  const social = useSocial()
  const chain = useChain()
  const [stored, setStored] = useState<PublicDrawing | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void socialRequest<{ drawing: PublicDrawing | null }>(
      `/drawing?id=${encodeURIComponent(id)}`,
      undefined,
      controller.signal,
    ).then(
      (r) => {
        if (controller.signal.aborted) return
        setStored(r.drawing)
        if (!r.drawing) setError('This drawing could not be found')
      },
      () => {
        if (!controller.signal.aborted) setError('Could not load this drawing')
      },
    )
    return () => controller.abort()
  }, [id])
  const d = social.drawings.find((item) => item.id === id) ?? stored
  const cluster = chain.hello?.cluster === 'mainnet-beta' ? '' : '?cluster=devnet'
  return (
    <>
      <Button size="md" variant="ghost" onPress={onBack}>
        ← Back
      </Button>
      {!d ? (
        error ? (
          <Text className="text-muted-foreground">{error}</Text>
        ) : (
          <Spinner />
        )
      ) : (
        <>
          <Pressable className="flex-row items-center gap-3" onPress={() => onPlayer(d.player)}>
            <PlayerAvatar profile={d.profile} />
            <View>
              <Text className="font-semibold text-foreground">{playerName(d.profile)}</Text>
              <Text className="text-[12px] text-muted-foreground">{new Date(d.at).toLocaleString()}</Text>
            </View>
          </Pressable>
          <View className="gap-3 rounded-[18px] bg-muted p-4">
            <DrawingPreview drawing={d} width="100%" height={128} />
            <Text className="text-[13px] text-muted-foreground">
              {d.complete ? 'Final net result' : 'So far · ink still in play'}
            </Text>
            <Text
              className={cn(
                'font-bold text-[38px]',
                BigInt(d.pnl) > 0n ? 'text-success-foreground' : 'text-foreground',
              )}
            >
              {socialMoney(d.pnl, true)}
            </Text>
          </View>
          <View className="flex-row flex-wrap gap-2">
            {[
              ['Staked', d.stake],
              ['Paid at settlement', d.paid],
              ['Still in play', (BigInt(d.stake) - BigInt(d.settledStake)).toString()],
              ['Earned as IOUs', d.owed],
            ].map(([label, value]) => (
              <View key={label} className="rounded-[14px] bg-muted p-3" style={{ width: '48.5%' }}>
                <Text className="text-[12px] text-muted-foreground">{label}</Text>
                <Text className="font-semibold text-foreground">{socialMoney(value)}</Text>
              </View>
            ))}
          </View>
          <ShareDrawing drawing={d.id} player={d.player} />
          <Pressable
            accessibilityRole="link"
            className="min-h-11 justify-center"
            onPress={() =>
              void Linking.openURL(`https://solscan.io/tx/${d.tx}${cluster}`).catch(() =>
                setError('Could not open the explorer'),
              )
            }
          >
            <Text className="text-[13px] text-muted-foreground">See it placed on the chain ↗</Text>
          </Pressable>
          {error ? <Text className="text-muted-foreground">{error}</Text> : null}
        </>
      )}
    </>
  )
}

export function PnlChart({ points }: { points: ProfileResponse['curve'] }) {
  const c = useColors()
  const [selected, setSelected] = useState<number | null>(null)
  const width = useRef(320)
  if (!points.length) return <Text className="text-[12px] text-muted-foreground">Finished ink builds this line.</Text>
  const values = [0, ...points.map((p) => Number(p.pnl) / 1e6)]
  const lo = Math.min(...values),
    hi = Math.max(...values),
    span = Math.max(0.01, hi - lo)
  const path = values
    .map((v, i) => `${i ? 'L' : 'M'}${4 + (i / Math.max(1, values.length - 1)) * 312},${76 - ((v - lo) / span) * 68}`)
    .join(' ')
  return (
    <View>
      <View
        accessibilityLabel="Net profit and loss over time"
        onLayout={(e) => {
          width.current = Math.max(1, e.nativeEvent.layout.width)
        }}
        onTouchEnd={(e) =>
          setSelected(
            Math.max(
              0,
              Math.min(points.length - 1, Math.round((e.nativeEvent.locationX / width.current) * (points.length - 1))),
            ),
          )
        }
      >
        <Svg width="100%" height={84} viewBox="0 0 320 84">
          <Path d={path} fill="none" stroke={c.brand} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </View>
      <Text className="text-[12px] text-muted-foreground">
        {selected !== null && points[selected]
          ? `${new Date(points[selected].at).toLocaleDateString()} · ${socialMoney(points[selected].pnl, true)}`
          : 'Net, after the stakes settled'}
      </Text>
    </View>
  )
}
