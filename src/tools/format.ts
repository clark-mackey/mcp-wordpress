/**
 * When a post or page was last modified, in the reader's local time. Uses modified_gmt because
 * WordPress's plain `modified` is site-local time without a zone, which reads as the wrong hour
 * on a laptop in another timezone.
 */
export function formatModified(item: { modified?: string; modified_gmt?: string }): string {
  if (item.modified_gmt) return new Date(`${item.modified_gmt}Z`).toLocaleString();
  return item.modified ? new Date(item.modified).toLocaleString() : "unknown";
}
