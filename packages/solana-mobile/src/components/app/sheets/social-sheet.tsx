import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, Pressable, Switch, Text, TextInput, View } from 'react-native'
import {
  activityRuns,
  type SocialActivity,
  type PublicDrawing,
  avatarChoices,
  BIO_MAX,
  type LeaderboardRow,
  type PlayerProfile,
  playerName,
  type ProfileResponse,
  type SocialWindow,
  usernameProblem,
} from '@skech/core/social'
import { useAccount } from '@/components/app/auth'
import { useGate } from '@/components/app/gate'
import { Dylan, PlayerAvatar } from '@/components/app/player-avatar'
import { useCommunity } from '@/components/app/social-provider'
import { Button, Sheet, Spinner, useColors } from '@/components/ui'
import { RadioIcon, ShuffleIcon, TrophyIcon, UserIcon } from '@/components/ui/icons'
import { bindPen, cacheProfile, penBound, socialAction, socialMoney, socialRequest, useSocial } from '@/lib/social'
import { cn } from '@/lib/utils'
import { DrawingDetail, DrawingPreview, PnlChart, ShareDrawing } from './social-drawing'
import { storage } from '@/lib/storage'
import { pickAvatarPhoto } from '@/lib/avatar-photo'

/**
 * The community, on the phone: the web's social sheet (ui/app/src/components/app/ink/social-sheet.tsx), the same
 * service and the same numbers. The leaderboard by window, who is playing now and the live feed, and a player's
 * page with Follow, or, for one's own, a name, a bio and a Dylan avatar.
 */
export type SocialTab = 'leaderboard' | 'activity' | 'profile'
const windows: { value: SocialWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All time' },
]
const figures = { fontVariant: ['tabular-nums' as const] }
const positive = (v: string) => BigInt(v) > 0n

