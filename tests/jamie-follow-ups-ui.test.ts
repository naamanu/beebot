import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PostmortemPage } from "../web/components/incident/postmortem-page.tsx";
import { Postmortem } from "../web/components/incident/incident-page.tsx";
import { useTower } from "../web/lib/store.ts";
import type { IncidentView } from "../server/types.ts";

const incident: IncidentView = {
  id: "inc", title: "Checkout", severity: "SEV1", status: "resolved", declaredAt: 1, impactAt: 0,
  mitigatedAt: 2, errorRate: [], findings: [], timeline: [], statusPosts: [], hasPostmortem: true,
  postmortemState: "ready", jamieMeetingId: "meeting-1", declaredBy: "commander", fixAppliedAt: 2,
};

test("the Jamie attachment page exposes the proposed follow-ups where notes were attached", () => {
  const previous = useTower.getState();
  const initial = useTower.getInitialState();
  const previousInitial = { ...initial };
  const client = new QueryClient();
  client.setQueryData(["postmortem", incident.id], { markdown: "# Incident" });
  client.setQueryData(["jamie-meetings"], { configured: true, meetings: [] });
  try {
    useTower.setState({ incident, connected: true, proposals: [{
      id: "proposal-1", source: "jamie", title: "Follow-ups from review", items: ["Write a provider failover runbook."],
      createdAt: 1, status: "open",
    }] });
    Object.assign(initial, useTower.getState());
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(PostmortemPage)));
    assert.match(html, /Write a provider failover runbook/);
    assert.match(html, /Start 1 task/);
  } finally {
    useTower.setState(previous);
    Object.assign(initial, previousInitial);
    client.clear();
  }
});

test("the main postmortem tab exposes Jamie attachment controls and regeneration", () => {
  const previous = useTower.getState();
  const initial = useTower.getInitialState();
  const previousInitial = { ...initial };
  const client = new QueryClient();
  client.setQueryData(["postmortem", incident.id, "ready"], { markdown: "# Incident" });
  client.setQueryData(["jamie-meetings"], { configured: true, meetings: [] });
  try {
    useTower.setState({ incident, connected: true, proposals: [] });
    Object.assign(initial, useTower.getState());
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Postmortem)));
    assert.match(html, /Attach call notes/);
    assert.match(html, /Refresh meetings/);
    assert.match(html, /No meetings yet/);
    assert.match(html, /Regenerate/);
  } finally {
    useTower.setState(previous);
    Object.assign(initial, previousInitial);
    client.clear();
  }
});
