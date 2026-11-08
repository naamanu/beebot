import React from "react";
import { interpolate } from "remotion";
import { CheckCircle2, Eye, Hand, Mic, RadioTower, Siren, ThumbsDown, ThumbsUp, Undo2 } from "lucide-react";
import { C, F } from "./theme";
import type { Role } from "./data";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const ramp = (p: number, a: number, b: number) => interpolate(p, [a, b], [0, 1], clamp);
export const ease = (x: number) => 1 - Math.pow(1 - x, 3);
export const typed = (text: string, p: number) => text.slice(0, Math.round(text.length * Math.min(1, Math.max(0, p))));

export const W = 1600;
export const H = 880;

export const ROLE_COLOR: Record<Role, string> = { Logs: C.chat, Changes: C.workflow, Metrics: C.retrieval, Comms: C.http };

export function Dot({ color, pulse = 0, size = 8 }: { color: string; pulse?: number; size?: number }) {
  return <span style={{ display: "inline-block", width: size, height: size, borderRadius: 99, background: color, opacity: 0.55 + 0.45 * Math.abs(Math.cos(pulse)) }} />;
}

export function Sparkline({ points, bad }: { points: number[]; bad: boolean }) {
  const max = Math.max(10, ...points);
  const d = points.map((v, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * 48).toFixed(1)},${(16 - (v / max) * 14).toFixed(1)}`).join(" ");
  return (
    <svg width={48} height={16} style={{ overflow: "visible" }}>
      <path d={d} fill="none" strokeWidth={1.6} stroke={bad ? C.error : C.tool} />
    </svg>
  );
}

export function TopBar({ series, needsYou = 0 }: { series: number[]; needsYou?: number }) {
  const rate = series.at(-1) ?? 0;
  const bad = rate >= 5;
  return (
    <header style={{ height: 60, display: "flex", alignItems: "center", gap: 12, padding: "0 24px", borderBottom: `1px solid ${C.border}`, background: C.bg }}>
      <span style={{ width: 32, height: 32, borderRadius: 9, background: C.fg, color: "white", display: "grid", placeItems: "center" }}>
        <RadioTower size={18} />
      </span>
      <span style={{ fontFamily: F.heading, fontSize: 21, letterSpacing: -0.2 }}>Control Tower</span>
      <span style={{ marginLeft: "auto" }} />
      <span
        style={{
          display: "inline-flex", alignItems: "center", gap: 8, height: 32, padding: "0 12px", borderRadius: 99, fontFamily: F.mono, fontSize: 13,
          border: `1px solid ${bad ? "oklch(0.58 0.21 25 / 50%)" : C.border}`, background: bad ? "oklch(0.58 0.21 25 / 10%)" : "transparent", color: bad ? C.error : C.fg,
        }}
      >
        <Eye size={15} /> watching · checkout {rate.toFixed(1)}% <Sparkline points={series.slice(-16)} bad={bad} />
      </span>
      {needsYou > 0 && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px", borderRadius: 99, background: C.http, color: "white", fontSize: 13.5, fontWeight: 500 }}>
          <Hand size={15} /> {needsYou} needs you
        </span>
      )}
    </header>
  );
}

// Error-rate line chart with the tower's 5% threshold. `reveal` draws the last point partway.
export function ErrorChart({ series, width, height, reveal = 1, stroke = 2.5 }: { series: number[]; width: number; height: number; reveal?: number; stroke?: number }) {
  const n = series.length;
  const shown = Math.max(2, 1 + (n - 1) * reveal);
  const max = Math.max(10, ...series);
  const x = (i: number) => (i / (n - 1)) * width;
  const y = (v: number) => height - 6 - (v / max) * (height - 16);
  const pts: [number, number][] = [];
  for (let i = 0; i < Math.floor(shown); i++) pts.push([x(i), y(series[i]!)]);
  const frac = shown - Math.floor(shown);
  if (frac > 0 && Math.floor(shown) < n) {
    const i = Math.floor(shown);
    const v = series[i - 1]! + (series[i]! - series[i - 1]!) * frac;
    pts.push([x(i - 1 + frac), y(v)]);
  }
  const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const last = pts.at(-1)!;
  const lastV = max * ((height - 6 - last[1]) / (height - 16));
  const color = lastV >= 5 ? C.error : C.tool;
  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <line x1={0} x2={width} y1={y(5)} y2={y(5)} stroke="oklch(0.21 0.006 285.9 / 25%)" strokeDasharray="5 5" />
      <text x={width} y={y(5) - 8} textAnchor="end" fontFamily={F.mono} fontSize={13} fill={C.muted}>acts above 5%</text>
      <defs>
        <clipPath id={`above-${width}`}><rect x={-10} y={-20} width={width + 20} height={y(5) + 20} /></clipPath>
      </defs>
      <path d={d} fill="none" stroke={C.tool} strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round" />
      <path d={d} fill="none" stroke={C.error} strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#above-${width})`} />
      <circle cx={last[0]} cy={last[1]} r={5} fill={color} />
    </svg>
  );
}

