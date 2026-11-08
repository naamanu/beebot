import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Check, CheckCircle2, Sparkles, Waypoints } from "lucide-react";
import { C, F } from "./theme";
import {
  AGENTS, ALERT, FINDINGS, POSTMORTEM, ROLLBACK, SERIES_HEALTHY, SERIES_PEAK, SERIES_RECOVERY, SERIES_SPIKE, VOICE_ASK, VOICE_REPLY,
} from "./data";
import {
  AgentCard, ApprovalCard, Bubble, CommandBar, Cursor, ErrorChart, FindingRow, H, HealthCard, IncidentHeader, TopBar, W, clamp, ease, ramp, typed,
} from "./ui";

type SceneProps = { dur: number };

// The app window: top bar plus body, at a fixed logical size.
function Win({ series, needsYou, children }: { series: number[]; needsYou?: number; children: React.ReactNode }) {
  return (
    <div style={{ width: W, height: H, borderRadius: 18, overflow: "hidden", background: C.bg, color: C.fg, fontFamily: F.sans, display: "flex", flexDirection: "column", position: "relative", boxShadow: "0 30px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.08)" }}>
      <TopBar series={series} needsYou={needsYou} />
      <div style={{ flex: 1, minHeight: 0, padding: 20, display: "flex", position: "relative" }}>{children}</div>
    </div>
  );
}

function Panel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ flex: 1, borderRadius: 16, background: C.card, boxShadow: `0 0 0 1px ${C.ring}`, display: "flex", flexDirection: "column", overflow: "hidden", ...style }}>{children}</div>;
}

// Camera: zoom toward a point of the window over the scene.
export function Camera({ children, from = 1, to = 1, ox = 0.5, oy = 0.5, p }: { children: React.ReactNode; from?: number; to?: number; ox?: number; oy?: number; p: number }) {
  const s = interpolate(ease(Math.min(1, p * 1.6)), [0, 1], [from, to]);
  return <div style={{ transform: `scale(${s})`, transformOrigin: `${ox * 100}% ${oy * 100}%` }}>{children}</div>;
}

const sliceSeries = (s: number[], upto: number, p: number) => s.slice(0, Math.max(2, Math.round(upto + (s.length - upto) * p)));

// ---------- 1. Watching ----------
export function Watching({ dur }: SceneProps) {
  const f = useCurrentFrame();
  const p = f / dur;
  return (
    <Win series={SERIES_HEALTHY}>
      <Panel style={{ alignItems: "center", justifyContent: "center" }}>
        <HealthCard series={SERIES_HEALTHY} reveal={0.6 + 0.4 * p} />
      </Panel>
    </Win>
  );
}

// ---------- 2. Detect and declare ----------
export function Detect({ dur }: SceneProps) {
  const f = useCurrentFrame();
  const p = f / dur;
  const spikeP = ramp(p, 0.05, 0.4);
  const series = SERIES_SPIKE.slice(0, Math.max(SERIES_HEALTHY.length, Math.round(SERIES_HEALTHY.length + 3 * spikeP)));
  const speak = ramp(p, 0.42, 0.92);
  return (
    <Win series={series} needsYou={0}>
      <Panel style={{ alignItems: "center", justifyContent: "center" }}>
        <HealthCard series={SERIES_SPIKE} reveal={interpolate(spikeP, [0, 1], [(SERIES_HEALTHY.length - 1) / (SERIES_SPIKE.length - 1), 1])} />
      </Panel>
      {speak > 0 && (
        <div style={{ position: "absolute", right: 48, bottom: 44, opacity: ramp(p, 0.42, 0.47), transform: `translateY(${(1 - ease(ramp(p, 0.42, 0.5))) * 20}px)` }}>
          <Bubble text={typed(ALERT, speak)} width={720} />
        </div>
      )}
    </Win>
  );
}

