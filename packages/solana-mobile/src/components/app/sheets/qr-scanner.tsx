import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Linking, Text, View } from "react-native";
import { Button, Spinner } from "@/components/ui";
import { haptic } from "@/lib/feel";

/**
 * The camera, reading a QR code, as on the web (ui/app/src/components/app/ink/qr-scanner.tsx), with the phone's
 * own scanner. The rear camera; it is asked for once, and let go the moment a code is read or the scanner closes.
 */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const [permission, request] = useCameraPermissions();
  const asking = useRef(false);
  const [answered, setAnswered] = useState(false);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    if (!permission || permission.granted || !permission.canAskAgain || asking.current) return;
    asking.current = true;
    void request().finally(() => setAnswered(true));
  }, [permission, request]);

  const denied = permission !== null && !permission.granted && (!permission.canAskAgain || answered);
  const problem = failed ? "The camera didn't start. Paste the address instead." : denied ? "Camera access is off. Allow it in Settings, or paste the address instead." : null;
  const live = !problem && permission?.granted === true;

  const scanned = ({ data }: BarcodeScanningResult) => {
    if (done.current || !data) return;
    done.current = true;
    haptic("tap");
    onResult(data);
  };

  // A line sweeping the frame while it looks.
  const sweep = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!live) return;
    const a = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(sweep, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    a.start();
    return () => a.stop();
  }, [live, sweep]);

  const inset = Math.round(size * 0.14);
  const frame = size - inset * 2;

  return (
    <View className="gap-4">
      <View className="w-full overflow-hidden rounded-[24px] bg-black" onLayout={(e) => setSize(e.nativeEvent.layout.width)} style={{ aspectRatio: 1 }}>
        {problem ? (
          <View className="flex-1 items-center justify-center gap-4 p-8">
            <Text className="text-center text-[15px] text-white/80 leading-[21px]">{problem}</Text>
            {denied ? (
              <Button className="bg-white/15" onPress={() => void Linking.openSettings().catch(() => undefined)} size="md" textClassName="text-white" variant="secondary">
                Open Settings
              </Button>
            ) : null}
          </View>
        ) : live ? (
          <>
            <CameraView
              accessibilityLabel="Camera"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              facing="back"
              onBarcodeScanned={scanned}
              onMountError={() => setFailed(true)}
              style={{ flex: 1 }}
            />
            {size > 0 ? (
              <>
                {/* The frame to aim with: the rest of the picture dimmed around it. */}
                <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, width: size, height: size, borderWidth: inset, borderColor: "rgba(0,0,0,0.45)" }} />
                <View pointerEvents="none" style={{ position: "absolute", top: inset, left: inset, width: frame, height: frame, borderRadius: 20, borderWidth: 2, borderColor: "rgba(255,255,255,0.9)" }}>
                  <Animated.View
                    style={{
                      position: "absolute",
                      left: 12,
                      right: 12,
                      top: 0,
                      height: 2,
                      borderRadius: 1,
                      backgroundColor: "rgba(255,255,255,0.9)",
                      shadowColor: "#fff",
                      shadowOpacity: 0.6,
                      shadowRadius: 8,
                      shadowOffset: { width: 0, height: 0 },
                      transform: [{ translateY: sweep.interpolate({ inputRange: [0, 1], outputRange: [2, Math.max(2, frame - 8)] }) }],
                    }}
                  />
                </View>
              </>
            ) : null}
            <Text className="absolute inset-x-0 bottom-4 text-center font-medium text-[14px] text-white">Point at a wallet’s QR code</Text>
          </>
        ) : (
          <View className="flex-1 items-center justify-center">
            <Spinner color="#ffffff" />
          </View>
        )}
      </View>
      <Button className="h-12" onPress={onClose} textClassName="text-[16px]" variant="secondary">
        {problem ? "Back" : "Cancel"}
      </Button>
    </View>
  );
}
