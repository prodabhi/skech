import { Image } from "expo-image";
import { XIcon } from "@/components/ui/icons";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Modal, Pressable, type PressableProps, ScrollView, Switch as RNSwitch, Text, useWindowDimensions, View, type ViewStyle } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { G, Path } from "react-native-svg";
import { useDark } from "@/lib/theme";
import { cn } from "@/lib/utils";

/*
  The few pieces every screen is built from, in the web's shapes (coss/ui, ui/app/src/components/ui): a pill
  button, an icon button, a spinner, a switch, a sheet and a menu. Each is the phone's own control underneath:
  the sheet is iOS's page sheet, the switch the system switch.
*/

/** The colours a native control takes directly, where a className cannot reach. */
export function useColors() {
  const dark = useDark();
  return dark
    ? { fg: "#ffffff", bg: "#000000", muted: "#98989f", faint: "#636366", brand: "#6f92ff", success: "#30d158", raised: "#1c1c1e", border: "#38383a", secondary: "#1c1c1e", gold: "#ff9f0a" }
    : { fg: "#000000", bg: "#ffffff", muted: "#6c6c70", faint: "#aeaeb2", brand: "#2e5bff", success: "#34c759", raised: "#ffffff", border: "#e5e5ea", secondary: "#f2f2f7", gold: "#ff9500" };
}

/** What floats over the chart: the web's `--raised-shadow`, as a native shadow. */
export const raised: ViewStyle = { shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 15, shadowOffset: { width: 0, height: 8 }, elevation: 6 };

type ButtonProps = PressableProps & { variant?: "primary" | "secondary" | "ghost" | "raised"; size?: "lg" | "md" | "icon"; className?: string; textClassName?: string; children: ReactNode };

/** A pill: black on white (white on black in the dark), or the quiet grey one. Shrinks a little under the thumb. */
export function Button({ variant = "primary", size = "lg", className, textClassName, children, disabled, ...rest }: ButtonProps) {
  const base = size === "icon" ? "size-11 items-center justify-center rounded-full" : cn("flex-row items-center justify-center gap-2 rounded-full px-[18px]", size === "lg" ? "h-12" : "h-11");
  const look = { primary: "bg-primary", secondary: "bg-secondary", ghost: "bg-transparent", raised: "bg-raised" }[variant];
  const ink = { primary: "text-primary-foreground", secondary: "text-foreground", ghost: "text-foreground", raised: "text-foreground" }[variant];
  return (
    <Pressable accessibilityRole="button" disabled={disabled} {...rest} className={cn(base, look, disabled && "opacity-50", className)} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.97 : 1 }] })}>
      {typeof children === "string" ? <Text className={cn("font-semibold text-base", ink, textClassName)}>{children}</Text> : children}
    </Pressable>
  );
}

export function Spinner({ className, color }: { className?: string; color?: string }) {
  const c = useColors();
  return <ActivityIndicator className={className} color={color ?? c.muted} size="small" />;
}

export function Switch({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  const c = useColors();
  return <RNSwitch ios_backgroundColor={c.border} onValueChange={onChange} thumbColor="#ffffff" trackColor={{ false: c.border, true: c.success }} value={checked} />;
}

/**
 * A sheet up from the bottom, as the web's sheets are on a phone: a card the height of what is in it (up to most of
 * the screen, then it scrolls), over the dimmed game, a title and a plain close cross at the top. A tap on the
 * dimmed part closes it.
 */
export function Sheet({ open, onClose, title, description, children, scroll = true, action }: { open: boolean; onClose: () => void; title?: string; description?: string; children: ReactNode; scroll?: boolean; action?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { height } = useWindowDimensions();
  const [shown, setShown] = useState(open);
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (open) {
      setShown(true);
      Animated.spring(a, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 0 }).start();
    } else Animated.timing(a, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setShown(false));
  }, [open, a]);
  const Body = scroll ? ScrollView : View;
  return (
    <Modal animationType="none" onRequestClose={onClose} statusBarTranslucent transparent visible={shown}>
      {/* keyboard-controller's, not React Native's: inside a Modal drawn edge to edge, Android does not resize the window for the
          keyboard and React Native's own reads it wrong, so the field went behind it. This one follows the Modal's own window. */}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: "flex-end" }}>
        <Animated.View className="absolute inset-0 bg-black/30" style={{ opacity: a }}>
          <Pressable accessibilityLabel="Close" className="flex-1" onPress={onClose} />
        </Animated.View>
        {/* A share of the room above the keyboard, not of the screen, so a tall sheet shrinks and scrolls rather than run under the status bar. */}
        <Animated.View
          className="rounded-t-[24px] bg-popover"
          style={{ maxHeight: "92%", paddingBottom: Math.max(insets.bottom, 16), transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }] }}
        >
          <View className="flex-row items-start gap-3 px-4 pt-6 pb-3.5">
            <View className="flex-1 justify-center" style={{ minHeight: 32 }}>
              {title ? <Text className="font-bold text-foreground text-xl">{title}</Text> : null}
            </View>
            {action}
            <Pressable accessibilityLabel="Close" className="-mr-1 size-8 items-center justify-center" hitSlop={10} onPress={onClose}>
              <XIcon color={c.fg} size={20} strokeWidth={2} />
            </Pressable>
          </View>
          {description ? <Text className="-mt-2 px-4 pb-3.5 text-[15px] text-muted-foreground leading-[21px]">{description}</Text> : null}
          <Body className={scroll ? undefined : "flex-1"} contentContainerStyle={scroll ? { paddingHorizontal: 16, paddingBottom: 24, gap: 14 } : undefined} keyboardShouldPersistTaps="handled">
            {children}
          </Body>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * A small card anchored near where it was opened from: the web's popovers and menus. Taps outside close it.
 * `anchor` is a corner of the screen, in points: the card grows from there.
 */
