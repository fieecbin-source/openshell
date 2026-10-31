// Deployment values are supplied only to audit steps, never to the application build.
export function privateMarkers() {
  const values = new Set();
  for (const line of (process.env.OPENSHELL_PRIVATE_MARKERS ?? "").split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    values.add(value);
    try {
      const url = new URL(value);
      values.add(url.hostname);
    } catch { /* A plain hostname or other private fingerprint is valid too. */ }
  }
  return [...values].filter((value) => value.length >= 6);
}
