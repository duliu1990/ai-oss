export async function renderMarkdownSafe(source: string): Promise<string> {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([
    import('marked'),
    import('dompurify'),
  ]);
  const rendered = await marked.parse(source, { async: true, gfm: true });
  const sanitized = DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
    USE_PROFILES: { html: true },
  });
  const template = document.createElement('template');
  template.innerHTML = sanitized;
  template.content.querySelectorAll('a').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
  return template.innerHTML;
}
