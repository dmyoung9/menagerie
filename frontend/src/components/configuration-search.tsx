import { createContext, useContext } from 'react';

const ConfigurationSearch = createContext('');
export const ConfigurationSearchProvider = ConfigurationSearch.Provider;

/** Literal highlighting only; filtering never rewrites mounted editor content. */
export function ConfigurationMatch({ children }: { children: string }) {
  const query = useContext(ConfigurationSearch).trim().toLowerCase();
  if (!query) return children;
  const index = children.toLowerCase().indexOf(query);
  if (index < 0) return children;
  return (
    <>
      {children.slice(0, index)}
      <mark>{children.slice(index, index + query.length)}</mark>
      {children.slice(index + query.length)}
    </>
  );
}
