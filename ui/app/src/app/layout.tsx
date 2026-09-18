import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AuthProvider } from "@/components/app/auth";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { THEME_BOOT } from "@/lib/theme-boot";
import "./globals.css";

/* The phone's own face first (SF on Apple devices); Geist everywhere else. */
const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
  display: "swap",
});

const mono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

const SITE = "https://app.skech.trade";
const TITLE = "skech";
const DESCRIPTION = "Draw ahead of the Bitcoin price. The ink it runs through pays.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: "%s · skech" },
  description: DESCRIPTION,
  applicationName: "skech",
  keywords: ["skech", "draw", "bitcoin", "game", "prediction"],
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", url: "/", siteName: "skech" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, site: "@skechtrade", creator: "@skechtrade" },
  // Added to the Home Screen it opens as "skech", full screen (src/app/manifest.ts, apple-icon.png).
  appleWebApp: { capable: true, title: "skech", statusBarStyle: "default" },
  // og:image and the icon come from src/app/opengraph-image.tsx and
  // src/app/icon.png, the landing's artwork.
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
  colorScheme: "light dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html className={`h-full ${geist.variable} ${mono.variable} antialiased`} lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: must run before paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground text-sm">
        {/*
          Bottom right, not top right: the top right is the bar's Deposit and
          account buttons, and a notification there stands in front of them
          for as long as it stays up.
        */}
        <AuthProvider>
          <ToastProvider position="bottom-right">
            <TooltipProvider delay={300}>{children}</TooltipProvider>
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
