import "../global.css";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "@/components/app/auth";
import { GateProvider } from "@/components/app/gate";
import { ChainProvider } from "@/components/app/ink/chain-context";
import { SocialProvider } from "@/components/app/social-provider";
import { initTheme } from "@/lib/theme";

initTheme();

// Which code is running: the build's own, or an update downloaded over the air. One line in the log, to tell them apart.
console.info(`[updates] ${Updates.isEmbeddedLaunch ? "the build's own code" : `update ${Updates.updateId}`}, channel ${Updates.channel ?? "none"}, runtime ${Updates.runtimeVersion ?? "none"}`);

export default function Layout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <AuthProvider>
            <ChainProvider>
              <GateProvider>
                <SocialProvider>
                  <StatusBar style="auto" />
                  <Stack screenOptions={{ headerShown: false }} />
                </SocialProvider>
              </GateProvider>
            </ChainProvider>
          </AuthProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
