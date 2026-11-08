import React from "react";
import { AbsoluteFill, continueRender, delayRender, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { RadioTower } from "lucide-react";
import { C, F, loadFonts } from "./theme";
import { Approve, Detect, Investigate, Postmortem, Recover, Voice, Watching } from "./scenes";
import { H, W, ease, ramp } from "./ui";

export type Variant = "github" | "tweet";

type Step = {
  Scene: React.FC<{ dur: number }>;
  caption: string;
  sub?: string;
  dur: Record<Variant, number>;
};

const STEPS: Step[] = [
  { Scene: Watching, caption: "It watches production", sub: "Checkout errors, every 5 seconds", dur: { github: 120, tweet: 0 } },
  { Scene: Detect, caption: "When errors stay high, it declares the incident itself", sub: "and tells you out loud what it saw", dur: { github: 240, tweet: 180 } },
  { Scene: Investigate, caption: "Four agents investigate in parallel", sub: "Logs, Changes, Metrics and Comms share one findings log", dur: { github: 330, tweet: 210 } },
  { Scene: Voice, caption: "Ask any agent what it’s seeing", sub: "5 model votes must agree before the tower acts", dur: { github: 270, tweet: 210 } },
  { Scene: Approve, caption: "Risky actions wait for your approval", sub: "Rollbacks, restarts and status posts, with the evidence attached", dur: { github: 240, tweet: 180 } },
  { Scene: Recover, caption: "Then it watches the recovery", dur: { github: 180, tweet: 120 } },
  { Scene: Postmortem, caption: "And writes the postmortem for you", sub: "From the timeline, the findings and your approvals", dur: { github: 210, tweet: 120 } },
];

const XF = 12; // crossfade frames
const INTRO: Record<Variant, number> = { github: 90, tweet: 60 };
const OUTRO: Record<Variant, number> = { github: 150, tweet: 105 };

export const totalFrames = (v: Variant) => {
  const steps = STEPS.filter((s) => s.dur[v] > 0);
  return INTRO[v] + steps.reduce((a, s) => a + s.dur[v], 0) + OUTRO[v] - XF * (steps.length + 1);
};

function useFonts() {
  const [handle] = React.useState(() => delayRender("fonts"));
  React.useEffect(() => {
    loadFonts().then(() => continueRender(handle));
  }, [handle]);
}

function Stage({ children }: { children: React.ReactNode }) {
  return (
    <AbsoluteFill style={{ background: `radial-gradient(1200px 700px at 50% 35%, #1d1f26 0%, ${C.stage} 70%)`, fontFamily: F.sans, color: C.stageFg }}>
      {children}
    </AbsoluteFill>
  );
}

function Caption({ text, sub, variant, dur }: { text: string; sub?: string; variant: Variant; dur: number }) {
  const f = useCurrentFrame();
  const a = ramp(f, 6, 20) * (1 - ramp(f, dur - 14, dur - 2));
  const big = variant === "tweet";
  return (
    <div style={{ opacity: a, transform: `translateY(${(1 - ease(ramp(f, 6, 22))) * 12}px)`, textAlign: "center", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontFamily: F.heading, fontSize: big ? 60 : 50, lineHeight: 1.1, letterSpacing: -0.3, textWrap: "balance" }}>{text}</div>
      {sub && <div style={{ fontSize: big ? 28 : 25, color: C.stageMuted }}>{sub}</div>}
    </div>
  );
}

function StepScene({ step, variant }: { step: Step; variant: Variant }) {
  const f = useCurrentFrame();
  const dur = step.dur[variant];
  const tweet = variant === "tweet";
  // Window placement on the 1920×1080 stage
  const scale = tweet ? 0.93 : 0.94;
  const top = tweet ? 212 : 34;
  return (
    <Stage>
      <div style={{ position: "absolute", left: (1920 - W * scale) / 2, top, width: W * scale, height: H * scale, overflow: "hidden", borderRadius: 18 }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0" }}>
          <step.Scene dur={dur} />
        </div>
      </div>
      <div style={{ position: "absolute", left: 120, right: 120, ...(tweet ? { top: 34 } : { top: 34 + H * 0.94 + 26 }) }}>
        <Caption text={step.caption} sub={step.sub} variant={variant} dur={dur} />
      </div>
    </Stage>
  );
}

function Logo({ size }: { size: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: size * 0.28, background: C.stageFg, color: C.stage, display: "grid", placeItems: "center" }}>
      <RadioTower size={size * 0.56} />
    </span>
  );
}