export function HealthCard({ series, reveal = 1 }: { series: number[]; reveal?: number }) {
  const n = series.length;
  const idx = Math.min(n - 1, Math.max(0, Math.floor((n - 1) * reveal)));
  const rate = series[idx]!;
  const bad = rate >= 5;
  return (
    <section
      style={{
        width: 1000, borderRadius: 22, padding: 40, display: "flex", flexDirection: "column", gap: 30,
        background: bad ? "oklch(0.58 0.21 25 / 5%)" : C.bg, boxShadow: `0 0 0 1.5px ${bad ? "oklch(0.58 0.21 25 / 40%)" : C.ring}`,
      }}
    >
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        <span style={{ width: 60, height: 60, borderRadius: 15, display: "grid", placeItems: "center", background: bad ? C.error : "oklch(0.6 0.16 140 / 15%)", color: bad ? "white" : C.tool }}>
          {bad ? <Siren size={30} /> : <CheckCircle2 size={30} />}
        </span>
        <div>
          <div style={{ fontFamily: F.heading, fontSize: 40, lineHeight: 1.1 }}>{bad ? "Something’s wrong" : "All good"}</div>
          <div style={{ marginTop: 6, fontSize: 19, color: C.muted }}>
            {bad ? "Checkout errors are above normal. The tower is on it." : "Watching checkout on Shopfront every 5 seconds. The tower will speak up if something breaks."}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 36 }}>
        <div>
          <div style={{ fontFamily: F.heading, fontSize: 64, lineHeight: 1 }}>{rate.toFixed(1)}%</div>
          <div style={{ marginTop: 8, fontSize: 16, color: C.muted }}>checkout errors now</div>
        </div>
        <ErrorChart series={series} width={700} height={140} reveal={reveal} />
      </div>
    </section>
  );
}

const TONES = {
  bad: { bg: "oklch(0.58 0.21 25 / 10%)", fg: C.error },
  waiting: { bg: "oklch(0.64 0.17 52 / 15%)", fg: C.http },
  recovering: { bg: "oklch(0.56 0.18 258 / 10%)", fg: C.workflow },
  good: { bg: "oklch(0.6 0.16 140 / 10%)", fg: C.tool },
};
export type Tone = keyof typeof TONES;

export function StatusPill({ tone, label, frame }: { tone: Tone; label: string; frame: number }) {
  const t = TONES[tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 34, padding: "0 15px", borderRadius: 99, background: t.bg, color: t.fg, fontSize: 15.5, fontWeight: 500, boxShadow: `0 0 0 1px ${t.fg}55` }}>
      <Dot color={t.fg} pulse={tone === "good" ? 0 : frame / 9} /> {label}
    </span>
  );
}

export function IncidentHeader({ tone, label, frame, tab = "live", resolve }: { tone: Tone; label: string; frame: number; tab?: string; resolve?: React.ReactNode }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 24px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: F.heading, fontSize: 27, lineHeight: 1.15 }}>Checkout errors at 10% after deploy #482</div>
          <div style={{ fontFamily: F.mono, fontSize: 14, color: C.muted, marginTop: 2 }}>Noticed by the tower · SEV1 · payments-api deploy by sam</div>
        </div>
        <StatusPill tone={tone} label={label} frame={frame} />
        {resolve}
      </div>
      <div style={{ display: "flex", gap: 4, padding: "0 24px", borderBottom: `1px solid ${C.border}` }}>
        {["live", "timeline", "postmortem"].map((t) => (
          <span key={t} style={{ padding: "12px 14px", fontSize: 16, textTransform: "capitalize", marginBottom: -1, borderBottom: `2px solid ${t === tab ? C.fg : "transparent"}`, color: t === tab ? C.fg : C.muted, fontWeight: t === tab ? 500 : 400 }}>
            {t}
          </span>
        ))}
      </div>
    </>
  );
}

export function AgentCard({ role, job, status, frame }: { role: Role; job: string; status: "working" | "done" | "waiting"; frame: number }) {
  const color = ROLE_COLOR[role];
  const s = status === "working" ? { label: "investigating", c: C.retrieval } : status === "waiting" ? { label: "needs you", c: C.http } : { label: "done", c: C.tool };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderRadius: 14, background: C.card, boxShadow: `0 0 0 1px ${status === "waiting" ? C.http : C.ring}` }}>
      <span style={{ width: 38, height: 38, borderRadius: 10, background: `color-mix(in oklch, ${color} 14%, white)`, color, display: "grid", placeItems: "center", fontWeight: 650, fontSize: 16 }}>{role[0]}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 600 }}>{role}</div>
        <div style={{ fontSize: 14, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{job}</div>
      </div>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: F.mono, fontSize: 13, color: s.c }}>
        <Dot color={s.c} pulse={status === "done" ? 0 : frame / 8} /> {s.label}
      </span>
    </div>
  );
}