function InvestigateBody({ f, findP, statuses, right }: { f: number; findP: number; statuses: ("working" | "done" | "waiting")[]; right?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 20, flex: 1, minHeight: 0 }}>
      <div style={{ width: 520, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: 0.6, textTransform: "uppercase", color: C.muted }}>Investigators</div>
        {AGENTS.map((a, i) => (
          <AgentCard key={a.role} role={a.role} job={a.job} status={statuses[i]!} frame={f + i * 5} />
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {right ?? (
          <>
            <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: 0.6, textTransform: "uppercase", color: C.muted, marginBottom: 4 }}>Shared findings</div>
            {FINDINGS.map((x, i) => (
              <FindingRow key={i} n={i + 1} role={x.role} time={x.time} text={x.text} appear={ramp(findP, x.at, x.at + 0.08)} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- 3. Investigate ----------
export function Investigate({ dur }: SceneProps) {
  const f = useCurrentFrame();
  const p = f / dur;
  const series = sliceSeries(SERIES_PEAK, SERIES_SPIKE.length, p);
  const statuses = AGENTS.map(() => "working" as const);
  return (
    <Win series={series}>
      <Panel>
        <IncidentHeader tone="bad" label="Investigating" frame={f} />
        <div style={{ padding: 24, display: "flex", flex: 1, minHeight: 0 }}>
          <InvestigateBody f={f} findP={p} statuses={statuses} />
        </div>
      </Panel>
    </Win>
  );
}

// ---------- 4. Voice ----------
export function Voice({ dur }: SceneProps) {
  const f = useCurrentFrame();
  const p = f / dur;
  const ask = typed(VOICE_ASK, ramp(p, 0.05, 0.3));
  const votes = Math.floor(5 * ramp(p, 0.34, 0.5));
  const reply = ramp(p, 0.55, 0.95);
  return (
    <Win series={SERIES_PEAK}>
      <Panel>
        <IncidentHeader tone="bad" label="Investigating" frame={f} />
        <div style={{ padding: 24, display: "flex", flex: 1, minHeight: 0, opacity: 0.45 }}>
          <InvestigateBody f={f} findP={1} statuses={["working", "working", "working", "working"]} />
        </div>
      </Panel>
      <div style={{ position: "absolute", left: 60, right: 60, bottom: 40, display: "flex", flexDirection: "column", gap: 16 }}>
        {reply > 0 && (
          <div style={{ alignSelf: "flex-end", opacity: ramp(p, 0.55, 0.6) }}>
            <Bubble text={typed(VOICE_REPLY, reply)} label="Tower · from Logs" width={760} />
          </div>
        )}
        {p > 0.32 && (
          <div style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderRadius: 12, background: C.card, boxShadow: `0 0 0 1px ${C.ring}, 0 8px 24px oklch(0 0 0 / 8%)`, fontFamily: F.mono, fontSize: 15, opacity: ramp(p, 0.32, 0.36) }}>
            router votes
            <span style={{ display: "flex", gap: 6 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} style={{ width: 16, height: 16, borderRadius: 99, background: i < votes ? C.tool : C.secondary, boxShadow: `0 0 0 1px ${C.ring}` }} />
              ))}
            </span>
            {votes >= 5 && (
              <span style={{ color: C.tool }}>
                5/5 agree → <b>report</b> · target <b>Logs</b>
              </span>
            )}
          </div>
        )}
        <CommandBar text={ask} listening={p < 0.33} frame={f} />
      </div>
    </Win>
  );
}

// ---------- 5. Approve ----------
export function Approve({ dur }: SceneProps) {
  const f = useCurrentFrame();
  const p = f / dur;
  const clickAt = 0.55;
  const approved = p > clickAt + 0.03;
  const pressed = p > clickAt && p < clickAt + 0.04;
  const slide = ease(ramp(p, 0, 0.12));
  // cursor glides to the Approve button
  const cx = interpolate(p, [0.2, clickAt], [1150, 690], { ...clamp, easing: (x) => ease(x) });
  const cy = interpolate(p, [0.2, clickAt], [640, 404], { ...clamp, easing: (x) => ease(x) });
  const done = ramp(p, 0.68, 0.76);
  const statuses = ["done", approved ? "done" : "waiting", "working", "done"] as const;
  return (
    <Win series={SERIES_PEAK} needsYou={approved ? 0 : 1}>
      <Panel>
        <IncidentHeader tone={approved ? "recovering" : "waiting"} label={approved ? "Fix applied, watching" : "Waiting for you"} frame={f} />
        <div style={{ padding: 24, display: "flex", flex: 1, minHeight: 0 }}>
          <InvestigateBody
            f={f}
            findP={1}
            statuses={[...statuses]}
            right={
              <div style={{ display: "flex", flexDirection: "column", gap: 16, transform: `translateX(${(1 - slide) * 60}px)`, opacity: slide }}>
                <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: 0.6, textTransform: "uppercase", color: C.muted }}>Needs your approval</div>
                <ApprovalCard {...ROLLBACK} approved={approved} pressed={pressed} />
                {done > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderRadius: 12, background: "oklch(0.6 0.16 140 / 8%)", color: C.fg, fontSize: 17, opacity: done }}>
                    <Check size={18} color={C.tool} /> <span style={{ fontFamily: F.mono, fontSize: 13, color: C.workflow, fontWeight: 600 }}>Changes</span> {ROLLBACK.done}
                  </div>
                )}
              </div>
            }
          />
        </div>
      </Panel>
      {p > 0.18 && p < 0.8 && <Cursor x={cx} y={cy} pressed={pressed} />}
    </Win>
  );
}

