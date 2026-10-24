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

  const connected = useTower((s) => s.connected);
  const micStatus = useTower((s) => s.micStatus);

  const end = useCallback((notify = true) => {
    const active = starting.current || !!stop.current;
    if (starting.current) cancelStart.current = true;
    stop.current?.();
    stop.current = null;
    if (active && notify) send({ type: "mic", on: false });
    clearLevels();
    setOn(false);
  }, [send, clearLevels]);

  const start = useCallback(async () => {
    if (stop.current || starting.current || !useTower.getState().connected) return;
    if (useTower.getState().draft.attachments.some((file) => file.uploading)) {
      toast.error("Wait for the file uploads to finish before speaking.");
      return;
    }
    starting.current = true;
    cancelStart.current = false;
    useTower.setState({ micStatus: "connecting", micError: null, interim: "" });
    useTower.getState().syncCommandContext();
    send({ type: "mic", on: true });
    setOn(true);
    try {
      const cleanup = await startMic(sendAudio, pushLevel);
      if (cancelStart.current || !useTower.getState().connected || useTower.getState().micStatus === "error") {
        cleanup();
        return;
      }
      stop.current = cleanup;
    } catch (err) {
      if (!cancelStart.current) {
        const error = `Microphone unavailable: ${(err as Error).message}`;
        useTower.setState({ micStatus: "error", micError: error });
        toast.error(error);
        send({ type: "mic", on: false });
      }
      setOn(false);
    } finally {
      starting.current = false;
    }
  }, [send, sendAudio, pushLevel]);

  const toggle = useCallback(() => (stop.current || starting.current ? end() : void start()), [start, end]);

  useEffect(() => {
    if (!connected || micStatus === "error" || micStatus === "stopped") end(false);
  }, [connected, micStatus, end]);

  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && !!el.closest("input, textarea, select, button, a, [contenteditable], [role='dialog'], [role='alertdialog'], [role='menu'], [role='switch']");
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
    const blur = () => {
      if (!heldBySpace.current) return;
      heldBySpace.current = false;
      end();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [start, end]);

  useEffect(() => () => end(), [end]);

  return { on, toggle };
}