function Intro({ variant }: { variant: Variant }) {
  const f = useCurrentFrame();
  const a = ease(ramp(f, 4, 26));
  return (
    <Stage>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 28, opacity: a, transform: `translateY(${(1 - a) * 16}px)` }}>
        {variant === "github" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
              <Logo size={84} />
              <span style={{ fontFamily: F.heading, fontSize: 92, letterSpacing: -1 }}>Control Tower</span>
            </div>
            <div style={{ fontSize: 34, color: C.stageMuted }}>A voice-controlled AI incident commander</div>
          </>
        ) : (
          <div style={{ fontFamily: F.heading, fontSize: 86, lineHeight: 1.08, textAlign: "center", letterSpacing: -0.8, maxWidth: 1500 }}>
            Checkout just broke.
            <br />
            <span style={{ color: C.stageMuted }}>Watch AI agents handle the incident.</span>
          </div>
        )}
      </AbsoluteFill>
    </Stage>
  );
}

function Outro({ variant }: { variant: Variant }) {
  const f = useCurrentFrame();
  const a = ease(ramp(f, 4, 26));
  return (
    <Stage>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 26, opacity: a }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <Logo size={70} />
          <span style={{ fontFamily: F.heading, fontSize: 76, letterSpacing: -0.8 }}>Control Tower</span>
        </div>
        <div style={{ fontSize: 32, color: C.stageMuted, textAlign: "center", lineHeight: 1.4 }}>
          Proactive investigation, evidence you can inspect,
          <br />
          and a human approving the change.
        </div>
        <div style={{ marginTop: 18, fontFamily: F.mono, fontSize: 30, padding: "12px 26px", borderRadius: 14, background: "rgba(255,255,255,.07)", boxShadow: "0 0 0 1px rgba(255,255,255,.12)" }}>
          github.com/naamanu/beebot
        </div>
        <div style={{ fontSize: 21, color: "#71717a", marginTop: 10 }}>Built with the Claude Agent SDK, Reson8 speech recognition and Jamie</div>
      </AbsoluteFill>
    </Stage>
  );
}

// Corner disclosure: shown on every app scene.
function Disclosure() {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const a = interpolate(f, [INTRO.github - 10, INTRO.github + 10, durationInFrames - 160, durationInFrames - 140], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", right: 22, bottom: 16, fontFamily: F.mono, fontSize: 15, color: "#71717a", opacity: a }}>
      Simulated production · recreated from a recorded run · waits shortened
    </div>
  );
}

export const Tour: React.FC<{ variant: Variant }> = ({ variant }) => {
  useFonts();
  const steps = STEPS.filter((s) => s.dur[variant] > 0);
  const t = linearTiming({ durationInFrames: XF });
  return (
    <AbsoluteFill style={{ background: C.stage }}>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={INTRO[variant]}>
          <Intro variant={variant} />
        </TransitionSeries.Sequence>
        {steps.map((s) => (
          <React.Fragment key={s.caption}>
            <TransitionSeries.Transition presentation={fade()} timing={t} />
            <TransitionSeries.Sequence durationInFrames={s.dur[variant]}>
              <StepScene step={s} variant={variant} />
            </TransitionSeries.Sequence>
          </React.Fragment>
        ))}
        <TransitionSeries.Transition presentation={fade()} timing={t} />
        <TransitionSeries.Sequence durationInFrames={OUTRO[variant]}>
          <Outro variant={variant} />
        </TransitionSeries.Sequence>
      </TransitionSeries>
      <Disclosure />
    </AbsoluteFill>
  );
};
