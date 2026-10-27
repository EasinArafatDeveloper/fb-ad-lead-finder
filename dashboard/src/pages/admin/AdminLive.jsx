import { Radio } from 'lucide-react';
import { PageHeader } from '../../components/ui';
import LiveActivity from '../../components/LiveActivity';

/** Admin → Live activity: what every account is doing right now (its own page, so the Overview stays short). */
export default function AdminLive() {
  return (
    <div className="space-y-6">
      <PageHeader icon={Radio} title="Live activity" subtitle="What every account is doing right now — searches collecting, pages being read, problems. Updates every 5 seconds." />
      <LiveActivity />
    </div>
  );
}