export function FindingRow({ n, role, time, text, appear }: { n: number; role: Role; time: string; text: string; appear: number }) {
  const color = ROLE_COLOR[role];
  return (
    <div style={{ display: "flex", gap: 14, padding: "14px 0", borderBottom: `1px solid ${C.border}`, opacity: appear, transform: `translateY(${(1 - ease(appear)) * 14}px)` }}>
      <span style={{ fontFamily: F.mono, fontSize: 13, color: C.muted, width: 22, paddingTop: 3 }}>{n}</span>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", fontFamily: F.mono, fontSize: 13, color: C.muted }}>
          <span style={{ color, fontWeight: 600 }}>{role}</span> · {time}
        </div>
        <div style={{ fontSize: 17, lineHeight: 1.45, marginTop: 3 }}>{text}</div>
      </div>
    </div>
  );
}

export function CommandBar({ text, listening, frame }: { text: string; listening: boolean; frame: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, height: 64, padding: "0 18px", borderRadius: 16, background: C.card, boxShadow: `0 0 0 1.5px ${listening ? C.error : C.ring}, 0 10px 30px oklch(0 0 0 / 8%)` }}>
      <span style={{ width: 40, height: 40, borderRadius: 99, display: "grid", placeItems: "center", background: listening ? C.error : C.secondary, color: listening ? "white" : C.muted, boxShadow: listening ? `0 0 0 ${4 + 4 * Math.abs(Math.sin(frame / 6))}px oklch(0.58 0.21 25 / 20%)` : "none" }}>
        <Mic size={20} />
      </span>
      <span style={{ fontSize: 21, color: text ? C.fg : C.muted, flex: 1 }}>
        {text || "Hold Space to talk, or type a command"}
        {listening && <span style={{ opacity: frame % 20 < 10 ? 1 : 0 }}>▍</span>}
      </span>
      {listening && <span style={{ fontFamily: F.mono, fontSize: 13, color: C.error }}>listening · Reson8</span>}
    </div>
  );
}

export function Bubble({ text, label = "Tower", width = 760 }: { text: string; label?: string; width?: number }) {
  return (
    <div style={{ width, padding: "18px 22px", borderRadius: 18, background: C.fg, color: "white", boxShadow: "0 18px 50px oklch(0 0 0 / 25%)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: F.mono, fontSize: 13, color: "#a1a1aa", marginBottom: 8 }}>
        <RadioTower size={14} /> {label} · speaking
      </div>
      <div style={{ fontSize: 22, lineHeight: 1.45 }}>{text}</div>
    </div>
  );
}

export function ApprovalCard({ summary, by, why, cites, approved, pressed }: { summary: string; by: string; why: string; cites: number[]; approved: boolean; pressed: boolean }) {
  return (
    <div style={{ padding: 22, borderRadius: 16, background: approved ? "oklch(0.6 0.16 140 / 6%)" : "oklch(0.64 0.17 52 / 7%)", boxShadow: `0 0 0 1.5px ${approved ? C.tool : C.http}`, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: F.mono, fontSize: 13, color: approved ? C.tool : C.http }}>
        {approved ? <CheckCircle2 size={15} /> : <Hand size={15} />} {approved ? "Approved by you" : `${by} asks for approval`}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: F.heading, fontSize: 28 }}>
        <Undo2 size={24} /> {summary}
      </div>
      <div style={{ fontSize: 17, lineHeight: 1.45, color: C.fg }}>{why}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: F.mono, fontSize: 13, color: C.muted }}>
        Evidence:
        {cites.map((c) => (
          <span key={c} style={{ padding: "2px 8px", borderRadius: 6, background: C.secondary, color: C.fg }}>finding {c}</span>
        ))}
      </div>
      {!approved && (
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 42, padding: "0 18px", borderRadius: 10, background: C.fg, color: "white", fontSize: 16, fontWeight: 500, transform: pressed ? "scale(0.95)" : "none" }}>
            <ThumbsUp size={17} /> Approve
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 42, padding: "0 18px", borderRadius: 10, boxShadow: `0 0 0 1px ${C.ring}`, fontSize: 16, background: C.card }}>
            <ThumbsDown size={17} /> Deny
          </span>
          <span style={{ alignSelf: "center", fontSize: 14, color: C.muted, marginLeft: 6 }}>or say “approve”</span>
        </div>
      )}
    </div>
  );
}

export function Cursor({ x, y, pressed }: { x: number; y: number; pressed: boolean }) {
  return (
    <div style={{ position: "absolute", left: x, top: y, pointerEvents: "none", zIndex: 50 }}>
      {pressed && <span style={{ position: "absolute", left: -18, top: -18, width: 36, height: 36, borderRadius: 99, background: "oklch(0.21 0.006 285.9 / 18%)" }} />}
      <svg width={26} height={30} viewBox="0 0 26 30" style={{ position: "absolute", left: -3, top: -2, transform: pressed ? "scale(0.9)" : "none" }}>
        <path d="M3 2 L3 24 L9 18.5 L13 27 L17 25 L13 16.8 L21 16.5 Z" fill="#111" stroke="white" strokeWidth={2} strokeLinejoin="round" />
      </svg>
    </div>
  );
}
