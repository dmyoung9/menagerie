import type {ReactNode} from 'react';
import {ArrowUpRight, Boxes} from 'lucide-react';
import './catalog.css';

export function ModelCard({name, chips, url, footer, children}: {name: string; chips: string[]; url?: string; footer: ReactNode; children: ReactNode}) {
  return <article className="catalog-card"><div className="catalog-card-heading"><Boxes size={20}/><h3>{name}</h3>{url && <a className="button icon-button" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${name} supplier page`} title="Open supplier page"><ArrowUpRight size={17}/></a>}</div><div className="catalog-chips">{[...new Set(chips)].map(chip => <span className="catalog-chip" key={chip}>{chip}</span>)}</div><div className="catalog-card-footer"><span>{footer}</span>{children}</div></article>;
}
