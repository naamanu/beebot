import { useState } from "react";
import { Siren } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTower } from "@/lib/store";

export function DeclareIncidentDialog({ trigger }: { trigger?: React.ReactNode }) {
  const send = useTower((s) => s.send);
  const agents = useTower((s) => s.agents.length);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("Checkout failing");

  const declare = () => {
    send({ type: "declare_incident", title });
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">
            <Siren data-icon="inline-start" /> Declare incident
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Declare an incident</DialogTitle>
          <DialogDescription>
            Starts four investigators (logs, changes, metrics, comms) on a simulated Shopfront outage.
            {agents > 0 && " The current agents will be stopped."} You can also just say “declare an incident: checkout is failing”.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            declare();
          }}
        >
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's broken?" autoFocus />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={declare} disabled={!title.trim()}>
            <Siren data-icon="inline-start" /> Declare
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
