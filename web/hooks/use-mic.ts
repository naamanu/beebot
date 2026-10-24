import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { startMic } from "@/lib/mic.ts";
import { useTower } from "@/lib/store.ts";

// Mic control: click to toggle, or hold Space to talk.
export function useMic() {
  const [on, setOn] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  const heldBySpace = useRef(false);
  const { send, sendAudio, pushLevel, clearLevels } = useTower.getState();

  const starting = useRef(false);
  const cancelStart = useRef(false);

  const start = useCallback(async () => {
    if (stop.current || starting.current) return;
    starting.current = true;
    cancelStart.current = false;
    send({ type: "mic", on: true });
    try {
      stop.current = await startMic(sendAudio, pushLevel);
      setOn(true);
    } catch (err) {
      send({ type: "mic", on: false });
      toast.error(`Microphone unavailable: ${(err as Error).message}`);
    } finally {
      starting.current = false;
    }
    // Space was released while the mic was still starting up.
    if (cancelStart.current) end();
  }, [send, sendAudio, pushLevel]);

  const end = useCallback(() => {
    if (starting.current) {
      cancelStart.current = true;
      return;
    }
    if (!stop.current) return;
    stop.current();
    stop.current = null;
    send({ type: "mic", on: false });
    clearLevels();
    setOn(false);
  }, [send, clearLevels]);

  const toggle = useCallback(() => (stop.current ? end() : void start()), [start, end]);

  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || typing(e)) return;
      e.preventDefault();
      if (!stop.current) {
        heldBySpace.current = true;
        void start();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !heldBySpace.current) return;
      heldBySpace.current = false;
      end();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [start, end]);

  useEffect(() => end, [end]);

  return { on, toggle };
}