function Chips<T extends string>({
  items,
  value,
  onChange,
}: {
  items: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <View className="flex-row gap-1.5">
      {items.map((item) => (
        <Pressable
          accessibilityState={{ selected: value === item.value }}
          className={cn(
            'min-h-10 flex-1 items-center justify-center rounded-full',
            value === item.value ? 'bg-secondary' : '',
          )}
          key={item.value}
          onPress={() => onChange(item.value)}
        >
          <Text
            className={cn(
              'font-medium text-[13px]',
              value === item.value ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

export function SocialSheet({
  initialTab,
  initialPlayer,
  initialDrawing,
  onClose,
}: {
  initialTab: SocialTab
  initialPlayer?: string
  initialDrawing?: string
  onClose: () => void
}) {
  const me = useAccount()
  const c = useColors()
  const viewer = me.address ?? ''
  const [drawing, setDrawing] = useState<string | null>(initialDrawing ?? null)
  const [tab, setTab] = useState<SocialTab>(initialTab)
  const [player, setPlayer] = useState<string | null>(initialPlayer ?? me.address ?? null)
  const [window, setWindow] = useState<SocialWindow>('all')
  const viewPlayer = (target: string) => {
    setDrawing(null)
    setPlayer(target)
    setTab('profile')
  }
  const tabs = [
    { value: 'leaderboard' as const, label: 'Leaderboard', Icon: TrophyIcon },
    { value: 'activity' as const, label: 'Live', Icon: RadioIcon },
    { value: 'profile' as const, label: 'Profile', Icon: UserIcon },
  ]
  return (
    <Sheet
      description="Who is drawing, and how it went."
      onClose={onClose}
      open
      title={drawing ? 'Drawing' : tab === 'profile' ? (player === viewer ? 'Your profile' : 'Player') : 'Players'}
    >
      {drawing ? (
        <DrawingDetail id={drawing} key={drawing} onBack={() => setDrawing(null)} onPlayer={viewPlayer} />
      ) : (
        <>
          <View className="flex-row rounded-full bg-muted p-1">
            {tabs.map(({ value, label, Icon }) => (
              <Pressable
                accessibilityState={{ selected: tab === value }}
                className={cn(
                  'min-h-10 flex-1 flex-row items-center justify-center gap-1.5 rounded-full',
                  tab === value ? 'bg-background' : '',
                )}
                key={value}
                onPress={() => {
                  setTab(value)
                  if (value === 'profile') setPlayer(viewer || null)
                }}
              >
                <Icon color={tab === value ? c.fg : c.muted} size={14} />
                <Text
                  className={cn(
                    'font-semibold text-[13px]',
                    tab === value ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
          {tab !== 'activity' ? <Chips items={windows} onChange={setWindow} value={window} /> : null}
          {tab === 'leaderboard' ? (
            <Board onPlayer={viewPlayer} viewer={viewer} window={window} />
          ) : tab === 'activity' ? (
            <Live onDrawing={setDrawing} onPlayer={viewPlayer} />
          ) : player ? (
            <Profile key={`${player}:${window}`} player={player} window={window} onDrawing={setDrawing} />
          ) : (
            <SignInFirst />
          )}
        </>
      )}
    </Sheet>
  )
}

function SignInFirst() {
  const gate = useGate()
  return (
    <View className="items-start gap-3 rounded-[18px] bg-muted p-4">
      <Text className="text-[15px] text-muted-foreground">
        Sign in to make your profile and keep your drawing history.
      </Text>
      <Button onPress={() => gate.openSignIn('community')} size="md">
        Sign in
      </Button>
    </View>
  )
}

function Board({ window, viewer, onPlayer }: { window: SocialWindow; viewer: string; onPlayer: (p: string) => void }) {
  const social = useSocial()
  const [friends, setFriends] = useState(false)
  const [board, setBoard] = useState<{ rows: LeaderboardRow[]; me: LeaderboardRow | null; counting: boolean } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const load = () =>
      socialRequest<NonNullable<typeof board>>(
        `/leaderboard?window=${window}${viewer ? `&viewer=${viewer}` : ''}&friends=${friends ? '1' : '0'}`,
        undefined,
        controller.signal,
      ).then(
        (r) => {
          setBoard(r)
          setError(null)
        },
        () => !controller.signal.aborted && setError('The leaderboard is unavailable right now. Try again shortly.'),
      )
    void load()
    const t = setInterval(load, 10_000)
    return () => {
      controller.abort()
      clearInterval(t)
    }
  }, [window, viewer, friends])
  return (
    <>
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-[13px] text-muted-foreground">Ranked by net PnL</Text>
        {viewer ? (
          <Pressable className="min-h-10 justify-center" onPress={() => setFriends((v) => !v)}>
            <Text className="font-medium text-[13px] text-foreground">{friends ? 'Following' : 'Everyone'}</Text>
          </Pressable>
        ) : null}
      </View>
      {board?.counting || social.counting ? (
        <Text className="text-[13px] text-muted-foreground">
          Reading earlier drawings from the chain… the board fills in as they arrive.
        </Text>
      ) : null}
      {error ? (
        <Notice text={error} />
      ) : !board ? (
        <Spinner />
      ) : !board.rows.length ? (
        <Notice text={friends ? 'Follow a player to see them here.' : 'The first drawings will start the board.'} />
      ) : (
        <View className="overflow-hidden rounded-[18px] bg-muted">
          {board.rows.map((row) => (
            <LeaderRow
              key={row.profile.player}
              me={row.profile.player === viewer}
              onPress={() => onPlayer(row.profile.player)}
              row={row}
            />
          ))}
        </View>
      )}
      {board?.me && !board.rows.some((r) => r.profile.player === viewer) ? (
        <View className="overflow-hidden rounded-[18px] bg-muted">
          <LeaderRow me onPress={() => onPlayer(viewer)} row={board.me} />
        </View>
      ) : null}
    </>
  )
}

function LeaderRow({ row, me, onPress }: { row: LeaderboardRow; me: boolean; onPress: () => void }) {
  return (
    <Pressable className={cn('flex-row items-center gap-3 px-3.5 py-3', me && 'bg-brand/5')} onPress={onPress}>
      <Text className="w-5 text-center text-[13px] text-muted-foreground" style={figures}>
        {row.rank}
      </Text>
      <PlayerAvatar profile={row.profile} size={36} />
      <View className="min-w-0 flex-1">
        <Text className="font-medium text-[15px] text-foreground" numberOfLines={1}>
          {playerName(row.profile)}
          {me ? <Text className="text-[12px] text-muted-foreground"> you</Text> : null}
        </Text>
        <Text className="text-[12px] text-muted-foreground">{row.stats.completed} finished drawings</Text>
      </View>
      <Text
        className={cn(
          'font-semibold text-[15px]',
          positive(row.stats.pnl) ? 'text-success-foreground' : 'text-foreground',
        )}
        style={figures}
      >
        {socialMoney(row.stats.pnl, true)}
      </Text>
    </Pressable>
  )
}

/** The same grouped feed as the web; presence lives on the chart. */
function Live({ onPlayer, onDrawing }: { onPlayer: (p: string) => void; onDrawing: (id: string) => void }) {
  const social = useSocial()
  const [alerts, setAlerts] = useState(() => storage.getString('skech:social:alerts') !== 'off')
  const runs = useMemo(() => activityRuns(social.activity), [social.activity])
  return (
    <>
      <ShowMyPen />
      {runs.length ? (
        <View className="gap-2">
          {runs.map((run) => (
            <LiveRow
              key={run[0].drawing}
              run={run}
              drawings={social.drawings}
              onPlayer={() => onPlayer(run[0].player)}
              onDrawing={() => onDrawing(run[0].drawing)}
            />
          ))}
        </View>
      ) : (
        <Notice text={social.connected ? 'Nobody is drawing.' : 'Reconnecting…'} />
      )}
      <View className="min-h-11 flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-[13px] text-foreground">Tell me when someone I follow finishes</Text>
        <Switch
          accessibilityLabel="Tell me when someone I follow finishes"
          value={alerts}
          onValueChange={(on) => {
            setAlerts(on)
            storage.set('skech:social:alerts', on ? 'on' : 'off')
          }}
        />
      </View>
    </>
  )
}
function LiveRow({
  run,
  drawings,
  onPlayer,
  onDrawing,
}: {
  run: SocialActivity[]
  drawings: PublicDrawing[]
  onPlayer: () => void
  onDrawing: () => void
}) {
  const head = run[0]
  const net = run.reduce((sum, item) => sum + (item.kind === 'settled' ? BigInt(item.amount) : 0n), 0n)
  const open = run.some((item) => !item.complete)
  const d = drawings.find((d) => d.id === head.drawing)
  const line = d?.pieces.some((piece) => (piece.stroke?.pts.length ?? 0) > 1) ? d : null
  const when =
    Date.now() - head.at < 86_400_000
      ? new Date(head.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : new Date(head.at).toLocaleDateString([], { month: 'short', day: 'numeric' })
  return (
    <View className="flex-row items-center gap-3 rounded-[18px] bg-muted px-3 py-2">
      <Pressable accessibilityLabel={`Open ${playerName(head.profile)}'s profile`} onPress={onPlayer}>
        <PlayerAvatar profile={head.profile} size={36} />
      </Pressable>
      <Pressable className="min-h-11 flex-1 flex-row items-center gap-2" onPress={onDrawing}>
        <View className="min-w-0 flex-1">
          <Text className="font-medium text-[14px] text-foreground" numberOfLines={1}>
            {playerName(head.profile)}
          </Text>
          <Text className="text-[12px] text-muted-foreground">
            {run.length > 1 ? `${run.length} lines` : open ? 'Still going' : 'Done'} · {when}
          </Text>
        </View>
        {line ? <DrawingPreview drawing={line} width={48} height={28} /> : null}
        <Text
          className={cn('font-semibold text-[14px]', net > 0n ? 'text-success-foreground' : 'text-foreground')}
          style={figures}
        >
          {net === 0n && open ? '' : socialMoney(net.toString(), true)}
        </Text>
      </Pressable>
    </View>
  )
}

/** A wallet on the phone asks before it signs: its player says when others may see their pen as it draws. */
function ShowMyPen() {
  const me = useAccount()
  const [asked, setAsked] = useState(false)
  if (me.kind !== 'wallet' || !me.address || penBound()) return null
  return (
    <View className="gap-2 rounded-[18px] bg-muted p-3">
      <Text className="text-[13px] text-muted-foreground">
        Let others watch your line as you draw it. Your wallet signs once a day for it.
      </Text>
      <Button
        disabled={asked}
        onPress={() => {
          setAsked(true)
          bindPen(me.address, me.signMessage)
        }}
        size="md"
        variant="secondary"
      >
        {asked ? 'Asked your wallet' : 'Show my pen live'}
      </Button>
    </View>
  )
}

function Profile({
  player,
  window,
  onDrawing,
}: {
  player: string
  window: SocialWindow
  onDrawing: (id: string) => void
}) {
  const me = useAccount()
  const gate = useGate()
  const community = useCommunity()
  const viewer = me.address ?? ''
  const own = viewer === player
  const [data, setData] = useState<ProfileResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    const controller = new AbortController()
    mounted.current = true
    void socialRequest<ProfileResponse>(
      `/profile?player=${player}${viewer ? `&viewer=${viewer}` : ''}&window=${window}`,
      undefined,
      controller.signal,
    ).then(
      (r) => !controller.signal.aborted && setData(r),
      () => !controller.signal.aborted && setError('This profile is unavailable right now. Try again shortly.'),
    )
    return () => {
      mounted.current = false
      controller.abort()
    }
  }, [player, viewer, window])
  const follow = async () => {
    if (!viewer) return gate.openSignIn('community')
    if (!data || busy) return
    setBusy(true)
    setError(null)
    try {
      await socialAction(viewer, 'follow', { target: player, enabled: !data.following }, me.signMessage)
      if (mounted.current)
        setData({
          ...data,
          following: !data.following,
          profile: { ...data.profile, followers: data.profile.followers + (data.following ? -1 : 1) },
        })
      community?.refreshFollowing()
    } catch (e) {
      if (mounted.current) setError(String((e as Error).message ?? e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const more = async () => {
    if (!data?.next || busy) return
    setBusy(true)
    try {
      const next = await socialRequest<ProfileResponse>(
        `/profile?player=${player}${viewer ? `&viewer=${viewer}` : ''}&window=${window}&cursor=${encodeURIComponent(data.next)}`,
      )
      if (mounted.current) setData({ ...data, drawings: [...data.drawings, ...next.drawings], next: next.next })
    } catch {
      if (mounted.current) setError('Could not load earlier drawings')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  if (!data) return error ? <Notice text={error} /> : <Spinner />
  if (editing)
    return (
      <EditProfile
        onCancel={() => setEditing(false)}
        onSaved={(profile) => {
          // Everywhere at once: the bar's face, the feed, the board.
          cacheProfile(profile)
          setData({ ...data, profile })
          setEditing(false)
        }}
        profile={data.profile}
      />
    )
  const s = data.stats
  return (
    <>
      <View className="flex-row items-center gap-3">
        <PlayerAvatar profile={data.profile} size={56} />
        <View className="min-w-0 flex-1">
          <Text className="font-semibold text-[18px] text-foreground" numberOfLines={1}>
            {playerName(data.profile)}
          </Text>
          <Text className="text-[12px] text-muted-foreground">
            {data.profile.followers} followers · {data.profile.following} following
          </Text>
        </View>
        {own ? (
          <Button onPress={() => setEditing(true)} size="md" variant="secondary">
            Edit
          </Button>
        ) : (
          <Button
            disabled={busy}
            onPress={() => void follow()}
            size="md"
            variant={data.following ? 'secondary' : 'primary'}
          >
            {data.following ? 'Following' : 'Follow'}
          </Button>
        )}
      </View>
      {data.profile.bio ? (
        <Text className="text-[15px] text-muted-foreground leading-[21px]">{data.profile.bio}</Text>
      ) : null}
      {error ? <Notice text={error} /> : null}
      <View className="gap-1 rounded-[18px] bg-muted px-4 py-4">
        <Text className="text-[13px] text-muted-foreground">Net PnL</Text>
        <Text
          className={cn('font-bold text-[36px]', positive(s.pnl) ? 'text-success-foreground' : 'text-foreground')}
          style={figures}
        >
          {socialMoney(s.pnl, true)}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Stat label="Total staked" value={socialMoney(s.staked)} />
        <Stat label="Win rate" value={s.completed ? `${Math.round((s.wins / s.completed) * 100)}%` : '–'} />
        <Stat label="Finished drawings" value={String(s.completed)} />
        <Stat label="Biggest profit" value={socialMoney(s.biggest, true)} />
      </View>
      <PnlChart points={data.curve} />
      {data.badges.length ? (
        <View className="flex-row flex-wrap gap-2">
          {data.badges.map((badge) => (
            <Text key={badge} className="rounded-full bg-secondary px-3 py-2 text-[12px] text-foreground">
              {badge}
            </Text>
          ))}
        </View>
      ) : null}
      <ShareDrawing player={player} />
      <Text className="px-1 text-[13px] text-muted-foreground">Drawings</Text>
      {data.drawings.length ? (
        <View className="overflow-hidden rounded-[18px] bg-muted">
          {data.drawings.map((d) => (
            <Pressable className="flex-row items-center gap-3 px-3.5 py-3" key={d.id} onPress={() => onDrawing(d.id)}>
              <View className="flex-1">
                <Text className="font-medium text-[15px] text-foreground">
                  {d.complete ? (positive(d.pnl) ? 'Won' : 'Finished') : 'In play'}
                </Text>
                <Text className="text-[12px] text-muted-foreground">
                  {new Date(d.at).toLocaleDateString([], { month: 'short', day: 'numeric' })} · {socialMoney(d.stake)}{' '}
                  staked
                </Text>
              </View>
              <Text
                className={cn(
                  'font-semibold text-[15px]',
                  positive(d.pnl) ? 'text-success-foreground' : 'text-foreground',
                )}
                style={figures}
              >
                {d.complete ? socialMoney(d.pnl, true) : 'Pending'}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Notice text={own ? 'Your first drawing will start the story.' : 'No drawings in this period.'} />
      )}
      {data.next ? (
        <Button disabled={busy} size="md" variant="ghost" onPress={() => void more()}>
          {busy ? 'Loading…' : 'Earlier drawings'}
        </Button>
      ) : null}
    </>
  )
}

/** A name, a bio, and a Dylan avatar from a grid of them (shuffle for more): signed by the wallet, no prompt with Privy. */
function EditProfile({
  profile,
  onCancel,
  onSaved,
}: {
  profile: PlayerProfile
  onCancel: () => void
  onSaved: (p: PlayerProfile) => void
}) {
  const me = useAccount()
  const c = useColors()
  const [username, setUsername] = useState(profile.username ?? '')
  const [bio, setBio] = useState(profile.bio)
  const [seed, setSeed] = useState<string | null>(profile.avatarSeed)
  const [image, setImage] = useState<string | null | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [page, setPage] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const choices = useMemo(() => avatarChoices(profile.player, page * 8 + 1), [profile.player, page])
  const save = async () => {
    if (!me.address || busy) return
    const problem = usernameProblem(username)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      // A chosen Dylan avatar is the face from now on: an uploaded picture (from the web) is let go.
      const result = await socialAction<{ profile: PlayerProfile }>(
        me.address,
        'profile',
        { username, bio, avatarSeed: seed, ...(image !== undefined ? { image } : {}) },
        me.signMessage,
      )
      onSaved(result.profile)
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }
  const field = { color: c.fg, fontSize: 16, paddingHorizontal: 16, borderRadius: 18 }
  return (
    <>
      <Pressable className="min-h-10 justify-center self-start" onPress={onCancel}>
        <Text className="font-medium text-[15px] text-foreground">← Back to profile</Text>
      </Pressable>
      <View className="flex-row flex-wrap justify-between gap-y-2">
        {choices.map((choice) => {
          const value = choice === profile.player ? null : choice
          const on = value === seed
          return (
            <Pressable
              accessibilityLabel={value ? `Avatar ${choice.split(':')[1]}` : "Your address's avatar"}
              accessibilityState={{ selected: on && image === null }}
              className={cn(
                'items-center justify-center rounded-[18px] bg-muted p-2',
                on && (image === null || (!profile.avatar && image === undefined)) && 'border-2 border-brand',
              )}
              key={choice}
              onPress={() => {
                setSeed(value)
                setImage(null)
              }}
              style={{ width: '31.5%', aspectRatio: 1 }}
            >
              <Dylan seed={choice} size={72} />
            </Pressable>
          )
        })}
      </View>
      <View className="flex-row items-center justify-between gap-3">
        <Button
          disabled={picking || busy}
          size="md"
          variant="secondary"
          onPress={() => {
            setPicking(true)
            void pickAvatarPhoto()
              .then(
                (photo) => {
                  if (photo) {
                    setImage(photo)
                    setError(null)
                  }
                },
                (e) => setError(String((e as Error).message ?? e)),
              )
              .finally(() => setPicking(false))
          }}
        >
          {picking ? 'Preparing…' : 'Upload photo'}
        </Button>
        <Button onPress={() => setPage(1 + Math.floor(Math.random() * 100_000))} size="md" variant="secondary">
          <View className="flex-row items-center gap-1.5">
            <ShuffleIcon color={c.fg} size={16} />
            <Text className="font-semibold text-[15px] text-foreground">Shuffle</Text>
          </View>
        </Button>
      </View>
      {image ? (
        <Image source={{ uri: image }} style={{ width: 72, height: 72, borderRadius: 36 }} />
      ) : image === undefined && profile.avatar ? (
        <PlayerAvatar profile={profile} size={72} />
      ) : null}
      <View className="gap-2">
        <Text className="text-[13px] text-foreground">Username</Text>
        <TextInput
          autoCapitalize="none"
          autoComplete="username"
          autoCorrect={false}
          className="h-12 bg-muted"
          maxLength={24}
          onChangeText={(t) => setUsername(t.toLowerCase())}
          placeholder="your_name"
          placeholderTextColor={c.faint}
          selectionColor={c.brand}
          style={field}
          value={username}
        />
      </View>
      <View className="gap-2">
        <Text className="text-[13px] text-foreground">Bio</Text>
        <TextInput
          className="min-h-24 bg-muted"
          maxLength={BIO_MAX}
          multiline
          onChangeText={setBio}
          placeholder="A little about you"
          placeholderTextColor={c.faint}
          selectionColor={c.brand}
          style={[field, { paddingVertical: 12, textAlignVertical: 'top' }]}
          value={bio}
        />
        <Text className="self-end text-[12px] text-muted-foreground">
          {[...bio].length}/{BIO_MAX}
        </Text>
      </View>
      {error ? <Notice text={error} /> : null}
      <Button disabled={busy || picking} onPress={() => void save()}>
        {busy ? 'Saving…' : 'Save profile'}
      </Button>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="rounded-[14px] bg-muted px-3.5 py-3" style={{ width: '48.5%' }}>
      <Text className="text-[12px] text-muted-foreground">{label}</Text>
      <Text className="font-semibold text-[17px] text-foreground" style={figures}>
        {value}
      </Text>
    </View>
  )
}
function Notice({ text }: { text: string }) {
  return (
    <View className="rounded-[14px] bg-muted px-4 py-3">
      <Text className="text-[13px] text-muted-foreground leading-[19px]">{text}</Text>
    </View>
  )
}
