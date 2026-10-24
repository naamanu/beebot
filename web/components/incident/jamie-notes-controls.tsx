import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Mic, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTower } from "@/lib/store";

export function JamieNotesControls() {
  const incident = useTower((s) => s.incident);
  const [meetingId, setMeetingId] = useState("");
  const meetings = useQuery({
    queryKey: ["jamie-meetings"],
    queryFn: async () => {
      const res = await fetch("/api/jamie/meetings");
      if (!res.ok) throw new Error((await res.json()).error || "Could not load Jamie meetings.");
      return await res.json() as { configured: boolean; meetings: { id: string; title: string; startTime: string }[] };
    },
  });
  const attach = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch("/api/incident/jamie", { method: "POST", body: JSON.stringify({ meetingId: id }) });
      if (!res.ok) throw new Error((await res.json()).error);
      return await res.json() as { title: string; followUpCount?: number };
    },
    onSuccess: (result) => toast(result.followUpCount === 0
      ? "Notes attached, but Jamie supplied no unfinished action items. Add tasks in Jamie and attach the meeting again."
      : `Call notes attached: ${result.title}. Review the follow-up proposal and choose Start tasks.`),
    onError: (error) => toast.error(error.message),
  });
  if (!incident) return null;
  return (
    <section aria-label="Jamie meeting notes" className="flex flex-wrap items-center gap-2 text-xs">
      {meetings.isPending ? <span role="status">Loading Jamie meetings…</span>
        : meetings.isError ? <span role="alert">{meetings.error.message}</span>
          : !meetings.data.configured ? <span>Jamie not connected. Set JAMIE_API_KEY in .env.</span>
            : <>
              <Select value={meetingId} onValueChange={setMeetingId}>
                <SelectTrigger size="sm" className="w-64 text-xs" aria-label="Jamie review meeting">
                  <SelectValue placeholder="Review meeting from Jamie…" />
                </SelectTrigger>
                <SelectContent>
                  {meetings.data.meetings.map((meeting) => <SelectItem key={meeting.id} value={meeting.id}>
                    {meeting.title} · {new Date(meeting.startTime).toLocaleString()}
                  </SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" disabled={!meetingId || attach.isPending} onClick={() => attach.mutate(meetingId)}>
                {attach.isPending ? <Loader2 className="animate-spin" /> : <Mic />} Attach call notes
              </Button>
              {!meetings.data.meetings.length && <span role="status">No meetings yet. Refresh after Jamie finishes processing.</span>}
            </>}
      <Button size="sm" variant="ghost" disabled={meetings.isFetching} onClick={() => void meetings.refetch()} aria-label="Refresh Jamie meetings">
        <RotateCcw className={meetings.isFetching ? "animate-spin" : ""} /> Refresh meetings
      </Button>
      {incident.jamieMeetingId && <span className="text-span-tool">Call notes attached</span>}
      {attach.data?.followUpCount === 0 && <p role="status" className="basis-full text-muted-foreground">No unfinished action items were supplied by Jamie. Add tasks to the meeting in Jamie, then attach it again.</p>}
      {attach.data?.followUpCount !== undefined && attach.data.followUpCount > 0 && <p role="status" className="basis-full text-muted-foreground">{attach.data.followUpCount} follow-up tasks suggested. Choose Start tasks in the proposal to begin.</p>}
      {attach.isSuccess && <p className="basis-full text-muted-foreground">Regenerate the postmortem to include the newly attached notes.</p>}
    </section>
  );
}
