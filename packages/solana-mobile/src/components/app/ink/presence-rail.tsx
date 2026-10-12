import { Pressable, Text, useWindowDimensions, View } from 'react-native'
import { playerHue, playerName } from '@skech/core/social'
import { PlayerAvatar } from '@/components/app/player-avatar'
import { focusPlayer, useFocusedPlayer, useSocial } from '@/lib/social'

/** Only the controls intercept touches; the chart stays drawable between them. */
export function PresenceRail() {
  const { playing, connected } = useSocial()
  const focused = useFocusedPlayer()
  const { width } = useWindowDimensions()
  if (!connected || !playing.length) return null
  const shown = playing.slice(0, Math.min(8, Math.max(1, Math.floor((width - 52) / 48))))
  return (
    <View className="items-center gap-1" pointerEvents="box-none">
      <Text className="text-[11px] text-muted-foreground" pointerEvents="none">
        {playing.length} drawing
      </Text>
      <View className="flex-row items-center gap-1" pointerEvents="box-none">
        {shown.map((profile) => (
          <Pressable
            accessibilityLabel={`${focused === profile.player ? 'Stop following' : 'Follow'} ${playerName(profile)}'s line`}
            accessibilityRole="button"
            accessibilityState={{ selected: focused === profile.player }}
            className="min-h-11 min-w-11 items-center justify-center"
            key={profile.player}
            onPress={() => focusPlayer(profile.player)}
            style={{ opacity: focused && focused !== profile.player ? 0.35 : 1 }}
          >
            <View
              style={{
                padding: 2,
                borderRadius: 20,
                borderWidth: 2,
                borderColor: `hsl(${playerHue(profile.player)}, 64%, 54%)`,
              }}
            >
              <PlayerAvatar profile={profile} size={28} />
            </View>
          </Pressable>
        ))}
        {playing.length > shown.length ? (
          <Text className="text-[11px] text-muted-foreground" pointerEvents="none">
            +{playing.length - shown.length}
          </Text>
        ) : null}
      </View>
      {focused ? (
        <Pressable className="min-h-11 justify-center rounded-full bg-secondary px-3" onPress={() => focusPlayer(null)}>
          <Text className="text-[12px] text-foreground">Show everyone</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
