import { Brain, Eye, FileText, Wrench, AudioLines, Video } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { DiscoveredCapabilities } from '@/types';

const capabilityIcons = {
  text: FileText,
  image: Eye,
  audio: AudioLines,
  video: Video,
  reasoning: Brain,
  tools: Wrench,
};
export function CapabilityBadge({ name }: { name: string }) {
  const Icon = capabilityIcons[name as keyof typeof capabilityIcons];
  return Icon ? (
    <Badge variant="secondary" title={name} aria-label={name}>
      <Icon aria-hidden="true" />
      <span className="sr-only">{name}</span>
    </Badge>
  ) : null;
}
export function CapabilityBadges({
  hints,
}: {
  hints?: DiscoveredCapabilities;
}) {
  const reasoning =
    typeof hints?.reasoning === 'object'
      ? hints.reasoning.supported
      : hints?.reasoning;
  const names = [
    ...new Set([
      ...(hints?.input || []),
      ...(reasoning ? ['reasoning'] : []),
      ...(hints?.tools ? ['tools'] : []),
    ]),
  ];
  return (
    <div className="catalog-chips" aria-label="Detected capabilities">
      {names.map((name) => (
        <CapabilityBadge key={name} name={name} />
      ))}
    </div>
  );
}
