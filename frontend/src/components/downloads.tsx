import { Card, CardContent } from '@/components/ui/card';
import { EventFeed } from './event-feed';
import type { Artifact, Job } from '@/types';

export function Downloads({
  jobs,
  models,
}: {
  jobs: Job[];
  models: Artifact[];
}) {
  const downloads = jobs
    .filter((j) => j.operation === 'download' || j.name.startsWith('Download '))
    .map((j) => {
      const model = models.find(
        (m) =>
          m.repo === j.repo &&
          (!j.filename ||
            m.name === j.filename ||
            m.local_path?.endsWith(j.filename)),
      );
      return { ...j, model_id: j.model_id || model?.id };
    });
  return (
    <Card className="mb-5 min-w-0">
      <CardContent className="p-0">
        <EventFeed events={[]} deployments={[]} jobs={downloads} />
      </CardContent>
    </Card>
  );
}
