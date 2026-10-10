import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { playerName, type PlayerProfile, type SocialActivity } from '@skech/core/social'
import {
  bindPen,
  cacheProfile,
  connectSocial,
  type DrawingAudience,
  onSocialActivity,
  setDrawingAudience,
  setSocialViewer,
  socialRequest,
} from '@/lib/social'
import { storage } from '@/lib/storage'
import { useAccount } from './auth'
import { SocialSheet, type SocialTab } from './sheets/social-sheet'

/**
 * The community around the game, as on the web (social-provider.tsx): one live stream for the app, who the player
 * follows, and the sheet with the leaderboard, who is playing, and profiles. The game screen does not subscribe to
 * the stream: the stage reads it each frame (lib/social.ts), so a busy feed costs the game nothing.
 */
type Community = {
  open: (tab?: SocialTab, player?: string) => void
  audience: DrawingAudience
  changeAudience: (value: DrawingAudience) => void
  refreshFollowing: () => void
}
const Ctx = createContext<Community | null>(null)
export const useCommunity = () => useContext(Ctx)

export function SocialProvider({ children }: { children: ReactNode }) {
  const me = useAccount()
  const player = me.address
  const [panel, setPanel] = useState<{ tab: SocialTab; player?: string; drawing?: string } | null>(null)
  const [following, setFollowing] = useState<string[]>([])
  const [notice, setNotice] = useState<SocialActivity | null>(null)
  const notified = useRef(new Set<string>())
  const insets = useSafeAreaInsets()
  const [audience, setAudience] = useState<DrawingAudience>('everyone')
  const [version, refresh] = useState(0)
  const open = useCallback((tab: SocialTab = 'leaderboard', target?: string) => setPanel({ tab, player: target }), [])
  useEffect(() => connectSocial(), [])
  // Others see this player's pen as it draws. Privy signs for it without asking; a wallet on the phone would ask, so
  // its player says so in the community sheet (a day's ticket after).
  const sign = me.signMessage
  const silent = me.kind === 'privy'
  useEffect(() => bindPen(player, player && silent ? sign : null), [player, sign, silent])
  useEffect(() => {
    if (!player) {
      setFollowing([])
      setSocialViewer(null, [])
      return
    }
    const controller = new AbortController()
    setSocialViewer(player, [])
    setFollowing([])
    void socialRequest<{ profile: PlayerProfile }>(`/identity?player=${player}`, undefined, controller.signal).then(
      (r) => cacheProfile(r.profile),
      () => undefined,
    )
    void socialRequest<{ players: string[] }>(`/following?player=${player}`, undefined, controller.signal).then(
      (r) => {
        if (controller.signal.aborted) return
        setFollowing(r.players)
        setSocialViewer(player, r.players)
      },
      () => undefined,
    )
    return () => controller.abort()
  }, [player, version])
  useEffect(
    () =>
      onSocialActivity((activity) => {
        if (
          !following.includes(activity.player) ||
          activity.kind !== 'settled' ||
          !activity.complete ||
          storage.getString('skech:social:alerts') === 'off' ||
          notified.current.has(activity.drawing)
        )
          return
        notified.current.add(activity.drawing)
        if (notified.current.size > 500) notified.current.delete(notified.current.values().next().value!)
        setNotice(activity)
      }),
    [following],
  )
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])
  const value = useMemo<Community>(
    () => ({
      open,
      audience,
      changeAudience(next) {
        setAudience(next)
        setDrawingAudience(next)
      },
      refreshFollowing() {
        refresh((v) => v + 1)
      },
    }),
    [open, audience],
  )
  return (
    <Ctx.Provider value={value}>
      {children}
      {notice ? (
        <View className="absolute inset-x-4" pointerEvents="box-none" style={{ top: insets.top + 8, zIndex: 100 }}>
          <Pressable
            className="rounded-[18px] bg-secondary p-4"
            onPress={() => {
              setPanel({ tab: 'activity', drawing: notice.drawing })
              setNotice(null)
            }}
          >
            <Text className="font-semibold text-foreground">{playerName(notice.profile)} finished a drawing</Text>
            <Text className="text-[13px] text-muted-foreground">See how it went in Live.</Text>
          </Pressable>
        </View>
      ) : null}
      {panel ? (
        <SocialSheet
          key={`${panel.tab}:${panel.player ?? ''}:${panel.drawing ?? ''}`}
          initialDrawing={panel.drawing}
          initialPlayer={panel.player}
          initialTab={panel.tab}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </Ctx.Provider>
  )
}
