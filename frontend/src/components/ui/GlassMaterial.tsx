/** A quiet material plane; text and controls stay sharp above native CSS blur. */
export function GlassMaterial({ radius = 18 }: { radius?: number }) {
  return <div className="glass-material" aria-hidden="true" style={{ borderRadius: radius }} />;
}
