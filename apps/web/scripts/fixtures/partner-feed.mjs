export function partnerFixture() {
  return { version: 1, generated_at: new Date().toISOString(), status: 'live', count: 4,
    opportunities: ['keykeeper', 'promoted-by-ai', 'booktemplatespro', 'openagentforum'].map(slug => ({
      id: 'cmp_' + slug, slug, status: 'live', name: slug, tagline: 'Fixture campaign brief',
      currency: 'usd', rates: { article: 5000, listing: 1000 },
      brief_url: 'http://127.0.0.1/never-fetch', assets: [{ url: 'https://evil.invalid/never-fetch' }],
    })) };
}
