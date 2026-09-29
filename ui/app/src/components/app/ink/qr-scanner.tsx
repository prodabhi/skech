"use client";

import { useEffect, useRef, useState } from "react";
import { haptic } from "@/lib/feel";

/**
 * The camera, reading a QR code. The browser's own BarcodeDetector where it has one (Chrome on Android), jsQR,
 * loaded only now, everywhere else (Safari). The rear camera, a frame every 120 ms at most, and the camera is
 * let go the moment a code is read or the scanner closes.
 */
type Detector = { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> };

export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const done = useRef(false);
  const result = useRef(onResult);
  useEffect(() => {
    result.current = onResult;
  }, [onResult]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let alive = true;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let last = 0;
    let busy = false;
    let frame = 0;

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) return setProblem("This browser can't use the camera. Paste the address instead.");
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch (e) {
        const name = (e as DOMException).name;
        return setProblem(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Camera access is off. Allow it in your browser's settings, or paste the address instead."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "No camera found. Paste the address instead."
              : "The camera didn't start. Paste the address instead.",
        );
      }
      if (!alive || !video.current) return stream?.getTracks().forEach((t) => t.stop());
      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);

      const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
      const native = Native ? new Native({ formats: ["qr_code"] }) : null;
      const jsqr = native ? null : (await import("jsqr")).default;

      const tick = async (now: number) => {
        if (!alive || done.current) return;
        raf = requestAnimationFrame(tick);
        const v = video.current;
        if (busy || now - last < 120 || !v || v.readyState < 2 || !v.videoWidth) return;
        last = now;
        busy = true;
        try {
          let text: string | null = null;
          if (native) text = (await native.detect(v))[0]?.rawValue ?? null;
          else if (jsqr && ctx) {
            // Every other frame at full size (640px wide), the rest at half. jsQR cannot read codes drawn as separate
            // dots, which many wallets and our own deposit sheet use; at half size the dots average into modules.
            const scale = Math.min(1, (frame++ % 2 ? 320 : 640) / v.videoWidth);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            canvas.width = Math.round(v.videoWidth * scale);
            canvas.height = Math.round(v.videoHeight * scale);
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            text = jsqr(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
          }
          if (text && alive && !done.current) {
            done.current = true;
            haptic("tap");
            result.current(text);
          }
        } catch {
          /* a bad frame: try the next one */
        } finally {
          busy = false;
        }
      };
      raf = requestAnimationFrame(tick);
    };
    void start();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="relative aspect-square w-full overflow-hidden rounded-[24px] bg-black">
        {problem ? (
          <p className="absolute inset-0 flex items-center justify-center p-8 text-center text-[15px] text-white/80 leading-snug">{problem}</p>
        ) : (
          <>
            <video aria-label="Camera" className="size-full object-cover" muted playsInline ref={video} />
            {/* The frame to aim with, and a line sweeping it while it looks. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-[14%] rounded-[20px] shadow-[0_0_0_999px_rgb(0_0_0/45%)] ring-2 ring-white/90">
              <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-white/90 shadow-[0_0_12px_2px_rgb(255_255_255/60%)] motion-safe:animate-[scan-line_2.2s_ease-in-out_infinite]" />
            </div>
            <p className="absolute inset-x-0 bottom-4 text-center font-medium text-[14px] text-white">Point at a wallet&rsquo;s QR code</p>
          </>
        )}
      </div>
      <button className="flex h-12 w-full items-center justify-center rounded-full bg-foreground/[0.06] font-semibold text-[16px] transition-transform active:scale-[.98]" onClick={onClose} type="button">
        {problem ? "Back" : "Cancel"}
      </button>
    </div>
  );
}