export function Popover({ open, onClose, anchor, width = 288, children }: { open: boolean; onClose: () => void; anchor: { top?: number; bottom?: number; left?: number; right?: number }; width?: number; children: ReactNode }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (open) Animated.spring(a, { toValue: 1, useNativeDriver: true, speed: 28, bounciness: 6 }).start();
    else a.setValue(0);
  }, [open, a]);
  return (
    <Modal animationType="none" onRequestClose={onClose} transparent visible={open}>
      <Pressable className="flex-1" onPress={onClose}>
        <Animated.View
          className="rounded-[18px] border-[0.5px] border-border bg-popover p-1.5"
          style={[raised, { position: "absolute", width, ...anchor, opacity: a, transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] }]}
        >
          <Pressable>{children}</Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

/** A row in a menu or a grouped list: an icon, words, and what it leads to. */
export function Row({ icon, children, trailing, onPress, destructive, disabled, className }: { icon?: ReactNode; children: ReactNode; trailing?: ReactNode; onPress?: () => void; destructive?: boolean; disabled?: boolean; className?: string }) {
  return (
    <Pressable className={cn("min-h-11 flex-row items-center gap-3 rounded-xl px-2.5", disabled && "opacity-40", className)} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ backgroundColor: pressed ? "rgba(127,127,127,0.12)" : "transparent" })}>
      {icon}
      <Text className={cn("flex-1 text-[16px]", destructive ? "text-destructive-foreground" : "text-foreground")}>{children}</Text>
      {typeof trailing === "string" ? <Text className="text-[15px] text-muted-foreground">{trailing}</Text> : trailing}
    </Pressable>
  );
}

/** The mark: a flat shape, tinted the text colour. */
export function LogoMark({ size = 24 }: { size?: number }) {
  const c = useColors();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return <Image contentFit="contain" source={require("../../../assets/logo-mark-alpha.webp")} style={{ width: size * 1.25, height: size }} tintColor={c.fg} />;
}

/** "skech", one t. Never "sketch". */
export function Wordmark() {
  return (
    <View className="flex-row items-center gap-2">
      <LogoMark />
      <Text className="font-bold text-foreground text-xl" style={{ letterSpacing: -0.6 }}>
        skech
      </Text>
    </View>
  );
}

export function BitcoinMark({ size = 36 }: { size?: number }) {
  return (
    <Svg height={size} viewBox="0 0 64 64" width={size}>
      <G transform="translate(0.00630876,-0.00301984)">
        <Path d="m63.033,39.744c-4.274,17.143-21.637,27.576-38.782,23.301-17.138-4.274-27.571-21.638-23.295-38.78,4.272-17.145,21.635-27.579,38.775-23.305,17.144,4.274,27.576,21.64,23.302,38.784z" fill="#f7931a" />
        <Path
          d="m46.103,27.444c0.637-4.258-2.605-6.547-7.038-8.074l1.438-5.768-3.511-0.875-1.4,5.616c-0.923-0.23-1.871-0.447-2.813-0.662l1.41-5.653-3.509-0.875-1.439,5.766c-0.764-0.174-1.514-0.346-2.242-0.527l0.004-0.018-4.842-1.209-0.934,3.75s2.605,0.597,2.55,0.634c1.422,0.355,1.679,1.296,1.636,2.042l-1.638,6.571c0.098,0.025,0.225,0.061,0.365,0.117-0.117-0.029-0.242-0.061-0.371-0.092l-2.296,9.205c-0.174,0.432-0.615,1.08-1.609,0.834,0.035,0.051-2.552-0.637-2.552-0.637l-1.743,4.019,4.569,1.139c0.85,0.213,1.683,0.436,2.503,0.646l-1.453,5.834,3.507,0.875,1.439-5.772c0.958,0.26,1.888,0.5,2.798,0.726l-1.434,5.745,3.511,0.875,1.453-5.823c5.987,1.133,10.489,0.676,12.384-4.739,1.527-4.36-0.076-6.875-3.226-8.515,2.294-0.529,4.022-2.038,4.483-5.155zm-8.022,11.249c-1.085,4.36-8.426,2.003-10.806,1.412l1.928-7.729c2.38,0.594,10.012,1.77,8.878,6.317zm1.086-11.312c-0.99,3.966-7.1,1.951-9.082,1.457l1.748-7.01c1.982,0.494,8.365,1.416,7.334,5.553z"
          fill="#fff"
        />
      </G>
    </Svg>
  );
}

/** Two hues from the address, so each wallet has a face of its own that stays the same everywhere. */
export function swatch(address: string): [string, string] {
  let n = 0;
  for (let i = 0; i < 8 && i < address.length; i++) n = (n * 31 + address.charCodeAt(i)) >>> 0;
  const a = n % 360;
  const b = (a + 40 + ((n >> 9) % 80)) % 360;
  return [`hsl(${a}, 62%, 62%)`, `hsl(${b}, 58%, 46%)`];
}