// ---------- 6. Recover ----------
export function Recover({ dur }: SceneProps) {
  const f = useCurrentFrame();
  const p = f / dur;
  const reveal = interpolate(p, [0.05, 0.7], [(SERIES_PEAK.length - 1) / (SERIES_RECOVERY.length - 1), 1], clamp);
  const n = SERIES_RECOVERY.length;
  const idx = Math.min(n - 1, Math.floor((n - 1) * reveal));
  const rate = SERIES_RECOVERY[idx]!;
  const healthy = rate < 1;
  const clickAt = 0.82;
  const resolved = p > clickAt + 0.03;
  const cx = interpolate(p, [0.6, clickAt], [1100, 1494], { ...clamp, easing: ease });
  const cy = interpolate(p, [0.6, clickAt], [480, 58], { ...clamp, easing: ease });
  return (
    <Win series={SERIES_RECOVERY.slice(0, idx + 1)}>
      <Panel>
        <IncidentHeader
          tone={resolved ? "good" : healthy ? "good" : "recovering"}
          label={resolved ? "Resolved" : healthy ? "Recovered" : "Fix applied, watching"}
          frame={f}
          resolve={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 38, padding: "0 16px", borderRadius: 10, background: C.fg, color: "white", fontSize: 15.5, fontWeight: 500, opacity: resolved ? 0.4 : 1, transform: p > clickAt && p < clickAt + 0.04 ? "scale(0.95)" : "none" }}>
              <CheckCircle2 size={17} /> Resolve
            </span>
          }
        />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 28 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
            <span style={{ fontFamily: F.heading, fontSize: 96, lineHeight: 1, color: rate >= 5 ? C.error : C.tool}}>{rate.toFixed(1)}%</span>
            <span style={{ fontSize: 22, color: C.muted }}>checkout errors</span>
          </div>
          <ErrorChart series={SERIES_RECOVERY} width={1180} height={300} reveal={reveal} stroke={3.5} />
          <div style={{ fontFamily: F.mono, fontSize: 15, color: C.muted }}>peak 18.8% at 16:46:41 · back to 0.4% by 16:47:26 · recovery wait shortened</div>
        </div>
      </Panel>
      {p > 0.58 && p < 0.95 && <Cursor x={cx} y={cy} pressed={p > clickAt && p < clickAt + 0.04} />}
    </Win>
  );
}

// ---------- 7. Postmortem ----------
export function Postmortem({ dur }: SceneProps) {
  const f = useCurrentFrame();
  const p = f / dur;
  const scroll = interpolate(p, [0.35, 0.95], [0, 300], { ...clamp, easing: (x) => x * x * (3 - 2 * x) });
  return (
    <Win series={SERIES_RECOVERY}>
      <Panel>
        <IncidentHeader tone="good" label="Resolved" frame={f} tab="postmortem" />
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <div style={{ maxWidth: 1000, margin: "0 auto", padding: "28px 0", transform: `translateY(${-scroll}px)`, display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: F.mono, fontSize: 13, color: C.muted }}>
              <Sparkles size={14} /> Written from the timeline, every agent’s findings and your approvals
            </div>
            <div style={{ fontFamily: F.heading, fontSize: 38, lineHeight: 1.1 }}>Checkout errors at 10% after deploy #482</div>
            <div style={{ fontSize: 17, color: C.muted }}>{POSTMORTEM.meta}</div>
            <div style={{ fontFamily: F.heading, fontSize: 26, marginTop: 6 }}>Summary</div>
            <p style={{ margin: 0, fontSize: 19, lineHeight: 1.6 }}>{POSTMORTEM.summary}</p>
            <div style={{ fontFamily: F.heading, fontSize: 26, marginTop: 6 }}>Impact</div>
            <ul style={{ margin: 0, paddingLeft: 24, fontSize: 19, lineHeight: 1.7 }}>
              {POSTMORTEM.impact.map((x) => <li key={x}>{x}</li>)}
            </ul>
            <div style={{ fontFamily: F.heading, fontSize: 26, marginTop: 6 }}>Timeline</div>
            <div style={{ borderRadius: 12, boxShadow: `0 0 0 1px ${C.ring}`, overflow: "hidden" }}>
              {POSTMORTEM.timeline.map(([t, e, who], i) => (
                <div key={t} style={{ display: "flex", gap: 20, padding: "12px 16px", fontSize: 17, borderTop: i ? `1px solid ${C.border}` : "none" }}>
                  <span style={{ fontFamily: F.mono, fontSize: 15, color: C.muted, width: 90 }}>{t}</span>
                  <span style={{ flex: 1 }}>{e}</span>
                  <span style={{ color: C.muted }}>{who}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, color: C.muted }}>
              <Waypoints size={16} /> Every model and tool call is in Activity
            </div>
          </div>
        </div>
      </Panel>
    </Win>
  );
}
