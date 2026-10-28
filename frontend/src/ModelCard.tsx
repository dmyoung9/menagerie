import type {ReactNode} from 'react';
import {ArrowUpRight, Boxes} from 'lucide-react';
import {Card, CardHeader, CardTitle, CardContent, CardFooter, CardDescription} from '@/components/ui/card';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import './catalog.css';

export function ModelCard({name, chips, url, footer, children}: {name: string; chips: string[]; url?: string; footer: ReactNode; children: ReactNode}) {
  return <Card className="min-w-0"><CardHeader className="flex-row items-start gap-3"><Boxes className="shrink-0"/><CardTitle className="min-w-0 flex-1 break-words">{name}</CardTitle>{url && <Button nativeButton={false} variant="ghost" size="icon" render={<a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${name} supplier page`}/>}><ArrowUpRight/></Button>}</CardHeader><CardContent><div className="catalog-chips">{[...new Set(chips)].map(chip => <Badge variant="secondary" className="max-w-full whitespace-normal break-words" key={chip}>{chip}</Badge>)}</div></CardContent><CardFooter className="mt-auto flex-wrap justify-between gap-3"><CardDescription>{footer}</CardDescription>{children}</CardFooter></Card>;
}
